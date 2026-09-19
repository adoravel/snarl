/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { client, server, window } from "./dom.ts";
import { signal } from "@404/aether/reactivity";
import type { PageProps, SpaManifest } from "@404/aether/client";

const { document } = window;
for (const name of ["location", "history", "scrollTo"] as const) {
	Object.defineProperty(globalThis, name, {
		value: name === "scrollTo" ? () => {} : (window as any)[name],
		configurable: true,
	});
}

/** the same pages built for either runtime, like the bundle would import them */
function pages(h: (tag: any, props?: any) => any) {
	const visits = signal(0);
	return {
		visits,
		Home: (_: PageProps) => h("h1", { children: "home" }),
		Post: ({ params }: PageProps) =>
			h("article", {
				children: [
					h("h1", { children: `post ${params.id}` }),
					h("a", { href: "/", children: "back" }),
				],
			}),
		Docs: ({ params }: PageProps) => h("pre", { children: params.rest }),
		Blog: ({ children }: PageProps & { children: unknown }) =>
			h("section", { class: "blog", children: [h("nav", { children: visits }), children] }),
		Missing: ({ url }: PageProps) => h("p", { children: `nothing at ${url.pathname}` }),
	};
}

function manifest(
	h: (tag: any, props?: any) => any,
): SpaManifest & { visits: ReturnType<typeof signal<number>> } {
	const p = pages(h);
	return {
		visits: p.visits,
		routes: [
			{ pattern: "/blog/:id", page: p.Post, layouts: [p.Blog as any] },
			{ pattern: "/docs/*rest", page: p.Docs, layouts: [] },
			{ pattern: "/", page: p.Home, layouts: [] },
		],
		notFound: p.Missing,
	};
}

async function serverRender(path: string): Promise<string> {
	const m = manifest(server.jsx as any);
	const url = new URL(path, "http://localhost");
	const hit = m.routes.find((r) =>
		r.pattern === (path.startsWith("/blog/") ? "/blog/:id" : path === "/" ? "/" : "")
	);
	const params: Record<string, string> = hit?.pattern === "/blog/:id"
		? { id: path.split("/")[2] }
		: {};
	let node: unknown = hit ? hit.page({ params, url }) : m.notFound!({ params, url });
	for (const layout of hit?.layouts.toReversed() ?? []) {
		node = layout({ params, url, children: node });
	}
	return await server.renderToString(node as any);
}

async function mountAt(path: string) {
	window.history.replaceState(null, "", path);
	document.body.innerHTML = `<header>shell</header><div data-x-spa>${await serverRender(
		path,
	)}</div>`;
	const m = manifest(client.jsx as any);
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
	try {
		client.mountSpa(m);
	} finally {
		console.warn = warn;
	}
	return { root: document.querySelector("[data-x-spa]")!, warnings, m };
}

Deno.test("router: hydrates the server-rendered page and exposes the match", async () => {
	const { root, warnings } = await mountAt("/blog/7");
	assertEquals(warnings, []);
	assertEquals(
		root.innerHTML,
		'<section class="blog"><nav>0</nav><article><h1>post 7</h1><a href="/">back</a></article></section>',
	);
	assertEquals(client.route().pattern, "/blog/:id");
	assertEquals(client.route().params, { id: "7" });
});

Deno.test("router: navigate() swaps the page, pushes history and keeps app state", async () => {
	const { root, m } = await mountAt("/");
	m.visits(3);
	client.navigate("/blog/9?x=1");
	assertEquals(window.location.pathname + window.location.search, "/blog/9?x=1");
	assertEquals(root.querySelector("h1")!.textContent, "post 9");
	assertEquals(root.querySelector("nav")!.textContent, "3", "signals outlive navigation");
	assertEquals(client.route().search, "?x=1");

	client.navigate("/docs/a/b/c");
	assertEquals(root.innerHTML, "<pre>a/b/c</pre>");
	assertEquals(client.route().params, { rest: "a/b/c" });
});

Deno.test("router: same-origin links are intercepted, others and opt-outs are not", async () => {
	const { root } = await mountAt("/blog/1");
	const back = root.querySelector("a")!;
	const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
	back.dispatchEvent(event as any);
	assertEquals(event.defaultPrevented, true);
	assertEquals(root.innerHTML, "<h1>home</h1>");

	document.body.insertAdjacentHTML(
		"beforeend",
		'<a id="ext" href="https://example.com/x">x</a><a id="native" href="/blog/2" data-native>y</a>',
	);
	for (const id of ["ext", "native"]) {
		const e = new window.MouseEvent("click", { bubbles: true, cancelable: true });
		document.getElementById(id)!.dispatchEvent(e as any);
		assertEquals(e.defaultPrevented, false, id);
	}
});

Deno.test("router: popstate re-renders for the new location", async () => {
	const { root } = await mountAt("/");
	client.navigate("/blog/4");
	window.history.replaceState(null, "", "/");
	globalThis.dispatchEvent(new Event("popstate"));
	assertEquals(root.innerHTML, "<h1>home</h1>");
	assertEquals(client.route().pattern, "/");
});

Deno.test("router: unmatched paths render notFound", async () => {
	const { root } = await mountAt("/nope");
	assertEquals(root.innerHTML, "<p>nothing at /nope</p>");
	assertEquals(client.route().pattern, null);
});
