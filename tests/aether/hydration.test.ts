/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { click, client, clientRuntime, input, mountIsland, server, window } from "./dom.ts";
import { signal } from "@404/aether/reactivity";

const { document } = window;

Deno.test("hydration: adopts static markup and attaches listeners", async () => {
	const count = signal(1);
	const { el, warnings } = await mountIsland((h) =>
		h("div", {
			class: "box",
			children: [
				h("button", { onClick: () => count.update((n) => n + 1), children: "+" }),
				h("span", { children: count }),
			],
		})
	);

	assertEquals(warnings, []);
	const span = el.querySelector("span")!;
	const button = el.querySelector("button")!;
	assertEquals(span.textContent, "1");

	click(button);
	assertEquals(span.textContent, "2");
	assertStrictEquals(el.querySelector("span"), span, "nodes are kept, not rebuilt");
	assertEquals(el.hasAttribute("data-x-id"), false);
});

Deno.test("hydration: keeps the exact server nodes", async () => {
	let before: Element[] = [];
	const { el, warnings } = await mountIsland(
		(h) => h("ul", { children: [h("li", { children: "a" }), h("li", { children: "b" })] }),
		{ before: (el) => before = [...el.querySelectorAll("li")] },
	);

	assertEquals(warnings, []);
	assertEquals(el.innerHTML, "<ul><li>a</li><li>b</li></ul>");
	const after = [...el.querySelectorAll("li")];
	assertStrictEquals(after[0], before[0]);
	assertStrictEquals(after[1], before[1]);
});

Deno.test("hydration: splits merged text nodes and keeps reactive text live", async () => {
	const remaining = signal(2);
	const { el, warnings } = await mountIsland((h) =>
		h("p", {
			children: [
				h("strong", {
					children: [remaining, " item", remaining.map((n) => (n !== 1 ? "s" : "")), " left"],
				}),
			],
		})
	);

	assertEquals(warnings, []);
	const strong = el.querySelector("strong")!;
	assertEquals(strong.textContent, "2 items left");
	assertEquals(strong.childNodes.length, 4);

	remaining(1);
	assertEquals(strong.textContent, "1 item left");
});

Deno.test("hydration: reactive text that rendered empty gets a home", async () => {
	const error = signal("");
	const { el, warnings } = await mountIsland((h) =>
		h("div", { children: ["status: ", error, h("i", { children: "!" })] })
	);

	assertEquals(warnings, []);
	assertEquals(el.firstElementChild!.textContent, "status: !");
	error("boom");
	assertEquals(el.firstElementChild!.textContent, "status: boom!");
});

Deno.test("hydration: static attributes are left alone, reactive ones bind", async () => {
	const active = signal(false);
	const { el, warnings } = await mountIsland((h) =>
		h("div", {
			children: [
				h("input", { type: "text", value: "server" }),
				h("a", { href: "/x", "class:active": active, children: "link" }),
			],
		}), {
		html: '<div><input type="text" value="server"><a href="/x">link</a></div>',
	});

	assertEquals(warnings, []);
	const a = el.querySelector("a")!;
	assertEquals(a.className, "");
	active(true);
	assertEquals(a.className, "active");
});

Deno.test("hydration: input typed before hydration survives", async () => {
	const { el, warnings } = await mountIsland(
		(h) => h("div", { children: [h("input", { type: "text", value: "server" })] }),
		{ before: (el) => (el.querySelector("input")!.value = "typed") },
	);
	assertEquals(warnings, []);
	assertEquals(el.querySelector("input")!.value, "typed");
});

Deno.test("hydration: <show> with function children is adopted and toggles", async () => {
	const open = signal(true);
	const { el, warnings } = await mountIsland((h) =>
		h("div", {
			children: [
				h("show", { when: open, fallback: "closed", children: () => h("b", { children: "open" }) }),
				h("i", { children: "tail" }),
			],
		})
	);

	assertEquals(warnings, []);
	const b = el.querySelector("b")!;
	assertEquals(el.firstElementChild!.innerHTML, "<!--show--><b>open</b><!--/show--><i>tail</i>");

	open(false);
	assertEquals(el.firstElementChild!.innerHTML, "<!--show-->closed<!--/show--><i>tail</i>");
	open(true);
	assertEquals(el.firstElementChild!.innerHTML, "<!--show--><b>open</b><!--/show--><i>tail</i>");
	assert(el.querySelector("b") !== b, "function children build a fresh branch");
});

Deno.test("hydration: <show> with static children hidden at ssr time", async () => {
	const empty = signal(false);
	const { el, warnings } = await mountIsland((h) =>
		h("div", {
			children: [
				h("show", { when: empty, children: h("p", { children: "nothing here" }) }),
				h("ul", { children: [h("li", { children: "x" })] }),
			],
		})
	);

	assertEquals(warnings, []);
	assertEquals(el.firstElementChild!.innerHTML, "<!--show--><!--/show--><ul><li>x</li></ul>");
	empty(true);
	assertEquals(
		el.firstElementChild!.innerHTML,
		"<!--show--><p>nothing here</p><!--/show--><ul><li>x</li></ul>",
	);
});

Deno.test("hydration: <for> adopts items and keeps keyed nodes across updates", async () => {
	const items = signal([{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }]);
	const { el, warnings } = await mountIsland((h) =>
		h("ul", {
			children: h("for", {
				each: items,
				key: (t: { id: number }) => t.id,
				children: (t: { text: string }) => h("li", { children: t.text }),
			}),
		})
	);

	assertEquals(warnings, []);
	const ul = el.querySelector("ul")!;
	const [a, b, c] = ul.querySelectorAll("li");
	assertEquals(ul.innerHTML, "<!--for--><li>a</li><li>b</li><li>c</li><!--/for-->");

	items([items()[2], items()[0]]);
	assertEquals(ul.innerHTML, "<!--for--><li>c</li><li>a</li><!--/for-->");
	assertStrictEquals(ul.querySelectorAll("li")[0], c);
	assertStrictEquals(ul.querySelectorAll("li")[1], a);
	assertEquals(b.isConnected, false);
});

Deno.test("hydration: <for> with text items", async () => {
	const tags = signal(["x", "y"]);
	const { el, warnings } = await mountIsland((h) =>
		h("p", {
			children: h("for", { each: tags, key: (t: string) => t, children: (t: string) => t }),
		})
	);
	assertEquals(warnings, []);
	assertEquals(el.firstElementChild!.innerHTML, "<!--for-->xy<!--/for-->");
	tags(["y", "z"]);
	assertEquals(el.firstElementChild!.innerHTML, "<!--for-->yz<!--/for-->");
});

Deno.test("hydration: <for> nested in a static <show> moves and removes as a unit", async () => {
	const visible = signal(true);
	const items = signal([1, 2]);
	const { el, warnings } = await mountIsland((h) =>
		h("div", {
			children: [
				h("show", {
					when: visible,
					children: h("for", {
						each: items,
						key: (n: number) => n,
						children: (n: number) => h("li", { children: String(n) }),
					}),
				}),
				h("hr"),
			],
		})
	);

	assertEquals(warnings, []);
	const root = el.firstElementChild!;
	assertEquals(
		root.innerHTML,
		"<!--show--><!--for--><li>1</li><li>2</li><!--/for--><!--/show--><hr>",
	);

	items([1, 2, 3]);
	visible(false);
	assertEquals(
		root.innerHTML,
		"<!--show--><!--/show--><hr>",
		"the inner block's later items go too",
	);
	visible(true);
	assertEquals(
		root.innerHTML,
		"<!--show--><!--for--><li>1</li><li>2</li><li>3</li><!--/for--><!--/show--><hr>",
	);
});

Deno.test("hydration: slot children are adopted in place", async () => {
	const props = { title: "t" };
	const name = "island-slot";
	const html = await server.renderToString(
		server.jsx("section", {
			children: [
				server.jsx("h1", { children: "t" }),
				server.jsx(server.Fragment as any, {
					dangerouslySetInnerHTML: { __html: "<!--x-slot-->" },
				}),
				server.jsx("p", { children: "from the page" }),
				server.jsx(server.Fragment as any, {
					dangerouslySetInnerHTML: { __html: "<!--/x-slot-->" },
				}),
			],
		}),
	);
	document.body.innerHTML = `<div data-x-id="${name}" data-x-props='${
		JSON.stringify(props)
	}'><template data-x-slot><p>from the page</p></template>${html}</div>`;
	const el = document.body.firstElementChild!;
	const slotted = el.querySelector("section > p")!;

	client.registerIsland(
		name,
		(p: any) =>
			client.jsx("section", {
				children: [client.jsx("h1", { children: p.title }), p.children],
			}) as any,
	);
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
	try {
		client.mount(document as unknown as Document);
	} finally {
		console.warn = warn;
	}

	assertEquals(warnings, []);
	assertEquals(el.innerHTML, "<section><h1>t</h1><p>from the page</p></section>");
	assertStrictEquals(el.querySelector("section > p"), slotted);
});

Deno.test("hydration: mismatch falls back to a client render", async () => {
	const { el, warnings } = await mountIsland(
		(h) => h("div", { children: [h("b", { children: "client" })] }),
		{ html: "<div><i>server</i></div>" },
	);

	assertEquals(warnings.length, 1);
	assert(warnings[0].includes("couldn't adopt"), warnings[0]);
	assertEquals(el.innerHTML, "<div><b>client</b></div>");
});

Deno.test("hydration: an empty island just renders", async () => {
	const { el, warnings } = await mountIsland(
		(h) => h("div", { children: "fresh" }),
		{ html: "" },
	);
	assertEquals(warnings, []);
	assertEquals(el.innerHTML, "<div>fresh</div>");
});

Deno.test("hydration: dangerouslySetInnerHTML is adopted untouched", async () => {
	const { el, warnings } = await mountIsland((h) =>
		h("div", { dangerouslySetInnerHTML: { __html: "<em>raw</em>" } })
	);
	assertEquals(warnings, []);
	const em = el.querySelector("em")!;
	assertEquals(em.textContent, "raw");
});

Deno.test("hydration: fragments and svg", async () => {
	const { el, warnings } = await mountIsland((h) =>
		h(h === client.jsx ? clientRuntime.Fragment : server.Fragment, {
			children: [
				h("svg", { viewBox: "0 0 1 1", children: h("path", { d: "M0 0" }) }),
				"tail",
			],
		})
	);
	assertEquals(warnings, []);
	assertEquals(el.innerHTML, '<svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>tail');
});

Deno.test("hydration: two-way binding on an adopted input", async () => {
	const text = signal("hi");
	const { el, warnings } = await mountIsland((h) =>
		h("div", { children: [h("input", { "bind:value": text }), h("span", { children: text })] })
	);
	assertEquals(warnings, []);
	const inputEl = el.querySelector("input")!;
	assertEquals(inputEl.value, "hi");
	input(inputEl, "hello");
	assertEquals(text(), "hello");
	assertEquals(el.querySelector("span")!.textContent, "hello");
});

Deno.test("hydration: async islands render into a slot after the promise settles", async () => {
	const { el, warnings } = await mountIsland(
		async (h) => {
			await Promise.resolve();
			return h("div", { children: "later" });
		},
		{ html: "<div>server</div>" },
	);
	assertEquals(warnings, []);
	await new Promise((r) => setTimeout(r, 0));
	assertEquals(el.innerHTML, "<!--async--><div>later</div><!--/async-->");
});
