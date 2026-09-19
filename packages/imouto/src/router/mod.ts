/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * @module router
 * file-based routing layout composition, per-directory middleware, and error boundaries
 *
 * @example
 * ```
 *   routes/mod.tsx               /
 *   routes/about.tsx             /about
 *   routes/blog/[id].tsx         /blog/:id
 *   routes/blog/[...slug].tsx    /blog/*slug
 *   routes/_layout.tsx           layout wrapping all routes in this dir
 *   routes/_middleware.ts        middleware applied to all routes in this dir
 *   routes/_error.tsx            error boundary for this dir
 *   routes/_404.tsx              not-found page for root
 * ```
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { bold, cyan, dim } from "@std/fmt/colors";
import type { Router } from "@july/snarl";
import { httpMethods } from "@july/snarl";
import { scanDir } from "./scanner.ts";
import { registerRoute } from "./registry.ts";
import { collectDirAncestors, rateRouteSpecificity } from "./paths.ts";
import type { LayoutModule, RootRouteMetadata, ScanEntry, ScanOptions } from "./types.ts";
import { log } from "@july/snarl/verbosity";

function wireNotFound(router: Router, rootMeta: RootRouteMetadata | undefined): void {
	const NotFound = rootMeta?.notFound?.default;
	if (!NotFound) return;

	router.config.onNotFound = (ctx) => ctx.html(NotFound({ ctx }) as any, { status: 404 });
}

/**
 * scans a directory for route files and registers them on the given router.
 * routes are sorted by specificity so more specific paths take precedence
 *
 * @example
 * ```ts
 * const app = createRouter();
 * await scanRoutes(app, { dir: "./routes", from: import.meta.url });
 * ```
 */
export async function scanRoutes(
	router: Router,
	options: ScanOptions | string = "./routes",
): Promise<void> {
	const opts = typeof options === "string" ? { dir: options } : options;
	const base = opts.from
		? join(dirname(fromFileUrl(opts.from)), opts.dir)
		: join(Deno.cwd(), opts.dir);

	const entries: ScanEntry[] = [];
	const dirMetas = new Map<string, RootRouteMetadata>();

	log.raw(cyan(bold("\n  · scanning routes:")));
	const scanStart = performance.now();

	await scanDir(base, base, entries, dirMetas);
	entries.sort((a, b) => rateRouteSpecificity(b.path) - rateRouteSpecificity(a.path));
	wireNotFound(router, dirMetas.get(base));

	const registered = new Set<string>();
	if (entries.length) log.raw("");

	for (const { path, fsPath, module } of entries) {
		const ancestors = collectDirAncestors(fsPath, base, dirMetas);
		const layouts = ancestors.map((m) => m.layout).filter(Boolean) as LayoutModule[];
		const middlewares = ancestors.flatMap((m) => m.middlewares);
		const errorBoundary = ancestors.findLast((m) => m.errorBoundary)?.errorBoundary;

		for (const method of httpMethods) {
			const handler = module[method] ?? (method === "GET" ? module.default : undefined);
			if (handler) {
				registerRoute(
					router,
					method,
					path,
					handler,
					layouts,
					middlewares,
					errorBoundary,
					fsPath,
					base,
					registered,
				);
			}
		}
	}

	log.raw(
		dim(
			`\n  ${registered.size} routes registered in ${
				(performance.now() - scanStart).toFixed(2)
			}ms\n`,
		),
	);
}
