/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { client, clientRuntime } from "./dom.ts";
import { computed, signal } from "@404/aether/reactivity";

const h = client.jsx as (tag: any, props?: any) => any;

Deno.test("control flow: <show> and <for> accept text children", () => {
	const on = signal(true);
	const el = h("div", {
		children: [
			h("show", { when: on, fallback: "off", children: "on" }),
			h("for", { each: ["a", "b"], key: (t: string) => t, children: (t: () => string) => t() }),
		],
	}) as HTMLElement;
	assertEquals(el.innerHTML, "<!--show-->on<!--/show--><!--for-->ab<!--/for-->");
	on(false);
	assertEquals(el.innerHTML, "<!--show-->off<!--/show--><!--for-->ab<!--/for-->");
});

Deno.test("control flow: <for> items that are blocks are positioned as ranges", () => {
	const items = signal([1, 2, 3]);
	const el = h("ul", {
		children: h("for", {
			each: items,
			key: (n: number) => n,
			children: (item: () => number) =>
				h("show", {
					when: item() % 2,
					fallback: h("li", { children: "even" }),
					children: h("li", { children: String(item()) }),
				}),
		}),
	}) as HTMLElement;
	assertEquals(
		el.innerHTML,
		"<!--for--><!--show--><li>1</li><!--/show--><!--show--><li>even</li><!--/show--><!--show--><li>3</li><!--/show--><!--/for-->",
	);
	items([3, 1]);
	assertEquals(
		el.innerHTML,
		"<!--for--><!--show--><li>3</li><!--/show--><!--show--><li>1</li><!--/show--><!--/for-->",
	);
});

Deno.test("control flow: a static <for> inside <show> is removed and restored whole", () => {
	const visible = signal(true);
	const items = signal([1]);
	const el = h("div", {
		children: h("show", {
			when: visible,
			children: h("for", {
				each: items,
				key: (n: number) => n,
				children: (n: () => number) => h("li", { children: String(n()) }),
			}),
		}),
	}) as HTMLElement;
	assertEquals(el.innerHTML, "<!--show--><!--for--><li>1</li><!--/for--><!--/show-->");

	items([1, 2]);
	visible(false);
	assertEquals(el.innerHTML, "<!--show--><!--/show-->");
	items([1, 2, 3]);
	visible(true);
	assertEquals(
		el.innerHTML,
		"<!--show--><!--for--><li>1</li><li>2</li><li>3</li><!--/for--><!--/show-->",
	);
});

Deno.test("control flow: keyed nodes survive reorders", () => {
	const items = signal([1, 2, 3]);
	const el = h("ul", {
		children: h("for", {
			each: items,
			key: (n: number) => n,
			children: (n: () => number) => h("li", { children: String(n()) }),
		}),
	}) as HTMLElement;
	const [one, two, three] = el.querySelectorAll("li");
	items([3, 2, 1]);
	const after = [...el.querySelectorAll("li")];
	assertStrictEquals(after[0], three);
	assertStrictEquals(after[1], two);
	assertStrictEquals(after[2], one);
});

Deno.test("control flow: fragments flatten into their parent", () => {
	const el = h("div", {
		children: h(clientRuntime.Fragment, { children: ["a", h("b", { children: "b" }), "c"] }),
	}) as HTMLElement;
	assertEquals(el.innerHTML, "a<b>b</b>c");
});

Deno.test("control flow: a keyed row survives its item being replaced", () => {
	interface Row {
		id: number;
		text: string;
	}
	let built = 0;
	const rows = signal<Row[]>([{ id: 1, text: "one" }, { id: 2, text: "two" }]);

	const ul = h("ul", {
		children: h("for", {
			each: rows,
			key: (r: Row) => r.id,
			children: (row: () => Row) => {
				built++;
				return h("li", { children: computed(() => row().text) });
			},
		}),
	}) as HTMLElement;

	const [first] = ul.querySelectorAll("li");
	assertEquals(built, 2);

	rows([{ id: 1, text: "ONE" }, { id: 2, text: "two" }]);
	assertEquals(ul.textContent, "ONEtwo");
	assertStrictEquals(ul.querySelectorAll("li")[0], first, "the row's dom is reused");
	assertEquals(built, 2, "and its body was not re-run");
});

Deno.test("control flow: <for> renders a fallback when the list is empty", () => {
	const items = signal<string[]>([]);
	const ul = h("ul", {
		children: h("for", {
			each: items,
			key: (s: string) => s,
			fallback: h("li", { children: "nothing here" }),
			children: (s: () => string) => h("li", { children: s() }),
		}),
	}) as HTMLElement;

	assertEquals(ul.textContent, "nothing here");
	items(["a"]);
	assertEquals(ul.textContent, "a");
	items([]);
	assertEquals(ul.textContent, "nothing here", "and back again");
});

Deno.test("control flow: a reactive fallback keeps updating while the list stays empty", () => {
	const items = signal<string[]>([]);
	const label = signal("loading");
	const ul = h("ul", {
		children: h("for", {
			each: items,
			key: (s: string) => s,
			fallback: computed(() => label()),
			children: (s: () => string) => h("li", { children: s() }),
		}),
	}) as HTMLElement;

	assertEquals(ul.textContent, "loading");

	items([]);
	label("empty");
	assertEquals(ul.textContent, "empty");
});

Deno.test("control flow: a reactive child may resolve to nodes", () => {
	const items = signal<string[]>([]);
	const el = h("div", {
		children: ["before ", computed(() => items().map((s) => h("b", { children: s }))), " after"],
	}) as HTMLElement;

	assertEquals(el.innerHTML, "before  after");
	items(["x", "y"]);
	assertEquals(el.innerHTML, "before <b>x</b><b>y</b> after");
	items(["z"]);
	assertEquals(el.innerHTML, "before <b>z</b> after");

	const mixed = signal<unknown>(h("i", { children: "node" }));
	const box = h("p", { children: computed(() => mixed()) }) as HTMLElement;
	assertEquals(box.innerHTML, "<i>node</i>");
	mixed("text");
	assertEquals(box.innerHTML, "text");

	const when = new Date(0);
	mixed(when);
	assertEquals(box.textContent, String(when));
});
