/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Context } from "./context.ts";

/**
 * represents a message sent over server-sent events
 */
export interface SSEMessage {
	/** the event name */
	event?: string;
	/** the data payload */
	data: string;
	/** the event identifier */
	id?: string;
	/** the reconnection time in milliseconds */
	retry?: number;
}

function abortableStream<T>(
	ctx: Context,
	iterable: AsyncIterable<T>,
	onChunk: (controller: ReadableStreamDefaultController<Uint8Array>, value: T) => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			let closed = false;
			const iterator = iterable[Symbol.asyncIterator]();

			const onAbort = () => {
				closed = true;
				try {
					controller.close();
				} catch { /* no-op */ }
			};
			ctx.request.signal.addEventListener("abort", onAbort);

			try {
				while (!closed && !ctx.request.signal.aborted) {
					const { done, value } = await iterator.next();
					if (done) break;
					onChunk(controller, value);
				}
				if (!closed) controller.close();
			} catch (error) {
				if (!closed) controller.error(error);
			} finally {
				ctx.request.signal.removeEventListener("abort", onAbort);
				try {
					await iterator.return?.(undefined);
				} catch { /* no-op */ }
			}
		},
	});
}

/**
 * creates a `Response` that streams server-sent events
 * @param ctx the request context
 * @param source an async iterable or a function returning one
 * @param init optional `ResponseInit` body.
 */
export function sse(
	ctx: Context,
	source: AsyncIterable<SSEMessage> | (() => AsyncIterable<SSEMessage>),
	init?: ResponseInit,
): Response {
	const encoder = new TextEncoder();
	const iterable = typeof source === "function" ? source() : source;

	const stream = abortableStream(ctx, iterable, (controller, message) => {
		let chunk = "";
		if (message.event) chunk += `event: ${message.event}\n`;
		if (message.id) chunk += `id: ${message.id}\n`;
		if (message.retry) chunk += `retry: ${message.retry}\n`;

		for (const line of message.data.split("\n")) {
			chunk += `data: ${line}\n`;
		}
		chunk += "\n";

		controller.enqueue(encoder.encode(chunk));
	});

	return new Response(stream, {
		...init,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			...init?.headers,
		},
	});
}

/**
 * handlers for WebSocket lifecycle events
 */
export interface WebSocketHandler {
	onOpen?: (ws: WebSocket) => void | Promise<void>;
	onMessage?: (ws: WebSocket, event: MessageEvent) => void | Promise<void>;
	onClose?: (ws: WebSocket, event: CloseEvent) => void | Promise<void>;
	onError?: (ws: WebSocket, event: Event | ErrorEvent) => void | Promise<void>;
}

/**
 * upgrades an incoming HTTP connection to a WebSocket connection
 * @param ctx the request context
 * @param handler the WebSocket event handlers
 */
export function upgradeWebSocket(
	ctx: Context,
	handler: WebSocketHandler,
): Response {
	const upgrade = ctx.request.headers.get("upgrade")?.toLowerCase();

	if (upgrade !== "websocket") {
		return new Response("expected websocket upgrade", {
			status: 426,
			headers: {
				"Upgrade": "websocket",
			},
		});
	}

	const { socket, response } = Deno.upgradeWebSocket(ctx.request);

	if (handler.onOpen) {
		socket.addEventListener("open", () => {
			handler.onOpen!(socket);
		});
	}
	if (handler.onMessage) {
		socket.addEventListener("message", (event) => {
			handler.onMessage!(socket, event);
		});
	}
	if (handler.onClose) {
		socket.addEventListener("close", (event) => {
			handler.onClose!(socket, event);
		});
	}
	if (handler.onError) {
		socket.addEventListener("error", (event) => {
			handler.onError!(socket, event);
		});
	}

	return response;
}

/**
 * creates a streaming Response from an async iterable of data
 * @param source an async iterable of strings or Uint8Arrays
 * @param init optional `ResponseInit` body
 */
export function stream(
	ctx: Context,
	source: AsyncIterable<Uint8Array> | (() => AsyncIterable<Uint8Array>),
	init?: ResponseInit,
): Response {
	const encoder = new TextEncoder();
	const iterable = typeof source === "function" ? source() : source;

	const readable = abortableStream(ctx, iterable, (controller, chunk) => {
		controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
	});

	return new Response(readable, init);
}
