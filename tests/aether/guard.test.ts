/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertRejects, assertStringIncludes } from "@std/assert";
import { relative, resolve } from "@std/path";
import { bundleIslands, IslandRegistry } from "@404/aether/server";

async function bundle(
	files: Record<string, string>,
	options: Parameters<typeof bundleIslands>[2] = {},
): Promise<string> {
	const dir = resolve(await Deno.makeTempDir({ dir: "tests/aether", prefix: "guard-" }));
	try {
		for (const [name, source] of Object.entries(files)) {
			await Deno.writeTextFile(`${dir}/${name}`, source);
		}
		const registry = new IslandRegistry();
		const meta = registry.register(() => null, `file://${dir}/island.tsx`, "default");
		const serverOnly = options.serverOnly?.map((g) => `${relative(Deno.cwd(), dir)}/${g}`);

		return await bundleIslands([meta.id], registry, {
			...options,
			serverOnly,
			esbuild: { logLevel: "silent" },
		});
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
}

const island = (extra = "") =>
	`/** @jsxImportSource @404/aether */
import { signal } from "@404/aether";
${extra}
export default function Island() {
	const n = signal(0);
	return <button onClick={() => n.update((v) => v + 1)}>{n}</button>;
}
`;

Deno.test("guard: an island that pulls in Deno.* fails to bundle with the import chain", async () => {
	const err = await assertRejects(() =>
		bundle({
			"island.tsx": island(`import { siteUrl } from "./config.ts";\nconsole.log(siteUrl);`),
			"config.ts": `export const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost";\n`,
		}), Error);
	assertStringIncludes(err.message, "config.ts");
	assertStringIncludes(err.message, "uses `Deno`");
	assertStringIncludes(err.message, "island.tsx → ");
	assertStringIncludes(err.message, "config.ts:1:");
});

Deno.test("guard: references behind isServer / typeof Deno checks are allowed", async () => {
	const code = await bundle({
		"island.tsx": island(`import { siteUrl, tmp } from "./config.ts";\nconsole.log(siteUrl, tmp);`),
		"config.ts": `import { isServer } from "@404/aether";
export const siteUrl = isServer ? Deno.env.get("SITE_URL") : location.origin;
export const tmp = typeof Deno !== "undefined" ? Deno.cwd() : "/";
export function log(msg: string) {
	if (!isServer) return console.log(msg);
	Deno.stderr.writeSync(new TextEncoder().encode(msg));
}
`,
	});
	assertStringIncludes(code, "location.origin");
});

Deno.test("guard: serverOnly globs block a module by path", async () => {
	const err = await assertRejects(() =>
		bundle({
			"island.tsx": island(`import { secret } from "./secret.ts";\nconsole.log(secret);`),
			"secret.ts": `export const secret = "not really";\n`,
		}, { serverOnly: ["secret.ts"] }), Error);
	assertStringIncludes(err.message, "marked server-only");
	assertStringIncludes(err.message, "secret.ts");
});

Deno.test("guard: node built-ins are rejected", async () => {
	const err = await assertRejects(() =>
		bundle({
			"island.tsx": island(`import { readFileSync } from "node:fs";\nconsole.log(readFileSync);`),
		}), Error);
	assertStringIncludes(err.message, '"node:fs" is a node built-in');
});

Deno.test("guard: a clean island still bundles", async () => {
	const code = await bundle({ "island.tsx": island() });
	assertStringIncludes(code, "registerIsland");
});
