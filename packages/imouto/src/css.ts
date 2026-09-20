/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * @module css
 * scoped stylesheets. a `css` template compiles once at module load into
 * the registry under a content hash; rendering with it marks the sheet as
 * used on the request, and `scopedStyling()` links the sheets a page used
 * into its `<head>` and serves them at `/_css/<hash>.css`
 */

import { jsx } from "@july/snarl/jsx-runtime";
import {
	chain,
	type Context,
	type JSX,
	type Middleware,
	MiddlewarePriority,
	provideMiddleware,
} from "@july/snarl";
import { getContext } from "./context.ts";
import { boring } from "./hash/mod.ts";
import { injectIntoHead } from "./inject.ts";
import { scopeCss } from "./scope.ts";

const CSS_ROUTE_RE = /^\/_css\/([a-zA-Z0-9_-]+)\.css$/;
const USED = Symbol("imouto.styles");

/** scope hash -> compiled css, filled as `css` templates are evaluated */
export const styleRegistry: Map<string, string> = new Map();

/** marks a sheet as used on this request, so `styleScopeInjection()` links it */
export function markStyleUsed(ctx: Context<any>, hash: string): void {
	(ctx.state.getOrInsertComputed(USED, () => new Set()) as Set<string>).add(hash);
}

/** serves compiled sheets at `/_css/<hash>.css`, immutable since the hash is the content */
export function scopedCss(): Middleware {
	return (ctx, next) => {
		const hash = CSS_ROUTE_RE.exec(ctx.url.pathname)?.[1];
		const content = hash && styleRegistry.get(hash);
		if (!content) return next();

		return new Response(content, {
			headers: {
				"Content-Type": "text/css; charset=utf-8",
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	};
}

/** adds a `<link rel="stylesheet">` to html responses for every sheet the request used */
export function styleScopeInjection(): Middleware {
	return async (ctx, next) => {
		const response = await next();
		if (!response.body || !(response.headers.get("Content-Type") ?? "").includes("text/html")) {
			return response;
		}

		const used = ctx.state.get(USED) as Set<string> | undefined;
		if (used?.size) {
			let links = "";
			for (const hash of used) links += `<link rel="stylesheet" href="/_css/${hash}.css">\n`;
			injectIntoHead(ctx, links);
		}
		return response;
	};
}

/** `scopedCss()` + `styleScopeInjection()` */
export function scopedStyling(): Middleware {
	return chain(scopedCss(), styleScopeInjection());
}

provideMiddleware({
	name: "scoped-css",
	priority: MiddlewarePriority.normal,
	factory: () => scopedStyling(),
});

/** a scoped stylesheet: its class name, and components that carry it */
export interface ScopedStyles {
	/** the scope class applied to the root element */
	readonly id: string;
	/** the source css */
	readonly raw: string;
	/** coerces to the class name and marks the sheet as used */
	toString(): string;
	/** marks the sheet as used on the current (or given) request */
	use(ctx?: Context): void;
}

export type ScopedComponent = JSX.FC<{ children?: any; class?: string; [key: string]: unknown }>;

export type StyledFactory = {
	[K in keyof HTMLElementTagNameMap]: (
		strings: TemplateStringsArray,
		...values: unknown[]
	) => ScopedComponent;
};

export type ScopedStyleSheet =
	& ScopedStyles
	& { [K in keyof HTMLElementTagNameMap]: ScopedComponent }
	& { readonly styled: StyledFactory };

export interface CssTag {
	(strings: TemplateStringsArray, ...values: unknown[]): ScopedStyleSheet;
}

const ROOT_TAGS = new Set(["html", "body", "head"]);

function interpolate(strings: TemplateStringsArray, values: unknown[]): string {
	return strings.reduce<string>((acc, str, i) => acc + str + (values[i] ?? ""), "").trim();
}

function register(scope: string, compiled: string): void {
	const existing = styleRegistry.get(scope);
	if (existing !== undefined && existing !== compiled) {
		throw new Error(`imouto: css hash collision for scope "${scope}"`);
	}
	styleRegistry.set(scope, compiled);
}

function createComponent(tag: string, scope: string, registryKey: string): ScopedComponent {
	const root = ROOT_TAGS.has(tag);
	return function TagComponent(props: Record<string, unknown> = {}) {
		const ctx = getContext();
		if (ctx) markStyleUsed(ctx, registryKey);

		const { class: className, ...rest } = props;
		const classes = root ? className : className ? `${scope} ${className}` : scope;

		return jsx(tag, { ...rest, class: classes });
	};
}

function createStyledComponent(tag: string, src: string, scope: string): ScopedComponent {
	const root = ROOT_TAGS.has(tag);
	const key = root ? `${scope}__root` : scope;

	register(key, scopeCss(src, root ? "" : `.${scope}`));

	return createComponent(tag, scope, key);
}

function createStyledFactory(base?: string): StyledFactory {
	return new Proxy({} as StyledFactory, {
		get(_target, property: string) {
			const tag = property.toLowerCase();

			return (strings: TemplateStringsArray, ...values: unknown[]) => {
				const own = interpolate(strings, values);
				const src = base ? `${base} ${own}` : own;
				return createStyledComponent(tag, src, boring(src));
			};
		},
	});
}

/**
 * creates a scoped stylesheet from a css string
 *
 * @example
 * ```js
 * const root = css`
 *   :scope { display: flex; }
 *   &.active { outline: 1px solid; }
 *   .title { font-size: 2rem; }
 * `;
 *
 * function Greet() {
 *   return <root.div><h1 class="title">Hello</h1></root.div>;
 * }
 * ```
 */
export const css: CssTag = (strings, ...values) => {
	const src = interpolate(strings, values);
	const scope = boring(src);

	register(scope, scopeCss(src, `.${scope}`));

	const sheet: ScopedStyles & { styled: StyledFactory } = {
		id: scope,
		raw: src,
		styled: createStyledFactory(src),
		toString() {
			const ctx = getContext();
			if (ctx) markStyleUsed(ctx, scope);
			return scope;
		},
		use(ctx = getContext()) {
			if (!ctx) throw new Error("css.use(): no request context available");
			markStyleUsed(ctx, scope);
		},
	};

	return new Proxy(sheet, {
		get(target, tag: string | symbol) {
			if (typeof tag !== "string" || tag in target) return (target as any)[tag];
			return createStyledComponent(tag, src, scope);
		},
	}) as ScopedStyleSheet;
};

export const styled: StyledFactory = createStyledFactory();
