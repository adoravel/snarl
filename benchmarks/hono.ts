import { Hono } from "hono";
import { largePayload } from "./fixtures.ts";

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

app.post("/echo", async (c) => c.json(await c.req.json()));

app.get("/json/large", (c) => c.json(largePayload));

export default app.fetch;
