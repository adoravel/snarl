/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import { createRouter } from "@july/snarl";
import { htmlInjection, HtmlInjector, injectIntoBody, injectIntoHead } from "@404/imouto";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;

/** runs `chunks` through the injector one write at a time */
async function inject(chunks: string[], head?: string, body?: string): Promise<string> {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return await new Response(stream.pipeThrough(new HtmlInjector({ head, body }))).text();
}

Deno.test("inject: before </head> and </body>, even when a tag straddles chunks", async () => {
	const page = "<html><head><title>t</title></head><body><p>hi</p></body></html>";
	assertEquals(
		await inject([page], "<link>", "<script></script>"),
		"<html><head><title>t</title><link></head><body><p>hi</p><script></script></body></html>",
	);

	// every possible split point gives the same result
	for (let i = 1; i < page.length; i++) {
		assertEquals(
			await inject([page.slice(0, i), page.slice(i)], "<link>", "<script></script>"),
			"<html><head><title>t</title><link></head><body><p>hi</p><script></script></body></html>",
			`split at ${i}`,
		);
	}
});

Deno.test("inject: a page without <head> gets one before <body>; without <body>, before </html>", async () => {
	assertEquals(
		await inject(["<html><body class=x><p>hi</p></body></html>"], "<link>", "<s>"),
		"<html><head><link></head><body class=x><p>hi</p><s></body></html>",
	);
	assertEquals(
		await inject(["<html><head></head><p>hi</p></html>"], "<link>", "<s>"),
		"<html><head><link></head><p>hi</p><body><s></body></html>",
	);
	assertEquals(
		await inject(["<p>fragment</p>"], "<link>", "<s>"),
		"<p>fragment</p><head><link></head><body><s></body>",
	);
	assertEquals(await inject(["<p>plain</p>"]), "<p>plain</p>", "nothing queued, nothing touched");
});

Deno.test("inject: middleware splices what handlers queued, only into html", async () => {
	const app = createRouter();
	app.use(htmlInjection());
	app.get("/page", (ctx) => {
		injectIntoHead(ctx, "<meta a>");
		injectIntoHead(ctx, "<meta b>");
		injectIntoBody(ctx, "<script></script>");
		return ctx.html("<html><head></head><body></body></html>");
	});
	app.get("/json", (ctx) => {
		injectIntoHead(ctx, "<meta>");
		return ctx.json({ ok: true });
	});

	const page = await app.fetch(new Request("http://localhost/page"), mockInfo);
	assertEquals(
		await page.text(),
		"<!DOCTYPE html><html><head><meta a><meta b></head><body><script></script></body></html>",
	);
	assertEquals(await (await app.fetch(new Request("http://localhost/json"), mockInfo)).json(), {
		ok: true,
	});
});
