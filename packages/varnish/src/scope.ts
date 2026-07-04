/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

const CONDITIONAL_AT = /^@(media|supports|layer|container|document)\b/i;

function isQuote(ch: string): boolean {
	return ch === '"' || ch === "'";
}

function skipString(src: string, start: number): number {
	const quote = src[start];
	let i = start + 1;
	while (i < src.length) {
		if (src[i] === "\\") {
			i += 2;
			continue;
		}
		if (src[i] === quote) return i + 1;
		i++;
	}
	return src.length;
}

function splitSelectors(selector: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";

	for (let i = 0; i < selector.length; i++) {
		const ch = selector[i];
		if (ch === "(") {
			depth++;
			current += ch;
		} else if (ch === ")") {
			depth--;
			current += ch;
		} else if (ch === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function prefixSelector(sel: string, scope: string): string {
	if (sel === ":scope") return scope || ":root";
	sel = sel.replace(/:(root|scope)\b/g, scope);

	if (sel.startsWith(scope)) return sel;

	if (/^::?(view-transition|selection|backdrop|spelling-error|grammar-error|marker|placeholder)\b/i.test(sel)) {
		return sel;
	}
	if (/^::?-webkit-scrollbar/i.test(sel)) return sel;

	if (sel.startsWith("&")) return sel;

	return `${scope} ${sel}`;
}

function prefixSelectors(xs: string, scope: string): string {
	return splitSelectors(xs)
		.map((x) => prefixSelector(x, scope))
		.join(",");
}

function transformRules(src: string, scope: string): string {
	let out = "";
	let i = 0;

	while (i < src.length) {
		while (i < src.length && src[i] <= " ") i++;
		if (i >= src.length) break;

		if (src[i] === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			continue;
		}

		if (src[i] === "}") {
			i++;
			break;
		}

		let sel = "";
		let hasBlock = false;

		scan: while (i < src.length) {
			if (src[i] === "/" && src[i + 1] === "*") {
				const end = src.indexOf("*/", i + 2);
				i = end === -1 ? src.length : end + 2;
				continue;
			}
			if (isQuote(src[i])) {
				const end = skipString(src, i);
				sel += src.slice(i, end);
				i = end;
				continue;
			}
			switch (src[i]) {
				case "{":
					hasBlock = true;
					i++;
					break scan;
				case "}":
					break scan;
				default:
					sel += src[i++];
			}
		}

		sel = sel.trim();
		if (!hasBlock || !sel) break;

		const blockStart = i;
		let depth = 1;
		while (i < src.length && depth > 0) {
			if (isQuote(src[i])) {
				i = skipString(src, i);
				continue;
			}
			if (src[i] === "/" && src[i + 1] === "*") {
				const end = src.indexOf("*/", i + 2);
				i = end === -1 ? src.length : end + 2;
				continue;
			}
			if (src[i] === "{") depth++;
			else if (src[i] === "}") depth--;
			i++;
		}

		const block = src.slice(blockStart, i - 1);
		if (sel.startsWith("@global ")) {
			sel = sel.slice(7).trim();
			out += `${sel}{${block}}`;
			continue;
		}

		if (CONDITIONAL_AT.test(sel)) {
			out += `${sel}{${transformRules(block, scope)}}`;
		} else if (sel.startsWith("@")) {
			out += `${sel}{${block}}`;
		} else {
			out += `${prefixSelectors(sel, scope)}{${block}}`;
		}
	}

	return out;
}

/**
 * @example
 * ```ts
 * scopeCss(":root { display: flex; } .title { font-size: 2rem; }", ".abc123");
 * // => ".abc123 { display: flex; } .abc123 .title { font-size: 2rem; }"
 * ```
 */
export function scopeCss(src: string, scope: string): string {
	return transformRules(src.trim(), scope);
}
