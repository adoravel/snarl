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
const scenarioOrder: string[] = [];

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
		if (!scenarioOrder.includes(scenario)) scenarioOrder.push(scenario);

		const rpsLine = lines[i + 1];
		matches = rpsLine?.match(/^\s+(\d+)\s+req\/s$/);

		if (matches) {
			const rps = parseInt(matches[1]);
			if (!data[framework]) data[framework] = {};
			data[framework][scenario] = rps;
		}
	}
}

const scenarios = scenarioOrder;
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

const sorted = [...frameworks].filter((f) => avg[f] !== undefined).sort((
	a,
	b,
) => avg[b] - avg[a]);
const alignments = ["left", ...sorted.map(() => "right")];
const baselineFramework = sorted[sorted.length - 1] ?? sorted[0];

rows.push(["Scenario", ...sorted]);
rows.push(alignments.map((align) => align === "right" ? ":---:" : ":---"));

for (const scenario of scenarios) {
	const baseline = data[baselineFramework]?.[scenario] || 1;
	const row = [`**${scenario}**`];

	for (const framework of sorted) {
		const rps = data[framework]?.[scenario] || 0;
		if (framework === baselineFramework) {
			row.push(`1.00x<br><small>${rps.toLocaleString()} req/s</small>`);
			continue;
		}
		const relative = (rps / baseline).toFixed(2);
		row.push(`${relative}x<br><small>${rps.toLocaleString()} req/s</small>`);
	}

	rows.push(row);
}

const widths = new Array(rows[0].length).fill(0);
for (const row of rows) {
	for (let i = 0; i < row.length; i++) {
		widths[i] = Math.max(widths[i], row[i].length);
	}
}

for (let r = 0; r < rows.length; r++) {
	const row = rows[r];
	const cells = row.map((cell, i) => alignments[i] === "right" ? cell.padStart(widths[i]) : cell.padEnd(widths[i]));
	console.log(`| ${cells.join(" | ")} |\n`);
}
