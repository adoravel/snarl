/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { CookieJar } from "../cookie.ts";
import {
	BadRequestError,
	ForbiddenError,
	InternalServerError,
	NotFoundError,
	TooManyRequestsError,
	UnauthorizedError,
} from "../errors.ts";
import { isJsxElement, type JSX, renderToString } from "../jsx-runtime.ts";
import { type BodyReader, createBodyReader } from "./body.ts";
import { entriesToObject, type Infer, type Schema } from "../validate.ts";
import { createMultipartReader, type MultipartOptions, type MultipartResult } from "./multipart.ts";
import { detectImageType, processImageBlob, processImageStream } from "./image.ts";

export class QueryParams extends URLSearchParams {
	/** validates the query as an object; throws a 422 with the issues if it doesn't fit */
	parse<S extends Schema<unknown>>(schema: S): Infer<S> {
		return schema.parse(entriesToObject(this)) as Infer<S>;
	}

	/** the query as a plain object. a repeated key becomes an array */
	toObject(): Record<string, string | string[]> {
		return entriesToObject(this);
	}
}

const encoder = new TextEncoder();
const DOCTYPE_RE = /^\s*<!doctype\b/i;

const JSON_INIT: ResponseInit = { headers: new Headers({ "Content-Type": "application/json" }) };
const TEXT_INIT: ResponseInit = {
	headers: new Headers({ "Content-Type": "text/plain; charset=utf-8" }),
};
const HTML_INIT: ResponseInit = {
	headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
};

function isDefaultInit(init: ResponseInit | undefined): boolean {
	return init === undefined ||
		(init.status === undefined && init.statusText === undefined && init.headers === undefined);
}

/**
 * the `Context` object represents a single HTTP request/response lifecycle,
 * holding request data and middleware state and providing response helpers
 */
export class Context<Params = Record<string, string>> {
	/** internal cache for body parsing */
	bodyCache: unknown = undefined;

	private _headers?: Headers;
	private _cookies?: CookieJar;
	private _state?: Map<string | symbol, unknown>;
	private _body?: BodyReader;
	private _query?: QueryParams;
	private _requestId?: string;
	private _url?: URL;

	constructor(
		/** the incoming Request object */
		public readonly request: Request,
		/** the request's pathname, exactly as sent by the client */
		public readonly path: string,
		/** the raw query string (e.g. `"?term=hewwo"`, or `""` if none) */
		private readonly rawSearch: string,
		/** Deno's connection info (remote address) */
		public readonly sender: Deno.ServeHandlerInfo<Deno.NetAddr>,
		/** parameters extracted from the url path (e.g., `:id`) */
		public readonly params: Params,
		/** lazily produces a unique identifier for this request, called at most once */
		private readonly genRequestId: string | (() => string),
	) {
		if (typeof genRequestId === "string") this._requestId = genRequestId;
	}

	/** the fully parsed request URL */
	get url(): URL {
		return this._url ??= new URL(this.request.url);
	}

	/** the URL search params, plus `parse(schema)` and `toObject()` */
	get query(): QueryParams {
		return this._query ??= new QueryParams(this.rawSearch);
	}

	/** a unique identifier for this request */
	get requestId(): string {
		return this._requestId ??= (this.genRequestId as () => string)();
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

	/** methods for accessing the request body */
	get body(): BodyReader {
		return this._body ??= createBodyReader(this);
	}

	/** gets a specific outgoing header value */
	get(name: string): string | null {
		return this.headers.get(name);
	}

	/** sets an outgoing header value */
	set(name: string, value: string): this {
		return this.headers.set(name, value), this;
	}

	/**
	 * @internal true once anything has forced allocation of custom response
	 * headers or cookies, meaning responses must go through the slower
	 * header-merging path instead of the direct `new Response()` shortcut
	 */
	private hasCustomHeaders(): boolean {
		return this._headers !== undefined || !!this._cookies?.headers.length;
	}

	/** sends a JSON response */
	json<T>(data: T, init?: ResponseInit): Response {
		const body = JSON.stringify(data);
		if (!this.hasCustomHeaders() && isDefaultInit(init)) return new Response(body, JSON_INIT);
		return this.response(body, "application/json", init);
	}

	/** sends an HTML response */
	html(
		content: JSX.Node,
		init?: ResponseInit & { autoDoctype?: boolean },
	): Response | Promise<Response> {
		const body = isJsxElement(content) ? renderToString(content) : content as string;

		if (typeof body === "string") return this.finishHtml(body, init);
		return Promise.resolve(body).then((resolved) => this.finishHtml(String(resolved ?? ""), init));
	}

	finishHtml(body: string, init?: ResponseInit & { autoDoctype?: boolean }): Response {
		if (init?.autoDoctype !== false && !DOCTYPE_RE.test(body)) {
			body = `<!DOCTYPE html>${body}`;
		}
		if (!this.hasCustomHeaders() && isDefaultInit(init)) return new Response(body, HTML_INIT);
		return this.response(body, "text/html; charset=utf-8", init);
	}

	/** sends a plain text response */
	text(content: string, init?: ResponseInit): Response {
		if (!this.hasCustomHeaders() && isDefaultInit(init)) return new Response(content, TEXT_INIT);
		return this.response(content, "text/plain; charset=utf-8", init);
	}

	/** redirects to a different url */
	redirect(url: string, status: number = 302): Response {
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

	/** throws a 401 Unauthorised error (superior) */
	unauthorised(message = "Unauthorised"): never {
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

	/** sends an image */
	async image(
		data: Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
		init?: ResponseInit,
	): Promise<Response> {
		if (data instanceof ReadableStream) {
			const result = await processImageStream(data);
			return this.response(result.stream, result.mime, init);
		}

		if (data instanceof Blob) {
			const result = await processImageBlob(data);
			return this.response(result.bytes, result.mime, init);
		}

		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		const mime = detectImageType(bytes) || "application/octet-stream";
		return this.response(bytes as Uint8Array<ArrayBuffer>, mime, init);
	}

	/** returns the body as a `FormData` object */
	formData(): Promise<FormData> {
		return this.request.formData();
	}

	/** parses the body as `multipart/form-data`. see `context/multipart.ts` */
	multipart(options: MultipartOptions = {}): Promise<MultipartResult> {
		return createMultipartReader(this.request, options);
	}

	/**
	 * checks whether the incoming request's `Content-Type` header matches
	 * the given MIME type(s), narrowing the header's type when it does
	 */
	is<T extends string>(type: T | T[]): this is Context & {
		request: Request & { headers: Headers & { get(name: "content-type"): T } };
	} {
		const kind = this.request.headers.get("content-type");
		if (!kind) return false;

		return Array.isArray(type) ? type.some((t) => kind.includes(t)) : kind.includes(type);
	}

	/** @internal shared by json/html/text so header/cookie merging happens once */
	response(data: BodyInit | null, contentType: string | null, init?: ResponseInit): Response {
		if (!this.hasCustomHeaders()) {
			if (init === undefined) {
				return new Response(
					data,
					contentType ? { headers: { "Content-Type": contentType } } : undefined,
				);
			}
			return new Response(data, {
				...init,
				headers: contentType ? { "Content-Type": contentType, ...init?.headers } : init?.headers,
			});
		}

		const headers = new Headers(init?.headers);

		if (contentType) headers.set("Content-Type", contentType);
		if (data != null) {
			let length;

			if (typeof data === "string") {
				data = encoder.encode(data);
				headers.set("Content-Length", String(data.byteLength));
			} else if (data instanceof Uint8Array) {
				length = data.length;
			} else if (data instanceof ArrayBuffer) {
				length = data.byteLength;
			}

			if (length !== undefined) headers.set("Content-Length", String(length));
		}

		this._headers?.forEach((value, key) => headers.set(key, value));
		this._cookies?.headers.forEach((v) => headers.append("Set-Cookie", v));

		return new Response(data, { ...init, headers });
	}
}
