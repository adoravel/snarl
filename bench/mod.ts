/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import autocannon from "autocannon";
import { Table } from "@cliffy/table";
import servers from "./servers.ts";

const port = 6776;

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
const logfile = `bench-${timestamp}.log`;

const orig = { log: console.log, table: console.table };
console.log = (...args: unknown[]) => {
	orig.log(...args), Deno.writeTextFileSync(logfile, args.map((a) => String(a)).join(" ") + "\n", { append: true });
};
console.table = (args: Record<string, Record<string, string>>) => {
	const keys = (orig.table(args), Object.keys(args));
	if (keys.length) {
		const name = keys[0], data = args[name];

		const table = new Table().header(["(index)", name]).border(true);
		table.push(...Object.entries(data));

		Deno.writeTextFileSync(logfile, table.toString() + "\n", { append: true });
	}
};

const scenarios = [
	{ name: "plain text", path: "/plaintext" },
	{ name: "JSON", path: "/json" },
	{ name: "path params", path: "/user/123/todos/456" },
	{ name: "query params", path: "/search?term=benchmark" },
];

const WARMUP_ROUNDS = 5;
const BENCH_DURATION = 10;

const warmupTime = WARMUP_ROUNDS * scenarios.length * BENCH_DURATION;
const benchTime = scenarios.length * BENCH_DURATION;
const totalTime = (warmupTime + benchTime + 1) * Object.keys(servers).length;

console.log(
	`\n  + estimated time ${Math.ceil(totalTime / 60)} min (${totalTime}s)`,
);
console.log(`    - warmup: ${warmupTime}s per server`);
console.log(`    - benchmarks: ${benchTime}s per server`);
console.log(`    - servers (${Object.keys(servers).length}): ${Object.keys(servers).join(", ")}`);

interface BenchResult {
	rps: number;
	mean: number;
	p90: number;
	p975: number;
	p99: number;
}

async function begin(
	name: string,
	server: typeof servers[keyof typeof servers],
	controller: AbortController,
): Promise<void> {
	server(port, controller.signal);

	for (let i = 0; i < 10; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(1000),
			});
			if (res.ok && await res.text() === name) {
				return;
			}
		} catch {
			if (i === 9) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	throw new Error(`port ${port} didn’t respond appropriately after 10 attempts`);
}

async function bench(url: string): Promise<BenchResult> {
	const meow = await autocannon({
		url,
		connections: 100,
		duration: BENCH_DURATION,
		workers: Math.max(1, Math.floor(navigator.hardwareConcurrency / 4)),
	});

	return {
		rps: meow.requests.mean,
		mean: meow.latency.mean,
		p90: meow.latency.p90,
		p975: meow.latency.p97_5,
		p99: meow.latency.p99,
	};
}

function inform(name: string, results: Record<string, BenchResult>) {
	console.log("\n");
	const table: Record<string, string> = {};
	for (const scenario of scenarios) {
		const res = results[scenario.name];
		table[scenario.name] = `${(res.rps / 1000).toFixed(1)}k rps · ${res.mean.toFixed(1)}ms avg`;
	}
	console.table({ [name]: table });

	console.log(`\n  + detailed results\n`);
	console.log(`    - ${name}`);
	for (const scenario of scenarios) {
		const res = results[scenario.name];
		console.log(`      • ${scenario.name}`);
		console.log(`        ${res.rps.toFixed(0)} req/s`);
		console.log(
			`        mean ${res.mean.toFixed(2)}ms, 90% ${res.p90.toFixed(2)}ms, 97.5% ${res.p975.toFixed(2)}ms, 99% ${
				res.p99.toFixed(2)
			}ms`,
		);
	}
}

const results: Record<string, Record<string, BenchResult>> = {};

for (const [name, server] of Object.entries(servers)) {
	const controller = new AbortController();
	results[name] = {}, await begin(name, server, controller);

	console.log(`  + ${name}: *warmup*`);
	for (let i = 0; i < WARMUP_ROUNDS; i++) {
		for (const scenario of scenarios) {
			console.log(`    - ${i + 1}/${WARMUP_ROUNDS} @ ${scenario.name}`);
			await bench(`http://127.0.0.1:${port}${scenario.path}`);
		}
	}

	for (const scenario of scenarios) {
		console.log(`\n  + ${name}: ${scenario.name}`);
		results[name][scenario.name] = await bench(`http://127.0.0.1:${port}${scenario.path}`);
	}

	inform(name, results[name]), controller.abort();
	await new Promise((r) => setTimeout(r, 1000));
}
