/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

/**
 * @module middleware
 * Provides the `Context` interface, request handling, and built-in middleware.
 */

import { CookieJar } from "./cookie.ts";
import {
	BadRequestError,
	ForbiddenError,
	HttpError,
	httpMethods,
	InternalServerError,
	NotFoundError,
	TooManyRequestsError,
	UnauthorizedError,
} from "./utils.ts";
import { extname, join, resolve } from "@std/path";
import { encodeHex } from "@std/encoding/hex";

/**
 * Represents a file uploaded via `multipart/form-data`.
 */
export interface UploadedFile {
	/** The field name in the form. */
	name: string;
	/** The filename provided by the client. */
	filename: string;
	/** The MIME type provided by the client. */
	type: string;
	/** The size of the file in bytes. */
	size: number;
	/** The raw file content. */
	content: Uint8Array;
}

/**
 * The Context object represents a single HTTP request/response lifecycle.
 * It holds request data, response helpers, and middleware state.
 */
export interface Context<Params = Record<string, string>> {
	/** The incoming Request object. */
	readonly request: Request;
	/** Deno's connection info (remote address). */
	readonly sender: Deno.ServeHandlerInfo<Deno.NetAddr>;
	/** Parameters extracted from the URL path (e.g., `:id`). */
	readonly params: Params;
	/** The parsed URL. */
	readonly url: URL;
	/** A helper to manage cookies (request and response). */
	readonly cookies: CookieJar;
	/** A unique identifier for this request. */
	readonly requestId: string;

	/** The URL search params object. */
	readonly query: URLSearchParams;
	/** Headers for the outgoing response. */
	readonly headers: Headers;

	/** Gets a specific outgoing header value. */
	get(name: string): string | null;
	/** Sets an outgoing header value. */
	set(name: string, value: string): void;

	/** Internal cache for body parsing. Used by `ctx.body` methods. */
	bodyCache: unknown;
	/** Shared state map for middleware. */
	state: Map<string | symbol, unknown>;

	/**
	 * Sends a JSON response.
	 * @param data - The object to serialize.
	 * @param init - Optional ResponseInit (status, headers).
	 */
	json<T>(data: T, init?: ResponseInit): Response;
	/**
	 * Sends an HTML response.
	 * @param content - The HTML string.
	 * @param init - Optional ResponseInit.
	 */
	html(content: string, init?: ResponseInit): Response;
	/**
	 * Sends a plain text response.
	 * @param content - The text string.
	 * @param init - Optional ResponseInit.
	 */
	text(content: string, init?: ResponseInit): Response;
	/**
	 * Redirects to a different URL.
	 * @param url - The URL to redirect to.
	 * @param status - The HTTP status code (defaults to 302).
	 */
	redirect(url: string, status?: number): Response;

	/** Throws a 404 Not Found error. */
	notFound(message?: string): never;
	/** Throws a 400 Bad Request error. */
	badRequest(message?: string): never;
	/** Throws a 429 Too Many Requests error. */
	tooManyRequests(message?: string, retryAfter?: string): never;
	/** Throws a 401 Unauthorized error. */
	unauthorized(message?: string): never;
	/** Throws a 403 Forbidden error. */
	forbidden(message?: string): never;
	/** Throws a 500 Internal Server Error. */
	internalError(message?: string): never;

	/** Sends a 201 Created JSON response. */
	created<T>(data: T, init?: ResponseInit): Response;
	/** Sends a 204 No Content response. */
	noContent(): Response;

	/**
	 * Sends a file from the filesystem.
	 * Uses `getContentType` to detect MIME type automatically.
	 * @param path - The relative or absolute path to the file.
	 * @param init - Optional ResponseInit.
	 */
	send(path: string, init?: ResponseInit): Promise<Response>;

	/** Methods for accessing the request body. */
	body: {
		/**
		 * Returns the body as a string.
		 * If the body was previously parsed as JSON, it returns `JSON.stringify` of the cache.
		 */
		plain(): Promise<string>;
		/**
		 * Returns the body as a parsed JSON object.
		 * Uses native `request.json()` for efficiency.
		 */
		json<T = any>(): Promise<T>;
	};

	/** Returns the body as a `FormData` object. */
	formData(): Promise<FormData>;

	/**
	 * Parses the body as `multipart/form-data`.
	 * @returns Fields and files extracted from the request.
	 */
	multipart(): Promise<{
		fields: Record<string, string>;
		files: Record<string, UploadedFile>;
	}>;
}

/**
 * A route handler function.
 * @template C - The type of route parameters.
 */
export interface Handler<C> {
	(ctx: Context<C>): Response | Promise<Response> | void | Promise<void>;
}

/**
 * A middleware function.
 * Middleware can modify the Context or modify the Response.
 */
export interface Middleware {
	(ctx: Context, next: () => Promise<Response>): Response | Promise<Response>;
}

/**
 * An error handler function for top-level error catching.
 */
export interface ErrorHandler {
	(error: Error, ctx: Context): Response | Promise<Response>;
}

/**
 * Composes an array of middleware functions with a final handler.
 */
export function compose(middlewares: Middleware[], handler: Handler<any>): Handler<any> {
	if (!middlewares.length) return handler;

	return (ctx) => {
		let i = 0;
		const dispatch = async (): Promise<Response> => {
			if (i < middlewares.length) {
				const mw = middlewares[i++];
				return await mw(ctx, dispatch);
			}
			const result = await handler(ctx);
			return result || new Response("", { status: 200 });
		};
		return dispatch();
	};
}

function response(
	data: BodyInit | null,
	contentType: string | null,
	cookies: CookieJar,
	arbitraryHeaders: Headers,
	init?: ResponseInit,
): Response {
	const headers = new Headers(init?.headers);
	if (contentType) headers.set("Content-Type", contentType);

	arbitraryHeaders.forEach((value, key) => headers.set(key, value));

	for (const setCookie of cookies.headers) {
		headers.append("Set-Cookie", setCookie);
	}

	return new Response(data, {
		...init,
		headers,
	});
}

function getContentType(ext: string): string | undefined {
	const contentTypes: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".js": "application/javascript; charset=utf-8",
		".mjs": "application/javascript; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".txt": "text/plain; charset=utf-8",
		".xml": "application/xml",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".svg": "image/svg+xml",
		".ico": "image/x-icon",
		".woff": "font/woff",
		".woff2": "font/woff2",
		".ttf": "font/ttf",
		".webp": "image/webp",
		".webm": "video/webm",
		".mp4": "video/mp4",
	};
	return contentTypes[ext];
}

/**
 * Creates a new Context object.
 */
export function createContext<P>(
	request: Request,
	sender: Deno.ServeHandlerInfo<Deno.NetAddr>,
	params: P,
	requestId?: string,
): Context<P> {
	const url = new URL(request.url);
	const cookies = new CookieJar(request.headers.get("Cookie"));
	const headers = new Headers();

	const context: Context<P> = {
		request,
		sender,
		params,
		url,
		state: new Map(),
		requestId: requestId || crypto.randomUUID(),
		cookies,
		bodyCache: undefined,
		query: url.searchParams,
		headers,
		get(name: string): string | null {
			return headers.get(name);
		},
		set(name: string, value: string): void {
			headers.set(name, value);
		},
		json(data, init) {
			return response(JSON.stringify(data), "application/json", cookies, headers, init);
		},
		html(content, init) {
			return response(content, "text/html; charset=utf-8", cookies, headers, init);
		},
		text(content, init) {
			return response(content, "text/plain; charset=utf-8", cookies, headers, init);
		},
		redirect(url, status = 302) {
			return response(null, null, cookies, headers, { status, headers: { Location: url } });
		},
		async send(path, init) {
			try {
				const safePath = resolve(Deno.cwd(), path);

				const stat = await Deno.stat(safePath);
				if (stat.isDirectory) throw new HttpError(400, "Cannot send directory");

				const file = await Deno.readFile(safePath);
				const ext = extname(safePath).toLowerCase();

				const resHeaders = new Headers(init?.headers);
				resHeaders.set("Content-Type", getContentType(ext) || "application/octet-stream");
				headers.forEach((v, k) => resHeaders.set(k, v));

				return new Response(file, { ...init, headers: resHeaders });
			} catch (e) {
				if (e instanceof HttpError) throw e;
				throw new HttpError(404, "File not found");
			}
		},
		notFound(message = "Not Found"): never {
			throw new NotFoundError(message);
		},
		badRequest(message = "Bad Request"): never {
			throw new BadRequestError(message);
		},
		unauthorized(message = "Unauthorized"): never {
			throw new UnauthorizedError(message);
		},
		forbidden(message = "Forbidden"): never {
			throw new ForbiddenError(message);
		},
		internalError(message = "Internal Server Error"): never {
			throw new InternalServerError(message);
		},
		tooManyRequests(message = "Too Many Requests Error", retryAfter?: string): never {
			throw new TooManyRequestsError(message, retryAfter);
		},
		created(data, init) {
			return response(JSON.stringify(data), "application/json", cookies, headers, { ...init, status: 201 });
		},
		noContent() {
			return response(null, null, cookies, headers, { status: 204 });
		},

		body: {
			async plain() {
				return context.bodyCache ? JSON.stringify(context.bodyCache) : await request.text();
			},
			async json() {
				return context.bodyCache ?? await request.json();
			},
		},
		formData() {
			return request.formData();
		},
		async multipart() {
			const formData = await request.formData();
			const fields: Record<string, string> = {};
			const files: Record<string, UploadedFile> = {};

			for (const [name, value] of formData.entries()) {
				if (value instanceof File) {
					files[name] = {
						name,
						filename: value.name,
						type: value.type,
						size: value.size,
						content: new Uint8Array(await value.arrayBuffer()),
					};
				} else {
					fields[name] = value;
				}
			}

			return { fields, files };
		},
	};
	return context;
}

/**
 * Middleware that logs HTTP request details (method, path, status, latency).
 */
export function logger(options: {
	format?: (ctx: Context, ms: number, status: number) => string;
} = {}): Middleware {
	const { format } = options;

	return async (ctx, next) => {
		const start = performance.now();
		const response = await next();
		const end = performance.now() - start;
		if (format) {
			console.log(format(ctx, end, response.status));
		} else {
			console.log(
				`${ctx.request.method} ${ctx.url.pathname} ${response.status} ${end.toFixed(2)}ms`,
			);
		}
		return response;
	};
}

/**
 * Middleware to handle Cross-Origin Resource Sharing (CORS).
 */
export function cors(options: {
	origin?: string | string[];
	methods?: string[];
	headers?: string[];
	credentials?: boolean;
	maxAge?: number;
} = {}): Middleware {
	const {
		origin = "*",
		methods = httpMethods,
		headers: allowedHeaders = ["*"],
		credentials = false,
		maxAge,
	} = options;

	return async (ctx, next) => {
		const preflight = ctx.request.method === "OPTIONS";

		const response = preflight ? null : await next();
		const headers = preflight ? new Headers() : new Headers(response!.headers);

		const requestOrigin = ctx.request.headers.get("Origin");
		if (Array.isArray(origin)) {
			if (requestOrigin && origin.includes(requestOrigin)) {
				headers.set("Access-Control-Allow-Origin", requestOrigin);
			}
		} else {
			headers.set("Access-Control-Allow-Origin", origin);
		}

		headers.set("Access-Control-Allow-Methods", methods.join(", "));
		headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
		if (credentials) {
			headers.set("Access-Control-Allow-Credentials", "true");
		}

		if (preflight) {
			if (maxAge) {
				headers.set("Access-Control-Max-Age", maxAge.toString());
			}
			return new Response(null, { status: 204, headers });
		}
		return new Response(response!.body, {
			status: response!.status,
			statusText: response!.statusText,
			headers,
		});
	};
}

async function hashFile(message: Uint8Array<ArrayBuffer>): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", message);
	return encodeHex(buf);
}

/**
 * Serves static files from a directory.
 * Handles ETag caching, Range requests, and prevents directory traversal.
 */
export function staticFiles(root: string, options: {
	maxAge?: number;
	immutable?: boolean;
	index?: string;
	etag?: boolean;
} = {}): Middleware {
	const { maxAge = 0, immutable = false, index = "index.html", etag = true } = options;
	root = resolve(Deno.cwd(), root);

	return async (ctx, next) => {
		if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") {
			return next();
		}

		const decodedPath = decodeURIComponent(ctx.url.pathname);
		let filepath = resolve(root, decodedPath.slice(1));
		if (!filepath.startsWith(root)) {
			return next();
		}

		try {
			const stat = await Deno.stat(filepath);

			if (stat.isDirectory) {
				filepath = join(filepath, index);
				try {
					await Deno.stat(filepath);
				} catch {
					return next();
				}
			}

			const file = await Deno.readFile(filepath);
			const ext = extname(filepath).toLowerCase();

			const headers = new Headers({
				"Content-Type": getContentType(ext) || "application/octet-stream",
			});

			if (etag) {
				const hash = (await hashFile(file)).toString();

				headers.set("ETag", hash);
				if (ctx.request.headers.get("If-None-Match") === hash) {
					return new Response(null, { status: 304, headers });
				}
			}

			const rangeHeader = ctx.request.headers.get("Range");
			if (rangeHeader) {
				const range = parseRangeHeader(rangeHeader, file.length);

				if (!range) {
					headers.set("Content-Range", `bytes */${file.length}`);
					throw new HttpError(416, "Range Not Satisfiable", headers);
				}

				const { start, end } = range;
				const chunkLen = (end - start) + 1;

				headers.set("Content-Range", `bytes ${start}-${end}/${file.length}`);
				headers.set("Accept-Ranges", "bytes");
				headers.set("Content-Length", chunkLen.toString());

				return new Response(file.slice(start, end + 1), { status: 206, headers });
			}

			if (maxAge > 0 || immutable) {
				const directives = [`max-age=${maxAge}`];
				if (immutable) directives.push("immutable");
				headers.set("Cache-Control", directives.join(", "));
			}

			return new Response(file, { headers });
		} catch {
			return next();
		}
	};
}

/**
 * Rate limiter middleware.
 * Returns an object with a `cleanup` method to clear the internal timer.
 */
export function rateLimit(options: {
	windowMs: number;
	max: number;
	keygen?: (ctx: Context) => string;
	handler?: Handler<any>;
}): Middleware & { cleanup: () => void } {
	const {
		windowMs,
		max,
		keygen = (ctx) => ctx.sender.remoteAddr.hostname,
		handler,
	} = options;

	const requests = new Map<string, { count: number; reset: number }>();
	const id = setInterval(() => {
		const now = Date.now();
		for (const [key, data] of requests.entries()) {
			if (now > data.reset) requests.delete(key);
		}
	}, windowMs);

	const middleware = async (ctx: Context, next: () => Promise<Response>) => {
		const key = keygen(ctx);
		const now = Date.now();

		let data = requests.get(key);

		if (!data || now > data.reset) {
			data = { count: 0, reset: now + windowMs };
			requests.set(key, data);
		}

		if (++data.count > max) {
			const retryAfter = Math.ceil((data.reset - now) / 1000).toString();
			return await handler?.(ctx) ?? ctx.tooManyRequests(undefined, retryAfter);
		}
		return next();
	};

	return Object.assign(middleware, {
		cleanup: () => clearInterval(id),
		[Symbol.dispose]: () => clearInterval(id),
	});
}

/**
 * Middleware that adds security headers to the response.
 */
export function securityHeaders(options: {
	contentSecurityPolicy?: string;
	strictTransportSecurity?: string;
	xContentTypeOptions?: "nosniff";
	referrerPolicy?: string;
	permissionsPolicy?: string;
	crossOriginOpenerPolicy?: string;
	crossOriginEmbedderPolicy?: string;
	crossOriginResourcePolicy?: string;
	cacheControl?: string;
} = {}): Middleware {
	const {
		contentSecurityPolicy = [
			"default-src 'self'",
			"base-uri 'self'",
			"object-src 'none'",
			"frame-ancestors 'self'",
			"form-action 'self'",
		].join("; "),
		strictTransportSecurity = "max-age=31536000; includeSubDomains",
		xContentTypeOptions = "nosniff",
		referrerPolicy = "strict-origin-when-cross-origin",
		permissionsPolicy = "camera=(), microphone=(), geolocation=()",
		crossOriginOpenerPolicy = "same-origin",
		crossOriginEmbedderPolicy = "require-corp",
		crossOriginResourcePolicy = "same-origin",
		cacheControl,
	} = options;

	return async (_, next) => {
		const response = await next();
		const headers = new Headers(response.headers);

		if (contentSecurityPolicy) {
			headers.set("Content-Security-Policy", contentSecurityPolicy);
		}

		if (strictTransportSecurity) {
			headers.set("Strict-Transport-Security", strictTransportSecurity);
		}

		if (xContentTypeOptions) {
			headers.set("X-Content-Type-Options", xContentTypeOptions);
		}

		if (referrerPolicy) {
			headers.set("Referrer-Policy", referrerPolicy);
		}

		if (permissionsPolicy) {
			headers.set("Permissions-Policy", permissionsPolicy);
		}

		if (crossOriginOpenerPolicy) {
			headers.set("Cross-Origin-Opener-Policy", crossOriginOpenerPolicy);
		}

		if (crossOriginEmbedderPolicy) {
			headers.set(
				"Cross-Origin-Embedder-Policy",
				crossOriginEmbedderPolicy,
			);
		}

		if (crossOriginResourcePolicy) {
			headers.set(
				"Cross-Origin-Resource-Policy",
				crossOriginResourcePolicy,
			);
		}

		if (cacheControl) {
			headers.set("Cache-Control", cacheControl);
		}

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}

/**
 * Middleware that parses `application/json` bodies.
 */
export function jsonParser(): Middleware {
	return async (ctx, next) => {
		const contentType = ctx.request.headers.get("Content-Type");

		if (contentType?.includes("application/json")) {
			try {
				ctx.bodyCache = await ctx.body.json();
			} catch (_e) {
				return ctx.badRequest("Malformed JSON input");
			}
		}
		return next();
	};
}

/**
 * Middleware that parses `application/x-www-form-urlencoded` bodies.
 */
export function formParser(): Middleware {
	return async (ctx, next) => {
		const contentType = ctx.request.headers.get("Content-Type");

		if (contentType?.includes("application/x-www-form-urlencoded")) {
			try {
				const formData = await ctx.formData();
				const data: Record<string, string> = {};
				for (const [key, value] of formData.entries()) {
					data[key] = value.toString();
				}
				ctx.bodyCache = data;
			} catch (_) {
				return ctx.badRequest("Invalid form data");
			}
		}

		return next();
	};
}

function parseRangeHeader(
	rangeHeader: string,
	fileSize: number,
	maxRangeLength: number = 128 * 1024 * 1024,
): { start: number; end: number } | null {
	const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) return null;

	const start = parseInt(match[1], 10);
	const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

	if (
		isNaN(start) || isNaN(end) ||
		start < 0 || end < 0 ||
		start > end ||
		start >= fileSize ||
		end >= fileSize
	) {
		return null;
	}

	if ((end - start + 1) > maxRangeLength) {
		return null;
	}

	return { start, end };
}
