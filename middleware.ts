/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
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

export interface UploadedFile {
	name: string;
	filename: string;
	type: string;
	size: number;
	content: Uint8Array;
}

export interface Context<Params = Record<string, string>> {
	readonly request: Request;
	readonly sender: Deno.ServeHandlerInfo<Deno.NetAddr>;
	readonly params: Params;
	readonly url: URL;
	readonly cookies: CookieJar;
	readonly requestId: string;

	bodyCache: unknown;
	state: Map<string | symbol, unknown>;

	json<T>(data: T, init?: ResponseInit): Response;
	html(content: string, init?: ResponseInit): Response;
	text(content: string, init?: ResponseInit): Response;
	redirect(url: string, status?: number): Response;

	notFound(message?: string): never;
	badRequest(message?: string): never;
	tooManyRequests(retryAfter?: string, message?: string): never;
	unauthorized(message?: string): never;
	forbidden(message?: string): never;
	internalError(message?: string): never;

	created<T>(data: T, init?: ResponseInit): Response;
	noContent(): Response;

	send(path: string, init?: ResponseInit): Promise<Response>;

	body<T = any>(): Promise<T>;
	formData(): Promise<FormData>;

	multipart(): Promise<{
		fields: Record<string, string>;
		files: Record<string, UploadedFile>;
	}>;
}

export interface Handler<C> {
	(ctx: Context<C>): Response | Promise<Response> | void | Promise<void>;
}

export interface Middleware {
	(ctx: Context, next: () => Promise<Response>): Response | Promise<Response>;
}

export interface ErrorHandler {
	(error: Error, ctx: Context): Response | Promise<Response>;
}

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
	init?: ResponseInit,
): Response {
	const headers = new Headers(init?.headers);
	if (contentType) headers.set("Content-Type", contentType);

	for (const setCookie of cookies.getSetCookieHeaders()) {
		headers.append("Set-Cookie", setCookie);
	}

	return new Response(data, {
		...init,
		headers,
	});
}

export function getContentType(ext: string): string | undefined {
	const contentTypes: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".js": "application/javascript; charset=utf-8",
		".mjs": "application/javascript; charset=utf-8",
		".json": "application/json; charset=utf-8",
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

export function createContext<P>(
	request: Request,
	sender: Deno.ServeHandlerInfo<Deno.NetAddr>,
	params: P,
	requestId?: string,
): Context<P> {
	const url = new URL(request.url);
	const cookies = new CookieJar(request.headers.get("Cookie"));

	return {
		request,
		sender,
		params,
		url,
		state: new Map(),
		requestId: requestId || crypto.randomUUID(),
		cookies,
		bodyCache: undefined,
		json(data, init) {
			return response(JSON.stringify(data), "application/json", cookies, init);
		},
		html(content, init) {
			return response(content, "text/html; charset=utf-8", cookies, init);
		},
		text(content, init) {
			return response(content, "text/plain; charset=utf-8", cookies, init);
		},
		redirect(url, status = 302) {
			return response(null, null, cookies, { status, headers: { Location: url } });
		},
		async send(path, init) {
			try {
				const safePath = resolve(Deno.cwd(), path);

				const stat = await Deno.stat(safePath);
				if (stat.isDirectory) throw new HttpError(400, "Cannot send directory");

				const file = await Deno.readFile(safePath);
				const ext = extname(safePath).toLowerCase();

				const headers = new Headers(init?.headers);
				headers.set("Content-Type", getContentType(ext) || "application/octet-stream");

				return new Response(file, { ...init, headers });
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
		tooManyRequests(message = "Too Many Requests Error"): never {
			throw new TooManyRequestsError(message);
		},
		created(data, init) {
			return response(JSON.stringify(data), "application/json", cookies, { ...init, status: 201 });
		},
		noContent() {
			return response(null, null, cookies, { status: 204 });
		},
		async body() {
			if (this.bodyCache !== undefined) {
				return this.bodyCache;
			}
			const text = await request.text();
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
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
					const content = new Uint8Array(await value.arrayBuffer());
					files[name] = {
						name,
						filename: value.name,
						type: value.type,
						size: value.size,
						content,
					};
				} else {
					fields[name] = value;
				}
			}

			return { fields, files };
		},
	};
}

export function requestId(): Middleware {
	return async (ctx, next) => {
		const response = await next();
		const headers = new Headers(response.headers);
		headers.set("X-Request-ID", ctx.requestId);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}

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
	const buf = await crypto.subtle.digest("SHA-1", message);
	return encodeHex(buf);
}

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
			return await handler?.(ctx) ?? ctx.tooManyRequests(retryAfter);
		}
		return next();
	};

	return Object.assign(middleware, {
		cleanup: () => clearInterval(id),
		[Symbol.dispose]: () => clearInterval(id),
	});
}

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

export function jsonParser(): Middleware {
	return async (ctx, next) => {
		const contentType = ctx.request.headers.get("Content-Type");

		if (contentType?.includes("application/json")) {
			try {
				ctx.bodyCache = await ctx.body();
			} catch (_e) {
				return ctx.badRequest("Malformed JSON input");
			}
		}

		return next();
	};
}

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
