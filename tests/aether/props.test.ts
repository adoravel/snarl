/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { client, server } from "./dom.ts";
import { isSignal, signal } from "@404/aether/reactivity";

const c = client.jsx as (tag: any, props?: any) => any;
const s = server.jsx as (tag: any, props?: any) => any;

Deno.test("components receive signal props as signals on both sides", async () => {
	const count = signal(3);
	const seen: string[] = [];

	const Badge = (h: any) => (props: { count: unknown }) => {
		seen.push(isSignal(props.count) ? "signal" : typeof props.count);
		return h("span", { children: props.count });
	};

	const html = await server.renderToString(s(Badge(s), { count }));
	const el = c(Badge(c), { count }) as HTMLElement;

	assertEquals(seen, ["signal", "signal"]);
	assertEquals(html, "<span>3</span>");
	assertEquals(el.outerHTML, "<span>3</span>");
});

Deno.test("ssr: intrinsic elements still unwrap reactive props and children", async () => {
	const cls = signal("dms");
	const n = signal(1);
	const html = await server.renderToString(
		s("p", { class: cls, "class:alittle": n, children: [n, "!"] }),
	);
	assertEquals(html, '<p class="dms alittle">1!</p>');
});

Deno.test("ssr: nested reactive values inside plain-object props of components are untouched", async () => {
	const inner = signal("x");
	let recv: unknown;
	const Comp = (props: { config: { inner: unknown } }) => (recv = props.config.inner, null);
	await server.renderToString(s(Comp, { config: { inner } }));
	assertEquals(recv, inner);
});
