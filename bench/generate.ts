#!/usr/bin/env -S deno run --allow-env --allow-read

import servers from "./servers.ts";

if (!Deno.args.length) {
	console.error("usage: deno run --allow-read bench/generate.ts <log-file>");
	Deno.exit(1);
}

const frameworks = Object.keys(servers);
const pattern = new RegExp(`^\\s+-\\s+(${frameworks.join("|")})$`);

const content = await Deno.readTextFile(Deno.args[0]);
const lines = content.split("\n");

const data: Record<string, Record<string, number>> = {};
let framework = "";

for (let i = 0; i < lines.length; i++) {
	const line = lines[i];
	let matches = line.match(pattern);

	if (matches) {
		framework = matches[1];
		continue;
	}

	matches = line.match(/^\s+•\s+(.*)$/);
	if (matches && framework) {
		const scenario = matches[1];

		const rpsLine = lines[i + 1];
		matches = rpsLine?.match(/^\s+(\d+)\s+req\/s$/);

		if (matches) {
			const rps = parseInt(matches[1]);
			if (!data[framework]) data[framework] = {};
			data[framework][scenario] = rps;
		}
	}
}

const scenarios = ["plain text", "JSON", "path params", "query params"];
const rows: string[][] = [];

const avg: Record<string, number> = {};

for (const x of frameworks) {
	const fwData = data[x];
	if (!fwData) continue;

	let total = 0, count = 0;

	for (const scenario of scenarios) {
		const rps = fwData[scenario];
		if (rps !== undefined) {
			total += rps, count++;
		}
	}

	avg[x] = count > 0 ? total / count : 0;
}

const sorted = [...frameworks].sort((a, b) => avg[b] - avg[a]);
const alignments = ["left", ...sorted.map(() => "right")];

rows.push(["Scenario", ...sorted]);
rows.push(alignments.map((align) => align === "right" ? ":---:" : ":---"));

for (const scenario of scenarios) {
	const baseline = data.snarl?.[scenario] || 1;
	const row = [`**${scenario}**`];

	for (const framework of sorted) {
		if (framework === "snarl") {
			row.push(`1.00x<br><small>${baseline.toLocaleString()} req/s</small>`);
			continue;
		}
		const rps = data[framework]?.[scenario] || 0;
		const relative = (rps / baseline).toFixed(2);
		row.push(`${relative}x<br><small>${rps.toLocaleString()} req/s</small>`);
	}

	rows.push(row);
}

const colWidths = new Array(rows[0].length).fill(0);
for (const row of rows) {
	for (let i = 0; i < row.length; i++) {
		colWidths[i] = Math.max(colWidths[i], row[i].length);
	}
}

let markdown = "";
for (let r = 0; r < rows.length; r++) {
	const row = rows[r];
	const paddedCells = row.map((cell, i) =>
		alignments[i] === "right" ? cell.padStart(colWidths[i]) : cell.padEnd(colWidths[i])
	);
	markdown += `| ${paddedCells.join(" | ")} |\n`;
}

console.log("\n### Performance Comparison\n");
console.log(`Benchmarking frameworks using \`autocannon\`. snarl is set as baseline (1x).\n`);
console.log(markdown);
