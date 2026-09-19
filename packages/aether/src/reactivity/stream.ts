/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { effect } from "./effect.ts";
import { untracked } from "./engine.ts";
import { type Signal, signal } from "./signal.ts";
import { isBrowser } from "../env.ts";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ReconnectOptions {
	/** first retry delay in ms. defaults to 500 */
	min?: number;

	/** cap on the retry delay in ms. defaults to 30 000 */
	max?: number;

	/** randomise each delay by up to ±50%. defaults to `true` */
	jitter?: boolean;

	/** give up after this many consecutive failures. defaults to unlimited */
	attempts?: number;
}

export interface StreamOptions<T> {
	/** turns a message's `data` into a value. defaults to `JSON.parse` */
	parse?: (data: string) => T;

	/** retry policy after a drop. `false` disables reconnecting */
	reconnect?: ReconnectOptions | false;
}

export interface EventSourceOptions<T> extends StreamOptions<T> {
	/** named events to listen for besides `message` */
	events?: string[];
	withCredentials?: boolean;
}

export interface WebSocketOptions<In, Out> extends StreamOptions<In> {
	/** turns an outgoing message into a frame. defaults to `JSON.stringify` */
	serialise?: (message: Out) => string | BufferSource | Blob;
	protocols?: string | string[];
}

export interface Stream<T> {
	/** the last parsed message */
	latest: Signal<T | undefined>;
	status: Signal<StreamStatus>;

	/** the last connection error, cleared on a successful open */
	error: Signal<unknown>;

	/** subscribes to every message without going through a signal. returns an unsubscribe */
	on(listener: (value: T, event: MessageEvent) => void): () => void;

	/** closes for good: no reconnect */
	close(): void;
}

export interface Socket<In, Out> extends Stream<In> {
	/** sends now, or once the socket is open */
	send(message: Out): void;
}

type Url = string | (() => string);

interface Transport {
	open(url: string): void;
	close(): void;
}

function readUrl(url: Url): string {
	return typeof url === "function" ? url() : url;
}

function delayFor(attempt: number, options: ReconnectOptions): number {
	const min = options.min ?? 500;
	const max = options.max ?? 30_000;
	const base = Math.min(max, min * 2 ** attempt);
	if (options.jitter === false) return base;
	return Math.round(base * (0.5 + Math.random()));
}

function connection<T>(
	url: Url,
	options: StreamOptions<T>,
	transport: (handlers: {
		onOpen(): void;
		onMessage(event: MessageEvent): void;
		onError(error: unknown): void;
		onClose(): void;
	}) => Transport,
): Stream<T> & { isOpen(): boolean; onOpened(fn: () => void): void } {
	const latest = signal<T | undefined>(undefined);
	const status = signal<StreamStatus>("closed");
	const error = signal<unknown>(undefined);
	const listeners = new Set<(value: T, event: MessageEvent) => void>();
	const opened = new Set<() => void>();
	const parse = options.parse ?? ((data: string) => JSON.parse(data) as T);

	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	let live = false;
	let current: string | undefined;

	const link = transport({
		onOpen() {
			attempt = 0;
			error(undefined);
			status("open");
			for (const fn of opened) fn();
		},
		onMessage(event) {
			let value: T;
			try {
				value = parse(event.data);
			} catch (err) {
				console.warn("aether: couldn't parse a stream message:", err);
				return;
			}
			latest(value);
			for (const fn of listeners) fn(value, event);
		},
		onError(err) {
			error(err);
		},
		onClose() {
			live = false;
			if (stopped) return void status("closed");
			schedule();
		},
	});

	function schedule() {
		const policy = options.reconnect ?? {};
		if (policy === false || attempt >= (policy.attempts ?? Infinity)) {
			return void status("closed");
		}
		status("reconnecting");
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			attempt++;
			if (current !== undefined) connect(current);
		}, delayFor(attempt, policy));
	}

	function connect(to: string) {
		if (live) link.close();
		if (status.peek() !== "reconnecting") status("connecting");
		link.open(to);
		live = true;
	}

	function teardown() {
		clearTimeout(timer);
		timer = undefined;
		if (live) link.close();
		live = false;
		status("closed");
	}

	function close() {
		stopped = true;
		teardown();
	}

	if (isBrowser) {
		effect(() => {
			const to = readUrl(url);
			untracked(() => {
				if (stopped) return;
				current = to;
				attempt = 0;
				connect(to);
			});
			return teardown;
		});
	}

	return {
		latest,
		status,
		error,
		on: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
		close,
		isOpen: () => live && status.peek() === "open",
		onOpened: (fn) => void opened.add(fn),
	};
}

/**
 * @example
 * ```ts
 * const events = fromEventSource<SyncEvent>(() => `/sync?since=${token()}`, {
 *   events: ["message", "typing"],
 *   reconnect: { min: 500, max: 30_000 },
 * });
 * events.on((ev) => apply(ev));
 * <show when={events.status.is("reconnecting")}>reconnecting a little</show>
 * ```
 */
export function fromEventSource<T = unknown>(
	url: Url,
	options: EventSourceOptions<T> = {},
): Stream<T> {
	const { latest, status, error, on, close } = connection<T>(url, options, (handlers) => {
		let source: EventSource | undefined;
		return {
			open(to) {
				const es = source = new EventSource(to, { withCredentials: options.withCredentials });
				es.onopen = () => handlers.onOpen();
				es.onmessage = (event) => handlers.onMessage(event);
				for (const name of options.events ?? []) {
					if (name !== "message") {
						es.addEventListener(name, (event) => handlers.onMessage(event as MessageEvent));
					}
				}
				es.onerror = (event) => {
					es.close();
					if (source === es) source = undefined;
					handlers.onError(event);
					handlers.onClose();
				};
			},
			close() {
				source?.close();
				source = undefined;
			},
		};
	});
	return { latest, status, error, on, close };
}

export function fromWebSocket<In = unknown, Out = In>(
	url: Url,
	options: WebSocketOptions<In, Out> = {},
): Socket<In, Out> {
	const serialise = options.serialise ?? ((message: Out) => JSON.stringify(message));
	const queue: Out[] = [];
	let socket: WebSocket | undefined;

	const stream = connection<In>(url, options, (handlers) => ({
		open(to) {
			const ws = socket = new WebSocket(to, options.protocols);
			ws.onopen = () => handlers.onOpen();
			ws.onmessage = (event) => handlers.onMessage(event);
			ws.onerror = (event) => handlers.onError(event);
			ws.onclose = () => {
				if (socket === ws) socket = undefined;
				handlers.onClose();
			};
		},
		close() {
			const ws = socket;
			socket = undefined;
			if (ws) {
				ws.onclose = null;
				ws.close();
			}
		},
	}));

	const flush = () => {
		while (socket && stream.isOpen() && queue.length) socket.send(serialise(queue.shift()!));
	};
	stream.onOpened(flush);

	return {
		latest: stream.latest,
		status: stream.status,
		error: stream.error,
		on: stream.on,
		close: stream.close,
		send(message) {
			queue.push(message);
			flush();
		},
	};
}
