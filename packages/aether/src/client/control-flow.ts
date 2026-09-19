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
import { toNodes } from "./jsx-runtime.ts";
import type { JSX } from "./jsx-runtime.ts";
import {
	claimBlock,
	expandBlocks,
	isHydrating,
	reconcileRange,
	registerBlock,
	removeNodes,
	reportMismatch,
} from "./hydration.ts";

interface Block {
	end: Comment;
	/** holds the anchors (and content) until the parent inserts them somewhere real */
	holder: DocumentFragment;
	/** what the block returns to its parent */
	result: JSX.Element;
}

function createBlock(kind: string): Block {
	const start = document.createComment(kind);
	const end = document.createComment(`/${kind}`);
	const holder = document.createDocumentFragment();
	holder.append(start, end);
	registerBlock(start, end, holder);
	return { end, holder, result: isHydrating() ? [start, end] : holder };
}

/** swaps in the server's anchors. must run after the block's first effect run */
function adoptBlock(block: Block, kind: string, content: readonly Node[]): void {
	const claimed = claimBlock(kind);
	if (!claimed) {
		reportMismatch(`no server markers for <${kind}>`);
		return;
	}
	const [start, end] = claimed;
	block.holder.replaceChildren();
	registerBlock(start, end, block.holder);
	block.end = end;
	block.result = [start, end];
	reconcileRange(start, end, content);
}

function place(block: Block, nodes: readonly Node[]): void {
	const end = block.end;
	const parent = end.parentNode ?? block.holder;
	let cursor: Node = end;
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i];
		if (node.nextSibling !== cursor) parent.insertBefore(node, cursor);
		cursor = node;
	}
}

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
	const block = createBlock("for");
	const entries = new Map<string | number, Entry<T>>();
	let hydrating = isHydrating();
	let initial: Node[] | undefined;

	const owner = getActiveSub();
	const render = (item: T, index: Signal<number>): Pick<Entry<T>, "nodes" | "dispose"> => {
		const previous = setActiveSub(owner);
		try {
			let nodes: Node[] = [];
			const dispose = effectScope(() => {
				nodes = toNodes(props.children(item, () => index()));
			});
			return { nodes, dispose };
		} finally {
			setActiveSub(previous);
		}
	};

	effect(() => {
		const items = readEach(props.each);
		const seen = new Set<string | number>();
		const ordered: Entry<T>[] = [];

		for (let i = 0; i < items.length; i++) {
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
					removeNodes(entry.nodes);
					Object.assign(entry, render(item, entry.index));
					entry.item = item;
				}
			}
			ordered.push(entry);
		}

		for (const [key, entry] of entries) {
			if (seen.has(key)) continue;
			entry.dispose();
			removeNodes(entry.nodes);
			entries.delete(key);
		}

		if (hydrating) {
			hydrating = false;
			initial = ordered.flatMap((entry) => entry.nodes);
			return;
		}

		place(block, ordered.flatMap((entry) => expandBlocks(entry.nodes)));
	});

	if (initial) adoptBlock(block, "for", initial);
	return block.result;
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
	const block = createBlock("show");
	let hydrating = isHydrating();
	let initial: Node[] | undefined;
	let currentNodes: Node[] = [];

	effect(() => {
		const condition = typeof props.when === "function" ? (props.when as () => T)() : props.when;

		removeNodes(currentNodes);

		const branch = condition
			? (typeof props.children === "function"
				? (props.children as (v: NonNullable<T>) => JSX.Node)(condition as NonNullable<T>)
				: props.children)
			: props.fallback;

		currentNodes = toNodes(branch);

		if (hydrating) {
			hydrating = false;
			initial = currentNodes;
			return;
		}

		place(block, expandBlocks(currentNodes));
	});

	if (initial) adoptBlock(block, "show", initial);
	return block.result;
}
