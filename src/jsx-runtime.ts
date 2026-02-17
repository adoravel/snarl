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
const ESC_RE = /[&<>"']/;

const enum EscapeLut {
	AMP = 38,
	LESS_THAN = 60,
	GREATER_THAN = 62,
	DOUBLE_QUOTE = 34,
	SINGLE_QUOTE = 39,
}

interface Html {
	__html?: string;
}

export const Fragment = Symbol("jsx.fragment");
const jsxBrand = Symbol.for("jsx.element");

export interface JsxElement {
	readonly [jsxBrand]: true;
	readonly tag: string | Component | typeof Fragment;
	readonly props: Props;
}

export type Component<P extends Props = Props> = (props: P) => JsxNode;

export type JsxNode = string | number | boolean | null | undefined | JsxElement | JsxNode[] | Promise<JsxNode>;

type Props = {
	children?: JsxElement | JsxElement[];
	dangerouslySetInnerHTML?: { __html: string };
	[key: string]: unknown;
};

const prototype: Pick<JsxElement, typeof jsxBrand> = Object.create(null, {
	[jsxBrand]: { value: true, enumerable: false, writable: false },
	toString: {
		value: function () {
			return renderTrusted(this);
		},
	},
});

function isJsxElement(value: unknown): value is JsxElement {
	return typeof value === "object" && value != null && jsxBrand in value;
}

function ignore(value: unknown): value is undefined | null | false {
	return value == null || value === undefined || value === false;
}

function encode(str: string): string {
	if (!str.length || !ESC_RE.test(str)) return str;

	let out = "", last = 0;

	for (let i = 0; i < str.length; i++) {
		let esc: string;

		// deno-fmt-ignore
		switch (str.charCodeAt(i)) {
			case EscapeLut.AMP:          esc = "&amp;";  break;
			case EscapeLut.LESS_THAN:    esc = "&lt;";   break;
			case EscapeLut.GREATER_THAN: esc = "&gt;";   break;
			case EscapeLut.DOUBLE_QUOTE: esc = "&quot;"; break;
			case EscapeLut.SINGLE_QUOTE: esc = "&#39;";  break;
			default: continue;
		}

		if (i !== last) out += str.slice(last, i);
		out += esc, last = i + 1;
	}

	return last === 0 ? str : out + str.slice(last);
}

export function jsxEscape(value: unknown): string | Promise<string> {
	if (ignore(value)) return "";
	if (Array.isArray(value)) return renderTrustedArray(value);

	switch (typeof value) {
		case "string":
			return encode(value);
		case "object":
			if ("__html" in value) {
				return (value as Html).__html ?? "";
			}
			if (isJsxElement(value)) {
				return renderJsx(value);
			}
			break;
		case "number":
		case "boolean":
			return value.toString();
	}

	return value as string;
}

export function jsxAttr(k: string, v: unknown): string {
	if (v == null || v === false) return "";
	if (v === true) return ` ${k}`;

	if (k === "style" && typeof v === "object" && !Array.isArray(v)) {
		const css = renderStyle(v as Record<string, string | number>);
		return css ? ` style="${css}"` : "";
	}

	if (k.startsWith("on")) return "";
	return ` ${k}="${encode(String(v))}"`;
}

function renderStyle(style: Record<string, string | number>): string {
	let css = "";

	for (const key in style) {
		const val = style[key];
		if (val == null) continue;
		const prop = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
		css += `${prop}:${encode(String(val))};`;
	}
	return css;
}

function renderTrusted(node: unknown): string | Promise<string> {
	if (node == null || node === false || node === true) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);

	if (node instanceof Promise) {
		return node.then((v) => renderTrusted(v));
	}
	if (Array.isArray(node)) {
		return renderTrustedArray(node);
	}
	if (isJsxElement(node)) {
		return renderJsx(node);
	}
	if (typeof node === "object" && "__html" in node) {
		return (node as Html).__html!;
	}

	return String(node);
}

function renderTrustedArray(nodes: unknown[]): string | Promise<string> {
	let html = "";

	for (let i = 0; i < nodes.length; i++) {
		const r = renderTrusted(nodes[i]);

		if (r instanceof Promise) {
			return continueArrayAsync(html, nodes, i, r);
		}
		html += r;
	}

	return html;
}

async function continueArrayAsync(
	html: string,
	node: unknown[],
	index: number,
	firstPromise: Promise<string>,
): Promise<string> {
	html += await firstPromise;
	for (let i = index + 1; i < node.length; i++) {
		html += await renderTrusted(node[i]);
	}
	return html;
}

export function jsxTemplate(
	template: string[],
	...values: unknown[]
): string | Promise<string> {
	let html = template[0];

	for (let i = 0; i < values.length; i++) {
		const r = renderTrusted(values[i]);

		if (r instanceof Promise) {
			return continueAsync(html, template, values, i, r);
		}

		html += r + template[i + 1];
	}

	return html;
}

async function continueAsync(
	html: string,
	template: string[],
	values: unknown[],
	index: number,
	pending: Promise<string>,
): Promise<string> {
	html += await pending;
	html += template[index + 1];

	for (let i = index + 1; i < values.length; i++) {
		html += await renderTrusted(values[i] as JsxNode);
		html += template[i + 1];
	}

	return html;
}

/**
 * jsx factory function
 * @template P compoonent properties parameter
 * @param tag the element tag type (e.g., `div`, `span`, or a Component function)
 * @param props the attributes and children of the element
 * @returns either the rendered html string or a `Promise` resolving to one
 */
export function jsx<P extends Props = Props>(tag: JsxElement["tag"], props: P | null = {} as P): JsxElement {
	const el = Object.create(prototype);
	el.tag = tag;
	el.props = props ?? {};
	return el;
}

function renderJsx(element: JsxElement): string | Promise<string> {
	const { tag, props } = element;
	const { children, dangerouslySetInnerHTML, ...attrs } = props;

	if (tag === Fragment) return renderTrusted(children);
	if (typeof tag === "function") {
		const result = tag(props as any);

		if (result instanceof Promise) {
			return result.then((r) => ignore(r) ? "" : typeof r === "string" ? r : renderJsx(r as JsxElement));
		}
		return ignore(result) ? "" : typeof result === "string" ? result : renderJsx(result as JsxElement);
	}

	if (typeof tag !== "string") {
		throw new TypeError("invalid jsx tag");
	}

	let html = `<${tag}`;
	for (const name in attrs) {
		html += jsxAttr(name, attrs[name]);
	}
	html += ">";

	if (voidTags.has(tag)) return html;

	if (dangerouslySetInnerHTML != null && children != null) {
		throw new Error("cannot use both children and dangerouslySetInnerHTML");
	}
	if (dangerouslySetInnerHTML != null) {
		return html + dangerouslySetInnerHTML.__html + `</${tag}>`;
	}

	const inner = renderTrusted(children);
	if (inner instanceof Promise) {
		return inner.then((c) => html + c + `</${tag}>`);
	}
	return html + inner + `</${tag}>`;
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
		dangerouslySetInnerHTML?: Html;
		children?: any;
		key?: string;
		charset?: string;
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

export { jsx as jsxDEV, jsx as jsxs };
