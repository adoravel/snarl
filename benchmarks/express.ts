/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import express from "express";
import { largePayload } from "./fixtures.ts";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
	res.type("text/plain").send("express");
});

app.get("/plaintext", (_req, res) => {
	res.type("text/plain").send("Hello World");
});

app.get("/json", (_req, res) => {
	res.json({ message: "Hello World" });
});

app.get("/user/:id/todos/:todoId", (req, res) => {
	const { id, todoId } = req.params;
	res.json({ userId: id, todoId });
});

app.get("/search", (req, res) => {
	const { term } = req.query;
	res.json({ term });
});

app.post("/echo", (req, res) => {
	res.json(req.body);
});

app.get("/json/large", (_req, res) => {
	res.json(largePayload);
});

export default app;
