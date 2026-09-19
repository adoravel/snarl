# [`@404/aether`]

a minimal islands architecture implementation for [snarl]

## features

- AST-based analysis finds interactive components by scanning for signals, effects, and event
  handlers. `"use island"` and `"use server"` directives as hints are also supported.
- signal/computed/effect system with automatic dependency tracking
- client bundles are built per-island-set with tree-shaking and minification via [`esbuild`]
- ssr output includes hydration markers; the client bundle hydrates only `[data-x-id]` boundaries

## quick start

```jsonc
// deno.json
{
	"imports": {
		"@404/imouto": "jsr:@404/imouto",
		"@404/aether": "jsr:@404/aether"
	},
	"permissions": {
		"default": {
			"net": true,
			"read": true,
			"run": true,
			"env": true,
			"write": true
		}
	},
	"compilerOptions": {
		"jsx": "react-jsx",
		"jsxImportSource": "@404/aether",
		"lib": ["deno.ns", "dom", "dom.iterable"]
	}
}
```

```tsx
// ./components/counter.tsx
import { signal } from "@404/aether";

export default function Counter({ initial = 0 }: { initial?: number }) {
	const count = signal(initial);
	return (
		<button onClick={() => count(count() + 1)}>
			count is {count}
		</button>
	);
}
```

```tsx
// ./routes/index.tsx
import Counter from "../components/counter.tsx";

export default function Meow() {
	return <Counter initial={67} />;
}
```

```tsx
// ./main.ts
import { createApp } from "@404/aether";

const app = await createApp({ routesDir: "./routes" });

app.serve({ port: 8000 });
```

## api

| API                  | Description                                                                |
| :------------------- | :------------------------------------------------------------------------- |
| **signal(value)**    | create a reactive signal                                                   |
| **computed(getter)** | create a derived computation                                               |
| **effect(fn)**       | run a side effect that tracks dependencies                                 |
| **batch(fn)**        | batch multiple signal writes into one flush                                |
| **onMount(fn)**      | run once, untracked, after the island is in the document; return a cleanup |
| **onCleanup(fn)**    | run when the island, `<show>` branch or `<for>` item is disposed           |
| **aether(?options)** | Middleware that discovers islands and serves client bundles                |

[`@404/aether`]: https://kyu.re/~snarl
[snarl]: https://jsr.io/@july/snarl
[esbuild]: https://esbuild.github.io/
