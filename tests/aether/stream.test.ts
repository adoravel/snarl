/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import "./dom.ts";
import { effectScope, fromEventSource, fromWebSocket, signal } from "@404/aether/reactivity";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket {
	static instances: FakeSocket[] = [];
	static get last(): FakeSocket {
		return this.instances[this.instances.length - 1];
	}
	readonly sent: unknown[] = [];

	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onclose: (() => void) | null = null;
	listeners = new Map<string, (e: unknown) => void>();

	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}
	addEventListener(name: string, fn: (e: unknown) => void) {
		this.listeners.set(name, fn);
	}
	send(data: unknown) {
		this.sent.push(data);
	}
	close() {
		this.closed = true;
	}
	open() {
		this.onopen?.();
	}
	message(data: unknown) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
	fail() {
		this.onerror?.(new Error("boom"));
		this.onclose?.();
	}
}

Object.defineProperty(globalThis, "EventSource", { value: FakeSocket, configurable: true });
Object.defineProperty(globalThis, "WebSocket", { value: FakeSocket, configurable: true });

Deno.test("fromEventSource: messages land in latest and listeners; named events too", () => {
	FakeSocket.instances = [];
	const events = fromEventSource<{ n: number }>("/events", { events: ["typing"] });
	const seen: number[] = [];
	const off = events.on((v) => void seen.push(v.n));

	assertEquals(events.status(), "connecting");
	const es = FakeSocket.last;
	assertEquals(es.url, "/events");
	es.open();
	assertEquals(events.status(), "open");

	es.message({ n: 1 });
	es.listeners.get("typing")!({ data: JSON.stringify({ n: 2 }) });
	assertEquals(events.latest(), { n: 2 });
	assertEquals(seen, [1, 2]);

	off();
	es.message({ n: 3 });
	assertEquals(seen, [1, 2]);
	events.close();
	assertEquals(es.closed, true);
	assertEquals(events.status(), "closed");
});

Deno.test("fromEventSource: reconnects with backoff, gives up after `attempts`", async () => {
	FakeSocket.instances = [];
	const events = fromEventSource("/events", { reconnect: { min: 5, jitter: false, attempts: 2 } });

	FakeSocket.last.open();
	FakeSocket.last.fail();
	assertEquals(events.status(), "reconnecting");
	assertEquals((events.error() as Error).message, "boom");
	assertEquals(FakeSocket.instances.length, 1, "waits for the backoff before reopening");

	await sleep(8);
	assertEquals(FakeSocket.instances.length, 2);
	FakeSocket.last.open();
	assertEquals(events.error(), undefined, "a successful open clears the error");

	FakeSocket.last.fail();
	await sleep(8);
	FakeSocket.last.fail();
	await sleep(15);
	FakeSocket.last.fail();
	assertEquals(events.status(), "closed", "attempts exhausted");
	assertEquals(FakeSocket.instances.length, 4);
	events.close();
});

Deno.test("fromEventSource: a url signal reopens, disposal closes", () => {
	FakeSocket.instances = [];
	const room = signal("a");
	let events!: ReturnType<typeof fromEventSource>;
	const dispose = effectScope(() => {
		events = fromEventSource(() => `/rooms/${room()}/events`);
	});
	const first = FakeSocket.last;
	first.open();

	room("b");
	assertEquals(first.closed, true);
	assertEquals(FakeSocket.last.url, "/rooms/b/events");
	assertEquals(events.status(), "connecting");

	dispose();
	assertEquals(FakeSocket.last.closed, true);
	assertEquals(events.status(), "closed");
});

Deno.test("fromWebSocket: queues sends until open and reconnects after a drop", async () => {
	FakeSocket.instances = [];
	const ws = fromWebSocket<{ ok: boolean }, { text: string }>("wss://x/ws", {
		reconnect: { min: 5, jitter: false },
	});
	ws.send({ text: "early" });
	assertEquals(FakeSocket.last.sent, []);

	FakeSocket.last.open();
	assertEquals(FakeSocket.last.sent, ['{"text":"early"}']);
	ws.send({ text: "now" });
	assertEquals(FakeSocket.last.sent.length, 2);

	FakeSocket.last.message({ ok: true });
	assertEquals(ws.latest(), { ok: true });

	FakeSocket.last.fail();
	ws.send({ text: "while down" });
	await sleep(8);
	FakeSocket.last.open();
	assertEquals(FakeSocket.last.sent, ['{"text":"while down"}']);
	ws.close();
});
