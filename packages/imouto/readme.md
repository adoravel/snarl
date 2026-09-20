# [`@404/imouto`]

a minimal full-stack web framework built on [snarl](https://jsr.io/@july/snarl)

## features

- file-based routing. supports dynamic params (`[id].tsx` → `/blog/:id`), catch-all routes
  (`[...slug].tsx`), and nested directories
- `_middleware.ts` applies middleware to all routes in a directory, `_error.tsx` provides error
  boundaries, `_404.tsx` handles missing routes
- `<Head>` component collects `<title>`, `<meta>`, `<link>`, and `<script>` tags
- `build()` renders the whole site to static files for hosts that only serve them

## quick start

```ts
// ./main.ts
import { createApp } from "@404/imouto";

const app = await createApp({ routesDir: "./routes" });
app.serve({ port: 8000 });
```

```ts
routes/
├── mod.tsx              GET /
├── about.tsx            GET /about
├── blog/
│   ├── mod.tsx          GET /blog
│   ├── [id].tsx         GET /blog/:id
│   ├── _layout.tsx      wraps all /blog/* routes
│   └── _middleware.ts   auth check for /blog/*
├── _layout.tsx          root layout
├── _error.tsx           error boundary
└── _404.tsx             404 page
```

[`@404/imouto`]: https://kyu.re/~snarl
[snarl]: https://jsr.io/@july/snarl

## static sites

```ts
import { build, createApp } from "@404/imouto";

const app = await createApp({ routesDir: "./routes" });
await build(app, { routesDir: "./routes", outDir: "./dist" });
```

| routes                   | dist                                           |
| :----------------------- | :--------------------------------------------- |
| `mod.tsx`                | `index.html`                                   |
| `about.tsx`              | `about/index.html`                             |
| `blog/[slug].tsx`        | one page per url from its `staticPaths` export |
| `_404.tsx`               | `404.html`                                     |
| `feed.xml.ts` (`GET`)    | `feed.xml`                                     |
| `api/[id].ts` (no paths) | skipped, with a warning                        |

a route with parameters lists its pages: `export const staticPaths = () => ["/blog/hello"]` (an
array, or a function that may be async). links between pages are followed by default (`crawl: false`
to render only what the routes name), and `paths: [...]` adds urls by hand.
