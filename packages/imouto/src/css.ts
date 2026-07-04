/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Context, type JSX, jsx } from "@july/snarl";
import { markStyleUsed, scopeCss, styleRegistry } from "@404/varnish";
import { getContext } from "./context.ts";
import meowmix0 from "./meowmix0.ts";

export interface Css {
	/**
	 * creates a scoped stylesheet from a CSS string

	 * @example
	 * ```js
	 * const root = css`
	 *   :scope { display: flex; }
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

function createComponent(tag: string, scope: string): ScopedComponent {
	return function TagComponent(props: Record<string, unknown> = {}) {
		const ctx = getContext();
		if (ctx) markStyleUsed(ctx, scope);

		if (tag === "html" || tag === "body" || tag === "head") scope = "";

		const { class: className, ...rest } = props;
		return jsx(tag, {
			...rest,
			class: className ? `${scope ? `${scope} ` : ""}${className}` : scope,
		});
	};
}

function registerScope(scope: string, compiled: string, overwrite: boolean = false): string {
	let existing = styleRegistry.get(scope);
	let attempts = 0;

	while (!overwrite && existing !== undefined && existing !== compiled) {
		if (attempts++ == 5) {
			if (Deno.env.get("ENV") !== "production") {
				console.error("@july/twist:", `css scope collision on "${scope}"`);
			}
			break;
		}

		const count = 6 + (attempts * 2);
		const bytes = new Uint8Array(count / 2);
		crypto.getRandomValues(bytes);

		scope = bytes.toHex() + scope.slice(8);
		existing = styleRegistry.get(scope);
	}

	styleRegistry.set(scope, compiled);
	return scope;
}

function createStyledComponent(tag: string, src: string, scope: string): ScopedComponent {
	const shouldIgnore = tag === "html" || tag === "body" || tag === "head";
	registerScope(scope, scopeCss(src, shouldIgnore ? "" : `.${scope}`), true);
	return createComponent(tag, scope);
}

function createScopedStyles(src: string, hashFn: CssConfig["hash"]): ScopedStyleSheet {
	let scope = hashFn(src);
	scope = registerScope(scope, scopeCss(src, `.${scope}`), true);

	const styledFactory = new Proxy({} as StyledFactory, {
		get(_target, property: string) {
			const tag = property.toLowerCase();
			return (strings: TemplateStringsArray, ...values: unknown[]) => {
				const additional = strings.reduce<string>(
					(acc, str, i) => acc + str + (values[i] ?? ""),
					"",
				).trim();
				return createStyledComponent(tag, `${src} ${additional}`, scope);
			};
		},
	});

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
				if (tag in target) return target[tag];
				if (tag === "styled") return styledFactory;
				return createStyledComponent(tag, src, scope);
			},
		},
	);

	return componentProxy as ScopedStyleSheet;
}

export function createStyles(config: CssConfig = { hash: meowmix0 }): { css: typeof cssTag; styled: StyledFactory } {
	function cssTag(strings: TemplateStringsArray, ...values: unknown[]): ScopedStyleSheet {
		const src = strings.reduce<string>(
			(acc, str, i) => acc + str + (values[i] ?? ""),
			"",
		).trim();
		return createScopedStyles(src, config.hash);
	}

	const styled = new Proxy({} as StyledFactory, {
		get(_target, property: string) {
			const tag = property.toLowerCase();
			return (strings: TemplateStringsArray, ...values: unknown[]) => {
				const src = strings.reduce<string>(
					(acc, str, i) => acc + str + (values[i] ?? ""),
					"",
				).trim();
				const styles = createScopedStyles(src, config.hash);
				return createComponent(tag, styles.id);
			};
		},
	});

	return { css: cssTag, styled };
}

const defaultCss: ReturnType<typeof createStyles> = createStyles();

export const css = defaultCss.css;
export const styled = defaultCss.styled;
