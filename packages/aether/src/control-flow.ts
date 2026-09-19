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

function comment(data: string): JSX.Element {
	return jsx(Fragment as JSX.Fragment, { dangerouslySetInnerHTML: { __html: `<!--${data}-->` } });
}

export interface ForProps<T> {
	each: T[] | (() => T[]);
	key: (item: T, index: number) => string | number;
	children: (item: T, index: () => number) => JSX.Node;
}

function readEach<T>(each: ForProps<T>["each"]): T[] {
	return typeof each === "function" ? each() : each;
}

export function For<T>(props: ForProps<T>): JSX.Element {
	const items = readEach(props.each);
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

	return block("for", rendered);
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
