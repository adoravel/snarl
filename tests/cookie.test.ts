/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { CookieJar, deleteCookie, parseCookies, serialiseCookie } from "@july/snarl";

Deno.test("parseCookies", async (t) => {
	await t.step("parses simple pairs", () => {
		assertEquals(parseCookies("a=1; b=2"), { a: "1", b: "2" });
	});
	await t.step("null/empty header becomes empty object", () => {
		assertEquals(parseCookies(null), {});
		assertEquals(parseCookies(""), {});
	});
	await t.step("decodes URL-encoded values", () => {
		assertEquals(parseCookies("token=abc%20123"), { token: "abc 123" });
	});
	await t.step("malformed percent-encoding falls back to raw value", () => {
		assertEquals(parseCookies("bad=%ZZ"), { bad: "%ZZ" });
	});
	await t.step("skips entries with no '='", () => {
		assertEquals(parseCookies("a=1; bogus; b=2"), { a: "1", b: "2" });
	});
	await t.step("trims surrounding whitespace", () => {
		assertEquals(parseCookies(" a = 1 ; b = 2 "), { a: "1", b: "2" });
	});
	await t.step("value itself may contain '='", () => {
		assertEquals(parseCookies("token=a=b=c"), { token: "a=b=c" });
	});
	await t.step("empty value is preserved", () => {
		assertEquals(parseCookies("a="), { a: "" });
	});
});

Deno.test("serialiseCookie", async (t) => {
	await t.step("defaults: Secure, HttpOnly, SameSite=Lax", () => {
		assertEquals(serialiseCookie("s", "v"), "s=v; Secure; HttpOnly; SameSite=Lax");
	});
	await t.step("URL-encodes the value", () => {
		assertEquals(serialiseCookie("s", "a b"), "s=a%20b; Secure; HttpOnly; SameSite=Lax");
	});
	await t.step("secure: false omits Secure", () => {
		assertEquals(serialiseCookie("s", "v", { secure: false }).includes("Secure"), false);
	});
	await t.step("httpOnly: false omits HttpOnly", () => {
		assertEquals(serialiseCookie("s", "v", { httpOnly: false }).includes("HttpOnly"), false);
	});
	await t.step("expires renders UTC string", () => {
		const d = new Date("2026-06-01T00:00:00Z");
		assertEquals(
			serialiseCookie("s", "v", { expires: d, secure: false, httpOnly: false }).includes(
				"Expires=Mon, 01 Jun 2026",
			),
			true,
		);
	});
	await t.step("maxAge renders exactly, including 0", () => {
		assertEquals(
			serialiseCookie("s", "v", { maxAge: 0, secure: false, httpOnly: false }).includes(
				"Max-Age=0",
			),
			true,
		);
	});
	await t.step("domain and path render when present", () => {
		const out = serialiseCookie("s", "v", {
			domain: "example.com",
			path: "/api",
			secure: false,
			httpOnly: false,
		});
		assertEquals(out.includes("Domain=example.com"), true);
		assertEquals(out.includes("Path=/api"), true);
	});
	await t.step("sameSite: explicit value overrides default", () => {
		assertEquals(
			serialiseCookie("s", "v", { sameSite: "Strict", secure: false, httpOnly: false }).includes(
				"SameSite=Strict",
			),
			true,
		);
	});
	await t.step("sameSite: empty string omits the attribute entirely", () => {
		const out = serialiseCookie("s", "v", { sameSite: "" as any, secure: false, httpOnly: false });
		assertEquals(out.includes("SameSite"), false);
	});
	await t.step("sameSite: undefined falls back to Lax", () => {
		assertEquals(
			serialiseCookie("s", "v", { sameSite: undefined, secure: false, httpOnly: false }).includes(
				"SameSite=Lax",
			),
			true,
		);
	});
	await t.step("prefix 'host': forces __Host- name, Path=/, Secure, forbids Domain", () => {
		const out = serialiseCookie("s", "v", { prefix: "host", domain: "example.com", path: "/x" });
		assertEquals(out.startsWith("__Host-s="), true);
		assertEquals(out.includes("Path=/"), true);
		assertEquals(out.includes("Secure"), true);
		assertEquals(out.includes("Domain="), false);
	});
	await t.step(
		"prefix 'secure': forces __Secure- name and Secure, leaves other options alone",
		() => {
			const out = serialiseCookie("s", "v", { prefix: "secure", path: "/x", httpOnly: false });
			assertEquals(out.startsWith("__Secure-s="), true);
			assertEquals(out.includes("Secure"), true);
			assertEquals(out.includes("Path=/x"), true);
		},
	);
});

Deno.test("deleteCookie", async (t) => {
	await t.step("sets Expires in the past and Max-Age=0", () => {
		const out = deleteCookie("s");
		assertEquals(out.includes("Expires=Thu, 01 Jan 1970"), true);
		assertEquals(out.includes("Max-Age=0"), true);
	});
	await t.step("forwards domain/path for exact-match deletion", () => {
		const out = deleteCookie("s", { domain: "example.com", path: "/admin" });
		assertEquals(out.includes("Domain=example.com"), true);
		assertEquals(out.includes("Path=/admin"), true);
	});
});

Deno.test("CookieJar", async (t) => {
	await t.step("get/has read from the parsed header", () => {
		const jar = new CookieJar("a=1; b=2");
		assertEquals(jar.get("a"), "1");
		assertEquals(jar.get("missing"), undefined);
		assertEquals(jar.has("a"), true);
		assertEquals(jar.has("missing"), false);
	});
	await t.step("parsing is lazy and cached (second read reuses the same object)", () => {
		const jar = new CookieJar("a=1");
		const first = jar.allCookies();
		const second = jar.allCookies();
		assertEquals(first, second);
	});
	await t.step("allCookies returns a defensive copy", () => {
		const jar = new CookieJar("a=1");
		const copy = jar.allCookies();
		copy.b = "2";
		assertEquals(jar.has("b"), false);
	});
	await t.step("set() updates the read-side cache immediately", () => {
		const jar = new CookieJar("a=1");
		jar.set("a", "2");
		assertEquals(jar.get("a"), "2");
	});
	await t.step("set() replaces a prior Set-Cookie for the same name rather than appending", () => {
		const jar = new CookieJar(null);
		jar.set("a", "1");
		jar.set("a", "2");
		assertEquals(jar.headers.length, 1);
		assertEquals(jar.headers[0].startsWith("a=2"), true);
	});
	await t.step("set() for distinct names appends distinct headers", () => {
		const jar = new CookieJar(null);
		jar.set("a", "1");
		jar.set("b", "2");
		assertEquals(jar.headers.length, 2);
	});
	await t.step("delete() removes from the read-side and appends a deletion header", () => {
		const jar = new CookieJar("a=1; b=2");
		jar.delete("a");
		assertEquals(jar.has("a"), false);
		assertEquals(jar.has("b"), true);
		const header = jar.headers.find((h) => h.startsWith("a="));
		assertEquals(header?.includes("Max-Age=0"), true);
	});
	await t.step("null header: every read method degrades gracefully", () => {
		const jar = new CookieJar(null);
		assertEquals(jar.get("x"), undefined);
		assertEquals(jar.has("x"), false);
		assertEquals(jar.allCookies(), {});
		assertEquals(jar.headers, []);
	});
	await t.step("headers getter reflects live accumulated Set-Cookie state, not a snapshot", () => {
		const jar = new CookieJar(null);
		const before = jar.headers;
		jar.set("a", "1");
		assertNotEquals(before.length, jar.headers.length);
	});
});
