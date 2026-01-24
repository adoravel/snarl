/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

/**
 * @module stream
 * Utilities for Server-Sent Events (SSE), WebSockets, and generic streaming responses.
 */

import { Context } from "./middleware.ts";

/**
 * Represents a message sent over Server-Sent Events.
 */
export interface SSEMessage {
	/** The event name (optional). */
	event?: string;
	/** The data payload. */
	data: string;
	/** The event ID (optional). */
	id?: string;
	/** The reconnection time in ms (optional). */
	retry?: number;
}

/**
 * Creates a Response that streams Server-Sent Events.
 * @param source - An async iterable or a function returning one.
 * @param init - Optional ResponseInit.
 */
export function sse(
	source: AsyncIterable<SSEMessage> | (() => AsyncIterable<SSEMessage>),
	init?: ResponseInit,
): Response {
	const encoder = new TextEncoder();
	const iterable = typeof source === "function" ? source() : source;

	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const message of iterable) {
					let chunk = "";

					if (message.event) {
						chunk += `event: ${message.event}\n`;
					}
					if (message.id) {
						chunk += `id: ${message.id}\n`;
					}
					if (message.retry) {
						chunk += `retry: ${message.retry}\n`;
					}

					const lines = message.data.split("\n");
					for (const line of lines) {
						chunk += `data: ${line}\n`;
					}

					chunk += "\n"; // eoi
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});

	return new Response(stream, {
		...init,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			...init?.headers,
		},
	});
}

/**
 * Handlers for WebSocket lifecycle events.
 */
export interface WebSocketHandler {
	onOpen?: (ws: WebSocket) => void | Promise<void>;
	onMessage?: (ws: WebSocket, event: MessageEvent) => void | Promise<void>;
	onClose?: (ws: WebSocket, event: CloseEvent) => void | Promise<void>;
	onError?: (ws: WebSocket, event: Event | ErrorEvent) => void | Promise<void>;
}

/**
 * Upgrades an incoming HTTP connection to a WebSocket connection.
 * @param ctx - The request context.
 * @param handler - The WebSocket event handlers.
 * @returns The appropriate Response to perform the upgrade.
 */
export function upgradeWebSocket(
	ctx: Context,
	handler: WebSocketHandler,
): Response {
	const upgrade = ctx.request.headers.get("upgrade")?.toLowerCase();

	if (upgrade !== "websocket") {
		return new Response("expected websocket upgrade", {
			status: 426,
			headers: {
				"Upgrade": "websocket",
			},
		});
	}

	const { socket, response } = Deno.upgradeWebSocket(ctx.request);

	if (handler.onOpen) {
		socket.addEventListener("open", () => {
			handler.onOpen!(socket);
		});
	}

	if (handler.onMessage) {
		socket.addEventListener("message", (event) => {
			handler.onMessage!(socket, event);
		});
	}

	if (handler.onClose) {
		socket.addEventListener("close", (event) => {
			handler.onClose!(socket, event);
		});
	}

	if (handler.onError) {
		socket.addEventListener("error", (event) => {
			handler.onError!(socket, event);
		});
	}
	return response;
}

/**
 * Creates a streaming Response from an async iterable of data.
 * @param source - An async iterable of strings or Uint8Arrays.
 * @param init - Optional ResponseInit.
 */
export function stream(
	source: AsyncIterable<string | Uint8Array> | (() => AsyncIterable<string | Uint8Array>),
	init?: ResponseInit,
): Response {
	const encoder = new TextEncoder();
	const iterable = typeof source === "function" ? source() : source;

	const readable = new ReadableStream({
		async start(controller) {
			try {
				for await (const chunk of iterable) {
					const data = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
					controller.enqueue(data);
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});

	return new Response(readable, init);
}
