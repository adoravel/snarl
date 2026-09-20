/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import {
	type Context,
	type Middleware,
	type MutableResponse,
	provideMiddleware,
} from "@july/snarl";
import {
	type AetherServeOptions,
	bundleIslands,
	decodeEntryKey,
	encodeEntryKey,
} from "./bundler.ts";
import { discoverAndRegisterIslands } from "./discover.ts";
import {
	getUsedIslands,
	IslandRegistry,
	type IslandRegistryOptions,
	setActiveIslandRegistry,
} from "./registry.ts";
import { log } from "@july/snarl/verbosity";
import { boring } from "@404/imouto";
import { injectIntoBody } from "@404/imouto";

const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";
const ENTRY_ROUTE_RE = /^\/_aether\/entry\/([A-Za-z0-9_,-]+)\.([0-9a-z]+)\.js$/;

export interface AetherOptions extends AetherServeOptions {
	entrypoints?: string[];
	/** shares island identity with a registry created elsewhere (e.g. by `createApp()`) */
	registry?: IslandRegistry;
	/** hash function for island ids. ignored if `registry` is supplied */
	islandHash?: IslandRegistryOptions["hash"];
	/** hot-swap islands in place on re-registration. ignored if `registry` is supplied.
	 *  defaults to `Deno.env.get("ENV") !== "production"` */
	hmr?: boolean;
}

class IslandBundleCache {
	readonly compiled: Map<string, string>;
	#hashByNameSet = new Map<string, string>();
	#pending = new Map<string, Promise<{ code: string; hash: string }>>();

	constructor(compiled: Map<string, string> = new Map()) {
		this.compiled = compiled;
	}

	resolve(
		names: readonly string[],
		registry: IslandRegistry,
		options: AetherServeOptions,
	): Promise<{ code: string; hash: string }> {
		const nameSetKey = names.join(",");

		const knownHash = this.#hashByNameSet.get(nameSetKey);
		if (knownHash) {
			const cached = this.compiled.get(knownHash);
			if (cached !== undefined) return Promise.resolve({ code: cached, hash: knownHash });
		}

		return this.#pending.getOrInsertComputed(nameSetKey, async () => {
			try {
				const code = await bundleIslands(names, registry, options);
				const hash = boring(code);
				this.compiled.set(hash, code);
				this.#hashByNameSet.set(nameSetKey, hash);
				this.#pending.delete(nameSetKey);
				return { code, hash };
			} catch (err) {
				this.#pending.delete(nameSetKey);
				throw err;
			}
		});
	}
}

async function injectIslandScript(
	response: MutableResponse,
	ctx: Context,
	registry: IslandRegistry,
	options: AetherOptions,
	bundles: IslandBundleCache,
): Promise<MutableResponse> {
	if (!response.body) return response;

	const contentType = response.headers.get("Content-Type") ?? "";
	if (!contentType.includes("text/html")) return response;

	const used = getUsedIslands(ctx);
	if (!used || used.size === 0) return response;

	const names = [...new Set(used)].sort();

	let hash: string;
	try {
		({ hash } = await bundles.resolve(names, registry, options));
	} catch (err) {
		log.error("aether", "failed to pre-bundle islands for script injection:", err);
		return response;
	}

	const src = `/_aether/entry/${encodeEntryKey(names)}.${hash}.js`;
	injectIntoBody(ctx, `<script type="module" src="${src}"></script>`);
	return response;
}

export function aether(options: AetherOptions = {}): Middleware {
	const registry = options.registry ?? new IslandRegistry({
		hash: options.islandHash,
		hmr: options.hmr ?? (Deno.env.get("ENV") !== "production"),
	});
	const bundles = new IslandBundleCache(options.cache);

	if (options.entrypoints) {
		discoverAndRegisterIslands(options.entrypoints, registry).catch(log.error);
	}

	return async (ctx, next) => {
		setActiveIslandRegistry(registry);
		const match = ctx.url.pathname.match(ENTRY_ROUTE_RE);

		if (ctx.url.pathname.startsWith("/_aether/entry/") && !match) {
			return new Response("// aether: malformed island entry URL", {
				status: 400,
				headers: { "Content-Type": "application/javascript; charset=utf-8" },
			});
		}

		if (match) {
			const [, encodedNames, requestedHash] = match;

			const cached = bundles.compiled.get(requestedHash);
			if (cached !== undefined) {
				return new Response(cached, {
					headers: {
						"Content-Type": "application/javascript; charset=utf-8",
						"Cache-Control": CACHE_CONTROL_IMMUTABLE,
					},
				});
			}

			let rebuilt: { code: string; hash: string };
			try {
				const names = decodeEntryKey(encodedNames);
				rebuilt = await bundles.resolve(names, registry, options);
			} catch (err) {
				log.error("aether", `failed to bundle entry "${encodedNames}":`, err);
				return new Response("Failed to bundle island entry", { status: 500 });
			}

			if (rebuilt.hash !== requestedHash) {
				return new Response("stale island bundle; reload the page", {
					status: 409,
					headers: { "Cache-Control": "no-store" },
				});
			}

			return new Response(rebuilt.code, {
				headers: {
					"Content-Type": "application/javascript; charset=utf-8",
					"Cache-Control": CACHE_CONTROL_IMMUTABLE,
				},
			});
		}

		const response = await next();
		return injectIslandScript(response, ctx, registry, options, bundles);
	};
}

provideMiddleware({
	name: "aether",
	priority: 800,
	dependencies: ["context"],
	factory: () => aether({ entrypoints: ["./routes"] }),
	permissions: [
		{ descriptor: { name: "run", command: "esbuild" }, reason: "to bundle island components" },
		{
			descriptor: { name: "env", variable: "ESBUILD_BINARY_PATH" },
			reason: "to locate the esbuild binary",
		},
		{
			descriptor: { name: "read" } as Deno.PermissionDescriptor,
			reason: `to discover islands`,
		},
	],
});
