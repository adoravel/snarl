#!/usr/bin/env -S deno run --allow-read --allow-write

import { walk } from "https://deno.land/std/fs/walk.ts";
import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";

const CONFIG = {
	author: "kylia",
	license: "Apache-2.0",
	currentYear: new Date().getFullYear(),
	extensions: [".ts", ".tsx"],
	skip: [
		/node_modules/,
		/\.git/,
		/copyright\.ts$/,
		/meowmix(0|1)\.ts$/,
		/(generate|loc)\.ts$/,
		/bench\//,
		/static\//,
	],
};

const JSDOC_RE =
	/\/\*\*\s*\n\s*\*\s*Copyright\s*\(c\)\s*(\d{4})(?:-(\d{4}))?\s+([^\n]+)\s*\n\s*\*\s*SPDX-License-Identifier:\s*([^\s]+)\s*\n\s*\*\//;
const SLASH_RE = /\/\/\s*Copyright\s*\(c\)\s*(\d{4})(?:-(\d{4}))?\s+([^\n]+)/;
const SPDX_RE = /SPDX-License-Identifier:\s*([^\s]+)/;

function detect(content: string) {
	const jsdocMatch = content.match(JSDOC_RE);
	if (jsdocMatch) {
		const [full, year, endYear, author, license] = jsdocMatch;
		return {
			exists: true,
			header: full,
			rest: content.slice(jsdocMatch.index! + full.length).trimStart(),
			year: parseInt(year),
			endYear: endYear ? parseInt(endYear) : undefined,
			author: author.trim(),
			license: license.trim(),
		};
	}

	const slashMatch = content.match(SLASH_RE);
	if (slashMatch) {
		const [full, year, endYear, author] = slashMatch;
		const spdxMatch = content.match(SPDX_RE);

		let sliceIndex = slashMatch.index! + full.length;
		if (spdxMatch && spdxMatch.index! > slashMatch.index!) {
			sliceIndex = Math.max(sliceIndex, spdxMatch.index! + spdxMatch[0].length);
		}

		return {
			exists: true,
			header: full + (spdxMatch ? `\n${spdxMatch[0]}` : ""),
			rest: content.slice(sliceIndex).trimStart(),
			year: parseInt(year),
			endYear: endYear ? parseInt(endYear) : undefined,
			author: author.trim(),
			license: spdxMatch ? spdxMatch[1].trim() : "unknown",
		};
	}

	return { exists: false, header: "", rest: content.trimStart() };
}

function generate(year: number, endYear?: number, author = CONFIG.author, license = CONFIG.license): string {
	const range = endYear && endYear !== year ? `${year}-${endYear}` : `${year}`;
	return `/**\n * Copyright (c) ${range} ${author}\n * SPDX-License-Identifier: ${license}\n */`;
}

async function processFile(path: string, dry: boolean): Promise<{ status: string; msg: string }> {
	const raw = await Deno.readTextFile(path);
	const content = raw.replaceAll("\r\n", "\n");
	const detected = detect(content);

	if (!detected.exists) {
		if (!dry) {
			const header = generate(CONFIG.currentYear);
			await Deno.writeTextFile(path, `${header}\n\n${detected.rest}`);
		}
		return { status: "added", msg: "added copyright header" };
	}

	let needsUpdate = false;

	const year = detected.year ?? CONFIG.currentYear;
	if ((detected.endYear ?? year ?? 0) < CONFIG.currentYear) {
		needsUpdate = true;
	}
	if (detected.author !== CONFIG.author || detected.license !== CONFIG.license) {
		needsUpdate = true;
	}

	if (needsUpdate) {
		const { endYear } = detected;
		if (!dry) {
			const header = generate(year, CONFIG.currentYear);
			await Deno.writeTextFile(path, `${header}\n\n${detected.rest}`);
		}
		const meow = year != CONFIG.currentYear ? `${year}-${CONFIG.currentYear}` : CONFIG.currentYear;
		return { status: "updated", msg: `updated (${year}${endYear ? `-${endYear}` : ""} → ${meow})` };
	}

	return { status: "ok", msg: "all good" };
}

async function main() {
	const args = Deno.args;
	const dry = args.includes("--dry") || args.includes("-n");
	const verbose = args.includes("--verbose") || args.includes("-v");
	const dir = args.find((a) => !a.startsWith("-")) || "./";

	console.log(cyan(bold("silly copyright header management")));
	console.log(dim(`  target: ${dir}`));
	console.log(dim(`  year: ${CONFIG.currentYear}`));
	console.log(dim(`  author: ${CONFIG.author}`));
	console.log(dim(`  license: ${CONFIG.license}`));
	console.log(dim(`  mode: ${dry ? "dry run" : "owo"}\n`));

	const stats = { added: 0, updated: 0, ok: 0, errors: 0 };

	const walkOptions = {
		includeDirs: false,
		followSymlinks: false,
		exts: CONFIG.extensions,
		skip: CONFIG.skip,
	};

	for await (const entry of walk(dir, walkOptions)) {
		try {
			const result = await processFile(entry.path, dry);
			stats[result.status as keyof typeof stats] = (stats[result.status as keyof typeof stats] || 0) + 1;

			if (verbose || result.status !== "ok") {
				const color = result.status === "added" ? green : result.status === "updated" ? yellow : dim;
				const sym = result.status === "added" ? "+" : result.status === "updated" ? "~" : "·";
				console.log(`  ${color(sym)} ${result.msg.padEnd(25)} ${dim(entry.path)}`);
			}
		} catch (err) {
			stats.errors++;
			console.log(`  ${red("!")} ${red((err as Error).message)} ${dim(entry.path)}`);
		}
	}

	console.log(cyan(bold("\nsummary")));
	console.log(`  ${green("+")} ${stats.added} added`);
	console.log(`  ${yellow("~")} ${stats.updated} updated`);
	console.log(`  ${dim("·")} ${stats.ok} ok`);
	console.log(`  ${red("!")} ${stats.errors} errors`);

	if (dry && (stats.added || stats.updated)) {
		console.log(yellow("\n  (this was a dry run, run without --dry to apply)"));
	}

	if (stats.errors) Deno.exit(1);
}

if (import.meta.main) await main();
