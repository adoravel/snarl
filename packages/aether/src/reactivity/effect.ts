/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import {
	checkDirty,
	decrementRunDepth,
	disposeAllDepsInReverse,
	incrementCycle,
	incrementRunDepth,
	link,
	pruneChildEffectDeps,
	purgeDeps,
	setActiveSub,
	unlink,
} from "./engine.ts";
import { tag } from "./tag.ts";
import { HasChildEffect, NodeKind, ReactiveFlags, type ReactiveNode } from "./types.ts";

export interface EffectNode extends ReactiveNode {
	readonly kind: NodeKind.Effect;
	fn(): (() => void) | void;
	cleanup: (() => void) | void;
}

export interface EffectScopeNode extends ReactiveNode {
	readonly kind: NodeKind.EffectScope;
}

export type Dispose = () => void;

export function effect(fn: () => void | (() => void)): Dispose {
	const node: EffectNode = {
		kind: NodeKind.Effect,
		fn,
		cleanup: undefined,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck,
	};

	startEffect(node);
	return tag(() => disposeEffect(node), NodeKind.Effect);
}

export function effectScope(fn: () => void): Dispose {
	const node: EffectScopeNode = {
		kind: NodeKind.EffectScope,
		deps: undefined,
		depsTail: undefined,
		subs: undefined,
		subsTail: undefined,
		flags: ReactiveFlags.Mutable,
	};

	startEffectScope(node, fn);
	return tag(() => disposeEffectScope(node), NodeKind.EffectScope);
}

let onEffectError: (error: unknown) => void = (error) => {
	console.error("aether:", "an effect threw and was skipped:", error);
};

/** replaces the reporter used when an effect throws. returns the previous one */
export function setEffectErrorHandler(
	handler: (error: unknown) => void,
): (error: unknown) => void {
	const previous = onEffectError;
	onEffectError = handler;
	return previous;
}

/** runs `fn`, keeping a throw from escaping into whatever wrote the signal */
function runIsolated(node: EffectNode): void {
	try {
		node.cleanup = node.fn();
	} catch (error) {
		node.cleanup = undefined;
		onEffectError(error);
	}
}

export function startEffect(node: EffectNode): void {
	const prevSub = beginChildScope(node);
	try {
		incrementRunDepth();
		runIsolated(node);
	} finally {
		decrementRunDepth();
		setActiveSub(prevSub);
		node.flags &= ~ReactiveFlags.RecursedCheck;
	}
}

export function startEffectScope(node: EffectScopeNode, fn: () => void): void {
	const prevSub = beginChildScope(node);
	try {
		fn();
	} finally {
		setActiveSub(prevSub);
	}
}

export function disposeEffectScope(node: EffectScopeNode): void {
	node.flags = ReactiveFlags.None;
	disposeAllDepsInReverse(node);
	const sub = node.subs;
	if (sub !== undefined) unlink(sub);
}

export function beginChildScope(node: EffectNode | EffectScopeNode): ReactiveNode | undefined {
	const prevSub = setActiveSub(node);
	if (prevSub !== undefined) {
		link(node, prevSub, 0);
		prevSub.flags |= HasChildEffect;
	}
	return prevSub;
}

export function runEffect(node: EffectNode): void {
	const flags = node.flags;
	if (
		flags & ReactiveFlags.Dirty || (flags & ReactiveFlags.Pending && checkDirty(node.deps!, node))
	) {
		if (flags & HasChildEffect) pruneChildEffectDeps(node);
		if (node.cleanup) {
			runCleanup(node);
			if (!node.flags) return;
		}
		node.depsTail = undefined;
		node.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;

		const prevSub = setActiveSub(node);
		try {
			incrementCycle();
			incrementRunDepth();
			runIsolated(node);
		} finally {
			decrementRunDepth();
			setActiveSub(prevSub);
			node.flags &= ~ReactiveFlags.RecursedCheck;
			purgeDeps(node);
		}
	} else if (node.deps !== undefined) {
		node.flags = ReactiveFlags.Watching | (flags & HasChildEffect);
	}
}

export function disposeEffect(node: EffectNode): void {
	disposeEffectScope(node as unknown as EffectScopeNode);
	if (node.cleanup) runCleanup(node);
}

export function runCleanup(node: EffectNode): void {
	const cleanup = node.cleanup!;
	node.cleanup = undefined;
	const prevSub = setActiveSub(undefined);
	try {
		cleanup();
	} catch (error) {
		onEffectError(error);
	} finally {
		setActiveSub(prevSub);
	}
}
