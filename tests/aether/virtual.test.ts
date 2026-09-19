/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { client, window } from "./dom.ts";
import { signal } from "@404/aether/reactivity";

const h = client.jsx as (tag: any, props?: any) => any;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const { document } = window;

function scroller(height: number, contentHeight: () => number) {
	const el = document.createElement("div") as unknown as HTMLElement;
	let top = 0;
	Object.defineProperties(el, {
		clientHeight: { get: () => height },
		scrollHeight: { get: contentHeight },
		scrollTop: { get: () => top, set: (v: number) => (top = v) },
	});
	(el as any).scrollTo = ({ top: next }: { top: number }) => {
		top = next;
		el.dispatchEvent(new window.Event("scroll") as unknown as Event);
	};
	return el;
}

function layout(container: HTMLElement): void {
	const spacer = container.querySelector('[data-x-spacer="top"]') as any;
	spacer.getBoundingClientRect = () => ({ top: -container.scrollTop, height: 0 });
	(container as any).getBoundingClientRect = () => ({ top: 0, height: 100 });
}

const items = (n: number) => Array.from({ length: n }, (_, i) => i);
const texts = (root: Element) => [...root.querySelectorAll("li")].map((li) => li.textContent);

Deno.test("virtual: keyed items keep their nodes while the window slides", async () => {
	const list = signal(items(50));
	const container = scroller(100, () => 500) as any;
	const ul = h("ul", {
		children: h("for", {
			each: list,
			key: (n: number) => n,
			virtual: { itemSize: 10, overscan: 1, scrollParent: container },
			children: (n: number) => h("li", { children: String(n) }),
		}),
	}) as HTMLElement;
	container.append(ul);
	document.body.append(container);
	layout(container);
	await tick();

	const li5 = [...ul.querySelectorAll("li")].find((li) => li.textContent === "5")!;
	container.scrollTo({ top: 30 });
	assertEquals(texts(ul)[0], "2");
	assertEquals([...ul.querySelectorAll("li")].find((li) => li.textContent === "5"), li5);
	container.remove();
});
