/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { globToRegExp, isAbsolute, relative, resolve } from "@std/path";
import type { Message, Plugin } from "esbuild";
import { type AstNode, parseSource, walk } from "./analyser.ts";

export interface ServerOnlyGuardOptions {
	/**
	 * globs (relative to the working directory) of modules that must never
	 * end up in an island bundle, e.g. `["config/site.ts", "db/**"]`
	 */
	serverOnly?: string[];
}

/** globals that only exist server-side. a reference in a browser bundle is a runtime crash */
const SERVER_GLOBALS = new Set(["Deno", "process"]);

/** identifiers aether exports for branching on the environment */
const SERVER_FLAGS = new Set(["isServer"]);
const BROWSER_FLAGS = new Set(["isBrowser"]);

const SOURCE_RE = /\.(m?[jt]sx?)$/;

function loaderFor(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) return "tsx";
	if (path.endsWith(".jsx")) return "jsx";
	if (path.endsWith(".ts") || path.endsWith(".mts")) return "ts";
	return "js";
}

/**
 * which branch of a conditional only runs on the server, if the test says
 * so. covers `isServer`, `!isBrowser`, `typeof Deno !== "undefined"` and
 * their negations
 */
function serverBranch(test: AstNode): "consequent" | "alternate" | null {
	const answer = (server: boolean) => server ? "consequent" : "alternate";

	if (test.type === "Identifier") {
		if (SERVER_FLAGS.has(test.name)) return answer(true);
		if (BROWSER_FLAGS.has(test.name)) return answer(false);
		return null;
	}
	if (test.type === "UnaryExpression" && test.operator === "!") {
		const inner = serverBranch(test.argument);
		return inner === null ? null : inner === "consequent" ? "alternate" : "consequent";
	}
	if (test.type === "BinaryExpression") {
		const { left, right, operator } = test;
		const isTypeof = (n: AstNode) =>
			n.type === "UnaryExpression" && n.operator === "typeof" && n.argument.type === "Identifier";
		const literal = (n: AstNode) => n.type === "Literal" && typeof n.value === "string";
		const [probe, value] = isTypeof(left) && literal(right)
			? [left, right]
			: isTypeof(right) && literal(left)
			? [right, left]
			: [null, null];
		if (!probe || !value) return null;

		const name = probe.argument.name;
		const equals = operator === "===" || operator === "==";
		if (SERVER_GLOBALS.has(name)) {
			return answer(value.value === "undefined" ? !equals : equals);
		}
		if (name === "document" || name === "window") {
			return answer(value.value === "undefined" ? equals : !equals);
		}
	}
	return null;
}

function isBrowserExit(statement: AstNode): boolean {
	if (statement?.type !== "IfStatement" || statement.alternate) return false;
	if (serverBranch(statement.test) !== "alternate") return false;
	const body = statement.consequent;
	const last = body.type === "BlockStatement" ? body.body[body.body.length - 1] : body;
	return last?.type === "ReturnStatement" || last?.type === "ThrowStatement";
}

function findServerReferences(ast: AstNode): Set<string> {
	const found = new Set<string>();
	const declared = new Set<string>();

	walk(ast, (node) => {
		if (
			(node.type === "VariableDeclarator" || node.type === "FunctionDeclaration" ||
				node.type === "ClassDeclaration") && node.id?.type === "Identifier"
		) {
			declared.add(node.id.name);
		}
		if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier") {
			declared.add(node.local.name);
		}
	});

	const visit = (node: AstNode, parent: AstNode | null): void => {
		if (!node || typeof node.type !== "string") return;

		if (node.type === "Identifier" && SERVER_GLOBALS.has(node.name) && !declared.has(node.name)) {
			const isProperty = parent?.type === "MemberExpression" && parent.property === node &&
				!parent.computed;
			const isKey = parent?.type === "Property" && parent.key === node && !parent.computed;
			const isTypeof = parent?.type === "UnaryExpression" && parent.operator === "typeof";
			if (!isProperty && !isKey && !isTypeof) found.add(node.name);
			return;
		}

		let skip: AstNode | undefined;
		if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
			const branch = serverBranch(node.test);
			if (branch) skip = node[branch];
		} else if (node.type === "LogicalExpression" && node.operator === "&&") {
			if (serverBranch(node.left) === "consequent") skip = node.right;
		} else if (node.type === "LogicalExpression" && node.operator === "||") {
			if (serverBranch(node.left) === "alternate") skip = node.right;
		}

		for (const key of Object.keys(node)) {
			if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") {
				continue;
			}
			const value = node[key];
			if (value === skip) continue;
			if (Array.isArray(value)) {
				for (const child of value) {
					visit(child, node);
					if (isBrowserExit(child)) break;
				}
			} else if (value && typeof value === "object") {
				visit(value, node);
			}
		}
	};
	visit(ast, null);
	return found;
}

function locate(source: string, file: string, name: string): Message["location"] {
	const lines = source.split("\n");
	const re = new RegExp(`(^|[^\\w$.])${name}\\b`);
	for (let i = 0; i < lines.length; i++) {
		const match = re.exec(lines[i]);
		if (match) {
			return {
				file,
				namespace: "file",
				line: i + 1,
				column: match.index + match[1].length,
				length: name.length,
				lineText: lines[i],
				suggestion: "",
			};
		}
	}
	return null;
}
export function serverOnlyGuard(options: ServerOnlyGuardOptions = {}): Plugin {
	const cwd = Deno.cwd();
	const blocked = (options.serverOnly ?? []).map((glob) => globToRegExp(glob, { globstar: true }));
	const importers = new Map<string, string>();

	const label = (path: string) =>
		path === "<stdin>" || /^aether-entry-/.test(path) ? "island entry" : relative(cwd, path);
	const chain = (path: string): string => {
		const seen = new Set<string>();
		const parts = [label(path)];
		let current = path;
		while (importers.has(current) && !seen.has(current)) {
			seen.add(current);
			current = importers.get(current)!;
			parts.unshift(label(current));
		}
		return parts.join(" → ");
	};

	return {
		name: "aether-server-only-guard",
		setup(build) {
			build.onResolve({ filter: /^node:/ }, (args) => ({
				errors: [{
					text:
						`aether: "${args.path}" is a node built-in and can't be bundled for the browser (imported via ${
							chain(args.importer)
						})`,
				}],
			}));

			build.onResolve({ filter: /^(\.\.?\/|\/|file:)/ }, (args) => {
				if (!args.importer) return;
				const path = args.path.startsWith("file:")
					? new URL(args.path).pathname
					: isAbsolute(args.path)
					? args.path
					: resolve(args.resolveDir, args.path);
				importers.set(path, args.importer);

				const rel = relative(cwd, path);
				if (blocked.some((re) => re.test(rel))) {
					return {
						errors: [{
							text:
								`aether: "${rel}" is marked server-only and can't be bundled into an island (imported via ${
									chain(args.importer)
								})`,
						}],
					};
				}
			});

			build.onLoad({ filter: SOURCE_RE, namespace: "file" }, async (args) => {
				if (!args.path.startsWith(cwd) || args.path.includes("/node_modules/")) return;

				const source = await Deno.readTextFile(args.path);
				if (!/\b(Deno|process)\b/.test(source)) return;

				let ast: AstNode;
				try {
					ast = await parseSource(source, loaderFor(args.path));
				} catch {
					return;
				}

				const names = findServerReferences(ast);
				if (names.size === 0) return;

				const errors: Message[] = [...names].map((name) => ({
					id: "",
					pluginName: "aether-server-only-guard",
					text:
						`aether: "${
							relative(cwd, args.path)
						}" uses \`${name}\`, which doesn't exist in the browser ` +
						`(bundled via ${
							chain(args.path)
						}). guard it with \`isServer\` or move it out of the island`,
					location: locate(source, relative(cwd, args.path), name),
					notes: [],
					detail: undefined,
				}));
				return { errors };
			});
		},
	};
}
