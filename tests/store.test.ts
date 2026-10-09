/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals } from "@std/assert";
import { createRouter, rateLimit, rateLimitStore } from "@july/snarl";
// the subpath, which is what an island imports: the store is a primitive you
// reach for deliberately, not something every `@july/snarl` import drags along
import { createFileStore, createMemoryStore, type Store } from "@july/snarl/store";
import { scratch } from "./scratch.ts";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

async function collect<K, V>(store: Store<K, V>): Promise<[K, V][]> {
	const out: [K, V][] = [];
	for await (const entry of store.entries()) out.push(entry);
	return out;
}

/** every store answers the same way, so they are tested the same way */
async function behaves(store: Store<string, { n: number }>): Promise<void> {
	assertEquals(await store.get("missing"), undefined);

	await store.set("a", { n: 1 });
	await store.set("b", { n: 2 });
	assertEquals(await store.get("a"), { n: 1 });
	assertEquals((await collect(store)).sort(), [["a", { n: 1 }], ["b", { n: 2 }]]);

	await store.set("a", { n: 3 });
	assertEquals(await store.get("a"), { n: 3 }, "a second set replaces the value");

	await store.delete("a");
	assertEquals(await store.get("a"), undefined);

	// an expiry in the past is gone on the next read, without waiting for a sweep
	await store.set("c", { n: 4 }, { ttl: -1 });
	assertEquals(await store.get("c"), undefined);
	assertEquals(await collect(store), [["b", { n: 2 }]]);

	await store.clear();
	assertEquals(await collect(store), []);
	store.close();
}

Deno.test("store: a memory store", async () => {
	await behaves(createMemoryStore<string, { n: number }>());
});

Deno.test("store: a file store, which outlives the process holding it", async () => {
	const dir = await scratch("store-file");
	await behaves(createFileStore<{ n: number }>(dir));

	const first = createFileStore<string>(dir);
	await first.set("session:1", "kept");
	// a key is not a filename, so it has to survive being made into one
	await first.set("weird/key with spaces", "also kept");

	const second = createFileStore<string>(dir);
	assertEquals(await second.get("session:1"), "kept");
	assertEquals(await second.get("weird/key with spaces"), "also kept");
	assertEquals((await collect(second)).length, 2);

	await second.clear();
	assertEquals(await first.get("session:1"), undefined, "cleared for everyone");
});

Deno.test("store: a missing directory reads as empty rather than throwing", async () => {
	const store = createFileStore<string>(`${await scratch("store-absent")}/not-yet`);
	assertEquals(await store.get("x"), undefined);
	assertEquals(await collect(store), []);

	await store.set("x", "made on write");
	assertEquals(await store.get("x"), "made on write");
});

Deno.test("store: oldest entries are evicted past maxSize", async () => {
	const store = createMemoryStore<string, number>({ maxSize: 2 });
	await store.set("a", 1);
	await store.set("b", 2);
	await store.set("c", 3);

	assertEquals(await store.get("a"), undefined, "the oldest write went first");
	assertEquals(await store.get("b"), 2);
	assertEquals(await store.get("c"), 3);
	store.close();
});

Deno.test("store: rate limiting counts through the same store", async () => {
	const dir = await scratch("store-limits");
	// the point of exporting it: a guard can count the same way middleware does
	const shared = rateLimitStore(createFileStore(dir));

	const first = await shared.increment("k", 60_000);
	assertEquals(first.count, 1);
	assert(first.reset > Date.now(), "the window is open");
	assertEquals(await shared.increment("k", 60_000), { count: 2, reset: first.reset });
	assertEquals((await shared.increment("other", 60_000)).count, 1, "counted per key");

	const app = createRouter();
	app.use(rateLimit({ windowMs: 60_000, max: 1, keygen: () => "k", store: shared }));
	app.get("/x", (ctx) => ctx.text("ok"));

	const response = await app.fetch(new Request("http://localhost/x"), mockInfo);
	assertEquals(response.status, 429, "the middleware counts what the guard already counted");
	await response.text();
	shared.cleanup();
});
