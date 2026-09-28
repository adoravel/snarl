/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRemoteClient, endpoint, remote, v } from "@july/snarl";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
	: false;

interface Seen {
	method: string;
	path: string;
	type: string | null;
	body: string;
	extra: string | null;
}

function upstream() {
	const seen: Seen[] = [];
	const server = Deno.serve({ port: 0, onListen() {} }, async (request) => {
		const url = new URL(request.url);
		const body = request.body ? await request.text() : "";
		seen.push({
			method: request.method,
			path: url.pathname + url.search,
			type: request.headers.get("content-type"),
			body,
			extra: request.headers.get("x-extra"),
		});

		switch (url.pathname) {
			case "/oauth/token":
				return Response.json({ access_token: "tok", expires_in: 604800 });
			case "/upload":
				return Response.json({ bytes: body.length });
			case "/avatar.webp":
				return new Response(new Uint8Array([82, 73, 70, 70]), {
					headers: { "content-type": "image/webp" },
				});
			case "/notify":
				return new Response(null, { status: 204 });
			case "/gone":
				return new Response("missing", { status: 404 });
			case "/plain":
				return new Response("  spaced  ", { headers: { "content-type": "text/plain" } });
			case "/search":
				return Response.json({ query: url.search });
			case "/slow":
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, 5_000);
					request.signal.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve(undefined);
					});
				});
				return new Response("too late");
			default:
				return new Response("nope", { status: 500 });
		}
	});
	return { server, seen, url: `http://localhost:${server.addr.port}` };
}

Deno.test("remote: a form body, for the oauth exchange that will not take json", async () => {
	const up = upstream();
	try {
		const api = remote(up.url, {
			token: endpoint.post("/oauth/token", {
				input: v({
					grant_type: v.string(),
					code: v.string(),
					redirect_uri: v.string(),
				}),
				output: v({ access_token: v.string(), expires_in: v.number() }),
				body: "form",
			}),
		});
		const client = createRemoteClient(api);

		assertEquals(
			await client.token({
				grant_type: "authorization_code",
				code: "c",
				redirect_uri: "https://app/cb",
			}),
			{ access_token: "tok", expires_in: 604800 },
		);
		assertEquals(up.seen[0].type, "application/x-www-form-urlencoded;charset=UTF-8");
		assertEquals(
			up.seen[0].body,
			"grant_type=authorization_code&code=c&redirect_uri=https%3A%2F%2Fapp%2Fcb",
		);
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: raw, multipart and hand-rolled bodies", async () => {
	const up = upstream();
	try {
		const api = remote(up.url, {
			raw: endpoint.post("/upload", { body: "raw" }),
			multipart: endpoint.post("/upload", { input: v({ name: v.string() }), body: "multipart" }),
			text: endpoint.post("/upload", { body: "text" }),
			custom: endpoint.post("/upload", {
				input: v({ lines: v.array(v.string()) }),
				body: (input: { lines: string[] }) => input.lines.join("\n"),
				headers: { "content-type": "text/csv" },
			}),
		});
		const client = createRemoteClient(api);

		await client.raw(new TextEncoder().encode("bytes!") as never);
		assertEquals(up.seen[0].body, "bytes!");
		assertEquals(up.seen[0].type, null, "raw sets no content type of its own");

		await client.multipart({ name: "meow" });
		assert(up.seen[1].type?.startsWith("multipart/form-data; boundary="));
		assert(up.seen[1].body.includes('name="name"'));

		await client.text("hello" as never);
		assertEquals(up.seen[2].type, "text/plain;charset=UTF-8");
		assertEquals(up.seen[2].body, "hello");

		await client.custom({ lines: ["a", "b"] });
		assertEquals(up.seen[3].body, "a\nb");
		assertEquals(up.seen[3].type, "text/csv", "the endpoint's header wins");
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: bodyless posts and fire-and-forget", async () => {
	const up = upstream();
	try {
		const api = remote(up.url, {
			notify: endpoint.post("/notify", {
				input: v({ ping: v.string() }),
				body: "none",
				response: "none",
			}),
			broken: endpoint.post("/gone", { response: "none" }),
		});
		const client = createRemoteClient(api);

		assertEquals(await client.notify({ ping: "x" }), undefined);
		assertEquals(up.seen[0].method, "POST");
		assertEquals(up.seen[0].body, "", "body: none sends nothing, even on a post");

		const result = await client.broken.attempt();
		assert(!result.ok);
		assertEquals(result.error.status, 404);
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: binary and streaming responses, and the raw Response", async () => {
	const up = upstream();
	try {
		const api = remote(up.url, {
			bytes: endpoint.get("/avatar.webp", { response: "bytes" }),
			stream: endpoint.get("/avatar.webp", { response: "stream" }),
			passthrough: endpoint.get("/avatar.webp", { response: "response" }),
			missing: endpoint.get("/gone", { response: "response" }),
			plain: endpoint.get("/plain", {
				response: "text",
				output: v.string().refine((text) => text.includes("spaced"), "not the expected text"),
			}),
			wrong: endpoint.get("/plain", {
				response: "text",
				output: v.string().refine((text) => text === "exact", "not the expected text"),
			}),
		});
		const client = createRemoteClient(api);

		const _bytes: Equal<Awaited<ReturnType<typeof client.bytes>>, Uint8Array> = true;
		const _stream: Equal<
			Awaited<ReturnType<typeof client.stream>>,
			ReadableStream<Uint8Array>
		> = true;
		const _response: Equal<Awaited<ReturnType<typeof client.passthrough>>, Response> = true;
		const _text: Equal<Awaited<ReturnType<typeof client.plain>>, string> = true;
		assert(_bytes && _stream && _response && _text);

		assertEquals(await client.bytes(), new Uint8Array([82, 73, 70, 70]));

		const body = await client.stream();
		assertEquals(
			new Uint8Array(await new Response(body).arrayBuffer()),
			new Uint8Array([82, 73, 70, 70]),
		);

		const proxied = await client.passthrough();
		assertEquals(proxied.headers.get("content-type"), "image/webp");
		await proxied.body?.cancel();

		const gone = await client.missing();
		assertEquals(gone.status, 404);
		assertEquals(await gone.text(), "missing");

		assertEquals(await client.plain(), "  spaced  ", "an output schema still checks the text");

		const wrong = await client.wrong.attempt();
		assert(!wrong.ok);
		assertEquals(wrong.error.code, "invalid");
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: per-call abort, timeouts and headers", async () => {
	const up = upstream();
	try {
		const api = remote(up.url, {
			slow: endpoint.get("/slow"),
			notify: endpoint.post("/notify", { response: "none" }),
		});
		const client = createRemoteClient(api);

		const controller = new AbortController();
		const inflight = client.slow(undefined, { signal: controller.signal });
		controller.abort();
		await assertRejects(() => inflight);

		await assertRejects(() => client.slow(undefined, { timeout: 50 }));

		const bounded = createRemoteClient(api, { timeout: 50 });
		await assertRejects(() => bounded.slow());

		await client.notify(undefined, { headers: { "x-extra": "once" } });
		assertEquals(up.seen.at(-1)?.extra, "once");
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: paths that name their own origin, and query shapes", async () => {
	const up = upstream();
	try {
		const api = remote("https://api.example", {
			elsewhere: endpoint.get(`${up.url}/search`, {
				input: v({ q: v.string() }),
				output: v({ query: v.string() }),
			}),
			preset: endpoint.get(`${up.url}/search?type=user`, {
				input: v({ q: v.string() }),
				output: v({ query: v.string() }),
			}),
			joined: endpoint.get(`${up.url}/search`, {
				input: v({ tags: v.array(v.string()) }),
				output: v({ query: v.string() }),
				query: (input) => `tags=${(input.tags as string[]).join(",")}`,
			}),
		});
		const client = createRemoteClient(api);

		assertEquals(await client.elsewhere({ q: "a" }), { query: "?q=a" });
		assertEquals(
			await client.preset({ q: "a" }),
			{ query: "?type=user&q=a" },
			"a declared query is kept and appended to",
		);
		assertEquals(await client.joined({ tags: ["x", "y"] }), { query: "?tags=x,y" });
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: onError is told which endpoint failed", async () => {
	const up = upstream();
	try {
		const api = remote(up.url, { gone: endpoint.get("/gone") });
		const named: string[] = [];
		const client = createRemoteClient(api, {
			onError: (response, _body, info) => {
				named.push(`${info.path} ${info.verb} ${info.url} ${response.status}`);
				return undefined;
			},
		});

		await client.gone.attempt();
		assertEquals(named, ["gone GET /gone 404"]);
	} finally {
		await up.server.shutdown();
	}
});
