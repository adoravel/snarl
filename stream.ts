/**
 * @module stream
 * Utilities for Server-Sent Events (SSE), WebSockets, and generic streaming responses.
 */

/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { Context } from "./middleware.ts";

/**
 * represents a message sent over server-sent events
 */
export interface SSEMessage {
	/** the event name */
	event?: string;
	/** the data payload */
	data: string;
	/** the event identifier */
	id?: string;
	/** the reconnection time in milliseconds */
	retry?: number;
}

/**
 * creates a `Response` that streams server-sent events
 * @param source an async iterable or a function returning one
 * @param init optional `ResponseInit` body.
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
 * creates a streaming Response from an async iterable of data
 * @param source an async iterable of strings or Uint8Arrays
 * @param init optional `ResponseInit` body
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
