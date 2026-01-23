# snarl

a minimal web framework for deno

## features

- [x] lightweight and minimal
- [x] built-in jsx/tsx rendering
- [x] flexible type-safe routing with path parameters
- [x] type-safe request/response handling
- [x] middleware composition
- [x] sse and websocket support
- [x] static file serving with etag and range support
- [ ] reactivity and signals

## quick start

```json
// ... deno.json
{
	"imports": {
		"@july/snarl": "jsr:@july/snarl"
	},
	"compilerOptions": {
		"jsx": "precompile",
		"jsxImportSource": "@july/snarl",
		"lib": ["deno.ns", "dom", "dom.iterable"]
	}
}
```

```tsx
import { createRouter, logger } from "@july/snarl";

const app = createRouter();

app.use(logger());

app.get("/", (ctx) => {
	return ctx.html(
		"<!DOCTYPE html>" + (
			<html>
				<head>
					<title>example paige</title>
				</head>
				<body>
					<h1>welcom</h1>
					<p>i meant page* haiiiii</p>
				</body>
			</html>
		),
	);
});

app.get("/users/:id", (ctx) => {
	const { id } = ctx.params;
	return ctx.json({ user: id });
});

app.post("/users", async (ctx) => {
	const body = await ctx.body();
	return ctx.created(body);
});

Deno.serve(app.fetch);
```
