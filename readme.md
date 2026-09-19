# snarl

a minimal, batteries-included web framework for deno. it provides a type-safe routing core, a
composable middleware system with automatic dependency resolution, and native streaming primitives

## features

- tiny core, built entirely on top of deno's `@std/*`
- declarative middleware with priority tiers and automatic dependency resolution
- flexible type-safe routing with first-class support for path parameters, route groups, and
  wildcard methods w/ full inference :3
- chainable context helpers and type-safe request/response handling
- composable middleware stack with built-in support for CORS, logging, security headers, rate
  limiting
- ETag caching (weak + strong), `Range` requests, dotfile protection, and streaming responses
- first-class SSE and WebSocket support with abort-safe async iterables
- lightweight server-side rendering with escaping, style objects, and fragment support
- automatic JSON, form-urlencoded, and multipart file upload handling with size limits
- a tiny schema validator (`v`) whose definitions are the types: `ctx.body.json(User)`,
  `ctx.body.form(Signup)` and `ctx.query.parse(Filters)` validate, narrow, and answer a 422 with
  every issue and its path. `v.coerce` turns the strings a query or form carries into numbers,
  booleans, dates and arrays
- CORS, CSP, HSTS, referrer policy, and rate limiting as composable middleware
- global error handling and cookie jar management

## quick start

```jsonc
// deno.json
{
	"imports": {
		"@july/snarl": "jsr:@july/snarl"
	},
	"compilerOptions": {
		"jsx": "react-jsx",
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
		<html>
			<head>
				<title>example paige</title>
			</head>
			<body>
				<h1>welcom</h1>
				<p>i meant page* haiiiii</p>
			</body>
		</html>,
	);
});

app.get("/users/:id", (ctx) => {
	const { id } = ctx.params;
	return ctx.json({ user: id });
});

app.post("/users", async (ctx) => {
	const body = await ctx.body.json();
	return ctx.created(body);
});

app.serve();
```

## ecosystem

| Package          | Description                                             |
| :--------------- | :------------------------------------------------------ |
| **@july/snarl**  | core: router, middleware, jsx, streaming                |
| **@404/imouto**  | file-based routing, layout composition, app boilerplate |
| **@404/aether**  | islands architecture, reactivity, client bundling       |
| **@404/varnish** | response post-processing: minification, scoped CSS      |
