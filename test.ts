/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { assertEquals } from "jsr:@std/assert";
import { parseCookies, serializeCookie } from "./cookie.ts";
import { createRouter } from "./router.ts";
import { rateLimit } from "./middleware.ts";

Deno.test("parseCookies - parses cookie header correctly", () => {
	const result = parseCookies("session=abc123; user=john");
	assertEquals(result, { session: "abc123", user: "john" });
});

Deno.test("serializeCookie - creates cookie string", () => {
	const result = serializeCookie("session", "abc123", {
		httpOnly: true,
		maxAge: 3600,
	});
	assertEquals(result, "session=abc123; Max-Age=3600; Secure; HttpOnly; SameSite=Strict");
});

Deno.test("router - matches routes correctly", async () => {
	const router = createRouter();

	router.get("/users/:id", (ctx) => {
		return ctx.json({ id: ctx.params.id });
	});

	const response = await router.fetch(
		new Request("http://localhost/users/123"),
		{} as Deno.ServeHandlerInfo<Deno.NetAddr>,
	);

	assertEquals(response.status, 200);
	const body = await response.json();
	assertEquals(body.id, "123");
});

Deno.test("router - lists all routes", () => {
	const router = createRouter();

	router.get("/users", () => {});
	router.post("/users", () => {});

	const routes = router.routes;
	assertEquals(routes.length, 2);
	assertEquals(routes[0].method, "GET");
	assertEquals(routes[1].method, "POST");
});

Deno.test("middleware - rate limiter works", async () => {
	const limiter = rateLimit({ windowMs: 1000, max: 2 });
	const router = createRouter();

	router.use(limiter);
	router.get("/test", (ctx) => ctx.text("ok"));

	const res1 = await router.fetch(
		new Request("http://localhost/test"),
		{ remoteAddr: { hostname: "127.0.0.1" } } as any,
	);
	assertEquals(res1.status, 200);

	const res2 = await router.fetch(
		new Request("http://localhost/test"),
		{ remoteAddr: { hostname: "127.0.0.1" } } as any,
	);
	assertEquals(res2.status, 200);

	const res3 = await router.fetch(
		new Request("http://localhost/test"),
		{ remoteAddr: { hostname: "127.0.0.1" } } as any,
	);
	assertEquals(res3.status, 429);

	limiter.cleanup();
});
