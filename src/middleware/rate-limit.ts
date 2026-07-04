/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Context, Handler, Middleware } from "../context.ts";

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

	cleanup?: () => void;
}

/** in-memory implementation of `RateLimitStore` */
class MemoryStore implements RateLimitStore {
	private requests = new Map<string, { count: number; reset: number }>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private windowMs: number) {}

	increment(key: string, windowMs: number): Promise<{ count: number; reset: number }> {
		const now = Date.now();
		const existing = this.requests.get(key);

		const entry = existing && now <= existing.reset
			? { count: existing.count + 1, reset: existing.reset }
			: { count: 1, reset: now + windowMs };

		this.requests.set(key, entry);
		this.scheduleCleanup();
		return Promise.resolve(entry);
	}

	public cleanup(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private scheduleCleanup() {
		if (this.timer) return;

		this.timer = setTimeout(() => {
			const now = Date.now();
			let hasActiveKeys = false;

			for (const [key, data] of this.requests.entries()) {
				if (now > data.reset) {
					this.requests.delete(key);
				} else {
					hasActiveKeys = true;
				}
			}

			this.timer = null;
			if (hasActiveKeys) this.scheduleCleanup();
		}, this.windowMs);
	}
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
}): Middleware & RateLimitStore["cleanup"] {
	const {
		windowMs,
		max,
		keygen = (ctx) => ctx.sender.remoteAddr.hostname,
		handler,
		store = new MemoryStore(windowMs),
	} = options;

	const middleware = async (ctx: Context, next: () => Promise<Response>) => {
		const key = keygen(ctx);
		const { count, reset } = await store.increment(key, windowMs);

		if (count > max) {
			const retryAfter = Math.ceil((reset - Date.now()) / 1000).toString();
			return await handler?.(ctx) ?? ctx.tooManyRequests(undefined, retryAfter);
		}
		return next();
	};

	if (store.cleanup) {
		(middleware as any).cleanup = store.cleanup;
	}
	return middleware as ReturnType<typeof rateLimit>;
}
