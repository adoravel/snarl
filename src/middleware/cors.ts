/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Middleware } from "../context.ts";
import { httpMethods } from "../types.ts";

/**
 * Middleware to handle Cross-Origin Resource Sharing (CORS).
 * @example
 * ```ts
 * app.use(cors({ origin: "https://example.com", methods: ["GET", "POST"], credentials: true }));
 * ```
 */
export function cors(options: {
	origin?: string | string[];
	methods?: string[];
	headers?: string[];
	credentials?: boolean;
	maxAge?: number;
} = {}): Middleware {
	const {
		origin = "*",
		methods = httpMethods,
		headers: allowedHeaders = ["*"],
		credentials = false,
		maxAge,
	} = options;

	return async (ctx, next) => {
		const preflight = ctx.request.method === "OPTIONS";

		const response = preflight ? null : await next();
		const headers = preflight ? new Headers() : new Headers(response!.headers);

		const requestOrigin = ctx.request.headers.get("Origin");
		if (Array.isArray(origin)) {
			if (requestOrigin && origin.includes(requestOrigin)) {
				headers.set("Access-Control-Allow-Origin", requestOrigin);
			}
		} else {
			headers.set("Access-Control-Allow-Origin", origin);
		}

		headers.set("Access-Control-Allow-Methods", methods.join(", "));
		headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
		if (credentials) headers.set("Access-Control-Allow-Credentials", "true");

		if (preflight) {
			if (maxAge) headers.set("Access-Control-Max-Age", maxAge.toString());
			return new Response(null, { status: 204, headers });
		}
		return new Response(response!.body, {
			status: response!.status,
			statusText: response!.statusText,
			headers,
		});
	};
}
