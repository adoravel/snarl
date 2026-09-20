/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { httpMethods, type Method } from "../types.ts";
import { extractPattern, type RouteMetadata } from "./route.ts";
import type { Router } from "./factory.ts";
import type { Handler } from "../context/mod.ts";
import { normalisePath } from "./paths.ts";

function joinPrefix(parentPrefix: string, childPrefix: string): string {
	if (!parentPrefix) return childPrefix;
	if (!childPrefix) return parentPrefix;
	return normalisePath(parentPrefix + childPrefix);
}

export function createPrefixedRouter(parent: Router, prefix: string): Router {
	const prefixed: Partial<Router> = {
		routes: parent.routes,
		middlewares: parent.middlewares,
		config: parent.config,
		middlewareOrder: parent.middlewareOrder,

		use(...mw) {
			parent.use(...mw);
			return prefixed as Router;
		},

		on(method, path, handler, metadata) {
			const base = extractPattern(path);
			const prefixedPath = joinPrefix(prefix, base);
			parent.on(method, prefixedPath as any, handler, metadata);
			return prefixed as Router;
		},

		all(path, handler, metadata) {
			for (const method of httpMethods) {
				prefixed.on!(method, path, handler, metadata);
			}
			return prefixed as Router;
		},

		group(subPrefix, configure) {
			const child = createPrefixedRouter(parent, joinPrefix(prefix, subPrefix));
			configure(child);
			return prefixed as Router;
		},

		fetch: parent.fetch,
		allRoutes: parent.allRoutes,
		serve: parent.serve,
	};

	httpMethods.forEach((method) => {
		const lower = method.toLowerCase() as Lowercase<Method>;
		(prefixed as any)[lower] = (path: string, handler: Handler<any>, metadata?: RouteMetadata) =>
			prefixed.on!(method, path, handler, metadata);
	});

	return prefixed as Router;
}
