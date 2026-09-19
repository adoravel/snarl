/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { client, window } from "./dom.ts";

const { document } = window;
const h = client.jsx as (tag: any, props?: any) => any;

function links(): string[] {
	return [...document.head.querySelectorAll("link")].map((l) => l.getAttribute("href")!);
}

Deno.test("client css: use() links the sheet once", () => {
	document.head.innerHTML = "";
	const sheet = client.css`:scope { color: red }`;
	sheet.use();
	sheet.use();
	assertEquals(links(), [`/_css/${sheet.id}.css`]);
});

Deno.test("client css: rendering a scoped component or coercing to a class links the sheet", () => {
	document.head.innerHTML = "";
	const sheet = client.css`.a { color: blue }`;
	const el = h(sheet.div, { class: "a" }) as HTMLElement;
	assertEquals(el.className, `${sheet.id} a`);
	assertEquals(links(), [`/_css/${sheet.id}.css`]);

	const other = client.css`.b { color: green }`;
	assertEquals(`${other}`, other.id);
	assertEquals(links(), [`/_css/${sheet.id}.css`, `/_css/${other.id}.css`]);
});

Deno.test("client css: sheets the server already linked are not linked again", async () => {
	const sheet = client.css`.seeded { color: red }`;
	document.head.innerHTML = `<link rel="stylesheet" href="/_css/${sheet.id}.css">`;
	const fresh = await import(`../../packages/aether/src/client/css.ts?seed=${Date.now()}`);
	fresh.css`.seeded { color: red }`.use();
	assertEquals(links(), [`/_css/${sheet.id}.css`]);
});

Deno.test("client css: styled components get their own sheet", () => {
	document.head.innerHTML = "";
	const Box = client.styled.section`padding: 1rem`;
	const el = h(Box, {}) as HTMLElement;
	assertEquals(el.tagName, "SECTION");
	assertEquals(links(), [`/_css/${el.className}.css`]);
});
