/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

/// <reference types="@july/snarl/jsx-runtime" />

import type { Component } from "@july/snarl/jsx-runtime";

type CSSProperties =
	& {
		[K in keyof CSSStyleDeclaration]?: CSSStyleDeclaration[K] extends string ? string | number
			: never;
	}
	& {
		[key: `--${string}`]: string | number;
		[key: `-webkit-${string}`]: string | number;
		[key: `-moz-${string}`]: string | number;
		[key: `-ms-${string}`]: string | number;
	};

type HTMLAttributeMap<T = HTMLElement> = Partial<
	Omit<T, keyof Element | "children" | "style" | "href"> & {
		style?: string | CSSProperties;
		class?: string;
		dangerouslySetInnerHTML?: { __html: string };
		children?: any;
		href: string | SVGAnimatedString;
		[key: `data-${string}`]: string | number | boolean | null | undefined;
		[key: `aria-${string}`]: string | number | boolean | null | undefined;
		[key: `on${string}`]: string | ((e: Event) => void);
	}
>;

declare global {
	namespace JSX {
		export type ElementType =
			| keyof IntrinsicElements
			| Component<any>;

		export interface ElementChildrenAttribute {
			// deno-lint-ignore ban-types
			children: {};
		}

		export type IntrinsicElements =
			& {
				[K in keyof HTMLElementTagNameMap]: HTMLAttributeMap<
					HTMLElementTagNameMap[K]
				>;
			}
			& {
				[K in keyof SVGElementTagNameMap]: HTMLAttributeMap<
					SVGElementTagNameMap[K]
				>;
			};
	}
}
