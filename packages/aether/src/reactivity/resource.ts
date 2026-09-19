/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { effect } from "./effect.ts";
import { endBatch, startBatch, untracked } from "./engine.ts";
import { type Signal, signal } from "./signal.ts";
import { isBrowser } from "../env.ts";

function batch(fn: () => void): void {
	startBatch();
	try {
		fn();
	} finally {
		endBatch();
	}
}

export interface ResourceContext {
	/** aborted when the resource re-runs, is refetched or its scope is disposed */
	signal: AbortSignal;
	/** `true` when triggered by `refetch()` rather than a dependency change */
	refetching: boolean;
}

export type Fetcher<T, D> = (deps: D, ctx: ResourceContext) => T | Promise<T>;

export interface ResourceOptions<T> {
	/** what `data` holds before the first fetch settles */
	initialValue?: T;
}

export interface Resource<T> {
	/** the last successful value. kept while a newer fetch is in flight */
	data: Signal<T | undefined>;

	/** the last rejection. cleared when a fetch succeeds */
	error: Signal<unknown>;

	/** `true` from the moment a fetch starts until it settles */
	loading: Signal<boolean>;

	/** runs the fetcher again with the current dependencies, aborting any in-flight run */
	refetch(): Promise<T | undefined>;
}

export function resource<T, D>(
	deps: () => D,
	fetcher: Fetcher<T, D>,
	options?: ResourceOptions<T>,
): Resource<T>;
export function resource<T>(
	fetcher: Fetcher<T, undefined>,
	options?: ResourceOptions<T>,
): Resource<T>;
export function resource<T, D>(
	depsOrFetcher: (() => D) | Fetcher<T, D>,
	fetcherOrOptions?: Fetcher<T, D> | ResourceOptions<T>,
	maybeOptions?: ResourceOptions<T>,
): Resource<T> {
	const hasDeps = typeof fetcherOrOptions === "function";
	const deps = hasDeps ? depsOrFetcher as () => D : () => undefined as D;
	const fetcher = hasDeps ? fetcherOrOptions as Fetcher<T, D> : depsOrFetcher as Fetcher<T, D>;
	const options = (hasDeps ? maybeOptions : fetcherOrOptions as ResourceOptions<T>) ?? {};

	const data = signal<T | undefined>(options.initialValue);
	const error = signal<unknown>(undefined);
	const loading = signal(!isBrowser);

	let controller: AbortController | undefined;
	let run = 0;

	function load(current: D, refetching: boolean): Promise<T | undefined> {
		controller?.abort();
		const own = controller = new AbortController();
		const id = ++run;

		loading(true);
		let result: Promise<T>;
		try {
			result = Promise.resolve(fetcher(current, { signal: own.signal, refetching }));
		} catch (reason) {
			result = Promise.reject(reason);
		}
		return result
			.then((value) => {
				if (id !== run || own.signal.aborted) return undefined;
				batch(() => {
					data(value);
					error(undefined);
					loading(false);
				});
				return value;
			}, (reason) => {
				if (id !== run || own.signal.aborted) return undefined;
				batch(() => {
					error(reason);
					loading(false);
				});
				return undefined;
			});
	}

	if (isBrowser) {
		effect(() => {
			const current = deps();
			untracked(() => load(current, false));
			return () => {
				if (controller) controller.abort();
			};
		});
	}

	return {
		data,
		error,
		loading,
		refetch: () => isBrowser ? load(untracked(deps), true) : Promise.resolve(undefined),
	};
}
