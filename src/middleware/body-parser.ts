/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Middleware } from "../context.ts";

/**
 * middleware that parses `application/json` bodies into `ctx.bodyCache`
 * @example
 * ```ts
 * app.use(jsonParser());
 * app.post("/", async (ctx) => ctx.json(await ctx.body.json<{ name: string }>()));
 * ```
 */
export function jsonParser(): Middleware {
	return async (ctx, next) => {
		if (ctx.is("application/json")) {
			try {
				ctx.bodyCache = await ctx.body.json();
			} catch (_e) {
				return ctx.badRequest("Malformed JSON input");
			}
		}
		return next();
	};
}

/**
 * middleware that parses `application/x-www-form-urlencoded` bodies into
 * `ctx.bodyCache`
 * @example
 * ```ts
 * app.use(formParser());
 * app.post("/submit", async (ctx) => {
 *   const { email } = await ctx.body.json<{ email: string }>();
 * });
 * ```
 */
export function formParser(): Middleware {
	return async (ctx, next) => {
		if (ctx.is("application/x-www-form-urlencoded")) {
			try {
				const formData = await ctx.formData();
				const data: Record<string, string> = {};
				for (const [key, value] of formData.entries()) {
					data[key] = value.toString();
				}
				ctx.bodyCache = data;
			} catch (_) {
				return ctx.badRequest("Invalid form data");
			}
		}
		return next();
	};
}
