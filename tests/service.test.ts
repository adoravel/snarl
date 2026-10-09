/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
	type Client,
	createClient,
	createRouter,
	type Paths,
	service,
	ServiceError,
	TooManyRequestsError,
	v,
} from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
	: false;

interface Post {
	id: number;
	title: string;
}

const posts: Post[] = [{ id: 1, title: "one" }, { id: 2, title: "two" }];
const calls: string[] = [];

const api = service({
	version: service.query({ handler: () => "1.4.4" }),
	posts: {
		list: service.query({
			input: v({
				page: v.coerce.number({ int: true, min: 1 }).default(1),
				tag: v.coerce.array(v.string()),
			}),
			headers: { "Cache-Control": "max-age=60" },
			handler: ({ input }): Post[] => {
				calls.push(`list:${input.page}:${input.tag.join(",")}`);
				return posts.slice(0, input.page);
			},
		}),
		byId: service.query({
			input: v({ id: v.coerce.number() }),
			path: "/posts/:id",
			errors: ["not_found"],
			handler: ({ input }): Post => {
				const post = posts.find((p) => p.id === input.id);
				if (!post) throw new ServiceError("not_found", `no post ${input.id}`);
				return post;
			},
		}),
		create: service.mutation({
			input: v({ title: v.string({ min: 1 }), draft: v.coerce.boolean().default(false) }),
			errors: ["conflict"],
			handler: ({ input, ctx }): Post => {
				calls.push(`create:${input.title}:${input.draft}:${ctx.request.method}`);
				if (posts.some((p) => p.title === input.title)) {
					throw new ServiceError("conflict", "that title is taken");
				}
				return { id: posts.length + 1, title: input.title };
			},
		}),
		touch: service.mutation({ handler: () => {} }),
		tail: service.stream({
			input: v({ from: v.coerce.number().default(0) }),
			handler: async function* ({ input }) {
				for (const post of posts.slice(input.from)) {
					await Promise.resolve();
					yield post;
				}
			},
		}),
	},
});

Deno.test("service: type system shenanigans", () => {
	type C = Client<typeof api.routes>;

	// type system shenanigans o algo así
	const _paths: Equal<
		Paths<typeof api.routes>,
		"version" | `posts.${"list" | "byId" | "create" | "touch" | "tail"}`
	> = true;
	const _out: Equal<Awaited<ReturnType<C["posts"]["list"]>>, Post[]> = true;
	const _void: Equal<Awaited<ReturnType<C["posts"]["touch"]>>, void> = true;
	const _stream: Equal<
		ReturnType<C["posts"]["tail"]> extends AsyncIterable<infer T> ? T : never,
		Post
	> = true;
	assert(_paths && _out && _void && _stream);

	const client = api.caller(null as never);
	const _noArgs: Equal<Parameters<typeof client.version>, []> = true;

	const _input: Equal<
		Parameters<typeof client.posts.create>[0],
		{ title: string; draft?: string | boolean }
	> = true;
	const _parsed: Equal<Awaited<ReturnType<C["posts"]["create"]>>, Post> = true;
	assert(_parsed);
	assert(_noArgs && _input);

	const _query: Equal<ReturnType<typeof client.posts.list.url>, string> = true;

	// @ts-expect-error a mutation has no url()
	client.posts.create.url;
	assert(_query);
});

Deno.test("service: the caller runs handlers in process", async () => {
	const ctx = { request: new Request("http://localhost/"), params: {} } as never;
	const caller = api.caller(ctx);

	assertEquals(await caller.version(), "1.4.4");
	assertEquals(await caller.posts.list({ page: 2, tag: ["x"] }), posts);
	assertEquals(await caller.posts.list({}), [posts[0]], "defaults are applied");
	assertEquals(await caller.posts.touch(), undefined);
	assertEquals(caller.posts.list.url({ page: 2 }), "/api/posts.list?page=2");
	assertEquals(
		caller.posts.byId.url({ id: 1 }),
		"/posts/:id?id=1",
		"a custom path is used as declared",
	);

	const found = await caller.posts.byId.attempt({ id: 1 });
	assert(found.ok && found.value.title === "one");

	const missing = await caller.posts.byId.attempt({ id: 9 });
	assert(!missing.ok);
	assertEquals(missing.error.code, "not_found");
	assertEquals(missing.error.status, 404);
	if (!missing.ok && missing.error.code === "not_found") {
		// @ts-expect-error "teapot" is not one of this procedure's codes
		assert(missing.error.code !== "teapot");
	}

	const invalid = await caller.posts.create.attempt({ title: "" });
	assert(!invalid.ok);
	assertEquals(invalid.error.code, "invalid");
	assertEquals(invalid.error.details, [{
		path: ["title"],
		message: "expected at least 1 characters",
	}]);

	const streamed: Post[] = [];
	for await (const post of caller.posts.tail({ from: 1 })) streamed.push(post);
	assertEquals(streamed, [posts[1]]);
});

Deno.test("service: mounted procedures are normal http routes", async () => {
	const app = createRouter();
	api.mount(app);

	assertEquals(
		api.list().map((r) => `${r.methods.join("|")} ${r.url}`),
		[
			"GET|POST /api/version",
			"GET|POST /api/posts.list",
			"GET|POST /posts/:id",
			"POST /api/posts.create",
			"POST /api/posts.touch",
			"GET /api/posts.tail",
		],
	);

	const list = await app.fetch(
		new Request("http://localhost/api/posts.list?page=2&tag=a&tag=b"),
		mockInfo,
	);
	assertEquals(list.status, 200);
	assertEquals(list.headers.get("Cache-Control"), "max-age=60");
	assertEquals(await list.json(), posts);
	assert(calls.includes("list:2:a,b"), `coerced from strings: ${calls}`);

	const byId = await app.fetch(new Request("http://localhost/posts/2"), mockInfo);
	assertEquals(await byId.json(), posts[1]);

	const missing = await app.fetch(new Request("http://localhost/posts/9"), mockInfo);
	assertEquals(missing.status, 404);
	assertEquals(await missing.json(), { error: "no post 9", code: "not_found" });

	const created = await app.fetch(
		new Request("http://localhost/api/posts.create", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "three" }),
		}),
		mockInfo,
	);
	assertEquals(await created.json(), { id: 3, title: "three" });

	const fromForm = await app.fetch(
		new Request("http://localhost/api/posts.create", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "title=four&draft=on",
		}),
		mockInfo,
	);
	assertEquals(await fromForm.json(), { id: 3, title: "four" });
	assert(calls.includes("create:four:true:POST"), "form strings are coerced too");

	const bad = await app.fetch(
		new Request("http://localhost/api/posts.create", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "" }),
		}),
		mockInfo,
	);
	assertEquals(bad.status, 422);
	assertEquals((await bad.json()).code, "invalid");

	const touched = await app.fetch(
		new Request("http://localhost/api/posts.touch", { method: "POST" }),
		mockInfo,
	);
	assertEquals(touched.status, 204);

	const tail = await app.fetch(
		new Request("http://localhost/api/posts.tail?from=1"),
		mockInfo,
	);
	assertEquals(tail.headers.get("Content-Type"), "text/event-stream");
	assertEquals(await tail.text(), `data: {"id":2,"title":"two"}\n\n`);
});

Deno.test("service: the http client is the same shape as the caller", async () => {
	const app = createRouter();
	api.mount(app);

	const client = createClient<typeof api>({
		fetch: (input, init) =>
			app.fetch(
				new Request(
					new URL(String(input instanceof Request ? input.url : input), "http://localhost"),
					init instanceof Object ? init : undefined,
				),
				mockInfo,
			),
	});

	assertEquals(await client.version(), "1.4.4");
	assertEquals(await client.posts.list({ page: 1, tag: [] }), [posts[0]]);
	assertEquals(await client.posts.touch(), undefined);

	assertEquals(await client.posts.list.get({ page: 2, tag: [] }), posts);
	assertEquals(
		client.posts.list.url({ page: 2, tag: ["a", "b"] }),
		"/api/posts.list?page=2&tag=a&tag=b",
	);

	const conflict = await client.posts.create.attempt({ title: "one" });
	assert(!conflict.ok);
	assertEquals(conflict.error.code, "conflict");
	assertEquals(conflict.error.message, "that title is taken");

	const thrown = await assertRejects(() => client.posts.create({ title: "" }), ServiceError);
	assertEquals(thrown.code, "invalid");
	assertEquals(thrown.details, [{ path: ["title"], message: "expected at least 1 characters" }]);

	const streamed: Post[] = [];
	for await (const post of client.posts.tail({ from: 0 })) streamed.push(post);
	assertEquals(streamed, posts);
});

Deno.test("service: a procedure chooses its success status and can be too large", async () => {
	const created = service({
		posts: {
			create: service.mutation({
				input: v({ title: v.string() }),
				status: 201,
				headers: { Location: "/posts/1" },
				handler: ({ input }) => ({ id: 1, title: input.title }),
			}),
			upload: service.mutation({
				input: v({ size: v.number() }),
				errors: ["payload_too_large"],
				handler: ({ input }) => {
					if (input.size > 10) throw new ServiceError("payload_too_large", "too big");
					return { ok: true };
				},
			}),
			touch: service.mutation({ status: 202, handler: () => {} }),
		},
	});

	const app = createRouter();
	created.mount(app);

	const post = async (path: string, body: unknown) =>
		await app.fetch(
			new Request(`http://localhost/api/${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			mockInfo,
		);

	const made = await post("posts.create", { title: "one" });
	assertEquals(made.status, 201);
	assertEquals(made.headers.get("Location"), "/posts/1");
	assertEquals(await made.json(), { id: 1, title: "one" });

	const big = await post("posts.upload", { size: 99 });
	assertEquals(big.status, 413, "payload_too_large is a 413, not a reluctant 422");
	assertEquals(await big.json(), { error: "too big", code: "payload_too_large" });

	const empty = await post("posts.touch", null);
	assertEquals(empty.status, 202, "a handler returning nothing still chooses its status");
	await empty.text();
});

Deno.test("service: a call can be given headers, a timeout and a signal", async () => {
	const app = createRouter();
	api.mount(app);

	const seen: (string | null)[] = [];
	const client = createClient<typeof api>({
		headers: { "x-from": "client" },
		fetch: (input, init) => {
			const request = new Request(
				new URL(String(input instanceof Request ? input.url : input), "http://localhost"),
				init instanceof Object ? init : undefined,
			);

			seen.push(request.headers.get("x-from"));
			if (request.signal.aborted) return Promise.reject(new Error("aborted before sending"));

			return app.fetch(request, mockInfo);
		},
	});

	assertEquals(await client.version(), "1.4.4");
	assertEquals(seen, ["client"]);

	assertEquals(await client.version(undefined, { headers: { "x-from": "call" } }), "1.4.4");
	assertEquals(seen.at(-1), "call", "a per-call header beats the client's own");

	const controller = new AbortController();
	controller.abort();
	await assertRejects(() => client.posts.touch(undefined, { signal: controller.signal }));

	const local = api.caller(null as never);
	const _local: Equal<Parameters<typeof local.version>, []> = true;
	assert(_local);
});

Deno.test("service: an unexpected throw is an internal error", async () => {
	const seen: string[] = [];
	const broken = service({
		boom: service.query({ handler: () => JSON.parse("{oops") as string }),
	}, { onError: (_error, path) => seen.push(path) });

	const app = createRouter();
	broken.mount(app);

	const response = await app.fetch(new Request("http://localhost/api/boom"), mockInfo);
	assertEquals(response.status, 500);
	assertEquals(await response.json(), { error: "internal error", code: "internal" });
	assertEquals(seen, ["boom"], "the real error goes to onError, not to the client");
});

Deno.test("service: guards refine the context", async () => {
	const seen: string[] = [];

	const authed = service.guard(({ ctx }) => {
		seen.push("auth");
		const token = ctx.cookies.get("session");
		if (!token) throw new ServiceError("unauthorised", "sign in first");
		return { user: { id: token, name: "lívia" } };
	}, ["unauthorised"]);

	const admin = authed.guard(({ user }) => {
		seen.push(`admin:${user.id}`);
		if (user.id !== "root") throw new ServiceError("forbidden", "not an admin");
		return { level: 9 as const };
	}, ["forbidden"]);

	const api = service({
		me: authed.query({ handler: ({ user }) => user.name }),
		purge: admin.mutation({
			input: v({ what: v.string() }),
			handler: ({ input, user, level }) => `${user.name} purged ${input.what} at ${level}`,
		}),
		tail: admin.stream({
			handler: async function* ({ level }) {
				await Promise.resolve();
				yield level;
			},
		}),
	});

	type Args = Parameters<Parameters<typeof admin.mutation>[0]["handler"]>[0];
	const _extra: Equal<Args["user"], { id: string; name: string }> = true;
	const _level: Equal<Args["level"], 9> = true;
	assert(_extra && _level);

	type Failure = Extract<Awaited<ReturnType<typeof caller.purge.attempt>>, { ok: false }>;
	const _codes: Equal<
		Failure["error"]["code"],
		"unauthorised" | "forbidden" | "invalid" | "bad_request" | "internal"
	> = true;
	assert(_codes);

	const app = createRouter();
	api.mount(app);

	const anonymous = await app.fetch(new Request("http://localhost/api/me"), mockInfo);
	assertEquals(anonymous.status, 401);
	assertEquals((await anonymous.json()).code, "unauthorised");
	assertEquals(seen, ["auth"], "a failing guard stops the chain");

	const signedIn = await app.fetch(
		new Request("http://localhost/api/me", { headers: { cookie: "session=u1" } }),
		mockInfo,
	);
	assertEquals(await signedIn.json(), "lívia");

	const notAdmin = await app.fetch(
		new Request("http://localhost/api/purge", {
			method: "POST",
			headers: { cookie: "session=u1", "content-type": "application/json" },
			body: JSON.stringify({ what: "cache" }),
		}),
		mockInfo,
	);
	assertEquals(notAdmin.status, 403);

	const purged = await app.fetch(
		new Request("http://localhost/api/purge", {
			method: "POST",
			headers: { cookie: "session=root", "content-type": "application/json" },
			body: JSON.stringify({ what: "cache" }),
		}),
		mockInfo,
	);
	assertEquals(await purged.json(), "lívia purged cache at 9");

	const denied = await app.fetch(new Request("http://localhost/api/tail"), mockInfo);
	assertEquals(denied.status, 401);

	const ctx = {
		request: new Request("http://localhost/", { headers: { cookie: "session=root" } }),
		params: {},
		cookies: { get: () => "root" },
	} as never;
	const caller = api.caller(ctx);
	assertEquals(await caller.purge({ what: "sessions" }), "lívia purged sessions at 9");
	for await (const level of caller.tail()) assertEquals(level, 9);

	const anonymousCtx = {
		request: new Request("http://localhost/"),
		params: {},
		cookies: { get: () => null },
	} as never;
	const rejected = await api.caller(anonymousCtx).me.attempt();
	assert(!rejected.ok && rejected.error.code === "unauthorised");
});

Deno.test("service: a mutation is a form target", async () => {
	const api = service({
		subscribe: service.mutation({
			input: v({ email: v.email(), weekly: v.coerce.boolean().default(false) }),
			handler: ({ input }) => `ok ${input.email} ${input.weekly}`,
		}),
		search: service.query({
			input: v({ q: v.string() }),
			handler: ({ input }) => [input.q],
		}),
	});

	const caller = api.caller(null as never);
	const form = caller.subscribe.form();
	assertEquals(form, {
		action: "/api/subscribe",
		method: "post",
		enctype: "application/x-www-form-urlencoded",
		fields: form.fields,
	});
	assertEquals(form.fields.email, "email");
	assertEquals(form.fields.weekly, "weekly");

	// @ts-expect-error the input has no such field
	form.fields.nope;

	assertEquals(caller.search.form().method, "get");
	assertEquals(caller.subscribe.form({ multipart: true }).enctype, "multipart/form-data");

	const app = createRouter();
	api.mount(app);
	const response = await app.fetch(
		new Request(`http://localhost${form.action}`, {
			method: form.method,
			headers: { "content-type": form.enctype },
			body: `${form.fields.email}=hi%40x.io&${form.fields.weekly}=on`,
		}),
		mockInfo,
	);
	assertEquals(await response.json(), "ok hi@x.io true");
});

Deno.test("service: a procedure can't be named after a client helper", () => {
	for (const name of ["get", "url", "attempt", "form", "path", "then"]) {
		assertThrows(
			() => service({ posts: { [name]: service.query({ handler: () => 1 }) } }),
			Error,
			"collides with a helper",
		);
	}
	assertEquals(
		typeof service({ get: { thing: service.query({ handler: () => 1 }) } }).list,
		"function",
	);
});

Deno.test("service: an http error keeps its status and headers through a service route", async () => {
	const api = service({
		slow: service.query({
			handler: () => {
				throw new TooManyRequestsError("later", "30");
			},
		}),
	});
	const app = createRouter();
	api.mount(app);

	const response = await app.fetch(new Request("http://localhost/api/slow"), mockInfo);
	assertEquals(response.status, 429);
	assertEquals(response.headers.get("Retry-After"), "30");
	assertEquals((await response.json()).code, "rate_limited");
});
