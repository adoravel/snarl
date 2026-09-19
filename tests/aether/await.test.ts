/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { client, mountIsland, server } from "./dom.ts";
import { onCleanup, signal } from "@404/aether/reactivity";

const h = client.jsx as (tag: any, props?: any) => any;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
	let resolve!: (v: T) => void, reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => (resolve = res, reject = rej));
	return { promise, resolve, reject };
}

Deno.test("<await>: shows the fallback, then the resolved content", async () => {
	const d = deferred<string>();
	const el = h("div", {
		children: h("await", {
			for: d.promise,
			fallback: "a little",
			children: (v: string) => h("b", { children: v }),
		}),
	}) as HTMLElement;
	assertEquals(el.innerHTML, "<!--await-->a little<!--/await-->");

	d.resolve("done");
	await tick();
	assertEquals(el.innerHTML, "<!--await--><b>done</b><!--/await-->");
});

Deno.test("<await>: catch renders a rejection", async () => {
	const d = deferred<string>();
	const el = h("div", {
		children: h("await", {
			for: d.promise,
			fallback: "…",
			catch: (e: Error) => h("i", { children: e.message }),
			children: (v: string) => v,
		}),
	}) as HTMLElement;
	d.reject(new Error("nope"));
	await tick();
	assertEquals(el.innerHTML, "<!--await--><i>nope</i><!--/await-->");
});

Deno.test("<await>: a tracked source restarts, drops the stale promise and disposes old content", async () => {
	const id = signal(1);
	const pending = new Map<number, ReturnType<typeof deferred<string>>>();
	const cleaned: string[] = [];
	const el = h("div", {
		children: h("await", {
			for: () => {
				const d = deferred<string>();
				pending.set(id(), d);
				return d.promise;
			},
			fallback: "…",
			children: (v: string) => {
				onCleanup(() => cleaned.push(v));
				return h("b", { children: v });
			},
		}),
	}) as HTMLElement;

	pending.get(1)!.resolve("one");
	await tick();
	assertEquals(el.innerHTML, "<!--await--><b>one</b><!--/await-->");

	id(2);
	assertEquals(el.innerHTML, "<!--await-->…<!--/await-->");
	assertEquals(cleaned, ["one"], "the resolved branch is disposed when the source changes");

	id(3);
	pending.get(2)!.resolve("two");
	pending.get(3)!.resolve("three");
	await tick();
	assertEquals(el.innerHTML, "<!--await--><b>three</b><!--/await-->");
});

Deno.test("<await>: ssr renders the fallback and the client hydrates it", async () => {
	const d = deferred<string>();
	const { el, warnings } = await mountIsland((h) =>
		h("div", {
			children: [
				h("await", {
					for: d.promise,
					fallback: h("i", { children: "wait" }),
					children: (v: string) => v,
				}),
				h("hr"),
			],
		})
	);
	assertEquals(warnings, []);
	assertEquals(el.innerHTML, "<div><!--await--><i>wait</i><!--/await--><hr></div>");

	d.resolve("ready");
	await tick();
	assertEquals(el.innerHTML, "<div><!--await-->ready<!--/await--><hr></div>");
});

Deno.test("<await>: ssr never waits for the promise", async () => {
	const html = await server.renderToString(
		(server.jsx as any)("await", {
			for: Promise.resolve("x"),
			fallback: ":3",
			children: (v: string) => v,
		}),
	);
	assertEquals(html, "<!--await-->:3<!--/await-->");
});
