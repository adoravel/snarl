/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Middleware } from "../context.ts";
import { getContentType } from "../mime.ts";
import { extname, join, relative, resolve } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { HttpError } from "../errors.ts";

function weakEtag(stat: Deno.FileInfo): string {
	const mtime = stat.mtime?.getTime() ?? 0;
	return `W/"${stat.size.toString(16)}-${mtime.toString(16)}"`;
}

function takeTransform(limit: number): TransformStream<Uint8Array, Uint8Array> {
	let remaining = limit;
	return new TransformStream({
		transform(chunk, controller) {
			if (remaining <= 0) {
				controller.terminate();
				return;
			}
			if (chunk.byteLength <= remaining) {
				controller.enqueue(chunk);
				remaining -= chunk.byteLength;
			} else {
				controller.enqueue(chunk.subarray(0, remaining));
				remaining = 0;
				controller.terminate();
			}
		},
	});
}

async function strongEtag(filepath: string): Promise<string> {
	const file = await Deno.readFile(filepath);
	const digest = await crypto.subtle.digest("SHA-256", file);
	return encodeHex(digest);
}

function parseRangeHeader(
	rangeHeader: string,
	fileSize: number,
	maxRangeLength: number,
): { start: number; end: number } | null {
	const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) return null;

	const start = parseInt(match[1], 10);
	const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

	if (isNaN(start) || isNaN(end) || start < 0 || end < 0 || start > end || start >= fileSize || end >= fileSize) {
		return null;
	}
	if ((end - start + 1) > maxRangeLength) return null;

	return { start, end };
}

/**
 * serves static files from a directory, streaming from disk rather than
 * buffering into memory.
 *
 * @example
 * ```js
 * app.use(staticFiles("public", { immutable: true, dotfiles: "deny" }));
 * app.use(staticFiles("uploads", { etag: "strong" })); // content hashing
 * ```
 */
export function staticFiles(root: string, options: {
	maxAge?: number;
	immutable?: boolean;
	index?: string;
	/**
	 * `"weak"` (default): `size+mtime` etag
	 * `"strong"`: SHA-256 content hash, disables streaming
	 * `false`: no etag
	 */
	etag?: boolean | "weak" | "strong";
	dotfiles?: "allow" | "ignore" | "deny";
	maxRangeLength?: number;
	strongEtagThreshold?: number;
} = {}): Middleware {
	const {
		maxAge = 3600,
		immutable = false,
		index = "index.html",
		etag: etagOption = "weak",
		dotfiles = "ignore",
		maxRangeLength = 128 * 1024 * 1024,
		strongEtagThreshold = 1024 * 1024,
	} = options;

	const etagMode = etagOption === false ? false : etagOption === true ? "weak" : etagOption;
	root = resolve(Deno.cwd(), root);

	return async (ctx, next) => {
		if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") {
			return next();
		}

		const decodedPath = decodeURIComponent(ctx.url.pathname);
		let filepath = resolve(root, decodedPath.slice(1));

		if (!filepath.startsWith(root)) return next();

		const relativePath = relative(root, filepath);
		if (relativePath !== "." && /(^|\/|\\)\./.test(relativePath)) {
			if (dotfiles === "deny") return new Response("Forbidden", { status: 403 });
			if (dotfiles === "ignore") return next();
		}

		let stat: Deno.FileInfo;
		try {
			stat = await Deno.stat(filepath);
			if (stat.isDirectory) {
				filepath = join(filepath, index);
				stat = await Deno.stat(filepath);
			}
		} catch {
			return next();
		}

		const ext = extname(filepath).toLowerCase();
		const headers = new Headers({
			"Content-Type": getContentType(ext) || "application/octet-stream",
		});

		if (etagMode) {
			let tag: string;
			if (etagMode === "strong" && stat.size <= strongEtagThreshold) {
				tag = await strongEtag(filepath);
			} else {
				if (etagMode === "strong" && stat.size > strongEtagThreshold) {
					console.warn("staticFiles", `file ${filepath} is too large for strong etag`);
				}
				tag = weakEtag(stat);
			}
			headers.set("ETag", tag);
			if (ctx.request.headers.get("If-None-Match") === tag) {
				return new Response(null, { status: 304, headers });
			}
		}

		const rangeHeader = ctx.request.headers.get("Range");
		if (rangeHeader) {
			const range = parseRangeHeader(rangeHeader, stat.size, maxRangeLength);

			if (!range) {
				headers.set("Content-Range", `bytes */${stat.size}`);
				throw new HttpError(416, "Range Not Satisfiable", headers);
			}

			const { start, end } = range;
			const chunkLen = end - start + 1;

			headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
			headers.set("Accept-Ranges", "bytes");
			headers.set("Content-Length", chunkLen.toString());

			let file: Deno.FsFile;
			try {
				file = await Deno.open(filepath, { read: true });
				await file.seek(start, Deno.SeekMode.Start);
			} catch {
				return next();
			}

			return new Response(file.readable.pipeThrough(takeTransform(chunkLen)), { status: 206, headers });
		}

		if (maxAge > 0 || immutable) {
			const directives = [`max-age=${maxAge}`];
			if (immutable) directives.push("immutable");
			headers.set("Cache-Control", directives.join(", "));
		}
		headers.set("Content-Length", stat.size.toString());

		let file: Deno.FsFile;
		try {
			file = await Deno.open(filepath, { read: true });
		} catch {
			return next();
		}

		return new Response(file.readable, { headers });
	};
}
