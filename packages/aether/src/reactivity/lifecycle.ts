/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { effect } from "./effect.ts";
import { untracked } from "./engine.ts";
import { isBrowser } from "../env.ts";

export type MountCallback = () => void | (() => void);

/** `onMount` callbacks held back whilst an island renders, flushed once its nodes are in the document!!111! */
let pending: (() => void)[] | null = null;

/**
 * runs `fn` once, after the surrounding island's nodes are in the document.
 */
export function onMount(fn: MountCallback): void {
	if (!isBrowser) return;

	let cleanup: (() => void) | void;
	let disposed = false;

	effect(() => () => {
		disposed = true;
		cleanup?.();
	});

	const run = () => {
		if (!disposed) cleanup = untracked(fn);
	};

	if (pending) pending.push(run);
	else queueMicrotask(run);
}

/** registers `fn` to run when the surrounding island, `<show>` branch or `<for>` item is disposed */
export function onCleanup(fn: () => void): void {
	if (!isBrowser) return;
	effect(() => fn);
}

/**
 * @internal renders with `onMount` callbacks held back. the returned flush
 * runs them and must be called once the render result is in the document
 */
export function deferMounts<T>(render: () => T): [result: T, flush: () => void] {
	const previous = pending;
	const queue: (() => void)[] = [];
	pending = queue;
	try {
		return [render(), () => {
			for (const run of queue) run();
		}];
	} finally {
		pending = previous;
	}
}
