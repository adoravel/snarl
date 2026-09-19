/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { isPromiseLike } from "../promise.ts";
import { effectScope } from "../reactivity/mod.ts";
import { deferMounts } from "../reactivity/lifecycle.ts";
import { renderAsyncSlot } from "./async-slot.ts";
import { beginHydration, endHydration, reconcileChildren } from "./hydration.ts";
import { normaliseChildren } from "./jsx-runtime.ts";

export type IslandComponent<P = Record<string, unknown>> = (props: P) => Node | Node[] | null;

const islands = new Map<string, IslandComponent<any>>();
const scopes = new WeakMap<HTMLElement, () => void>();

export function registerIsland<P = Record<string, unknown>>(
	name: string,
	component: IslandComponent<P>,
): void {
	if (islands.has(name)) throw new Error(`aether: island "${name}" is already registered`);
	islands.set(name, component);
}

function parseProps(el: HTMLElement): Record<string, unknown> {
	const raw = el.dataset.xProps;
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		console.warn(
			`aether: island "${el.dataset.xId}" has malformed data-x-props, mounting with no props`,
		);
		return {};
	}
}

interface SlotChildren {
	nodes: Node[] | undefined;
	inline: Set<Node>;
}

function extractSlotChildren(el: HTMLElement): SlotChildren {
	let template: HTMLTemplateElement | undefined;
	for (const child of el.children) {
		if (child.tagName === "TEMPLATE" && child.hasAttribute("data-x-slot")) {
			template = child as HTMLTemplateElement;
			break;
		}
	}
	template?.remove();

	const inline = new Set<Node>();
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT);
	let start: Node | null;
	while ((start = walker.nextNode())) {
		if ((start as Comment).data === "x-slot") break;
	}

	if (start) {
		let end = start.nextSibling;
		while (end && !(end.nodeType === Node.COMMENT_NODE && (end as Comment).data === "/x-slot")) {
			inline.add(end);
			end = end.nextSibling;
		}
		if (end) {
			(start as ChildNode).remove();
			end.remove();
			return { nodes: [...inline], inline };
		}
		inline.clear();
	}

	if (!template) return { nodes: undefined, inline };
	return { nodes: [...template.content.childNodes], inline };
}

interface Rendered {
	result: Node | Node[] | Promise<Node | Node[] | null> | null;
	dispose: () => void;

	/** runs the `onMount` callbacks collected during the render */
	mounted: () => void;
}

function render(component: IslandComponent<any>, props: Record<string, unknown>): Rendered {
	let result: Rendered["result"] = null;
	const [dispose, mounted] = deferMounts(() =>
		effectScope(() => {
			result = component(props);
		})
	);
	return { result, dispose, mounted };
}

function reportRenderError(name: string, err: unknown): void {
	console.error(
		`aether: island "${name}" threw during hydration and was skipped. ` +
			`Its server-rendered markup is left in place but will not be interactive.`,
		err,
	);
}

function mountOne(el: HTMLElement): void {
	const name = el.dataset.xId;
	if (!name) return;

	const component = islands.get(name);
	if (!component) {
		console.warn(
			`aether: no island registered for "${name}", leaving server-rendered markup as-is`,
		);
		return;
	}

	const slot = extractSlotChildren(el);
	const props = parseProps(el);
	if (slot.nodes !== undefined) props.children = slot.nodes;

	let rendered: Rendered | undefined;
	let adopted = false;

	if (el.firstChild !== null) {
		beginHydration(el, slot.inline);
		try {
			rendered = render(component, props);
			if (!isPromiseLike(rendered.result)) {
				reconcileChildren(el, normaliseChildren(rendered.result));
			}
		} catch (err) {
			endHydration();
			return reportRenderError(name, err);
		}

		const mismatch = endHydration();
		if (isPromiseLike(rendered.result)) {
			/* no-op */
		} else if (mismatch) {
			rendered.dispose();
			rendered = undefined;
			console.warn(
				`aether: island "${name}" couldn't adopt its server markup (${mismatch}), ` +
					`rendering it on the client instead`,
			);
		} else {
			adopted = true;
		}
	}

	if (!rendered) {
		try {
			rendered = render(component, props);
		} catch (err) {
			return reportRenderError(name, err);
		}
	}

	const { result, dispose, mounted } = rendered;
	const controller = new AbortController();
	const promiseLike = isPromiseLike(result);

	const settled: Promise<unknown> = promiseLike
		? result as unknown as Promise<unknown>
		: Promise.resolve();

	const $dispose = () => {
		controller.abort();
		settled.finally(dispose).catch(() => {});
	};
	scopes.set(el, $dispose);

	if (promiseLike) {
		const slot = renderAsyncSlot(result, {
			signal: controller.signal,
			onError: (err) => {
				console.error(`aether: island "${name}"'s async render rejected:`, err);
				return undefined;
			},
		});
		el.replaceChildren(slot);
	} else if (!adopted) {
		const resolved = result as Node | Node[] | null;
		el.replaceChildren(
			...(resolved == null ? [] : Array.isArray(resolved) ? resolved : [resolved]),
		);
	}

	el.removeAttribute("data-x-id");
	mounted();
}

/** hydrates every unhydrated `[data-x-id]` element under `root` with a registered island */
export function mount(root: ParentNode = document): void {
	const targets: HTMLElement[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

	let node: Node | null;
	while ((node = walker.nextNode())) {
		if ((node as HTMLElement).hasAttribute("data-x-id")) {
			targets.push(node as HTMLElement);
		}
	}

	for (let i = 0; i < targets.length; i++) {
		mountOne(targets[i]);
	}
}

/** disposes an island's reactive scope and clears its root. no-op if never mounted */
export function unmount(el: HTMLElement): void {
	scopes.get(el)?.();
	scopes.delete(el);
	el.replaceChildren();
}

/** `mount()` plus a `data-x` marker on `<html>`, so `[data-x-id]{visibility:hidden}` can hide islands until hydrated */
export function hydrate(root: ParentNode = document): void {
	mount(root);
	document.documentElement.setAttribute("data-x", "");
}

export * from "./control-flow.ts";
export { jsx } from "./jsx-runtime.ts";
export * from "../env.ts";
export * from "./css.ts";
