/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { Window } from "happy-dom";

export const window = new Window({ url: "http://localhost/" });

const globals = [
	"document",
	"Node",
	"Element",
	"Text",
	"Comment",
	"DocumentFragment",
	"HTMLElement",
	"SVGElement",
	"HTMLAnchorElement",
	"HTMLInputElement",
	"HTMLTemplateElement",
	"HTMLLinkElement",
	"NodeFilter",
	"Event",
	"MouseEvent",
	"InputEvent",
	"AbortController",
] as const;

for (const name of globals) {
	if (!(name in globalThis) || name === "document") {
		Object.defineProperty(globalThis, name, {
			value: (window as any)[name],
			configurable: true,
			writable: true,
		});
	}
}
