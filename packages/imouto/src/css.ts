/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { jsx } from "@july/snarl/jsx-runtime";
import type { Context, JSX } from "@july/snarl";
import { markStyleUsed, scopeCss, styleRegistry } from "@404/varnish";
import { getContext } from "./context.ts";
import { boring } from "./hash/mod.ts";
import { log } from "@july/snarl/verbosity";

export type CssCollisionPolicy = "throw" | "warn" | "ignore";

export interface Css {
	/**
	 * creates a scoped stylesheet from a CSS string

	 * @example
	 * ```js
	 * const root = css`
	 *   :scope { display: flex; }
	 *   &.active { outline: 1px solid; }
	 *   .title { font-size: 2rem; }
	 * `;
	 *
	 * function Greet() {
	 *   return <div class={root}><h1 class="title">Hello</h1></div>;
	 * }
	 * ```
	 */
	<const S extends string>(
		strings: TemplateStringsArray | S,
		...values: unknown[]
	): ScopedStyles;
}

/** a scoped stylesheet object */
export interface ScopedStyles {
	/** the unique scope identifier applied to the root element */
	readonly id: string;

	/** coerces to the scope class name and auto-registers for injection */
	toString(): string;

	/** :3 */
	readonly raw: string;

	/** mark this stylesheet as used for the current request */
	use(ctx?: Context): void;
}

const stylesheetProto = Object.create(null, {
	toString: {
		enumerable: false,
		writable: false,
		value(this: ScopedStyles): string {
			const ctx = getContext();
			if (ctx) markStyleUsed(ctx, this.id);
			return this.id;
		},
	},
});

export interface CssConfig {
	hash: (input: string) => string;

	/**
	 * what to do when two different source strings hash to the same
	 * scope. `"throw"` (default) fails fast; `"warn"` logs and keeps
	 * the first-registered stylesheet */
	onCollision?: CssCollisionPolicy;
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
	& {
		[K in keyof HTMLElementTagNameMap]: ScopedComponent;
	}
	& {
		readonly styled: StyledFactory;
	};

export interface CssTag {
	(strings: TemplateStringsArray, ...values: unknown[]): ScopedStyleSheet;
}

const ROOT_TAGS = new Set(["html", "body", "head"]);
const isRootTag = (tag: string): boolean => ROOT_TAGS.has(tag);
const rootScopeKey = (scope: string): string => `${scope}__root`;

function interpolate(strings: TemplateStringsArray, values: unknown[]): string {
	return strings.reduce<string>((acc, str, i) => acc + str + (values[i] ?? ""), "").trim();
}

function registerScope(scope: string, source: string, onCollision: CssCollisionPolicy): void {
	const existing = styleRegistry.get(scope);
	if (existing === source) return;

	if (existing !== undefined && onCollision !== "ignore") {
		const message = `imouto: CSS hash collision for scope "${scope}"`;
		if (onCollision === "throw") throw new Error(message);
		if (onCollision === "warn") log.warn(message);
	}

	styleRegistry.set(scope, source);
}

function createComponent(tag: string, scope: string, registryKey: string): ScopedComponent {
	return function TagComponent(props: Record<string, unknown> = {}) {
		const ctx = getContext();
		if (ctx) markStyleUsed(ctx, registryKey);

		const { class: className, ...rest } = props;
		const appliedScope = isRootTag(tag) ? undefined : scope;
		return jsx(tag, {
			...rest,
			class: appliedScope ? (className ? `${appliedScope} ${className}` : appliedScope) : className,
		});
	};
}

function createStyledComponent(
	tag: string,
	src: string,
	scope: string,
	onCollision: CssCollisionPolicy,
): ScopedComponent {
	const root = isRootTag(tag);
	const registryKey = root ? rootScopeKey(scope) : scope;
	registerScope(registryKey, scopeCss(src, root ? "" : `.${scope}`), onCollision);
	return createComponent(tag, scope, registryKey);
}

/** builds a `.styled.tag\`...\`` factory */
function buildStyledFactory(baseSrc: string | undefined, config: CssConfig): StyledFactory {
	const { hash: hashFn, onCollision = "throw" } = config;

	return new Proxy({} as StyledFactory, {
		get(_target, property: string) {
			const tag = property.toLowerCase();
			return (strings: TemplateStringsArray, ...values: unknown[]) => {
				const own = interpolate(strings, values);
				const combined = baseSrc ? `${baseSrc} ${own}` : own;
				const scope = hashFn(combined);
				return createStyledComponent(tag, combined, scope, onCollision);
			};
		},
	});
}

function createScopedStyles(src: string, config: CssConfig): ScopedStyleSheet {
	const { hash: hashFn, onCollision = "throw" } = config;

	const scope = hashFn(src);
	registerScope(scope, scopeCss(src, `.${scope}`), onCollision);

	const styledFactory = buildStyledFactory(src, config);

	const componentProxy = new Proxy(
		Object.create(stylesheetProto, {
			id: { value: scope, enumerable: true },
			use: {
				value: function (ctx?: Context) {
					const resolved = ctx ?? getContext();
					if (!resolved) throw new Error("css.use(): no request context available");
					markStyleUsed(resolved, scope);
				},
			},
			raw: { value: src, enumerable: false },
			styled: { value: styledFactory, enumerable: true },
		}),
		{
			get(target, tag: string) {
				if (tag in target) return (target as any)[tag];
				return createStyledComponent(tag, src, scope, onCollision);
			},
		},
	);

	return componentProxy as ScopedStyleSheet;
}

export function createStyles(
	config: CssConfig = { hash: boring },
): { css: CssTag; styled: StyledFactory } {
	function cssTag(strings: TemplateStringsArray, ...values: unknown[]): ScopedStyleSheet {
		return createScopedStyles(interpolate(strings, values), config);
	}

	return { css: cssTag, styled: buildStyledFactory(undefined, config) };
}

let defaultHash: CssConfig["hash"] = boring;
let defaultOnCollision: CssCollisionPolicy = "throw";
let cachedInstance = createStyles({ hash: defaultHash, onCollision: defaultOnCollision });

export function configureDefaultCss(config: Partial<CssConfig>): void {
	if (config.hash) defaultHash = config.hash;
	if (config.onCollision) defaultOnCollision = config.onCollision;
	cachedInstance = createStyles({ hash: defaultHash, onCollision: defaultOnCollision });
}

export const css: CssTag = (strings, ...values) => cachedInstance.css(strings, ...values);
export const styled: StyledFactory = new Proxy({} as StyledFactory, {
	get: (_t, prop: string) => cachedInstance.styled[prop as keyof StyledFactory],
});
