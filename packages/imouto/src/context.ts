/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Middleware, MiddlewarePriority, provideMiddleware } from "@july/snarl";

const storage = new AsyncLocalStorage<Context>();

/** retrieves the current request context */
export function getContext(): Context | undefined {
	return storage.getStore();
}

/** retrieves the current request context, throwing if unavailable */
export function requireContext(
	message: string = "no active request context; are you outside a request handler, mate?",
): Context {
	const ctx = storage.getStore();
	if (!ctx) throw new Error(message);
	return ctx;
}

/**
 * middleware that stores the request context in `AsyncLocalStorage`
 * for the duration of the request
 */
export function context(): Middleware {
	return (ctx, next) => storage.run(ctx, next);
}

provideMiddleware({
	name: "context",
	priority: MiddlewarePriority.first,
	factory: () => context(),
});
