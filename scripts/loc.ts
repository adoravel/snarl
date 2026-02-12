#!/usr/bin/env -S deno run --allow-read
/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: BSD-3-Clause
 */

import { walk } from "jsr:@std/fs@1.0.22";
const ENTRY_DIR = "./src";

/**
 * counts logical lines of code by stripping comments and blank lines
 */
function process(content: string): number {
	content = content
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");

	let count = 0;
	for (const line of content.split("\n")) {
		if (line.trim().length) count++;
	}
	return count;
}

async function main() {
	if (!Deno.readDirSync(ENTRY_DIR)) Deno.exit(1);
	let count = 0, files = 0;

	for await (const entry of walk(ENTRY_DIR)) {
		if (entry.isFile && entry.name.endsWith(".ts")) {
			if (entry.name === "test.ts") {
				continue;
			}

			const content = await Deno.readTextFile(entry.path);
			const lines = process(content);
			count += lines, files++;

			console.log(`${entry.path}: ${lines} lines`);
		}
	}
	console.log(`total of ${count} LoC and ${files} files :>`);
}

main();
