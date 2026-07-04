/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals } from "@std/assert";
import { createRouter, rateLimit } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

Deno.test("rateLimit middleware", async (t) => {
	await t.step("allows requests within limit", async () => {
		const limiter = rateLimit({ windowMs: 5000, max: 3 });
		const router = createRouter();
		router.use(limiter);
		router.get("/", (ctx) => ctx.text("ok"));

		for (let i = 0; i < 3; i++) {
			const res = await router.fetch(new Request("http://localhost/"), mockInfo);
			assertEquals(res.status, 200, `request ${i + 1} should pass`);
		}
		(limiter as any).cleanup?.();
	});

	await t.step("blocks requests over limit", async () => {
		const limiter = rateLimit({ windowMs: 5000, max: 2 });
		const router = createRouter();
		router.use(limiter);
		router.get("/", (ctx) => ctx.text("ok"));

		await router.fetch(new Request("http://localhost/"), mockInfo);
		await router.fetch(new Request("http://localhost/"), mockInfo);
		const res = await router.fetch(new Request("http://localhost/"), mockInfo);

		assertEquals(res.status, 429);
		(limiter as any).cleanup?.();
	});

	await t.step("custom keygen", async () => {
		const limiter = rateLimit({
			windowMs: 5000,
			max: 1,
			keygen: (ctx) => ctx.request.headers.get("X-Api-Key") || "anon",
		});
		const router = createRouter();
		router.use(limiter);
		router.get("/", (ctx) => ctx.text("ok"));

		const res1 = await router.fetch(
			new Request("http://localhost/", { headers: { "X-Api-Key": "key-a" } }),
			mockInfo,
		);
		const res2 = await router.fetch(
			new Request("http://localhost/", { headers: { "X-Api-Key": "key-b" } }),
			mockInfo,
		);

		assertEquals(res1.status, 200);
		assertEquals(res2.status, 200);
		(limiter as any).cleanup?.();
	});

	await t.step("custom handler on exceeded", async () => {
		const limiter = rateLimit({
			windowMs: 5000,
			max: 1,
			handler: (ctx) => ctx.json({ custom: "rate limited" }, { status: 429 }),
		});
		const router = createRouter();
		router.use(limiter);
		router.get("/", (ctx) => ctx.text("ok"));

		await router.fetch(new Request("http://localhost/"), mockInfo);
		const res = await router.fetch(new Request("http://localhost/"), mockInfo);

		assertEquals(await res.json(), { custom: "rate limited" });
		(limiter as any).cleanup?.();
	});
});
