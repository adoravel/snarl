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

### performance comparison

frameworks were benchmarked using `autocannon`. `snarl 0.2.6` is set as baseline (`1x`).

| Scenario         |                 hono                  |                snarl                 |                 oak                  |               express                |
| :--------------- | :-----------------------------------: | :----------------------------------: | :----------------------------------: | :----------------------------------: |
| **plain text**   | 1.93x<br><small>113,293 req/s</small> | 1.00x<br><small>58,838 req/s</small> | 0.81x<br><small>47,878 req/s</small> | 0.48x<br><small>28,093 req/s</small> |
| **JSON**         | 1.48x<br><small>84,166 req/s</small>  | 1.00x<br><small>56,752 req/s</small> | 0.83x<br><small>47,187 req/s</small> | 0.48x<br><small>27,285 req/s</small> |
| **path params**  | 1.49x<br><small>78,150 req/s</small>  | 1.00x<br><small>52,355 req/s</small> | 0.86x<br><small>44,922 req/s</small> | 0.51x<br><small>26,520 req/s</small> |
| **query params** | 1.61x<br><small>81,325 req/s</small>  | 1.00x<br><small>50,621 req/s</small> | 0.86x<br><small>43,562 req/s</small> | 0.51x<br><small>26,027 req/s</small> |

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
