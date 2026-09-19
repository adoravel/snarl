/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { boring } from "@404/imouto";
import { fromFileUrl } from "@std/path";
import type { IslandRegistry } from "./registry.ts";

import type { BuildOptions, Plugin } from "esbuild";
import { log } from "@july/snarl/verbosity";
import { serverOnlyGuard, type ServerOnlyGuardOptions } from "./guard.ts";

export interface AetherServeOptions extends ServerOnlyGuardOptions {
	/** in-memory cache for bundled islands. defaults to a shared `Map` */
	cache?: Map<string, string>;
	/** extra esbuild plugins merged after the aether resolver */
	plugins?: Plugin[];
	/** override the jsx runtime used for the client bundle */
	jsxImportSource?: string;

	esbuild?: Omit<BuildOptions, "stdin" | "bundle" | "write" | "plugins">;
}

class UnsupportedExportError extends Error {
	constructor(exportName: string, hint?: string) {
		super(
			`The export "${exportName}" is not supported in this environment` +
				(hint ? ` ~ ${hint}` : ""),
		);
		this.name = "UnsupportedExportError";
	}
}

const KNOWN_EXPORTS: Record<string, string | (() => never) | undefined> = {
	"@404/aether": "client/browser-mod.ts",
	"@404/aether/jsx-runtime": "client/jsx-runtime.ts",
	"@404/aether/jsx-dev-runtime": "client/jsx-runtime.ts",
	"@404/aether/client": "client/mod.ts",
	"@404/aether/client/jsx-runtime": "client/jsx-runtime.ts",
	"@404/aether/client/jsx-dev-runtime": "client/jsx-runtime.ts",
	"@404/aether/reactivity": "reactivity/mod.ts",
	"@404/aether/server": () => {
		throw new UnsupportedExportError(
			"@404/aether/server",
			"island registration and the esbuild-based bundler only run server-side",
		);
	},
	"@july/snarl": () => {
		throw new UnsupportedExportError(
			"@july/snarl",
			'use "@404/aether" or "@404/aether/client" instead',
		);
	},
	"@july/snarl/jsx-runtime": "client/jsx-runtime.ts",
	"@july/snarl/jsx-dev-runtime": "client/jsx-runtime.ts",
	"@404/imouto": () => {
		throw new UnsupportedExportError("@404/imouto");
	},
};

interface ResolvedSpecifier {
	path: string;
	namespace?: "https" | "http" | "file" | "jsr" | "npm";
}

export function resolveTargetUrl(relativeTarget: string): URL {
	const rootUrl = new URL("../", import.meta.url).href;
	return new URL(relativeTarget, rootUrl);
}

function normaliseSpecifier(targetUrl: URL): ResolvedSpecifier {
	const urlStr = targetUrl.href;

	const match = urlStr.match(/^(https|http|jsr|npm):/);
	if (match) {
		return {
			path: urlStr,
			namespace: match[1] as ResolvedSpecifier["namespace"],
		};
	}

	return {
		path: fromFileUrl(urlStr),
		namespace: "file",
	};
}

/** resolves `@404/aether/*` to real source paths so esbuild can bundle them */
function aetherResolver(): Plugin {
	return {
		name: "aether-resolver",
		setup(build) {
			build.onResolve({ filter: /^(?:@404\/aether|@404\/imouto|@july\/snarl)(\/|$)/ }, (args) => {
				if (!(args.path in KNOWN_EXPORTS)) return;

				const rel = KNOWN_EXPORTS[args.path];
				if (!rel) return { path: args.path, external: true };
				if (typeof rel === "function") {
					return rel();
				}

				try {
					const url = resolveTargetUrl(rel);
					const spec = normaliseSpecifier(url);

					return {
						path: spec.path,
						namespace: spec.namespace,
						external: false,
					};
				} catch (err) {
					log.warn(
						"aether/bundler",
						`couldn't resolve "${args.path}" to a real path, leaving external: ${err}`,
					);
					return { path: args.path, external: true };
				}
			});
		},
	};
}

export async function bundleIslands(
	names: readonly string[],
	registry: IslandRegistry,
	options: AetherServeOptions,
): Promise<string> {
	return await bundleEntry(buildEntrySource(names, registry), options);
}

/** bundles a generated entry module for the browser, with aether's resolver and guard */
export async function bundleEntry(source: string, options: AetherServeOptions): Promise<string> {
	const { default: esbuild } = await import("esbuild");
	const { denoPlugin } = await import("@deno/esbuild-plugin");

	const result = await esbuild.build({
		...options.esbuild,
		stdin: {
			contents: source,
			resolveDir: Deno.cwd(),
			loader: "ts",
			sourcefile: `aether-entry-${boring(source)}.ts`,
		},
		bundle: true,
		write: false,
		format: options.esbuild?.format ?? "esm",
		platform: options.esbuild?.platform ?? "browser",
		target: options.esbuild?.target ?? "es2022",
		jsx: options.esbuild?.jsx ?? "automatic",
		jsxImportSource: options.jsxImportSource ?? "@404/aether/client",
		plugins: [
			aetherResolver(),
			serverOnlyGuard({ serverOnly: options.serverOnly }),
			denoPlugin(),
			...(options.plugins ?? []),
		],
		minify: options.esbuild?.minify ?? Deno.env.get("ENV") === "production",
		treeShaking: options.esbuild?.treeShaking ?? true,
		logLevel: options.esbuild?.logLevel ?? "warning",
	});

	if (result.errors.length) {
		const lines = result.errors.map((e) =>
			e.location
				? `${e.text}\n    at ${e.location.file}:${e.location.line}:${e.location.column}`
				: e.text
		);
		throw new Error(`aether: bundle failed\n${lines.join("\n")}`);
	}
	return result.outputFiles![0].text;
}

function buildEntrySource(names: readonly string[], registry: IslandRegistry): string {
	const lines = [`import { registerIsland, hydrate } from "@404/aether/client";`];

	names.forEach((name, i) => {
		const specifier = registry.getModuleUrl(name);
		if (!specifier) throw new Error(`aether: no island registered under name "${name}"`);

		const exportName = registry.getExportName(name);

		const url = new URL(specifier);
		const path = url.protocol === "file:" ? fromFileUrl(url) : url.href;

		if (exportName === "default") {
			lines.push(`import island${i} from ${JSON.stringify(path)};`);
		} else {
			lines.push(`import { ${exportName} as island${i} } from ${JSON.stringify(path)};`);
		}
		lines.push(`registerIsland(${JSON.stringify(name)}, island${i});`);
	});

	lines.push(`hydrate();`);
	return lines.join("\n");
}

export function encodeEntryKey(names: Iterable<string>): string {
	return [...new Set(names)].sort().map(encodeURIComponent).join(",");
}

export function decodeEntryKey(key: string): string[] {
	return key.length === 0 ? [] : key.split(",").map(decodeURIComponent);
}
