/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals } from "jsr:@std/assert@1.0.17";
import { createRouter, securityHeaders } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

Deno.test("securityHeaders middleware", async (t) => {
	await t.step("applies default headers", async () => {
		const router = createRouter();
		router.use(securityHeaders());
		router.get("/", (ctx) => ctx.text("ok"));

		const res = await router.fetch(new Request("http://localhost/"), mockInfo);
		assertEquals(res.headers.get("X-Content-Type-Options"), "nosniff");
		assertEquals(res.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
		assertEquals(res.headers.get("Strict-Transport-Security"), "max-age=31536000; includeSubDomains");
		assertEquals(res.headers.has("Content-Security-Policy"), true);
	});

	await t.step("custom CSP overrides default", async () => {
		const router = createRouter();
		router.use(securityHeaders({ contentSecurityPolicy: "default-src 'none'" }));
		router.get("/", (ctx) => ctx.text("ok"));

		const res = await router.fetch(new Request("http://localhost/"), mockInfo);
		assertEquals(res.headers.get("Content-Security-Policy"), "default-src 'none'");
	});

	await t.step("cache control when set", async () => {
		const router = createRouter();
		router.use(securityHeaders({ cacheControl: "no-store" }));
		router.get("/", (ctx) => ctx.text("ok"));

		const res = await router.fetch(new Request("http://localhost/"), mockInfo);
		assertEquals(res.headers.get("Cache-Control"), "no-store");
	});
});
