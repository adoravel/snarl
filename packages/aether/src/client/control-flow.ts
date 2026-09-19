/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import {
	type Dispose,
	effect,
	effectScope,
	getActiveSub,
	setActiveSub,
	type Signal,
	signal,
} from "../reactivity/mod.ts";
import { normaliseChildren } from "./jsx-runtime.ts";
import type { JSX } from "./jsx-runtime.ts";

export interface ForProps<T> {
	/** the list to render */
	each: T[] | (() => T[]);

	/** stable identity per item. matches old/new DOM nodes across renders instead of rebuilding everything */
	key: (item: T, index: number) => string | number;

	/**
	 * renders one item. `index` is a live accessor reflecting this item's
	 * *current* position. it can change on reorder without the item
	 * itself re-rendering.
	 */
	children: (item: T, index: () => number) => JSX.Node;
}

interface Entry<T> {
	item: T;
	index: Signal<number>;
	nodes: Node[];
	dispose: Dispose;
}

function readEach<T>(each: ForProps<T>["each"]): T[] {
	return typeof each === "function" ? each() : each;
}

/**
 * keyed list rendering with DOM node reuse.
 *
 * @example
 * ```tsx
 * const todos = signal([{ id: 1, text: meow" }, { id: 2, text: "mrrp" }]);
 * <ul>
 *   <For each={todos} key={(t) => t.id}>
 *     {(todo) => <li>{todo.text}</li>}
 *   </For>
 * </ul>
 * ```
 */
export function For<T>(props: ForProps<T>): JSX.Element {
	const startAnchor = document.createComment("for");
	const endAnchor = document.createComment("/for");
	const frag = document.createDocumentFragment();
	frag.append(startAnchor, endAnchor);

	const entries = new Map<string | number, Entry<T>>();
	const owner = getActiveSub();

	const render = (item: T, index: Signal<number>): Pick<Entry<T>, "nodes" | "dispose"> => {
		const previous = setActiveSub(owner);
		try {
			let nodes: Node[] = [];
			const dispose = effectScope(() => {
				nodes = normaliseChildren(props.children(item, () => index())) as Node[];
			});
			return { nodes, dispose };
		} finally {
			setActiveSub(previous);
		}
	};

	effect(() => {
		const items = readEach(props.each);
		const seen = new Set<string | number>();
		let cursor: Node = endAnchor;

		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			const key = props.key(item, i);

			if (seen.has(key)) {
				console.warn(
					`aether: <For> found a duplicate key ${
						JSON.stringify(key)
					}. later duplicates are skipped`,
				);
				continue;
			}
			seen.add(key);

			let entry = entries.get(key);
			if (!entry) {
				const index = signal(i);
				entry = { item, index, ...render(item, index) };
				entries.set(key, entry);
			} else {
				entry.index(i);
				if (!Object.is(entry.item, item)) {
					entry.dispose();
					for (const node of entry.nodes) node.parentNode?.removeChild(node);
					Object.assign(entry, render(item, entry.index));
					entry.item = item;
				}
			}

			for (let j = entry.nodes.length - 1; j >= 0; j--) {
				const node = entry.nodes[j];
				if (node.nextSibling !== cursor) {
					(cursor.parentNode ?? frag).insertBefore(node, cursor);
				}
				cursor = node;
			}
		}

		for (const [key, entry] of entries) {
			if (seen.has(key)) continue;
			entry.dispose();
			for (const node of entry.nodes) node.parentNode?.removeChild(node);
			entries.delete(key);
		}
	});

	return frag as unknown as JSX.Element;
}

export interface ShowProps<T = unknown> {
	/** the condition. a signal/computed re-evaluates reactively */
	when: T | (() => T);

	/** rendered when `when` is falsy. omit for nothing */
	fallback?: JSX.Node;

	/** rendered when `when` is truthy */
	children: JSX.Node | ((value: NonNullable<T>) => JSX.Node);
}

/**
 * conditional rendering that swaps branches in place.
 */
export function Show<T>(props: ShowProps<T>): JSX.Element {
	const endAnchor = document.createComment("/show");
	const frag = document.createDocumentFragment();
	frag.append(document.createComment("show"), endAnchor);

	let currentNodes: Node[] = [];

	effect(() => {
		const condition = typeof props.when === "function" ? (props.when as () => T)() : props.when;

		for (const node of currentNodes) node?.parentNode?.removeChild(node);

		const branch = condition
			? (typeof props.children === "function"
				? (props.children as (v: NonNullable<T>) => JSX.Node)(condition as NonNullable<T>)
				: props.children)
			: props.fallback;

		currentNodes = normaliseChildren(branch) as Node[];
		const parent = endAnchor.parentNode ?? frag;
		for (const node of currentNodes) parent.insertBefore(node, endAnchor);
	});

	return frag as unknown as JSX.Element;
}
