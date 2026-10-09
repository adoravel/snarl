/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Context, Handler, Middleware } from "../context/mod.ts";
import { createMemoryStore, type Store } from "../store.ts";

/**
 * a storage backend for rate limiting data
 */
export interface RateLimitStore {
	/**
	 * atomically increments the request count for `key`, opening a fresh
	 * `windowMs`-long window if none is currently active for it, and
	 * returns the updated count alongside the window's reset time
	 */
	increment(key: string, windowMs: number): Promise<{ count: number; reset: number }>;

	cleanup: () => void;
}

/**
 * a `RateLimitStore` over any {@link Store}, so a limit can be counted in memory
 * or somewhere every process can see it.
 *
 * @example
 * ```ts
 * const shared = rateLimitStore(createFileStore("./.limits"));
 * app.use(rateLimit({ windowMs: 60_000, max: 100, store: shared }));
 * ```
 */
export function rateLimitStore(
	store: Store<string, { count: number; reset: number }>,
): RateLimitStore {
	return {
		async increment(key, windowMs) {
			const now = Date.now();
			const existing = await store.get(key);

			const entry = existing && now <= existing.reset
				? { count: existing.count + 1, reset: existing.reset }
				: { count: 1, reset: now + windowMs };

			await store.set(key, entry, { ttl: entry.reset - now });
			return entry;
		},
		cleanup: () => store.close(),
	};
}

/** the default store. counts in this process's memory */
export function createRateLimitStore(
	windowMs: number,
	maxSize = 10_000,
): RateLimitStore {
	return rateLimitStore(createMemoryStore({ ttl: windowMs, maxSize }));
}

/**
 * rate limiter middleware. returns an object with a `cleanup` method to
 * clear the internal timer of the default in-memory store.
 *
 * @example
 * ```ts
 * app.use(rateLimit({
 *   windowMs: 60_000,
 *   max: 100,
 *   keygen: (ctx) => ctx.headers.get("X-API-Key") || ctx.sender.remoteAddr.hostname,
 * }));
 * ```
 */
export function rateLimit(options: {
	windowMs: number;
	max: number;
	keygen?: (ctx: Context) => string;
	handler?: Handler<any>;
	store?: RateLimitStore;
}): Middleware & { cleanup: RateLimitStore["cleanup"] } {
	const {
		windowMs,
		max,
		keygen = (ctx) => ctx.sender.remoteAddr.hostname,
		handler,
		store = createRateLimitStore(windowMs),
	} = options;

	const middleware = (async (ctx, next) => {
		const key = keygen(ctx);
		const { count, reset } = await store.increment(key, windowMs);

		if (count > max) {
			const retryAfter = Math.ceil((reset - Date.now()) / 1000).toString();
			return await handler?.(ctx) ?? ctx.tooManyRequests(undefined, retryAfter);
		}
		return next();
	}) as ReturnType<typeof rateLimit>;

	if (store.cleanup) {
		middleware.cleanup = store.cleanup;
	}
	return middleware;
}
