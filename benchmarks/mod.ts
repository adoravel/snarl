// uses `oha` (https://github.com/hatoo/oha) for benchmarking

import { Table } from "@cliffy/table";
import { bold, cyan, dim, green, magenta, red, stripAnsiCode, white, yellow } from "@std/fmt/colors";
import servers from "./servers.ts";
import { type Scenario, scenarios } from "./scenarios.ts";

interface CliOptions {
	duration: number;
	warmup: number;
	connections: number;
	servers?: string[];
	quick: boolean;
	dry: boolean;
}

function parseArgs(args: string[]): CliOptions {
	const opts: CliOptions = {
		duration: 5,
		warmup: 2,
		connections: 100,
		quick: false,
		dry: false,
	};

	for (const arg of args) {
		if (arg === "--quick" || arg === "-q") {
			opts.quick = true;
			continue;
		}
		if (arg === "--dry" || arg === "--list") {
			opts.dry = true;
			continue;
		}
		const match = arg.match(/^--([\w-]+)=(.+)$/);
		if (!match) continue;

		const [, key, value] = match;
		switch (key) {
			case "duration":
				opts.duration = Number(value);
				break;
			case "warmup":
				opts.warmup = Number(value);
				break;
			case "connections":
				opts.connections = Number(value);
				break;
			case "servers":
				opts.servers = value.split(",").map((s) => s.trim());
				break;
		}
	}

	if (opts.quick) {
		opts.duration = Math.min(opts.duration, 2);
		opts.warmup = Math.min(opts.warmup, 1);
	}

	return opts;
}

const opts = parseArgs(Deno.args);
const port = 6776;

const allServers = Object.entries(servers);
const activeServers = opts.servers ? allServers.filter(([name]) => opts.servers!.includes(name)) : allServers;

if (!activeServers.length) {
	console.error(red(`no matching servers for: ${opts.servers?.join(", ")}`));
	console.error(dim(`available: ${allServers.map(([n]) => n).join(", ")}`));
	Deno.exit(1);
}

const colours: Record<string, (s: string) => string> = {
	snarl: magenta,
	hono: yellow,
	oak: cyan,
	express: green,
};
const colourFor = (name: string) => colours[name] ?? white;

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
const logfile = `bench-${timestamp}.log`;
const jsonfile = `bench-${timestamp}.json`;

function log(text: string = ""): void {
	console.log(text);
	Deno.writeTextFileSync(logfile, stripAnsiCode(text) + "\n", { append: true });
}

function logRaw(text: string): void {
	console.log(text);
	Deno.writeTextFileSync(logfile, stripAnsiCode(text) + "\n", { append: true });
}

const warmupTime = scenarios.length * opts.warmup;
const benchTime = scenarios.length * opts.duration;
const perServerTime = warmupTime + benchTime + 1;
const totalTime = perServerTime * activeServers.length;

log(bold(cyan("\n  benchmark plan")));
log(
	dim(
		`    servers:      ${activeServers.map(([n]) => colourFor(n)(n)).join(", ")}`,
	),
);
log(dim(`    scenarios:    ${scenarios.map((s) => s.name).join(", ")}`));
log(dim(`    connections:  ${opts.connections}`));
log(
	dim(
		`    warmup:       ${opts.warmup}s × ${scenarios.length} scenarios = ${warmupTime}s per server`,
	),
);
log(
	dim(
		`    measurement:  ${opts.duration}s × ${scenarios.length} scenarios = ${benchTime}s per server`,
	),
);
log(
	bold(
		`    estimated total: ~${Math.ceil(totalTime / 60)} min (${totalTime}s)\n`,
	),
);

if (opts.dry) Deno.exit(0);

try {
	const check = new Deno.Command("oha", { args: ["--version"] });
	const { success } = await check.output();
	if (!success) throw new Error("oha --version failed");
} catch {
	console.error(red("`oha` is not installed or not in PATH"));
	Deno.exit(1);
}

interface BenchResult {
	rps: number;
	mean: number;
	p90: number;
	p99: number;
	errors: number;
}

let activeController: AbortController | null = null;
Deno.addSignalListener("SIGINT", () => {
	console.log(red("\n\n  ✕ interrupted"));
	activeController?.abort();
	Deno.exit(130);
});

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
			if (res.ok && await res.text() === name) return;
		} catch {
			if (i === 9) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	throw new Error(
		`port ${port} didn't respond appropriately after 10 attempts`,
	);
}

async function bench(
	url: string,
	scenario: Scenario,
	duration: number,
): Promise<BenchResult> {
	const args: string[] = [
		"-z",
		`${duration}s`,
		"-c",
		String(opts.connections),
		"--output-format",
		"json",
		"--no-tui",
		"-w",
	];

	if (scenario.method) args.push("-m", scenario.method);
	if (scenario.body) args.push("-d", scenario.body);
	if (scenario.headers) {
		for (const [k, v] of Object.entries(scenario.headers)) {
			args.push("-H", `${k}: ${v}`);
		}
	}
	args.push(url);

	const cmd = new Deno.Command("oha", { args });
	const { stdout, stderr, success } = await cmd.output();

	if (!success) {
		const errorMsg = new TextDecoder().decode(stderr);
		throw new Error(`oha failed: ${errorMsg}`);
	}

	const raw = new TextDecoder().decode(stdout);
	let data: any;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`Failed to parse oha JSON output: ${raw.slice(0, 200)}`);
	}

	const summary = data.summary;
	const latency = data.latencyPercentiles;

	const rps = summary.requestsPerSec;
	const mean = summary.average * 1000;
	const p90 = latency.p90 * 1000;
	const p99 = latency.p99 * 1000;

	let errors = 0;
	if (data.statusCodeDistribution) {
		for (const [code, count] of Object.entries(data.statusCodeDistribution)) {
			const status = parseInt(code);
			if (status >= 500) errors += Number(count);
			else if (status >= 400 && status < 500 && scenario.name !== "404") {
				errors += Number(count);
			}
		}
	}
	return { rps, mean, p90, p99, errors };
}

function scenarioLine(scenario: Scenario, res: BenchResult): string {
	const rps = `${(res.rps / 1000).toFixed(1)}k rps`;
	const latency = `${res.mean.toFixed(1)}ms avg`;
	const stats = res.errors > 0 ? red(`${rps} · ${latency} · ${res.errors} errors`) : `${dim(rps)} · ${dim(latency)}`;
	return `      ${bold("▸")} ${scenario.name.padEnd(16)} ${stats}`;
}

function inform(name: string, results: Record<string, BenchResult>): void {
	const color = colourFor(name);
	logRaw("\n" + bold(color(`${name}`)));

	const table = new Table()
		.header(["scenario", "req/s", "avg", "p90", "p99", "errors"])
		.border(true);

	for (const scenario of scenarios) {
		const res = results[scenario.name];
		table.push([
			scenario.name,
			`${(res.rps / 1000).toFixed(1)}k`,
			`${res.mean.toFixed(1)}ms`,
			`${res.p90.toFixed(1)}ms`,
			`${res.p99.toFixed(1)}ms`,
			res.errors ? red(String(res.errors)) : dim("0"),
		]);
	}
	logRaw(table.toString());
}

function perish(
	allResults: Record<string, Record<string, BenchResult>>,
): void {
	const names = activeServers.map(([n]) => n).filter((n) => allResults[n]);
	if (names.length < 2) return;

	log("\n" + bold(cyan("meow?")));

	const table = new Table()
		.header(["scenario", ...names.map((n) => bold(colourFor(n)(n)))])
		.border(true);

	for (const scenario of scenarios) {
		const row: string[] = [scenario.name];
		const values = names.map((n) => allResults[n]?.[scenario.name]?.rps ?? 0);
		const positive = values.filter((v) => v > 0);
		const max = Math.max(...positive, 0);
		const min = Math.min(...positive, Infinity);

		for (const n of names) {
			const res = allResults[n]?.[scenario.name];
			if (!res) {
				row.push(dim("n/a"));
				continue;
			}
			const cell = `${(res.rps / 1000).toFixed(1)}k`;
			if (res.rps === max && max !== min) row.push(bold(green(cell)));
			else if (res.rps === min && max !== min) row.push(red(cell));
			else row.push(yellow(cell));
		}
		table.push(row);
	}

	logRaw(table.toString());

	const overall = names.map((n) => {
		const rpsList = scenarios.map((s) => allResults[n]?.[s.name]?.rps).filter((
			v,
		): v is number => !!v);
		const geoMean = Math.exp(
			rpsList.reduce((sum, v) => sum + Math.log(v), 0) / rpsList.length,
		);
		return { name: n, geoMean };
	}).sort((a, b) => b.geoMean - a.geoMean);

	log(
		"\n" +
			bold("  overall ranking (geometric mean req/s across all scenarios):"),
	);
	overall.forEach(({ name, geoMean }, i) => {
		const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  ";
		log(
			`    ${medal} ${colourFor(name)(bold(name.padEnd(10)))} ${(geoMean / 1000).toFixed(1)}k rps`,
		);
	});
}

const results: Record<string, Record<string, BenchResult>> = {};
const runStart = performance.now();

for (const [name, server] of activeServers) {
	const controller = new AbortController();
	activeController = controller;
	results[name] = {};

	try {
		await begin(name, server, controller);

		log(bold(colourFor(name)(`\n  ${name}: warming up...`)));
		for (const scenario of scenarios) {
			await bench(
				`http://127.0.0.1:${port}${scenario.path}`,
				scenario,
				opts.warmup,
			);
		}

		log(bold(colourFor(name)(`  ${name}: measuring`)));
		for (const scenario of scenarios) {
			const res = await bench(
				`http://127.0.0.1:${port}${scenario.path}`,
				scenario,
				opts.duration,
			);
			results[name][scenario.name] = res;
			console.log(scenarioLine(scenario, res));
		}

		inform(name, results[name]);
	} catch (error) {
		log(red(`  ✕ ${name} failed: ${(error as Error).message}`));
		delete results[name];
	} finally {
		controller.abort();
		activeController = null;
		await new Promise((r) => setTimeout(r, 1000));
	}
}

perish(results);

const actualTime = ((performance.now() - runStart) / 1000).toFixed(1);
log(bold(cyan(`\n  done in ${actualTime}s`)) + dim(` (log: ${logfile})`));

Deno.writeTextFileSync(jsonfile, JSON.stringify(results, null, 2));
log(dim(`  raw results: ${jsonfile}`));
