/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { boring } from "@404/imouto/hash";
import { type JSX, jsx } from "./jsx-runtime.ts";

export interface ScopedStyles {
	readonly id: string;
	toString(): string;

	use(): void;
}

export type ScopedComponent = (props: Record<string, unknown>) => JSX.Element;

export type StyledFactory = Record<
	string,
	(strings: TemplateStringsArray, ...values: unknown[]) => ScopedComponent
>;

export type ScopedStyleSheet =
	& ScopedStyles
	& Record<string, ScopedComponent>
	& { readonly styled: StyledFactory };

function templateToSource(strings: TemplateStringsArray, values: unknown[]): string {
	return strings.reduce<string>((acc, str, i) => acc + str + (values[i] ?? ""), "").trim();
}

const CSS_ROUTE = "/_css/";

let loaded: Set<string> | undefined;

export function ensureStyles(scope: string): void {
	if (!loaded) {
		loaded = new Set();
		const links = document.querySelectorAll<HTMLLinkElement>(
			`link[rel="stylesheet"][href^="${CSS_ROUTE}"]`,
		);
		for (const link of links) {
			const href = link.getAttribute("href")!;
			if (href.endsWith(".css")) loaded.add(href.slice(CSS_ROUTE.length, -4));
		}
	}

	if (loaded.has(scope)) return;
	loaded.add(scope);

	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = `${CSS_ROUTE}${scope}.css`;

	document.head.append(link);
}

function createComponent(tag: string, scope: string): ScopedComponent {
	return function TagComponent(props: Record<string, unknown> = {}) {
		ensureStyles(scope);
		const { class: className, ...rest } = props;
		return jsx(tag, {
			...rest,
			class: className ? `${scope ? `${scope} ` : ""}${className}` : scope,
		}) as JSX.Element;
	};
}

function createScopedStyles(src: string): ScopedStyleSheet {
	const scope = boring(src);

	const styledFactory = new Proxy({} as StyledFactory, {
		get(_target, property: string) {
			const tag = property.toLowerCase();
			return (strings: TemplateStringsArray, ...values: unknown[]) => {
				const combined = `${src} ${templateToSource(strings, values)}`;
				return createComponent(tag, boring(combined));
			};
		},
	});

	const use = () => ensureStyles(scope);
	return new Proxy(
		{ id: scope, toString: () => (use(), scope), use, styled: styledFactory },
		{
			get(target, tag: string | symbol) {
				if (typeof tag !== "string" || tag in target) return (target as any)[tag];
				return createComponent(tag, scope);
			},
		},
	) as ScopedStyleSheet;
}

export interface CssTag {
	(strings: TemplateStringsArray, ...values: unknown[]): ScopedStyleSheet;
}

export const css: CssTag = (strings, ...values) =>
	createScopedStyles(templateToSource(strings, values));

export const styled: StyledFactory = new Proxy({} as StyledFactory, {
	get(_target, property: string) {
		const tag = property.toLowerCase();
		return (strings: TemplateStringsArray, ...values: unknown[]) => {
			const src = templateToSource(strings, values);
			return createComponent(tag, boring(src));
		};
	},
});
