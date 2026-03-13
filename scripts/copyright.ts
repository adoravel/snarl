#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: Apache-2.0
 */

import { walk } from "https://deno.land/std/fs/walk.ts";

const copyrightHeader = `/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: Apache-2.0
 */
`;

const dir = "./";

for await (
	const entry of walk(dir, {
		exts: [".ts", ".tsx"],
		includeDirs: false,
		skip: [/(copyright|generate|loc)\.ts$/],
	})
) {
	const filePath = entry.path;
	const content = await Deno.readTextFile(filePath);

	if (!content.startsWith(copyrightHeader)) {
		await Deno.writeTextFile(filePath, copyrightHeader + "\n" + content);
		console.log(`Added header to ${filePath}`);
	}
}
