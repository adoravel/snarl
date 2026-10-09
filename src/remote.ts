/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import {
	asServiceError,
	type BuiltinError,
	type Call,
	type CallArgs,
	type CallOptions,
	callSignal,
	CODE_BY_STATUS,
	type ErrorCode,
	type FormBinding,
	formBinding,
	nest,
	ServiceError,
	trimSlashes,
} from "./service.ts";
import { consume } from "./stream.ts";
import { type Infer, type InferInput, type Schema, ValidationError } from "./validate.ts";

/** the verbs an endpoint can declare */
export type Verb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const SENDS_BODY: ReadonlySet<Verb> = new Set(["POST", "PUT", "PATCH"]);

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** an endpoint path that names its own origin rather than the remote's */
const ABSOLUTE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const DEFAULT_TIMEOUT = 30_000;

/**
 * - `json` — `application/json`, the default for a verb that carries a body
 * - `form` — `application/x-www-form-urlencoded`, which oauth token exchange wants
 * - `multipart` — `FormData`, for an upload
 * - `text` — the input verbatim, as `text/plain`
 * - `raw` — the input as-is (bytes, a `Blob`, a stream); no content type is set
 * - `none` — no body at all
 */
export type BodyFormat = "json" | "form" | "multipart" | "text" | "raw" | "none";

/**
 * - `json` — parsed, then checked against `output`. the default
 * - `text` — the body as a string
 * - `bytes` — a `Uint8Array`
 * - `stream` — the body, unread, for proxying it somewhere else
 * - `response` — the whole `Response`
 * - `none` — the body is discarded and nothing is returned
 */
export type ResponseFormat = "json" | "text" | "bytes" | "stream" | "response" | "none";

export interface EndpointDefinition<S, O, E extends readonly ErrorCode[], F> {
	/** input `v` schema */
	input?: S;

	/** output `v` schema */
	output?: O;

	/** the codes this endpoint raises, which the client narrows `error.code` to */
	errors?: E;

	/** sent with this endpoint only, on top of the client's own headers */
	headers?: Record<string, string>;

	/**
	 * how the input is sent. defaults to `json` for `POST`/`PUT`/`PATCH`, and a
	 * function is the way out when an api wants something none of the formats are
	 */
	body?: BodyFormat | ((input: any) => BodyInit | null);

	/** how the response is read. defaults to `json` */
	response?: F;

	/**
	 * how the leftover input becomes a query string, without the `?`. the default
	 * repeats a key per array item; an api wanting `a,b` or `k[]=a` says so here
	 */
	query?: (input: Record<string, unknown>) => string;

	/**
	 * for an api that answers `200` and puts the failure in the body. 🫩🫩🫩
	 *
	 * declare the code in `errors` too, so the client narrows to it
	 */
	failure?: (body: any) => { code: ErrorCode; message: string; details?: unknown } | undefined;
}

export interface Endpoint<
	In,
	Out,
	Code extends ErrorCode,
	Accepted = In,
	Streaming extends boolean = false,
> {
	readonly verb: Verb;
	readonly path: string;

	/** server-sent event. the call is iterated rather than awaited */
	readonly streaming: Streaming;

	readonly input?: Schema<In, Accepted>;
	readonly output?: Schema<Out, any>;
	readonly errors?: readonly Code[];
	readonly headers?: Record<string, string>;
	readonly body?: BodyFormat | ((input: any) => BodyInit | null);
	readonly response?: ResponseFormat;
	readonly query?: (input: Record<string, unknown>) => string;
	readonly failure?: (
		body: any,
	) => { code: ErrorCode; message: string; details?: unknown } | undefined;
}

export type AnyEndpoint = Endpoint<any, any, ErrorCode, any, boolean>;

/** a tree of endpoints */
export interface RemoteRoutes {
	[name: string]: AnyEndpoint | RemoteRoutes;
}

type Parsed<S> = S extends Schema<any, any> ? Infer<S> : void;
type Accepts<S> = S extends Schema<any, any> ? InferInput<S> : void;

type ByFormat<F> = F extends "response" ? Response
	: F extends "stream" ? ReadableStream<Uint8Array>
	: F extends "bytes" ? Uint8Array
	: F extends "text" ? string
	: F extends "none" ? void
	: unknown;

type Produced<O, F> = O extends Schema<any, any> ? Infer<O> : ByFormat<F>;

/** a call to somebody else's endpoint */
export interface RemoteCall<In, Out, Code extends ErrorCode> extends Call<In, Out, Code> {
	url(...args: CallArgs<In>): string;
}

export interface RemoteStream<In, Out> {
	(...args: CallArgs<In>): AsyncIterable<Out> & { close(): void };
	readonly path: string;
	url(...args: CallArgs<In>): string;
}

/** the callable shape of a remote api */
export type RemoteClient<R extends RemoteRoutes> = {
	[K in keyof R]: R[K] extends Endpoint<any, infer Out, infer Code, infer In, infer Streaming>
		? Streaming extends true ? RemoteStream<In, Out>
		: RemoteCall<In, Out, Code | BuiltinError>
		: R[K] extends RemoteRoutes ? RemoteClient<R[K]>
		: never;
};

/** every endpoint name in the tree */
export type RemotePaths<R extends RemoteRoutes, Prefix extends string = ""> = {
	[K in keyof R & string]: R[K] extends AnyEndpoint ? `${Prefix}${K}`
		: R[K] extends RemoteRoutes ? RemotePaths<R[K], `${Prefix}${K}.`>
		: never;
}[keyof R & string];

export interface RemoteInfo {
	/** the name, e.g. `"invoices.get"` */
	path: string;
	verb: Verb;

	/** the declared path */
	url: string;
	endpoint: AnyEndpoint;
}

export interface RemoteOptions {
	/** sent with every request. a function is called per request, for a rotating token */
	headers?: HeadersInit | (() => HeadersInit);

	/** the fetch to use. defaults to the global one */
	fetch?: typeof fetch;

	/** aborts any call that takes longer than this, unless the call says otherwise */
	timeout?: number | null;

	/**
	 * turns somebody else's error body into a code and a message. without it
	 * the status decides the code and the body is kept as `details`
	 */
	onError?: (
		response: Response,
		body: unknown,
		endpoint: RemoteInfo,
	) => { code: ErrorCode; message: string } | undefined;
}

export interface Remote<R extends RemoteRoutes> {
	readonly routes: R;

	/** where the endpoints live, without a trailing slash */
	readonly url: string;

	/** every endpoint, in declaration order */
	list(): RemoteInfo[];
}

function isEndpoint(value: AnyEndpoint | RemoteRoutes): value is AnyEndpoint {
	return typeof (value as AnyEndpoint).verb === "string";
}

function* walk(
	routes: RemoteRoutes,
	prefix = "",
): Generator<[path: string, endpoint: AnyEndpoint]> {
	for (const name of Object.keys(routes)) {
		const entry = routes[name];
		const path = `${prefix}${name}`;
		if (isEndpoint(entry)) yield [path, entry];
		else yield* walk(entry, `${path}.`);
	}
}

/** declares one endpoint */
export interface EndpointBuilder<Streaming extends boolean> {
	<
		S extends Schema<any, any> | undefined = undefined,
		O extends Schema<any, any> | undefined = undefined,
		const E extends readonly ErrorCode[] = [],
		F extends ResponseFormat = "json",
	>(
		path: string,
		definition?: EndpointDefinition<S, O, E, F>,
	): Endpoint<Parsed<S>, Produced<O, F>, E[number], Accepts<S>, Streaming>;
}

function define<Streaming extends boolean>(
	verb: Verb,
	streaming: Streaming,
): EndpointBuilder<Streaming> {
	return ((path: string, definition = {}) => ({
		verb,
		path,
		streaming,
		...definition,
	})) as any;
}

/** declares one endpoint of a foreign api. */
export const endpoint: {
	get: EndpointBuilder<false>;
	post: EndpointBuilder<false>;
	put: EndpointBuilder<false>;
	patch: EndpointBuilder<false>;
	delete: EndpointBuilder<false>;
	stream: EndpointBuilder<true>;
} = {
	get: define("GET", false),
	post: define("POST", false),
	put: define("PUT", false),
	patch: define("PATCH", false),
	delete: define("DELETE", false),
	stream: define("GET", true),
};

/** describes an api somebody else implements */
export function remote<const R extends RemoteRoutes>(url: string, routes: R): Remote<R> {
	const base = trimSlashes(url);
	const list: RemoteInfo[] = [];
	for (const [path, entry] of walk(routes)) {
		list.push({ path, verb: entry.verb, url: entry.path, endpoint: entry });
	}
	return { routes, url: base, list: () => [...list] };
}

function fillPath(
	template: string,
	input: unknown,
): { path: string; rest: unknown } {
	if (input === undefined || input === null || typeof input !== "object") {
		return { path: template, rest: input };
	}
	if (!isPlainObject(input)) return { path: template, rest: input };

	const values = input as Record<string, unknown>;
	const used = new Set<string>();
	const path = template.replace(PARAM_RE, (whole, name: string) => {
		if (!(name in values)) return whole;
		used.add(name);
		return encodeURIComponent(String(values[name]));
	});

	if (used.size === 0) return { path, rest: values };
	const rest: Record<string, unknown> = {};
	for (const key of Object.keys(values)) if (!used.has(key)) rest[key] = values[key];
	return { path, rest };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function searchParams(rest: Record<string, unknown>): URLSearchParams {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(rest)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) { for (const item of value) params.append(key, String(item)); }
		else params.append(key, String(value));
	}
	return params;
}

function queryString(endpoint: AnyEndpoint, rest: unknown, url: string): string {
	if (!isPlainObject(rest)) return "";

	const query = endpoint.query ? endpoint.query(rest) : searchParams(rest).toString();
	if (!query) return "";

	return `${url.includes("?") ? "&" : "?"}${query}`;
}

function encodeBody(
	endpoint: AnyEndpoint,
	rest: unknown,
): { body: BodyInit | null; type?: string } {
	const format = endpoint.body ?? "json";

	if (typeof format === "function") return { body: format(rest) };
	if (format === "none" || rest === undefined) return { body: null };

	switch (format) {
		case "form":
			return {
				body: isPlainObject(rest) ? searchParams(rest) : String(rest),
				type: "application/x-www-form-urlencoded;charset=UTF-8",
			};
		case "multipart": {
			const form = new FormData();
			if (isPlainObject(rest)) {
				for (const [key, value] of Object.entries(rest)) {
					if (value === undefined || value === null) continue;
					if (Array.isArray(value)) { for (const item of value) form.append(key, item as string); }
					else form.append(key, value as string);
				}
			}
			return { body: form };
		}
		case "text":
			return { body: String(rest), type: "text/plain;charset=UTF-8" };
		case "raw":
			return { body: rest as BodyInit };
		default:
			return { body: JSON.stringify(rest), type: "application/json" };
	}
}

/**
 * a client for a described api. the endpoints carry their own verbs, so this
 * client is exact where one built from a type alone has to guess
 */
export function createRemoteClient<R extends RemoteRoutes>(
	api: Remote<R>,
	options: RemoteOptions = {},
): RemoteClient<R> {
	const defaultFetch = options.fetch ?? fetch;
	const fetchFor = (call?: CallOptions) => call?.fetch ?? defaultFetch;
	const timeout = options.timeout === null ? undefined : options.timeout ?? DEFAULT_TIMEOUT;
	const byPath = new Map(api.list().map((info) => [info.path, info]));

	const computeHeaders = (
		endpoint: AnyEndpoint,
		extra?: Record<string, string>,
		call?: CallOptions,
	) => {
		const headers = new Headers(
			typeof options.headers === "function" ? options.headers() : options.headers,
		);

		for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
		for (const [name, value] of Object.entries(endpoint.headers ?? {})) headers.set(name, value);
		for (const [name, value] of new Headers(call?.headers)) headers.set(name, value);

		return headers;
	};

	async function fail(response: Response, info: RemoteInfo): Promise<ServiceError> {
		const body = await response.text().then((text) => {
			try {
				return JSON.parse(text);
			} catch {
				return text || undefined;
			}
		});
		const mapped = options.onError?.(response, body, info);
		if (mapped) return new ServiceError(mapped.code, mapped.message, body);

		const code = CODE_BY_STATUS.get(response.status) ?? "internal";
		const failure = new ServiceError(
			code,
			response.statusText || `${info.verb} failed (${response.status})`,
			body,
		);

		failure.status = response.status;
		return failure;
	}

	function declared(endpoint: AnyEndpoint, body: unknown): unknown {
		const failure = endpoint.failure?.(body);
		if (failure == null) return body;
		throw new ServiceError(failure.code, failure.message, failure.details ?? body);
	}

	async function decode(response: Response, endpoint: AnyEndpoint): Promise<unknown> {
		switch (endpoint.response ?? "json") {
			case "response":
				return response;
			case "stream":
				return response.body ?? new Response("").body;
			case "bytes":
				return new Uint8Array(await response.arrayBuffer());
			case "text":
				return check(endpoint, declared(endpoint, await response.text()));
			case "none":
				await response.body?.cancel();
				return undefined;
			default: {
				if (response.status === 204) return check(endpoint, declared(endpoint, undefined));
				const text = await response.text();
				const body = text === "" ? undefined : JSON.parse(text);
				return check(endpoint, declared(endpoint, body));
			}
		}
	}

	function check(endpoint: AnyEndpoint, value: unknown): unknown {
		if (!endpoint.output) return value;
		try {
			return endpoint.output.parse(value);
		} catch (error) {
			if (error instanceof ValidationError) {
				throw new ServiceError(
					"invalid",
					`${endpoint.verb} ${endpoint.path} answered with an unexpected shape: ${error.message}`,
					error.issues,
				);
			}
			throw error;
		}
	}

	function validate(endpoint: AnyEndpoint, input: unknown): unknown {
		if (!endpoint.input) return undefined;
		try {
			return endpoint.input.parse(input);
		} catch (error) {
			if (error instanceof ValidationError) {
				throw new ServiceError("invalid", error.message, error.issues);
			}
			throw error;
		}
	}

	return nest<RemoteClient<R>>((path) => {
		const info = byPath.get(path);
		if (!info) return () => {};
		const { endpoint, verb } = info;

		const origin = ABSOLUTE_RE.test(endpoint.path) ? "" : api.url;

		const request = (raw?: unknown) => {
			const parsed = validate(endpoint, raw);
			const { path: filled, rest } = fillPath(endpoint.path, parsed ?? raw);
			const target = `${origin}${filled}`;
			const sendsBody = SENDS_BODY.has(verb) && endpoint.body !== "none";

			return sendsBody
				? { url: target, ...encodeBody(endpoint, rest) }
				: { url: `${target}${queryString(endpoint, rest, target)}`, body: null };
		};

		const url = (raw?: unknown) => request(raw).url;

		const call = async (raw?: unknown, callOptions?: CallOptions) => {
			const { url, body, type } = request(raw) as
				& { url: string; body: BodyInit | null }
				& { type?: string };

			const response = await fetchFor(callOptions)(url, {
				method: verb,
				headers: computeHeaders(endpoint, type ? { "content-type": type } : undefined, callOptions),
				body,
				signal: callSignal(callOptions, timeout),
			});
			if (!response.ok && endpoint.response !== "response") throw await fail(response, info);

			return await decode(response, endpoint);
		};

		if (endpoint.streaming) {
			const open = (raw?: unknown, callOptions?: CallOptions) => {
				const controller = new AbortController();
				const signal = callSignal(callOptions, undefined, controller.signal);

				const iterator = (async function* () {
					const response = await fetchFor(callOptions)(url(raw), {
						method: verb,
						headers: computeHeaders(endpoint, { accept: "text/event-stream" }, callOptions),
						signal,
					});
					
					if (!response.ok) throw await fail(response, info);
					if (!response.body) return;
					
					const asText = endpoint.response === "text";
					for await (const data of consume(response.body)) {
						yield check(endpoint, asText ? data : JSON.parse(data));
					}
				})();
				
				return Object.assign({ [Symbol.asyncIterator]: () => iterator }, {
					close: () => controller.abort(),
				});
			};
			return Object.assign(open, { path, url });
		}

		return Object.assign(call, {
			path,
			url,
			form: (formOptions?: { multipart?: boolean }): FormBinding<unknown> =>
				formBinding(url(), verb === "GET" ? "get" : "post", formOptions),
			async attempt(raw?: unknown, callOptions?: CallOptions) {
				try {
					return { ok: true as const, value: await call(raw, callOptions) };
				} catch (error) {
					return { ok: false as const, error: asServiceError(error) };
				}
			},
		});
	}, (path) => byPath.has(path));
}
