/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { Window } from "happy-dom";

export const window = new Window({ url: "http://localhost/" });

const globals = [
	"document",
	"Node",
	"Element",
	"Text",
	"Comment",
	"DocumentFragment",
	"HTMLElement",
	"SVGElement",
	"HTMLAnchorElement",
	"HTMLInputElement",
	"HTMLTemplateElement",
	"HTMLLinkElement",
	"NodeFilter",
	"Event",
	"MouseEvent",
	"InputEvent",
	"AbortController",
] as const;

for (const name of globals) {
	if (!(name in globalThis) || name === "document") {
		Object.defineProperty(globalThis, name, {
			value: (window as any)[name],
			configurable: true,
			writable: true,
		});
	}
}

export const client = await import("@404/aether/client");
export const clientRuntime = await import("@404/aether/client/jsx-runtime");
export const server = await import("@404/aether/jsx-runtime");

/** either runtime's `jsx`, loosely typed so a tree can be built for both sides */
export type H = (tag: any, props?: any) => any;

let islandCounter = 0;

export interface Mounted {
	el: HTMLElement;
	warnings: string[];
}

export async function mountIsland<P extends Record<string, unknown>>(
	tree: (h: H, props: P) => unknown,
	options: { props?: P; html?: string; before?: (el: HTMLElement) => void } = {},
): Promise<Mounted> {
	const name = `island-${++islandCounter}`;
	const props = (options.props ?? {}) as P;

	let html = options.html;
	if (html === undefined) {
		html = await server.renderToString(tree(server.jsx, props) as any);
	}

	window.document.body.innerHTML = `<div data-x-id="${name}" data-x-props='${
		JSON.stringify(props)
	}'>${html}</div>`;
	const el = window.document.body.firstElementChild as unknown as HTMLElement;
	options.before?.(el);

	client.registerIsland(name, (p: any) => tree(client.jsx, p) as any);

	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		client.mount(window.document as unknown as Document);
	} finally {
		console.warn = warn;
	}

	return { el, warnings };
}

export function click(node: Node): void {
	node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

export function input(node: Node, value: string): void {
	(node as HTMLInputElement).value = value;
	node.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
}
