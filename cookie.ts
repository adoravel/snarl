/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

/**
 * @module cookie
 * Utilities for parsing, serializing, and managing HTTP Cookies.
 */

/**
 * configuration options for setting a cookie
 */
export interface CookieOptions {
	/**
	 * the expiration date of the cookie. if omitted, the cookie becomes a session cookie
	 */
	expires?: Date;
	/**
	 * the maximum age of the cookie in seconds
	 */
	maxAge?: number;
	/**
	 * the domain for which the cookie is valid
	 */
	domain?: string;
	/**
	 * the path for which the cookie is valid. defaults to `/`
	 */
	path?: string;
	/**
	 * whether the cookie will only be sent if the connection is established through HTTPS. defaults to `true`
	 */
	secure?: boolean;
	/**
	 * whether the cookie disallows to be accessed via javascript. defaults to `true`
	 */
	httpOnly?: boolean;
	/**
	 * the `SameSite` attribute (`Strict`, `Lax`, or `None`).
	 * Defaults to `Lax`
	 */
	sameSite?: "Strict" | "Lax" | "None";
}

/**
 * parses the `Cookie` header string into an object
 * @param header the value of the `Cookie` request header
 * @returns an object mapping cookie names to their decoded values
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
 * serializes a cookie into a `Set-Cookie` header string
 * @param name the name of the cookie
 * @param value the value of the cookie
 * @param options additional options for the cookie
 * @returns a formatted `Set-Cookie` header string
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
 * creates a `Set-Cookie` header string that instructs the client to delete a cookie
 * @param name the name of the cookie to delete
 * @param options options such as domain or path to ensure the cookie matches correctly
 * @returns a formatted `Set-Cookie` header string
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
 * a helper class to manage request cookies (input) and response cookies (output)
 */
export class CookieJar {
	private cookies: Record<string, string>;
	private setCookieHeaders: string[] = [];

	/**
	 * parses the `Cookie` header and creates a new `CookieJar` instance
	 * @param header the value of the `Cookie` request header
	 */
	constructor(header: string | null) {
		this.cookies = parseCookies(header);
	}

	/**
	 * gets a cookie value from the request
	 * @param name the name of the cookie
	 * @returns the cookie value or undefined if not found
	 */
	get(name: string): string | undefined {
		return this.cookies[name];
	}

	/**
	 * sets and overwrites (if previously set) a cookie to be sent in the response.
	 * @param name the name of the cookie
	 * @param value the value of the cookie
	 * @param options options for the cookie (`path`, `maxAge`, etc.)
	 */
	set(name: string, value: string, options?: CookieOptions): void {
		this.cookies[name] = value;
		this.setCookieHeaders = this.setCookieHeaders.filter((h) => !h.startsWith(`${name}=`));
		this.setCookieHeaders.push(serializeCookie(name, value, options));
	}

	/**
	 * deletes a cookie by setting its expiration to the past
	 * @param name the name of the cookie to delete
	 * @param options options such as domain/path to ensure correct matching
	 */
	delete(name: string, options?: Omit<CookieOptions, "expires" | "maxAge">): void {
		delete this.cookies[name];
		this.setCookieHeaders.push(deleteCookie(name, options));
	}

	/**
	 * checks if a cookie exists in the request
	 * @param name the name of the cookie
	 * @returns whether the cookie exists
	 */
	has(name: string): boolean {
		return name in this.cookies;
	}

	/**
	 * returns a copy of all cookies from the request
	 * @returns an object of all cookie names and values
	 */
	allCookies(): Record<string, string> {
		return { ...this.cookies };
	}

	/**
	 * gets the list of `Set-Cookie` header strings to be sent in the response
	 * @returns an array of header strings
	 */
	get headers(): string[] {
		return this.setCookieHeaders;
	}
}

export type Cookies = CookieJar;
