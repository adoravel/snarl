/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1.0.17";
import { CookieJar, serializeCookie } from "./cookie.ts";
import { createRouter } from "./router.ts";
import { formParser, jsonParser, rateLimit, staticFiles } from "./middleware.ts";
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

		const { headers } = jar;
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

Deno.test("trie routing: static routes", async (t) => {
	await t.step("matches exact static paths", async () => {
		const router = createRouter();
		router.get("/cats", (ctx) => ctx.json({ page: "meow" }));
		router.get("/posts", (ctx) => ctx.json({ page: "posts" }));

		const res1 = await router.fetch(new Request("http://localhost/cats"), mockInfo);
		assertEquals(res1.status, 200);
		assertEquals(await res1.json(), { page: "meow" });

		const res2 = await router.fetch(new Request("http://localhost/posts"), mockInfo);
		assertEquals(res2.status, 200);
		assertEquals(await res2.json(), { page: "posts" });
	});

	await t.step("distinguishes between similar paths", async () => {
		const router = createRouter();
		router.get("/user", (ctx) => ctx.json({ type: "single" }));
		router.get("/users", (ctx) => ctx.json({ type: "plural" }));
		router.get("/user/profile", (ctx) => ctx.json({ type: "profile" }));

		const res1 = await router.fetch(new Request("http://localhost/user"), mockInfo);
		assertEquals(await res1.json(), { type: "single" });

		const res2 = await router.fetch(new Request("http://localhost/users"), mockInfo);
		assertEquals(await res2.json(), { type: "plural" });

		const res3 = await router.fetch(new Request("http://localhost/user/profile"), mockInfo);
		assertEquals(await res3.json(), { type: "profile" });
	});

	await t.step("handles trailing slashes correctly", async () => {
		const router = createRouter();
		router.get("/api/users", (ctx) => ctx.json({ ok: true }));

		const res1 = await router.fetch(new Request("http://localhost/api/users"), mockInfo);
		assertEquals(res1.status, 200);

		const res2 = await router.fetch(new Request("http://localhost/api/users/"), mockInfo);
		assertEquals(res2.status, 200);
	});

	await t.step("handles root path", async () => {
		const router = createRouter();
		router.get("/", (ctx) => ctx.json({ root: true }));

		const res = await router.fetch(new Request("http://localhost/"), mockInfo);
		assertEquals(res.status, 200);
		assertEquals(await res.json(), { root: true });
	});
});

Deno.test("trie routing: dynamic parameters", async (t) => {
	await t.step("extracts single parameter", async () => {
		const router = createRouter();
		router.get("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }));

		const res = await router.fetch(new Request("http://localhost/users/42"), mockInfo);
		assertEquals(res.status, 200);
		assertEquals(await res.json(), { id: "42" });
	});

	await t.step("extracts multiple parameters", async () => {
		const router = createRouter();
		router.get(
			"/cats/:feline/meow/:mrrp",
			(ctx) => ctx.json({ feline: ctx.params.feline, mrrp: ctx.params.mrrp }),
		);

		const res = await router.fetch(new Request("http://localhost/cats/123/meow/456"), mockInfo);
		assertEquals(await res.json(), { feline: "123", mrrp: "456" });
	});

	await t.step("decodes URL-encoded parameters", async () => {
		const router = createRouter();
		router.get("/search/:query", (ctx) => ctx.json({ query: ctx.params.query }));

		const res = await router.fetch(
			new Request("http://localhost/search/hello%20world"),
			mockInfo,
		);
		assertEquals(await res.json(), { query: "hello world" });
	});

	await t.step("handles special characters in params", async () => {
		const router = createRouter();
		router.get("/file/:name", (ctx) => ctx.json({ name: ctx.params.name }));

		const res = await router.fetch(
			new Request("http://localhost/file/test%26file.txt"),
			mockInfo,
		);
		assertEquals(await res.json(), { name: "test&file.txt" });
	});
});

Deno.test("trie routing: optional parameters", async (t) => {
	await t.step("matches with optional param present", async () => {
		const router = createRouter();
		router.get("/posts/:id?", (ctx) => ctx.json({ id: ctx.params.id || null }));

		const res = await router.fetch(new Request("http://localhost/posts/123"), mockInfo);
		assertEquals(await res.json(), { id: "123" });
	});

	await t.step("matches with optional param absent", async () => {
		const router = createRouter();
		router.get("/posts/:id?", (ctx) => ctx.json({ id: ctx.params.id || null }));

		const res = await router.fetch(new Request("http://localhost/posts"), mockInfo);
		assertEquals(await res.json(), { id: null });
	});
});

Deno.test("trie routing: wildcard routes", async (t) => {
	await t.step("captures remaining path segments", async () => {
		const router = createRouter();
		router.get("/files/*", (ctx) => ctx.json({ path: ctx.params["*"] }));

		const res = await router.fetch(
			new Request("http://localhost/files/docs/api/readme.md"),
			mockInfo,
		);
		assertEquals(await res.json(), { path: "docs/api/readme.md" });
	});

	await t.step("wildcard with empty path", async () => {
		const router = createRouter();
		router.get("/static/*", (ctx) => ctx.json({ path: ctx.params["*"] || "" }));

		const res = await router.fetch(new Request("http://localhost/static/"), mockInfo);
		assertEquals(await res.json(), { path: "" });
	});
});

Deno.test("trie routing: priority and precedence", async (t) => {
	await t.step("static routes take precedence over params", async () => {
		const router = createRouter();
		router.get("/users/new", (ctx) => ctx.json({ type: "new" }));
		router.get("/users/:id", (ctx) => ctx.json({ type: "id", id: ctx.params.id }));

		const res1 = await router.fetch(new Request("http://localhost/users/new"), mockInfo);
		assertEquals(await res1.json(), { type: "new" });

		const res2 = await router.fetch(new Request("http://localhost/users/123"), mockInfo);
		assertEquals(await res2.json(), { type: "id", id: "123" });
	});

	await t.step("params take precedence over wildcards", async () => {
		const router = createRouter();
		router.get("/api/:resource", (ctx) => ctx.json({ type: "param", resource: ctx.params.resource }));
		router.get("/api/*", (ctx) => ctx.json({ type: "wildcard", path: ctx.params["*"] }));

		const res = await router.fetch(new Request("http://localhost/api/users"), mockInfo);
		assertEquals(await res.json(), { type: "param", resource: "users" });
	});

	await t.step("registration order doesn't affect precedence", async () => {
		const router = createRouter();

		router.get("/users/:id", (ctx) => ctx.json({ type: "param" }));
		router.get("/users/admin", (ctx) => ctx.json({ type: "static" }));

		const res = await router.fetch(new Request("http://localhost/users/admin"), mockInfo);
		assertEquals(await res.json(), { type: "static" });
	});
});

Deno.test("trie routing: edge cases", async (t) => {
	await t.step("handles empty path segments", async () => {
		const router = createRouter();
		router.get("/api//users", (ctx) => ctx.json({ ok: true }));

		const res = await router.fetch(new Request("http://localhost/api//users"), mockInfo);
		assertEquals(res.status, 200);
	});

	await t.step("handles deeply nested routes", async () => {
		const router = createRouter();
		router.get("/a/b/c/d/e/f/g", (ctx) => ctx.json({ depth: 7 }));

		const res = await router.fetch(new Request("http://localhost/a/b/c/d/e/f/g"), mockInfo);
		assertEquals(await res.json(), { depth: 7 });
	});

	await t.step("handles routes with many parameters", async () => {
		const router = createRouter();
		router.get("/:a/:b/:c/:d/:e", (ctx) =>
			ctx.json({
				a: ctx.params.a,
				b: ctx.params.b,
				c: ctx.params.c,
				d: ctx.params.d,
				e: ctx.params.e,
			}));

		const res = await router.fetch(new Request("http://localhost/1/2/3/4/5"), mockInfo);
		assertEquals(await res.json(), { a: "1", b: "2", c: "3", d: "4", e: "5" });
	});

	await t.step("404 for non-existent routes", async () => {
		const router = createRouter();
		router.get("/users", (ctx) => ctx.json({ ok: true }));

		const res = await router.fetch(new Request("http://localhost/posts"), mockInfo);
		assertEquals(res.status, 404);
	});

	await t.step("handles malformed URL encoding gracefully", async () => {
		const router = createRouter();
		router.get("/search/:query", (ctx) => ctx.json({ query: ctx.params.query }));

		// Invalid percent encoding - should not crash
		const res = await router.fetch(new Request("http://localhost/search/%ZZ"), mockInfo);
		assertEquals(res.status, 200);
		const body = await res.json();
		assertEquals(body.query, "%ZZ"); // Should keep original if decode fails
	});
});

Deno.test("trie routing: method isolation", async (t) => {
	await t.step("different methods on same path", async () => {
		const router = createRouter();
		router.get("/resource", (ctx) => ctx.json({ method: "GET" }));
		router.post("/resource", (ctx) => ctx.json({ method: "POST" }));
		router.delete("/resource", (ctx) => ctx.json({ method: "DELETE" }));

		const get = await router.fetch(new Request("http://localhost/resource"), mockInfo);
		assertEquals(await get.json(), { method: "GET" });

		const post = await router.fetch(
			new Request("http://localhost/resource", { method: "POST" }),
			mockInfo,
		);
		assertEquals(await post.json(), { method: "POST" });

		const del = await router.fetch(
			new Request("http://localhost/resource", { method: "DELETE" }),
			mockInfo,
		);
		assertEquals(await del.json(), { method: "DELETE" });
	});

	await t.step("405 not implemented for method", async () => {
		const router = createRouter();
		router.get("/users", (ctx) => ctx.json({ ok: true }));

		const res = await router.fetch(
			new Request("http://localhost/users", { method: "POST" }),
			mockInfo,
		);
		assertEquals(res.status, 404); // No POST handler = 404
	});
});

Deno.test("trie routing: route groups", async (t) => {
	await t.step("applies prefix to grouped routes", async () => {
		const router = createRouter();
		router.group("/api", (api) => {
			api.get("/users", (ctx) => ctx.json({ group: "api" }));
			api.get("/posts", (ctx) => ctx.json({ group: "api" }));
		});

		const res1 = await router.fetch(new Request("http://localhost/api/users"), mockInfo);
		assertEquals(await res1.json(), { group: "api" });

		const res2 = await router.fetch(new Request("http://localhost/api/posts"), mockInfo);
		assertEquals(await res2.json(), { group: "api" });
	});

	await t.step("nested groups", async () => {
		const router = createRouter();
		router.group("/api", (api) => {
			api.group("/v1", (v1) => {
				v1.get("/users", (ctx) => ctx.json({ version: "v1" }));
			});
		});

		const res = await router.fetch(new Request("http://localhost/api/v1/users"), mockInfo);
		assertEquals(await res.json(), { version: "v1" });
	});
});

Deno.test("trie routing: performance characteristics", async (t) => {
	await t.step("scales with many routes", async () => {
		const router = createRouter();

		for (let i = 0; i < 1000; i++) {
			router.get(`/route${i}`, (ctx) => ctx.json({ route: i }));
		}

		const start = performance.now();
		const res = await router.fetch(new Request("http://localhost/route999"), mockInfo);
		const elapsed = performance.now() - start;

		assertEquals(res.status, 200);
		assertEquals(await res.json(), { route: 999 });
		assertEquals(elapsed < 25, true, `Routing took ${elapsed}ms, expected < 25ms`);
	});

	await t.step("efficient param extraction", async () => {
		const router = createRouter();
		router.get("/a/:p1/b/:p2/c/:p3/d/:p4/e/:p5", (ctx) =>
			ctx.json({
				p1: ctx.params.p1,
				p2: ctx.params.p2,
				p3: ctx.params.p3,
				p4: ctx.params.p4,
				p5: ctx.params.p5,
			}));

		const start = performance.now();
		const res = await router.fetch(
			new Request("http://localhost/a/1/b/2/c/3/d/4/e/5"),
			mockInfo,
		);
		const elapsed = performance.now() - start;

		assertEquals(await res.json(), { p1: "1", p2: "2", p3: "3", p4: "4", p5: "5" });
		assertEquals(elapsed < 5, true, `Param extraction took ${elapsed}ms, expected < 5ms`);
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

		// test-suite constraint
		(limiter as any).cleanup();
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

Deno.test("formParser", async (t) => {
	await t.step("parses form data and caches it", async () => {
		const router = createRouter();
		router.use(formParser());

		router.post("/submit", async (ctx) => {
			const body = await ctx.body.json();

			if (typeof body === "object") {
				return ctx.json({ received: body });
			} else {
				return ctx.json({ status: "invalid bruh" });
			}
		});

		const req = new Request("http://localhost/submit", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "meow=mrrp&myage=13",
		});

		const res = await router.fetch(req, mockInfo);
		assertEquals(res.status, 200);

		const json = await res.json();
		assertEquals(json.received, { meow: "mrrp", myage: "13" });
	});
});

Deno.test("static files dotfiles security", async (t) => {
	const root = await Deno.makeTempDir({ prefix: "snarl-dotfiles-or-smth-" });

	await Deno.writeTextFile(`${root}/visible.txt`, "I am very visible");
	await Deno.writeTextFile(`${root}/.env`, "SECRET_KEY=123");

	await Deno.mkdir(`${root}/.git`);
	await Deno.writeTextFile(`${root}/.git/config`, "[core]\nrepositoryformatversion = 0");

	await t.step("default mode (ignore) returns 404 for hidden files", async () => {
		const router = createRouter();
		router.use(staticFiles(root));

		const res = await router.fetch(new Request("http://localhost/.env"), mockInfo);
		assertEquals(res.status, 404);
	});

	await t.step("default mode (ignore) returns 404 for files inside hidden directories", async () => {
		const router = createRouter();
		router.use(staticFiles(root));

		const res = await router.fetch(new Request("http://localhost/.git/config"), mockInfo);
		assertEquals(res.status, 404);
	});

	await t.step("default mode (ignore) serves visible files normally", async () => {
		const router = createRouter();
		router.use(staticFiles(root));

		const res = await router.fetch(new Request("http://localhost/visible.txt"), mockInfo);
		assertEquals(res.status, 200);
		assertEquals(await res.text(), "I am very visible");
	});

	await t.step("deny mode returns 403 for hidden files", async () => {
		const router = createRouter();
		router.use(staticFiles(root, { dotfiles: "deny" }));

		const res = await router.fetch(new Request("http://localhost/.env"), mockInfo);
		assertEquals(res.status, 403);
	});

	await t.step("deny mode returns 403 for files inside hidden directories", async () => {
		const router = createRouter();
		router.use(staticFiles(root, { dotfiles: "deny" }));

		const res = await router.fetch(new Request("http://localhost/.git/config"), mockInfo);
		assertEquals(res.status, 403);
	});

	await t.step("allow mode serves hidden files successfully", async () => {
		const router = createRouter();
		router.use(staticFiles(root, { dotfiles: "allow" }));

		const res = await router.fetch(new Request("http://localhost/.env"), mockInfo);
		assertEquals(res.status, 200);
		assertEquals(await res.text(), "SECRET_KEY=123");
	});

	await t.step("allow mode serves files inside hidden directories", async () => {
		const router = createRouter();
		router.use(staticFiles(root, { dotfiles: "allow" }));

		const res = await router.fetch(new Request("http://localhost/.git/config"), mockInfo);
		assertEquals(res.status, 200);
		assertEquals(await res.text(), "[core]\nrepositoryformatversion = 0");
	});

	await Deno.remove(root, { recursive: true });
});
