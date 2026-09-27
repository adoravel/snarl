/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { emptyDir } from "@std/fs";
import { resolve } from "@std/path";

export async function scratch(name: string): Promise<string> {
	const dir = resolve("tests/.scratch", name);
	await emptyDir(dir);
	return dir;
}

export async function fixture(name: string, files: Record<string, string>): Promise<string> {
	const dir = await scratch(name);
	for (const [path, source] of Object.entries(files)) {
		const file = resolve(dir, path);
		await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
		await Deno.writeTextFile(file, source);
	}
	return dir;
}
