/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @module app
 * pre‑configured router with common middleware
 */

import { createRouter, logger, Middleware, staticFiles } from "@july/snarl";
import { context, minify, scanRoutes } from "./mod.ts";
import { collectHeadContent, injectIntoHead } from "./head.ts";
import { injectScopedStylesheet, scopedCss } from "@404/varnish";
import { dim } from "@std/fmt/colors";

export interface AppOptions {
	staticDir?: string;
	routesDir?: string;
	env?: string;
	/** whether to serve static files with long‑term caching */
	immutableStatic?: boolean;
	maxAge?: number;
	/** whether to show route registration logs */
	verbose?: boolean;
}

export function transform(mini: ReturnType<typeof minify>): Middleware {
	return async (ctx, next) => {
		if (ctx.request.method !== "GET") return next();

		const response = await next();

		if (!response.body) return response;
		if (response.status === 204 || response.status === 304) return response;

		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/html")) return response;

		let html = await response.text();

		const head = collectHeadContent(ctx);
		if (head) {
			html = injectIntoHead(html, head.content && await head.content, head.attrs);
		}
		html = mini.perform(injectScopedStylesheet(ctx, html) ?? html, false);

		const headers = new Headers(response.headers);
		headers.delete("Content-Length");

		return new Response(html, { status: response.status, statusText: response.statusText, headers });
	};
}

export async function createApp(options: AppOptions = {}): Promise<ReturnType<typeof createRouter>> {
	const {
		staticDir = "./static",
		routesDir = "./src/routes",
		env = Deno.env.get("ENV") || "development",
		immutableStatic = false,
		verbose = env !== "production",
		maxAge = immutableStatic ? 60 * 60 * 24 * 365 : 60 * 60,
	} = options;

	const router = createRouter();
	router.config.onListen = ({ hostname, port }) => {
		console.log(dim(`  listening on http://${hostname}:${port}/`));
		console.log(dim(`  env: ${env}\n`));
	};

	router.use(
		context(),
		scopedCss(),
		staticFiles(staticDir, { maxAge, immutable: immutableStatic }),
		transform(minify()),
		logger(),
	);

	if (routesDir) await scanRoutes(router, { dir: routesDir, verbose });
	return router;
}
