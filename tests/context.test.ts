/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { Context, MutableResponse } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

function makeCtx(url = "http://localhost/test"): Context {
	const u = new URL(url);
	return new Context(new Request(url), u.pathname, u.search, mockInfo, {}, "id");
}

Deno.test("MutableResponse: text()/bytes() cross-populate their caches", async (t) => {
	await t.step("text() on a string body populates the text cache directly", async () => {
		const res = new MutableResponse("hello");
		assertEquals(await res.text(), "hello");
	});
	await t.step("bytes() on a string body encodes and caches", async () => {
		const res = new MutableResponse("hello");
		const bytes = await res.bytes();
		assertEquals(new TextDecoder().decode(bytes!), "hello");
	});
	await t.step(
		"text() after bytes() reuses the byte cache instead of re-reading the body",
		async () => {
			const res = new MutableResponse(new TextEncoder().encode("cached"));
			await res.bytes();
			assertEquals(await res.text(), "cached");
		},
	);
	await t.step("bytes() after text() reuses the text cache", async () => {
		const res = new MutableResponse("cached-other-way");
		await res.text();
		const bytes = await res.bytes();
		assertEquals(new TextDecoder().decode(bytes!), "cached-other-way");
	});
	await t.step("null body: both accessors return null without throwing", async () => {
		const res = new MutableResponse(null);
		assertEquals(await res.text(), null);
		assertEquals(await res.bytes(), null);
	});
	await t.step("ArrayBuffer body is normalised through both accessors", async () => {
		const buf = new TextEncoder().encode("buf-body").buffer;
		const res = new MutableResponse(buf as ArrayBuffer);
		assertEquals(await res.text(), "buf-body");
	});
});

Deno.test("MutableResponse.from: wraps a real Response, preserving status/headers", async () => {
	const original = new Response("body", { status: 201, headers: { "X-A": "1" } });
	const wrapped = MutableResponse.from(original);
	assertEquals(wrapped.status, 201);
	assertEquals(wrapped.headers.get("X-A"), "1");
	assertEquals(await wrapped.text(), "body");
});

Deno.test("MutableResponse.toResponse(): re-serialises cached text without consuming a stream twice", async () => {
	const res = new MutableResponse("x");
	await res.text();
	const out = res.toResponse();
	assertEquals(await out.text(), "x");
});

Deno.test("Context.is(): matches single and array content-type predicates", () => {
	const ctx = new Context(
		new Request("http://localhost/", {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
		}),
		"/",
		"",
		mockInfo,
		{},
		"id",
	);
	assertEquals(ctx.is("application/json"), true);
	assertEquals(ctx.is("text/plain"), false);
	assertEquals(ctx.is(["text/plain", "application/json"]), true);
});

Deno.test("Context.is(): false when there is no Content-Type header at all", () => {
	const ctx = makeCtx();
	assertEquals(ctx.is("application/json"), false);
});

Deno.test("Context: setting a header forces the merged response() path, not the direct shortcut", () => {
	const ctx = makeCtx();
	ctx.set("X-Custom", "v");
	const res = ctx.json({ a: 1 });
	assertEquals(res.headers.get("X-Custom"), "v");
	assertEquals(res.headers.get("Content-Type"), "application/json");
});

Deno.test("Context: cookies set on the response merge alongside custom headers", () => {
	const ctx = makeCtx();
	ctx.cookies.set("session", "abc");
	const res = ctx.text("ok");
	assertEquals(res.headers.get("Set-Cookie")?.startsWith("session=abc"), true);
});

Deno.test("Context: requestId generator function is called at most once and cached", () => {
	let calls = 0;
	const ctx = new Context(new Request("http://localhost/"), "/", "", mockInfo, {}, () => {
		calls++;
		return "generated";
	});
	assertEquals(ctx.requestId, "generated");
	assertEquals(ctx.requestId, "generated");
	assertEquals(calls, 1);
});
