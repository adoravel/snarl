/**
 * @module router
 * The HTTP Router implementation with type-safe path parameters and middleware support.
 */

/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { compose, createContext, ErrorHandler, Handler, Middleware } from "./middleware.ts";
import { HttpError, httpMethods, Method, ParametersOf, PreciseURLPattern, ReplaceReturnType } from "./utils.ts";

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
}

interface Router {
	routes: Record<Method, Route<any>[]>;
	middlewares: Middleware[];
	config: RouterConfig;

	use: (...middlewares: Middleware[]) => this;

	on<P extends string | PreciseURLPattern<any> | URLPattern>(
		method: Method,
		path: P,
		handler: Handler<Params<P>>,
		metadata?: RouteMetadata,
	): void;

	group(prefix: string, configure: (router: Router) => void): Router;

	fetch(
		request: Request,
		info: Deno.ServeHandlerInfo<Deno.NetAddr>,
	): Promise<Response>;

	allRoutes(): Array<{
		method: Method;
		pattern: Route<any>["pattern"];
		metadata?: RouteMetadata;
	}>;
}

/**
 * the extended router interface that includes convenience methods (`GET`, `POST`, etc.).
 */
type ExtendedRouter =
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
		 * registers a handler for all supported HTTP methods.
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

interface TrieNode {
	type: NodeType;
	segment: string;
	paramName?: string;
	optional?: boolean;
	children: TrieNode[];
	handler?: Handler<any>;
	route?: Route<any>;
}

interface MatchResult {
	handler: Handler<any>;
	params: Record<string, string>;
	route: Route<any>;
}

function extractPattern(pattern: string | PreciseURLPattern<any> | URLPattern): string {
	if (typeof pattern === "string") return pattern;
	return (pattern as PreciseURLPattern<any>).raw ?? pattern.pathname;
}

function parsePattern(pattern: string): Array<{ type: NodeType; segment: string; optional: boolean }> {
	const path = pattern.replace(/^\/+|\/+$/g, "");
	if (!path) return [];

	const parts = path.split("/");
	const segments: ReturnType<typeof parsePattern> = [];

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];

		if (part === "*") {
			segments.push({ type: NodeType.WILDCARD, segment: "*", optional: false });
			break;
		} else if (part.startsWith(":")) {
			const optional = part.endsWith("?");
			const paramName = optional ? part.slice(1, -1) : part.slice(1);
			segments.push({ type: NodeType.PARAM, segment: paramName, optional });
		} else {
			segments.push({ type: NodeType.STATIC, segment: part, optional: false });
		}
	}
	return segments;
}

function insertRoute(root: TrieNode, pattern: string, handler: Handler<any>, route: Route<any>) {
	const segments = parsePattern(pattern);
	let node = root;

	for (const { type, segment, optional } of segments) {
		let child = node.children.find((c) =>
			c.type === type && (type === NodeType.STATIC ? c.segment === segment : c.paramName === segment)
		);

		if (!child) {
			child = {
				type,
				segment: type === NodeType.STATIC ? segment : "",
				paramName: type !== NodeType.STATIC ? segment : undefined,
				optional,
				children: [],
			};
			node.children.push(child);
			node.children.sort((a, b) => a.type - b.type);
		}
		node = child;
	}

	node.handler = handler;
	node.route = route;
}

function matchStatic(node: TrieNode, segments: string[], index: number): MatchResult | null {
	if (index >= segments.length) {
		return node.handler && node.route ? { handler: node.handler, params: {}, route: node.route } : null;
	}

	const segment = segments[index];

	for (let i = 0; i < node.children.length; i++) {
		const child = node.children[i];
		if (child.type === NodeType.STATIC && child.segment === segment) {
			return matchStatic(child, segments, index + 1);
		}
	}

	return null;
}

function decodeParams(params: Record<string, string>): void {
	for (const key in params) {
		const value = params[key];
		if (value.indexOf("%") !== -1) {
			try {
				params[key] = decodeURIComponent(value);
			} catch (err) {
				console.warn(`failed to decode param "${key}": ${err}`);
			}
		}
	}
}

function matchRoute(root: TrieNode, pathname: string): MatchResult | null {
	if (pathname === "/" || pathname === "") {
		return root.handler ? { handler: root.handler, params: {}, route: root.route! } : null;
	}

	const path = pathname.replace(/^\/+|\/+$/g, "");
	const segments = path.split("/");

	const $static = matchStatic(root, segments, 0);
	if ($static) return $static;

	let requiresDecoding = false;

	function search(node: TrieNode, index: number, params: Record<string, string>): MatchResult | null {
		if (index >= segments.length) {
			if (node.handler && node.route) {
				return { handler: node.handler, params, route: node.route };
			}

			for (const child of node.children) {
				if (child.optional && child.handler && child.route) {
					return { handler: child.handler, params, route: child.route };
				}
			}
			return null;
		}

		const segment = segments[index];

		for (const child of node.children) {
			if (child.type === NodeType.STATIC) {
				if (child.segment === segment) {
					const result = search(child, index + 1, params);
					if (result) return result;
				}
			} else if (child.type === NodeType.PARAM) {
				if (segment.indexOf("%") !== -1) requiresDecoding = true;

				const newParams = { ...params, [child.paramName!]: segment };
				const result = search(child, index + 1, newParams);
				if (result) return result;

				if (child.optional) {
					const skipResult = search(node, index + 1, params);
					if (skipResult) return skipResult;
				}
			} else if (child.type === NodeType.WILDCARD) {
				const wildcard = segments.slice(index).join("/");
				const newParams = { ...params, [child.paramName || "*"]: wildcard };
				return child.handler && child.route ? { handler: child.handler, params: newParams, route: child.route } : null;
			}
		}
		return null;
	}

	const result = search(root, 0, {});

	if (result && requiresDecoding) {
		decodeParams(result.params);
	}
	return result;
}

function createTrieRoot(): TrieNode {
	return {
		type: NodeType.STATIC,
		segment: "",
		children: [],
	};
}

/**
 * creates a new `Router` instance
 * @param baseConfig optional configuration for the router
 */
export function createRouter(baseConfig: Partial<RouterConfig> = {}): ExtendedRouter {
	const routes = Object.fromEntries(httpMethods.map((m) => [m, []])) as unknown as Record<
		Method,
		Route<any>[]
	>;

	const tries: Record<Method, TrieNode> = Object.fromEntries(
		httpMethods.map((m) => [m, createTrieRoot()]),
	) as Record<Method, TrieNode>;

	let requestId = 0;
	const nextRequestId = () => (++requestId).toString(36);

	const middlewares: Middleware[] = [];
	const config = baseConfig as RouterConfig;

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

	const r: Partial<ExtendedRouter> = {
		routes,
		middlewares,
		config,
		use(...mw) {
			middlewares.push(...mw);
			return r as ExtendedRouter;
		},
		on(method, path, handler, metadata) {
			const pathname = typeof path === "string" ? (config.prefix + path) : path;
			const pattern = typeof pathname !== "string" ? pathname : new URLPattern({ pathname }) as any;

			const route: Route<any> = {
				method,
				pattern,
				handler: handler as any,
				metadata,
			};

			routes[method].push(route);

			const p = extractPattern(pattern);
			insertRoute(tries[method], p, handler, route);

			return this;
		},
		all<P extends string | PreciseURLPattern<any> | URLPattern>(
			path: P,
			handler: Handler<Params<P>>,
			metadata?: RouteMetadata,
		) {
			for (const method of httpMethods) {
				r.on!(method, path, handler, metadata);
			}
			return r as ExtendedRouter;
		},
		group(prefix, configure) {
			const subRouter = createRouter({
				...config,
				prefix: config.prefix + prefix,
			});
			configure(subRouter);

			for (const method of httpMethods) {
				for (const route of subRouter.routes[method] ?? []) {
					const handler = subRouter.middlewares.length > 0
						? compose(subRouter.middlewares, route.handler)
						: route.handler;

					const r: Route<any> = {
						...route,
						handler: handler,
					};
					routes[method].push(r);

					const p = extractPattern(route.pattern);
					insertRoute(tries[method], p, handler, r);
				}
			}
			return r as ExtendedRouter;
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
			let method = request.method.toUpperCase() as Method;
			const requestId = nextRequestId();

			if (method === "HEAD" && routes["HEAD"].length === 0) {
				method = "GET";
			}

			let ctx: ReturnType<typeof createContext<any>>;
			try {
				const url = new URL(request.url);
				const match = matchRoute(tries[method], url.pathname);

				const handle: Handler<any> = async (ctx) => {
					if (match) {
						const result = await match.route.handler(ctx);
						return result || new Response("", { status: 200 });
					}
					return await config.onNotFound(ctx);
				};

				ctx = createContext(
					request,
					info,
					match?.params,
					requestId,
				);

				try {
					const response = await compose(middlewares, handle)(ctx);
					if (request.method.toUpperCase() === "HEAD" && response?.body) {
						return new Response(null, {
							status: response.status,
							statusText: response.statusText,
							headers: response.headers,
						});
					}
					return response || new Response("", { status: 200 });
				} catch (err) {
					if (err instanceof HttpError) {
						return ctx.json(
							{ error: err.message },
							{ status: err.status, headers: err.headers },
						);
					}
					throw err;
				}
			} catch (e) {
				ctx ??= createContext(request, info, {} as any, requestId);
				return await config.onError(e as Error, ctx);
			}
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
	return r as ExtendedRouter;
}

export type { ExtendedRouter as Router };
