/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals } from "@std/assert";
import { compress, createRouter, proxy } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "10.0.0.7" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function upstream() {
	const gate = deferred();
	const aborted = deferred<string>();
	const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
		const url = new URL(req.url);
		switch (url.pathname) {
			case "/_matrix/echo":
				return Response.json({
					method: req.method,
					path: url.pathname + url.search,
					forwardedFor: req.headers.get("x-forwarded-for"),
					forwardedHost: req.headers.get("x-forwarded-host"),
					forwardedProto: req.headers.get("x-forwarded-proto"),
					connection: req.headers.get("connection"),
					custom: req.headers.get("x-custom"),
					body: req.body ? await req.text() : null,
				});
			case "/_matrix/sse": {
				const encoder = new TextEncoder();
				const body = new ReadableStream({
					async start(controller) {
						controller.enqueue(encoder.encode("data: one\n\n"));
						await gate.promise;
						controller.enqueue(encoder.encode("data: two\n\n"));
						controller.close();
					},
				});
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			}
			case "/_matrix/cookie": {
				const headers = new Headers({ "content-type": "text/plain" });
				headers.append("set-cookie", "sid=1; Domain=upstream.local; Path=/_matrix; HttpOnly");
				headers.append("set-cookie", "theme=dark");
				return new Response("ok", { headers });
			}
			case "/_matrix/redirect":
				return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
			case "/_matrix/hang":
				await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve()));
				aborted.resolve("upstream saw the abort");
				return new Response("late");
			case "/_matrix/ws": {
				const { socket, response } = Deno.upgradeWebSocket(req);
				socket.onmessage = (e) => socket.send(`echo:${e.data}`);
				return response;
			}
			default:
				return new Response("nope", { status: 404 });
		}
	});
	return { server, origin: `http://localhost:${server.addr.port}`, gate, aborted };
}

Deno.test("proxy: forwards method, path, query, body and x-forwarded-*; strips hop-by-hop", async () => {
	const up = upstream();
	try {
		const app = createRouter();
		app.use(proxy(up.origin, {
			prefix: "/api",
			rewrite: (path) => `/_matrix${path}`,
			headers: (h) => h.set("x-custom", "yes"),
		}));
		app.get("/local", () => new Response("local"));

		const res = await app.fetch(
			new Request("http://example.com/api/echo?q=1", {
				method: "POST",
				body: "hello",
				headers: { host: "example.com", connection: "keep-alive, x-hop", "x-hop": "1" },
			}),
			mockInfo,
		);
		assertEquals(await res.json(), {
			method: "POST",
			path: "/_matrix/echo?q=1",
			forwardedFor: "10.0.0.7",
			forwardedHost: "example.com",
			forwardedProto: "http",
			connection: null,
			custom: "yes",
			body: "hello",
		});

		const local = await app.fetch(new Request("http://example.com/local"), mockInfo);
		assertEquals(await local.text(), "local", "paths outside the prefix fall through");
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("proxy: streams the upstream body chunk by chunk, past compress()", async () => {
	const up = upstream();
	try {
		const app = createRouter();
		app.use(compress());
		app.use(proxy(up.origin, { prefix: "/api", rewrite: (p) => `/_matrix${p}` }));

		const res = await app.fetch(
			new Request("http://example.com/api/sse", { headers: { "accept-encoding": "gzip" } }),
			mockInfo,
		);
		assertEquals(res.headers.get("content-type"), "text/event-stream");
		assertEquals(res.headers.get("content-encoding"), null, "event streams are not compressed");

		const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
		const first = await reader.read();
		assertEquals(
			first.value,
			"data: one\n\n",
			"the first event arrives before the second is written",
		);
		up.gate.resolve();
		const second = await reader.read();
		assertEquals(second.value, "data: two\n\n");
		assertEquals((await reader.read()).done, true);
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("proxy: rewrites set-cookie and passes redirects through untouched", async () => {
	const up = upstream();
	try {
		const app = createRouter();
		app.use(proxy(up.origin, {
			prefix: "/api",
			rewrite: (p) => `/_matrix${p}`,
			cookies: { domain: null, path: "/api" },
		}));

		const res = await app.fetch(new Request("http://example.com/api/cookie"), mockInfo);
		assertEquals(res.headers.getSetCookie(), [
			"sid=1; Path=/api; HttpOnly",
			"theme=dark; Path=/api",
		]);

		const redirect = await app.fetch(new Request("http://example.com/api/redirect"), mockInfo);
		assertEquals(redirect.status, 302);
		assertEquals(redirect.headers.get("location"), "/elsewhere");
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("proxy: a client disconnect aborts the upstream request", async () => {
	const up = upstream();
	try {
		const app = createRouter();
		app.use(proxy(up.origin, { prefix: "/api", rewrite: (p) => `/_matrix${p}` }));

		const controller = new AbortController();
		const pending = app.fetch(
			new Request("http://example.com/api/hang", { signal: controller.signal }),
			mockInfo,
		);
		setTimeout(() => controller.abort(), 20);
		const res = await pending;
		assertEquals(res.status, 499);
		assertEquals(await up.aborted.promise, "upstream saw the abort");
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("proxy: an unreachable upstream is a 502, a slow one a 504", async () => {
	const app = createRouter();
	app.use(proxy("http://127.0.0.1:1", { prefix: "/down" }));
	const res = await app.fetch(new Request("http://example.com/down/x"), mockInfo);
	assertEquals(res.status, 502);

	const up = upstream();
	try {
		const slow = createRouter();
		slow.use(proxy(up.origin, { prefix: "/api", rewrite: (p) => `/_matrix${p}`, timeout: 20 }));
		const late = await slow.fetch(new Request("http://example.com/api/hang"), mockInfo);
		assertEquals(late.status, 504);
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("proxy: bridges websocket upgrades", async () => {
	const up = upstream();
	const app = createRouter();
	app.use(proxy(up.origin, { prefix: "/api", rewrite: (p) => `/_matrix${p}`, websocket: true }));
	const server = Deno.serve({ port: 0, onListen() {} }, app.fetch);
	try {
		const ws = new WebSocket(`ws://localhost:${server.addr.port}/api/ws`);
		const reply = deferred<string>();
		ws.onopen = () => ws.send("hi");
		ws.onmessage = (e) => reply.resolve(e.data);
		assertEquals(await reply.promise, "echo:hi");

		const closed = deferred<number>();
		ws.onclose = (e) => closed.resolve(e.code);
		ws.close(1000, "bye");
		assert(await closed.promise);
	} finally {
		await server.shutdown();
		await up.server.shutdown();
	}
});
