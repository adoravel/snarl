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

frameworks were benchmarked using `autocannon`. `snarl 0.3.0` is set as baseline (`1x`).

| Scenario         |                                snarl |                                  hono |                                  oak |                              express |
| :---             |                                :---: |                                 :---: |                                :---: |                                :---: |
| **plain text**   | 1.00x<br><small>73,554 req/s</small> | 1.36x<br><small>100,346 req/s</small> | 0.53x<br><small>38,960 req/s</small> | 0.30x<br><small>22,398 req/s</small> |
| **JSON**         | 1.00x<br><small>73,005 req/s</small> |  0.88x<br><small>64,200 req/s</small> | 0.53x<br><small>38,842 req/s</small> | 0.26x<br><small>18,982 req/s</small> |
| **path params**  | 1.00x<br><small>73,062 req/s</small> |  0.80x<br><small>58,573 req/s</small> | 0.48x<br><small>34,903 req/s</small> | 0.25x<br><small>18,190 req/s</small> |
| **query params** | 1.00x<br><small>71,830 req/s</small> |  0.87x<br><small>62,502 req/s</small> | 0.43x<br><small>30,702 req/s</small> | 0.28x<br><small>20,362 req/s</small> |

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
