/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { Application, Router } from "@oak/oak";
import { largePayload } from "./fixtures.ts";

const router = new Router();

router.get("/health", (ctx) => {
	ctx.response.body = "oak";
});

router.get("/plaintext", (ctx) => {
	ctx.response.body = "Hello World";
});

router.get("/json", (ctx) => {
	ctx.response.body = { message: "Hello World" };
});

router.get("/user/:id/todos/:todoId", (ctx) => {
	const { id, todoId } = ctx.params;
	ctx.response.body = { userId: id, todoId };
});

router.get("/search", (ctx) => {
	const term = ctx.request.url.searchParams.get("term");
	ctx.response.body = { term };
});

router.post("/echo", async (ctx) => {
	ctx.response.body = await ctx.request.body.json();
});

router.get("/json/large", (ctx) => {
	ctx.response.body = largePayload;
});

const oak = new Application();

oak.use(router.routes());
oak.use(router.allowedMethods());

export default oak;
