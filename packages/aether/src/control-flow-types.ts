/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

/** the comment markers wrapped around a block, so hydration can adopt it */
export const BLOCK = {
	for: "for",
	show: "show",
	await: "await",
	virtual: "virtual",
	slot: "slot",
} as const;

export type BlockKind = typeof BLOCK[keyof typeof BLOCK];

/** windowing options */
export interface VirtualOptions<T> {
	/** px per item. can be either a number for fixed rows or a function for an estimate that is measured later */
	itemSize: number | ((item: T, index: number) => number);

	/** items kept rendered beyond each edge of the viewport. defaults to 10 */
	overscan?: number;

	/** how many items the server renders. defaults to `overscan` */
	ssr?: number;
}

export function useFallback(count: number, fallback: unknown): boolean {
	return count === 0 && fallback != null;
}

export interface ForProps<T> {
	/** the list to render */
	each: T[] | (() => T[]);

	/** stable identity per item, so rows are matched across updates rather than rebuilt */
	key: (item: T, index: number) => string | number;

	children: (item: () => T, index: () => number) => unknown;

	/** rendered instead of the list when there is nothing in it */
	fallback?: unknown;

	/** render only the slice near the viewport. needs one element per item */
	virtual?: VirtualOptions<T>;
}

export interface ShowProps<T = unknown> {
	/** the condition. a signal or getter is re-evaluated */
	when: T | (() => T);

	/** rendered when `when` is falsy. omit for nothing */
	fallback?: unknown;

	/**
	 * rendered when `when` is truthy.
	 */
	children: unknown | ((value: NonNullable<T>) => unknown);
}

export interface AwaitProps<T> {
	/** the value to wait for. a function or signal is tracked */
	for: Promise<T> | T | (() => Promise<T> | T);

	/** shown until the promise settles */
	fallback?: unknown;

	/** rendered if it rejects. without one the rejection is logged */
	catch?: (error: unknown) => unknown;

	/** rendered with the resolved value */
	children: (value: T) => unknown;
}
