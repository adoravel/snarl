/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Context, Middleware } from "@july/snarl";

const INJECTIONS = Symbol("imouto.injections");

interface Queue {
	head: string[];
	body: string[];
}

function getQueue(ctx: Context): Queue {
	return ctx.state.getOrInsertComputed(INJECTIONS, () => ({ head: [], body: [] })) as Queue;
}

/** queues `html` to go right before `</head>` on this response */
export function injectIntoHead(ctx: Context, html: string): void {
	if (html) getQueue(ctx).head.push(html);
}

/** queues `html` to go right before `</body>` on this response */
export function injectIntoBody(ctx: Context, html: string): void {
	if (html) getQueue(ctx).body.push(html);
}

/** splices queued markup into html responses. registered by `createApp` */
export function htmlInjection(): Middleware {
	return async (ctx, next) => {
		const response = await next();

		const queue = ctx.state.get(INJECTIONS) as Queue | undefined;
		if (!queue || (!queue.head.length && !queue.body.length)) return response;
		if (!(response.headers.get("Content-Type") ?? "").includes("text/html")) return response;

		return response.pipeThrough(
			new HtmlInjector({ head: queue.head.join(""), body: queue.body.join("") }),
		);
	};
}

export interface Injections {
	head?: string;
	body?: string;
}

interface Target {
	content: string;
	marker: RegExp;
	fallbacks: RegExp[];
	element: string;
}

const HEAD_END = /<\/head>/;
const BODY_OPEN = /<body(?:\s[^>]*)?>/;
const BODY_END = /<\/body>/;
const HTML_END = /<\/html>/;

function heldBack(buffer: string, markers: string[]): number {
	let keep = 0;
	for (const marker of markers) {
		for (let n = Math.min(buffer.length, marker.length - 1); n > keep; n--) {
			if (buffer.endsWith(marker.slice(0, n))) {
				keep = n;
				break;
			}
		}
	}
	return keep;
}

/**
 * a byte stream transform that inserts markup before `</head>` and
 * `</body>` as the html streams through, without buffering the whole page.
 * a page without those tags gets the markup wrapped in the element it
 * belongs to, before `<body>`/`</html>` or at the very end
 */
export class HtmlInjector extends TransformStream<Uint8Array, Uint8Array> {
	constructor(injections: Injections) {
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const pending: Target[] = [];
		if (injections.head) {
			pending.push({
				content: injections.head,
				marker: HEAD_END,
				fallbacks: [BODY_OPEN, HTML_END],
				element: "head",
			});
		}
		if (injections.body) {
			pending.push({
				content: injections.body,
				marker: BODY_END,
				fallbacks: [HTML_END],
				element: "body",
			});
		}

		let buffer = "";

		const inject = (final: boolean) => {
			while (pending.length) {
				const target = pending[0];
				const at = target.marker.exec(buffer);
				if (at) {
					buffer = buffer.slice(0, at.index) + target.content + buffer.slice(at.index);
				} else {
					const wrapped = `<${target.element}>${target.content}</${target.element}>`;
					const fallback = target.fallbacks.map((re) => re.exec(buffer)).find(Boolean);
					if (fallback) {
						buffer = buffer.slice(0, fallback.index) + wrapped + buffer.slice(fallback.index);
					} else if (final) {
						buffer += wrapped;
					} else {
						return;
					}
				}
				pending.shift();
			}
		};

		super({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				inject(false);

				const markers = pending.length
					? [...(pending[0].element === "head" ? ["</head>"] : []), "</body>", "</html>"]
					: [];
				const keep = heldBack(buffer, markers);
				const out = keep ? buffer.slice(0, -keep) : buffer;
				buffer = keep ? buffer.slice(-keep) : "";
				if (out) controller.enqueue(encoder.encode(out));
			},
			flush(controller) {
				buffer += decoder.decode();
				inject(true);
				if (buffer) controller.enqueue(encoder.encode(buffer));
			},
		});
	}
}
