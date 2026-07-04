/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals } from "jsr:@std/assert@1.0.17";
import { cors, createRouter } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

Deno.test("cors middleware", async (t) => {
	await t.step("adds wildcard origin by default", async () => {
		const router = createRouter();
		router.use(cors());
		router.get("/data", (ctx) => ctx.text("ok"));

		const res = await router.fetch(new Request("http://localhost/data"), mockInfo);
		assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
	});

	await t.step("reflects allowed origin", async () => {
		const router = createRouter();
		router.use(cors({ origin: "https://example.com" }));
		router.get("/data", (ctx) => ctx.text("ok"));

		const res = await router.fetch(
			new Request("http://localhost/data", { headers: { Origin: "https://example.com" } }),
			mockInfo,
		);
		assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://example.com");
	});

	await t.step("array origins: matches listed origin", async () => {
		const router = createRouter();
		router.use(cors({ origin: ["https://a.com", "https://b.com"] }));
		router.get("/data", (ctx) => ctx.text("ok"));

		const res = await router.fetch(
			new Request("http://localhost/data", { headers: { Origin: "https://a.com" } }),
			mockInfo,
		);
		assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://a.com");
	});

	await t.step("array origins: ignores unlisted origin", async () => {
		const router = createRouter();
		router.use(cors({ origin: ["https://a.com"] }));
		router.get("/data", (ctx) => ctx.text("ok"));

		const res = await router.fetch(
			new Request("http://localhost/data", { headers: { Origin: "https://evil.com" } }),
			mockInfo,
		);
		assertEquals(res.headers.get("Access-Control-Allow-Origin"), null);
	});

	await t.step("preflight returns 204 with headers", async () => {
		const router = createRouter();
		router.use(cors({ maxAge: 3600 }));
		router.get("/data", (ctx) => ctx.text("ok"));

		const res = await router.fetch(
			new Request("http://localhost/data", { method: "OPTIONS" }),
			mockInfo,
		);
		assertEquals(res.status, 204);
		assertEquals(res.headers.get("Access-Control-Allow-Methods"), "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
		assertEquals(res.headers.get("Access-Control-Max-Age"), "3600");
	});

	await t.step("credentials mode", async () => {
		const router = createRouter();
		router.use(cors({ credentials: true }));
		router.get("/data", (ctx) => ctx.text("ok"));

		const res = await router.fetch(new Request("http://localhost/data"), mockInfo);
		assertEquals(res.headers.get("Access-Control-Allow-Credentials"), "true");
	});
});
