/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Context, Middleware, MutableResponse } from "@july/snarl";
import { injectIntoBody } from "@404/imouto";
import {
	boring,
	type LayoutModule,
	type RegisterOptions,
	type RootRouteMetadata,
	type RouteTable,
	type ScanEntry,
} from "@404/imouto";
import { jsx } from "@july/snarl/jsx-runtime";
import { log } from "@july/snarl/verbosity";
import { type AetherServeOptions, bundleEntry } from "./bundler.ts";
import { hydrationSlot } from "../control-flow.ts";

/** a page's client-side wiring: which module to import and which layouts wrap it */
export interface SpaBundleRoute {
	pattern: string;
	page: string;
	layouts: string[];
}

export interface SpaBundle {
	routes: SpaBundleRoute[];
	notFound?: string;
}

const SPA_ROUTE_RE = /^\/_aether\/spa\.([0-9a-z]+)\.js$/;
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

function ancestorsOf(table: RouteTable, entry: ScanEntry): RootRouteMetadata[] {
	const out: RootRouteMetadata[] = [];
	let dir = entry.fsPath.slice(0, entry.fsPath.lastIndexOf("/"));
	while (dir.startsWith(table.base)) {
		const meta = table.metas.get(dir);
		if (meta) out.unshift(meta);
		if (dir === table.base) break;
		dir = dir.slice(0, dir.lastIndexOf("/"));
	}
	return out;
}

/**
 * what the client needs to route: every page with a default export, its
 * pattern and the layouts under the root one. the root layout is the
 * server-rendered shell around `[data-x-spa]` and stays out of the bundle
 */
export function buildSpaManifest(table: RouteTable): SpaBundle {
	const root = table.metas.get(table.base);
	const routes: SpaBundleRoute[] = [];

	for (const entry of table.entries) {
		if (typeof entry.module.default !== "function") continue;
		const layouts = ancestorsOf(table, entry)
			.filter((meta) => meta !== root && meta.files.layout)
			.map((meta) => meta.files.layout!);
		routes.push({ pattern: entry.path, page: entry.fsPath, layouts });
	}

	return { routes, notFound: root?.files["404"] };
}

function buildSpaEntrySource(manifest: SpaBundle): string {
	const imports: string[] = [`import { mountSpa } from "@404/aether/client";`];
	const names = new Map<string, string>();
	const nameOf = (path: string) => {
		let name = names.get(path);
		if (!name) {
			name = `m${names.size}`;
			names.set(path, name);
			imports.push(`import ${name} from ${JSON.stringify(path)};`);
		}
		return name;
	};

	const routes = manifest.routes.map((route) =>
		`{ pattern: ${JSON.stringify(route.pattern)}, page: ${nameOf(route.page)}, layouts: [${
			route.layouts.map(nameOf).join(", ")
		}] }`
	);
	const notFound = manifest.notFound ? nameOf(manifest.notFound) : "undefined";

	return [
		...imports,
		`mountSpa({ routes: [${routes.join(", ")}], notFound: ${notFound} });`,
	].join("\n");
}

/**
 * the `page` hook for `registerRouteTable` in spa mode: pages and nested
 * layouts render inside `<div data-x-spa>` with isomorphic props, the root
 * layout wraps that as the shell
 */
export function spaPageHook(table: RouteTable): NonNullable<RegisterOptions["page"]> {
	const root = table.metas.get(table.base)?.layout;

	return (page, _entry, layouts) => {
		const shell = layouts[0] === root ? [layouts[0]] : [];
		const nested = layouts.slice(shell.length);

		const handler = async (ctx: Context) => {
			const props = { params: ctx.params, url: ctx.url, ctx };
			let node = await (page as (props: unknown) => unknown)(props);
			if (node instanceof Response) return node;
			for (const layout of nested.toReversed()) {
				node = await (layout as LayoutModule).default({
					...props,
					children: hydrationSlot(node as any),
				});
				if (node instanceof Response) return node;
			}
			return jsx("div", { "data-x-spa": "", children: node as any });
		};
		return { handler, layouts: shell };
	};
}

/**
 * `_404.tsx` in spa mode: rendered like a page (isomorphic props, inside the
 * shell and `[data-x-spa]`) so the client can take over from it too
 */
export function spaNotFound(table: RouteTable): ((ctx: Context) => Promise<Response>) | undefined {
	const root = table.metas.get(table.base);
	const NotFound = root?.notFound?.default as ((props: unknown) => unknown) | undefined;
	if (!NotFound) return undefined;

	return async (ctx) => {
		const props = { params: {}, url: ctx.url, ctx };
		let node: unknown = jsx("div", { "data-x-spa": "", children: NotFound(props) as any });
		if (root?.layout) node = await root.layout.default({ children: node, ctx });
		if (node instanceof Response) return node;
		return await ctx.html(node as any, { status: 404 });
	};
}

export interface SpaOptions extends AetherServeOptions {
	manifest: SpaBundle;
}

/**
 * serves the spa bundle and puts its `<script>` on every html page. the
 * bundle is built on first use and keyed by content hash
 */
export function spa(options: SpaOptions): Middleware {
	let building: Promise<{ code: string; hash: string }> | undefined;
	const compiled = options.cache ?? new Map<string, string>();

	const resolve = () =>
		building ??= (async () => {
			try {
				const code = await bundleEntry(buildSpaEntrySource(options.manifest), options);
				const hash = boring(code);
				compiled.set(hash, code);
				return { code, hash };
			} catch (err) {
				building = undefined;
				throw err;
			}
		})();

	return async (ctx, next) => {
		const match = ctx.url.pathname.match(SPA_ROUTE_RE);
		if (match) {
			const cached = compiled.get(match[1]);
			if (cached === undefined) {
				return new Response("stale app bundle; reload the page", {
					status: 409,
					headers: { "Cache-Control": "no-store" },
				});
			}
			return new Response(cached, {
				headers: {
					"Content-Type": "application/javascript; charset=utf-8",
					"Cache-Control": CACHE_CONTROL_IMMUTABLE,
				},
			});
		}

		const response = await next() as MutableResponse;
		if (!response.body) return response;
		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/html")) return response;

		try {
			const { hash } = await resolve();
			injectIntoBody(ctx, `<script type="module" src="/_aether/spa.${hash}.js"></script>`);
		} catch (err) {
			log.error("aether", "failed to bundle the spa:", err);
		}
		return response;
	};
}
