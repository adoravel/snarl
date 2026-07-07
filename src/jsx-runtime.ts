/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

export const voidTags: ReadonlySet<string> = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

const ESC_RE = /[&<>"']/;
const SAFE_ATTR_RE = /^[a-zA-Z_:][-\w:.]*$/;
const CSS_PROP_RE = /[A-Z]/g;

const jsxBrand = Symbol.for("jsx.element");
export const Fragment = Symbol("jsx.fragment");

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

interface JsxElement {
	readonly [jsxBrand]: true;
	readonly tag: string | JsxComponent | typeof Fragment;
	readonly props: JSX.Props;
}

type JsxComponent<P extends JSX.Props = JSX.Props> = (props: P) => JSX.Node;

type JsxNode = string | number | boolean | null | undefined | JsxElement | JsxNode[] | Promise<JsxNode>;

interface JsxProps {
	children?: JSX.Node | JSX.Node[];
	dangerouslySetInnerHTML?: { __html: string };
	[key: string]: unknown;
}

const prototype: Pick<JSX.Element, typeof jsxBrand> = Object.create(null, {
	[jsxBrand]: { value: true, enumerable: false, writable: false, configurable: false },
	toString: {
		value: function (this: JSX.Element) {
			return renderTrusted(this) as string;
		},
		enumerable: false,
		writable: true,
		configurable: true,
	},
});

export function isJsxElement(value: unknown): value is JSX.Element {
	return typeof value === "object" && value != null && jsxBrand in value;
}

function isIgnorable(value: unknown): value is undefined | null | false {
	return value == null || value === false;
}

function encode(str: string): string {
	if (!str || !ESC_RE.test(str)) return str;

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
	if (isIgnorable(value)) return "";

	if (typeof value === "object" && value != null) {
		if (typeof (value as any).then === "function") {
			return (value as Promise<unknown>).then(jsxEscape);
		}
		if (Array.isArray(value)) {
			return renderTrustedArray(value);
		}
		if ("__html" in value) {
			return (value as Html).__html ?? "";
		}
		if (isJsxElement(value)) {
			return renderJsx(value);
		}
	}

	if (typeof value === "string") return encode(value);
	if (typeof value === "number" || typeof value === "boolean") return value.toString();

	return String(value);
}

export function jsxAttr(k: string, v: unknown): string {
	if (v == null || v === false) return "";
	if (!SAFE_ATTR_RE.test(k)) {
		console.warn("jsx-runtime:", `refusing to render unsafe attribute name: ${JSON.stringify(k)}`);
		return "";
	}

	if (v === true) return `${k}`;

	if (k === "style" && typeof v === "object" && v != null && !Array.isArray(v)) {
		const css = renderStyle(v as Record<string, string | number>);
		return css ? `style="${css}"` : "";
	}

	return `${k}="${encode(String(v))}"`;
}

function renderStyle(style: Record<string, string | number>): string {
	let css = "";

	for (const key in style) {
		const val = style[key];
		if (val == null) continue;

		const prop = key.replace(CSS_PROP_RE, (m) => `-${m.toLowerCase()}`);
		css += `${prop}:${encode(String(val))};`;
	}
	return css;
}

function renderTrusted(node: unknown): string | Promise<string> {
	if (typeof node === "string") return encode(node);
	if (typeof node === "number") return String(node);
	if (node == null || node === false || node === true) return "";

	if (typeof node == "object") {
		if (typeof (node as any).then === "function") {
			return (node as Promise<unknown>).then((v) => renderTrusted(v));
		}
		if (Array.isArray(node)) {
			return renderTrustedArray(node);
		}
		if (isJsxElement(node)) {
			return renderJsx(node);
		}
		if ("__html" in node) {
			return (node as Html).__html!;
		}
	}
	return String(node);
}

function renderTrustedArray(nodes: unknown[]): string | Promise<string> {
	const len = nodes.length;
	if (len === 0) return "";

	let html = "", hasAsync = false;
	const parts = new Array(len);
	for (let i = 0; i < len; i++) {
		const r = renderTrusted(nodes[i]);
		parts[i] = r;

		if (typeof r !== "string") {
			hasAsync = true;
		} else if (!hasAsync) {
			html += r;
		}
	}

	if (!hasAsync) return html;
	return Promise.all(parts).then((resolved) => resolved.join(""));
}

export function jsxTemplate(
	template: TemplateStringsArray | string[],
	...values: unknown[]
): string | Promise<string> {
	const len = values.length;
	if (len === 0) return template[0];

	let html = template[0], hasAsync = false;
	const parts = new Array(len * 2 + 1);

	parts[0] = template[0];
	for (let i = 0; i < len; i++) {
		const r = renderTrusted(values[i]);

		parts[i * 2 + 1] = r;
		parts[i * 2 + 2] = template[i + 1];

		if (typeof r !== "string") {
			hasAsync = true;
		} else if (!hasAsync) {
			html += r + template[i + 1];
		}
	}

	if (!hasAsync) return html;
	return Promise.all(parts).then((resolved) => resolved.join(""));
}

/**
 * jsx factory function
 * @template P component properties parameter
 * @param tag the element tag type (e.g., `div`, `span`, or a Component function)
 * @param props the attributes and children of the element
 * @returns either the rendered html string or a `Promise` resolving to one
 */
export function jsx<P extends JSX.Props = JSX.Props>(tag: JSX.Element["tag"], props: P | null = {} as P): JSX.Element {
	const el = Object.create(prototype);
	el.tag = tag;
	el.props = props ?? {};
	return el;
}

function renderJsx(element: JSX.Element): string | Promise<string> {
	const { tag, props } = element;

	if (tag === Fragment) {
		return props.dangerouslySetInnerHTML != null
			? String(props.dangerouslySetInnerHTML.__html)
			: renderTrusted(props.children);
	}
	if (typeof tag === "function") {
		try {
			return renderTrusted(tag(props));
		} catch (error) {
			console.error("snarl/jsx:", "error rendering component:", error);
			return `<!-- error rendering component -->`;
		}
	}

	if (typeof tag !== "string") {
		throw new TypeError(`invalid jsx tag type: ${typeof tag}`);
	}

	let html = `<${tag}`;
	for (const name in props) {
		if (name === "children" || name === "dangerouslySetInnerHTML") continue;

		if (Object.prototype.hasOwnProperty.call(props, name)) {
			html += " " + jsxAttr(name, props[name]);
		}
	}
	html += ">";

	if (voidTags.has(tag)) return html;
	if (props.dangerouslySetInnerHTML != null) {
		if (props.children != null) {
			throw new Error("cannot use both children and dangerouslySetInnerHTML");
		}
		return html + String(props.dangerouslySetInnerHTML.__html) + `</${tag}>`;
	}

	const inner = renderTrusted(props.children);
	if (typeof inner !== "string") {
		return (inner as Promise<string>).then((c) => html + c + `</${tag}>`);
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

type CoerceDOMProperty<T> = T extends string ? string
	: T extends number ? string | number
	: T extends boolean ? string | boolean
	: T extends SVGAnimatedString ? string
	: T extends SVGAnimatedLength ? string | number
	: T extends SVGAnimatedRect ? string
	// deno-lint-ignore ban-types
	: T extends Function ? string | T
	: string;

export type HTMLAttributeMap<T = HTMLElement> =
	& Omit<
		{
			[K in keyof T]?: CoerceDOMProperty<T[K]>;
		},
		keyof Element | "children" | "style" | "href"
	>
	& {
		style?: string | CSSProperties;
		class?: string;
		dangerouslySetInnerHTML?: Html;
		children?: any;
		[key: `data-${string}`]: string | number | boolean | null | undefined;
		[key: `aria-${string}`]: string | number | boolean | null | undefined;
		// deno-lint-ignore ban-types
		[key: `on${string}`]: string | Function;
		[key: string]: any;
	};

export declare namespace JSX {
	export type Element = JsxElement;
	export type Node = JsxNode;
	export type Props = JsxProps;
	export type Fragment = typeof Fragment;

	export type FC<P extends Props = Props> = JsxComponent<P>;

	/** defines valid JSX elements */
	export type ElementType =
		| keyof IntrinsicElements
		| FC<any>;

	export interface ElementChildrenAttribute {
		// deno-lint-ignore ban-types
		children: {};
	}

	export type IntrinsicAttributes = {
		key?: string | number;
	};

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

export { jsx as jsxDEV, jsx as jsxs, renderTrusted as renderToString };
