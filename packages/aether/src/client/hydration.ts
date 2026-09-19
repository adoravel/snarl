/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

interface Hydration {
	/** elements under the island root in post-order */
	elements: Element[];
	next: number;

	closers: Map<string, Comment[]>;
	consumed: Map<string, number>;
	openers: Map<Comment, Comment>;

	mismatch: string | null;
}

let current: Hydration | null = null;

interface BlockRange {
	end: Comment;
	/** where the block's range is parked whilst it's out of the document */
	holder: DocumentFragment;
}

const blocks = new WeakMap<Comment, BlockRange>();

export function isHydrating(): boolean {
	return current !== null;
}

export function registerBlock(start: Comment, end: Comment, holder: DocumentFragment): void {
	blocks.set(start, { end, holder });
}

export function blockEnd(node: Node): Comment | undefined {
	return node.nodeType === Node.COMMENT_NODE ? blocks.get(node as Comment)?.end : undefined;
}

/** the live `[start, ...content, end]` range of one block */
function blockRange(start: Comment, end: Comment): Node[] {
	const out: Node[] = [start];
	let cursor = start.nextSibling;
	while (cursor && cursor !== end) {
		out.push(cursor);
		cursor = cursor.nextSibling;
	}
	if (cursor === end) out.push(end);
	return out;
}

export function expandBlocks(nodes: readonly Node[]): Node[] {
	const out: Node[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const end = blockEnd(node);
		if (!end) {
			out.push(node);
			continue;
		}
		out.push(...blockRange(node as Comment, end));

		const j = nodes.indexOf(end, i + 1);
		if (j !== -1) i = j;
	}
	return out;
}

export function removeNodes(nodes: readonly Node[]): void {
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const block = node.nodeType === Node.COMMENT_NODE ? blocks.get(node as Comment) : undefined;
		if (!block) {
			node.parentNode?.removeChild(node);
			continue;
		}
		block.holder.append(...blockRange(node as Comment, block.end));
		const j = nodes.indexOf(block.end, i + 1);
		if (j !== -1) i = j;
	}
}

export function beginHydration(root: Element, skip: ReadonlySet<Node>): void {
	const elements: Element[] = [];
	const closers = new Map<string, Comment[]>();
	const openers = new Map<Comment, Comment>();
	const open = new Map<string, Comment[]>();

	(function walk(parent: Node) {
		for (let node = parent.firstChild; node; node = node.nextSibling) {
			if (skip.has(node)) continue;

			if (node.nodeType === Node.ELEMENT_NODE) {
				walk(node);
				elements.push(node as Element);
			} else if (node.nodeType === Node.COMMENT_NODE) {
				const data = (node as Comment).data;

				if (data.startsWith("/")) {
					const kind = data.slice(1);
					const opener = open.get(kind)?.pop();
					if (opener) openers.set(node as Comment, opener);
					let list = closers.get(data);
					if (!list) closers.set(data, list = []);
					list.push(node as Comment);
				} else {
					let stack = open.get(data);
					if (!stack) open.set(data, stack = []);
					stack.push(node as Comment);
				}
			}
		}
	})(root);

	current = { elements, next: 0, closers, consumed: new Map(), openers, mismatch: null };
}

export function endHydration(): string | null {
	const mismatch = current?.mismatch ?? null;
	current = null;
	return mismatch;
}

export function claimElement(tag: string, raw = false): Element | null {
	if (!current) return null;
	const { elements } = current;
	let i = current.next;
	const first = elements[i];
	if (first === undefined) return null;

	if (raw) {
		while (i < elements.length && !elements[i].contains(first)) i++;
		while (i < elements.length && elements[i].localName !== tag && elements[i].contains(first)) {
			i++;
		}
	}

	const candidate = elements[i];
	if (candidate === undefined || candidate.localName !== tag) return null;
	current.next = i + 1;
	return candidate;
}

export function claimBlock(kind: string): [start: Comment, end: Comment] | null {
	if (!current) return null;
	const closer = `/${kind}`;
	const list = current.closers.get(closer);
	const index = current.consumed.get(closer) ?? 0;
	const end = list?.[index];
	if (!end) return null;
	const start = current.openers.get(end);
	if (!start) return null;
	current.consumed.set(closer, index + 1);
	return [start, end];
}

export function reportMismatch(reason: string): void {
	if (current && current.mismatch === null) current.mismatch = reason;
}

function describe(node: Node | null): string {
	if (node === null) return "nothing";
	switch (node.nodeType) {
		case Node.ELEMENT_NODE:
			return `<${(node as Element).localName}>`;
		case Node.TEXT_NODE:
			return `text ${JSON.stringify((node as Text).data)}`;
		case Node.COMMENT_NODE:
			return `<!--${(node as Comment).data}-->`;
		default:
			return `node type ${node.nodeType}`;
	}
}

function claimText(node: Text, expected: string): boolean {
	const data = node.data;
	if (data === expected) return true;
	if (!data.startsWith(expected)) return false;
	node.splitText(expected.length);
	return true;
}

export function reconcileChildren(parent: Node, expected: readonly (Node | string)[]): void {
	reconcile(parent, parent.firstChild, null, expected);
}

export function reconcileRange(
	start: Comment,
	end: Comment,
	expected: readonly (Node | string)[],
): void {
	const parent = start.parentNode;
	if (!parent) return reportMismatch(`block <!--${start.data}--> is detached`);
	reconcile(parent, start.nextSibling, end, expected);
}

function reconcile(
	parent: Node,
	cursor: ChildNode | null,
	stop: ChildNode | null,
	expected: readonly (Node | string)[],
): void {
	if (!current) return;

	for (let i = 0; i < expected.length; i++) {
		const child = expected[i];
		const at = cursor === stop ? null : cursor;

		if (typeof child === "string") {
			if (child === "") continue;
			if (at === null || at.nodeType !== Node.TEXT_NODE || !claimText(at as Text, child)) {
				return reportMismatch(`expected text ${JSON.stringify(child)}, found ${describe(at)}`);
			}
			cursor = at.nextSibling;
			continue;
		}

		if (child.nodeType === Node.TEXT_NODE && child.parentNode !== parent) {
			const data = (child as Text).data;
			if (data === "") {
				parent.insertBefore(child, cursor);
				continue;
			}
			if (at === null || at.nodeType !== Node.TEXT_NODE || !claimText(at as Text, data)) {
				return reportMismatch(`expected text ${JSON.stringify(data)}, found ${describe(at)}`);
			}
			cursor = at.nextSibling;
			parent.replaceChild(child, at);
			continue;
		}

		if (at !== child) {
			return reportMismatch(`expected ${describe(child)}, found ${describe(at)}`);
		}

		const end = blockEnd(child);
		if (end) {
			if (end.parentNode !== parent) {
				return reportMismatch(
					`block <!--${(child as Comment).data}--> is not closed in its parent`,
				);
			}
			cursor = end.nextSibling;
			const j = expected.indexOf(end, i + 1);
			if (j !== -1) i = j;
			continue;
		}

		cursor = at.nextSibling;
	}

	if (cursor !== stop) {
		reportMismatch(`unexpected trailing ${describe(cursor)}`);
	}
}
