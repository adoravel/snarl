/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { type AstNode, parseSource, walk } from "./analyser.ts";
import { BLOCK } from "../control-flow-types.ts";

export interface Diagnostic {
	message: string;

	/** where it was found, formatted by whoever reports it */
	file?: string;
	line?: number;
	column?: number;

	/** @internal which tag, and which occurrence of it, so the position can be located */
	tag: string;
	nth: number;
}

function tagName(node: AstNode): string | undefined {
	const name = node.openingElement?.name;
	return name?.type === "JSXIdentifier" ? name.name : undefined;
}

function looksComputed(node: AstNode): boolean {
	let current = node;
	while (current?.type === "MemberExpression" || current?.type === "OptionalMemberExpression") {
		current = current.object;
	}
	return current?.type === "CallExpression" || current?.type === "OptionalCallExpression";
}

function isFunction(node: AstNode): boolean {
	return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

export function lintSource(ast: AstNode, file?: string): Diagnostic[] {
	const found: Diagnostic[] = [];
	const counts = new Map<string, number>();

	walk(ast, (node) => {
		if (node.type !== "JSXElement") return;
		const tag = tagName(node);
		if (!tag) return;

		const nth = counts.get(tag) ?? 0;
		counts.set(tag, nth + 1);
		if (tag !== BLOCK.show) return;

		for (const child of node.children ?? []) {
			if (child.type !== "JSXExpressionContainer") continue;
			const expression = child.expression;
			if (!expression || isFunction(expression) || !looksComputed(expression)) continue;

			found.push({
				tag,
				nth,
				file,
				message:
					`<${tag}> has children that are computed once, when the island is built. anything ` +
					`they read is frozen at that value; write {() => …} so the branch is re-evaluated ` +
					`when it is shown`,
			});
		}
	});

	return found;
}

/** where the `nth` `<tag` sits in `source`, counted the way the ast walk counts */
export function locate(
	source: string,
	tag: string,
	nth: number,
): Pick<Diagnostic, "line" | "column"> {
	const needle = new RegExp(`<${tag}(?![\\w-])`, "g");
	let match: RegExpExecArray | null;
	for (let i = 0; (match = needle.exec(source)) !== null; i++) {
		if (i !== nth) continue;
		const before = source.slice(0, match.index);
		const line = before.split("\n").length;
		return { line, column: match.index - (before.lastIndexOf("\n") + 1) };
	}
	return {};
}

/** parses `source` and lints it */
export async function lintIslandSource(
	source: string,
	loader: "jsx" | "tsx" | "ts" | "js",
	file?: string,
): Promise<Diagnostic[]> {
	if (loader !== "jsx" && loader !== "tsx") return [];
	try {
		const issues = lintSource(await parseSource(source, loader), file);
		return issues.map((issue) => ({ ...issue, ...locate(source, issue.tag, issue.nth) }));
	} catch {
		return [];
	}
}
