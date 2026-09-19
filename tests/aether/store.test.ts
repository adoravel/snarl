/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { window } from "./dom.ts";
import { createStore, effect } from "@404/aether/reactivity";

Object.defineProperty(globalThis, "localStorage", {
	value: window.localStorage,
	configurable: true,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeIndexedDB() {
	const data = new Map<string, unknown>();
	const request = <T>(result: () => T) => {
		const req: any = {};
		queueMicrotask(() => {
			req.result = result();
			req.onsuccess?.();
		});
		return req;
	};
	const objectStore = {
		get: (key: string) => request(() => data.get(key)),
		put: (value: unknown, key: string) => request(() => void data.set(key, value)),
	};
	const db = { transaction: () => ({ objectStore: () => objectStore }), createObjectStore() {} };
	return {
		data,
		open() {
			const req: any = { result: db };
			queueMicrotask(() => {
				req.onupgradeneeded?.();
				req.onsuccess?.();
			});
			return req;
		},
	};
}

let n = 0;
const key = () => `store-${++n}`;

Deno.test("store: memory-only stores are shared by key and reactive", () => {
	const k = key();
	const a = createStore(k, { count: 0 });
	const b = createStore(k, { count: 99 });
	assertStrictEquals(a, b, "first call wins");

	const seen: number[] = [];
	effect(() => void seen.push(a().count));
	b.update((s) => ({ count: s.count + 1 }));
	assertEquals(seen, [0, 1]);
	assertEquals(a.key, k);
	a.dispose();
});

Deno.test("store: localstorage round trip with debounced writes", async () => {
	const k = key();
	const first = createStore(k, ["a"], { persist: "localstorage", debounce: 5 });
	await first.ready;
	first(["a", "b"]);
	first(["a", "b", "c"]);
	assertEquals(localStorage.getItem(`aether:store:${k}`), null, "not written synchronously");
	await sleep(15);
	assertEquals(JSON.parse(localStorage.getItem(`aether:store:${k}`)!), {
		v: 1,
		data: ["a", "b", "c"],
	});

	first.dispose();
	const second = createStore(k, ["fresh"], { persist: "localstorage" });
	await second.ready;
	assertEquals(second(), ["a", "b", "c"]);
	second.dispose();
});

Deno.test("store: an older version is migrated, or discarded without migrate", async () => {
	const k = key();
	localStorage.setItem(`aether:store:${k}`, JSON.stringify({ v: 1, data: { name: "x" } }));

	const migrated = createStore(k, { fullName: "" }, {
		persist: "localstorage",
		version: 2,
		migrate: (old, from) => ({ fullName: `${(old as { name: string }).name}@v${from}` }),
		debounce: 1,
	});
	await migrated.ready;
	assertEquals(migrated(), { fullName: "x@v1" });
	await sleep(10);
	assertEquals(
		JSON.parse(localStorage.getItem(`aether:store:${k}`)!).v,
		2,
		"re-saved under the new version",
	);
	migrated.dispose();

	localStorage.setItem(`aether:store:${k}`, JSON.stringify({ v: 1, data: { name: "x" } }));
	const warn = console.warn;
	const warnings: string[] = [];
	console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
	try {
		const discarded = createStore(k, { fullName: "init" }, { persist: "localstorage", version: 3 });
		await discarded.ready;
		assertEquals(discarded(), { fullName: "init" });
		discarded.dispose();
	} finally {
		console.warn = warn;
	}
	assertEquals(warnings.length, 1);
});

Deno.test("store: indexeddb backend, and a write before ready wins over the stored value", async () => {
	const fake = fakeIndexedDB();
	Object.defineProperty(globalThis, "indexedDB", { value: fake, configurable: true });
	try {
		const k = key();
		fake.data.set(k, { v: 1, data: "stored" });

		const store = createStore(k, "initial", { persist: "indexeddb", debounce: 1 });
		assertEquals(store(), "initial", "before load");
		store("typed early");
		await store.ready;
		assertEquals(store(), "typed early");
		await sleep(10);
		assertEquals(fake.data.get(k), { v: 1, data: "typed early" });
		store.dispose();

		const again = createStore(k, "initial", { persist: "indexeddb" });
		await again.ready;
		assertEquals(again(), "typed early");
		again.dispose();
	} finally {
		Reflect.deleteProperty(globalThis, "indexedDB");
	}
});
