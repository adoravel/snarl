/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { compose, createContext, ErrorHandler, Handler, Middleware } from "./middleware.ts";
import { HttpError, httpMethods, Method, ParametersOf, PreciseURLPattern } from "./utils.ts";

export interface Route<P extends string> {
	readonly pattern: PreciseURLPattern<P>;
	handler: Handler<ParametersOf<P>>;
	method: Method;
	metadata?: RouteMetadata;
}

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
	onNotFound: Handler<Record<PropertyKey, never>>;
}

interface Router {
	routes: Route<any>[];
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

export function createRouter(baseConfig: Partial<RouterConfig> = {}): ExtendedRouter {
	const routes: Route<any>[] = [];
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

			routes.push({
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

			routes.push(...groupRouter.routes);
			return r as ExtendedRouter;
		},
		allRoutes() {
			return routes.map((route) => ({
				method: route.method,
				pattern: route.pattern,
				metadata: route.metadata,
			}));
		},
		async fetch(request, info): Promise<Response> {
			const method = request.method.toUpperCase() as Method;
			const requestId = request.headers.get("X-Request-ID") || crypto.randomUUID();

			try {
				for (const route of routes) {
					if (route.method !== method) continue;

					const match = route.pattern.exec(request.url);
					if (!match) continue;

					const ctx = createContext(
						request,
						info,
						(match.pathname.groups || {}) as any,
						requestId,
					);

					try {
						const result = await compose(middlewares, route.handler)(ctx);
						return result || new Response("", { status: 200 });
					} catch (err) {
						if (err instanceof HttpError) {
							return ctx.json(
								{ error: err.message },
								{ status: err.status, headers: err.headers },
							);
						}
						throw err;
					}
				}

				return await config.onNotFound(createContext(request, info, {} as any)) ??
					new Response("Not Found", { status: 404 });
			} catch (e) {
				return await config.onError(e as Error, createContext(request, info, {} as any));
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
