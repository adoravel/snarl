/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { Fragment, type JSX, jsx } from "./jsx-runtime.ts";

function block(kind: string, children: JSX.Node): JSX.Element {
	return jsx(Fragment as JSX.Fragment, {
		children: [comment(kind), children, comment(`/${kind}`)],
	});
}

export function hydrationSlot(children: JSX.Node): JSX.Element {
	return block("slot", children);
}

function comment(data: string): JSX.Element {
	return jsx(Fragment as JSX.Fragment, { dangerouslySetInnerHTML: { __html: `<!--${data}-->` } });
}

export interface VirtualOptions<T> {
	itemSize: number | ((item: T, index: number) => number);
	overscan?: number;
	ssr?: number;
	[option: string]: unknown;
}

export interface ForProps<T> {
	each: T[] | (() => T[]);
	key: (item: T, index: number) => string | number;
	children: (item: T, index: () => number) => JSX.Node;

	/** render only the first `ssr ?? overscan` items, between spacers, for the client to window */
	virtual?: VirtualOptions<T>;
}

function initialSpacers<T>(items: T[], options: VirtualOptions<T>): [top: number, bottom: number] {
	const shown = Math.min(items.length, options.ssr ?? options.overscan ?? 10);
	let bottom = 0;
	for (let i = shown; i < items.length; i++) {
		bottom += typeof options.itemSize === "number"
			? options.itemSize
			: options.itemSize(items[i], i);
	}
	return [0, bottom];
}

function spacer(height: number, edge: "top" | "bottom"): JSX.Element {
	return jsx("div", {
		"data-x-spacer": edge,
		"aria-hidden": "true",
		style: { height: `${height}px` },
	});
}

function readEach<T>(each: ForProps<T>["each"]): T[] {
	return typeof each === "function" ? each() : each;
}

export function For<T>(props: ForProps<T>): JSX.Element {
	const all = readEach(props.each);
	const { virtual } = props;
	const items = virtual ? all.slice(0, virtual.ssr ?? virtual.overscan ?? 10) : all;
	const seen = new Set<string | number>();

	const rendered = items.flatMap((item, index) => {
		const key = props.key(item, index);
		if (seen.has(key)) {
			console.warn(`aether: <For> found a duplicate key ${JSON.stringify(key)} during SSR`);
			return [];
		}
		seen.add(key);
		return [props.children(item, () => index)];
	});

	if (!virtual) return block("for", rendered);

	const [top, bottom] = initialSpacers(all, virtual);
	return block("virtual", [spacer(top, "top"), block("for", rendered), spacer(bottom, "bottom")]);
}

export interface ShowProps<T = unknown> {
	when: T | (() => T);
	fallback?: JSX.Node;
	children: JSX.Node | ((value: NonNullable<T>) => JSX.Node);
}

export function Show<T>(props: ShowProps<T>): JSX.Element {
	const condition = typeof props.when === "function" ? (props.when as () => T)() : props.when;
	const branch = condition
		? (typeof props.children === "function"
			? (props.children as (v: NonNullable<T>) => JSX.Node)(condition as NonNullable<T>)
			: props.children)
		: (props.fallback ?? null);

	return block("show", branch);
}

export interface AwaitProps<T> {
	for: Promise<T> | T | (() => Promise<T> | T);
	fallback?: JSX.Node;
	catch?: (error: unknown) => JSX.Node;
	children: (value: T) => JSX.Node;
}

export function Await<T>(props: AwaitProps<T>): JSX.Element {
	return block("await", props.fallback ?? null);
}
