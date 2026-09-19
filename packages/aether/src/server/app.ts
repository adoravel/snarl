/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import {
	type AppOptions,
	createApp as createImoutoApp,
	registerRouteTable,
	scanRouteTable,
} from "@404/imouto";
import { aether, type AetherOptions } from "./middleware.ts";
import { discoverAndRegisterIslands } from "./discover.ts";
import { IslandRegistry, type IslandRegistryOptions } from "./registry.ts";
import { buildSpaManifest, spa, spaNotFound, spaPageHook } from "./spa.ts";
import type { AetherServeOptions } from "./bundler.ts";

export interface AetherAppOptions extends AppOptions {
	/**
	 * `"islands"` (default): pages are server-rendered, interactive
	 * components are found by analysis and hydrated on their own.
	 *
	 * `"spa"`: the whole page under the root layout is one client app. every
	 * page and nested layout is bundled, routed in the browser over the
	 * history api, and shares a single reactive root; the root layout is
	 * the server-rendered shell around it
	 */
	mode?: "islands" | "spa";

	aether?: Omit<AetherOptions, "entrypoints" | "registry" | "islandHash" | "hmr"> & {
		entrypoints?: string[];
		islandHash?: IslandRegistryOptions["hash"];
		hmr?: boolean;
	};
}

const BUNDLER_PERMISSIONS = [
	{ descriptor: { name: "run", command: "esbuild" }, reason: "to bundle for the browser" },
	{
		descriptor: { name: "env", variable: "ESBUILD_BINARY_PATH" },
		reason: "to locate the esbuild binary",
	},
	{ descriptor: { name: "read" } as Deno.PermissionDescriptor, reason: "to read route modules" },
] as const;

async function createSpa(
	routesDir: string,
	serve: AetherServeOptions,
	rest: AppOptions,
): Promise<ReturnType<typeof createImoutoApp>> {
	// imouto would register the pages plainly; spa mode wraps them itself
	const app = await createImoutoApp({ ...rest, routesDir: "" });
	const table = await scanRouteTable(routesDir);
	registerRouteTable(app, table, { page: spaPageHook(table) });
	const notFound = spaNotFound(table);
	if (notFound) app.config.onNotFound = notFound;

	app.use({
		name: "aether",
		priority: 800,
		dependencies: ["context"],
		override: true,
		factory: () => spa({ ...serve, manifest: buildSpaManifest(table) }),
		permissions: BUNDLER_PERMISSIONS,
	});
	return app;
}

export async function createApp(
	options: AetherAppOptions = {},
): Promise<ReturnType<typeof createImoutoApp>> {
	const { aether: aetherOpts = {}, routesDir = "./routes", mode = "islands", ...rest } = options;

	if (mode === "spa") {
		const { entrypoints: _e, islandHash: _h, hmr: _m, ...serve } = aetherOpts;
		return createSpa(routesDir, serve, rest);
	}

	const registry = new IslandRegistry({
		hash: aetherOpts.islandHash,
		hmr: aetherOpts.hmr ?? (Deno.env.get("ENV") !== "production"),
	});

	const app = await createImoutoApp({ routesDir, ...rest });
	const entrypoints = aetherOpts.entrypoints ?? [routesDir];
	if (entrypoints) await discoverAndRegisterIslands(entrypoints, registry);

	app.use({
		name: "aether",
		priority: 800,
		dependencies: ["context"],
		override: true,
		factory: () =>
			aether({
				entrypoints: [],
				...aetherOpts,
				registry,
			}),
		permissions: BUNDLER_PERMISSIONS,
	});

	return app;
}
