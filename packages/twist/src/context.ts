/**
 * Copyright (c) 2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @module context
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Middleware } from "@july/snarl";

const storage = new AsyncLocalStorage<Context>();

/**
 * retrieves the current request context.

 * returns `undefined` if called outside of a request lifecycle
 * (e.g. at module load time or in a background task)
 */
export function getContext(): Context | undefined {
	return storage.getStore();
}

/**
 * retrieves the current request context, throwing if unavailable
 */
export function requireContext(
	message: string = "no active request context; are you outside a request handler?",
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
