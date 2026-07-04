/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { chain, Context, Middleware } from "@july/snarl";

/** hash -> compiled scoped CSS content, populated at module load time */
export const styleRegistry: Map<string, string> = new Map();

/** per-request set of style hashes marked as used, keyed by request Context */
export const contextualisedStyles: WeakMap<Context<any>, Set<string>> = new WeakMap();

/**
 * marks a style hash as used for the given request, so `styleScopeInjection()`
 * will emit a `<link>` for it
 */
export function markStyleUsed(ctx: Context<any>, hash: string): void {
	let set = contextualisedStyles.get(ctx);
	if (!set) contextualisedStyles.set(ctx, set = new Set());
	set.add(hash);
}

/**
 * serves compiled scoped stylesheets at `/css/<hash>.css` with long-lived
 * immutable caching, since the hash is content-derived
 *
 * register this before your route handlers.
 */
export function scopedCss(): Middleware {
	return (ctx: Context, next: () => Promise<Response>) => {
		const { pathname } = ctx.url;
		if (!pathname.startsWith("/_css/") || !pathname.endsWith(".css")) {
			return next();
		}

		const hash = pathname.slice("/_css/".length, -".css".length);
		const content = styleRegistry.get(hash);

		if (!content) return next();

		return new Response(content, {
			headers: {
				"Content-Type": "text/css; charset=utf-8",
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	};
}

/**
 * injects `<link rel="stylesheet">` tags for every scoped style marked
 * as used during this request (via `markStyleUsed`).
 *
 * register this after `scopedStyling()` and before your route handlers.
 */
export function styleScopeInjection(): Middleware {
	return async (ctx: Context, next: () => Promise<Response>) => {
		const res = await next();

		const used = contextualisedStyles.get(ctx);
		if (!used?.size) return res;

		const contentType = res.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/html")) return res;

		const html = await res.text();
		if (!html) return res;

		const links = [...used]
			.map((hash) => `<link rel="stylesheet" href="/_css/${hash}.css">`)
			.join("");

		const injected = html.includes("</head>") ? html.replace("</head>", `${links}</head>`) : links + html;

		const headers = new Headers(res.headers);
		headers.delete("Content-Length");

		return new Response(injected, {
			status: res.status,
			statusText: res.statusText,
			headers,
		});
	};
}

/**
 * convenience bundle of `scopedCss()` + `styleScopeInjection()`
 *
 * @example
 * ```js
 * app.use(scopedStyling());
 * // equivalent to:
 * app.use(scopedCss(), styleScopeInjection());
 * ```
 */
export function scopedStyling(): Middleware {
	return chain(scopedCss(), styleScopeInjection());
}
