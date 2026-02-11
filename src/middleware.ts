/**
 * @module middleware
 * Provides the `Context` interface, request handling, and built-in middleware.
 */

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

/**
 * represents a file uploaded via `multipart/form-data`
 */
export interface UploadedFile {
	/** the field name in the form */
	name: string;
	/** the filename provided by the client */
	filename: string;
	/** the MIME type provided by the client */
	type: string;
	/** the size of the file in bytes */
	size: number;
	/** the raw file content */
	content: Uint8Array;
}

/**
 * the Context object represents a single HTTP request/response lifecycle,
 * holding request data and middleware state and providing response helpers
 */
export interface Context<Params = Record<string, string>> {
	/** the incoming Request object */
	readonly request: Request;
	/** Deno's connection info (remote address) */
	readonly sender: Deno.ServeHandlerInfo<Deno.NetAddr>;
	/** parameters extracted from the url path (e.g., `:id`) */
	readonly params: Params;
	/** the parsed url */
	readonly url: URL;
	/** a helper to manage cookies (request and response) */
	readonly cookies: CookieJar;
	/** a unique identifier for this request */
	readonly requestId: string;

	/** the url search params object */
	readonly query: URLSearchParams;

	/**
	 * headers for the outgoing response
	 * @example
	 * ```ts
	 * ctx.set("X-Custom-Header", "hai")
	 * ctx.get("X-Custom-Header") // "hai"
	 * ```
	 */
	readonly headers: Headers;

	/** gets a specific outgoing header value */
	get(name: string): string | null;
	/** sets an outgoing header value */
	set(name: string, value: string): this;

	/** internal cache for body parsing */
	bodyCache: unknown;

	/**
	 * shared state map for middleware. useful for passing data between different many
	 * middleware stages.
	 */
	state: Map<string | symbol, unknown>;

	/**
	 * sends a JSON response
	 * @param data the object to serialize
	 * @param init optional ResponseInit body
	 */
	json<T>(data: T, init?: ResponseInit): Response;
	/**
	 * sends an HTML response
	 * @param content the html input to be sent
	 * @param init optional ResponseInit body
	 */
	html(content: string, init?: ResponseInit): Response;
	/**
	 * sends a plain text response
	 * @param content the plain text input to be sent
	 * @param init optional ResponseInit body
	 */
	text(content: string, init?: ResponseInit): Response;
	/**
	 * redirects to a different url
	 * @param url the url to redirect to
	 * @param status the HTTP status code (defaults to 302)
	 */
	redirect(url: string, status?: number): Response;

	/** throws a 404 Not Found error */
	notFound(message?: string): never;
	/** throws a 400 Bad Request error */
	badRequest(message?: string): never;
	/** throws a 429 Too Many Requests error */
	tooManyRequests(message?: string, retryAfter?: string): never;
	/** throws a 401 Unauthorized error */
	unauthorized(message?: string): never;
	/** throws a 403 Forbidden error */
	forbidden(message?: string): never;
	/** throws a 500 Internal Server Error */
	internalError(message?: string): never;

	/** sends a 201 Created JSON response */
	created<T>(data: T, init?: ResponseInit): Response;
	/** sends a 204 No Content response */
	noContent(): Response;

	/**
	 * sends a file from the filesystem.
	 * @param path the relative or absolute path to the file
	 * @param init optional ResponseInit body
	 *
	 * @example
	 * ```ts
	 * app.get("/image.png", (ctx) => {
	 *   return ctx.send("./assets/image.png");
	 * });
	 * ```
	 */
	send(path: string, init?: ResponseInit): Promise<Response>;

	/** methods for accessing the request body */
	body: {
		/**
		 * returns the body as a string.
		 * if the body was previously parsed as JSON, it returns `JSON.stringify` of the cache
		 */
		plain(): Promise<string>;
		/**
		 * returns the body as a parsed JSON object.
		 * uses native `request.json()` for efficiency
		 * @example
		 * ```ts
		 * app.post("/data", async (ctx) => {
		 *   const body = await ctx.body.json<{ name: string }>();
		 *
		 * 	 // unsafe operation: data must be validated beforehand
		 *   return ctx.json({ received: body.name });
		 * });
		 * ```
		 */
		json<T = any>(): Promise<T>;
	};

	/** returns the body as a `FormData` object */
	formData(): Promise<FormData>;

	/**
	 * parses the body as `multipart/form-data`
	 * @returns fields and files extracted from the request
	 * @example
	 * ```ts
	 * app.post("/upload", async (ctx) => {
	 *   const { files } = await ctx.multipart();
	 *   const file = files.avatar;
	 *   console.log(`Received ${file.filename}`);
	 * });
	 * ```
	 */
	multipart(): Promise<{
		fields: Record<string, string>;
		files: Record<string, UploadedFile>;
	}>;

	/**
	 * checks whether the incoming request's `Content-Type` header matches the given MIME type(s).
	 *
	 * @template T the string literal type of the MIME type
	 *
	 * @example
	 * ```ts
	 * if (ctx.is("application/json")) {
	 *   // the type system knows the header is strictly "application/json" here
	 *   const data = await ctx.body.json();
	 * }
	 * ```
	 */
	is<T extends string>(type: T | T[]): this is Context & {
		request: Request & {
			headers: Headers & { get(name: "content-type"): T };
		};
	};
}

/**
 * a route handler function
 * @template C the type of route parameters
 */
export interface Handler<C> {
	(ctx: Context<C>): Response | Promise<Response> | void | Promise<void>;
}

/**
 * a middleware function
 * `Middleware` can modify the `Context` or modify the `Response`
 * @example <caption>short-circuit / authentication middleware</caption>
 * ```ts
 * // check for a token in the headers before allowing access
 * const auth: Middleware = async (ctx, next) => {
 *   const token = ctx.request.headers.get("Authorization");
 *   if (!token) {
 *     ctx.unauthorized("missing token :c");
 *   }
 *   // calling `next()` allows the request to proceed to the next
 *   // middleware or route handler
 *   await next();
 * };
 * app.use(auth);
 * ```
 *
 * @example <caption>deny requests based on method or path</caption>
 * ```ts
 * const deny: Middleware = async (ctx, next) => {
 *   if (ctx.request.method === "DELETE") {
 *     ctx.forbidden("bugger off mate");
 *   }
 *   await next();
 * };
 * app.use(auth);
 * ```
 *
 * @example <caption>logging middleware</caption>
 * ```ts
 * const logging: Middleware = async (ctx, next) => {
 *   const start = performance.now();
 *   await next(); // wait for the response to be generated by other handlers
 *   const duration = performance.now() - start;
 *   console.log(`${ctx.request.method} ${ctx.url.pathname} - ${duration}ms`);
 * };
 * app.use(auth);
 * ```
 *
 * @example <caption>custom headers</caption>
 * ```ts
 * const headersMiddleware: Middleware = async (ctx, next) => {
 *   const response = await next();
 *   return response.headers.set("X-Powered-By", "snarl"), response;
 * };
 * app.use(auth);
 * ```
 */
export interface Middleware {
	(ctx: Context, next: () => Promise<Response>): Response | Promise<Response>;
}

/**
 * an error handler function for top-level error catching
 */
export interface ErrorHandler {
	(error: Error, ctx: Context): Response | Promise<Response>;
}

/**
 * composes an array of middleware functions with a final handler
 *
 * this function creates a chain of functions where the `next()` function
 * of each middleware executes the next middleware in the sequence. when the last
 * middleware finishes, the user's route handler is executed
 *
 * @param middlewares a set of middleware functions to execute in order
 * @param handler the last route handler that returns a `Response`
 * @returns a composed handler function
 *
 * @example <caption>chaining middlewares</caption>
 * ```ts
 * const myHandler: Handler = async (ctx) => {
 *   return ctx.json({ message: "Hello World" });
 * };
 *
 * const app = createRouter();
 * app.use(compose([authMiddleware, loggingMiddleware], myHandler));
 * ```
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
 * creates a new `Context` object
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
		set(name: string, value: string): typeof context {
			headers.set(name, value);
			return context;
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
		is<T extends string>(
			type: T | T[],
		): this is Context & {
			request: Request & {
				headers: Headers & { get(name: "content-type"): T };
			};
		} {
			const kind = this.request.headers.get("Content-Type");
			if (!kind) return false;

			if (Array.isArray(type)) {
				return type.some((t) => kind.includes(t));
			}
			return kind.includes(type);
		},
	};
	return context;
}

/**
 * middleware that logs HTTP request details
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
 * @example
 * ```ts
 * app.use(cors({
 *   origin: "https://example.com",
 *   methods: ["GET", "POST"],
 *   credentials: true
 * }));
 * ```
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
 * serves static files from a directory.
 * handles ETag caching, range requests, and prevents directory traversal
 *
 * @example
 * ```ts
 * app.use(staticFiles("public", { immutable: true, etag: false }));
 * ```
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
 *
 * @example
 * ```ts
 * app.use(rateLimit({
 *   windowMs: 60_000,
 *   max: 100,
 *   keygen: (ctx) => ctx.headers.get("X-API-Key") || ctx.sender.remoteAddr.hostnam
 * }));
 * ```
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
 * middleware that adds security headers to the response
 * @example
 * ```ts
 * app.use(securityHeaders({
 *   contentSecurityPolicy: "default-src 'self' 'unsafe-inline'"
 * }));
 * ```
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
 * middleware that parses `application/json` bodies
 *
 * @example
 * ```ts
 * app.use(jsonParser());
 *
 * app.post("/", async (ctx) => {
 *   // returns cached object
 *   return await ctx.body.json<{ name: string }>();
 * });
 * ```ts
 */
export function jsonParser(): Middleware {
	return async (ctx, next) => {
		if (ctx.is("application/json")) {
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
 * middleware that parses `application/x-www-form-urlencoded` bodies

 * @example
 * ```ts
 * app.use(formParser());
 *
 * app.post("/submit", async (ctx) => {
 *   const { email } = await ctx.body.json<{ email: string }>();
 * });
 * ```
 */
export function formParser(): Middleware {
	return async (ctx, next) => {
		if (ctx.is("application/x-www-form-urlencoded")) {
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
