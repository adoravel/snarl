/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

// deno-fmt-ignore
export const voidTags: Set<string> = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input",
	"link", "meta", "param", "source", "track", "wbr",
]);

// deno-fmt-ignore
const ESC_LUT: Record<string, string> = {
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const ESC_RE = /[&<>"']/g;

export const Fragment = Symbol("jsx.fragment") as any as JsxElement;

export type Component<P = Props> = (props: P) => JsxElement | Promise<JsxElement>;

export type JsxElement = string;

type Props = {
	children?: JsxElement | JsxElement[];
	dangerouslySetInnerHTML?: { __html: string };
	[key: string]: unknown;
};

export const jsxEscape = (input: string): string =>
	typeof input !== "string" ? input : input.replace(ESC_RE, (c) => ESC_LUT[c]);

export function jsxAttr(k: string, v: unknown): string {
	if (v == null || v === false) return "";
	if (v === true) return ` ${k}`;

	if (k === "style" && typeof v === "object" && !Array.isArray(v)) {
		const style = Object.entries(v as Record<string, string | number>)
			.map(([key, val]) => {
				key = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
				return `${key}:${val}`;
			})
			.join(";");
		return style ? ` style="${style}"` : "";
	}

	if (k.startsWith("on")) return "";
	return ` ${k}="${jsxEscape(String(v))}"`;
}

function render(node: any): string | Promise<string> {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string") return node;

	if (node instanceof Promise) {
		return node.then(render);
	}

	if (typeof node === "function") return render(node());
	if (Array.isArray(node)) {
		let hasPromise = false;
		const mapped = node.map((child) => {
			const res = render(child);
			if (res instanceof Promise) hasPromise = true;
			return res;
		});
		if (hasPromise) {
			return Promise.all(mapped).then((parts) => parts.join(""));
		}
		return (mapped as string[]).join("");
	}

	return jsxEscape(String(node));
}

export function jsxTemplate(template: string[], ...values: unknown[]): string {
	let html = "";
	for (let i = 0; i < template.length; i++) {
		html += template[i];
		if (i < values.length) html += render(values[i]);
	}
	return html;
}

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

	let html = `<${tag}`;
	for (const name in attrs) {
		html += jsxAttr(name, attrs[name]);
	}

	const isVoid = voidTags.has(tag);
	html += isVoid ? "/>" : ">";

	if (!isVoid) {
		const inner = render(children);
		if (inner instanceof Promise) {
			return inner.then((c) => html + (dangerouslySetInnerHTML?.__html ?? c) + `</${tag}>`);
		}
		html += dangerouslySetInnerHTML?.__html ?? inner;
		html += `</${tag}>`;
	}
	return html;
}
