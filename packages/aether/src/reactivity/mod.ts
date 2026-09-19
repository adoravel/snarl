/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Computed } from "./computed.ts";
import type { Dispose } from "./effect.ts";
import { endBatch, startBatch } from "./engine.ts";
import type { Signal } from "./signal.ts";
import { kindOf } from "./tag.ts";
import { NodeKind } from "./types.ts";

export function batch<T>(fn: () => T): T {
	startBatch();
	try {
		return fn();
	} finally {
		endBatch();
	}
}

export function isSignal(value: unknown): value is Signal<unknown> {
	return kindOf(value) === NodeKind.Signal;
}

export function isComputed(value: unknown): value is Computed<unknown> {
	return kindOf(value) === NodeKind.Computed;
}

export function isEffect(value: unknown): value is Dispose {
	return kindOf(value) === NodeKind.Effect;
}

export function isEffectScope(value: unknown): value is Dispose {
	return kindOf(value) === NodeKind.EffectScope;
}

export function isReactive(value: unknown): value is () => unknown {
	return isSignal(value) || isComputed(value);
}

export { type Signal, signal } from "./signal.ts";
export { type Computed, computed } from "./computed.ts";
export { type Dispose, effect, effectScope } from "./effect.ts";
export { flush, getActiveSub, setActiveSub, trigger, untracked } from "./engine.ts";
export type { Link, ReactiveNode } from "./types.ts";
export type { ReactiveAccessor } from "./accessor.ts";
export { sharedSignal } from "./shared.ts";
export { type MountCallback, onCleanup, onMount } from "./lifecycle.ts";
export { reactive } from "./proxy.ts";
