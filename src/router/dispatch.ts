/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { compose, Context, type Handler, type Middleware } from "../context/mod.ts";
import { httpMethods, type Method } from "../types.ts";
import { HttpError } from "../errors.ts";
import {
	canPossiblyMatch,
	getSegments,
	matchRoute,
	type RadixNode,
	type TreeOptions,
} from "./tree.ts";
import type { Route, RoutePayload } from "./route.ts";
import type { RouterConfig } from "./config.ts";
import { extractPathParts, hasTrailingSlash } from "./paths.ts";

const EMPTY_200 = new Response(null, { status: 200 });
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze(Object.create(null));

export interface DispatchState {
	readonly trees: Record<Method, RadixNode<RoutePayload>>;
	readonly exactRoutes: Record<Method, Record<string, Route<any>>>;
	readonly middlewares: Middleware[];
	readonly config: RouterConfig;
}

export function createRequestIdGenerator(): () => string {
	let state = crypto.getRandomValues(new Uint32Array(1))[0];
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0).toString(36).padStart(6, "0");
	};
}

type Resolved = { handler: Handler<any>; route: Route<any>; params: Record<string, string> };

function lookupMethod(
	trees: Record<Method, RadixNode<RoutePayload>>,
	exactRoutes: Record<Method, Record<string, Route<any>>>,
	method: Method,
	pathname: string,
	treeOptions: TreeOptions,
): Resolved | null {
	const exact = exactRoutes[method]?.[pathname];
	if (exact) return { handler: exact.handler, route: exact, params: EMPTY_PARAMS };

	if (pathname !== "/") {
		const caseSensitive = treeOptions.caseSensitive ?? true;
		const firstSlash = pathname.indexOf("/", 1);
		const firstSegment = firstSlash === -1 ? pathname.slice(1) : pathname.slice(1, firstSlash);

		if (!canPossiblyMatch(trees[method], firstSegment, caseSensitive)) return null;
	}

	const segments = pathname === "/"
		? []
		: getSegments(pathname, treeOptions.trailingSlashSensitive ?? false);
	const params: Record<string, string> = Object.create(null);
	const result = matchRoute(trees[method], segments, 0, params, treeOptions);

	return result ? { handler: result.payload.handler, route: result.payload.route, params } : null;
}

function resolve(
	state: DispatchState,
	treeOptions: TreeOptions,
	method: Method,
	pathname: string,
): Resolved | null {
	const primary = lookupMethod(state.trees, state.exactRoutes, method, pathname, treeOptions);
	if (primary || method !== "HEAD") return primary;

	return lookupMethod(state.trees, state.exactRoutes, "GET", pathname, treeOptions);
}

export function createDispatcher(state: DispatchState): {
	fetch: (request: Request, info: Deno.ServeHandlerInfo<Deno.NetAddr>) => Promise<Response>;
} {
	const nextRequestId = createRequestIdGenerator();
	const trailingSlashMode = state.config.trailingSlash;
	const treeOptions: TreeOptions = {
		caseSensitive: state.config.caseSensitive,
		trailingSlashSensitive: trailingSlashMode === "strict",
	};

	const composedCache = new WeakMap<Handler<any>, Handler<any>>();
	let composedNotFound: Handler<any> | null = null;

	function handlerFor(match: Resolved | null): Handler<any> {
		if (!match) {
			return composedNotFound ??= state.middlewares.length
				? compose(state.middlewares, state.config.onNotFound)
				: state.config.onNotFound;
		}
		if (!state.middlewares.length) return match.route.handler;

		return composedCache.getOrInsertComputed(
			match.route.handler,
			() => compose(state.middlewares, match.route.handler),
		);
	}

	function finishForMethod(method: Method, response: Response): Response {
		if (method !== "HEAD" || !response.body) return response;
		return new Response(null, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	function handleError(err: unknown, ctx: Context<any>): Response | Promise<Response> {
		if (err instanceof HttpError) {
			const acceptsHtml = ctx.request.headers.get("accept")?.includes("text/html");
			if (acceptsHtml) {
				const html =
					`<!DOCTYPE html><html><body><h1>${err.status} ${err.message}</h1></body></html>`;
				return new Response(html, {
					status: err.status,
					headers: { "Content-Type": "text/html; charset=utf-8", ...(err.headers || {}) },
				});
			}
			const body = err.details === undefined
				? { error: err.message }
				: { error: err.message, details: err.details };
			return ctx.json(body, { status: err.status, headers: err.headers });
		}
		return state.config.onError(err as Error, ctx);
	}

	async function fetch(
		request: Request,
		info: Deno.ServeHandlerInfo<Deno.NetAddr>,
	): Promise<Response> {
		const method = request.method.toUpperCase() as Method;
		const { pathname, search } = extractPathParts(request.url);

		const trailing = hasTrailingSlash(pathname);
		const lookupPathname = trailing && trailingSlashMode !== "strict"
			? pathname.slice(0, -1)
			: pathname;

		const match = resolve(state, treeOptions, method, lookupPathname);

		if (trailing && trailingSlashMode === "redirect" && match) {
			return new Response(null, {
				status: 308,
				headers: { Location: lookupPathname + search },
			});
		}

		let ctx: Context<any> | null = null;
		try {
			ctx = new Context(
				request,
				pathname,
				search,
				info,
				match?.params ?? EMPTY_PARAMS,
				nextRequestId,
			);

			const response = await handlerFor(match)(ctx);
			return finishForMethod(method, response ?? EMPTY_200);
		} catch (err) {
			ctx ??= new Context(request, pathname, search, info, EMPTY_PARAMS, nextRequestId);
			return handleError(err, ctx);
		}
	}

	return { fetch };
}

export function createEmptyRouteTable(): Record<Method, Route<any>[]> {
	return Object.fromEntries(httpMethods.map((m) => [m, []])) as Record<string, Route<any>[]>;
}

export function createEmptyExactTable(): Record<Method, Record<string, Route<any>>> {
	return Object.fromEntries(httpMethods.map((m) => [m, {}])) as Record<
		Method,
		Record<string, Route<any>>
	>;
}
