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
 * metadata that can be attached to routes for documentation (usually openapi)
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
	};

function findRoute(routes: Route<any>[], url: string): { route: Route<any>; params: Record<string, string> } | null {
	for (const route of routes) {
		const match = route.pattern.exec(url);
		if (match) {
			const params = (match.pathname.groups || {}) as Record<string, string>;

			for (const [key, value] of Object.entries(params)) {
				try {
					params[key] = decodeURIComponent(value);
				} catch (_e) {
					// no-op
				}
			}

			return { route, params };
		}
	}
	return null;
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

	const r: Router = {
		routes,
		middlewares,
		config,
		use(...mw) {
			middlewares.push(...mw);
			return r as ExtendedRouter;
		},
		on(method, path, handler, metadata) {
			const pathname = typeof path === "string" ? (config.prefix + path) : path;

			routes[method].push({
				method,
				pattern: typeof pathname !== "string" ? pathname : new URLPattern({ pathname }) as any,
				handler: handler as any,
				metadata,
			});
			return r as ExtendedRouter;
		},
		group(prefix, configure) {
			const groupRouter = createRouter({
				...config,
				prefix: config.prefix + prefix,
			});
			configure(groupRouter);

			for (const m of httpMethods) {
				const groupRoutes = groupRouter.routes[m] ?? [];
				routes[m].push(...groupRoutes);
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
			const requestId = request.headers.get("X-Request-ID") || crypto.randomUUID();

			if (method === "HEAD" && routes["HEAD"].length === 0) {
				method = "GET";
			}

			let ctx: ReturnType<typeof createContext<any>>;
			try {
				const match = findRoute(routes[method], request.url);

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
			) => r.on(method as Method, path, handler, metadata);
		},
	);
	return r as ExtendedRouter;
}

export type { ExtendedRouter as Router };
