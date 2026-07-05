import { createRouter } from "@july/snarl";
import { largePayload } from "./fixtures.ts";

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

app.post("/echo", async (ctx) => {
	const body = await ctx.body.json();
	return ctx.json(body);
});

app.get("/json/large", (ctx) => {
	return ctx.json(largePayload);
});

export default app.fetch;
