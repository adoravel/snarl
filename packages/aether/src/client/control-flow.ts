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
import { jsx, toNodes } from "./jsx-runtime.ts";
import type { JSX } from "./jsx-runtime.ts";
import { connect, VirtualList, type VirtualOptions } from "./virtual.ts";

export type { VirtualApi, VirtualOptions } from "./virtual.ts";
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

	/**
	 * only render the items around the viewport. needs one element per item
	 * for measured sizes; see `VirtualOptions`
	 */
	virtual?: VirtualOptions<T>;
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
	if (props.virtual) return VirtualFor(props, props.virtual);

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

function spacer(height: Signal<number>, edge: "top" | "bottom"): Node {
	return jsx("div", {
		"data-x-spacer": edge,
		"aria-hidden": "true",
		style: { height: height.map((h) => `${h}px`) },
	}) as Node;
}

function VirtualFor<T>(props: ForProps<T>, options: VirtualOptions<T>): JSX.Element {
	const block = createBlock("virtual");
	const list = new VirtualList<T>(options, props.key);
	const items = signal<T[]>([]);

	effect(() => {
		const all = readEach(props.each);
		items(all);
		list.setItems(all);
	});

	const top = spacer(list.topHeight, "top");
	list.setTopSpacer(top as Element);

	const measure = () => {
		const elements: Element[] = [];
		let node = top.nextSibling;
		while (node && node !== bottom) {
			if (node.nodeType === Node.ELEMENT_NODE) elements.push(node as Element);
			node = node.nextSibling;
		}
		const { start, end } = list.window.peek();
		const slice = items.peek();
		if (elements.length !== Math.min(end, slice.length) - start) return;
		list.measure(elements.map((el, i) => [props.key(slice[start + i], start + i), el]));
	};

	const inner = For<T>({
		each: () => {
			const { start, end } = list.window();
			queueMicrotask(measure);
			return items().slice(start, end);
		},
		key: (item, i) => props.key(item, list.window.peek().start + i),
		children: (item, index) => props.children(item, () => list.window().start + index()),
	});

	const bottom = spacer(list.bottomHeight, "bottom");
	const content = [top, ...toNodes(inner), bottom];
	if (isHydrating()) adoptBlock(block, "virtual", content);
	else place(block, expandBlocks(content));

	connect(list, () => top);
	options.ref?.(list.api);

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

export interface AwaitProps<T> {
	/**
	 * the value to wait for. a function (or signal) is tracked: a new promise
	 * from it discards the pending one and shows `fallback` again
	 */
	for: Promise<T> | T | (() => Promise<T> | T);

	/** shown until the promise settles */
	fallback?: JSX.Node;

	/** rendered if the promise rejects. without it the rejection is logged and `fallback` stays */
	catch?: (error: unknown) => JSX.Node;

	/** rendered with the resolved value */
	children: (value: T) => JSX.Node;
}

export function Await<T>(props: AwaitProps<T>): JSX.Element {
	const block = createBlock("await");
	let hydrating = isHydrating();
	let initial: Node[] | undefined;
	let currentNodes: Node[] = [];
	let disposeContent: Dispose | undefined;
	let run = 0;

	const owner = getActiveSub();
	const renderOwned = (fn: () => JSX.Node): Node[] => {
		const previous = setActiveSub(owner);
		try {
			let nodes: Node[] = [];
			disposeContent = effectScope(() => {
				nodes = toNodes(fn());
			});
			return nodes;
		} finally {
			setActiveSub(previous);
		}
	};
	const swap = (nodes: Node[]) => {
		removeNodes(currentNodes);
		currentNodes = nodes;
		place(block, expandBlocks(nodes));
	};

	effect(() => {
		const source = typeof props.for === "function"
			? (props.for as () => Promise<T> | T)()
			: props.for;
		const id = ++run;

		disposeContent?.();
		disposeContent = undefined;
		removeNodes(currentNodes);
		currentNodes = toNodes(props.fallback);

		if (hydrating) {
			hydrating = false;
			initial = currentNodes;
		} else {
			place(block, expandBlocks(currentNodes));
		}

		Promise.resolve(source).then(
			(value) => {
				if (id === run) swap(renderOwned(() => props.children(value)));
			},
			(error) => {
				if (id !== run) return;
				if (props.catch) return swap(renderOwned(() => props.catch!(error)));
				console.error("aether: <await> rejected and has no `catch`:", error);
			},
		);

		return () => {
			run++;
			disposeContent?.();
			disposeContent = undefined;
		};
	});

	if (initial) adoptBlock(block, "await", initial);
	return block.result;
}
