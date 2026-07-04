/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { CookieJar } from "./cookie.ts";
import {
	BadRequestError,
	ForbiddenError,
	HttpError,
	InternalServerError,
	NotFoundError,
	TooManyRequestsError,
	UnauthorizedError,
} from "./errors.ts";
import { extname, resolve } from "@std/path";
import { getContentType } from "./mime.ts";

/** represents a file uploaded via `multipart/form-data` */
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

export interface MultipartOptions {
	/**
	 * reject any single file whose declared size exceeds this, in bytes.
	 * unlimited by default
	 */
	maxFileSize?: number;
	/**
	 * reject the whole request if the sum of all file sizes exceeds this,
	 * in bytes. unlimited by default
	 */
	maxTotalSize?: number;
}

/**
 * the `Context` object represents a single HTTP request/response lifecycle,
 * holding request data and middleware state and providing response helpers
 */
export class Context<Params = Record<string, string>> {
	/** the url search params object */
	readonly query: URLSearchParams;
	/** internal cache for body parsing */
	bodyCache: unknown = undefined;

	private _headers?: Headers;
	private _cookies?: CookieJar;
	private _state?: Map<string | symbol, unknown>;

	constructor(
		/** the incoming Request object */
		public readonly request: Request,
		/** the parsed url */
		public readonly url: URL,
		/** Deno's connection info (remote address) */
		public readonly sender: Deno.ServeHandlerInfo<Deno.NetAddr>,
		/** parameters extracted from the url path (e.g., `:id`) */
		public readonly params: Params,
		/** a unique identifier for this request */
		public readonly requestId: string,
	) {
		this.query = url.searchParams;
	}

	/** headers for the outgoing response */
	get headers(): Headers {
		return this._headers ??= new Headers();
	}

	/** a helper to manage cookies (request and response) */
	get cookies(): CookieJar {
		return this._cookies ??= new CookieJar(this.request.headers.get("Cookie"));
	}

	/** shared state map for middleware, used to pass data between stages */
	get state(): Map<string | symbol, unknown> {
		return this._state ??= new Map();
	}

	/** gets a specific outgoing header value */
	get(name: string): string | null {
		return this.headers.get(name);
	}

	/** sets an outgoing header value */
	set(name: string, value: string): this {
		return this.headers.set(name, value), this;
	}

	/** sends a JSON response */
	json<T>(data: T, init?: ResponseInit): Response {
		const body = JSON.stringify(data);

		if (!this._cookies?.headers.length && !this._headers) {
			return new Response(body, {
				...init,
				headers: { "Content-Type": "application/json", ...init?.headers },
			});
		}
		return this.response(body, "application/json", init);
	}

	/** sends an HTML response */
	html(content: string, init?: ResponseInit & { autoDoctype?: boolean }): Response {
		if (!this._cookies?.headers.length && !this._headers) {
			return new Response(content, {
				...init,
				headers: { "Content-Type": "text/html; charset=utf-8", ...init?.headers },
			});
		}
		if (init?.autoDoctype !== false && !content.startsWith("<!")) {
			content = `<!DOCTYPE html>${content}`;
		}
		return this.response(content, "text/html; charset=utf-8", init);
	}

	/** sends a plain text response */
	text(content: string, init?: ResponseInit): Response {
		if (!this._cookies?.headers.length && !this._headers) {
			return new Response(content, {
				...init,
				headers: { "Content-Type": "text/plain; charset=utf-8", ...init?.headers },
			});
		}
		return this.response(content, "text/plain; charset=utf-8", init);
	}

	/** redirects to a different url */
	redirect(url: string, status?: number): Response {
		return this.response(null, null, { status, headers: { Location: url } });
	}

	/** throws a 404 Not Found error */
	notFound(message = "Not Found"): never {
		throw new NotFoundError(message);
	}

	/** throws a 400 Bad Request error */
	badRequest(message = "Bad Request"): never {
		throw new BadRequestError(message);
	}

	/** throws a 429 Too Many Requests error */
	tooManyRequests(message = "Too Many Requests Error", retryAfter?: string): never {
		throw new TooManyRequestsError(message, retryAfter);
	}

	/** throws a 401 Unauthorized error */
	unauthorized(message = "Unauthorized"): never {
		throw new UnauthorizedError(message);
	}

	/** throws a 403 Forbidden error */
	forbidden(message = "Forbidden"): never {
		throw new ForbiddenError(message);
	}

	/** throws a 500 Internal Server Error */
	internalError(message = "Internal Server Error"): never {
		throw new InternalServerError(message);
	}

	/** sends a 201 Created JSON response */
	created<T>(data: T, init?: ResponseInit): Response {
		return this.json(data, { ...init, status: 201 });
	}

	/** sends a 204 No Content response */
	noContent(): Response {
		return this.response(null, null, { status: 204 });
	}

	/**
	 * streams a file from the filesystem as the response body.
	 *
	 * @example
	 * ```ts
	 * app.get("/image.png", (ctx) => ctx.send("./assets/image.png"));
	 * ```
	 */
	async send(path: string, init?: ResponseInit): Promise<Response> {
		const safePath = resolve(Deno.cwd(), path);

		let stat: Deno.FileInfo;
		try {
			stat = await Deno.stat(safePath);
		} catch {
			throw new HttpError(404, "File not found");
		}
		if (stat.isDirectory) throw new HttpError(400, "Cannot send directory");

		let file: Deno.FsFile;
		try {
			file = await Deno.open(safePath, { read: true });
		} catch {
			throw new HttpError(404, "File not found");
		}

		const ext = extname(safePath).toLowerCase();
		const headers = new Headers(init?.headers);
		headers.set("Content-Type", getContentType(ext) || "application/octet-stream");
		headers.set("Content-Length", stat.size.toString());
		this._headers?.forEach((v, k) => headers.set(k, v));

		return new Response(file.readable, { ...init, headers });
	}

	/** methods for accessing the request body */
	body = {
		/**
		 * returns the body as a string. if the body was previously parsed
		 * as JSON, it returns `JSON.stringify` of the cache
		 */
		plain: async (): Promise<string> => {
			return this.bodyCache ? JSON.stringify(this.bodyCache) : await this.request.text();
		},

		/** returns the body as a parsed JSON object, using the cache if present */
		json: async <T = any>(): Promise<T> => {
			return this.bodyCache as T ?? await this.request.json();
		},
	};

	/** returns the body as a `FormData` object */
	formData(): Promise<FormData> {
		return this.request.formData();
	}

	/**
	 * parses the body as `multipart/form-data`
	 * @returns fields and files extracted from the request
	 * @example
	 * ```ts
	 * app.post("/upload", async (ctx) => {
	 *   const { files } = await ctx.multipart({ maxFileSize: 10 * 1024 * 1024 });
	 *   console.log(`Received ${files.avatar.filename}`);
	 * });
	 * ```
	 */
	async multipart(options: MultipartOptions = {}): Promise<{
		fields: Record<string, string>;
		files: Record<string, UploadedFile>;
	}> {
		const declaredLength = Number(this.request.headers.get("Content-Length"));
		if (options.maxTotalSize && Number.isFinite(declaredLength) && declaredLength > options.maxTotalSize) {
			throw new HttpError(413, "Payload Too Large");
		}

		const formData = await this.request.formData();
		const fields: Record<string, string> = {};
		const files: Record<string, UploadedFile> = {};
		let total = 0;

		for (const [name, value] of formData.entries()) {
			if (value instanceof File) {
				if (options.maxFileSize && value.size > options.maxFileSize) {
					throw new HttpError(413, `File "${value.name}" exceeds the ${options.maxFileSize}-byte limit`);
				}

				total += value.size;
				if (options.maxTotalSize && total > options.maxTotalSize) {
					throw new HttpError(413, "Payload Too Large");
				}

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
	}

	/**
	 * checks whether the incoming request's `Content-Type` header matches
	 * the given MIME type(s), narrowing the header's type when it does
	 */
	is<T extends string>(type: T | T[]): this is Context & {
		request: Request & { headers: Headers & { get(name: "content-type"): T } };
	} {
		const kind = this.request.headers.get("Content-Type");
		if (!kind) return false;
		return Array.isArray(type) ? type.some((t) => kind.includes(t)) : kind.includes(type);
	}

	private response(data: BodyInit | null, contentType: string | null, init?: ResponseInit): Response {
		const headers = new Headers(init?.headers);
		if (contentType) headers.set("Content-Type", contentType);

		this._headers?.forEach((value, key) => headers.set(key, value));
		this._cookies?.headers.forEach((v) => headers.append("Set-Cookie", v));

		return new Response(data, { ...init, headers });
	}
}

/** a route handler function */
export interface Handler<C> {
	(ctx: Context<C>): Response | Promise<Response> | void | Promise<void>;
}

/**
 * a middleware function. `Middleware` can modify the `Context` or modify
 * the `Response`
 *
 * @example <caption>short-circuit / authentication middleware</caption>
 * ```ts
 * const auth: Middleware = async (ctx, next) => {
 *   const token = ctx.request.headers.get("Authorization");
 *   if (!token) ctx.unauthorized("missing token :c");
 *   await next();
 * };
 * ```
 *
 * @example <caption>logging middleware</caption>
 * ```ts
 * const logging: Middleware = async (ctx, next) => {
 *   const start = performance.now();
 *   await next();
 *   console.log(`${ctx.request.method} ${ctx.url.pathname} - ${performance.now() - start}ms`);
 * };
 * ```
 */
export interface Middleware {
	(ctx: Context, next: () => Promise<Response>): Response | Promise<Response>;
}

/** an error handler function for top-level error catching */
export interface ErrorHandler {
	(error: Error, ctx: Context): Response | Promise<Response>;
}

/**
 * composes an array of middleware functions with a final handler into a
 * single handler, where each middleware's `next()` invokes the next one
 * in sequence, and the last `next()` invokes `handler`
 */
export function compose(middlewares: Middleware[], handler: Handler<any>): Handler<any> {
	if (!middlewares.length) return handler;

	const chained = chain(...middlewares);

	return async (ctx) => {
		const result = await chained(ctx, async () => await handler(ctx) ?? new Response("", { status: 200 }));
		return result;
	};
}

/** chain multiple middleware into a single middleware */
export function chain(...middlewares: Middleware[]): Middleware {
	return (ctx, next) => {
		let i = 0;
		const dispatch = (): Promise<Response> => {
			if (i < middlewares.length) {
				const mw = middlewares[i++];
				return Promise.resolve(mw(ctx, dispatch));
			}
			return next();
		};
		return dispatch();
	};
}
