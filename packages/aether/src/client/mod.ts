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
import { normaliseChildren, toNodes } from "./jsx-runtime.ts";

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
	result: unknown;
	dispose: () => void;

	/** runs the `onMount` callbacks collected during the render */
	mounted: () => void;
}

/** anything renderable: an island component, or a page composed by the router */
export type RootComponent = (props: Record<string, unknown>) => unknown;

function render(component: RootComponent, props: Record<string, unknown>): Rendered {
	let result: unknown = null;
	const [dispose, mounted] = deferMounts(() =>
		effectScope(() => {
			result = component(props);
		})
	);
	return { result, dispose, mounted };
}

function reportRenderError(name: string, err: unknown): void {
	console.error(
		`aether: ${name} threw during hydration and was skipped. ` +
			`Its server-rendered markup is left in place but will not be interactive.`,
		err,
	);
}

export interface AttachOptions {
	/** how the root is called in warnings, e.g. `island "counter"` */
	label: string;

	/** subtrees inside the root that are adopted as-is and never claimed piecemeal */
	skip?: ReadonlySet<Node>;
}

/**
 * renders `component` into `el`: adopts the server markup already there if
 * it lines up, otherwise renders on the client and replaces it. async
 * results render into a slot. returns `null` if the component threw
 *
 * @internal shared by islands and the app root
 */
export function attach(
	el: HTMLElement,
	component: RootComponent,
	props: Record<string, unknown>,
	options: AttachOptions,
): (() => void) | null {
	const { label, skip = new Set<Node>() } = options;
	let rendered: Rendered | undefined;
	let adopted = false;

	if (el.firstChild !== null) {
		beginHydration(el, skip);
		try {
			rendered = render(component, props);
			if (!isPromiseLike(rendered.result)) {
				reconcileChildren(el, normaliseChildren(rendered.result));
			}
		} catch (err) {
			endHydration();
			reportRenderError(label, err);
			return null;
		}

		const mismatch = endHydration();
		if (isPromiseLike(rendered.result)) {
			/* nothing to adopt yet */
		} else if (mismatch) {
			rendered.dispose();
			rendered = undefined;
			console.warn(
				`aether: ${label} couldn't adopt its server markup (${mismatch}), ` +
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
			reportRenderError(label, err);
			return null;
		}
	}

	const { result, dispose, mounted } = rendered;
	const controller = new AbortController();
	const promiseLike = isPromiseLike(result);

	const settled: Promise<unknown> = promiseLike
		? result as unknown as Promise<unknown>
		: Promise.resolve();

	if (promiseLike) {
		const slot = renderAsyncSlot(
			(result as Promise<unknown>).then((value) => toNodes(value)),
			{
				signal: controller.signal,
				onError: (err) => {
					console.error(`aether: ${label}'s async render rejected:`, err);
					return undefined;
				},
			},
		);
		el.replaceChildren(slot);
	} else if (!adopted) {
		el.replaceChildren(...toNodes(result));
	}

	mounted();
	return () => {
		controller.abort();
		settled.finally(dispose).catch(() => {});
	};
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

	const dispose = attach(el, component, props, { label: `island "${name}"`, skip: slot.inline });
	if (!dispose) return;
	scopes.set(el, dispose);
	el.removeAttribute("data-x-id");
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
export * from "./router.ts";
export { jsx } from "./jsx-runtime.ts";
export * from "../env.ts";
export * from "./css.ts";
