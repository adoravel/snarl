/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { Fragment, type JSX, jsx } from "./jsx-runtime.ts";
import { BLOCK, type BlockKind, useFallback } from "./control-flow-types.ts";
import type {
	AwaitProps as SharedAwaitProps,
	ForProps as SharedForProps,
	ShowProps as SharedShowProps,
	VirtualOptions as SharedVirtualOptions,
} from "./control-flow-types.ts";

export type { BlockKind };

function block(kind: BlockKind, children: JSX.Node): JSX.Element {
	return jsx(Fragment as JSX.Fragment, {
		children: [comment(kind), children, comment(`/${kind}`)],
	});
}

export function hydrationSlot(children: JSX.Node): JSX.Element {
	return block(BLOCK.slot, children);
}

function comment(data: string): JSX.Element {
	return jsx(Fragment as JSX.Fragment, { dangerouslySetInnerHTML: { __html: `<!--${data}-->` } });
}

export type VirtualOptions<T> = SharedVirtualOptions<T>;

export interface ForProps<T> extends SharedForProps<T> {
	children: (item: () => T, index: () => number) => JSX.Node;
	fallback?: JSX.Node;
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
		return [props.children(() => item, () => index)];
	});

	const content = useFallback(rendered.length, props.fallback) ? props.fallback : rendered;
	if (!virtual) return block(BLOCK.for, content);

	const [top, bottom] = initialSpacers(all, virtual);
	return block(BLOCK.virtual, [
		spacer(top, "top"),
		block(BLOCK.for, content),
		spacer(bottom, "bottom"),
	]);
}

export interface ShowProps<T = unknown> extends SharedShowProps<T> {
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

	return block(BLOCK.show, branch);
}

export interface AwaitProps<T> extends SharedAwaitProps<T> {
	fallback?: JSX.Node;
	catch?: (error: unknown) => JSX.Node;
	children: (value: T) => JSX.Node;
}

export function Await<T>(props: AwaitProps<T>): JSX.Element {
	return block(BLOCK.await, props.fallback ?? null);
}
