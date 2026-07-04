/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals, assertThrows } from "@std/assert";
import { chain, compose, Context } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

function makeCtx(url = "http://localhost/test", params = {}): Context {
	return new Context(
		new Request(url),
		new URL(url),
		mockInfo,
		params,
		"12reais",
	);
}

Deno.test("context: response helpers", async (t) => {
	await t.step("json response", async () => {
		const ctx = makeCtx();
		const res = ctx.json({ hello: "world" });
		assertEquals(res.status, 200);
		assertEquals(res.headers.get("Content-Type"), "application/json");
		assertEquals(await res.json(), { hello: "world" });
	});

	await t.step("text response", async () => {
		const ctx = makeCtx();
		const res = ctx.text("hello");
		assertEquals(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
		assertEquals(await res.text(), "hello");
	});

	await t.step("html response with doctype", async () => {
		const ctx = makeCtx();
		const res = ctx.html("<h1>hi</h1>");
		assertEquals(res.headers.get("Content-Type"), "text/html; charset=utf-8");
		const body = await res.text();
		assertEquals(body.startsWith("<!DOCTYPE html>"), true);
	});

	await t.step("html response without auto doctype", async () => {
		const ctx = makeCtx();
		const res = ctx.html("<h1>hi</h1>", { autoDoctype: false });
		const body = await res.text();
		assertEquals(body.startsWith("<!DOCTYPE html>"), false);
	});

	await t.step("redirect", () => {
		const ctx = makeCtx();
		const res = ctx.redirect("/login");
		assertEquals(res.status, 302);
		assertEquals(res.headers.get("Location"), "/login");
	});

	await t.step("redirect with custom status", () => {
		const ctx = makeCtx();
		const res = ctx.redirect("/new", 301);
		assertEquals(res.status, 301);
	});

	await t.step("created response", async () => {
		const ctx = makeCtx();
		const res = ctx.created({ id: 1 });
		assertEquals(res.status, 201);
		assertEquals(await res.json(), { id: 1 });
	});

	await t.step("noContent response", () => {
		const ctx = makeCtx();
		const res = ctx.noContent();
		assertEquals(res.status, 204);
		assertEquals(res.body, null);
	});

	await t.step("json with custom status", () => {
		const ctx = makeCtx();
		const res = ctx.json({ error: "gone" }, { status: 410 });
		assertEquals(res.status, 410);
	});
});

Deno.test("context: header management", async (t) => {
	await t.step("set and get", () => {
		const ctx = makeCtx();
		ctx.set("X-Custom", "value");
		assertEquals(ctx.get("X-Custom"), "value");
	});

	await t.step("headers appear on response", () => {
		const ctx = makeCtx();
		ctx.set("X-Custom", "hello");
		const res = ctx.text("ok");
		assertEquals(res.headers.get("X-Custom"), "hello");
	});

	await t.step("set returns this for chaining", () => {
		const ctx = makeCtx();
		const returned = ctx.set("A", "1");
		assertEquals(returned, ctx);
	});
});

Deno.test("context: query params", () => {
	const ctx = makeCtx("http://localhost/test?q=hello&page=2");
	assertEquals(ctx.query.get("q"), "hello");
	assertEquals(ctx.query.get("page"), "2");
	assertEquals(ctx.query.get("missing"), null);
});

Deno.test("context: state", () => {
	const ctx = makeCtx();
	ctx.state.set("user", { id: 1 });
	assertEquals(ctx.state.get("user"), { id: 1 });
});

Deno.test("context: cookies", () => {
	const ctx = new Context(
		new Request("http://localhost/test", { headers: { Cookie: "a=1" } }),
		new URL("http://localhost/test"),
		mockInfo,
		{},
		"12reais",
	);
	assertEquals(ctx.cookies.get("a"), "1");
});

Deno.test("context: requestId", () => {
	const ctx = makeCtx();
	assertEquals(ctx.requestId, "12reais");
});

Deno.test("context: error throwers", () => {
	const ctx = makeCtx();

	assertThrows(() => ctx.notFound("gone"), Error, "gone");
	assertThrows(() => ctx.badRequest("bad"), Error, "bad");
	assertThrows(() => ctx.unauthorized("nope"), Error, "nope");
	assertThrows(() => ctx.forbidden("no"), Error, "no");
	assertThrows(() => ctx.internalError("boom"), Error, "boom");
	assertThrows(() => ctx.tooManyRequests("slow", "5"), Error, "slow");
});

Deno.test("context: compose", async (t) => {
	await t.step("runs middleware in order", async () => {
		const order: string[] = [];

		const mw1 = async (_: Context, next: () => Promise<Response>) => {
			order.push("1-before");
			const res = await next();
			order.push("1-after");
			return res;
		};
		const mw2 = async (_: Context, next: () => Promise<Response>) => {
			order.push("2-before");
			const res = await next();
			order.push("2-after");
			return res;
		};

		const handler = compose([mw1, mw2], (ctx) => {
			order.push("handler");
			return ctx.text("ok");
		});

		await handler(makeCtx());
		assertEquals(order, ["1-before", "2-before", "handler", "2-after", "1-after"]);
	});

	await t.step("short-circuit middleware", async () => {
		const auth = (ctx: Context, _next: () => Promise<Response>) => {
			return ctx.json({ error: "unauthorized" }, { status: 401 });
		};
		const handler = compose([auth], (ctx) => ctx.text("secret"));
		const res = await handler(makeCtx()) as Response;
		assertEquals(res.status, 401);
	});

	await t.step("no middleware passes straight to handler", async () => {
		const handler = compose([], (ctx) => ctx.text("direct"));
		const res = await handler(makeCtx()) as Response;
		assertEquals(await res.text(), "direct");
	});
});

Deno.test("context: chain", async (t) => {
	await t.step("passes through when empty", async () => {
		const mw = chain();
		const res = await mw(makeCtx(), () => Promise.resolve(new Response("ok")));
		assertEquals(await res.text(), "ok");
	});

	await t.step("chains multiple middleware into one", async () => {
		const calls: string[] = [];
		const a = (_ctx: Context, next: () => Promise<Response>) => {
			calls.push("a");
			return next();
		};
		const b = (_ctx: Context, next: () => Promise<Response>) => {
			calls.push("b");
			return next();
		};
		const mw = chain(a, b);
		await mw(makeCtx(), () => {
			calls.push("final");
			return Promise.resolve(new Response("done"));
		});
		assertEquals(calls, ["a", "b", "final"]);
	});
});
