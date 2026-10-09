/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Context } from "./context/mod.ts";

/**
 * handlers for WebSocket lifecycle events
 */
export interface WebSocketHandler {
	onOpen?: (ws: WebSocket) => void | Promise<void>;
	onMessage?: (ws: WebSocket, event: MessageEvent) => void | Promise<void>;
	onClose?: (ws: WebSocket, event: CloseEvent) => void | Promise<void>;
	onError?: (ws: WebSocket, event: Event | ErrorEvent) => void | Promise<void>;
}

/**
 * upgrades an incoming HTTP connection to a WebSocket connection
 * @param ctx the request context
 * @param handler the WebSocket event handlers
 */
export function upgradeWebSocket(
	ctx: Context,
	handler: WebSocketHandler,
): Response {
	const upgrade = ctx.request.headers.get("upgrade")?.toLowerCase();

	if (!upgrade?.includes("websocket")) {
		return new Response("expected websocket upgrade", {
			status: 426,
			headers: { "Upgrade": "websocket" },
		});
	}

	try {
		const { socket, response } = Deno.upgradeWebSocket(ctx.request);

		if (handler.onOpen) socket.onopen = () => handler.onOpen?.(socket);
		if (handler.onMessage) socket.onmessage = (event) => handler.onMessage?.(socket, event);
		if (handler.onClose) socket.onclose = (event) => handler.onClose?.(socket, event);
		if (handler.onError) socket.onerror = (event) => handler.onError?.(socket, event);

		return response;
	} catch {
		return new Response("Failed to upgrade WebSocket connection", { status: 400 });
	}
}
