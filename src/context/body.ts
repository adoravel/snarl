/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * @module context/body
 */

import type { Context } from "./core.ts";
import { entriesToObject, type Infer, type Schema } from "../validate.ts";

/** a form field: text, or a file for multipart uploads. repeated names become arrays */
export type FormValue = string | File;
export type FormObject = Record<string, FormValue | FormValue[]>;

export interface BodyReader {
	/**
	 * returns the body as a string. Uses cached JSON if already
	 * parsed to avoid re-reading the consumed request stream
	 */
	plain(): Promise<string>;

	/** returns the body as parsed JSON, using the cache if present */
	json<S extends Schema<unknown>>(schema: S): Promise<Infer<S>>;
	json<T = any>(schema?: { parse: (val: unknown) => T } | ((val: unknown) => T)): Promise<T>;

	/**
	 * the body as a form (`application/x-www-form-urlencoded` or
	 * `multipart/form-data`) turned into a plain object.
	 */
	form(): Promise<FormObject>;
	form<S extends Schema<unknown>>(schema: S): Promise<Infer<S>>;
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
		form: async (schema?: Schema<unknown>) => {
			const cached = ctx.bodyCache;
			const data: FormObject = cached && typeof cached === "object" && !(cached instanceof FormData)
				? cached as FormObject
				: entriesToObject<FormValue>(
					(cached instanceof FormData ? cached : await ctx.request.formData()).entries(),
				);
			return (schema ? schema.parse(data) : data) as any;
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
