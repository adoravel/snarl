/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { abortable } from "@std/async";
import type { Context } from "./context/mod.ts";
import { TextLineStream } from "@std/streams";

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

async function* formatSSE(messages: AsyncIterable<SSEMessage> | Iterable<SSEMessage>) {
	const encoder = new TextEncoder();

	for await (const msg of messages) {
		let chunk = "";
		if (msg.event) chunk += `event: ${msg.event}\n`;
		if (msg.id) chunk += `id: ${msg.id}\n`;
		if (msg.retry) chunk += `retry: ${msg.retry}\n`;
		for (const line of msg.data.split("\n")) chunk += `data: ${line}\n`;
		chunk += "\n";

		yield encoder.encode(chunk);
	}
}

/**
 * creates a `Response` that streams server-sent events
 * @param ctx the request context
 * @param source an async iterable or a function returning one
 * @param init optional `ResponseInit` body.
 */
export function sse(
	ctx: Context,
	source: AsyncIterable<SSEMessage> | (() => AsyncIterable<SSEMessage>),
	init?: ResponseInit,
): Response {
	const iterable = typeof source === "function" ? source() : source;
	const stream = ReadableStream.from(
		abortable(formatSSE(iterable), ctx.request.signal),
	);

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

async function* toUint8Array(source: AsyncIterable<string | ArrayBufferView>) {
	const encoder = new TextEncoder();
	for await (const chunk of source) {
		yield typeof chunk === "string" ? encoder.encode(chunk) : chunk;
	}
}

/**
 * creates a streaming Response from an async iterable of data
 * @param source an async iterable of strings or Uint8Arrays
 * @param init optional `ResponseInit` body
 */
export function stream(
	ctx: Context,
	source:
		| AsyncIterable<string | ArrayBufferView>
		| (() => AsyncIterable<string | ArrayBufferView>),
	init?: ResponseInit,
): Response {
	const iterable = typeof source === "function" ? source() : source;
	const readable = ReadableStream.from(
		abortable(toUint8Array(iterable), ctx.request.signal),
	);

	return new Response(readable, init);
}

async function* extractData(lines: AsyncIterable<string>) {
	for await (const line of lines) {
		if (line.startsWith("data:")) {
			yield line[5] === " " ? line.slice(6) : line.slice(5);
		}
	}
}

/**
 * parses a raw SSE byte stream into a stream of data strings
 *
 * @param stream the raw byte stream (e.g., `response.body` from a `fetch` request)
 * @returns a `ReadableStream` yielding the extracted SSE data string payloads
 *
 * @example
 * ```ts
 * const response = await fetch("https://api.example.com/events");
 *
 * if (response.body) {
 *   const stream = consume(response.body);
 *   for await (const data of stream) {
 *     console.log("received event data:", data);
 *   }
 * }
 * ```
 */
export function consume(stream: ReadableStream<BufferSource>): ReadableStream<string> {
	const lines = stream
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(new TextLineStream());

	return ReadableStream.from(extractData(lines));
}
