/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

export interface CookieOptions {
	expires?: Date;
	maxAge?: number;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
	if (!cookieHeader) return {};

	const cookies: Record<string, string> = {};

	for (const cookie of cookieHeader.split(";")) {
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
		cookie += `; SameSite=Strict`;
	}

	return cookie;
}

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

export class CookieJar {
	private cookies: Record<string, string>;
	private setCookieHeaders: string[] = [];

	constructor(cookieHeader: string | null) {
		this.cookies = parseCookies(cookieHeader);
	}

	get(name: string): string | undefined {
		return this.cookies[name];
	}

	set(name: string, value: string, options?: CookieOptions): void {
		this.cookies[name] = value;
		this.setCookieHeaders.push(serializeCookie(name, value, options));
	}

	delete(name: string, options?: Omit<CookieOptions, "expires" | "maxAge">): void {
		delete this.cookies[name];
		this.setCookieHeaders.push(deleteCookie(name, options));
	}

	has(name: string): boolean {
		return name in this.cookies;
	}

	getAll(): Record<string, string> {
		return { ...this.cookies };
	}

	getSetCookieHeaders(): string[] {
		return this.setCookieHeaders;
	}
}

export type Cookies = CookieJar;
