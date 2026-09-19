/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Middleware } from "../context/middleware.ts";
import { provideMiddleware } from "./manager.ts";

type Encoding = "gzip" | "deflate";

export interface CompressOptions {
	/** encodings to offer, in preference order. defaults to `["gzip", "deflate"]` */
	encodings?: Encoding[];
	/**
	 * skip bodies smaller than this many bytes. only enforced when `Content-Length`
	 * is present and known
	 */
	threshold?: number;
	/** `Content-Type` prefixes eligible for compression */
	compressibleTypes?: string[];
}

function pickEncoding(acceptEncoding: string | null, allowed: Encoding[]): Encoding | null {
	if (!acceptEncoding) return null;

	for (const encoding of allowed) {
		if (acceptEncoding.startsWith(encoding)) return encoding;
	}
	return null;
}

/**
 * compresses eligible responses with gzip or deflate, based on the
 * request's `Accept-Encoding` header.
 *
 * register this *after* `minify()` if you use both.
 *
 * @example
 * ```ts
 * app.use(minify());
 * app.use(compress());
 * ```
 */
export function compress(options: CompressOptions = {}): Middleware {
	const {
		encodings = ["gzip", "deflate"],
		threshold = 1024,
		compressibleTypes = [
			"text/",
			"application/json",
			"application/javascript",
			"application/xml",
			"image/svg+xml",
		],
	} = options;

	return async (ctx, next) => {
		const state = await next();

		if (state.headers.has("Content-Encoding") || state.body == null) return state;

		const contentType = state.headers.get("Content-Type");
		if (!contentType || !compressibleTypes.some((t) => contentType.startsWith(t))) return state;

		if (contentType.startsWith("text/event-stream")) return state;
		if (state.headers.get("Cache-Control")?.includes("no-transform")) return state;

		const declaredLength = state.headers.get("Content-Length");
		if (declaredLength !== null) {
			const length = Number(declaredLength);
			if (Number.isFinite(length) && length < threshold) return state;
		} else {
			const bytes = await state.bytes();
			if (bytes !== null && bytes.byteLength < threshold) return state;
		}

		const encoding = pickEncoding(ctx.request.headers.get("Accept-Encoding"), encodings);
		if (!encoding) return state;

		const bodyStream = toReadableStream(state.body);
		if (!bodyStream) return state;

		state.body = bodyStream.pipeThrough(new CompressionStream(encoding));
		state.headers.set("Content-Encoding", encoding);
		state.headers.set(
			"Vary",
			state.headers.has("Vary")
				? `${state.headers.get("Vary")}, Accept-Encoding`
				: "Accept-Encoding",
		);
		state.headers.delete("Content-Length");

		return state;
	};
}

function toReadableStream(body: BodyInit): ReadableStream<Uint8Array<ArrayBuffer>> | null {
	if (body instanceof ReadableStream) return body;

	if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
		return new Response(body).body;
	}

	if (body instanceof Blob) return body.stream();
	return new Response(body as any).body;
}

provideMiddleware({ name: "compress", priority: 250, factory: () => compress() });
