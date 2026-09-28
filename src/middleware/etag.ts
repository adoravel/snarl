/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { encodeHex } from "@std/encoding/hex";
import type { Middleware } from "../context/middleware.ts";
import { MutableResponse } from "../context/middleware.ts";
import { provideMiddleware } from "./manager.ts";

export interface ETagOptions {
	/**
	 * emit the tag as weak (`W/"..."`). the hash covers the exact bytes,
	 * so the tag is strong by default.
	 */
	weak?: boolean;

	/** methods that get a tag. defaults to `["GET", "HEAD"]` */
	methods?: readonly string[];

	/** bodies larger than this many bytes are passed through untagged. defaults to 8 MiB */
	maxSize?: number;

	/** `Content-Type` prefixes eligible for a tag */
	taggableTypes?: readonly string[];
}

function opaque(tag: string): string {
	const unwrapped = tag.startsWith("W/") ? tag.slice(2) : tag;
	return unwrapped.trim();
}

function matches(ifNoneMatch: string, tag: string): boolean {
	if (ifNoneMatch.trim() === "*") return true;
	const wanted = opaque(tag);
	return ifNoneMatch.split(",").some((candidate) => opaque(candidate) === wanted);
}

/**
 * hashes a response body into an `ETag` and answers `304 Not Modified` when the
 * client already has that body.
 *
 * register it *inside* `compress()` (the default priority does this), so the tag
 * covers the body the handler produced rather than one particular encoding.
 *
 * @example
 * ```ts
 * app.use(compress());
 * app.use(etag());
 * ```
 */
export function etag(options: ETagOptions = {}): Middleware {
	const {
		weak = false,
		methods = ["GET", "HEAD"],
		maxSize = 8 * 1024 * 1024,
		taggableTypes = ["text/", "application/json", "application/xml", "image/svg+xml"],
	} = options;
	const allowed = new Set(methods.map((method) => method.toUpperCase()));

	return async (ctx, next) => {
		const state = await next();

		if (!allowed.has(ctx.request.method)) return state;
		if (state.status !== 200 || state.body == null) return state;
		if (state.headers.has("ETag")) return state;
		if (state.headers.get("Cache-Control")?.includes("no-store")) return state;

		const type = state.headers.get("Content-Type");
		if (!type || !taggableTypes.some((prefix) => type.startsWith(prefix))) return state;
		if (type.startsWith("text/event-stream")) return state;

		const declaredLength = Number(state.headers.get("Content-Length"));
		if (Number.isFinite(declaredLength) && declaredLength > maxSize) return state;

		const bytes = await state.bytes();
		if (bytes === null || bytes.byteLength > maxSize) return state;

		const digest = encodeHex(await crypto.subtle.digest("SHA-256", bytes));
		const tag = `${weak ? "W/" : ""}"${digest}"`;
		state.headers.set("ETag", tag);

		const ifNoneMatch = ctx.request.headers.get("If-None-Match");
		if (ifNoneMatch === null || !matches(ifNoneMatch, tag)) return state;

		const headers = new Headers(state.headers);
		headers.delete("Content-Length");
		headers.delete("Content-Type");

		return new MutableResponse(null, { status: 304, headers });
	};
}

provideMiddleware({ name: "etag", priority: 300, factory: () => etag() });
