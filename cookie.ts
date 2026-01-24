/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

/**
 * @module cookie
 * Utilities for parsing, serializing, and managing HTTP Cookies.
 */

/**
 * Configuration options for setting a cookie.
 */
export interface CookieOptions {
	/**
	 * The expiration date of the cookie. If omitted, the cookie becomes a session cookie.
	 */
	expires?: Date;
	/**
	 * The max-age of the cookie in seconds.
	 */
	maxAge?: number;
	/**
	 * The domain for which the cookie is valid.
	 */
	domain?: string;
	/**
	 * The path for which the cookie is valid. Defaults to "/".
	 */
	path?: string;
	/**
	 * If true, the cookie is only sent over HTTPS. Defaults to true.
	 */
	secure?: boolean;
	/**
	 * If true, the cookie cannot be accessed via JavaScript. Defaults to true.
	 */
	httpOnly?: boolean;
	/**
	 * The SameSite attribute (Strict, Lax, or None).
	 * Defaults to "Lax" if not provided.
	 */
	sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Parses the `Cookie` header string into an object.
 * @param header - The value of the `Cookie` request header.
 * @returns An object mapping cookie names to their decoded values.
 * @example
 * parseCookies("session=mrrp; user=meow") // { session: "mrrp", user: "meow" }
 */
export function parseCookies(header: string | null): Record<string, string> {
	if (!header) return {};

	const cookies: Record<string, string> = {};

	for (const cookie of header.split(";")) {
		const trimmed = cookie.trim();
		const idx = trimmed.indexOf("=");

		if (idx === -1) continue;

		const name = trimmed.slice(0, idx);
		const value = trimmed.slice(idx + 1);

		try {
			cookies[name] = decodeURIComponent(value);
		} catch {
			cookies[name] = value;
		}
	}

	return cookies;
}

/**
 * Serializes a cookie into a `Set-Cookie` header string.
 * @param name - The name of the cookie.
 * @param value - The value of the cookie.
 * @param options - Additional options for the cookie.
 * @returns A formatted `Set-Cookie` header string.
 */
export function serializeCookie(
	name: string,
	value: string,
	options: CookieOptions = {},
): string {
	let cookie = `${name}=${encodeURIComponent(value)}`;

	if (options.expires) {
		cookie += `; Expires=${options.expires.toUTCString()}`;
	}
	if (options.maxAge !== undefined) {
		cookie += `; Max-Age=${options.maxAge}`;
	}
	if (options.domain) {
		cookie += `; Domain=${options.domain}`;
	}
	if (options.path) {
		cookie += `; Path=${options.path}`;
	}
	if (options.secure !== false) {
		cookie += "; Secure";
	}
	if (options.httpOnly !== false) {
		cookie += "; HttpOnly";
	}
	if (options.sameSite != null) {
		if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
	} else {
		cookie += `; SameSite=Lax`;
	}

	return cookie;
}

/**
 * Creates a `Set-Cookie` header string that instructs the client to delete a cookie.
 * @param name - The name of the cookie to delete.
 * @param options - Options such as domain or path to ensure the cookie matches correctly.
 * @returns A formatted `Set-Cookie` header string.
 */
export function deleteCookie(
	name: string,
	options?: Omit<CookieOptions, "expires" | "maxAge">,
): string {
	return serializeCookie(name, "", {
		...options,
		expires: new Date(0),
		maxAge: 0,
	});
}

/**
 * A helper class to manage request cookies (input) and response cookies (output).
 */
export class CookieJar {
	private cookies: Record<string, string>;
	private setCookieHeaders: string[] = [];

	/**
	 * Creates a new CookieJar instance.
	 * @param cookieHeader - The value of the `Cookie` request header.
	 */
	constructor(cookieHeader: string | null) {
		this.cookies = parseCookies(cookieHeader);
	}

	/**
	 * Gets a cookie value from the request.
	 * @param name - The name of the cookie.
	 * @returns The cookie value or undefined if not found.
	 */
	get(name: string): string | undefined {
		return this.cookies[name];
	}

	/**
	 * Sets a cookie to be sent in the response.
	 * If a cookie with this name has already been set in this instance, it is replaced.
	 * @param name - The name of the cookie.
	 * @param value - The value of the cookie.
	 * @param options - Options for the cookie (path, maxAge, etc.).
	 */
	set(name: string, value: string, options?: CookieOptions): void {
		this.cookies[name] = value;
		this.setCookieHeaders = this.setCookieHeaders.filter((h) => !h.startsWith(`${name}=`));
		this.setCookieHeaders.push(serializeCookie(name, value, options));
	}

	/**
	 * Deletes a cookie by setting its expiration to the past.
	 * @param name - The name of the cookie to delete.
	 * @param options - Options such as domain/path to ensure correct matching.
	 */
	delete(name: string, options?: Omit<CookieOptions, "expires" | "maxAge">): void {
		delete this.cookies[name];
		this.setCookieHeaders.push(deleteCookie(name, options));
	}

	/**
	 * Checks if a cookie exists in the request.
	 * @param name - The name of the cookie.
	 * @returns True if the cookie exists.
	 */
	has(name: string): boolean {
		return name in this.cookies;
	}

	/**
	 * Returns a copy of all cookies from the request.
	 * @returns An object of all cookie names and values.
	 */
	allCookies(): Record<string, string> {
		return { ...this.cookies };
	}

	/**
	 * Gets the list of `Set-Cookie` header strings to be sent in the response.
	 * @returns An array of header strings.
	 */
	get headers(): string[] {
		return this.setCookieHeaders;
	}
}

export type Cookies = CookieJar;
