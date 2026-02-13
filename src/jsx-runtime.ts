/**
 * @module jsx-runtime
 * Minimal async-aware, JSX `precompile` renderer.
 */

/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

// deno-fmt-ignore
export const voidTags: ReadonlySet<string> = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input",
	"link", "meta", "param", "source", "track", "wbr",
]);

// deno-fmt-ignore
const ESC_LUT: Record<string, string> = {
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const ESC_RE = /[&<>"']/g;

export const Fragment = Symbol("jsx.fragment");

export type Component<P = Props> = (props: P) => JsxElement;

export type JsxElement = string | Promise<string>;

type Props = {
	children?: JsxElement | JsxElement[];
	dangerouslySetInnerHTML?: { __html: string };
	[key: string]: unknown;
};

function escape(input: string): string {
	return input.replace(ESC_RE, (c) => ESC_LUT[c]);
}

export const jsxEscape = (input: unknown): string => input == null ? "" : String(input);

export function jsxAttr(k: string, v: unknown): string {
	if (v == null || v === false) return "";
	if (v === true) return ` ${k}`;

	if (k === "style" && typeof v === "object" && !Array.isArray(v)) {
		const style = Object.entries(v as Record<string, string | number>)
			.map(([key, val]) => {
				key = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
				return `${key}:${escape(String(val))}`;
			})
			.join(";");
		return style ? ` style="${style}"` : "";
	}

	if (k.startsWith("on")) return "";
	return ` ${k}="${escape(String(v))}"`;
}

function render(node: any): string | Promise<string> {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string") return node;

	if (node instanceof Promise) {
		return node.then((v) => render(v));
	}

	if (Array.isArray(node)) {
		let html = "";

		for (let i = 0; i < node.length; i++) {
			const r = render(node[i]);
			if (r instanceof Promise) {
				return continueArrayAsync(html, node, i, r);
			}
			html += r;
		}

		return html;
	}

	return escape(String(node));
}

async function continueArrayAsync(
	html: string,
	node: unknown[],
	index: number,
	firstPromise: Promise<string>,
): Promise<string> {
	html += await firstPromise;

	for (let i = index + 1; i < node.length; i++) {
		html += await render(node[i]);
	}

	return html;
}

export function jsxTemplate(
	template: string[],
	...values: unknown[]
): string | Promise<string> {
	let html = "";

	for (let i = 0; i < template.length; i++) {
		html += template[i];

		if (i < values.length) {
			const r = render(values[i]);

			if (r instanceof Promise) {
				return continueAsync(html, template, values, i, r);
			}
			html += r;
		}
	}

	return html;
}

function continueAsync(
	html: string,
	template: string[],
	values: unknown[],
	index: number,
	firstPromise: Promise<string>,
): Promise<string> {
	return (async () => {
		html += await firstPromise;

		for (let i = index + 1; i < template.length; i++) {
			html += template[i];

			if (i < values.length) {
				html += await render(values[i]);
			}
		}

		return html;
	})();
}

/**
 * jsx factory function
 * @template P compoonent properties parameter
 * @param tag the element tag type (e.g., `div`, `span`, or a Component function)
 * @param props the attributes and children of the element
 * @returns either the rendered html string or a `Promise` resolving to one
 */
export function jsx<P extends Props = Props>(
	tag: string | Component<P> | typeof Fragment,
	props: P | null = {} as P,
): string | Promise<string> {
	props ??= {} as P;
	const { children, dangerouslySetInnerHTML, ...attrs } = props;

	if (tag === Fragment) return render(children);
	if (typeof tag === "function") {
		const result = tag(props);
		return result instanceof Promise ? result.then(render) : render(result);
	}

	if (typeof tag !== "string") {
		throw new TypeError("invalid jsx tag");
	}

	let html = `<${tag}`;
	for (const name in attrs) {
		html += jsxAttr(name, attrs[name]);
	}
	html += ">";

	if (!voidTags.has(tag)) {
		const inner = render(children);
		if (inner instanceof Promise) {
			return closeAsync(html, inner, dangerouslySetInnerHTML, tag);
		}
		if (dangerouslySetInnerHTML?.__html && children != null) {
			throw new Error("cannot use both children and dangerouslySetInnerHTML");
		}
		html += dangerouslySetInnerHTML?.__html ?? inner;
		html += `</${tag}>`;
	}
	return html;
}

async function closeAsync(
	html: string,
	inner: Promise<string>,
	dangerouslySetInnerHTML: { __html: string } | undefined,
	tag: string,
): Promise<string> {
	const c = await inner;
	return html + (dangerouslySetInnerHTML?.__html ?? c) + `</${tag}>`;
}

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

export declare namespace JSX {
	/** defines valid JSX elements */
	export type ElementType =
		| keyof IntrinsicElements
		| Component<any>;

	export interface ElementChildrenAttribute {
		// deno-lint-ignore ban-types
		children: {};
	}

	/** type definitions for intrinsic HTML and SVG elements */
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
