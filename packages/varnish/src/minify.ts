/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Context, Middleware } from "@july/snarl";
import { minify as mini } from "@minify-html/deno";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface CacheEntry {
	bytes: Uint8Array<ArrayBuffer>;
	length: number;
}

class LRUCache {
	private map = new Map<string, CacheEntry>();
	private bytes = 0;

	constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

	get(key: string): Uint8Array<ArrayBuffer> | undefined {
		const entry = this.map.get(key);
		if (!entry) return undefined;

		this.map.delete(key);
		this.map.set(key, entry);

		return entry.bytes;
	}

	set(key: string, bytes: Uint8Array<ArrayBuffer>): void {
		const prev = this.map.get(key);
		if (prev) {
			this.bytes -= prev.length;
		}

		const length = bytes.byteLength;
		this.map.set(key, { bytes, length });
		this.bytes += length;

		if (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
			const iterator = this.map.entries();

			while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
				const next = iterator.next();
				if (next.done) break;

				const [oldestKey, oldestEntry] = next.value;
				this.bytes -= oldestEntry.length;
				this.map.delete(oldestKey);
			}
		}
	}
}

export interface MinifyOptions {
	/** minify `text/html` responses. defaults to `true` */
	html?: boolean;
	/** minify `text/css` responses. defaults to `true` */
	css?: boolean;
	/** maximum number of distinct bodies to keep cached. defaults to `128` */
	maxCacheEntries?: number;
	/** maximum total cache size in bytes. defaults to `8 MiB` */
	maxCacheBytes?: number;
}

function minifyCss(src: string): Uint8Array<ArrayBuffer> {
	const wrapped = `<style>${src}</style>`;
	const data = mini(encoder.encode(wrapped), {
		keep_spaces_between_attributes: false,
		keep_comments: true,
		minify_css: true,
		minify_js: false,
	});

	const style = decoder.decode(data);
	if (style.startsWith("<style>") && style.endsWith("</style>")) {
		return encoder.encode(style.slice(7, -8));
	}

	console.warn("minify:", "unexpected minify-html output shape for standalone css");
	return encoder.encode(src);
}

/**
 * minifies `text/html` and `text/css` responses produced further down the
 * middleware chain. results are cached by raw body so repeated renders of
 * the same content (e.g. a static page) only pay the minification cost once.
 *
 * register this as close to the outside of the middleware stack as
 * possible, after anything that mutates `Content-Type` or streams the body
 *
 * @example
 * ```js
 * app.use(minify());
 * app.use(minify({ css: false, maxCacheEntries: 256 }));
 * ```
 */
export default function minify(options: MinifyOptions = {}): Middleware {
	const {
		html = true,
		css = true,
		maxCacheEntries = 128,
		maxCacheBytes = 8 * 1024 * 1024,
	} = options;

	const cache = new LRUCache(maxCacheEntries, maxCacheBytes);

	return async (_ctx: Context, next: () => Promise<Response>) => {
		const response = await next();

		if (response.headers.has("Content-Encoding")) return response;

		const contentType = response.headers.get("Content-Type") ?? "";
		const isHtml = html && contentType.includes("text/html");
		const isCss = css && contentType.includes("text/css");
		if (!isHtml && !isCss) return response;

		const buf = await response.arrayBuffer();
		const bytes = new Uint8Array(buf);
		if (bytes.length === 0) return response;

		const string = decoder.decode(bytes);
		let minified = cache.get(string);

		if (minified === undefined) {
			if (isCss) {
				minified = minifyCss(string);
			} else {
				minified = mini(bytes, {
					keep_spaces_between_attributes: false,
					keep_comments: true,
					minify_css: true,
					minify_js: true,
				}) as Uint8Array<ArrayBuffer>;
			}
			cache.set(string, minified);
		}

		const headers = new Headers(response.headers);
		headers.delete("Content-Length");

		return new Response(minified, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}
