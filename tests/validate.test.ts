/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
	createRouter,
	type Email,
	type Infer,
	type Schema,
	v,
	validate,
	ValidationError,
} from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
	: false;

const User = v({
	name: v.string({ min: 1, max: 8 }),
	email: v.email(),
	age: v.optional(v.number({ int: true, min: 0 })),
	role: v.enum(["admin", "member"]),
	tags: v.array(v.string(), { max: 3 }),
	address: v.nullable(
		v({ city: v.string(), zip: v.string({ pattern: /^\d{5}$/, message: "5 digits" }) }),
	),
});
type User = Infer<typeof User>;

Deno.test("validate: the schema is the type", () => {
	const _shape: Equal<User, {
		name: string;
		email: Email;
		role: "admin" | "member";
		tags: string[];
		address: { city: string; zip: string } | null;
		age?: number | undefined;
	}> = true;
	const Point = v.tuple([v.string(), v.number()]);
	const _tuple: Equal<Infer<typeof Point>, [string, number]> = true;
	const _union: Equal<
		Infer<
			ReturnType<typeof v.union<[ReturnType<typeof v.string>, ReturnType<typeof v.literal<42>>]>>
		>,
		string | 42
	> = true;
	const _literal: Equal<Infer<ReturnType<typeof v.literal<"x">>>, "x"> = true;
	assert(_shape && _tuple && _union && _literal);
});

Deno.test("validate: a good value passes through unchanged and typed", () => {
	const input = {
		name: "lívia",
		email: "l@x.io",
		role: "admin",
		tags: ["a"],
		address: null,
		extra: "kept unless strict",
	};
	const user = User.parse(input);
	assertEquals(user, input as unknown as User);
	assertEquals(validate(User, input), input as unknown as User);
	assert(User.is(input));
	const email: Email = user.email;
	assertEquals(typeof email, "string");
});

Deno.test("validate: every issue is collected with its path", () => {
	const result = User.safeParse({
		name: "",
		email: "nope",
		age: 1.5,
		role: "guest",
		tags: ["a", 2, "c", "d"],
		address: { city: 7, zip: "abc" },
	});
	assert(!result.ok);
	assertEquals(result.issues, [
		{ path: ["name"], message: "expected at least 1 characters" },
		{ path: ["email"], message: "expected an email address" },
		{ path: ["age"], message: "expected an integer" },
		{ path: ["role"], message: 'expected one of "admin", "member"' },
		{ path: ["tags"], message: "expected at most 3 items" },
		{ path: ["tags", 1], message: "expected string, got number" },
		{ path: ["address", "city"], message: "expected string, got number" },
		{ path: ["address", "zip"], message: "5 digits" },
	]);
});

Deno.test("validate: required vs optional vs missing", () => {
	const r = User.safeParse({});
	assert(!r.ok);
	assertEquals(r.issues.map((i) => i.path[0]), ["name", "email", "role", "tags", "address"]);
	assertEquals(v({ a: v.optional(v.string()) }).safeParse({}).ok, true);
	assertEquals(v({ a: v.optional(v.string()) }).safeParse({ a: undefined }).ok, true);
	assertEquals(v({ a: v.optional(v.string()) }).safeParse({ a: 1 }).ok, false);
	assertEquals(v({ a: v.string() }, { strict: true }).safeParse({ a: "x", b: 1 }).ok, false);
});

Deno.test("validate: parse throws a 422 that the router turns into a body with the issues", async () => {
	const err = assertThrows(() => User.parse({ name: "x" }), ValidationError);
	assertEquals(err.status, 422);
	assertEquals(err.message, "required at email (+3 more)");

	const app = createRouter();
	app.post("/users", async (ctx) => {
		const user = await ctx.body.json(User);
		const _typed: Equal<typeof user, User> = true;
		return ctx.json({ ok: _typed, name: user.name });
	});

	const bad = await app.fetch(
		new Request("http://localhost/users", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x", email: "y" }),
		}),
		mockInfo,
	);
	assertEquals(bad.status, 422);
	const body = await bad.json();
	assertEquals(body.error, "expected an email address at email (+3 more)");
	assertEquals(body.details[0], { path: ["email"], message: "expected an email address" });

	const good = await app.fetch(
		new Request("http://localhost/users", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "ok", email: "a@b.c", role: "member", tags: [], address: null }),
		}),
		mockInfo,
	);
	assertEquals(await good.json(), { ok: true, name: "ok" });
});

Deno.test("validate: unions report the closest branch, tuples check length and slots", () => {
	const Id = v.union(v.uuid(), v.number({ int: true }));
	assert(Id.is("123e4567-e89b-12d3-a456-426614174000"));
	assert(Id.is(7));
	const r = Id.safeParse("nope");
	assert(!r.ok);
	assertEquals(r.issues, [{ path: [], message: "expected a uuid" }]);

	const Point = v.tuple([v.number(), v.number()]);
	assert(Point.is([1, 2]));
	assertEquals(Point.safeParse([1]).ok, false);
	assertEquals(Point.safeParse([1, "2"]).ok, false);
});

Deno.test("validate: refine, custom, lazy and records", () => {
	const Even = v.number().refine((n) => n % 2 === 0, "expected an even number");
	assertEquals(Even.safeParse(3), {
		ok: false,
		issues: [{ path: [], message: "expected an even number" }],
	});
	assertEquals(Even.safeParse("x").ok, false, "the base check still runs first");

	type Slug = string & { readonly __slug: true };
	const Slug = v.guard(
		(x): x is Slug => typeof x === "string" && /^[a-z-]+$/.test(x),
		"expected a slug",
	);
	const _slug: Equal<Infer<typeof Slug>, Slug> = true;
	assert(_slug && Slug.is("hello-world") && !Slug.is("Hello"));

	type Tree = { value: number; children: Tree[] };
	const Tree: Schema<Tree> = v.lazy(() => v({ value: v.number(), children: v.array(Tree) }));
	assert(Tree.is({ value: 1, children: [{ value: 2, children: [] }] }));
	assertEquals(Tree.safeParse({ value: 1, children: [{ value: "x", children: [] }] }).ok, false);

	const Counts = v.record(v.number());
	assert(Counts.is({ a: 1, b: 2 }));
	assertEquals(Counts.safeParse({ a: "1" }).ok, false);
	assert(v.url().is("https://x.io/p?q") && !v.url().is("not a url"));
	assert(v.boolean().is(false) && !v.boolean().is("false"));
	assert(v.any().is(undefined));
});

Deno.test("validate: coercion converts strings, plain schemas hand the input back untouched", () => {
	const Filters = v({
		page: v.coerce.number({ int: true, min: 1 }).default(1),
		limit: v.coerce.number({ max: 100 }),
		draft: v.coerce.boolean(),
		since: v.coerce.date(),
		tag: v.coerce.array(v.string()),
		id: v.coerce.string(),
	});
	const _type: Equal<Infer<typeof Filters>, {
		page: number;
		limit: number;
		draft: boolean;
		since: Date;
		tag: string[];
		id: string;
	}> = true;
	assert(_type);

	const out = Filters.parse({ limit: "50", draft: "on", since: "2026-01-02", tag: "a", id: 7 });
	assertEquals(out, {
		limit: 50,
		draft: true,
		since: new Date("2026-01-02"),
		tag: ["a"],
		id: "7",
		page: 1,
	});
	assertEquals(
		Filters.parse({ limit: 5, draft: false, since: out.since, tag: ["x", "y"], id: "a" }).tag,
		["x", "y"],
	);

	const r = Filters.safeParse({ page: "0", limit: "", draft: "maybe", since: "nope", id: {} });
	assert(!r.ok);
	assertEquals(r.issues, [
		{ path: ["page"], message: "expected at least 1" },
		{ path: ["limit"], message: "expected a number, got string" },
		{ path: ["draft"], message: "expected a boolean, got string" },
		{ path: ["since"], message: "expected a date, got string" },
		{ path: ["id"], message: "expected string, got object" },
	]);

	// nothing coerced → the very same object comes back
	const Plain = v({ a: v.string(), b: v.array(v.number()) });
	const input = { a: "x", b: [1] };
	assert(Plain.parse(input) === input);
	// something coerced → a copy, and the input is left alone
	const Mixed = v({ a: v.string(), n: v.coerce.number() });
	const mixed = { a: "x", n: "1" };
	assertEquals(Mixed.parse(mixed), { a: "x", n: 1 });
	assertEquals(mixed.n, "1");
});

Deno.test("validate: defaults fill missing keys and make them required in the type", () => {
	const S = v({
		role: v.default(v.enum(["admin", "member"]), "member"),
		note: v.string().optional(),
	});
	const _type: Equal<Infer<typeof S>, { role: "admin" | "member"; note?: string | undefined }> =
		true;
	assert(_type);
	assertEquals(S.parse({}), { role: "member" });
	assertEquals(S.parse({ role: "admin", note: "x" }), { role: "admin", note: "x" });
	assertEquals(S.safeParse({ role: "guest" }).ok, false);
});

Deno.test("validate: ctx.query.parse and ctx.body.form", async () => {
	const Filters = v({
		q: v.string().default(""),
		page: v.coerce.number({ int: true }).default(1),
		tag: v.coerce.array(v.string()),
	});
	const Signup = v({
		name: v.string({ min: 1 }),
		newsletter: v.coerce.boolean().default(false),
		avatar: v.guard((x): x is File => x instanceof File).optional(),
	});

	const app = createRouter();
	app.get("/posts", (ctx) => ctx.json(ctx.query.parse(Filters)));
	app.post("/signup", async (ctx) => {
		const form = await ctx.body.form(Signup);
		return ctx.json({ ...form, avatar: form.avatar?.name });
	});

	const posts = await app.fetch(
		new Request("http://localhost/posts?q=cats&page=3&tag=a&tag=b"),
		mockInfo,
	);
	assertEquals(await posts.json(), { q: "cats", page: 3, tag: ["a", "b"] });
	const none = await app.fetch(new Request("http://localhost/posts"), mockInfo);
	assertEquals(await none.json(), { q: "", page: 1, tag: [] });
	const bad = await app.fetch(new Request("http://localhost/posts?page=x"), mockInfo);
	assertEquals(bad.status, 422);
	assertEquals((await bad.json()).details, [{
		path: ["page"],
		message: "expected a number, got string",
	}]);

	const urlencoded = await app.fetch(
		new Request("http://localhost/signup", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "name=l%C3%ADvia&newsletter=on",
		}),
		mockInfo,
	);
	assertEquals(await urlencoded.json(), { name: "lívia", newsletter: true });

	const multipart = new FormData();
	multipart.set("name", "k");
	multipart.set("avatar", new File(["x"], "me.png", { type: "image/png" }));
	const upload = await app.fetch(
		new Request("http://localhost/signup", { method: "POST", body: multipart }),
		mockInfo,
	);
	assertEquals(await upload.json(), { name: "k", newsletter: false, avatar: "me.png" });

	const invalid = await app.fetch(
		new Request("http://localhost/signup", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "name=",
		}),
		mockInfo,
	);
	assertEquals(invalid.status, 422);
});
