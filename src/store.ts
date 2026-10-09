/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { dirname, join } from "@std/path";

/** what to remember about an entry beyond its value */
export interface EntryOptions {
	/** milliseconds until it expires. without one it is kept until evicted */
	ttl?: number;
}

/** a key-value store */
export interface Store<K, V> {
	get(key: K): Promise<V | undefined>;

	/** replaces whatever was there, including its expiry */
	set(key: K, value: V, options?: EntryOptions): Promise<void>;

	delete(key: K): Promise<void>;

	/** forgets everything this store put there, and nothing else */
	clear(): Promise<void>;

	/** every live entry. an expired one is skipped and dropped on the way past */
	entries(): AsyncIterable<[K, V]>;

	/** stops the sweep. the store keeps working, it just stops tidying itself */
	close(): void;
}

export interface MemoryStoreOptions {
	/** entries past this count are evicted, oldest write first. defaults to 10 000 */
	maxSize?: number;

	/** the ttl for an entry that does not name its own */
	ttl?: number;

	/** how often expired entries are swept. defaults to the ttl, or a minute */
	sweepMs?: number;
}

interface Entry<V> {
	value: V;
	/** when it expires, or `Infinity` */
	expires: number;
}

function live<V>(entry: Entry<V> | undefined, now: number): entry is Entry<V> {
	return entry !== undefined && entry.expires > now;
}

/**
 * a store in this process's memory. insertion order is the eviction order, and
 * reading a key does *not* refresh it.

 * @example
 * ```ts
 * const sessions = createMemoryStore<string, Session>({ ttl: 30 * 60_000 });
 * await sessions.set(id, session);
 * ```
 */
export function createMemoryStore<K, V>(options: MemoryStoreOptions = {}): Store<K, V> {
	const { maxSize = 10_000, ttl, sweepMs = ttl ?? 60_000 } = options;

	const entries = new Map<K, Entry<V>>();
	let timer: ReturnType<typeof setTimeout> | null = null;

	const sweep = () => {
		timer = null;
		const now = Date.now();
		let remaining = false;
		for (const [key, entry] of entries) {
			if (entry.expires <= now) entries.delete(key);
			else if (entry.expires !== Infinity) remaining = true;
		}
		if (remaining) schedule();
	};

	const schedule = () => {
		if (timer !== null) return;
		timer = setTimeout(sweep, sweepMs);
		Deno.unrefTimer(timer);
	};

	return {
		get(key) {
			const entry = entries.get(key);
			if (live(entry, Date.now())) return Promise.resolve(entry.value);
			if (entry) entries.delete(key);
			return Promise.resolve(undefined);
		},

		set(key, value, entryOptions) {
			const lifetime = entryOptions?.ttl ?? ttl;

			entries.delete(key);
			entries.set(key, {
				value,
				expires: lifetime === undefined ? Infinity : Date.now() + lifetime,
			});

			if (entries.size > maxSize) {
				const oldest = entries.keys().next();
				if (!oldest.done) entries.delete(oldest.value);
			}
			if (lifetime !== undefined) schedule();
			return Promise.resolve();
		},

		delete(key) {
			entries.delete(key);
			return Promise.resolve();
		},

		clear() {
			entries.clear();
			return Promise.resolve();
		},

		async *entries() {
			const now = Date.now();
			for (const [key, entry] of [...entries]) {
				if (live(entry, now)) yield [key, entry.value];
				else entries.delete(key);
			}
		},

		close() {
			if (timer !== null) clearTimeout(timer);
			timer = null;
		},
	};
}

export interface FileStoreOptions {
	/** the ttl for an entry that does not name its own */
	ttl?: number;

	/** how a value is written. defaults to json */
	encode?: (value: unknown) => string;

	/** how a value is read back. defaults to json */
	decode?: (text: string) => unknown;
}

/** a key becomes one file, so it has to survive being a filename */
function makeFileNameFromKey(key: string): string {
	return `${encodeURIComponent(key)}.json`;
}

function makeKey(name: string): string | undefined {
	if (!name.endsWith(".json")) return undefined;
	try {
		return decodeURIComponent(name.slice(0, -".json".length));
	} catch {
		return undefined;
	}
}

/**
 * a store on disk, one file per key, that outlives the process.
 *
 * needs read and write access to `directory`, which is created on first write.
 *
 * @example
 * ```ts
 * const tokens = createFileStore<Token>("./.tokens", { ttl: 7 * 86_400_000 });
 * ```
 */
export function createFileStore<V>(
	directory: string,
	options: FileStoreOptions = {},
): Store<string, V> {
	const { ttl, encode = JSON.stringify, decode = JSON.parse } = options;

	const getPath = (key: string) => join(directory, makeFileNameFromKey(key));

	async function read(key: string): Promise<Entry<V> | undefined> {
		try {
			const text = await Deno.readTextFile(getPath(key));
			const stored = decode(text) as { value: V; expires: number | null };
			return { value: stored.value, expires: stored.expires ?? Infinity };
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return undefined;
			if (error instanceof SyntaxError) return undefined;
			throw error;
		}
	}

	async function remove(key: string): Promise<void> {
		try {
			await Deno.remove(getPath(key));
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
	}

	return {
		async get(key) {
			const entry = await read(key);
			if (live(entry, Date.now())) return entry.value;
			if (entry) await remove(key);
			return undefined;
		},

		async set(key, value, entryOptions) {
			const lifetime = entryOptions?.ttl ?? ttl;
			const path = getPath(key);
			await Deno.mkdir(dirname(path), { recursive: true });
			await Deno.writeTextFile(
				path,
				encode({
					value,
					expires: lifetime === undefined ? null : Date.now() + lifetime,
				}),
			);
		},

		delete: remove,

		async clear() {
			for await (const key of keys()) await remove(key);
		},

		async *entries() {
			const now = Date.now();
			for await (const key of keys()) {
				const entry = await read(key);
				if (live(entry, now)) yield [key, entry.value];
				else if (entry) await remove(key);
			}
		},

		close() {},
	};

	async function* keys(): AsyncIterable<string> {
		try {
			for await (const entry of Deno.readDir(directory)) {
				if (!entry.isFile) continue;
				const key = makeKey(entry.name);
				if (key !== undefined) yield key;
			}
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
	}
}
