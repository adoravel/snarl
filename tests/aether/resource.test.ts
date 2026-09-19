/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import "./dom.ts";
import { effectScope, resource, signal } from "@404/aether/reactivity";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function controllable<T>() {
	const pending: {
		deps: unknown;
		resolve: (v: T) => void;
		reject: (e: unknown) => void;
		signal: AbortSignal;
	}[] = [];
	const fetcher = (deps: unknown, { signal }: { signal: AbortSignal }) =>
		new Promise<T>((resolve, reject) => pending.push({ deps, resolve, reject, signal }));
	return { pending, fetcher };
}

Deno.test("resource: loads on creation and re-runs when deps change", async () => {
	const id = signal(1);
	const { pending, fetcher } = controllable<string>();
	const r = resource(() => id(), fetcher);

	assertEquals(r.loading(), true);
	assertEquals(r.data(), undefined);
	assertEquals(pending.map((p) => p.deps), [1]);

	pending[0].resolve("one");
	await tick();
	assertEquals(r.data(), "one");
	assertEquals(r.loading(), false);

	id(2);
	assertEquals(r.loading(), true);
	assertEquals(r.data(), "one", "previous data is kept while refetching");
	assertEquals(pending[0].signal.aborted, true, "the previous run is aborted");
	pending[1].resolve("two");
	await tick();
	assertEquals(r.data(), "two");
});

Deno.test("resource: a late response from an older run is dropped", async () => {
	const id = signal(1);
	const { pending, fetcher } = controllable<string>();
	const r = resource(() => id(), fetcher);

	id(2);
	pending[1].resolve("two");
	await tick();
	pending[0].resolve("one");
	await tick();
	assertEquals(r.data(), "two");
	assertEquals(r.loading(), false);
});

Deno.test("resource: errors land in error, an abort does not", async () => {
	const id = signal(1);
	const { pending, fetcher } = controllable<string>();
	const r = resource(() => id(), fetcher);

	pending[0].reject(new Error("nope"));
	await tick();
	assertEquals((r.error() as Error).message, "nope");
	assertEquals(r.loading(), false);

	id(2);
	pending[1].reject(new DOMException("aborted", "AbortError"));
	id(3);
	pending[1].reject(new DOMException("aborted", "AbortError"));
	await tick();
	assertEquals(r.loading(), true, "the aborted run doesn't settle the resource");

	pending[2].resolve("three");
	await tick();
	assertEquals(r.error(), undefined, "a success clears the error");
	assertEquals(r.data(), "three");
});

Deno.test("resource: refetch re-runs with the current deps and flags it", async () => {
	const id = signal(7);
	const seen: boolean[] = [];
	const r = resource(
		() => id(),
		(deps: number, { refetching }) => (seen.push(refetching), Promise.resolve(deps * 2)),
	);
	await tick();
	assertEquals(r.data(), 14);
	assertEquals(await r.refetch(), 14);
	assertEquals(seen, [false, true]);
});

Deno.test("resource: disposing the owning scope aborts the in-flight run", async () => {
	const { pending, fetcher } = controllable<string>();
	let r!: ReturnType<typeof resource<string, undefined>>;
	const dispose = effectScope(() => {
		r = resource(fetcher, { initialValue: "initial" });
	});
	assertEquals(r.data(), "initial");
	dispose();
	assertEquals(pending[0].signal.aborted, true);
	pending[0].resolve("late");
	await tick();
	assertEquals(r.data(), "initial", "nothing lands after disposal");
});

Deno.test("resource: without deps it fetches once", async () => {
	let calls = 0;
	const r = resource(() => (calls++, Promise.resolve("x")));
	await tick();
	assertEquals([r.data(), calls], ["x", 1]);
});
