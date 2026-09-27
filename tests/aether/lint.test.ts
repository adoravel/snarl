/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals } from "@std/assert";
import { lintIslandSource } from "@404/aether/server";

const lint = (source: string) => lintIslandSource(source, "tsx", "island.tsx");

Deno.test("lint: <show> children that compute once are reported", async () => {
	const issues = await lint(`
		export default function Groups() {
			return <show when={groups}>{groups().map((g) => <li>{g.name}</li>)}</show>;
		}
	`);
	assertEquals(issues.length, 1);
	assert(issues[0].message.includes("computed once"), issues[0].message);
	assertEquals(issues[0].file, "island.tsx");
	assertEquals(issues[0].line, 3);
});

Deno.test("lint: the lazy and static forms are both fine", async () => {
	assertEquals(
		await lint(
			`export default () => <show when={x}>{() => list().map((g) => <li>{g}</li>)}</show>;`,
		),
		[],
		"a function child is re-evaluated",
	);
	assertEquals(
		await lint(`export default () => <show when={x}><p>nothing here</p></show>;`),
		[],
		"static markup reads nothing",
	);
	assertEquals(
		await lint(`export default () => <show when={x}>{label}</show>;`),
		[],
		"a bare signal is already reactive",
	);
	assertEquals(
		await lint(`export default () => <div>{list().map((g) => <li>{g}</li>)}</div>;`),
		[],
		"an ordinary element renders once by design",
	);
	assertEquals(
		await lint(`export default () => <show when={x}>{<b onClick={() => save()}>go</b>}</show>;`),
		[],
		"a call inside a handler is deferred, not eager",
	);
});

Deno.test("lint: what the types already catch is left to them", async () => {
	assertEquals(
		await lint(`export default () => <for each={xs}>{(x) => <li>{x()}</li>}</for>;`),
		[],
	);
	assertEquals(await lint(`export default () => <await for={p}>{render(x)}</await>;`), []);
});

Deno.test("lint: non-jsx sources are skipped", async () => {
	assertEquals(await lintIslandSource(`export const x = compute();`, "ts"), []);
	assertEquals(
		await lintIslandSource(`this is not valid <<<`, "tsx"),
		[],
		"a parse error is the bundler's to report",
	);
});
