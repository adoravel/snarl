/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { client, mountIsland } from "./dom.ts";
import { onCleanup, onMount, signal } from "@404/aether/reactivity";

const h = client.jsx as (tag: any, props?: any) => any;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const onClient = (runtime: unknown, fn: () => void) => runtime === client.jsx && fn();

Deno.test("onMount: runs once, untracked, after the island is in the document", async () => {
	const room = signal("a");
	const runs: string[] = [];
	let connected: boolean | undefined;

	const { el } = await mountIsland((h) => {
		const root = h("div", { children: "x" });
		onClient(h, () =>
			onMount(() => {
				runs.push(room());
				connected = (root as Node).isConnected;
			}));
		return root;
	});

	assertEquals(runs, ["a"]);
	assertEquals(connected, true);
	room("b");
	await tick();
	assertEquals(runs, ["a"], "a signal read inside onMount does not re-run it");
	client.unmount(el);
});

Deno.test("onMount: the returned cleanup runs on unmount, once", async () => {
	const closed: string[] = [];
	const { el } = await mountIsland((h) => {
		onClient(h, () => onMount(() => () => closed.push("closed")));
		return h("div");
	});

	assertEquals(closed, []);
	client.unmount(el);
	await tick();
	assertEquals(closed, ["closed"]);
});

Deno.test("onCleanup: runs when the island is disposed", async () => {
	const log: string[] = [];
	const { el } = await mountIsland((h) => {
		onClient(h, () => onCleanup(() => log.push("bye")));
		return h("div");
	});
	client.unmount(el);
	await tick();
	assertEquals(log, ["bye"]);
});

Deno.test("onMount: outside an island render it runs on the next microtask", async () => {
	const log: string[] = [];
	const el = h("div", { children: "x" }) as HTMLElement;
	onMount(() => void log.push(`mounted:${el.isConnected}`));
	assertEquals(log, []);
	await tick();
	assertEquals(log, ["mounted:false"]);
});

Deno.test("<for>: item bindings survive list updates and are disposed with the item", () => {
	const items = signal([1, 2]);
	const count = signal(0);
	const cleaned: number[] = [];

	const ul = h("ul", {
		children: h("for", {
			each: items,
			key: (n: number) => n,
			children: (n: number) => {
				onCleanup(() => cleaned.push(n));
				return h("li", { children: [String(n), ":", count] });
			},
		}),
	}) as HTMLElement;

	items([1, 2, 3]);
	count(1);
	assertEquals(ul.textContent, "1:12:13:1");
	assertEquals(cleaned, []);

	items([3]);
	assertEquals(cleaned.sort(), [1, 2]);
	count(2);
	assertEquals(ul.textContent, "3:2");
});

Deno.test("<for>: onMount inside an item is not re-run by list changes", async () => {
	const items = signal(["a"]);
	const mounted: string[] = [];
	const { el } = await mountIsland((h) =>
		h("ul", {
			children: h("for", {
				each: items,
				key: (s: string) => s,
				children: (s: string) => {
					onClient(h, () =>
						onMount(() => {
							mounted.push(s);
							return () => mounted.push(`-${s}`);
						}));
					return h("li", { children: s });
				},
			}),
		})
	);

	assertEquals(mounted, ["a"]);
	items(["a", "b"]);
	await tick();
	assertEquals(mounted, ["a", "b"]);
	items(["b"]);
	await tick();
	assertEquals(mounted, ["a", "b", "-a"]);
	client.unmount(el);
	await tick();
	assertEquals(mounted, ["a", "b", "-a", "-b"]);
});
