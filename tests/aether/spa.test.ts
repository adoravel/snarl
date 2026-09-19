/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { relative, resolve } from "@std/path";
import { window } from "./dom.ts";
import { createApp } from "@404/aether/server";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;
const pragma = "/** @jsxImportSource @404/aether */\n";

const routes: Record<string, string> = {
	"_layout.tsx": pragma + `export default function Shell({ children }: { children: unknown }) {
	return <html><body><nav>shell</nav>{children}</body></html>;
}
`,
	"mod.tsx": pragma + `export default function Home() {
	return <h1>home</h1>;
}
`,
	"_404.tsx": pragma + `export default function Missing({ url }: { url: URL }) {
	return <p>nothing at {url.pathname}</p>;
}
`,
	"blog/_layout.tsx": pragma + `import { signal } from "@404/aether";
const clicks = signal(0);
export default function Blog({ children }: { children: unknown }) {
	return (
		<section class="blog">
			<button onClick={() => clicks.update((n) => n + 1)}>{clicks}</button>
			{children}
			<a href="/">home</a>
		</section>
	);
}
`,
	"blog/[id].tsx": pragma + `export default function Post({ params }: { params: { id: string } }) {
	return <h1>post {params.id}</h1>;
}
`,
	"api/ping.ts": `export const GET = () => Response.json({ pong: true });\n`,
};

async function withRoutes<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = resolve(await Deno.makeTempDir({ dir: "tests/aether", prefix: "spa-" }));
	try {
		for (const [name, source] of Object.entries(routes)) {
			await Deno.mkdir(`${dir}/${name}`.replace(/\/[^/]+$/, ""), { recursive: true });
			await Deno.writeTextFile(`${dir}/${name}`, source);
		}
		return await fn(dir);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
}

Deno.test("spa: pages render inside the shell with nested layouts and a bundle script", async () => {
	await withRoutes(async (dir) => {
		const app = await createApp({
			mode: "spa",
			routesDir: relative(Deno.cwd(), dir),
			logger: false,
			verbose: false,
		});
		const res = await app.fetch(new Request("http://localhost/blog/7"), mockInfo);
		const html = await res.text();

		assertStringIncludes(
			html,
			'<nav>shell</nav><div data-x-spa=""><section class="blog"><button>0</button>' +
				'<!--slot--><h1>post 7</h1><!--/slot--><a href="/">home</a></section></div>',
		);
		const src = html.match(/<script type="module" src="(\/_aether\/spa\.[0-9a-z]+\.js)">/)?.[1];
		assert(src, "the spa bundle is linked");

		const bundle = await app.fetch(new Request(`http://localhost${src}`), mockInfo);
		assertEquals(bundle.status, 200);
		const code = await bundle.text();
		assertStringIncludes(code, "data-x-spa");
		assertStringIncludes(code, "/blog/:id");

		const api = await app.fetch(new Request("http://localhost/api/ping"), mockInfo);
		assertEquals(await api.json(), { pong: true }, "handler modules are untouched");

		const missing = await app.fetch(new Request("http://localhost/nope"), mockInfo);
		assertEquals(missing.status, 404);
		assertStringIncludes(await missing.text(), "nothing at /nope");
	});
});

Deno.test("spa: the real bundle hydrates the real page and routes on the client", async () => {
	await withRoutes(async (dir) => {
		const app = await createApp({
			mode: "spa",
			routesDir: relative(Deno.cwd(), dir),
			logger: false,
			verbose: false,
		});
		const html = await (await app.fetch(new Request("http://localhost/blog/7"), mockInfo)).text();
		const src = html.match(/src="(\/_aether\/spa\.[0-9a-z]+\.js)"/)![1];
		const code = await (await app.fetch(new Request(`http://localhost${src}`), mockInfo)).text();
		const file = `${dir}/bundle.js`;
		await Deno.writeTextFile(file, code);

		const { document } = window;
		for (const name of ["location", "history", "scrollTo"] as const) {
			Object.defineProperty(globalThis, name, {
				value: name === "scrollTo" ? () => {} : (window as any)[name],
				configurable: true,
			});
		}
		window.history.replaceState(null, "", "/blog/7");
		document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"))
			.replace(/<script[^>]*><\/script>/, "");
		const root = document.querySelector("[data-x-spa]")!;
		const button = root.querySelector("button")!;

		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
		try {
			await import(file);
		} finally {
			console.warn = warn;
		}
		assertEquals(warnings, []);

		button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as any);
		assertEquals(button.textContent, "1", "adopted nodes are interactive");
		assertEquals(root.querySelector("button"), button);

		root.querySelector("a")!.dispatchEvent(
			new window.MouseEvent("click", { bubbles: true, cancelable: true }) as any,
		);
		assertEquals(window.location.pathname, "/");
		assertEquals(root.innerHTML, "<h1>home</h1>");
	});
});
