/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { Context, Fragment, JSX, jsx, jsxAttr, Middleware, renderToString } from "@july/snarl";
import { requireContext } from "./mod.ts";

const HEAD_RE = /(<head(?:\s[^>]*)?>)/i;
const BODY_RE = /(<body(?:\s[^>]*)?>)/i;
const HEAD_STORE = Symbol("twist.head");
const ATTR_STORE = Symbol("twist.head.attrs");

interface HeadEntry {
	node: JSX.Element;
}

function getHeadStore(): Map<string, HeadEntry> {
	const ctx = requireContext("<Head> needs a request context");
	let store = ctx.state.get(HEAD_STORE);
	if (!store) {
		ctx.state.set(HEAD_STORE, store = new Map());
	}
	return store as Map<string, HeadEntry>;
}

function getAttrStore(): Record<string, string> {
	const ctx = requireContext("<Head> needs a request context");
	let attrs = ctx.state.get(ATTR_STORE);
	if (!attrs) {
		ctx.state.set(ATTR_STORE, attrs = {});
	}
	return attrs as Record<string, string>;
}

function getElementKey(tag: unknown, props: Record<string, any>): string | null {
	if (typeof tag !== "string") return null;

	if (tag === "title") return "title";

	if (tag === "meta") {
		if (props.name) return `meta:name:${props.name}`;
		if (props.property) return `meta:property:${props.property}`;
		if (props.charset) return "meta:charset";
		if (props["http-equiv"]) return `meta:http-equiv:${props["http-equiv"]}`;
		return null;
	}

	if (tag === "link" && props.rel) {
		if (props.href) return `link:${props.rel}:${props.href}`;
		return `link:${props.rel}`;
	}

	if (tag === "script" && props.src) {
		return `script:${props.src}`;
	}

	return null;
}

function collectElement(node: JSX.Node): void {
	if (!node || typeof node !== "object" || !("tag" in node)) return;

	const { tag, props } = node;
	const store = getHeadStore();
	const key = getElementKey(tag, props) ?? crypto.randomUUID();
	store.set(key, { node });
}

function collectAttributes(attrs: Record<string, any>): void {
	const store = getAttrStore();
	for (const [key, value] of Object.entries(attrs)) {
		if (key !== "children" && key !== "key") {
			store[key] = String(value);
		}
	}
}

async function renderHeadContent(nodes: JSX.Element[]): Promise<string> {
	return await renderToString(jsx(Fragment, { children: nodes }));
}

function renderHeadAttributes(attrs: Record<string, string>): string {
	let result = "";
	for (const [key, value] of Object.entries(attrs)) {
		result += jsxAttr(key, value);
	}
	return result ? ` ${result}` : result;
}

export function injectIntoHead(input: string, content?: string, attrs?: Record<string, string>): string {
	if (!content && !attrs) return input;

	const attrs$stringified = attrs ? renderHeadAttributes(attrs) : "";

	if (HEAD_RE.test(input)) {
		input = input.replace(HEAD_RE, (match) => {
			const existing = match.match(/<head(?:\s([^>]*))?>/i);
			if (existing && existing[1].trim()) {
				return match;
			}
			return `<head${attrs$stringified}>`;
		});
		return content ? input.replace(HEAD_RE, `$1${content}`) : input;
	}

	if (BODY_RE.test(input)) {
		return input.replace(BODY_RE, `<head${attrs$stringified}>${content ?? ""}</head>$1`);
	}
	return `<head${attrs$stringified}>${content ?? ""}</head>${input}`;
}

export function Head({ children, ...attrs }: { children?: any; [key: string]: any }): null {
	const nodes = Array.isArray(children) ? children : [children];

	collectAttributes(attrs);
	for (const node of nodes) {
		collectElement(node);
	}

	return null;
}

export function collectHeadContent(ctx: Context): {
	content?: Promise<string>;
	attrs?: Record<string, string>;
} | undefined {
	const store = ctx.state.get(HEAD_STORE) as Map<string, HeadEntry> | undefined;
	const attrs = ctx.state.get(ATTR_STORE) as Record<string, string> | undefined;

	if ((!store || store.size === 0) && !attrs) {
		return;
	}

	const content = store && store.size > 0 ? renderHeadContent(Array.from(store.values(), (e) => e.node)) : undefined;
	return { content, attrs };
}

export function head(): Middleware {
	return async (ctx: Context, next: () => Promise<Response>) => {
		const response = await next();

		const store = ctx.state.get(HEAD_STORE) as Map<string, HeadEntry> | undefined;
		if (!store || !store.size) return response;

		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/html")) return response;

		const nodes = Array.from(store.values()).map((e) => e.node);
		const content = renderHeadContent(nodes);
		const attrs = ctx.state.get(ATTR_STORE) as Record<string, string> || {};

		const html = await response.text();
		const result = injectIntoHead(html, await content, attrs);

		const headers = new Headers(response.headers);
		headers.delete("Content-Length");

		return new Response(result, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}
