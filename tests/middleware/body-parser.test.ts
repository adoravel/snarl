/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals } from "jsr:@std/assert@1.0.17";
import { createRouter, formParser, jsonParser } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

Deno.test("jsonParser", async (t) => {
	await t.step("parses valid JSON", async () => {
		const router = createRouter();
		router.use(jsonParser());
		router.post("/", async (ctx) => ctx.json(await ctx.body.json()));

		const res = await router.fetch(
			new Request("http://localhost/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "snarl" }),
			}),
			mockInfo,
		);
		assertEquals(await res.json(), { name: "snarl" });
	});

	await t.step("returns 400 for malformed JSON", async () => {
		const router = createRouter();
		router.use(jsonParser());
		router.post("/", (ctx) => ctx.json({ ok: true }));

		const res = await router.fetch(
			new Request("http://localhost/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not json",
			}),
			mockInfo,
		);
		assertEquals(res.status, 400);
	});

	await t.step("skips non-JSON content types", async () => {
		const router = createRouter();
		router.use(jsonParser());
		router.post("/", async (ctx) => ctx.text(await ctx.body.plain()));

		const res = await router.fetch(
			new Request("http://localhost/", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "raw text",
			}),
			mockInfo,
		);
		assertEquals(await res.text(), "raw text");
	});
});

Deno.test("formParser", async (t) => {
	await t.step("parses form data", async () => {
		const router = createRouter();
		router.use(formParser());
		router.post("/", async (ctx) => ctx.json(await ctx.body.json()));

		const res = await router.fetch(
			new Request("http://localhost/", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "name=snarl&version=0.3.4",
			}),
			mockInfo,
		);
		assertEquals(await res.json(), { name: "snarl", version: "0.3.4" });
	});
});
