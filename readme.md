# snarl

a minimal yet powerful web framework for deno.

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
				<title>example paige like codeberg.org/paige hilarious innit</title>
			</head>
			<body>
				<h1>welcome</h1>
				<p>hiii :3</p>
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

## documentation

wip. extremely wip. the guides are split into separate files in the repository:

- [routing and parameters](https://codeberg.org/livia/snarl/src/branch/main/docs/routing.md)
- [middleware and built-in features](https://codeberg.org/livia/snarl/src/branch/main/docs/middleware.md)
- [static compilation](https://codeberg.org/livia/snarl/src/branch/main/docs/static.md)
- [procedures](https://codeberg.org/livia/snarl/src/branch/main/docs/types.md)
- [services and remote api integration](https://codeberg.org/livia/snarl/src/branch/main/docs/services.md)
