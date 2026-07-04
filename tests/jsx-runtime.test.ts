/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
	Fragment,
	isJsxElement,
	JSX,
	jsx,
	jsxAttr,
	jsxEscape,
	jsxTemplate,
	renderToString,
	voidTags,
} from "@july/snarl/jsx-runtime";

Deno.test("jsx: voidTags", () => {
	assertEquals(voidTags.has("br"), true);
	assertEquals(voidTags.has("img"), true);
	assertEquals(voidTags.has("div"), false);
});

Deno.test("jsx: jsx factory", () => {
	const el = jsx("div", { class: "foo" });
	assertEquals(isJsxElement(el), true);
	assertEquals(el.tag, "div");
	assertEquals(el.props.class, "foo");
});

Deno.test("jsx: fragment renders children", async () => {
	const result = await renderToString(jsx(Fragment, { children: "hello" }));
	assertEquals(result, "hello");
});

Deno.test("jsx: dangerouslySetInnerHTML", async () => {
	const result = await renderToString(
		jsx("div", { dangerouslySetInnerHTML: { __html: "<span>hi</span>" } }),
	);
	assertEquals(result, "<div><span>hi</span></div>");
});

Deno.test("jsx: dangerouslySetInnerHTML conflicts with children", () => {
	assertThrows(
		() => {
			const el = jsx("div", {
				dangerouslySetInnerHTML: { __html: "a" },
				children: "b",
			});
			renderToString(el);
		},
		Error,
		"children and dangerouslySetInnerHTML",
	);
});

Deno.test("jsx: void tags are self-closing", async () => {
	const result = await renderToString(jsx("br", {}));
	assertEquals(result, "<br>");

	const img = await renderToString(jsx("img", { src: "a.png", alt: "pic" }));
	assertEquals(img, '<img src="a.png" alt="pic">');
});

Deno.test("jsx: string escaping", async () => {
	const result = await renderToString(jsx("div", { children: "<script>alert(1)</script>" }));
	assertEquals(result, "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
});

Deno.test("jsx: attribute escaping", async () => {
	const result = await renderToString(jsx("div", { "data-x": 'a"b' }));
	assertEquals(result, '<div data-x="a&quot;b"></div>');
});

Deno.test("jsx: boolean attributes", async () => {
	const result = await renderToString(jsx("input", { disabled: true }));
	assertEquals(result, "<input disabled>");
});

Deno.test("jsx: style object", async () => {
	const result = await renderToString(jsx("div", { style: { color: "red", fontSize: "14px" } }));
	assertEquals(result, '<div style="color:red;font-size:14px;"></div>');
});

Deno.test("jsx: component functions", async () => {
	function Greet(props: { name: string }) {
		return jsx("span", { children: `Hello ${props.name}` });
	}
	const result = await renderToString(jsx(Greet as JSX.FC, { name: "World" }));
	assertEquals(result, "<span>Hello World</span>");
});

Deno.test("jsx: async components", async () => {
	function AsyncComp(props: { msg: string }) {
		return jsx("span", { children: props.msg });
	}
	const result = await renderToString(jsx(AsyncComp as JSX.FC, { msg: "async" }));
	assertEquals(result, "<span>async</span>");
});

Deno.test("jsx: component error handling", async () => {
	function Broken() {
		throw new Error("boom💣💥");
	}
	const result = await renderToString(jsx(Broken as JSX.FC, {}));
	assertEquals(result, "<!-- error rendering component -->");
});

Deno.test("jsx: arrays of children", async () => {
	const result = await renderToString(
		jsx("ul", {
			children: [
				jsx("li", { children: "a" }),
				jsx("li", { children: "b" }),
			],
		}),
	);
	assertEquals(result, "<ul><li>a</li><li>b</li></ul>");
});

Deno.test("jsx: nested async children", async () => {
	async function Delayed(props: { ms: number; text: string }) {
		await new Promise((r) => setTimeout(r, props.ms));
		return props.text;
	}
	const result = await renderToString(
		jsx("div", {
			children: [
				jsx(Delayed as JSX.FC, { ms: 1, text: "fast" }),
				jsx(Delayed as JSX.FC, { ms: 1, text: "also-fast" }),
			],
		}),
	);
	assertEquals(result, "<div>fastalso-fast</div>");
});

Deno.test("jsx: null/undefined/false children are ignored", async () => {
	const result = await renderToString(
		jsx("div", { children: [null, "a", undefined, false, "b"] }),
	);
	assertEquals(result, "<div>ab</div>");
});

Deno.test("jsx: jsxEscape", () => {
	assertEquals(jsxEscape(null), "");
	assertEquals(jsxEscape(undefined), "");
	assertEquals(jsxEscape(false), "");
	assertEquals(jsxEscape("safe"), "safe");
	assertEquals(jsxEscape("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
	assertEquals(jsxEscape(42), "42");
});

Deno.test("jsx: jsxAttr", () => {
	assertEquals(jsxAttr("class", null), "");
	assertEquals(jsxAttr("class", false), "");
	assertEquals(jsxAttr("disabled", true), "disabled");
	assertEquals(jsxAttr("class", "foo"), 'class="foo"');
});

Deno.test("jsx: jsxTemplate", async () => {
	const result = await jsxTemplate`<div>${"meow"} ${">_<"}</div>`;
	assertEquals(result, "<div>meow &gt;_&lt;</div>");
});

Deno.test("jsx: data attributes", async () => {
	const result = await renderToString(jsx("div", { "data-x": "1", "data-y": 2 }));
	assertEquals(result.includes('data-x="1"'), true);
	assertEquals(result.includes('data-y="2"'), true);
});
