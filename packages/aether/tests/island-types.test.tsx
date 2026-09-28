/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { island } from "../src/server/island.ts";
import type { IslandProps } from "../src/server/island.ts";
import { signal } from "../src/reactivity/mod.ts";
import type { JSX } from "../src/jsx-runtime.ts";

const meta = { id: "x", moduleUrl: "file:///x.tsx", exportName: "X", Component: () => null };

interface Post {
	id: number;
	title: string;
	tags: string[];
	author: { name: string; avatar?: string };
	draft?: boolean;
}

const Plain = island<{ post: Post; count: number; label?: string }>(meta);
export const plain = <Plain post={{} as Post} count={1} label="x" />;

const WithChildren = island<{ title: string; children?: JSX.Node }>(meta);
export const children = <WithChildren title="t">body</WithChildren>;

interface Tree {
	value: string;
	children: Tree[];
}
const Recursive = island<{ tree: Tree }>(meta);
export const recursive = <Recursive tree={{} as Tree} />;

const Loose = island(meta);
export const loose = <Loose anything={new Set([1])} />;

const Signals = island<{ count: ReturnType<typeof signal<number>> }>(meta);
const Fn = island<{ onDone: () => void }>(meta);
const Collection = island<{ seen: Set<string> }>(meta);
const Nested = island<{ page: { rows: { when: RegExp }[] } }>(meta);
const Big = island<{ id: bigint }>(meta);

export const rejected = {
	// @ts-expect-error reactive state cannot cross the boundary
	signal: <Signals count={signal(0)} />,
	// @ts-expect-error nor can a callback
	fn: <Fn onDone={() => {}} />,
	// @ts-expect-error nor a Set, which would serialise to "{}"
	set: <Collection seen={new Set<string>()} />,
	// @ts-expect-error however deeply it is buried
	nested: <Nested page={{ rows: [{ when: /x/ }] }} />,
	// @ts-expect-error nor a bigint, which JSON.stringify throws on
	big: <Big id={1n} />,
};

export function Author(props: IslandProps<{ post: Post }>): string {
	return props.post.title;
}

Deno.test("island types: non-serialisable props are rejected at the call site", () => {
	if (Object.keys(rejected).length !== 5) throw new Error("a case was dropped");
});
