/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertEquals } from "@std/assert";
import { CookieJar, deleteCookie, parseCookies, serializeCookie } from "@july/snarl";

Deno.test("cookie: parseCookies", async (t) => {
	await t.step("parses simple cookie pairs", () => {
		assertEquals(parseCookies("a=1; b=2"), { a: "1", b: "2" });
	});

	await t.step("handles null/empty header", () => {
		assertEquals(parseCookies(null), {});
		assertEquals(parseCookies(""), {});
	});

	await t.step("decodes URL-encoded values", () => {
		assertEquals(parseCookies("token=abc%20123"), { token: "abc 123" });
	});

	await t.step("handles malformed encoding gracefully", () => {
		assertEquals(parseCookies("bad=%ZZ"), { bad: "%ZZ" });
	});

	await t.step("ignores cookies without equals sign", () => {
		assertEquals(parseCookies("a=1; bogus; b=2"), { a: "1", b: "2" });
	});

	await t.step("trims whitespace around pairs", () => {
		assertEquals(parseCookies(" a = 1 ; b = 2 "), { "a": "1", "b": "2" });
	});
});

Deno.test("cookie: serializeCookie", async (t) => {
	await t.step("serializes basic cookie", () => {
		const result = serializeCookie("session", "abc123");
		assertEquals(result, "session=abc123; Secure; HttpOnly; SameSite=Lax");
	});

	await t.step("respects httpOnly: false", () => {
		const result = serializeCookie("session", "abc123", { httpOnly: false });
		assertEquals(result.includes("HttpOnly"), false);
	});

	await t.step("respects secure: false", () => {
		const result = serializeCookie("session", "abc123", { secure: false });
		assertEquals(result.includes("Secure"), false);
	});

	await t.step("sets expires", () => {
		const date = new Date("2026-01-01T00:00:00Z");
		const result = serializeCookie("session", "abc123", { expires: date, secure: false, httpOnly: false });
		assertEquals(result.includes("Expires=Thu, 01 Jan 2026"), true);
	});

	await t.step("sets domain", () => {
		const result = serializeCookie("session", "abc123", { domain: "example.com", secure: false, httpOnly: false });
		assertEquals(result.includes("Domain=example.com"), true);
	});

	await t.step("sets path", () => {
		const result = serializeCookie("session", "abc123", { path: "/api", secure: false, httpOnly: false });
		assertEquals(result.includes("Path=/api"), true);
	});

	await t.step("sets sameSite", () => {
		const result = serializeCookie("session", "abc123", {
			sameSite: "Strict",
			secure: false,
			httpOnly: false,
		});
		assertEquals(result.includes("SameSite=Strict"), true);
	});

	await t.step("defaults sameSite to Lax", () => {
		const result = serializeCookie("session", "abc123", { secure: false, httpOnly: false });
		assertEquals(result.includes("SameSite=Lax"), true);
	});

	await t.step("omits SameSite when explicitly null", () => {
		const result = serializeCookie("session", "abc123", {
			sameSite: undefined as any,
			secure: false,
			httpOnly: false,
		});
		assertEquals(result.includes("SameSite=Lax"), true);
	});
});

Deno.test("cookie: __Host- prefix", async (t) => {
	await t.step("prepends __Host- and forces Secure, Path=/", () => {
		const result = serializeCookie("session", "abc123", { prefix: "host" });
		assertEquals(result.startsWith("__Host-session="), true);
		assertEquals(result.includes("Secure"), true);
		assertEquals(result.includes("Path=/"), true);
		assertEquals(result.includes("Domain="), false);
	});

	await t.step("__Secure- prefix forces Secure only", () => {
		const result = serializeCookie("token", "xyz", {
			prefix: "secure",
			path: "/api",
			httpOnly: false,
		});
		assertEquals(result.startsWith("__Secure-token="), true);
		assertEquals(result.includes("Secure"), true);
		assertEquals(result.includes("Path=/api"), true);
	});
});

Deno.test("cookie: deleteCookie", async (t) => {
	await t.step("sets expiry in the past", () => {
		const result = deleteCookie("session");
		assertEquals(result.includes("Expires=Thu, 01 Jan 1970"), true);
		assertEquals(result.includes("Max-Age=0"), true);
	});

	await t.step("matches domain/path for deletion", () => {
		const result = deleteCookie("session", { domain: "example.com", path: "/admin" });
		assertEquals(result.includes("Domain=example.com"), true);
		assertEquals(result.includes("Path=/admin"), true);
	});
});

Deno.test("cookie: CookieJar", async (t) => {
	await t.step("get returns parsed values", () => {
		const jar = new CookieJar("a=1; b=2");
		assertEquals(jar.get("a"), "1");
		assertEquals(jar.get("b"), "2");
		assertEquals(jar.get("c"), undefined);
	});

	await t.step("has checks existence", () => {
		const jar = new CookieJar("a=1");
		assertEquals(jar.has("a"), true);
		assertEquals(jar.has("b"), false);
	});

	await t.step("allCookies returns copy", () => {
		const jar = new CookieJar("a=1");
		const cookies = jar.allCookies();
		cookies.b = "2";
		assertEquals(jar.has("b"), false);
	});

	await t.step("set overwrites same-name Set-Cookie", () => {
		const jar = new CookieJar(null);
		jar.set("a", "1");
		jar.set("a", "2");
		assertEquals(jar.headers.length, 1);
		assertEquals(jar.headers[0].startsWith("a=2"), true);
	});

	await t.step("set updates parsed cache", () => {
		const jar = new CookieJar("a=1");
		jar.set("a", "2");
		assertEquals(jar.get("a"), "2");
	});

	await t.step("delete removes from cache and adds Set-Cookie", () => {
		const jar = new CookieJar("a=1; b=2");
		jar.delete("a");
		assertEquals(jar.has("a"), false);
		assertEquals(jar.has("b"), true);
		const deletionHeader = jar.headers.find((h) => h.startsWith("a="));
		assertEquals(deletionHeader?.includes("Max-Age=0"), true);
	});

	await t.step("handles null header gracefully", () => {
		const jar = new CookieJar(null);
		assertEquals(jar.get("anything"), undefined);
		assertEquals(jar.has("anything"), false);
		assertEquals(jar.allCookies(), {});
		assertEquals(jar.headers, []);
	});
});
