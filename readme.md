# snarl

a minimal web framework for deno

## features

- tiny core, zero runtime bloat; built entirely on top of deno's stdlib
- flexible type-safe routing with first-class support for path parameters, route groups, and wildcard methods
- chainable context helpers and type-safe request/response handling
- composable middleware stack with built-in support for CORS, logging, security headers, rate limiting
- robust file serving featuring ETag caching, `Range` requests, and security options (e.g. dotfile protection)
- native SSE and WebSockets support
- built-in precompiled jsx/tsx renderer
- multipart file uploads and automatic body parsing
- global error handling and cookie jar management

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
