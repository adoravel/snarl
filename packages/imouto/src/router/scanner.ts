/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { join, SEPARATOR, toFileUrl } from "@std/path";
import { dim } from "@std/fmt/colors";
import { applySpecialFile } from "./special-files.ts";
import { makeRoutePath } from "./paths.ts";
import type { RootRouteMetadata, ScanEntry } from "./types.ts";
import { log } from "@july/snarl/verbosity";

async function importRoute(base: string, file: string): Promise<ScanEntry | null> {
	const rel = file.slice(base.length + 1);
	const start = performance.now();

	try {
		const module = await import(toFileUrl(file).href);
		log.info("router", dim(`↓ imported ${rel} in ${(performance.now() - start).toFixed(2)}ms`));

		return {
			path: makeRoutePath(rel),
			fsPath: file,
			module,
			depth: rel.split(SEPARATOR).filter(Boolean).length - 1,
		};
	} catch (err) {
		log.error("router", `failed to import route ${dim(rel)}:`, err);
		return null;
	}
}

function isRouteFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".tsx");
}

function isSpecialFile(name: string): boolean {
	return name.startsWith("_") && isRouteFile(name);
}

async function collectFiles(currentDir: string): Promise<{
	routes: string[];
	special: string[];
	dirs: string[];
}> {
	const routes: string[] = [];
	const special: string[] = [];
	const dirs: string[] = [];

	try {
		for await (const entry of Deno.readDir(currentDir)) {
			if (entry.isFile) {
				const name = entry.name;
				if (isSpecialFile(name)) {
					special.push(join(currentDir, name));
				} else if (isRouteFile(name)) {
					routes.push(join(currentDir, name));
				}
			} else if (entry.isDirectory && !entry.name.startsWith("_")) {
				dirs.push(join(currentDir, entry.name));
			}
		}
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) {
			log.warn("imouto/router", `Skipping directory, path does not exist: ${dim(currentDir)}`);
		} else {
			throw err;
		}
	}

	return { routes, special, dirs };
}

async function processSpecialFiles(
	meta: RootRouteMetadata,
	specialFiles: string[],
): Promise<void> {
	await Promise.all(specialFiles.map((file) => applySpecialFile(meta, file)));
}

async function importRoutes(
	base: string,
	routeFiles: string[],
): Promise<ScanEntry[]> {
	const imported = await Promise.all(
		routeFiles.map((file) => importRoute(base, file)),
	);
	return imported.filter((r): r is ScanEntry => r !== null);
}

export async function scanDir(
	base: string,
	currentDir: string,
	entries: ScanEntry[],
	metas: Map<string, RootRouteMetadata>,
): Promise<void> {
	const meta: RootRouteMetadata = { middlewares: [], files: {} };
	metas.set(currentDir, meta);

	const { routes, special, dirs } = await collectFiles(currentDir);
	await processSpecialFiles(meta, special);

	const imports = await importRoutes(base, routes);
	entries.push(...imports);

	for (const dir of dirs) {
		await scanDir(base, dir, entries, metas);
	}
}
