/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { onCleanup, type Signal, signal, untracked } from "../reactivity/mod.ts";

export interface VirtualApi {
	/** scrolls so the item at `index` (or with `key`) is at the top of the viewport */
	scrollTo(target: number | string, behavior?: ScrollBehavior): void;

	/** scrolls to the end of the list */
	scrollToEnd(behavior?: ScrollBehavior): void;
}

export interface VirtualOptions<T> {
	/**
	 * height of an item in px: a number for fixed rows, or a function giving
	 * an estimate that's corrected once the item has been measured
	 */
	itemSize: number | ((item: T, index: number) => number);

	/** items rendered beyond each edge of the viewport. defaults to 10 */
	overscan?: number;

	/** the element that scrolls. defaults to the nearest scrollable ancestor, else the page */
	scrollParent?: Element;

	/**
	 * `"bottom"` keeps the view pinned to the end while it's there, so a
	 * timeline stays on the newest message unless the user scrolled up
	 */
	anchor?: "top" | "bottom";

	/** how many items the server renders (and the client shows before measuring). defaults to `overscan` */
	ssr?: number;

	/** receives the imperative api once mounted */
	ref?: (api: VirtualApi) => void;
}

export interface Window {
	start: number;
	end: number;
}

interface Viewport {
	el: Element;
	scrollTop(): number;
	height(): number;
	scrollHeight(): number;
	setScrollTop(top: number, behavior?: ScrollBehavior): void;
	listen(fn: () => void): () => void;
}

function scrollableAncestor(from: Node): Element | null {
	let el = from.parentElement;
	while (el && el !== document.body) {
		const { overflowY } = getComputedStyle(el);
		if (overflowY === "auto" || overflowY === "scroll") return el;
		el = el.parentElement;
	}
	return null;
}

function viewportFor(el: Element | null): Viewport {
	if (el) {
		return {
			el,
			scrollTop: () => el.scrollTop,
			height: () => el.clientHeight,
			scrollHeight: () => el.scrollHeight,
			setScrollTop: (top, behavior) => el.scrollTo({ top, behavior }),
			listen(fn) {
				el.addEventListener("scroll", fn, { passive: true });
				const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fn) : undefined;
				observer?.observe(el);
				return () => {
					el.removeEventListener("scroll", fn);
					observer?.disconnect();
				};
			},
		};
	}
	const root = document.scrollingElement ?? document.documentElement;
	return {
		el: root,
		scrollTop: () => root.scrollTop,
		height: () => globalThis.innerHeight,
		scrollHeight: () => root.scrollHeight,
		setScrollTop: (top, behavior) => globalThis.scrollTo({ top, behavior }),
		listen(fn) {
			globalThis.addEventListener("scroll", fn, { passive: true });
			globalThis.addEventListener("resize", fn);
			return () => {
				globalThis.removeEventListener("scroll", fn);
				globalThis.removeEventListener("resize", fn);
			};
		},
	};
}

export class VirtualList<T> {
	readonly window: Signal<Window>;
	readonly topHeight: Signal<number>;
	readonly bottomHeight: Signal<number>;

	#options: VirtualOptions<T>;
	#items: T[] = [];
	#measured = new Map<string | number, number>();
	#offsets: number[] = [];
	#viewport: Viewport | undefined;
	#stopListening: (() => void) | undefined;
	#pinned = false;
	#keyOf: (item: T, index: number) => string | number;

	constructor(options: VirtualOptions<T>, keyOf: (item: T, index: number) => string | number) {
		this.#options = options;
		this.#keyOf = keyOf;
		const initial = options.ssr ?? options.overscan ?? 10;
		this.window = signal<Window>({ start: 0, end: initial });
		this.topHeight = signal(0);
		this.bottomHeight = signal(0);
	}

	get api(): VirtualApi {
		return {
			scrollTo: (target, behavior) => {
				const index = typeof target === "number"
					? target
					: this.#items.findIndex((item, i) => this.#keyOf(item, i) === target);
				if (index < 0 || !this.#viewport) return;
				this.#viewport.setScrollTop(this.#offsets[index] ?? 0, behavior);
			},
			scrollToEnd: (behavior) => {
				if (!this.#viewport) return;
				this.#pinned = true;
				this.#viewport.setScrollTop(this.#viewport.scrollHeight(), behavior);
			},
		};
	}

	attach(anchor: Node): void {
		if (this.#viewport) return;
		const parent = this.#options.scrollParent ?? scrollableAncestor(anchor);
		this.#viewport = viewportFor(parent);
		this.#pinned = this.#options.anchor === "bottom";
		this.#stopListening = this.#viewport.listen(() => this.#onScroll());
		this.update();
	}

	detach(): void {
		this.#stopListening?.();
		this.#stopListening = undefined;
		this.#viewport = undefined;
	}

	setItems(items: T[]): void {
		const grew = items.length > this.#items.length;
		this.#items = items;
		this.#layout();
		this.update();
		if (this.#pinned && grew && this.#viewport) {
			queueMicrotask(() => {
				if (this.#pinned && this.#viewport) {
					this.#viewport.setScrollTop(this.#viewport.scrollHeight());
				}
			});
		}
	}

	measure(nodes: readonly [key: string | number, node: Node][]): void {
		let changed = false;
		for (const [key, node] of nodes) {
			if (node.nodeType !== Node.ELEMENT_NODE) continue;
			const height = (node as Element).getBoundingClientRect().height;
			if (height > 0 && this.#measured.get(key) !== height) {
				this.#measured.set(key, height);
				changed = true;
			}
		}
		if (changed) {
			this.#layout();
			this.update();
		}
	}

	#sizeOf(index: number): number {
		const item = this.#items[index];
		const measured = this.#measured.get(this.#keyOf(item, index));
		if (measured !== undefined) return measured;
		const { itemSize } = this.#options;
		return typeof itemSize === "number" ? itemSize : itemSize(item, index);
	}

	#layout(): void {
		const offsets = new Array<number>(this.#items.length + 1);
		offsets[0] = 0;
		for (let i = 0; i < this.#items.length; i++) {
			offsets[i + 1] = offsets[i] + this.#sizeOf(i);
		}
		this.#offsets = offsets;
	}

	#indexAt(y: number): number {
		const offsets = this.#offsets;
		let lo = 0, hi = this.#items.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (offsets[mid + 1] <= y) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	#onScroll(): void {
		if (this.#viewport && this.#options.anchor === "bottom") {
			const { scrollTop, height, scrollHeight } = this.#viewport;
			this.#pinned = scrollTop() + height() >= scrollHeight() - 1;
		}
		this.update();
	}

	update(): void {
		const count = this.#items.length;
		const total = this.#offsets[count] ?? 0;
		const overscan = this.#options.overscan ?? 10;

		let start = 0, end = Math.min(count, this.#options.ssr ?? overscan);
		if (this.#viewport) {
			const top = Math.max(0, this.#viewport.scrollTop() - this.#listOffset());
			const bottom = top + this.#viewport.height();
			start = Math.max(0, this.#indexAt(top) - overscan);
			end = Math.min(count, this.#indexAt(bottom) + 1 + overscan);
		}

		const current = untracked(() => this.window());
		if (current.start !== start || current.end !== end) this.window({ start, end });
		this.topHeight(this.#offsets[start] ?? 0);
		this.bottomHeight(total - (this.#offsets[end] ?? total));
	}

	#listTop: Element | undefined;

	#listOffset(): number {
		const spacer = this.#listTop;
		const viewport = this.#viewport;
		if (!spacer || !viewport || !spacer.isConnected) return 0;
		const rect = spacer.getBoundingClientRect();
		const base =
			viewport.el === document.scrollingElement || viewport.el === document.documentElement
				? 0
				: viewport.el.getBoundingClientRect().top;
		return rect.top - base + viewport.scrollTop();
	}

	setTopSpacer(el: Element): void {
		this.#listTop = el;
	}
}

export function connect<T>(list: VirtualList<T>, anchor: () => Node | undefined): void {
	let attached = false;
	const tryAttach = () => {
		const node = anchor();
		if (attached || !node?.isConnected) return;
		attached = true;
		list.attach(node);
	};
	queueMicrotask(tryAttach);
	onCleanup(() => list.detach());
}
