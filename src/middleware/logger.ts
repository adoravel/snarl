/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Context, Middleware } from "../context.ts";
import { blue, dim, green, red, reset, yellow } from "@std/fmt/colors";

function statusColor(status: number): typeof reset {
	if (status >= 200 && status < 300) return green;
	if (status >= 300 && status < 400) return blue;
	if (status >= 400 && status < 500) return yellow;
	if (status >= 500) return red;
	return reset;
}

/** middleware that logs HTTP request details */
export function logger(options: {
	format?: (ctx: Context, ms: number, status: number) => string;
} = {}): Middleware {
	const { format } = options;

	return async (ctx, next) => {
		const start = performance.now();
		const response = await next();
		const elapsed = performance.now() - start;

		if (format) {
			console.log(format(ctx, elapsed, response.status));
		} else {
			const method = ctx.request.method;
			const path = ctx.url.pathname;
			const status = response.status;
			const color = statusColor(status);
			console.log(
				dim(`[${ctx.requestId}]`),
				color(`${method} ${path}`),
				`${status} ${elapsed.toFixed(2)}ms`,
			);
		}
		return response;
	};
}
