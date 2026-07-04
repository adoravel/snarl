/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Middleware } from "../context.ts";

/**
 * middleware that adds security headers to the response
 *
 * @example
 * ```ts
 * app.use(securityHeaders({ contentSecurityPolicy: "default-src 'self' 'unsafe-inline'" }));
 * ```
 */
export function securityHeaders(options: {
	contentSecurityPolicy?: string;
	strictTransportSecurity?: string;
	xContentTypeOptions?: "nosniff";
	referrerPolicy?: string;
	permissionsPolicy?: string;
	crossOriginOpenerPolicy?: string;
	crossOriginEmbedderPolicy?: string;
	crossOriginResourcePolicy?: string;
	cacheControl?: string;
} = {}): Middleware {
	const {
		contentSecurityPolicy = [
			"default-src 'self'",
			"base-uri 'self'",
			"object-src 'none'",
			"frame-ancestors 'self'",
			"form-action 'self'",
		].join("; "),
		strictTransportSecurity = "max-age=31536000; includeSubDomains",
		xContentTypeOptions = "nosniff",
		referrerPolicy = "strict-origin-when-cross-origin",
		permissionsPolicy = "camera=(), microphone=(), geolocation=()",
		crossOriginOpenerPolicy = "same-origin",
		crossOriginEmbedderPolicy = "require-corp",
		crossOriginResourcePolicy = "same-origin",
		cacheControl,
	} = options;

	return async (_, next) => {
		const response = await next();
		const headers = new Headers(response.headers);

		if (contentSecurityPolicy) headers.set("Content-Security-Policy", contentSecurityPolicy);
		if (strictTransportSecurity) headers.set("Strict-Transport-Security", strictTransportSecurity);
		if (xContentTypeOptions) headers.set("X-Content-Type-Options", xContentTypeOptions);
		if (referrerPolicy) headers.set("Referrer-Policy", referrerPolicy);
		if (permissionsPolicy) headers.set("Permissions-Policy", permissionsPolicy);
		if (crossOriginOpenerPolicy) headers.set("Cross-Origin-Opener-Policy", crossOriginOpenerPolicy);
		if (crossOriginEmbedderPolicy) headers.set("Cross-Origin-Embedder-Policy", crossOriginEmbedderPolicy);
		if (crossOriginResourcePolicy) headers.set("Cross-Origin-Resource-Policy", crossOriginResourcePolicy);
		if (cacheControl) headers.set("Cache-Control", cacheControl);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}
