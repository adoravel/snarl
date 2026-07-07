/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { compose, Context, ErrorHandler, Handler, Middleware } from "@july/snarl";
import { httpMethods, Method, ParametersOf, PreciseURLPattern, ReplaceReturnType, url } from "./types.ts";
import { HttpError } from "./errors.ts";

export interface Route<P extends string> {
	readonly pattern: PreciseURLPattern<P>;
	handler: Handler<ParametersOf<P>>;
	method: Method;
	metadata?: RouteMetadata;
}

/**
 * metadata that can be attached to routes for documentation
 */
export interface RouteMetadata {
	description?: string;
	tags?: string[];
	deprecated?: boolean;
	params?: Record<string, { type: string; description?: string }>;
	responses?: Record<number, { description: string }>;
}

type Params<P> = P extends PreciseURLPattern<any> ? ParametersOf<P["raw"]>
	: P extends string ? ParametersOf<P>
	: P extends URLPattern ? Record<string, string>
	: never;

interface RouterConfig {
	prefix?: string;
	onError: ErrorHandler;
	onNotFound: ReplaceReturnType<Handler<Record<PropertyKey, never>>, Response | Promise<Response>>;
	onListen?: Parameters<typeof Deno.serve>[0]["onListen"];
}

interface Router {
	routes: Record<Method, Route<any>[]>;
	middlewares: Middleware[];
	config: RouterConfig;

	use: (...middlewares: (Middleware | Middleware[])[]) => this;

	on<P extends string | PreciseURLPattern<any> | URLPattern>(
		method: Method,
		path: P,
		handler: Handler<Params<P>>,
		metadata?: RouteMetadata,
	): void;

	group(prefix: string, configure: (router: HttpRouter) => void): this;

	fetch(
		request: Request,
		info: Deno.ServeHandlerInfo<Deno.NetAddr>,
	): Promise<Response>;

	allRoutes(): Array<{
		method: Method;
		pattern: Route<any>["pattern"];
		metadata?: RouteMetadata;
	}>;

	serve(options?: Deno.ServeTcpOptions): ReturnType<typeof Deno.serve>;
}

/**
 * the extended router interface that includes convenience methods (`GET`, `POST`, etc.)
 */
type HttpRouter =
	& Router
	& {
		[M in Method as Lowercase<M>]: <
			P extends string | PreciseURLPattern<any> | URLPattern,
		>(
			path: P,
			handler: Handler<Params<P>>,
			metadata?: RouteMetadata,
		) => Router;
	}
	& {
		/**
		 * registers a handler for all supported HTTP methods
		 */
		all<P extends string | PreciseURLPattern<any> | URLPattern>(
			path: P,
			handler: Handler<Params<P>>,
			metadata?: RouteMetadata,
		): Router;
	};

const enum NodeType {
	STATIC = 0,
	PARAM = 1,
	WILDCARD = 2,
}

interface RadixNode {
	type: NodeType;
	segment: string;
	optional: boolean;
	children: Map<string, RadixNode>;
	paramChild: RadixNode | null;
	wildcardChild: RadixNode | null;
	handler: Handler<any> | null;
	route: Route<any> | null;
}

function createNode(type: NodeType, segment: string, optional = false): RadixNode {
	return {
		type,
		segment,
		optional,
		children: new Map(),
		paramChild: null,
		wildcardChild: null,
		handler: null,
		route: null,
	};
}

function insertRoute(root: RadixNode, pattern: string, handler: Handler<any>, route: Route<any>) {
	const segments = pattern.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
	let node = root;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		let child: RadixNode | null = null;

		if (seg.startsWith("*")) {
			if (!node.wildcardChild) {
				const name = seg.length > 1 ? seg.slice(1) : "*";
				node.wildcardChild = createNode(NodeType.WILDCARD, name);
			}
			child = node.wildcardChild;
		} else if (seg.startsWith(":")) {
			const optional = seg.endsWith("?");
			const paramName = optional ? seg.slice(1, -1) : seg.slice(1);
			if (!node.paramChild) {
				node.paramChild = createNode(NodeType.PARAM, paramName, optional);
			}
			child = node.paramChild;
		} else {
			child = node.children.get(seg) ?? null;
			if (!child) {
				child = createNode(NodeType.STATIC, seg);
				node.children.set(seg, child);
			}
		}

		if (!child) break;
		node = child;
	}

	node.handler = handler;
	node.route = route;
}

function matchRoute(
	node: RadixNode,
	segments: string[],
	idx: number,
	params: Record<string, string>,
): { handler: Handler<any>; route: Route<any>; params?: Record<string, string> } | null {
	if (idx >= segments.length) {
		if (node.handler && node.route) {
			return { handler: node.handler, route: node.route };
		}
		if (node.wildcardChild) {
			const wc = node.wildcardChild;
			params[wc.segment] = "";
			if (wc.handler && wc.route) return { handler: wc.handler, route: wc.route };
		}
		let pc = node.paramChild;
		while (pc && pc.optional) {
			if (pc.handler && pc.route) return { handler: pc.handler, route: pc.route };
			pc = pc.paramChild;
		}
		return null;
	}

	const seg = segments[idx];

	const staticChild = node.children.get(seg);
	if (staticChild) {
		const result = matchRoute(staticChild, segments, idx + 1, params);
		if (result) return result;
	}

	if (node.paramChild) {
		const pc = node.paramChild;
		let decoded = seg;
		if (seg.indexOf("%") !== -1) {
			try {
				decoded = decodeURIComponent(seg);
			} catch {
				decoded = seg;
			}
		}

		params[pc.segment] = decoded;
		const result = matchRoute(pc, segments, idx + 1, params);
		if (result) return result;
		delete params[pc.segment];

		if (pc.optional) {
			const skipResult = matchRoute(pc, segments, idx, params);
			if (skipResult) return skipResult;
		}
	}

	if (node.wildcardChild) {
		const wc = node.wildcardChild;
		const remaining = idx < segments.length ? segments.slice(idx).join("/") : "";
		params[wc.segment] = remaining;
		if (wc.handler && wc.route) return { handler: wc.handler, route: wc.route };
	}

	return null;
}

function extractPattern(pattern: string | PreciseURLPattern<any> | URLPattern): string {
	if (typeof pattern === "string") return pattern;
	return (pattern as PreciseURLPattern<any>).raw ?? pattern.pathname;
}

const EMPTY_200 = new Response(null, { status: 200 });

/**
 * creates a new `Router` instance
 * @param baseConfig optional configuration for the router
 */
export function createRouter(baseConfig: Partial<RouterConfig> = {}): HttpRouter {
	const routes = Object.fromEntries(httpMethods.map((m) => [m, []])) as unknown as Record<
		Method,
		Route<any>[]
	>;

	const trees: Record<Method, RadixNode> = Object.fromEntries(
		httpMethods.map((m) => [m, createNode(NodeType.STATIC, "")]),
	) as Record<Method, RadixNode>;

	const exactRoutes: Record<Method, Record<string, Route<any>>> = Object.fromEntries(
		httpMethods.map((m) => [m, {}]),
	) as Record<Method, Record<string, Route<any>>>;

	let requestId = crypto.getRandomValues(new Uint32Array(1))[0];
	const nextRequestId = () => {
		requestId ^= requestId << 13;
		requestId ^= requestId >>> 17;
		requestId ^= requestId << 5;
		return (requestId >>> 0).toString(36).padStart(6, "0");
	};

	const middlewares: Middleware[] = [];
	const config = baseConfig as RouterConfig;
	const composedCache = new WeakMap<Handler<any>, Handler<any>>();
	let composedNotFound: Handler<any> | null = null;

	config.prefix ??= "";
	config.onError ??= (error, ctx) => (console.error("route error", error),
		ctx.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		));
	config.onNotFound ??= (ctx) =>
		ctx.json(
			{ error: "Not Found", path: ctx.url.pathname },
			{ status: 404 },
		);

	const r: Partial<HttpRouter> = {
		routes,
		middlewares,
		config,
		use(...mw: (Middleware | Middleware[])[]) {
			middlewares.push(...mw.flat());
			return r as HttpRouter;
		},
		on<P extends string | PreciseURLPattern<any> | URLPattern>(
			method: Method,
			path: P,
			handler: Handler<Params<P>>,
			metadata?: RouteMetadata,
		) {
			const base = extractPattern(path);
			const pathname = encodeURI(config.prefix + "/" + base).replace(/\/+/g, "/");

			const pattern = url({ pathname });
			const route: Route<any> = {
				method,
				pattern,
				handler: handler as any,
				metadata,
			};

			routes[method].push(route);
			insertRoute(trees[method], pathname, handler, route);
			if (!base.includes(":") && !base.includes("*") && !base.includes("?")) {
				exactRoutes[method][pathname] = route;
			}

			return r;
		},
		all<P extends string | PreciseURLPattern<any> | URLPattern>(
			path: P,
			handler: Handler<Params<P>>,
			metadata?: RouteMetadata,
		) {
			for (const method of httpMethods) {
				r.on!(method, path, handler, metadata);
			}
			return r as HttpRouter;
		},
		group(prefix, configure) {
			const subRouter = createRouter({
				...config,
				prefix: (config.prefix + prefix).replace(/\/+/g, "/"),
			});
			configure(subRouter);

			for (const method of httpMethods) {
				for (const route of subRouter.routes[method] ?? []) {
					if (subRouter.middlewares.length > 0) {
						route.handler = compose(subRouter.middlewares, route.handler);
					}
					routes[method].push(route);

					const pattern = extractPattern(route.pattern);
					insertRoute(trees[method], pattern, route.handler, route);
					if (!pattern.includes(":") && !pattern.includes("*") && !pattern.includes("?")) {
						exactRoutes[method][pattern] = route;
					}
				}
			}
			return r as HttpRouter;
		},
		allRoutes() {
			return httpMethods.flatMap((method) =>
				routes[method].map((route) => ({
					method,
					pattern: route.pattern,
					metadata: route.metadata,
				}))
			);
		},
		async fetch(request, info): Promise<Response> {
			composedNotFound ??= middlewares.length ? compose(middlewares, config.onNotFound) : config.onNotFound;

			const method = request.method.toUpperCase() as Method;
			const requestId = nextRequestId();

			const url = new URL(request.url);
			const pathname = url.pathname;

			const exact = exactRoutes[method]?.[pathname];
			let match: ReturnType<typeof matchRoute> | null = null;

			if (exact) {
				match = { handler: exact.handler, route: exact };
			} else if (method === "HEAD") {
				const getExact = exactRoutes["GET"]?.[pathname];
				if (getExact) {
					match = { handler: getExact.handler, route: getExact };
				}
			}

			if (!match) {
				const segments = pathname === "/" ? [] : pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
				const params = Object.create(null);
				const result = matchRoute(trees[method], segments, 0, params);
				if (result) {
					match = { handler: result.handler, params, route: result.route };
				} else if (method === "HEAD") {
					const resultHead = matchRoute(trees["GET"], segments, 0, params);
					if (resultHead) {
						match = { handler: resultHead.handler, params, route: resultHead.route };
					}
				}
			}

			let ctx: Context<any> | null = null;
			try {
				ctx = new Context(
					request,
					url,
					info,
					match?.params ?? {},
					requestId,
				);

				let handler: Handler<any>;
				if (!middlewares.length) {
					handler = match ? match.route.handler : config.onNotFound;
				} else if (!match) {
					handler = composedNotFound;
				} else {
					let cached = composedCache.get(match.route.handler);
					if (!cached) {
						composedCache.set(match.route.handler, cached = compose(middlewares, match.route.handler));
					}
					handler = cached;
				}
				const response = await handler(ctx);

				if (method === "HEAD" && response?.body) {
					return new Response(null, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				}
				return response ?? EMPTY_200;
			} catch (err) {
				ctx ??= new Context(request, url, info, {} as any, requestId);
				if (err instanceof HttpError) {
					return ctx.json(
						{ error: err.message },
						{ status: err.status, headers: err.headers },
					);
				}
				return await config.onError(err as Error, ctx);
			}
		},
		serve(opts) {
			opts ??= {} as unknown as typeof opts;
			if (r.config) {
				opts!.onListen ??= r.config?.onListen;
			}
			return Deno.serve(opts!, r.fetch!);
		},
	};

	httpMethods.forEach(
		(method) => {
			const lower = method.toLowerCase() as Lowercase<Method>;
			(r as any)[lower] = <P extends string>(
				path: P,
				handler: Handler<Params<P>>,
				metadata?: RouteMetadata,
			) => r.on!(method as Method, path, handler, metadata);
		},
	);

	return r as HttpRouter;
}

export type { HttpRouter as Router };
