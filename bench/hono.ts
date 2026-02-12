/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.text("hono"));

app.get("/plaintext", (c) => c.text("Hello World"));

app.get("/json", (c) => c.json({ message: "Hello World" }));

app.get("/user/:id/todos/:todoId", (c) => {
	const { id, todoId } = c.req.param();
	return c.json({ userId: id, todoId });
});

app.get("/search", (c) => {
	const term = c.req.query("term");
	return c.json({ term });
});

export default app.fetch;
