/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { createRouter } from "@july/snarl";

const app = createRouter();

app.get("/health", (ctx) => {
	return ctx.text("snarl");
});

app.get("/plaintext", (ctx) => {
	return ctx.text("Hello World");
});

app.get("/json", (ctx) => {
	return ctx.json({ message: "Hello World" });
});

app.get("/user/:id/todos/:todoId", (ctx) => {
	return ctx.json({ userId: ctx.params.id, todoId: ctx.params.todoId });
});

app.get("/search", (ctx) => {
	return ctx.json({ term: ctx.url.searchParams.get("term") });
});

export default app.fetch;
