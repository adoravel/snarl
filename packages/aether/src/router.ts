/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { type Signal, signal } from "./reactivity/mod.ts";

export type {
	LayoutComponent,
	LayoutProps,
	NavigateOptions,
	PageComponent,
	PageProps,
	RouteState,
	SpaManifest,
	SpaRoute,
} from "./client/router.ts";
import type { NavigateOptions, RouteState } from "./client/router.ts";

/**
 * server stand-in for the client router's `route`: pages get their location
 * through props (`params`, `url`), so this only exists to keep isomorphic
 * imports compiling. it never changes
 */
export const route: Signal<RouteState> = signal<RouteState>({
	pathname: "/",
	search: "",
	hash: "",
	pattern: null,
	params: {},
});

/** navigation is a browser thing. on the server, redirect from the handler instead */
export function navigate(_to: string | URL, _options?: NavigateOptions): void {
	throw new Error(
		"aether: navigate() only works in the browser; return a redirect response instead",
	);
}
