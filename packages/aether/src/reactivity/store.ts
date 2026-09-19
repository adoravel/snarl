/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { effect } from "./effect.ts";
import { setActiveSub, untracked } from "./engine.ts";
import { type Signal, signal } from "./signal.ts";
import { isBrowser } from "../env.ts";

export type Persistence = "indexeddb" | "localstorage" | false;

export interface StoreOptions<T> {
	/** where the value survives reloads. `false` (default) keeps it in memory only */
	persist?: Persistence;

	/**
	 * bump when the shape of the persisted value changes. a stored value with
	 * another version goes through `migrate`, or is discarded without one
	 */
	version?: number;

	/** converts a value persisted under an older `version` */
	migrate?: (stored: unknown, fromVersion: number) => T;

	/** how long to coalesce writes before persisting, in ms. defaults to 50 */
	debounce?: number;
}

export interface Store<T> extends Signal<T> {
	readonly key: string;

	/**
	 * settles once the persisted value (if any) has been loaded. until then
	 * reads return `initial`; a write made before that wins over the stored
	 * value, since it's the newer intent
	 */
	readonly ready: Promise<void>;

	/** stops persisting. the in-memory signal stays */
	dispose(): void;
}

interface Envelope {
	v: number;
	data: unknown;
}

interface Backend {
	load(key: string): Promise<Envelope | undefined>;
	save(key: string, envelope: Envelope): Promise<void>;
}

const PREFIX = "aether:store:";

const localBackend: Backend = {
	load(key) {
		try {
			const raw = localStorage.getItem(PREFIX + key);
			return Promise.resolve(raw ? JSON.parse(raw) as Envelope : undefined);
		} catch {
			return Promise.resolve(undefined);
		}
	},
	save(key, envelope) {
		try {
			localStorage.setItem(PREFIX + key, JSON.stringify(envelope));
		} catch (err) {
			console.warn(`aether: store "${key}" couldn't be persisted to localStorage:`, err);
		}
		return Promise.resolve();
	},
};

const DB_NAME = "aether-store";
const DB_STORE = "kv";
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
	return database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

const indexedBackend: Backend = {
	async load(key) {
		const db = await openDatabase();
		const store = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE);
		return await idbRequest(store.get(key)) as Envelope | undefined;
	},
	async save(key, envelope) {
		const db = await openDatabase();
		const store = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE);
		await idbRequest(store.put(envelope, key));
	},
};

function getBackend(persist: Persistence): Backend | undefined {
	if (!isBrowser || !persist) return undefined;
	if (persist === "indexeddb") {
		if (typeof indexedDB !== "undefined") return indexedBackend;
		if (typeof localStorage !== "undefined") return localBackend;
		return undefined;
	}
	return typeof localStorage !== "undefined" ? localBackend : undefined;
}

const stores = new Map<string, Store<any>>();

/**
 * a signal shared by key across islands, optionally persisted across reloads.
 *
 * define it once in a module and import that from every island that needs
 * it: the module fixes the type, the key keeps separate bundles on the same
 * value. the first call for a key wins; later calls return the same store
 *
 * @example
 * ```ts
 * export const dms = createStore<DMSummary[]>("dms", [], {
 *   persist: "indexeddb",
 *   version: 2,
 *   migrate: (old) => (old as LegacyDM[]).map(upgrade),
 * });
 *
 * dms()                 // read (tracked)
 * dms(next)             // write
 * dms.update((r) => [...r, hey])
 * await dms.ready       // persisted value loaded
 * ```
 */
export function createStore<T>(key: string, initial: T, options: StoreOptions<T> = {}): Store<T> {
	const existing = stores.get(key);
	if (existing) return existing;

	const version = options.version ?? 1;
	const backend = getBackend(options.persist ?? false);
	const state = signal<T>(initial) as Store<T>;

	let written = false;
	let applying = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposeWatcher: (() => void) | undefined;

	const save = () => {
		clearTimeout(timer);
		timer = undefined;
		backend?.save(key, { v: version, data: untracked(() => state()) }).catch((err) => {
			console.warn(`aether: store "${key}" couldn't be persisted:`, err);
		});
	};

	const watch = () => {
		const previous = setActiveSub(undefined);
		try {
			let first = true;
			disposeWatcher = effect(() => {
				state();
				if (first) return void (first = false);
				if (applying) return;
				written = true;
				clearTimeout(timer);
				timer = setTimeout(save, options.debounce ?? 50);
			});
		} finally {
			setActiveSub(previous);
		}
	};

	let ready: Promise<void>;
	if (!backend) {
		ready = Promise.resolve();
	} else {
		watch();
		ready = backend.load(key).then((stored) => {
			if (written) return save();
			if (stored === undefined) return;

			if (stored.v === version) {
				applying = true;
				state(stored.data as T);
				applying = false;
				return;
			}
			if (options.migrate) {
				applying = true;
				state(options.migrate(stored.data, stored.v));
				applying = false;
				return save();
			}
			console.warn(
				"aether:",
				`store "${key}" was persisted as version ${stored.v}, expected ${version}. discarding it; pass \`migrate\` to convert it instead`,
			);
		}, (err) => {
			console.warn("aether:", `store "${key}" couldn't be loaded:`, err);
		});
	}

	Object.defineProperty(state, "key", { value: key, enumerable: true });
	Object.defineProperty(state, "ready", { value: ready, enumerable: true });
	state.dispose = () => {
		disposeWatcher?.();
		clearTimeout(timer);
		stores.delete(key);
	};

	stores.set(key, state);
	return state;
}
