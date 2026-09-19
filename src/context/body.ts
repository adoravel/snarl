/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * @module context/body
 */

import type { Context } from "./core.ts";
import type { Schema } from "../validate.ts";

export interface BodyReader {
	/**
	 * returns the body as a string. Uses cached JSON if already
	 * parsed to avoid re-reading the consumed request stream
	 */
	plain(): Promise<string>;

	/** returns the body as parsed JSON, using the cache if present */
	json<S extends Schema<unknown>>(schema: S): Promise<S extends Schema<infer T> ? T : never>;
	json<T = any>(schema?: { parse: (val: unknown) => T } | ((val: unknown) => T)): Promise<T>;
}

export function createBodyReader(ctx: Context<any>): BodyReader {
	return {
		plain: async () => {
			if (ctx.bodyCache) {
				return typeof ctx.bodyCache === "object" && ctx.bodyCache !== null
					? JSON.stringify(ctx.bodyCache)
					: String(ctx.bodyCache);
			}
			return await ctx.request.text();
		},
		json: async <T = any>(schema?: any) => {
			let data = ctx.bodyCache ?? await ctx.request.json();
			if (schema) {
				if (typeof schema === "function") {
					data = schema(data);
				} else if (typeof schema.parse === "function") {
					data = schema.parse(data);
				}
			}
			return data as T;
		},
	};
}
