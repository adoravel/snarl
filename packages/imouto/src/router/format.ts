/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { blue, cyan, dim, green, magenta, red, yellow } from "@std/fmt/colors";
import type { Method } from "@july/snarl";

const METHOD_COLOURS: Record<Method, typeof dim> = {
	GET: green,
	POST: yellow,
	PUT: blue,
	PATCH: magenta,
	DELETE: red,
	HEAD: dim,
	OPTIONS: cyan,
};

const methodColour = (method: Method) => METHOD_COLOURS[method] ?? dim;

export function formatRoute(method: Method, path: string): string {
	const isLarge = method === "OPTIONS" || method === "DELETE";
	const padding = isLarge ? 7 : 5;
	const out = `${methodColour(method)(method.padEnd(padding))} ${dim("→")} ${cyan(path)}`;
	return `${isLarge ? "\n" : ""}${out}${isLarge ? "\n" : ""}`;
}

export const formatRouteFile = (path: string): string => dim(`(${path})`);
