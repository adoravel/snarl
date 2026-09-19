/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { For, Show } from "./control-flow.ts";
import { type Computed, effect, isReactive, isSignal, type Signal } from "../reactivity/mod.ts";
import { claimElement, isHydrating, reconcileChildren } from "./hydration.ts";

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

const svgTags = new Set([
	"svg",
	"path",
	"circle",
	"rect",
	"line",
	"polyline",
	"polygon",
	"ellipse",
	"g",
	"defs",
	"symbol",
	"use",
	"text",
	"tspan",
	"textPath",
	"image",
	"clipPath",
	"mask",
	"pattern",
	"filter",
	"feBlend",
	"feColorMatrix",
	"feComponentTransfer",
	"feComposite",
	"feConvolveMatrix",
	"feDiffuseLighting",
	"feDisplacementMap",
	"feFlood",
	"feGaussianBlur",
	"feImage",
	"feMerge",
	"feMorphology",
	"feOffset",
	"feSpecularLighting",
	"feTile",
	"feTurbulence",
	"linearGradient",
	"radialGradient",
	"stop",
	"marker",
	"foreignObject",
]);
const SVG_NS = "http://www.w3.org/2000/svg";

export const Fragment = Symbol.for("jsx.fragment");

const ESC_RE = /[&<>"']/;
const SAFE_ATTR_RE = /^[a-zA-Z_:][-\w:.]*$/;

function encode(str: string): string {
	if (!str || !ESC_RE.test(str)) return str;
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function jsxEscape(value: unknown): string {
	if (value == null || value === false) return "";
	if (typeof value === "string") return encode(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(jsxEscape).join("");
	if (typeof value === "object" && value !== null) {
		if ("__html" in value) return (value as { __html: string }).__html ?? "";
	}
	return String(value);
}

export function jsxAttr(k: string, v: unknown): string {
	if (v == null || v === false) return "";
	if (typeof v === "function") return "";

	if (!SAFE_ATTR_RE.test(k)) {
		console.warn("aether:", `refusing to render unsafe attribute: ${k}`);
		return "";
	}

	if (v === true) return k;
	if (k === "style" && typeof v === "object" && v !== null && !Array.isArray(v)) {
		let css = "";
		for (const prop in v as Record<string, string | number>) {
			const val = (v as Record<string, string | number>)[prop];
			if (val == null) continue;
			const key = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
			css += `${key}:${encode(String(val))};`;
		}
		return css ? `style="${css}"` : "";
	}

	return `${k}="${encode(String(v))}"`;
}

export function jsxTemplate(
	template: TemplateStringsArray | string[],
	...values: unknown[]
): string {
	const len = values.length;
	if (len === 0) return template[0];
	let html = template[0];
	for (let i = 0; i < len; i++) {
		html += jsxEscape(values[i]) + template[i + 1];
	}
	return html;
}

export type Component<P extends JSX.Props = JSX.Props> = (props: P) => JSX.Node;

function createTextNode(source: () => unknown): Text {
	const node = document.createTextNode("");
	effect(() => {
		const value = source();
		if (Array.isArray(value) || value instanceof Node) {
			throw new Error(
				"aether: a signal/computed child must resolve to a primitive, not a node or array",
			);
		}
		node.data = String(value ?? "");
	});
	return node;
}

export function normaliseChildren(raw: unknown): (Node | string)[] {
	if (raw == null || raw === false || raw === true) return [];
	if (isReactive(raw)) return [createTextNode(raw as () => unknown)];
	if (Array.isArray(raw)) return raw.flatMap(normaliseChildren);
	if (raw instanceof Node) {
		if (raw.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return [...raw.childNodes];
		return [raw];
	}
	if (typeof raw === "object") return [];
	return [String(raw)];
}

export function toNodes(raw: unknown): Node[] {
	const children = normaliseChildren(raw);
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (typeof child === "string") children[i] = document.createTextNode(child);
	}
	return children as Node[];
}

function setStyleProp(el: HTMLElement | SVGElement, prop: string, v: unknown): void {
	if (v == null) {
		if (prop.startsWith("--")) el.style.removeProperty(prop);
		else (el.style as any)[prop] = "";
		return;
	}
	if (prop.startsWith("--")) el.style.setProperty(prop, String(v));
	else (el.style as any)[prop] = String(v);
}

function applyStyle(el: HTMLElement | SVGElement, value: unknown): void {
	if (typeof value === "string") return void (el.style.cssText = value);
	if (typeof value !== "object" || value === null) return;

	for (const prop in value as Record<string, unknown>) {
		const v = (value as Record<string, unknown>)[prop];
		if (isReactive(v)) {
			effect(() => setStyleProp(el, prop, (v as () => unknown)()));
			continue;
		}
		setStyleProp(el, prop, v);
	}
}

function isEventKey(key: string): boolean {
	if (key.startsWith("on:")) return true;
	return key.length > 2 && key.startsWith("on") && key[2] === key[2].toUpperCase();
}

function applyAttribute(el: HTMLElement | SVGElement, key: string, value: unknown): void {
	if (key === "class") {
		const className = value == null ? "" : String(value);
		if (el instanceof SVGElement) {
			return void el.setAttribute("class", className);
		}
		return void (el.className = className);
	}
	if (key === "style") return applyStyle(el, value);

	if (key === "href" && el instanceof HTMLAnchorElement) {
		if (value == null) el.removeAttribute("href");
		else el.href = String(value);
		return;
	}

	if (isEventKey(key)) {
		const nativeEventName = key.startsWith("on:") ? key.slice(3) : key.slice(2).toLowerCase();
		if (typeof value === "function") {
			el.addEventListener(nativeEventName, value as EventListener);
		} else if (typeof value === "string") {
			el.setAttribute("on" + nativeEventName, value);
		}
		return;
	}

	if (value == null || value === false) {
		el.removeAttribute(key);
		return;
	}
	el.setAttribute(key, value === true ? "" : String(value));
}

const TWO_WAY_EVENT: Record<string, string> = {
	value: "input",
	input: "input",
	valueAsNumber: "input",
	"value-as-number": "input",
	valueAsDate: "input",
	"value-as-date": "input",
	checked: "change",
};

const describeCounters = new Map<string, number>();

function describeElement(el: Element): string {
	const tag = el.tagName.toLowerCase();
	const id = el.getAttribute("id");

	if (id) return `<${tag} id="${id}">`;

	const name = el.getAttribute("name");
	if (name) return `<${tag} name="${name}">`;

	const seen = (describeCounters.get(tag) ?? 0) + 1;
	describeCounters.set(tag, seen);

	return `<${tag}> (#${seen} of this tag encountered so far. add an id to pin this down precisely)`;
}

function bindProp(el: HTMLElement, key: string, value: unknown, adopted: boolean): void {
	if (value == null) return;

	if (key.startsWith("bind:")) {
		const prop = key.slice(5);
		if (isSignal(value)) {
			effect(() => {
				const v = (value as any).value;
				if (prop === "checked" || prop === "value") {
					(el as any)[prop] = v;
				} else {
					el.setAttribute(prop, v === true ? "" : String(v));
				}
			});
			const handler = (e: Event) => {
				const target = e.target as any;
				(value as any).value = prop === "checked" ? target.checked : (target[prop] ?? target.value);
			};
			el.addEventListener("input", handler);
			el.addEventListener("change", handler);
		} else {
			console.warn(
				`aether: bind:${prop} on ${
					describeElement(el)
				} strictly expects a Signal. Use ${prop}={() => ...} for getters.`,
			);
		}
		return;
	}

	if (!isEventKey(key) && (isReactive(value) || typeof value === "function")) {
		return void effect(() => applyAttribute(el, key, (value as () => unknown)()));
	}

	if (adopted && typeof value !== "function") return;
	applyAttribute(el, key, value);
}

function bindTwoWay(el: HTMLElement | SVGElement, prop: string, accessor: unknown): void {
	if (!isSignal(accessor)) {
		console.warn(
			`aether: bind:${prop} on ${
				describeElement(el)
			} expects a signal (from \`signal()\`), got ${typeof accessor}. ` +
				`Use ${prop}={someComputed} for a read-only reactive value, or wrap your value in \`signal()\` first.`,
		);
		if (accessor != null) applyAttribute(el, prop, accessor);
		return;
	}
	const sig = accessor as Signal<any>;

	if (prop === "group") {
		if (!(el instanceof HTMLInputElement) || el.type !== "radio") {
			console.warn(
				`aether: bind:group on ${describeElement(el)} only supports <input type="radio">`,
			);
			return;
		}
		effect(() => void (el.checked = String(sig()) === el.value));
		el.addEventListener("change", () => el.checked && sig(el.value));
		return;
	}

	// a <select> reports its selection through `change`
	const eventName = prop === "value" && el.tagName === "SELECT" ? "change" : TWO_WAY_EVENT[prop];
	if (!eventName) {
		console.warn(
			`aether: bind:${prop} on ${
				describeElement(el)
			} is not a supported two-way binding target. Supported: ${
				Object.keys(TWO_WAY_EVENT).join(", ")
			}, group.`,
		);
		return;
	}

	effect(() => {
		const next = sig();
		(el as any)[prop] = next == null && prop === "value" ? "" : next;
	});
	el.addEventListener(eventName, () => sig((el as any)[prop]));
}

function buildElement(tag: string, props: JSX.Props): HTMLElement | SVGElement {
	const claimed = claimElement(tag, props.dangerouslySetInnerHTML != null) as
		| HTMLElement
		| SVGElement
		| null;

	const adopted = claimed !== null;
	const el = claimed ??
		(svgTags.has(tag)
			? document.createElementNS(SVG_NS, tag) as SVGElement
			: document.createElement(tag));

	const bindings: [prop: string, accessor: unknown][] = [];

	for (const key in props) {
		if (key === "children" || key === "dangerouslySetInnerHTML" || key === "key") continue;

		if (key.startsWith("bind:")) {
			bindings.push([key.slice(5), (props as Record<string, unknown>)[key]]);
			continue;
		}

		if (key.startsWith("class:")) {
			const name = key.slice(6);
			const value = (props as Record<string, unknown>)[key];
			if (isReactive(value)) {
				effect(() => void el.classList.toggle(name, Boolean((value as () => unknown)())));
			} else if (!adopted) {
				el.classList.toggle(name, Boolean(value));
			}
			continue;
		}

		bindProp(el as HTMLElement, key, (props as Record<string, unknown>)[key], adopted);
	}

	if (props.dangerouslySetInnerHTML != null) {
		if (props.children != null) {
			throw new Error("aether: cannot use both children and dangerouslySetInnerHTML");
		}
		if (!adopted) el.innerHTML = String(props.dangerouslySetInnerHTML.__html);
	} else if (!voidTags.has(tag)) {
		const children = normaliseChildren(props.children);
		if (adopted) reconcileChildren(el, children);
		else el.append(...children);
	}

	// two-way bindings go last: a <select> only accepts a value once its <option>s exist
	for (const [prop, accessor] of bindings) bindTwoWay(el, prop, accessor);
	return el;
}

export function jsx<P extends JSX.Props = JSX.Props>(
	tag: string | Component | typeof Fragment,
	props: P | null = {} as P,
	key?: string | number,
): JSX.Element {
	props ??= {} as P;
	if (key !== undefined) props = { ...props, key };

	if (tag === "for") return For(props as any);
	if (tag === "show") return Show(props as any);

	if (tag === Fragment) {
		if (isHydrating()) return toNodes(props.children);
		const frag = document.createDocumentFragment();
		frag.append(...normaliseChildren(props.children));
		return frag;
	}

	if (typeof tag === "function") {
		for (const key in props) {
			if (key.startsWith("bind:")) {
				console.warn(
					`aether: "${key}" was passed to a component, not a native DOM element. ` +
						`bind: only works on intrinsic elements like <input bind:value={sig} />`,
				);
				break;
			}
		}
		return tag(props);
	}

	return typeof tag === "string" ? buildElement(tag, props) : null;
}

export { jsx as jsxDEV, jsx as jsxs };

export declare namespace JSX {
	type Element = Node | Node[] | null;

	type FC<P extends Props = Props> = Component<P>;

	interface Props {
		children?: any;
		dangerouslySetInnerHTML?: { __html: string };
		[key: string]: unknown;
	}

	type ElementType = string | FC<any>;

	type Node =
		| string
		| number
		| boolean
		| null
		| undefined
		| globalThis.Node
		| Node[]
		| Signal<unknown>
		| Computed<unknown>
		| (() => unknown);

	interface ElementChildrenAttribute {
		// deno-lint-ignore ban-types
		children: {};
	}

	type IntrinsicAttributes = { key?: string | number };
	type IntrinsicElements = {
		[K in keyof HTMLElementTagNameMap]: {
			[key: string]: unknown;
			style?: string | Record<string, string | number>;
			class?: string;
			children?: any;
			dangerouslySetInnerHTML?: { __html: string };
			for: Parameters<typeof For<any>>[0];
			show: Parameters<typeof Show<any>>[0];
		};
	};
}
