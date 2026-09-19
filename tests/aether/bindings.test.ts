/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { client, server, window } from "./dom.ts";
import { signal } from "@404/aether/reactivity";

const h = client.jsx as (tag: any, props?: any) => any;
const s = server.jsx as (tag: any, props?: any) => any;

function change(node: Node): void {
	node.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
}

Deno.test("bind:value on <select> applies the initial value", () => {
	const choice = signal("b");
	const select = h("select", {
		"bind:value": choice,
		children: [
			h("option", { value: "a", children: "A" }),
			h("option", { value: "b", children: "B" }),
			h("option", { value: "c", children: "C" }),
		],
	}) as HTMLSelectElement;

	assertEquals(select.value, "b");
	assertEquals(select.selectedIndex, 1);

	choice("c");
	assertEquals(select.value, "c");

	select.value = "a";
	change(select);
	assertEquals(choice(), "a");
});

Deno.test("bind:value on <select> works with options from <for>", () => {
	const options = signal(["x", "y"]);
	const choice = signal("y");
	const select = h("select", {
		"bind:value": choice,
		children: h("for", {
			each: options,
			key: (o: string) => o,
			children: (o: string) => h("option", { value: o, children: o }),
		}),
	}) as HTMLSelectElement;

	assertEquals(select.value, "y");
});

Deno.test("bind:value still binds inputs (no children involved)", () => {
	const text = signal("hi");
	const input = h("input", { "bind:value": text }) as HTMLInputElement;
	assertEquals(input.value, "hi");
	text("yo");
	assertEquals(input.value, "yo");
});

Deno.test("ssr: bind:value on <select> marks the matching option selected", async () => {
	const choice = signal("b");
	const html = await server.renderToString(
		s("select", {
			name: "pick",
			"bind:value": choice,
			children: [
				s("option", { value: "a", children: "A" }),
				s("option", { value: "b", children: "B" }),
			],
		}),
	);
	assertEquals(
		html,
		'<select name="pick"><option value="a">A</option><option value="b" selected>B</option></select>',
	);
});

Deno.test("ssr: select options are matched by text, through <for> and <optgroup>", async () => {
	const choice = signal("two");
	const html = await server.renderToString(
		s("select", {
			"bind:value": choice,
			children: [
				s("optgroup", {
					label: "g",
					children: s("for", {
						each: ["one", "two"],
						key: (o: string) => o,
						children: (o: string) => s("option", { children: o }),
					}),
				}),
				s("option", { children: "three" }),
			],
		}),
	);
	assertEquals(
		html,
		'<select><optgroup label="g"><option>one</option><option selected>two</option></optgroup>' +
			"<option>three</option></select>",
	);
});

Deno.test("ssr: a multiple select selects every bound value", async () => {
	const choice = signal(["a", "c"]);
	const html = await server.renderToString(
		s("select", {
			multiple: true,
			"bind:value": choice,
			children: ["a", "b", "c"].map((v) => s("option", { value: v, children: v })),
		}),
	);
	assertEquals(
		html,
		'<select multiple><option value="a" selected>a</option><option value="b">b</option>' +
			'<option value="c" selected>c</option></select>',
	);
});

Deno.test("ssr: bind:value on inputs still emits the value attribute", async () => {
	const text = signal("hi");
	assertEquals(
		await server.renderToString(s("input", { "bind:value": text })),
		'<input value="hi">',
	);
});
