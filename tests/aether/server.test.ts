/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { jsx as jsxTyped, renderToString } from "@404/aether/jsx-runtime";
import { signal } from "@404/aether/reactivity";
import { assertEquals } from "@std/assert";
import { island } from "../../packages/aether/src/server/island.ts";

const jsx = jsxTyped as (tag: any, props?: any) => any;

Deno.test("ssr: <show> and <for> wrap their output in hydration markers", async () => {
	const on = signal(false);
	const html = await renderToString(
		jsx("div", {
			children: [
				jsx("show", { when: on, fallback: "off", children: jsx("b", { children: "on" }) }),
				jsx("for", { each: ["a", "b"], key: (t: string) => t, children: (t: string) => t }),
			],
		}),
	);
	assertEquals(html, "<div><!--show-->off<!--/show--><!--for-->ab<!--/for--></div>");
});

Deno.test("ssr: island children are rendered inline between slot markers and in a template", async () => {
	const Card = island({
		id: "card",
		exportName: "Card",
		Component: (props: any) =>
			jsx("section", { children: [jsx("h1", { children: props.title }), props.children] }),
	} as any);

	const html = await renderToString(
		jsx(Card, { title: "t", children: jsx("p", { children: "slot" }) }),
	);
	assertEquals(
		html,
		'<div data-x-id="card" data-x-props="{&quot;title&quot;:&quot;t&quot;}">' +
			'<template data-x-slot=""><p>slot</p></template>' +
			"<section><h1>t</h1><!--x-slot--><p>slot</p><!--/x-slot--></section></div>",
	);
});

Deno.test("ssr: islands without children emit neither template nor markers", async () => {
	const Plain = island({
		id: "plain",
		exportName: "Plain",
		Component: () => jsx("i", { children: "x" }),
	} as any);
	const html = await renderToString(jsx(Plain, {}));
	assertEquals(html, '<div data-x-id="plain" data-x-props="{}"><i>x</i></div>');
});
