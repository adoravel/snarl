/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals } from "@std/assert";
import { compress, createRouter } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

Deno.test("compress middleware", async (t) => {
	await t.step("compresses large text response with gzip", async () => {
		const router = createRouter();
		router.use(compress());
		router.get("/lowtaperfade", (ctx) => ctx.text("x".repeat(2000)));

		const res = await router.fetch(
			new Request("http://localhost/lowtaperfade", { headers: { "Accept-Encoding": "gzip" } }),
			mockInfo,
		);
		assertEquals(res.status, 200);
		assertEquals(res.headers.get("Content-Encoding"), "gzip");
		assertEquals(res.headers.get("Vary")?.includes("Accept-Encoding"), true);
	});

	await t.step("skips small responses", async () => {
		const router = createRouter();
		router.use(compress({ threshold: 2000 }));
		router.get("/small", (ctx) => ctx.text("hi"));

		const res = await router.fetch(
			new Request("http://localhost/small", { headers: { "Accept-Encoding": "gzip" } }),
			mockInfo,
		);
		assertEquals(res.headers.get("Content-Encoding"), null);
	});

	await t.step("skips already-encoded responses", async () => {
		const router = createRouter();
		router.use(compress());
		router.get("/encoded", (ctx) => {
			ctx.set("Content-Encoding", "br");
			return ctx.text("x".repeat(2000));
		});

		const res = await router.fetch(
			new Request("http://localhost/encoded", { headers: { "Accept-Encoding": "gzip" } }),
			mockInfo,
		);
		assertEquals(res.headers.get("Content-Encoding"), "br"); // unchanged
	});

	await t.step("skips non-compressible types", async () => {
		const router = createRouter();
		router.use(compress());
		router.get("/img", () => {
			return new Response(new Uint8Array(2000), {
				headers: { "Content-Type": "image/png" },
			});
		});

		const res = await router.fetch(
			new Request("http://localhost/img", { headers: { "Accept-Encoding": "gzip" } }),
			mockInfo,
		);
		assertEquals(res.headers.get("Content-Encoding"), null);
	});

	await t.step("client disconnection doesn't crash", async () => {
		const router = createRouter();
		router.use(compress());
		router.get("/stream", (ctx) => ctx.text("x".repeat(5000)));

		const controller = new AbortController();
		const req = new Request("http://localhost/stream", {
			headers: { "Accept-Encoding": "gzip" },
			signal: controller.signal,
		});

		setTimeout(() => controller.abort(), 5);
		try {
			await router.fetch(req, mockInfo);
		} catch { /* no-op */ }
	});
});
