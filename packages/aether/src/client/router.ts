/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { batch, type Signal, signal } from "../reactivity/mod.ts";
import { attach } from "./mod.ts";
import { type JSX, lazy } from "./jsx-runtime.ts";

export interface RouteState {
	pathname: string;
	search: string;
	hash: string;

	/** the matched route's pattern, `null` when nothing matched */
	pattern: string | null;
	params: Record<string, string>;
}

/** what a page or layout receives on both sides. `ctx` only exists on the server */
export interface PageProps {
	params: Record<string, string>;
	url: URL;
	ctx?: unknown;
}

export interface LayoutProps extends PageProps {
	children: unknown;
}

export type PageComponent = (props: PageProps) => JSX.Node;
export type LayoutComponent = (props: LayoutProps) => JSX.Node;

export interface SpaRoute {
	/** a snarl pattern: `/blog/:id`, `/docs/*rest`, `/users/:id?` */
	pattern: string;
	page: PageComponent;

	/** layouts between the shell and the page, outermost first */
	layouts: LayoutComponent[];
}

export interface SpaManifest {
	/** most specific first; the first match wins */
	routes: SpaRoute[];
	notFound?: PageComponent;
}

export interface MountSpaOptions {
	/** selector of the element the app owns. defaults to `[data-x-spa]` */
	root?: string;
}

export interface NavigateOptions {
	/** replace the current history entry instead of pushing one */
	replace?: boolean;

	/** scroll to the top after rendering. defaults to `true` unless the url has a hash */
	scroll?: boolean;
}

interface Compiled {
	route: SpaRoute;
	regex: RegExp;
	keys: string[];
}

function compile(route: SpaRoute): Compiled {
	const keys: string[] = [];
	let source = "";
	for (const segment of route.pattern.split("/").filter(Boolean)) {
		if (segment.startsWith("*")) {
			keys.push(segment.slice(1) || "*");
			source += "(?:/(.*))?";
		} else if (segment.startsWith(":")) {
			const optional = segment.endsWith("?");
			keys.push(optional ? segment.slice(1, -1) : segment.slice(1));
			source += optional ? "(?:/([^/]+))?" : "/([^/]+)";
		} else {
			source += "/" + segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return { route, keys, regex: new RegExp(`^${source || "/"}/?$`, "i") };
}

function match(
	compiled: Compiled[],
	pathname: string,
): { route: SpaRoute; params: Record<string, string> } | null {
	for (const { route, regex, keys } of compiled) {
		const hit = regex.exec(pathname);
		if (!hit) continue;
		const params: Record<string, string> = {};
		keys.forEach((key, i) => params[key] = decodeURIComponent(hit[i + 1] ?? ""));
		return { route, params };
	}
	return null;
}

/** the current location and match. read it anywhere; it changes on navigation */
export const route: Signal<RouteState> = signal<RouteState>({
	pathname: "/",
	search: "",
	hash: "",
	pattern: null,
	params: {},
});

let app: { compiled: Compiled[]; manifest: SpaManifest; render: () => void } | undefined;

function stateFor(url: URL): RouteState {
	const hit = app ? match(app.compiled, url.pathname) : null;
	return {
		pathname: url.pathname,
		search: url.search,
		hash: url.hash,
		pattern: hit?.route.pattern ?? null,
		params: hit?.params ?? {},
	};
}

/**
 * goes to `to` without a page load: pushes a history entry, updates `route`
 * and renders the matching page. same-origin `<a>` clicks do this on their
 * own; add `data-native` to an anchor to opt out
 */
export function navigate(to: string | URL, options: NavigateOptions = {}): void {
	if (!app) {
		location.assign(String(to));
		return;
	}
	const url = new URL(to, location.href);
	if (url.origin !== location.origin) {
		location.assign(url.href);
		return;
	}

	history[options.replace ? "replaceState" : "pushState"](null, "", url.href);
	batch(() => route(stateFor(url)));
	app.render();

	if (options.scroll ?? !url.hash) {
		scrollTo({ top: 0 });
	} else if (url.hash) {
		document.getElementById(url.hash.slice(1))?.scrollIntoView();
	}
}

function compose(manifest: SpaManifest, state: RouteState): () => JSX.Node {
	const hit = state.pattern === null
		? null
		: manifest.routes.find((r) => r.pattern === state.pattern);
	const url = new URL(state.pathname + state.search + state.hash, location.origin);
	const props: PageProps = { params: state.params, url };

	if (!hit) {
		return () => manifest.notFound ? manifest.notFound(props) : `not found: ${state.pathname}`;
	}

	// each layout gets its content lazily, so the inner markup is built where
	// the layout places it rather than before the layout's own elements
	let build: () => JSX.Node = () => hit.page(props);
	for (const layout of hit.layouts.toReversed()) {
		const inner = build;
		build = () => layout({ ...props, children: lazy(inner) });
	}
	return build;
}

function interceptLinks(event: MouseEvent): void {
	if (event.defaultPrevented || event.button !== 0) return;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

	const anchor = (event.target as Element | null)?.closest("a[href]");
	if (!anchor || anchor.hasAttribute("download") || anchor.hasAttribute("data-native")) return;
	const target = anchor.getAttribute("target");
	if (target && target !== "_self") return;

	const href = anchor.getAttribute("href")!;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith(location.origin)) return;

	const url = new URL(href, location.href);
	if (url.origin !== location.origin) return;

	event.preventDefault();
	navigate(url);
}

/**
 * takes over the element the server rendered the app into: adopts its
 * markup, then renders pages on the client as the location changes.
 * `createApp({ mode: "spa" })` generates the call; use it directly to mount
 * a hand-written manifest
 */
export function mountSpa(manifest: SpaManifest, options: MountSpaOptions = {}): void {
	const root = document.querySelector<HTMLElement>(options.root ?? "[data-x-spa]");
	if (!root) {
		console.warn("aether: mountSpa found nothing to mount on; is this page rendered in spa mode?");
		return;
	}

	const compiled = manifest.routes.map(compile);
	let dispose: (() => void) | null = null;
	let first = true;

	// the first render adopts the server markup; later ones start from nothing
	const render = () => {
		dispose?.();
		dispose = null;
		if (!first) root.replaceChildren();
		first = false;
		const component = compose(manifest, route.peek());
		dispose = attach(root, component, {}, { label: "spa root" });
	};

	app = { compiled, manifest, render };
	route(stateFor(new URL(location.href)));
	render();

	document.addEventListener("click", interceptLinks);
	globalThis.addEventListener("popstate", () => {
		batch(() => route(stateFor(new URL(location.href))));
		render();
	});
}
