/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Context } from "./context/mod.ts";
import type { Router } from "./router/mod.ts";
import { HttpError } from "./errors.ts";
import { consume, sse } from "./stream.ts";
import { type Infer, type InferInput, type Schema, ValidationError } from "./validate.ts";

/** how a procedure is called, and what that implies over http */
export type Kind = "query" | "mutation" | "stream";

/**
 * why a call failed. `invalid` carries the validation issues in `details`.
 * a procedure declares the ones it raises itself so the client can narrow
 */
export type ErrorCode =
	| "bad_request"
	| "invalid"
	| "unauthorised"
	| "forbidden"
	| "not_found"
	| "conflict"
	| "payload_too_large"
	| "rate_limited"
	| "internal";

const STATUS: Record<ErrorCode, number> = {
	bad_request: 400,
	unauthorised: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	payload_too_large: 413,
	invalid: 422,
	rate_limited: 429,
	internal: 500,
};

/** @internal shared with `remote.ts` */
export const CODE_BY_STATUS: Map<number, ErrorCode> = new Map<number, ErrorCode>(
	Object.entries(STATUS).map(([code, status]) => [status, code as ErrorCode]),
);

/** codes every procedure can produce whether it declares them or not */
export type BuiltinError = "invalid" | "bad_request" | "internal";

/**
 * a failed call. `code` is the procedure's declared union plus the builtins,
 * so `if (error.code === "conflict")` is checked at compile time
 */
export class ServiceError<Code extends ErrorCode = ErrorCode> extends HttpError {
	constructor(
		readonly code: Code,
		message: string,
		override readonly details?: unknown,
	) {
		super(STATUS[code], message, undefined, details);
		this.name = "ServiceError";
	}
}

/** a value, or the error with its code */
export type ServiceResult<Out, Code extends ErrorCode> =
	| { ok: true; value: Out }
	| { ok: false; error: ServiceError<Code> };

export type ProcedureContext<In, Extra = unknown> = { input: In; ctx: Context } & Extra;

/**
 * refines the context for every procedure built from it. it either returns
 * what to add or throws, so a handler downstream of one can rely on both
 */
export type Guard<In extends object, Out extends object> = (
	args: { ctx: Context } & In,
) => Out | Promise<Out>;

/** extra route metadat */
export interface ProcedureOptions {
	/**
	 * mount at this path instead of `<prefix>/<dotted.name>`
	 */
	path?: string;

	/** sent with a successful response, e.g. `{ "Cache-Control": "max-age=60" }` */
	headers?: Record<string, string>;

	/**
	 * the status a success answers with. defaults to 200, or 204 when the handler
	 * returns nothing. `status: 201` for a procedure that creates something
	 */
	status?: number;
}

export interface Procedure<In, Out, K extends Kind, Code extends ErrorCode, Accepted = In> {
	readonly kind: K;
	readonly input?: Schema<In, Accepted>;
	readonly output?: Schema<Out, any>;
	readonly errors?: readonly Code[];
	readonly options: ProcedureOptions;

	readonly guards: readonly Guard<any, any>[];

	readonly handler: (args: any) => unknown;
}

export type AnyProcedure = Procedure<any, any, Kind, ErrorCode, any>;

export interface Routes {
	[name: string]: AnyProcedure | Routes;
}

/**
 * the parsed input, or `void` when the procedure declares no schema
 */
type Parsed<S> = S extends Schema<any, any> ? Infer<S> : void;

type Accepts<S> = S extends Schema<any, any> ? InferInput<S> : void;

type Yielded<T> = T extends AsyncIterable<infer U> ? U : T extends Iterable<infer U> ? U : never;

/** what any call takes alongside its input */
export interface CallOptions {
	/** aborts the request. composed with `timeout` when both are given */
	signal?: AbortSignal;

	/** aborts the request after this many milliseconds */
	timeout?: number;

	/** sent with this call only, on top of the client's own headers */
	headers?: HeadersInit;

	fetch?: typeof fetch;
}

/** @internal what a call is invoked with */
export type CallArgs<In> = [In] extends [void] ? [input?: void, options?: CallOptions]
	: [input: In, options?: CallOptions];

/**
 * how a call is reached. over http it can be aborted and given headers,
 * whilst in process there is no request, so it takes its input and nothing else.
 */
export type Transport = "http" | "local";

type Args<In, T extends Transport> = T extends "local" ? ([In] extends [void] ? [] : [input: In])
	: CallArgs<In>;

/** @internal the signal a call runs under */
export function callSignal(
	options: CallOptions | undefined,
	fallbackTimeout?: number,
	extra?: AbortSignal,
): AbortSignal | undefined {
	const timeout = options?.timeout ?? fallbackTimeout;
	const signals: AbortSignal[] = [];

	if (extra) signals.push(extra);
	if (options?.signal) signals.push(options.signal);
	if (timeout !== undefined) signals.push(AbortSignal.timeout(timeout));

	if (signals.length === 0) return undefined;
	return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export interface FormBinding<In> {
	action: string;
	method: "get" | "post";
	enctype: "application/x-www-form-urlencoded" | "multipart/form-data";

	fields: { [K in keyof Required<In>]-?: K & string };
}

/** a mutation */
export interface Call<In, Out, Code extends ErrorCode, T extends Transport = "http"> {
	(...args: Args<In, T>): Promise<Out>;

	/**
	 * runs the call and reports how it went instead of throwing: `{ ok: true,
	 * value }` or `{ ok: false, error }`, with `error.code` narrowed to what this
	 * procedure declares
	 */
	attempt(...args: Args<In, T>): Promise<ServiceResult<Out, Code>>;

	/** the dotted procedure name, e.g. `"posts.list"` */
	readonly path: string;

	/** attributes for an html form that posts to this procedure */
	form(options?: { multipart?: boolean }): FormBinding<In>;
}

/** a query */
export interface QueryCall<In, Out, Code extends ErrorCode, T extends Transport = "http">
	extends Call<In, Out, Code, T> {
	get(...args: Args<In, T>): Promise<Out>;
	url(...args: Args<In, T>): string;
}

/** iterate it to open the connection, `close()` to stop early */
export interface StreamCall<In, Out, T extends Transport = "http"> {
	(...args: Args<In, T>): AsyncIterable<Out> & { close(): void };
	readonly path: string;
	url(...args: Args<In, T>): string;
}

/** the callable shape of an api */
export type Client<R extends Routes, T extends Transport = "http"> = {
	[K in keyof R]: R[K] extends Procedure<any, infer Out, infer K2, infer Code, infer In>
		? K2 extends "stream" ? StreamCall<In, Yielded<Out>, T>
		: K2 extends "query" ? QueryCall<In, Out, Code | BuiltinError, T>
		: Call<In, Out, Code | BuiltinError, T>
		: R[K] extends Routes ? Client<R[K], T>
		: never;
};

/** every procedure name in the tree */
export type Paths<R extends Routes, Prefix extends string = ""> = {
	[K in keyof R & string]: R[K] extends AnyProcedure ? `${Prefix}${K}`
		: R[K] extends Routes ? Paths<R[K], `${Prefix}${K}.`>
		: never;
}[keyof R & string];

/** one mounted procedure, for introspection and for mountindg */
export interface RouteInfo {
	path: string;

	methods: ("GET" | "POST")[];

	kind: Kind;
	url: string;
	procedure: AnyProcedure;
}

export interface Service<R extends Routes> {
	readonly routes: R;

	/** where the procedures are mounted. defaults to `/api` */
	readonly prefix: string;

	/** every procedure, in declaration order */
	list(): RouteInfo[];

	/** registers a real route per procedure on `app` */
	mount(app: Router): void;

	/** calls procedures in process against `ctx` */
	caller(ctx: Context): Client<R, "local">;
}

export interface ServiceOptions {
	/** mount point for the generated routes. defaults to `/api` */
	prefix?: string;

	/** called for anything a handler throws that isn't an `ServiceError` */
	onError?: (error: unknown, path: string, ctx: Context) => void;
}

/** which verbs each kind answers on: a query is readable *and* postable */
const METHODS: Record<Kind, readonly ("GET" | "POST")[]> = {
	query: ["GET", "POST"],
	mutation: ["POST"],
	stream: ["GET"],
};

const DEFAULT_PREFIX = "/api";

/** @internal shared with `remote.ts` */
export const trimSlashes = (path: string): string => path.replace(/\/+$/, "");

function isProcedure(value: AnyProcedure | Routes): value is AnyProcedure {
	return typeof (value as AnyProcedure).handler === "function";
}

/** walks the tree once, depth first, so declaration order is the mount order */
function* walk(routes: Routes, prefix = ""): Generator<[path: string, procedure: AnyProcedure]> {
	for (const name of Object.keys(routes)) {
		const entry = routes[name];
		const path = `${prefix}${name}`;
		if (isProcedure(entry)) yield [path, entry];
		else yield* walk(entry, `${path}.`);
	}
}

/** a value a query can put in the query string as-is */
function isFlat(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean") return true;
	return Array.isArray(value) && value.every(isFlat);
}

function encodeQuery(input: unknown): string {
	if (input === undefined || input === null) return "";
	if (typeof input !== "object" || Array.isArray(input)) {
		return `?input=${encodeURIComponent(JSON.stringify(input))}`;
	}

	const entries = Object.entries(input as Record<string, unknown>);
	if (!entries.every(([, value]) => isFlat(value))) {
		return `?input=${encodeURIComponent(JSON.stringify(input))}`;
	}

	const params = new URLSearchParams();
	for (const [key, value] of entries) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) { for (const item of value) params.append(key, String(item)); }
		else params.append(key, String(value));
	}
	const query = params.toString();
	return query ? `?${query}` : "";
}

const FIELDS = new Proxy({} as Record<string, string>, {
	get: (_target, name) => typeof name === "string" ? name : undefined,
});

/** @internal shared with `remote.ts` */
export function formBinding(
	action: string,
	method: "get" | "post",
	options?: { multipart?: boolean },
): FormBinding<unknown> {
	return {
		action,
		method,
		enctype: options?.multipart ? "multipart/form-data" : "application/x-www-form-urlencoded",
		fields: FIELDS,
	};
}

async function decodeInput(ctx: Context, procedure: AnyProcedure): Promise<unknown> {
	const fromPath = ctx.params as Record<string, string>;

	if (procedure.kind === "mutation" || ctx.request.method === "POST") {
		const body = ctx.request.body === null
			? undefined
			: ctx.is(["application/x-www-form-urlencoded", "multipart/form-data"])
			? await ctx.body.form()
			: await ctx.body.json().catch(() => {
				throw new ServiceError("bad_request", "expected a json body");
			});
		return merge(fromPath, body);
	}

	const json = ctx.query.get("input");
	if (json !== null) {
		try {
			return merge(fromPath, JSON.parse(json));
		} catch {
			throw new ServiceError("bad_request", "`input` is not valid json");
		}
	}
	const flat = ctx.query.toObject();
	return merge(fromPath, Object.keys(flat).length ? flat : undefined);
}

function merge(params: Record<string, string>, input: unknown): unknown {
	if (Object.keys(params).length === 0) return input;
	if (input === undefined) return { ...params };
	if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
	return { ...params, ...input as Record<string, unknown> };
}

async function runGuards(
	procedure: AnyProcedure,
	ctx: Context,
): Promise<Record<string, unknown>> {
	if (procedure.guards.length === 0) return {};
	const extra: Record<string, unknown> = {};
	for (const guard of procedure.guards) {
		Object.assign(extra, await guard({ ctx, ...extra }));
	}
	return extra;
}

function validate(procedure: AnyProcedure, input: unknown): unknown {
	if (!procedure.input) return undefined;
	try {
		return procedure.input.parse(input);
	} catch (error) {
		if (error instanceof ValidationError) {
			throw new ServiceError("invalid", error.message, error.issues);
		}
		throw error;
	}
}

/** @internal shared with `remote.ts` */
export function asServiceError(error: unknown): ServiceError {
	if (error instanceof ServiceError) return error;
	if (error instanceof ValidationError) {
		return new ServiceError("invalid", error.message, error.issues);
	}
	if (error instanceof HttpError) {
		const code = CODE_BY_STATUS.get(error.status) ?? "internal";
		const failure = new ServiceError(code, error.message, error.details);
		failure.status = error.status;
		failure.headers = error.headers;
		return failure;
	}
	return new ServiceError("internal", "internal error");
}

const LEAF_KEYS = ["path", "url", "get", "attempt", "form"] as const;

const NEVER = new Set(["then", "catch", "finally"]);

/** * names a procedure can't have */
const RESERVED: ReadonlySet<string> = new Set([...LEAF_KEYS, ...NEVER]);

/**
 * the nested callable both halves hand out
 *
 * @param leaf builds the callable for a dotted path
 * @param onProcedure says whether a path names a procedure, when that is
 * knowable: the in-process caller knows, a client built from a type cannot
 */
export function nest<T>(
	leaf: (path: string) => unknown,
	onProcedure?: (path: string) => boolean,
	path = "",
): T {
	const target = path ? leaf(path) as object : () => {};
	const cache = new Map<string, unknown>();

	return new Proxy(target, {
		get(object, name) {
			if (typeof name !== "string") return Reflect.get(object, name);
			if (NEVER.has(name)) return undefined;

			const isLeaf = (LEAF_KEYS as readonly string[]).includes(name) && path !== "" &&
				(onProcedure ? onProcedure(path) : true);
			if (isLeaf) return Reflect.get(object, name);

			let hit = cache.get(name);
			if (hit === undefined) {
				cache.set(name, hit = nest(leaf, onProcedure, path ? `${path}.${name}` : name));
			}
			return hit;
		},
		apply(object, _this, args) {
			return (object as (...args: unknown[]) => unknown)(...args);
		},
	}) as T;
}

/**
 * declares a tree of procedures, mountable on a router and callable
 * from either side.
 */
export function service<const R extends Routes>(
	routes: R,
	options: ServiceOptions = {},
): Service<R> {
	const prefix = trimSlashes(options.prefix ?? DEFAULT_PREFIX);
	const list: RouteInfo[] = [];
	const byPath = new Map<string, RouteInfo>();

	for (const [path, procedure] of walk(routes)) {
		if (RESERVED.has(path.slice(path.lastIndexOf(".") + 1))) {
			throw new Error(
				`service: "${path}" collides with a helper on the client (${
					[...RESERVED].join(", ")
				}), so it would resolve to the helper in the browser and to the procedure on the server`,
			);
		}
		const methods = [...METHODS[procedure.kind]];
		const info: RouteInfo = {
			path,
			methods,
			kind: procedure.kind,
			url: procedure.options.path ?? `${prefix}/${path}`,
			procedure,
		};
		list.push(info);
		byPath.set(path, info);
	}

	async function serve(info: RouteInfo, ctx: Context): Promise<Response> {
		const { procedure } = info;
		try {
			const extra = await runGuards(procedure, ctx);
			const input = validate(procedure, await decodeInput(ctx, procedure));
			const result = procedure.handler({ input, ctx, ...extra });

			if (procedure.kind === "stream") {
				const source = result as AsyncIterable<unknown>;
				return sse(ctx, async function* () {
					for await (const value of source) yield { data: JSON.stringify(value ?? null) };
				}, { headers: procedure.options.headers });
			}

			const value = procedure.output ? procedure.output.parse(await result) : await result;

			const { status, headers } = procedure.options;
			if (value === undefined) {
				return new Response(null, { status: status ?? 204, headers });
			}
			return ctx.json(value, { status, headers });
		} catch (error) {
			const failure = asServiceError(error);
			if (!(error instanceof ServiceError) && !(error instanceof HttpError)) {
				options.onError?.(error, info.path, ctx);
			}
			return ctx.json({ error: failure.message, code: failure.code, details: failure.details }, {
				status: failure.status,
				headers: failure.headers,
			});
		}
	}

	return {
		routes,
		prefix,
		list: () => [...list],

		mount(app) {
			for (const info of list) {
				for (const method of info.methods) {
					app.on(method, info.url, (ctx) => serve(info, ctx), {
						description: `service ${info.kind} ${info.path}`,
						tags: ["service"],
					});
				}
			}
		},

		caller(ctx) {
			return nest<Client<R, "local">>((path) => {
				const info = byPath.get(path);
				if (!info) return () => {};
				const { procedure } = info;
				const url = (input?: unknown) =>
					procedure.kind === "mutation" ? info.url : `${info.url}${encodeQuery(input)}`;

				if (procedure.kind === "stream") {
					const open = (input?: unknown) => {
						const iterator = (async function* () {
							const extra = await runGuards(procedure, ctx);
							yield* procedure.handler({
								input: validate(procedure, input),
								ctx,
								...extra,
							}) as AsyncIterable<unknown>;
						})();
						return Object.assign({ [Symbol.asyncIterator]: () => iterator }, {
							close: () => void iterator.return(undefined),
						});
					};
					return Object.assign(open, { path, url });
				}

				const call = async (input?: unknown) => {
					const extra = await runGuards(procedure, ctx);
					const value = await procedure.handler({
						input: validate(procedure, input),
						ctx,
						...extra,
					});
					return procedure.output ? procedure.output.parse(value) : value;
				};
				return Object.assign(call, {
					path,
					url,
					get: call,
					form: (formOptions?: { multipart?: boolean }) =>
						formBinding(info.url, procedure.kind === "mutation" ? "post" : "get", formOptions),
					async attempt(input?: unknown) {
						try {
							return { ok: true as const, value: await call(input) };
						} catch (error) {
							return { ok: false as const, error: asServiceError(error) };
						}
					},
				});
			}, (path) => byPath.has(path));
		},
	};
}

interface Definition<S, Out, Extra extends object> extends ProcedureOptions {
	input?: S;

	output?: Schema<Awaited<Out>, any>;

	handler: (args: ProcedureContext<Parsed<S>, Extra>) => Out;
}

type Declared<E extends readonly ErrorCode[]> = E[number];

type WithErrors<E extends readonly ErrorCode[]> = {
	errors?: E;
};

type AnySchema = Schema<any, any> | undefined;

/**
 * builds procedures that receive more context and declare more errors
 */
export interface Builder<Extra extends object, Code extends ErrorCode> {
	/**
	 * refines the context for procedures built from the result. guards run in
	 * order before the input is validated, so authentication doesn't depend on
	 * a well-formed body
	 */
	guard<Added extends object, const E extends readonly ErrorCode[] = readonly []>(
		guard: Guard<Extra, Added>,
		errors?: E,
	): Builder<Extra & Added, Code | Declared<E>>;

	/** a `GET` */
	query<S extends AnySchema, Out, const E extends readonly ErrorCode[] = readonly []>(
		definition: Definition<S, Out, Extra> & WithErrors<E>,
	): Procedure<Parsed<S>, Awaited<Out>, "query", Code | Declared<E>, Accepts<S>>;

	/** a `POST`, from json *or* a plain form body */
	mutation<S extends AnySchema, Out, const E extends readonly ErrorCode[] = readonly []>(
		definition: Definition<S, Out, Extra> & WithErrors<E>,
	): Procedure<Parsed<S>, Awaited<Out>, "mutation", Code | Declared<E>, Accepts<S>>;

	/** an async generator, served as server-sent events */
	stream<S extends AnySchema, Out, const E extends readonly ErrorCode[] = readonly []>(
		definition: Omit<Definition<S, Out, Extra>, "output"> & WithErrors<E>,
	): Procedure<Parsed<S>, Out, "stream", Code | Declared<E>, Accepts<S>>;
}

function builder(guards: readonly Guard<any, any>[]): Builder<Empty, never> {
	const define = (kind: Kind) => (definition: Record<string, any>) => {
		const { input, output, errors, handler, ...options } = definition;
		return { kind, input, output, errors, handler, options, guards };
	};
	return {
		guard: (guard) => builder([...guards, guard]) as never,
		query: define("query") as never,
		mutation: define("mutation") as never,
		stream: define("stream") as never,
	};
}

type Empty = Record<never, never>;

const root: Builder<Empty, never> = builder([]);
service.guard = root.guard;
service.query = root.query;
service.mutation = root.mutation;
service.stream = root.stream;

export interface ClientOptions {
	/**
	 * where the api lives. a path keeps requests same-origin (the default,
	 * which is what a browser wants); an absolute url points elsewhere
	 */
	url?: string;

	/** mount point, matching the api's. defaults to `/api` */
	prefix?: string;

	/** the fetch to use. defaults to the global one */
	fetch?: typeof fetch;

	/** sent with every request, e.g. an authorization header */
	headers?: HeadersInit | (() => HeadersInit);

	/** aborts any call that takes longer than this, unless the call says otherwise */
	timeout?: number;
}

/** the same callable shape as `api.caller(ctx)`, over http */
export function createClient<S extends Service<Routes>>(
	options: ClientOptions = {},
): S extends Service<infer R> ? Client<R> : never {
	const base = trimSlashes(options.url ?? "");
	const prefix = trimSlashes(options.prefix ?? DEFAULT_PREFIX);
	const defaultFetch = options.fetch ?? fetch;
	const getFetch = (call?: CallOptions) => call?.fetch ?? defaultFetch;

	const computeHeaders = (extra?: Record<string, string>, call?: CallOptions) => {
		const headers = new Headers(
			typeof options.headers === "function" ? options.headers() : options.headers,
		);
		for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
		for (const [name, value] of new Headers(call?.headers)) headers.set(name, value);
		return headers;
	};

	async function fail(response: Response): Promise<ServiceError> {
		const fallback = CODE_BY_STATUS.get(response.status) ?? "internal";
		try {
			const body = await response.json() as { error?: string; code?: ErrorCode; details?: unknown };
			return new ServiceError(
				body.code ?? fallback,
				body.error ?? response.statusText,
				body.details,
			);
		} catch {
			return new ServiceError(
				fallback,
				response.statusText || `request failed (${response.status})`,
			);
		}
	}

	async function read(response: Response): Promise<unknown> {
		if (!response.ok) throw await fail(response);
		return response.status === 204 ? undefined : await response.json();
	}

	return nest((path) => {
		const endpoint = `${base}${prefix}/${path}`;
		const url = (input?: unknown) => `${endpoint}${encodeQuery(input)}`;

		const post = (input?: unknown, call?: CallOptions) =>
			getFetch(call)(endpoint, {
				method: "POST",
				headers: computeHeaders({ "content-type": "application/json" }, call),
				body: JSON.stringify(input ?? null),
				signal: callSignal(call, options.timeout),
			}).then(read);

		const get = (input?: unknown, call?: CallOptions) =>
			getFetch(call)(url(input), {
				headers: computeHeaders(undefined, call),
				signal: callSignal(call, options.timeout),
			}).then(read);

		async function* stream(input: unknown, signal: AbortSignal | undefined, call?: CallOptions) {
			const response = await getFetch(call)(url(input), {
				headers: computeHeaders({ accept: "text/event-stream" }, call),
				signal,
			});
			if (!response.ok) throw await fail(response);
			if (!response.body) return;
			for await (const data of consume(response.body)) yield JSON.parse(data);
		}

		const invoke = (input?: unknown, call?: CallOptions) => {
			let sent: Promise<unknown> | undefined;
			const send = () => sent ??= post(input, call);

			const controller = new AbortController();
			const signal = callSignal(call, undefined, controller.signal);

			return {
				then: (ok: any, err: any) => send().then(ok, err),
				catch: (err: any) => send().catch(err),
				finally: (fn: () => void) => send().finally(fn),
				[Symbol.asyncIterator]: () => stream(input, signal, call)[Symbol.asyncIterator](),
				close: () => controller.abort(),
			};
		};

		return Object.assign(invoke, {
			path,
			url,
			get,
			form: (formOptions?: { multipart?: boolean }) =>
				formBinding(`${base}${prefix}/${path}`, "post", formOptions),
			async attempt(input?: unknown, call?: CallOptions) {
				try {
					return { ok: true as const, value: await post(input, call) };
				} catch (error) {
					return { ok: false as const, error: asServiceError(error) };
				}
			},
		});
	}) as any;
}
