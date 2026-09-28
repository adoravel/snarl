/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { compress, createRouter, etag, sse } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

function get(path: string, headers?: Record<string, string>): Request {
	return new Request(`http://localhost${path}`, { headers });
}

Deno.test("etag middleware", async (t) => {
	await t.step("tags a rendered body and answers 304 for the same tag", async () => {
		const router = createRouter();
		router.use(etag());
		router.get("/page", (ctx) => ctx.html("<h1>hi</h1>"));

		const first = await router.fetch(get("/page"), mockInfo);
		const tag = first.headers.get("ETag");
		assertEquals(first.status, 200);
		assert(tag?.startsWith('"'), `expected a strong tag, got ${tag}`);
		assertEquals(await first.text(), "<!DOCTYPE html><h1>hi</h1>");

		const second = await router.fetch(get("/page", { "If-None-Match": tag! }), mockInfo);
		assertEquals(second.status, 304);
		assertEquals(await second.text(), "");
		assertEquals(second.headers.get("ETag"), tag);
		assertEquals(second.headers.get("Content-Type"), null, "a 304 describes no body");
	});

	await t.step("a different body is a different tag", async () => {
		const router = createRouter();
		router.use(etag());
		let count = 0;
		router.get("/count", (ctx) => ctx.text(String(++count)));

		const first = await router.fetch(get("/count"), mockInfo);
		const tag = first.headers.get("ETag")!;
		const second = await router.fetch(get("/count", { "If-None-Match": tag }), mockInfo);

		assertEquals(second.status, 200, "the body changed, so it is sent");
		assertNotEquals(second.headers.get("ETag"), tag);
		assertEquals(await second.text(), "2");
	});

	await t.step("weak comparison, lists and `*` all match", async () => {
		const router = createRouter();
		router.use(etag());
		router.get("/page", (ctx) => ctx.text("body"));

		const tag = (await router.fetch(get("/page"), mockInfo)).headers.get("ETag")!;
		const cases = [`W/${tag}`, `"other", ${tag}`, "*"];

		for (const ifNoneMatch of cases) {
			const res = await router.fetch(get("/page", { "If-None-Match": ifNoneMatch }), mockInfo);
			await res.body?.cancel();
			assertEquals(res.status, 304, `${ifNoneMatch} should have matched`);
		}

		const miss = await router.fetch(get("/page", { "If-None-Match": '"nope"' }), mockInfo);
		assertEquals(miss.status, 200);
		await miss.body?.cancel();
	});

	await t.step("a weak tag is emitted on request", async () => {
		const router = createRouter();
		router.use(etag({ weak: true }));
		router.get("/page", (ctx) => ctx.text("body"));

		const res = await router.fetch(get("/page"), mockInfo);
		assert(res.headers.get("ETag")?.startsWith('W/"'));
		await res.body?.cancel();
	});

	await t.step("streams, non-200s and other methods are left alone", async () => {
		const router = createRouter();
		router.use(etag());
		router.get("/feed", (ctx) =>
			sse(ctx, async function* () {
				yield { data: "tick" };
			}));
		router.get("/missing", (ctx) => ctx.text("gone", { status: 404 }));
		router.post("/submit", (ctx) => ctx.text("ok"));

		const feed = await router.fetch(get("/feed"), mockInfo);
		assertEquals(feed.headers.get("ETag"), null, "hashing a stream would buffer it");
		await feed.body?.cancel();

		const missing = await router.fetch(get("/missing"), mockInfo);
		assertEquals(missing.status, 404);
		assertEquals(missing.headers.get("ETag"), null);
		await missing.text();

		const posted = await router.fetch(
			new Request("http://localhost/submit", { method: "POST" }),
			mockInfo,
		);
		assertEquals(posted.headers.get("ETag"), null);
		await posted.text();
	});

	await t.step("a handler's own tag and `no-store` are respected", async () => {
		const router = createRouter();
		router.use(etag());
		router.get("/own", (ctx) => {
			ctx.set("ETag", '"mine"');
			return ctx.text("body");
		});
		router.get("/private", (ctx) => {
			ctx.set("Cache-Control", "no-store");
			return ctx.text("secret");
		});

		const own = await router.fetch(get("/own"), mockInfo);
		assertEquals(own.headers.get("ETag"), '"mine"');
		await own.text();

		const priv = await router.fetch(get("/private"), mockInfo);
		assertEquals(priv.headers.get("ETag"), null);
		await priv.text();
	});

	await t.step("a body over maxSize is passed through untagged", async () => {
		const router = createRouter();
		router.use(etag({ maxSize: 8 }));
		router.get("/big", (ctx) => ctx.text("x".repeat(64)));

		const res = await router.fetch(get("/big"), mockInfo);
		assertEquals(res.headers.get("ETag"), null);
		await res.text();
	});

	await t.step("the tag covers the body the handler produced, not the encoding", async () => {
		const router = createRouter();
		router.use(compress({ threshold: 0 }));
		router.use(etag());
		router.get("/page", (ctx) => ctx.html("<h1>hi</h1>".repeat(100)));

		const plain = await router.fetch(get("/page"), mockInfo);
		const gzipped = await router.fetch(get("/page", { "Accept-Encoding": "gzip" }), mockInfo);

		assertEquals(gzipped.headers.get("Content-Encoding"), "gzip");
		assertEquals(
			gzipped.headers.get("ETag"),
			plain.headers.get("ETag"),
			"same representation, so the same tag",
		);
		await plain.text();
		await gzipped.text();

		const tag = plain.headers.get("ETag")!;
		const fresh = await router.fetch(
			get("/page", { "If-None-Match": tag, "Accept-Encoding": "gzip" }),
			mockInfo,
		);
		assertEquals(fresh.status, 304);
		assertEquals(fresh.headers.get("Content-Encoding"), null);
		await fresh.text();
	});
});
