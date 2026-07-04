/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals } from "@std/assert";
import { createRouter, httpMethods, NotFoundError } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

Deno.test("router: static routes", async (t) => {
	await t.step("matches exact static paths", async () => {
		const router = createRouter();
		router.get("/cats", (ctx) => ctx.json({ page: "cats" }));
		router.get("/posts", (ctx) => ctx.json({ page: "posts" }));

		const r1 = await router.fetch(new Request("http://localhost/cats"), mockInfo);
		assertEquals(await r1.json(), { page: "cats" });

		const r2 = await router.fetch(new Request("http://localhost/posts"), mockInfo);
		assertEquals(await r2.json(), { page: "posts" });
	});

	await t.step("distinguishes similar paths", async () => {
		const router = createRouter();
		router.get("/user", (ctx) => ctx.json({ t: "single" }));
		router.get("/users", (ctx) => ctx.json({ t: "plural" }));
		router.get("/user/profile", (ctx) => ctx.json({ t: "profile" }));

		assertEquals(await (await router.fetch(new Request("http://localhost/user"), mockInfo)).json(), { t: "single" });
		assertEquals(await (await router.fetch(new Request("http://localhost/users"), mockInfo)).json(), { t: "plural" });
		assertEquals(
			await (await router.fetch(new Request("http://localhost/user/profile"), mockInfo)).json(),
			{ t: "profile" },
		);
	});

	await t.step("handles trailing slashes", async () => {
		const router = createRouter();
		router.get("/api/users", (ctx) => ctx.json({ ok: true }));

		assertEquals((await router.fetch(new Request("http://localhost/api/users"), mockInfo)).status, 200);
		assertEquals((await router.fetch(new Request("http://localhost/api/users/"), mockInfo)).status, 200);
	});

	await t.step("handles root path", async () => {
		const router = createRouter();
		router.get("/", (ctx) => ctx.json({ root: true }));
		const res = await router.fetch(new Request("http://localhost/"), mockInfo);
		assertEquals(await res.json(), { root: true });
	});

	await t.step("handles (empty) root path", async () => {
		const router = createRouter();
		router.get("/", (ctx) => ctx.json({ home: true }));
		const res = await router.fetch(new Request("http://localhost"), mockInfo);
		assertEquals(await res.json(), { home: true });
	});
});

Deno.test("router: dynamic parameters", async (t) => {
	await t.step("extracts single param", async () => {
		const router = createRouter();
		router.get("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }));
		const res = await router.fetch(new Request("http://localhost/users/42"), mockInfo);
		assertEquals(await res.json(), { id: "42" });
	});

	await t.step("extracts multiple params", async () => {
		const router = createRouter();
		router.get("/cats/:feline/meow/:mrrp", (ctx) => ctx.json({ feline: ctx.params.feline, mrrp: ctx.params.mrrp }));
		const res = await router.fetch(new Request("http://localhost/cats/123/meow/456"), mockInfo);
		assertEquals(await res.json(), { feline: "123", mrrp: "456" });
	});

	await t.step("decodes URL-encoded params", async () => {
		const router = createRouter();
		router.get("/search/:query", (ctx) => ctx.json({ query: ctx.params.query }));
		const res = await router.fetch(new Request("http://localhost/search/haii%20world"), mockInfo);
		assertEquals(await res.json(), { query: "haii world" });
	});

	await t.step("handles special chars in params", async () => {
		const router = createRouter();
		router.get("/file/:name", (ctx) => ctx.json({ name: ctx.params.name }));
		const res = await router.fetch(new Request("http://localhost/file/test%26file.txt"), mockInfo);
		assertEquals(await res.json(), { name: "test&file.txt" });
	});

	await t.step("handles unicode in params", async () => {
		const router = createRouter();
		router.get("/café/:city", (ctx) => ctx.json({ city: ctx.params.city }));
		const res = await router.fetch(
			new Request("http://localhost/caf%C3%A9/m%C3%BCnchen"),
			mockInfo,
		);
		assertEquals(await res.json(), { city: "münchen" });
	});

	await t.step("handles malformed encoding gracefully", async () => {
		const router = createRouter();
		router.get("/search/:query", (ctx) => ctx.json({ query: ctx.params.query }));
		const res = await router.fetch(new Request("http://localhost/search/%ZZ"), mockInfo);
		assertEquals((await res.json()).query, "%ZZ");
	});
});

Deno.test("router: optional parameters", async (t) => {
	await t.step("present", async () => {
		const router = createRouter();
		router.get("/posts/:id?", (ctx) => ctx.json({ id: ctx.params.id ?? null }));
		const res = await router.fetch(new Request("http://localhost/posts/123"), mockInfo);
		assertEquals(await res.json(), { id: "123" });
	});

	await t.step("absent", async () => {
		const router = createRouter();
		router.get("/posts/:id?", (ctx) => ctx.json({ id: ctx.params.id ?? null }));
		const res = await router.fetch(new Request("http://localhost/posts"), mockInfo);
		assertEquals(await res.json(), { id: null });
	});

	await t.step("optional param in middle of path", async () => {
		const router = createRouter();
		router.get("/users/:id?/posts", (ctx) => ctx.json({ id: ctx.params.id ?? "all", page: "posts" }));

		let res = await router.fetch(new Request("http://localhost/users/42/posts"), mockInfo);
		assertEquals(await res.json(), { id: "42", page: "posts" });

		res = await router.fetch(new Request("http://localhost/users/posts"), mockInfo);
		assertEquals(await res.json(), { id: "all", page: "posts" });
	});

	await t.step("multiple optional params", async () => {
		const router = createRouter();
		router.get("/a/:b?/:c?", (ctx) => ctx.json({ b: ctx.params.b ?? null, c: ctx.params.c ?? null }));

		assertEquals(
			await (await router.fetch(new Request("http://localhost/a/x/y"), mockInfo)).json(),
			{ b: "x", c: "y" },
		);
		assertEquals(
			await (await router.fetch(new Request("http://localhost/a/x"), mockInfo)).json(),
			{ b: "x", c: null },
		);
		assertEquals(
			await (await router.fetch(new Request("http://localhost/a"), mockInfo)).json(),
			{ b: null, c: null },
		);
	});
});

Deno.test("router: wildcard routes", async (t) => {
	await t.step("captures remaining path segments", async () => {
		const router = createRouter();
		router.get("/files/*", (ctx) => ctx.json({ path: ctx.params["*"] }));
		const res = await router.fetch(new Request("http://localhost/files/docs/api/readme.md"), mockInfo);
		assertEquals(await res.json(), { path: "docs/api/readme.md" });
	});

	await t.step("wildcard with empty path", async () => {
		const router = createRouter();
		router.get("/static/*", (ctx) => ctx.json({ path: ctx.params["*"] || "" }));
		const res = await router.fetch(new Request("http://localhost/static/"), mockInfo);
		assertEquals(await res.json(), { path: "" });
	});

	await t.step("named wildcard", async () => {
		const router = createRouter();
		router.get("/assets/*path", (ctx) => ctx.json({ path: ctx.params.path }));
		const res = await router.fetch(new Request("http://localhost/assets/images/logo.png"), mockInfo);
		assertEquals(await res.json(), { path: "images/logo.png" });
	});

	await t.step("root-level wildcard", async () => {
		const router = createRouter();
		router.get("/*", (ctx) => ctx.json({ path: ctx.params["*"] }));
		const res = await router.fetch(new Request("http://localhost/anything/at/all"), mockInfo);
		assertEquals(await res.json(), { path: "anything/at/all" });
	});
});

Deno.test("router: precedence", async (t) => {
	await t.step("static beats param", async () => {
		const router = createRouter();
		router.get("/users/new", (ctx) => ctx.json({ type: "new" }));
		router.get("/users/:id", (ctx) => ctx.json({ type: "id", id: ctx.params.id }));

		assertEquals(await (await router.fetch(new Request("http://localhost/users/new"), mockInfo)).json(), {
			type: "new",
		});
		assertEquals(await (await router.fetch(new Request("http://localhost/users/123"), mockInfo)).json(), {
			type: "id",
			id: "123",
		});
	});

	await t.step("param beats wildcard", async () => {
		const router = createRouter();
		router.get("/api/:resource", (ctx) => ctx.json({ type: "param" }));
		router.get("/api/*", (ctx) => ctx.json({ type: "wildcard" }));
		assertEquals(
			await (await router.fetch(new Request("http://localhost/api/users"), mockInfo)).json(),
			{ type: "param" },
		);
	});

	await t.step("order-independent", async () => {
		const router = createRouter();
		router.get("/users/:id", (ctx) => ctx.json({ type: "param" }));
		router.get("/users/admin", (ctx) => ctx.json({ type: "static" }));
		assertEquals(
			await (await router.fetch(new Request("http://localhost/users/admin"), mockInfo)).json(),
			{ type: "static" },
		);
	});

	await t.step("more specific path wins with same segment types", async () => {
		const router = createRouter();
		router.get("/a/:b", (ctx) => ctx.json({ t: "short" }));
		router.get("/a/:b/c", (ctx) => ctx.json({ t: "long" }));

		assertEquals(await (await router.fetch(new Request("http://localhost/a/x"), mockInfo)).json(), { t: "short" });
		assertEquals(await (await router.fetch(new Request("http://localhost/a/x/c"), mockInfo)).json(), { t: "long" });
	});
});

Deno.test("router: method isolation", async (t) => {
	await t.step("different methods on same path", async () => {
		const router = createRouter();
		router.get("/r", (ctx) => ctx.json({ m: "GET" }));
		router.post("/r", (ctx) => ctx.json({ m: "POST" }));
		router.put("/r", (ctx) => ctx.json({ m: "PUT" }));
		router.patch("/r", (ctx) => ctx.json({ m: "PATCH" }));
		router.delete("/r", (ctx) => ctx.json({ m: "DELETE" }));

		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
			const res = await router.fetch(new Request("http://localhost/r", { method }), mockInfo);
			assertEquals(await res.json(), { m: method });
		}
	});

	await t.step("HEAD falls back to GET when no explicit HEAD", async () => {
		const router = createRouter();
		router.get("/data", (ctx) => ctx.text("hello"));

		const res = await router.fetch(new Request("http://localhost/data", { method: "HEAD" }), mockInfo);
		assertEquals(res.status, 200);
		assertEquals(res.body, null);
		assertEquals(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
	});

	await t.step("HEAD uses explicit HEAD handler if registered", async () => {
		const router = createRouter();
		router.get("/data", (ctx) => ctx.text("get"));
		router.head("/data", (ctx) => {
			ctx.set("X-Head", "yes");
			return ctx.text("head");
		});

		const res = await router.fetch(new Request("http://localhost/data", { method: "HEAD" }), mockInfo);
		assertEquals(res.headers.get("X-Head"), "yes");
	});

	await t.step("OPTIONS works", async () => {
		const router = createRouter();
		router.options("/cors", (ctx) => ctx.noContent());
		const res = await router.fetch(new Request("http://localhost/cors", { method: "OPTIONS" }), mockInfo);
		assertEquals(res.status, 204);
	});

	await t.step("unknown method returns 404", async () => {
		const router = createRouter();
		router.get("/users", (ctx) => ctx.json({ ok: true }));
		const res = await router.fetch(new Request("http://localhost/users", { method: "POST" }), mockInfo);
		assertEquals(res.status, 404);
	});
});

Deno.test("router: groups", async (t) => {
	await t.step("applies prefix", async () => {
		const router = createRouter();
		router.group("/api", (api) => {
			api.get("/users", (ctx) => ctx.json({ g: "api" }));
		});
		const res = await router.fetch(new Request("http://localhost/api/users"), mockInfo);
		assertEquals(await res.json(), { g: "api" });
	});

	await t.step("nested groups", async () => {
		const router = createRouter();
		router.group("/api", (api) => {
			api.group("/v1", (v1) => {
				v1.get("/users", (ctx) => ctx.json({ v: "v1" }));
			});
		});
		const res = await router.fetch(new Request("http://localhost/api/v1/users"), mockInfo);
		assertEquals(await res.json(), { v: "v1" });
	});

	await t.step("group with empty prefix", async () => {
		const router = createRouter();
		router.group("", (g) => {
			g.get("/home", (ctx) => ctx.json({ ok: true }));
		});
		const res = await router.fetch(new Request("http://localhost/home"), mockInfo);
		assertEquals(res.status, 200);
	});

	await t.step("group normalises duplicate slashes in prefix", async () => {
		const router = createRouter();
		router.group("//api//", (g) => {
			g.get("/users", (ctx) => ctx.json({ ok: true }));
		});
		const res = await router.fetch(new Request("http://localhost/api/users"), mockInfo);
		assertEquals(res.status, 200);
	});

	await t.step("group middleware composes", async () => {
		const router = createRouter();
		const calls: string[] = [];

		router.group("/admin", (admin) => {
			admin.use((_, next) => {
				calls.push("mw");
				return next();
			});
			admin.get("/dashboard", (ctx) => {
				calls.push("handler");
				return ctx.text("ok");
			});
		});

		await router.fetch(new Request("http://localhost/admin/dashboard"), mockInfo);
		assertEquals(calls, ["mw", "handler"]);
	});

	await t.step("nested group middleware inheritance", async () => {
		const router = createRouter();
		const calls: string[] = [];

		router.group("/api", (api) => {
			api.use((_, next) => {
				calls.push("api-mw");
				return next();
			});
			api.group("/v1", (v1) => {
				v1.use((_, next) => {
					calls.push("v1-mw");
					return next();
				});
				v1.get("/users", (ctx) => {
					calls.push("handler");
					return ctx.text("ok");
				});
			});
		});

		await router.fetch(new Request("http://localhost/api/v1/users"), mockInfo);
		assertEquals(calls, ["api-mw", "v1-mw", "handler"]);
	});
});

Deno.test("router: all() method", async (t) => {
	await t.step("registers for all HTTP methods", async () => {
		const router = createRouter();
		router.all("/ping", (ctx) => ctx.text("pong"));

		for (const method of httpMethods) {
			const res = await router.fetch(new Request("http://localhost/ping", { method }), mockInfo);
			assertEquals(res.status, method === "HEAD" ? 200 : 200);
		}
	});
});

Deno.test("router: allRoutes()", () => {
	const router = createRouter();
	router.get("/a", (ctx) => ctx.text("a"), { description: "route a" });
	router.post("/b", (ctx) => ctx.text("b"));

	const routes = router.allRoutes();
	assertEquals(routes.length, 2);
	assertEquals(routes[0].method, "GET");
	assertEquals(routes[0].metadata?.description, "route a");
	assertEquals(routes[1].method, "POST");
});

Deno.test("router: error handling", async (t) => {
	await t.step("custom onNotFound", async () => {
		const router = createRouter({
			onNotFound: (ctx) => ctx.json({ custom: "missing" }, { status: 404 }),
		});
		const res = await router.fetch(new Request("http://localhost/nope"), mockInfo);
		assertEquals(await res.json(), { custom: "missing" });
	});

	await t.step("custom onError", async () => {
		const router = createRouter({
			onError: (err, ctx) => ctx.json({ oops: err.message }, { status: 500 }),
		});
		router.get("/boom", () => {
			throw new Error("kaboom");
		});
		const res = await router.fetch(new Request("http://localhost/boom"), mockInfo);
		assertEquals(await res.json(), { oops: "kaboom" });
	});

	await t.step("HttpError subclasses set status", async () => {
		const router = createRouter();
		router.get("/nf", () => {
			throw new NotFoundError("custom not found");
		});
		const res = await router.fetch(new Request("http://localhost/nf"), mockInfo);
		assertEquals(res.status, 404);
	});
});

Deno.test("router: edge cases", async (t) => {
	await t.step("normalises duplicate slashes in URL", async () => {
		const router = createRouter();
		router.get("/api/users", (ctx) => ctx.json({ ok: true }));
		const res = await router.fetch(new Request("http://localhost//api//users"), mockInfo);
		assertEquals(res.status, 200);
	});

	await t.step("deeply nested routes", async () => {
		const router = createRouter();
		router.get("/a/b/c/d/e/f/g", (ctx) => ctx.json({ depth: 7 }));
		const res = await router.fetch(new Request("http://localhost/a/b/c/d/e/f/g"), mockInfo);
		assertEquals(await res.json(), { depth: 7 });
	});

	await t.step("many parameters", async () => {
		const router = createRouter();
		router.get(
			"/:a/:b/:c/:d/:e",
			(ctx) => ctx.json({ a: ctx.params.a, b: ctx.params.b, c: ctx.params.c, d: ctx.params.d, e: ctx.params.e }),
		);
		const res = await router.fetch(new Request("http://localhost/1/2/3/4/5"), mockInfo);
		assertEquals(await res.json(), { a: "1", b: "2", c: "3", d: "4", e: "5" });
	});

	await t.step("query string ignored in route matching", async () => {
		const router = createRouter();
		router.get("/search", (ctx) => ctx.json({ q: ctx.query.get("q") }));
		const res = await router.fetch(new Request("http://localhost/search?q=test"), mockInfo);
		assertEquals(await res.json(), { q: "test" });
	});

	await t.step("path with dots", async () => {
		const router = createRouter();
		router.get("/file/:name", (ctx) => ctx.json({ name: ctx.params.name }));
		const res = await router.fetch(new Request("http://localhost/file/readme.md"), mockInfo);
		assertEquals(await res.json(), { name: "readme.md" });
	});

	await t.step("path with hyphens and underscores", async () => {
		const router = createRouter();
		router.get("/my-route/with_underscores", (ctx) => ctx.json({ ok: true }));
		const res = await router.fetch(new Request("http://localhost/my-route/with_underscores"), mockInfo);
		assertEquals(res.status, 200);
	});
});
