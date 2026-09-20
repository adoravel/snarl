/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Router } from "@july/snarl";
import { log } from "@july/snarl/verbosity";
import { dim, green, yellow } from "@std/fmt/colors";
import { copy, ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { scanRouteTable } from "./router/mod.ts";
import type { RouteTable, ScanEntry } from "./router/types.ts";

export interface BuildOptions {
	/** where to write. emptied first unless `clean: false`. defaults to `./dist` */
	outDir?: string;
	/** the routes to enumerate. defaults to imouto's `./src/routes` */
	routesDir?: string;
	/** copied into `outDir` as-is. defaults to `./static`; `false` skips it */
	staticDir?: string | false;
	/** urls to render besides what the routes yield, e.g. `["/blog/hidden"]` */
	paths?: string[];
	/** also render same-origin pages the rendered pages link to */
	crawl?: boolean;
	/** the origin the pages are rendered under. only matters for absolute urls. defaults to `http://localhost` */
	origin?: string;
	/** empty `outDir` before writing. defaults to `true` */
	clean?: boolean;
	/** pages rendered at once. defaults to 8 */
	concurrency?: number;
}

export interface BuildResult {
	/** url paths that became pages, in the order they were written */
	pages: string[];
	/** url paths of the assets fetched through the app */
	assets: string[];
	/** what couldn't be built, and why */
	skipped: { path: string; reason: string }[];
}

/**
 * a route module with parameters says which urls to render:
 * `export const staticPaths = () => ["/blog/hello", "/blog/again"]`
 */
export type StaticPaths = string[] | (() => string[] | Promise<string[]>);

const ATTR_URL_RE = /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function buildRequest(origin: string, path: string): Request {
	return new Request(new URL(path, origin), { headers: { accept: "text/html,*/*" } });
}

const info = {
	remoteAddr: { hostname: "127.0.0.1", port: 0, transport: "tcp" },
} as Deno.ServeHandlerInfo<
	Deno.NetAddr
>;

function isDynamic(pattern: string): boolean {
	return /[:*?]/.test(pattern);
}

function getRouteOutputPath(path: string, html: boolean): string {
	const clean = path.replace(/^\/+|\/+$/g, "");
	if (!html) return clean;
	return clean ? `${clean}/index.html` : "index.html";
}

async function getPaths(entry: ScanEntry): Promise<string[] | null> {
	const module = entry.module as { staticPaths?: StaticPaths };

	if (!entry.module.default && !entry.module.GET) return null;
	if (!isDynamic(entry.path)) return [entry.path];

	const paths = typeof module.staticPaths === "function"
		? await module.staticPaths()
		: module.staticPaths;
	return paths ?? null;
}

function getReferencedPaths(html: string, origin: string): string[] {
	const out = new Set<string>();

	for (const match of html.matchAll(ATTR_URL_RE)) {
		const raw = match[1] ?? match[2];
		if (!raw || raw.startsWith("#") || /^(?:data|mailto|tel|javascript):/i.test(raw)) continue;
		let url: URL;
		try {
			url = new URL(raw, origin);
		} catch {
			continue;
		}
		if (url.origin !== origin) continue;
		out.add(url.pathname + url.search);
	}
	return [...out];
}

/**
 * renders every page the routes describe and writes the site to `outDir`
 */
export async function build(app: Router, options: BuildOptions = {}): Promise<BuildResult> {
	const outDir = options.outDir ?? "./dist";
	const origin = new URL(options.origin ?? "http://localhost").origin;
	const crawl = options.crawl ?? true;
	const concurrency = options.concurrency ?? 8;

	const table: RouteTable = await scanRouteTable(options.routesDir ?? "./src/routes");
	const result: BuildResult = { pages: [], assets: [], skipped: [] };
	const started = performance.now();

	if (options.clean ?? true) {
		await Deno.remove(outDir, { recursive: true }).catch(() => {});
	}
	await ensureDir(outDir);

	if (options.staticDir !== false) {
		const staticDir = options.staticDir ?? "./static";
		try {
			await copy(staticDir, outDir, { overwrite: true });
		} catch (err) {
			if (!(err instanceof Deno.errors.NotFound)) throw err;
		}
	}

	const queue: string[] = [...(options.paths ?? [])];
	for (const entry of table.entries) {
		const paths = await getPaths(entry);
		if (paths === null) {
			const reason = isDynamic(entry.path)
				? "has parameters and no `staticPaths` export"
				: "only exports handlers";
			result.skipped.push({ path: entry.path, reason });
			continue;
		}
		queue.push(...paths);
	}

	const known = new Set(queue);
	const seen = new Set<string>();

	const write = async (path: string, body: Uint8Array | string, html: boolean) => {
		const file = join(outDir, getRouteOutputPath(path.replace(/\?.*$/, ""), html));
		await ensureDir(dirname(file));
		await (typeof body === "string" ? Deno.writeTextFile(file, body) : Deno.writeFile(file, body));
	};

	async function render(path: string): Promise<void> {
		const response = await app.fetch(buildRequest(origin, path), info);
		const type = response.headers.get("content-type") ?? "";

		if (response.status >= 300) {
			if (known.has(path)) result.skipped.push({ path, reason: `responded ${response.status}` });
			await response.body?.cancel();
			return;
		}

		if (type.includes("text/html")) {
			const html = await response.text();
			await write(path, html, true);
			result.pages.push(path);
			log.info("build", `${green("✓")} ${path} ${dim(`→ ${getRouteOutputPath(path, true)}`)}`);

			for (const ref of getReferencedPaths(html, origin)) enqueue(ref);
			return;
		}

		await write(path, new Uint8Array(await response.arrayBuffer()), false);
		result.assets.push(path);
	}

	const pending: string[] = [];
	function enqueue(path: string): void {
		if (seen.has(path)) return;
		seen.add(path);
		pending.push(path);
	}

	async function visit(path: string): Promise<void> {
		if (!known.has(path) && !crawl) {
			const response = await app.fetch(buildRequest(origin, path), info);
			const type = response.headers.get("content-type") ?? "";

			if (response.ok && !type.includes("text/html")) {
				await write(path, new Uint8Array(await response.arrayBuffer()), false);
				result.assets.push(path);
			} else {
				await response.body?.cancel();
			}
			return;
		}
		await render(path);
	}

	for (const path of queue) enqueue(path);
	while (pending.length) {
		const batch = pending.splice(0, concurrency);
		await Promise.all(batch.map(visit));
	}

	const notFound = table.metas.get(table.base)?.notFound;
	if (notFound) {
		const response = await app.fetch(buildRequest(origin, "/__imouto_404__"), info);
		if (
			response.status === 404 && (response.headers.get("content-type") ?? "").includes("text/html")
		) {
			await write("/404.html", await response.text(), false);
			result.pages.push("/404.html");
		} else {
			await response.body?.cancel();
		}
	}

	for (const { path, reason } of result.skipped) {
		log.warn("build", `${yellow("↷")} ${path} ${dim(reason)}`);
	}
	log.info(
		"build",
		dim(
			`${result.pages.length} pages, ${result.assets.length} assets → ${outDir} in ${
				(performance.now() - started).toFixed(0)
			}ms`,
		),
	);

	return result;
}
