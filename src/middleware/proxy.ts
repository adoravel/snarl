/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Context, Middleware } from "../context/mod.ts";
import { BadRequestError } from "../errors.ts";
import { log } from "../verbosity.ts";

export interface ProxyCookieRewrite {
	/** replaces the cookie's `Domain`. `null` drops the attribute so the cookie binds to this host */
	domain?: string | null;

	/** replaces the cookie's `Path` */
	path?: string;
}

export interface ProxyOptions {
	/**
	 * only requests under this path are proxied; the prefix is stripped
	 * before the path is appended to `target`. defaults to everything
	 */
	prefix?: string;

	/** rewrites the (prefix-stripped) path before it's sent upstream */
	rewrite?: (path: string, ctx: Context) => string;

	/** last look at the upstream request headers */
	headers?: (headers: Headers, ctx: Context) => void;

	/** adds `x-forwarded-for` / `-host` / `-proto`. defaults to `true` */
	forwarded?: boolean;

	/** rewrites `Set-Cookie` attributes on the way back. off by default */
	cookies?: ProxyCookieRewrite;

	/** bridges websocket upgrades to the upstream. off by default */
	websocket?: boolean;

	timeout?: number;

	/** the fetch used to reach the upstream. defaults to the global one */
	fetch?: typeof fetch;
}

const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

function stripHopByHop(headers: Headers): void {
	const named = headers.get("connection")?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
	for (const name of [...HOP_BY_HOP, ...named]) headers.delete(name);
}

function rewriteCookie(cookie: string, rules: ProxyCookieRewrite): string {
	const parts = cookie.split(";").map((p) => p.trim());
	const out = [parts[0]];
	let sawPath = false;
	for (const part of parts.slice(1)) {
		const [name] = part.split("=", 1);
		const key = name.trim().toLowerCase();
		if (key === "domain" && rules.domain !== undefined) {
			if (rules.domain !== null) out.push(`Domain=${rules.domain}`);
			continue;
		}
		if (key === "path" && rules.path !== undefined) {
			sawPath = true;
			out.push(`Path=${rules.path}`);
			continue;
		}
		out.push(part);
	}
	if (rules.path !== undefined && !sawPath) out.push(`Path=${rules.path}`);
	return out.join("; ");
}

function under(path: string, mount: string): boolean {
	return path === mount || path.startsWith(`${mount}/`);
}

/**
 * forwards requests to another server, streaming both ways
 *
 * @example
 * ```ts
 * app.use(proxy("http://127.0.0.1:8008", {
 *   prefix: "/api",
 *   rewrite: (path) => `/_matrix${path}`,
 *   websocket: true,
 * }));
 * ```
 */
export function proxy(target: string | URL, options: ProxyOptions = {}): Middleware {
	const upstream = new URL(target);
	const prefix = options.prefix?.replace(/\/+$/, "") ?? "";
	const base = upstream.pathname.replace(/\/+$/, "");
	const doFetch = options.fetch ?? fetch;

	function upstreamUrl(ctx: Context): URL {
		const incoming = ctx.url.pathname;
		let path = prefix ? incoming.slice(prefix.length) || "/" : incoming;
		if (options.rewrite) path = options.rewrite(path, ctx);

		const url = new URL(upstream);
		url.pathname = `${base}${path.startsWith("/") ? path : `/${path}`}`;
		url.search = ctx.url.search;

		if (base && !under(url.pathname, base)) throw new BadRequestError("invalid path");
		return url;
	}

	function upstreamHeaders(ctx: Context): Headers {
		const headers = new Headers(ctx.request.headers);

		stripHopByHop(headers);
		headers.delete("host");

		if (options.forwarded !== false) {
			const remote = ctx.sender.remoteAddr.hostname;
			const chain = headers.get("x-forwarded-for");
			headers.set("x-forwarded-for", chain ? `${chain}, ${remote}` : remote);
			headers.set("x-forwarded-host", ctx.request.headers.get("host") ?? ctx.url.host);
			headers.set("x-forwarded-proto", ctx.url.protocol.replace(":", ""));
		}
		options.headers?.(headers, ctx);
		return headers;
	}

	function bridgeWebSocket(ctx: Context): Response {
		const url = upstreamUrl(ctx);

		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const protocols = ctx.request.headers.get("sec-websocket-protocol")
			?.split(",").map((p) => p.trim());

		const { socket: client, response } = Deno.upgradeWebSocket(ctx.request, {
			protocol: protocols?.[0],
		});
		const server = new WebSocket(url, protocols);
		server.binaryType = "arraybuffer";
		client.binaryType = "arraybuffer";

		const queue: (string | ArrayBuffer)[] = [];
		client.onmessage = (event) => {
			if (server.readyState === WebSocket.OPEN) server.send(event.data);
			else queue.push(event.data);
		};
		server.onopen = () => {
			for (const message of queue) server.send(message);
			queue.length = 0;
		};
		server.onmessage = (event) => {
			if (client.readyState === WebSocket.OPEN) client.send(event.data);
		};

		const closeBoth = (from: WebSocket, event: CloseEvent) => {
			const other = from === client ? server : client;
			if (other.readyState === WebSocket.OPEN || other.readyState === WebSocket.CONNECTING) {
				try {
					other.close(event.code, event.reason);
				} catch {
					other.close();
				}
			}
		};
		client.onclose = (event) => closeBoth(client, event);
		server.onclose = (event) => closeBoth(server, event);
		server.onerror = () => {
			if (client.readyState === WebSocket.OPEN) client.close(1011, "upstream error");
		};

		return response;
	}

	return async (ctx, next) => {
		if (prefix && !under(ctx.url.pathname, prefix)) return next();

		if (options.websocket && ctx.request.headers.get("upgrade")?.toLowerCase() === "websocket") {
			return bridgeWebSocket(ctx);
		}

		const url = upstreamUrl(ctx);
		const method = ctx.request.method;
		const hasBody = method !== "GET" && method !== "HEAD" && ctx.request.body !== null;
		const signal = options.timeout
			? AbortSignal.any([ctx.request.signal, AbortSignal.timeout(options.timeout)])
			: ctx.request.signal;

		let response: Response;
		try {
			response = await doFetch(url, {
				method,
				headers: upstreamHeaders(ctx),
				body: hasBody ? ctx.request.body : undefined,
				signal,
				redirect: "manual",
				...(hasBody ? { duplex: "half" } : {}),
			} as RequestInit);
		} catch (err) {
			if (ctx.request.signal.aborted) return new Response(null, { status: 499 });
			log.warn("proxy", `upstream ${upstream.origin} failed:`, err);
			return new Response("bad gateway", {
				status: signal.aborted ? 504 : 502,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}

		const headers = new Headers(response.headers);
		stripHopByHop(headers);
		if (options.cookies) {
			const cookies = response.headers.getSetCookie();
			headers.delete("set-cookie");
			for (const cookie of cookies) {
				headers.append("set-cookie", rewriteCookie(cookie, options.cookies));
			}
		}

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}
