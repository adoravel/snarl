/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1.0.17";
import { CookieJar, serializeCookie } from "./cookie.ts";
import { createRouter } from "./router.ts";
import { jsonParser, rateLimit, staticFiles } from "./middleware.ts";
import { NotFoundError, TooManyRequestsError } from "./utils.ts";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

Deno.test("cookies", async (t) => {
	await t.step("parses cookie header correctly", () => {
		const jar = new CookieJar("session=abc123; user=meow");
		assertEquals(jar.get("session"), "abc123");
		assertEquals(jar.get("user"), "meow");
	});

	await t.step("properly handles URL encoded values", () => {
		const jar = new CookieJar("token=abc%20123");
		assertEquals(jar.get("token"), "abc 123");
	});

	await t.step("deduplicates Set-Cookie headers", () => {
		const jar = new CookieJar(null);
		jar.set("session", "first", { path: "/" });
		jar.set("session", "bleh", { path: "/" });

		const headers = jar.getSetCookieHeaders();
		assertEquals(headers.length, 1);
		assertEquals(headers[0].includes("session=bleh"), true);
	});
});

Deno.test("serializeCookie", () => {
	const result = serializeCookie("session", "mraow", {
		httpOnly: true,
		maxAge: 3600,
	});
	assertEquals(result, "session=mraow; Max-Age=3600; Secure; HttpOnly; SameSite=Lax");
});

Deno.test("basic routing", async (t) => {
	await t.step("matches routes correctly", async () => {
		const router = createRouter();
		router.get("/xd/:id", (ctx) => {
			return ctx.json({ id: ctx.params.id });
		});

		const response = await router.fetch(
			new Request("http://localhost/xd/123"),
			mockInfo,
		);

		assertEquals(response.status, 200);
		const body = await response.json();
		assertEquals(body.id, "123");
	});

	await t.step("returns 404 for unmatched routes", async () => {
		const router = createRouter();
		router.get("/only", (ctx) => ctx.text("ok"));

		const response = await router.fetch(new Request("http://localhost/unreal"), mockInfo);
		assertEquals(response.status, 404);
		const body = await response.json();
		assertEquals(body.error, "Not Found");
	});

	await t.step("lists all routes via allRoutes()", () => {
		const router = createRouter();
		router.get("/users", () => {});
		router.post("/users", () => {});

		const routes = router.allRoutes();
		assertEquals(routes.length, 2);
		assertEquals(routes[0].method, "GET");
		assertEquals(routes[1].method, "POST");
	});
});

Deno.test("context", async (t) => {
	await t.step("ctx.query returns URLSearchParams", async () => {
		const router = createRouter();
		router.get("/search", (ctx) => ctx.json({ q: ctx.query.get("q") }));

		const res = await router.fetch(new Request("http://localhost/search?q=snarl"), mockInfo);
		const body = await res.json();
		assertEquals(body.q, "snarl");
	});

	await t.step("ctx.set and ctx.get manage headers", async () => {
		const router = createRouter();
		router.get("/", (ctx) => {
			ctx.set("X-Custom", "heyyyy");
			return ctx.text("ok");
		});

		const res = await router.fetch(new Request("http://localhost/"), mockInfo);
		assertEquals(res.headers.get("X-Custom"), "heyyyy");
	});

	await t.step("ctx.json/jsonParser caching", async () => {
		const router = createRouter();
		router.use(jsonParser());
		router.post("/", async (ctx) => {
			const body1 = await ctx.body.json<{ msg: string }>();
			const body2 = await ctx.body.json<{ msg: string }>();
			return ctx.json({ body1, body2 });
		});

		const req = new Request("http://localhost/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ msg: "hello" }),
		});

		const res = await router.fetch(req, mockInfo);
		const body = await res.json();
		assertEquals(body.body1, { msg: "hello" });
		assertEquals(body.body2, { msg: "hello" });
	});
});

Deno.test("error handling", async (t) => {
	await t.step("http errors are caught and converted to JSON", async () => {
		const router = createRouter();
		router.get("/", () => {
			throw new NotFoundError("My custom message");
		});

		const res = await router.fetch(new Request("http://localhost/"), mockInfo);
		assertEquals(res.status, 404);
		const body = await res.json();
		assertEquals(body.error, "My custom message");
	});

	await t.step("too many requests includes Retry-After header", async () => {
		const router = createRouter();
		router.get("/", () => {
			throw new TooManyRequestsError("slown down mate", "5");
		});

		const res = await router.fetch(new Request("http://localhost/"), mockInfo);
		assertEquals(res.status, 429);
		assertEquals(res.headers.get("Retry-After"), "5");
	});
});

Deno.test("rate limiting", async (t) => {
	await t.step("limits requests correctly", async () => {
		const limiter = rateLimit({ windowMs: 3000, max: 2 });
		const router = createRouter();
		router.use(limiter);
		router.get("/hai", (ctx) => ctx.text("ok"));

		const res1 = await router.fetch(new Request("http://localhost/hai"), mockInfo);
		assertEquals(res1.status, 200);

		const res2 = await router.fetch(new Request("http://localhost/hai"), mockInfo);
		assertEquals(res2.status, 200);

		const res3 = await router.fetch(new Request("http://localhost/hai"), mockInfo);
		assertEquals(res3.status, 429);

		limiter.cleanup();
	});
});

Deno.test("static files", async (t) => {
	const root = await Deno.makeTempDir({ prefix: "snarl-test-" });
	const testFile = "test.txt";

	await Deno.writeTextFile(`${root}/${testFile}`, "bugger off mate");

	await t.step("serves file correctly", async () => {
		const router = createRouter();
		router.use(staticFiles(root));

		const res = await router.fetch(new Request(`http://localhost/${testFile}`), mockInfo);
		assertEquals(res.status, 200);
		assertEquals(await res.text(), "bugger off mate");
	});

	await t.step("prevents directory traversal", async () => {
		const router = createRouter();
		router.use(staticFiles(root));

		const res = await router.fetch(new Request(`http://localhost/../../etc/passwd`), mockInfo);
		assertEquals(res.status, 404);
	});

	await t.step("returns 304 for ETag match", async () => {
		const router = createRouter();
		router.use(staticFiles(root));

		const res1 = await router.fetch(new Request(`http://localhost/${testFile}`), mockInfo);
		const etag = res1.headers.get("ETag");
		assertExists(etag);

		const res2 = await router.fetch(
			new Request(`http://localhost/${testFile}`, { headers: { "If-None-Match": etag } }),
			mockInfo,
		);
		assertEquals(res2.status, 304);
	});

	await t.step("ctx.send helper works", async () => {
		const router = createRouter();
		router.get("/download", (ctx) => ctx.send(`${root}/${testFile}`));

		const res = await router.fetch(new Request("http://localhost/download"), mockInfo);
		assertEquals(res.status, 200);
		assertEquals(await res.text(), "bugger off mate");
		assertEquals(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
	});

	await Deno.remove(root, { recursive: true });
});
