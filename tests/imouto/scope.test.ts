/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { scopeCss } from "@404/imouto";

Deno.test("scopeCss: plain selectors become descendants, :scope is the root", () => {
	assertEquals(
		scopeCss(":scope { display: flex } .title { font-size: 2rem }", ".s1"),
		".s1{ display: flex }.s1 .title{ font-size: 2rem }",
	);
});

Deno.test("scopeCss: top-level & is the scope", () => {
	assertEquals(scopeCss("&.active { color: red }", ".s1"), ".s1.active{ color: red }");
	assertEquals(scopeCss("&:hover { color: red }", ".s1"), ".s1:hover{ color: red }");
	assertEquals(scopeCss("& > .child { color: red }", ".s1"), ".s1 > .child{ color: red }");
	assertEquals(scopeCss(".dark & { color: red }", ".s1"), ".dark .s1{ color: red }");
	assertEquals(
		scopeCss("&.a, &.b, .c { color: red }", ".s1"),
		".s1.a,.s1.b,.s1 .c{ color: red }",
	);
});

Deno.test("scopeCss: & inside strings is left alone", () => {
	assertEquals(
		scopeCss(`&[data-x="a&b"] { color: red }`, ".s1"),
		`.s1[data-x="a&b"]{ color: red }`,
	);
});

Deno.test("scopeCss: nested & is passed through for the browser to resolve", () => {
	assertEquals(
		scopeCss(".item { &.active { color: red } }", ".s1"),
		".s1 .item{ &.active { color: red } }",
	);
});

Deno.test("scopeCss: & in a root (unscoped) sheet targets :root", () => {
	assertEquals(scopeCss("&.dark { color: red }", ""), ":root.dark{ color: red }");
});

Deno.test("scopeCss: conditional at-rules are scoped inside, others left alone", () => {
	assertEquals(
		scopeCss("@media (width > 600px) { &.wide { x: y } .a { x: y } }", ".s1"),
		"@media (width > 600px){.s1.wide{ x: y }.s1 .a{ x: y }}",
	);
	assertEquals(
		scopeCss("@keyframes spin { to { x: y } }", ".s1"),
		"@keyframes spin{ to { x: y } }",
	);
});
