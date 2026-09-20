/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { relative, resolve } from "@std/path";
import { build } from "@404/imouto";
import { createApp } from "@404/aether/server";
import { setLogSink } from "@july/snarl/verbosity";

const pragma = "/** @jsxImportSource @404/aether */\n";

const files: Record<string, string> = {
	"routes/_layout.tsx": pragma + `import { css } from "@404/aether";
const Shell = css\`body { margin: 0 }\`;
export default function Layout({ children }: { children: unknown }) {
	return <Shell.html><head><title>site</title></head><body><nav><a href="/about">about</a></nav>{children}</body></Shell.html>;
}
`,
	"routes/mod.tsx": pragma + `import Counter from "../components/counter.tsx";
export default function Home() {
	return <main><h1>home</h1><a href="/blog/linked">linked</a><a href="https://example.com/x">out</a><img src="/logo.png" /><Counter /></main>;
}
`,
	"routes/about.tsx": pragma + `export default () => <p>about</p>;\n`,
	"routes/blog/[slug].tsx": pragma + `export const staticPaths = () => ["/blog/one", "/blog/two"];
export default function Post({ params }: { params: { slug: string } }) {
	return <article>{params.slug}</article>;
}
`,
	"routes/feed.xml.ts":
		`export const GET = () => new Response("<rss/>", { headers: { "content-type": "application/rss+xml" } });\n`,
	"routes/api/[id].ts": `export const GET = () => Response.json({});\n`,
	"routes/_404.tsx": pragma + `export default () => <p>lost</p>;\n`,
	"components/counter.tsx": pragma + `import { signal } from "@404/aether";
export default function Counter() {
	const n = signal(0);
	return <button onClick={() => n.update((v) => v + 1)}>{n}</button>;
}
`,
	"static/logo.png": "png-bytes",
};

Deno.test("build: renders pages, follows links, and collects assets into a static site", async () => {
	const dir = resolve(await Deno.makeTempDir({ dir: "tests/imouto", prefix: "build-" }));
	const rel = relative(Deno.cwd(), dir);
	setLogSink(false);
	try {
		for (const [name, source] of Object.entries(files)) {
			await Deno.mkdir(`${dir}/${name}`.replace(/\/[^/]+$/, ""), { recursive: true });
			await Deno.writeTextFile(`${dir}/${name}`, source);
		}
		const app = await createApp({
			routesDir: `${rel}/routes`,
			staticDir: `${rel}/static`,
			logger: false,
			verbose: false,
		});
		const outDir = `${rel}/dist`;
		const result = await build(app, {
			routesDir: `${rel}/routes`,
			outDir,
			staticDir: `${rel}/static`,
		});

		const read = (file: string) => Deno.readTextFile(`${dir}/dist/${file}`);

		assertEquals(result.pages.slice(0, 5).sort(), [
			"/",
			"/about",
			"/blog/linked",
			"/blog/one",
			"/blog/two",
		]);
		assertEquals(result.skipped, [{
			path: "/api/:id",
			reason: "has parameters and no `staticPaths` export",
		}]);

		const home = await read("index.html");
		assertStringIncludes(home, "<h1>home</h1>");
		assertStringIncludes(home, '<link rel="stylesheet" href="/_css/');
		assertStringIncludes(home, '<script type="module" src="/_aether/entry/');
		assertStringIncludes(await read("about/index.html"), "<p>about</p>");
		assertStringIncludes(await read("blog/one/index.html"), "<article>one</article>");
		assertStringIncludes(
			await read("blog/linked/index.html"),
			"<article>linked</article>",
			"crawled from a link",
		);
		assertStringIncludes(await read("404.html"), "<p>lost</p>");
		assertEquals(await read("feed.xml"), "<rss/>");
		assertEquals(await read("logo.png"), "png-bytes", "static dir copied");

		const css = result.assets.find((a) => a.startsWith("/_css/"))!;
		const bundle = result.assets.find((a) => a.startsWith("/_aether/entry/"))!;
		assert(css && bundle, `assets: ${result.assets}`);
		assertStringIncludes(await read(css.slice(1)), "margin");
		assertStringIncludes(await read(bundle.slice(1)), "registerIsland");
	} finally {
		setLogSink(null);
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("build: crawl: false only renders what the routes and `paths` name", async () => {
	const dir = resolve(await Deno.makeTempDir({ dir: "tests/imouto", prefix: "build-" }));
	const rel = relative(Deno.cwd(), dir);
	setLogSink(false);
	try {
		for (const [name, source] of Object.entries(files)) {
			await Deno.mkdir(`${dir}/${name}`.replace(/\/[^/]+$/, ""), { recursive: true });
			await Deno.writeTextFile(`${dir}/${name}`, source);
		}
		const app = await createApp({ routesDir: `${rel}/routes`, logger: false, verbose: false });
		const result = await build(app, {
			routesDir: `${rel}/routes`,
			outDir: `${rel}/dist`,
			staticDir: false,
			crawl: false,
			paths: ["/blog/extra"],
		});
		assertEquals(result.pages.filter((p) => p.startsWith("/blog/")).sort(), [
			"/blog/extra",
			"/blog/one",
			"/blog/two",
		]);
		assert(result.assets.some((a) => a.startsWith("/_css/")), "assets are still collected");
	} finally {
		setLogSink(null);
		await Deno.remove(dir, { recursive: true });
	}
});
