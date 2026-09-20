# [`@404/imouto`]

a lightweight full-stack web framework built on [snarl](https://jsr.io/@july/snarl)

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

## api

| Export                              | Description                                                               |
| :---------------------------------- | :------------------------------------------------------------------------ |
| **createApp(options?)**             | a router with context, scoped css, head, injection and static files wired |
| **scanRoutes(router, dir)**         | file-based routes; `scanRouteTable` + `registerRouteTable` split it       |
| **css\`…\`**, **styled.tag\`…\`**   | scoped stylesheets and components carrying them                           |
| **scopedStyling()**                 | `scopedCss()` (serves `/_css/<hash>.css`) + `styleScopeInjection()`       |
| **scopeCss(css, scope)**            | the css scoping transform on its own                                      |
| **injectIntoHead / injectIntoBody** | queue markup for `htmlInjection()` to splice into the response            |
| **`<Head>`**                        | collects `<title>`, `<meta>`, `<link>` and `<script>` from a render       |
| **build(app, options?)**            | renders the site to static files                                          |
