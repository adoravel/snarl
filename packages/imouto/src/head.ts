/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import {
	Fragment,
	JSX,
	jsx,
	Middleware,
	MiddlewarePriority,
	provideMiddleware,
	renderToString,
} from "@july/snarl";
import { requireContext } from "./mod.ts";
import { injectIntoHead } from "./inject.ts";

const HEAD_STORE = Symbol("imouto.head");

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

	const key = getElementKey(tag, props) ?? `__auto_${store.size}`;
	store.set(key, { node });
}

async function renderHeadContent(nodes: JSX.Element[]): Promise<string> {
	return await renderToString(jsx(Fragment, { children: nodes }));
}

export function Head({ children }: { children?: any; [key: string]: any }): null {
	const nodes = Array.isArray(children) ? children : [children];

	for (const node of nodes) {
		collectElement(node);
	}

	return null;
}

export function head(): Middleware {
	return async (ctx, next) => {
		const response = await next();

		const store = ctx.state.get(HEAD_STORE) as Map<string, HeadEntry> | undefined;
		if (!store || store.size === 0) return response;

		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/html") || !response.body) {
			return response;
		}

		const nodes = Array.from(store.values(), (e) => e.node);
		const content = await renderHeadContent(nodes);

		return injectIntoHead(ctx, content), response;
	};
}

provideMiddleware({
	name: "head",
	priority: MiddlewarePriority.normal,
	factory: () => head(),
});
