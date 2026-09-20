/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * @module app
 * pre‑configured router with common middleware
 */

import {
	createRouter,
	logger,
	LoggerOptions,
	Middleware,
	MiddlewareLike,
	MiddlewarePriority,
	staticFiles,
} from "@july/snarl";
import { scanRoutes } from "./mod.ts";
import { htmlInjection } from "./inject.ts";
import { dim } from "@std/fmt/colors";
import { log } from "@july/snarl/verbosity";
import { preflightPermissions } from "@july/snarl";

export interface AppOptions {
	staticDir?: string;
	routesDir?: string;
	env?: string;
	/** whether to serve static files with long‑term caching */
	immutableStatic?: boolean;
	maxAge?: number;
	/** whether to show route registration logs */
	verbose?: boolean;
	logger?: boolean | LoggerOptions | MiddlewareLike;
}

interface ResolvedAppOptions {
	staticDir: string;
	routesDir: string;
	immutableStatic: boolean;
	env: string;
	verbose: boolean;
	maxAge: number;
}

const DEFAULT_APP_OPTIONS: Required<Omit<AppOptions, "logger" | "env">> = {
	staticDir: "./static",
	routesDir: "./src/routes",
	immutableStatic: false,
	maxAge: 3600,
	verbose: true,
};

function resolveAppOptions(options: AppOptions): ResolvedAppOptions {
	const env = options.env ?? Deno.env.get("ENV") ?? "development";

	return {
		staticDir: options.staticDir ?? DEFAULT_APP_OPTIONS.staticDir,
		routesDir: options.routesDir ?? DEFAULT_APP_OPTIONS.routesDir,
		immutableStatic: options.immutableStatic ?? DEFAULT_APP_OPTIONS.immutableStatic,
		env,
		verbose: options.verbose ?? env !== "production",
		maxAge: options.maxAge ?? (options.immutableStatic ? 31536000 : DEFAULT_APP_OPTIONS.maxAge),
	};
}

export async function createApp(
	options: AppOptions = {},
): Promise<ReturnType<typeof createRouter>> {
	await preflightPermissions([
		{
			descriptor: { name: "env" },
			reason: "get dev/prod/esbuild required environment vars",
		},
		{ descriptor: { name: "read" }, reason: "read routes and static files" },
	], { strict: true });

	const { staticDir, routesDir, immutableStatic, env, verbose, maxAge } = resolveAppOptions(
		options,
	);

	const router = createRouter();
	router.config.onListen = ({ hostname, port }) => {
		log.raw(dim(`  listening on http://${hostname}:${port}/`));
		log.raw(dim(`  env: ${env}\n`));
	};

	router.use(
		"context",
		"scoped-css",
		"head",
		{
			name: "html-injection",
			priority: MiddlewarePriority.early,
			factory: () => htmlInjection(),
		},
		{
			name: "static-files",
			permissions: [{
				descriptor: { name: "read", path: staticDir },
				reason: `to serve static files from "${staticDir}"`,
			}],
			factory: () => staticFiles(staticDir, { maxAge, immutable: immutableStatic }),
		},
	);

	if (options.logger !== false) {
		let def: MiddlewareLike;
		if (options.logger === true || options.logger === undefined) {
			def = {
				name: "logger",
				priority: MiddlewarePriority.late,
				factory: () => logger(),
			};
		} else if (typeof options.logger === "string") {
			def = options.logger;
		} else if (typeof options.logger === "function") {
			def = {
				name: "logger",
				priority: MiddlewarePriority.late,
				factory: () => options.logger as Middleware,
			};
		} else if (typeof options.logger === "object" && "factory" in options.logger) {
			def = options.logger;
		} else {
			def = {
				name: "logger",
				priority: MiddlewarePriority.late,
				factory: () => logger(options.logger as LoggerOptions),
			};
		}
		router.use(def);
	}

	if (routesDir) {
		await scanRoutes(router, { dir: routesDir, verbose });
	}

	return router;
}
