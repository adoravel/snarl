/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { client, clientRuntime } from "./dom.ts";
import { signal } from "@404/aether/reactivity";

const h = client.jsx as (tag: any, props?: any) => any;

Deno.test("control flow: <show> and <for> accept text children", () => {
	const on = signal(true);
	const el = h("div", {
		children: [
			h("show", { when: on, fallback: "off", children: "on" }),
			h("for", { each: ["a", "b"], key: (t: string) => t, children: (t: string) => t }),
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
			children: (n: number) =>
				h("show", {
					when: n % 2,
					fallback: h("li", { children: "even" }),
					children: h("li", { children: String(n) }),
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
				children: (n: number) => h("li", { children: String(n) }),
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
			children: (n: number) => h("li", { children: String(n) }),
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
