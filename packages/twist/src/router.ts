/**
 * Copyright (c) 2026 kylia
 * SPDX-License-Identifier: Apache-2.0
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
 *   routes/blog/[...slug].tsx    /blog/*
 *   routes/_layout.tsx           layout wrapping all routes in this dir
 *   routes/_middleware.ts        middleware applied to all routes in this dir
 *   routes/_error.tsx            error boundary for this dir
 *   routes/_404.tsx              not-found page for root
 * ```
 */

import { compose, Context, type Handler, type Middleware, type Router } from "@july/snarl";
import { httpMethods, type Method } from "@july/snarl";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { blue, bold, cyan, dim, green, magenta, red, yellow } from "@std/fmt/colors";

type RouteHandler = (ctx: Context) => Response | Promise<Response> | unknown;

type RouteModule =
	& { default?: RouteHandler }
	& {
		[K in Method]?: RouteHandler;
	};

type LayoutModule = {
	default: (props: { children: unknown; ctx: Context }) => unknown;
};

type MiddlewareModule = {
	default: Middleware | Middleware[];
};

type ErrorModule = {
	default: (props: { error: Error; ctx: Context }) => unknown;
};

/** converts a filesystem path to a route path */
export function makeRoutePath(input: string): string {
	const path = input
		.replace(/\.tsx?$/, "")
		.replace(/(^|\/)mod$/, "")
		.replace(/\[\.\.\.(\w+)\]/g, ":$1*")
		.replace(/\[(\w+)\]/g, ":$1");

	return path === "" ? "/" : `/${path}`;
}

/**
 * priority score for route sorting. the higher the score, more specific
 * it is:
 *   static segment = 3
 *   :param         = 2
 *   :param?        = 1
 *   *wildcard      = 0
 */
function rateRouteSpecificity(path: string): number {
	return path.split("/").reduce((score, seg) => {
		if (!seg || seg === "*" || seg.endsWith("*")) return score;
		if (seg.endsWith("?")) return score + 1;
		if (seg.startsWith(":")) return score + 2;
		return score + 3;
	}, 0);
}

interface ScanEntry {
	path: string;
	fsPath: string;
	module: RouteModule;
	depth: number;
}

interface RootRouteMetadata {
	layout?: LayoutModule;
	middlewares: Middleware[];
	errorBoundary?: ErrorModule;
}

function methodColor(method: Method): typeof dim {
	switch (method) {
		case "GET":
			return green;
		case "POST":
			return yellow;
		case "PUT":
			return blue;
		case "PATCH":
			return magenta;
		case "DELETE":
			return red;
		case "HEAD":
			return dim;
		case "OPTIONS":
			return cyan;
		default:
			return dim;
	}
}

function formatRoute(method: Method, path: string): string {
	const color = methodColor(method);
	const padded = method.padEnd(7);
	return `${color(padded)} ${dim("→")} ${cyan(path)}`;
}

function formatRouteFile(path: string): string {
	return dim(`(${path})`);
}

async function scanDir(
	base: string,
	root: string,
	entries: ScanEntry[],
	metas: Map<string, RootRouteMetadata>,
	verbose: boolean,
) {
	const meta: RootRouteMetadata = { middlewares: [] };
	metas.set(root, meta);

	for await (const entry of Deno.readDir(root)) {
		const file = join(root, entry.name);

		if (entry.isDirectory) {
			await scanDir(base, file, entries, metas, verbose);
			continue;
		}

		if (!entry.name.match(/\.tsx?$/)) continue;

		const rel = relative(base, file);

		if (entry.name.startsWith("_")) {
			if (entry.name.match(/^_layout\.tsx?$/)) {
				meta.layout = await import(import.meta.resolve(file));
				continue;
			}
			if (entry.name.match(/^_middleware\.tsx?$/)) {
				const mod: MiddlewareModule = await import(import.meta.resolve(file));
				const mw = mod.default;
				meta.middlewares.push(...(Array.isArray(mw) ? mw : [mw]));
				continue;
			}
			if (entry.name.match(/^_error\.tsx?$/)) {
				meta.errorBoundary = await import(import.meta.resolve(file));
				continue;
			}
			continue; // skip unrelated shi
		}

		const importStart = performance.now();
		const module = await import(import.meta.resolve(file));
		const importTime = performance.now() - importStart;
		entries.push({
			path: makeRoutePath(rel),
			fsPath: file,
			module,
			depth: rel.split("/").length - 1,
		});
		if (verbose) {
			console.log(dim(`  ↓ imported ${rel} in ${importTime.toFixed(2)}ms`));
		}
	}
}

function collectDirAncestors(
	path: string,
	base: string,
	metas: Map<string, RootRouteMetadata>,
): RootRouteMetadata[] {
	const ancestors: RootRouteMetadata[] = [];
	let dir = dirname(path);

	while (dir.startsWith(base)) {
		const meta = metas.get(dir);
		if (meta) ancestors.unshift(meta);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return ancestors;
}

function wrapHandler(
	handler: RouteHandler,
	layouts: LayoutModule[],
	errorBoundary: ErrorModule | undefined,
): Handler<any> {
	return async (ctx: Context) => {
		try {
			let result = await handler(ctx);

			for (const layout of [...layouts].reverse()) {
				result = await layout.default({ children: result, ctx });
			}

			if (result instanceof Response) return result;

			const body = typeof result === "string" ? result : String(result ?? "");
			return ctx.html(body);
		} catch (err) {
			const result = await errorBoundary?.default({ error: err as Error, ctx });
			if (result) {
				const body = typeof result === "string" ? result : String(result ?? "");
				return ctx.html(body, { status: 500 });
			}
			throw err;
		}
	};
}

export interface ScanOptions {
	/** directory to scan for route files */
	dir: string;
	/** path resolution module url specification */
	from?: string;
	/** whether to log registered routes */
	verbose?: boolean;
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
	const base = opts.from ? join(dirname(fromFileUrl(opts.from)), opts.dir) : join(Deno.cwd(), opts.dir);
	const verbose = opts.verbose ?? Deno.env.get("ENV") !== "production";

	const entries: ScanEntry[] = [];
	const dirMetas = new Map<string, RootRouteMetadata>();

	if (verbose) {
		console.log(cyan(bold("\n  · scanning routes:")));
	}

	const scanStart = performance.now();
	await scanDir(base, base, entries, dirMetas, verbose);
	entries.sort((a, b) => rateRouteSpecificity(b.path) - rateRouteSpecificity(a.path));

	const registered = new Set<string>();
	if (verbose && entries.length) console.log("");

	for (const { path, fsPath, module } of entries) {
		const ancestors = collectDirAncestors(fsPath, base, dirMetas);

		const layouts: LayoutModule[] = ancestors
			.map((m) => m.layout)
			.filter(Boolean) as LayoutModule[];

		const middlewares: Middleware[] = ancestors.flatMap((m) => m.middlewares);
		const errorBoundary = [...ancestors].findLast((m) => m.errorBoundary)?.errorBoundary;

		for (const method of httpMethods) {
			const handler = module[method];
			if (!handler) continue;

			const routeStart = performance.now();
			const wrapped = wrapHandler(handler, layouts, errorBoundary);
			const final = middlewares.length ? compose(middlewares, wrapped) : wrapped;
			(router as any)[method.toLowerCase()](path, final);

			if (verbose && !registered.has(`${method}:${path}`)) {
				const routeTime = performance.now() - routeStart;
				registered.add(`${method}:${path}`);
				console.log(
					`    ${formatRoute(method, path)} ${formatRouteFile(relative(base, fsPath))} ${
						dim(`${routeTime.toFixed(2)}ms`)
					}`,
				);
			}
		}

		if (module.default && !module.GET) {
			const routeStart = performance.now();
			const wrapped = wrapHandler(module.default, layouts, errorBoundary);
			const final = middlewares.length ? compose(middlewares, wrapped) : wrapped;
			router.get(path, final);
			if (verbose && !registered.has(`GET:${path}`)) {
				const routeTime = performance.now() - routeStart;
				registered.add(`GET:${path}`);
				console.log(
					`    ${formatRoute("GET", path)} ${formatRouteFile(relative(base, fsPath))} ${
						dim(`${routeTime.toFixed(2)}ms`)
					}`,
				);
			}
		}
	}

	const scanTime = performance.now() - scanStart;
	if (verbose) console.log(dim(`\n  ${registered.size} routes registered in ${scanTime.toFixed(2)}ms\n`));
}

export {
	chain,
	compose,
	Context,
	createRouter,
	type Handler,
	type Middleware,
	type Router,
	stream,
	url,
} from "@july/snarl";
