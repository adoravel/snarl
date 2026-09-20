/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { dirname, join, relative, resolve, toFileUrl } from "@std/path";
import { analyseIslandSource, type AstNode, walk } from "./analyser.ts";
import type { IslandRegistry } from "./registry.ts";
import { walk as fsWalk } from "@std/fs";
import { bold, cyan, dim } from "@std/fmt/colors";
import { log } from "@july/snarl/verbosity";
import { extname } from "@std/path";
import { loadImportMap, resolveThroughImportMap } from "./import-map.ts";

const LOADER_MAP: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
	".ts": "ts",
	".tsx": "tsx",
	".js": "js",
	".jsx": "jsx",
	".mjs": "js",
	".cjs": "js",
};

const ANALYSIS_CACHE = new Map<string, Awaited<ReturnType<typeof analyseIslandSource>>>();

function extractImportSpecifiers(ast: AstNode): string[] {
	const specs: string[] = [];

	walk(ast, (node: AstNode) => {
		if (node.type === "ImportDeclaration" && typeof node.source?.value === "string") {
			specs.push(node.source.value);
		} else if (node.type === "ImportExpression" && typeof node.source?.value === "string") {
			specs.push(node.source.value);
		}
	});

	return specs;
}

function hasComponentExport(ast: AstNode): boolean {
	const isComponentName = (name?: string) => !!name && /^[A-Z]/.test(name);
	let found = false;

	walk(ast, (node: AstNode) => {
		if (found) return;
		if (node.type === "ExportDefaultDeclaration") {
			const d = node.declaration;
			if (
				d?.type === "FunctionDeclaration" ||
				d?.type === "ArrowFunctionExpression" ||
				d?.type === "FunctionExpression" ||
				d?.type === "Identifier" ||
				d?.type === "CallExpression"
			) {
				found = true;
			}
		}
		if (node.type === "ExportNamedDeclaration") {
			const d = node.declaration;
			if (d?.type === "FunctionDeclaration" && isComponentName(d.id?.name)) found = true;
			if (d?.type === "VariableDeclaration") {
				for (const decl of d.declarations ?? []) {
					if (decl.id?.type === "Identifier" && isComponentName(decl.id.name)) found = true;
				}
			}
			for (const s of node.specifiers ?? []) {
				if (s.type === "ExportSpecifier" && isComponentName(s.exported?.name)) found = true;
			}
		}
	});
	return found;
}

async function resolveImport(fromFile: string, spec: string): Promise<string | null> {
	let base: string;

	if (spec.startsWith("./") || spec.startsWith("../")) {
		base = resolve(dirname(fromFile), spec);
	} else {
		const map = await loadImportMap();
		const mapped = map ? resolveThroughImportMap(map, spec) : null;
		if (!mapped) return null;
		base = mapped;
	}

	const candidates = [
		base,
		`${base}.tsx`,
		`${base}.ts`,
		`${base}.jsx`,
		`${base}.js`,
		join(base, "mod.tsx"),
		join(base, "mod.ts"),
	];
	for (const candidate of candidates) {
		try {
			if ((await Deno.stat(candidate)).isFile) return candidate;
		} catch { /* no-op */ }
	}
	return null;
}

async function expandEntrypoints(entrypoints: string[]): Promise<string[]> {
	const files: string[] = [];
	for (const entry of entrypoints) {
		const resolved = resolve(entry);
		let stat: Deno.FileInfo;
		try {
			stat = await Deno.stat(resolved);
		} catch {
			log.warn("aether/discover", `skipped missing entrypoint: ${dim(resolved)}`);
			continue;
		}
		if (stat.isFile) {
			files.push(resolved);
		} else if (stat.isDirectory) {
			for await (
				const dirEntry of fsWalk(resolved, {
					includeDirs: false,
					followSymlinks: false,
					exts: [".ts", ".tsx"],
				})
			) {
				files.push(dirEntry.path);
			}
		}
	}
	return files;
}

/** walks the import graph, analyses components, and registers them automatically */
export async function discoverAndRegisterIslands(
	entrypoints: string[],
	registry: IslandRegistry,
): Promise<void> {
	const expandedFiles = await expandEntrypoints(entrypoints);

	if (expandedFiles.length === 0) {
		return;
	}

	log.info("aether/discover", cyan(bold("\n  · discovering islands:")));

	const seen = new Set<string>();
	const queue = [...expandedFiles];
	let registeredCount = 0;

	while (queue.length) {
		const path = resolve(queue.shift()!);
		if (seen.has(path)) continue;
		seen.add(path);

		let source: string, loader: typeof LOADER_MAP[keyof typeof LOADER_MAP];
		try {
			source = await Deno.readTextFile(path);
			loader = LOADER_MAP[extname(path).toLowerCase()] ?? "ts";
		} catch (err) {
			log.error("aether/discover", `failed to read: ${dim(path)} ${dim(String(err))}`);
			continue;
		}

		let analysis = ANALYSIS_CACHE.get(path);
		if (!analysis) {
			analysis = await analyseIslandSource(source, loader);
			ANALYSIS_CACHE.set(path, analysis);
		}

		if (analysis.isIsland && analysis.confidence === "high" && hasComponentExport(analysis.ast)) {
			const moduleUrl = toFileUrl(path).href;
			try {
				const mod = await import(moduleUrl);
				let registered = false;

				for (const [exportName, value] of Object.entries(mod)) {
					if (typeof value !== "function") continue;
					if (exportName !== "default" && !/^[A-Z]/.test(exportName)) continue;

					registry.register(value as () => string, moduleUrl, exportName);
					registered = true, registeredCount++;
				}

				if (registered) {
					const reason = analysis.reasons.join(", ");
					const file = relative(Deno.cwd(), path);
					log.info(
						"aether/discover",
						`↓ ${dim(file)} ${dim(`(${reason})`)}`,
					);
				}
			} catch (err) {
				log.error(
					"aether/discover",
					`failed to register: ${dim(path)} ${dim(String(err))}`,
				);
			}
		}

		for (const spec of extractImportSpecifiers(analysis.ast)) {
			const resolved = await resolveImport(path, spec);
			if (resolved && !seen.has(resolved)) queue.push(resolved);
		}
	}

	log.info(
		"aether",
		dim(`\n  ${registeredCount} island${registeredCount !== 1 ? "s" : ""} registered\n`),
	);
}
