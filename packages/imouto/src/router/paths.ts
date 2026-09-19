/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { dirname } from "@std/path";
import type { RootRouteMetadata } from "./types.ts";

/** converts a filesystem path to a route path */
export function makeRoutePath(input: string): string {
	const path = input
		.replace(/\\/g, "/")
		.replace(/\.tsx?$/, "")
		.replace(/(^|\/)mod$/, "")
		.replace(/\[\.\.\.(\w+)\]/g, "*$1")
		.replace(/\[(\w+)\]/g, ":$1");

	return path === "" ? "/" : `/${path}`;
}

/**
 * priority score for route sorting. the higher the score, more specific
 * it is:
 *   static segment = 3
 *   :param         = 2
 *   :param?        = 1
 *   *wildcard      = 0
 */
export function rateRouteSpecificity(path: string): number {
	return path.split("/").reduce((score, seg) => {
		if (!seg || seg.startsWith("*")) return score;
		if (seg.endsWith("?")) return score + 1;
		if (seg.startsWith(":")) return score + 2;
		return score + 3;
	}, 0);
}

export function collectDirAncestors(
	path: string,
	base: string,
	metas: Map<string, RootRouteMetadata>,
): RootRouteMetadata[] {
	const ancestors: RootRouteMetadata[] = [];

	let dir = dirname(path);

	const posixDir = dir.replace(/\\/g, "/");
	const posixBase = base.replace(/\\/g, "/");

	while (posixDir === posixBase || posixDir.startsWith(posixBase + "/")) {
		const meta = metas.get(dir);
		if (meta) ancestors.unshift(meta);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return ancestors;
}
