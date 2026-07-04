/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Middleware } from "../context.ts";

type Encoding = "gzip" | "deflate";

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
export function compress(options: {
	/** encodings to offer, in preference order. defaults to `["gzip", "deflate"]` */
	encodings?: Encoding[];
	/** skip bodies smaller than this many bytes. defaults to `1024` */
	threshold?: number;
	/** `Content-Type` prefixes eligible for compression */
	compressibleTypes?: string[];
} = {}): Middleware {
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
		const response = await next();

		if (response.headers.has("Content-Encoding") || !response.body) return response;

		const contentType = response.headers.get("Content-Type") ?? "";
		if (!compressibleTypes.some(contentType.startsWith)) return response;

		const declaredLength = Number(response.headers.get("Content-Length"));
		if (Number.isFinite(declaredLength) && declaredLength < threshold) return response;

		const encoding = pickEncoding(ctx.request.headers.get("Accept-Encoding"), encodings);
		if (!encoding) return response;

		const headers = new Headers(response.headers);
		headers.set("Content-Encoding", encoding);
		headers.set("Vary", headers.has("Vary") ? `${headers.get("Vary")}, Accept-Encoding` : "Accept-Encoding");
		headers.delete("Content-Length");

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const abortHandler = () => {
			writer.close().catch(() => {});
		};
		ctx.request.signal.addEventListener("abort", abortHandler, { once: true });
		response.body.pipeTo(writable).finally(() => {
			ctx.request.signal.removeEventListener("abort", abortHandler);
		});

		const compressed = readable.pipeThrough(new CompressionStream(encoding));
		return new Response(compressed, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}
