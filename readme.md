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
- ETag caching for static files (weak + strong) and for anything a route builds (`etag()`), `Range`
  requests, dotfile protection, and streaming responses
- first-class SSE and WebSocket support with abort-safe async iterables
- lightweight server-side rendering with escaping, style objects, and fragment support, either to a
  string or streamed as it renders (`ctx.htmlStream`)
- automatic JSON, form-urlencoded, and multipart file upload handling with size limits
- a typed `service` api: functions that are also ordinary http endpoints, callable in process or
  from the browser through the same call site
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

| Package         | Description                                             |
| :-------------- | :------------------------------------------------------ |
| **@july/snarl** | core: router, middleware, jsx, streaming                |
| **@404/imouto** | file-based routing, layout composition, app boilerplate |
| **@404/aether** | islands architecture, reactivity, client bundling       |

## service

a procedure is a `v` schema and a handler. mounting the service registers one real route per
procedure

```ts
// api.ts
const authed = service.guard(({ ctx }) => {
	const user = session(ctx);
	if (!user) throw new ServiceError("unauthorised", "sign in first");
	return { user };
}, ["unauthorised"]);

export const api = service({
	posts: {
		list: service.query({
			input: v({ page: v.coerce.number({ int: true, min: 1 }).default(1) }),
			headers: { "Cache-Control": "max-age=60" },
			handler: ({ input }) => db.posts(input.page),
		}),
		create: authed.mutation({
			input: v({ title: v.string({ min: 1 }) }),
			errors: ["conflict"],
			handler: ({ input, user }) => db.create(input, user),
		}),
		tail: authed.stream({
			handler: async function* ({ user }) {
				for await (const post of db.watch(user)) yield post;
			},
		}),
	},
});

// main.ts
api.mount(app);
```

```ts
// on the server
const posts = await api.caller(ctx).posts.list({ page: 2 });

// in the browser
import type { api } from "./api.ts";

const client = createClient<typeof api>();
const posts = await client.posts.list({ page: 2 });
```

### somebody else's api

`service()` describes procedures you implement. `remote()` describes endpoints you only call, so
let's say, a go or rust service gets the same call sites as your own:

```ts
const billing = remote("https://billing.internal", {
	invoices: {
		list: endpoint.get("/v1/invoices", {
			input: v({ customer: v.string(), limit: v.coerce.number().default(20) }),
			output: v({ data: v.array(Invoice) }),
		}),
		get: endpoint.get("/v1/invoices/:id", { input: v({ id: v.string() }), output: Invoice }),
		void: endpoint.post("/v1/invoices/:id/void", {
			input: v({ id: v.string() }),
			output: Invoice,
			errors: ["conflict"],
		}),
		events: endpoint.stream("/v1/events", { output: Invoice }),
	},
});

const client = createRemoteClient(billing, { headers: () => ({ authorization: `Bearer ${key}` }) });

const invoice = await client.invoices.get({ id: "in_1" });
const result = await client.invoices.void.attempt({ id: "in_1" });

if (!result.ok && result.error.code === "conflict") … // :3
```

#### apis that do not want json

real apis are not uniform, so `body` and `response` say what an endpoint actually speaks and call site stays the same:

```ts
const discord = remote("https://discord.com/api/v10", {
	// an oauth exchange takes a form, not json
	token: endpoint.post("/oauth2/token", {
		input: v({ grant_type: v.string(), code: v.string(), redirect_uri: v.string() }),
		output: v({ access_token: v.string(), expires_in: v.number() }),
		body: "form",
	}),
	// a webhook wants nothing back, and nothing said about it if it fails
	notify: endpoint.post("/webhooks/:id/:token", { input: Message, response: "none" }),
	// an avatar is bytes to hand on, not a shape to parse
	avatar: endpoint.get("https://cdn.discordapp.com/avatars/:user/:hash.webp", {
		input: v({ user: v.string(), hash: v.string() }),
		response: "stream",
	}),
});

await discord.notify.attempt(message); // fire & forget
return new Response(await discord.avatar({ user, hash }), { headers });
```
