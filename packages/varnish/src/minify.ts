/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Context, Middleware } from "@july/snarl";
import { minify as mini } from "@minify-html/deno";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface CacheEntry {
	bytes: Uint8Array;
	length: number;
}

class LRUCache {
	private map = new Map<string, CacheEntry>();
	private bytes = 0;

	constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

	get(key: string): Uint8Array | undefined {
		const entry = this.map.get(key);
		if (!entry) return undefined;

		this.map.delete(key);
		this.map.set(key, entry);

		return entry.bytes;
	}

	set(key: string, bytes: Uint8Array): void {
		const prev = this.map.get(key);
		if (prev) this.bytes -= prev.length;

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

function fnv1a64(bytes: Uint8Array): string {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;

	for (let i = 0; i < bytes.length; i++) {
		hash ^= BigInt(bytes[i]);
		hash = (hash * prime) & ((1n << 64n) - 1n);
	}
	return hash.toString(16);
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

function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length + c.length);
	out.set(a, 0);
	out.set(b, a.length);
	out.set(c, a.length + b.length);
	return out;
}

const PREFIX = encoder.encode("<style>");
const SUFFIX = encoder.encode("</style>");

function minifyCssFromBytes(src: Uint8Array): Uint8Array {
	const wrapped = concat3(PREFIX, src, SUFFIX);

	const data = mini(wrapped, {
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
	return src;
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
export default function minify(options: MinifyOptions = {}): Middleware & {
	perform(input: string, isCss: boolean): string;
	perform(input: Uint8Array, isCss: boolean): string;
} {
	const {
		html = true,
		css = true,
		maxCacheEntries = 128,
		maxCacheBytes = 8 * 1024 * 1024,
	} = options;

	const cache = new LRUCache(maxCacheEntries, maxCacheBytes);

	function key4Bytes(bytes: Uint8Array): string {
		return `${bytes.byteLength}:${fnv1a64(bytes)}`;
	}

	function perform(input: string | Uint8Array, isCss: boolean): string {
		const bytes = typeof input === "string" ? encoder.encode(input) : input;

		const key = key4Bytes(bytes);

		const cached = cache.get(key);
		if (cached) return decoder.decode(cached);

		let data: Uint8Array;
		if (isCss) {
			data = minifyCssFromBytes(bytes);
		} else {
			data = mini(bytes, {
				keep_spaces_between_attributes: false,
				keep_comments: true,
				minify_css: true,
				minify_js: true,
			}) as Uint8Array<ArrayBuffer>;
		}

		cache.set(key, data);
		return decoder.decode(data);
	}

	const middleware = (async (_ctx: Context, next: () => Promise<Response>) => {
		const response = await next();

		if (response.headers.has("Content-Encoding")) return response;

		const contentType = response.headers.get("Content-Type") ?? "";
		const isHtml = html && contentType.includes("text/html");
		const isCss = css && contentType.includes("text/css");
		if (!isHtml && !isCss) return response;

		const buf = await response.arrayBuffer();
		const bytes = new Uint8Array(buf);
		if (bytes.length === 0) return response;

		const minified = perform(bytes, isCss);

		const headers = new Headers(response.headers);
		headers.delete("Content-Length");

		return new Response(minified, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}) as ReturnType<typeof minify>;

	middleware.perform = perform;
	return middleware;
}
