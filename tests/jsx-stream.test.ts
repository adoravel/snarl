/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { jsx, renderToStream, renderToString } from "@july/snarl/jsx-runtime";
import { createRouter } from "@july/snarl";

const mockInfo = { remoteAddr: { hostname: "127.0.0.1" } } as Deno.ServeHandlerInfo<Deno.NetAddr>;
const h = jsx as (tag: any, props?: any) => any;

function reader(stream: ReadableStream<Uint8Array>) {
	const decoder = new TextDecoder();
	const source = stream.getReader();
	return {
		async next(): Promise<string | null> {
			const { done, value } = await source.read();
			return done ? null : decoder.decode(value);
		},
		cancel(reason: string): Promise<void> {
			return source.cancel(reason);
		},
		async rest(): Promise<string> {
			let out = "";
			for (;;) {
				const { done, value } = await source.read();
				if (done) return out;
				out += decoder.decode(value);
			}
		},
	};
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
	return await new Response(stream).text();
}

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => (resolve = res, reject = rej));
	return { promise, resolve, reject };
}

Deno.test("stream: the shell is flushed before a slow subtree resolves", async () => {
	const slow = deferred<string>();
	const Slow = async () => h("p", { children: await slow.promise });

	const page = h("html", {
		children: [
			h("head", { children: h("title", { children: "hi" }) }),
			h("body", { children: [h("nav", { children: "shell" }), h(Slow, {})] }),
		],
	});

	const parts = reader(renderToStream(page));

	let head = "";
	while (!head.includes("<nav>shell</nav>")) {
		const chunk = await parts.next();
		assert(chunk !== null, "the stream ended before the shell did");
		head += chunk;
	}
	assertStringIncludes(head, "<title>hi</title>");
	assertEquals(head.includes("late"), false, "the slow subtree has not been waited for");

	slow.resolve("late");
	assertStringIncludes(await parts.rest(), "<p>late</p></body></html>");
});

Deno.test("stream: the bytes match what renderToString produces", async () => {
	const Async = async (props: { value: string }) => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		return h("li", { children: props.value });
	};

	const tree = h("div", {
		class: "wrap",
		children: [
			h("img", { src: "/a.png", alt: "" }),
			h("ul", { children: ["a", "b"].map((value) => h(Async, { value })) }),
			h("script", { children: 'var a = "</script>";' }),
			h("span", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }),
			null,
			false,
			42,
			"text & more",
		],
	});

	assertEquals(await collect(renderToStream(tree)), await renderToString(tree));
});

Deno.test("stream: a failing subtree becomes a comment and the rest still arrives", async () => {
	const Boom = () => {
		throw new Error("no");
	};
	const Rejects = () => Promise.reject(new Error("later"));

	const seen: string[] = [];
	const html = await collect(
		renderToStream(
			h("main", { children: [h(Boom, {}), h(Rejects, {}), h("p", { children: "after" })] }),
			{ onError: (error) => seen.push((error as Error).message) },
		),
	);

	assertEquals(
		html,
		"<main><!-- error rendering component --><!-- error rendering component --><p>after</p></main>",
	);
	assertEquals(seen, ["no", "later"]);
});

Deno.test("stream: cancelling the response stops the walk", async () => {
	let reached = false;
	const After = () => {
		reached = true;
		return h("p", { children: "unreachable" });
	};
	const gate = deferred<string>();
	const Slow = async () => h("i", { children: await gate.promise });

	const stream = renderToStream(
		h("div", { children: [h("span", { children: "first" }), h(Slow, {}), h(After, {})] }),
	);
	const parts = reader(stream);
	while (!(await parts.next())!.includes("first"));

	await parts.cancel("done reading");
	gate.resolve("x");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assertEquals(reached, false, "nothing after the cancel is rendered");
});

Deno.test("ctx.htmlStream: streams html with one doctype", async () => {
	const router = createRouter();
	router.get("/", (ctx) => ctx.htmlStream(h("html", { children: h("body", { children: "hi" }) })));
	router.get("/own", (ctx) =>
		ctx.htmlStream([
			{ __html: "<!DOCTYPE html>" },
			h("html", { children: h("body", { children: "mine" }) }),
		]));
	router.get(
		"/bare",
		(ctx) => ctx.htmlStream(h("p", { children: "x" }), { autoDoctype: false, status: 201 }),
	);

	const res = await router.fetch(new Request("http://localhost/"), mockInfo);
	assertEquals(res.headers.get("Content-Type"), "text/html; charset=utf-8");
	assertEquals(await res.text(), "<!DOCTYPE html><html><body>hi</body></html>");

	const own = await router.fetch(new Request("http://localhost/own"), mockInfo);
	assertEquals(await own.text(), "<!DOCTYPE html><html><body>mine</body></html>");

	const bare = await router.fetch(new Request("http://localhost/bare"), mockInfo);
	assertEquals(bare.status, 201);
	assertEquals(await bare.text(), "<p>x</p>");
});
