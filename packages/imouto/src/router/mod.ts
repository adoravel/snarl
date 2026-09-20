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
import type {
	LayoutModule,
	RegisterOptions,
	RootRouteMetadata,
	RouteTable,
	ScanEntry,
	ScanOptions,
} from "./types.ts";

export type * from "./types.ts";
import { log } from "@july/snarl/verbosity";

function wireNotFound(router: Router, rootMeta: RootRouteMetadata | undefined): void {
	const NotFound = rootMeta?.notFound?.default;
	if (!NotFound) return;

	router.config.onNotFound = (ctx) => ctx.html(NotFound({ ctx }) as any, { status: 404 });
}

/** scans a directory for route files and special files without registering anything */
export async function scanRouteTable(
	options: ScanOptions | string = "./routes",
): Promise<RouteTable> {
	const opts = typeof options === "string" ? { dir: options } : options;
	const base = opts.from
		? join(dirname(fromFileUrl(opts.from)), opts.dir)
		: join(Deno.cwd(), opts.dir);

	const entries: ScanEntry[] = [];
	const metas = new Map<string, RootRouteMetadata>();
	await scanDir(base, base, entries, metas);
	entries.sort((a, b) => rateRouteSpecificity(b.path) - rateRouteSpecificity(a.path));
	return { base, entries, metas };
}

/** registers a scanned table on the router */
export function registerRouteTable(
	router: Router,
	table: RouteTable,
	options: RegisterOptions = {},
): void {
	const { base, entries, metas } = table;
	const scanStart = performance.now();

	wireNotFound(router, metas.get(base));

	const registered = new Set<string>();
	if (entries.length) log.raw("");

	for (const entry of entries) {
		const { path, fsPath, module } = entry;
		const ancestors = collectDirAncestors(fsPath, base, metas);
		const layouts = ancestors.map((m) => m.layout).filter(Boolean) as LayoutModule[];
		const middlewares = ancestors.flatMap((m) => m.middlewares);
		const errorBoundary = ancestors.findLast((m) => m.errorBoundary)?.errorBoundary;

		for (const method of httpMethods) {
			let handler = module[method] ?? (method === "GET" ? module.default : undefined);
			let wrapping = layouts;
			if (handler && method === "GET" && !module.GET && options.page) {
				const page = options.page(handler, entry, layouts);
				if (!page) continue;
				({ handler, layouts: wrapping } = page);
			}
			if (handler) {
				registerRoute(
					router,
					method,
					path,
					handler,
					wrapping,
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
	log.raw(cyan(bold("\n  · scanning routes:")));
	registerRouteTable(router, await scanRouteTable(options));
}
