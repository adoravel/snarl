/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import {
	asServiceError,
	type BuiltinError,
	type Call,
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

/** `:name` in a declared path, filled from the input */
const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

export interface EndpointDefinition<S, Out, E extends readonly ErrorCode[]> {
	/** input `v` schema */
	input?: S;

	/** outpiut `v` schema */
	output?: Schema<Out, any>;

	/** the codes this endpoint raises, which the client narrows `error.code` to */
	errors?: E;

	/** sent with this endpoint only, on top of the client's own headers */
	headers?: Record<string, string>;
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
}

export type AnyEndpoint = Endpoint<any, any, ErrorCode, any, boolean>;

/** a tree of endpoints */
export interface RemoteRoutes {
	[name: string]: AnyEndpoint | RemoteRoutes;
}

type Parsed<S> = S extends Schema<any, any> ? Infer<S> : void;
type Accepts<S> = S extends Schema<any, any> ? InferInput<S> : void;

/** a call to somebody else's endpoint */
export interface RemoteCall<In, Out, Code extends ErrorCode> extends Call<In, Out, Code> {
	url(...args: [In] extends [void] ? [] : [input: In]): string;
}

export interface RemoteStream<In, Out> {
	(...args: [In] extends [void] ? [] : [input: In]): AsyncIterable<Out> & { close(): void };
	readonly path: string;
	url(...args: [In] extends [void] ? [] : [input: In]): string;
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

	/**
	 * turns somebody else's error body into a code and a message. without it
	 * the status decides the code and the body is kept as `details`
	 */
	onError?: (
		response: Response,
		body: unknown,
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
	<S extends Schema<any, any> | undefined, Out, const E extends readonly ErrorCode[] = []>(
		path: string,
		definition?: EndpointDefinition<S, Out, E>,
	): Endpoint<Parsed<S>, Awaited<Out>, E[number], Accepts<S>, Streaming>;
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
): { path: string; rest: Record<string, unknown> | undefined } {
	if (input === undefined || input === null || typeof input !== "object") {
		return { path: template, rest: undefined };
	}

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

function queryString(rest: Record<string, unknown> | undefined): string {
	if (!rest) return "";
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(rest)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) { for (const item of value) params.append(key, String(item)); }
		else params.append(key, String(value));
	}
	const query = params.toString();
	return query ? `?${query}` : "";
}

/**
 * a client for a described api. the endpoints carry their own verbs, so this
 * client is exact where one built from a type alone has to guess
 */
export function createRemoteClient<R extends RemoteRoutes>(
	api: Remote<R>,
	options: RemoteOptions = {},
): RemoteClient<R> {
	const doFetch = options.fetch ?? fetch;
	const byPath = new Map(api.list().map((info) => [info.path, info]));

	const computeHeaders = (endpoint: AnyEndpoint, extra?: Record<string, string>) => {
		const headers = new Headers(
			typeof options.headers === "function" ? options.headers() : options.headers,
		);
		for (const [name, value] of Object.entries(endpoint.headers ?? {})) headers.set(name, value);
		for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
		return headers;
	};

	async function fail(response: Response, endpoint: AnyEndpoint): Promise<ServiceError> {
		const body = await response.text().then((text) => {
			try {
				return JSON.parse(text);
			} catch {
				return text || undefined;
			}
		});
		const mapped = options.onError?.(response, body);
		if (mapped) return new ServiceError(mapped.code, mapped.message, body);

		const code = CODE_BY_STATUS.get(response.status) ?? "internal";
		const failure = new ServiceError(
			code,
			response.statusText || `${endpoint.verb} failed (${response.status})`,
			body,
		);

		failure.status = response.status;
		return failure;
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

		const request = (raw?: unknown) => {
			const parsed = validate(endpoint, raw);
			const { path: filled, rest } = fillPath(endpoint.path, parsed ?? raw);
			const sendsBody = SENDS_BODY.has(verb);
			return {
				url: `${api.url}${filled}${sendsBody ? "" : queryString(rest)}`,
				body: sendsBody && rest !== undefined ? JSON.stringify(rest) : undefined,
			};
		};

		const url = (raw?: unknown) => request(raw).url;

		const call = async (raw?: unknown) => {
			const { url, body } = request(raw);
			const response = await doFetch(url, {
				method: verb,
				headers: computeHeaders(
					endpoint,
					body ? { "content-type": "application/json" } : undefined,
				),
				body,
			});
			if (!response.ok) throw await fail(response, endpoint);
			if (response.status === 204) return check(endpoint, undefined);
			const text = await response.text();
			return check(endpoint, text === "" ? undefined : JSON.parse(text));
		};

		if (endpoint.streaming) {
			const open = (raw?: unknown) => {
				const controller = new AbortController();
				const iterator = (async function* () {
					const response = await doFetch(url(raw), {
						method: verb,
						headers: computeHeaders(endpoint, { accept: "text/event-stream" }),
						signal: controller.signal,
					});
					if (!response.ok) throw await fail(response, endpoint);
					if (!response.body) return;
					for await (const data of consume(response.body)) yield check(endpoint, JSON.parse(data));
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
			async safe(raw?: unknown) {
				try {
					return { ok: true as const, value: await call(raw) };
				} catch (error) {
					return { ok: false as const, error: asServiceError(error) };
				}
			},
		});
	}, (path) => byPath.has(path));
}
