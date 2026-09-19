/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Context, Method, Middleware } from "@july/snarl";

export type RouteHandler = (ctx: Context) => Response | Promise<Response> | unknown;
export type RouteModule = { default?: RouteHandler } & { [K in Method]?: RouteHandler };
export type LayoutModule = { default: (props: { children: unknown; ctx: Context }) => unknown };
export type MiddlewareModule = { default: Middleware | Middleware[] };
export type ErrorModule = { default: (props: { error: Error; ctx: Context }) => unknown };
export type NotFoundModule = { default: (props: { ctx: Context }) => unknown };

export interface ScanEntry {
	path: string;
	fsPath: string;
	module: RouteModule;
	depth: number;
}

export interface RootRouteMetadata {
	layout?: LayoutModule;
	middlewares: Middleware[];
	errorBoundary?: ErrorModule;
	notFound?: NotFoundModule;

	/** where each special module came from, for anyone who needs to bundle them */
	files: Partial<Record<"layout" | "error" | "404", string>>;
}

/** everything a scan found, before any of it is registered */
export interface RouteTable {
	/** absolute path of the routes directory */
	base: string;
	/** page/handler modules, most specific first */
	entries: ScanEntry[];
	/** per-directory special files, keyed by absolute directory path */
	metas: Map<string, RootRouteMetadata>;
}

export interface RegisterOptions {
	verbose?: boolean;

	/**
	 * transforms a page (a module's default export) before it's registered
	 * as a GET route. `layouts` are the ones that would wrap it, root first.
	 * return `null` to leave the page unregistered
	 */
	page?: (
		handler: RouteHandler,
		entry: ScanEntry,
		layouts: LayoutModule[],
	) => { handler: RouteHandler; layouts: LayoutModule[] } | null;
}

export interface ScanOptions {
	/** directory to scan for route files */
	dir: string;
	/** path resolution module url specification */
	from?: string;
	/** whether to log registered routes */
	verbose?: boolean;
}
