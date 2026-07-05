/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @module app
 * pre‑configured router with common middleware
 */

import { createRouter, logger, staticFiles } from "@july/snarl";
import { context, head, minify, scanRoutes, scopedStyling } from "./mod.ts";
import { dim } from "@std/fmt/colors";

export interface AppOptions {
	staticDir?: string;
	routesDir?: string;
	env?: string;
	/** whether to serve static files with long‑term caching */
	immutableStatic?: boolean;
	maxAge?: number;
	/** whether to show route registration logs */
	verbose?: boolean;
}

export async function createApp(options: AppOptions = {}): Promise<ReturnType<typeof createRouter>> {
	const {
		staticDir = "./static",
		routesDir = "./src/routes",
		env = Deno.env.get("ENV") || "development",
		immutableStatic = false,
		verbose = env !== "production",
		maxAge = immutableStatic ? 60 * 60 * 24 * 365 : 60 * 60,
	} = options;

	const router = createRouter();
	router.config.onListen = ({ hostname, port }) => {
		console.log(dim(`  listening on http://${hostname}:${port}/`));
		console.log(dim(`  env: ${env}`));
		console.log("");
	};

	router.use(
		context(),
		head(),
		scopedStyling(),
		staticFiles(staticDir, { maxAge, immutable: immutableStatic }),
		minify(),
		logger(),
	);

	if (routesDir) await scanRoutes(router, { dir: routesDir, verbose });
	return router;
}
