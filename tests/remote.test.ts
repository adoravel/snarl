/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRemoteClient, endpoint, remote, ServiceError, v } from "@july/snarl";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
	: false;

const Invoice = v({ id: v.string(), cents: v.number(), paid: v.boolean() });

function upstream() {
	const seen: { method: string; path: string; body: string; auth: string | null }[] = [];
	const server = Deno.serve({ port: 0, onListen() {} }, async (request) => {
		const url = new URL(request.url);
		const body = request.body ? await request.text() : "";
		seen.push({
			method: request.method,
			path: url.pathname + url.search,
			body,
			auth: request.headers.get("authorization"),
		});

		switch (`${request.method} ${url.pathname}`) {
			case "GET /v1/invoices":
				return Response.json({ data: [{ id: "in_1", cents: 500, paid: false }] });
			case "GET /v1/invoices/in_1":
				return Response.json({ id: "in_1", cents: 500, paid: false });
			case "GET /v1/invoices/in_9":
				return Response.json({ error: "no such invoice" }, { status: 404 });
			case "GET /v1/invoices/in_drift":
				return Response.json({ id: "in_drift", cents: "500", paid: false });
			case "POST /v1/invoices/in_1/void":
				return Response.json({ id: "in_1", cents: 500, paid: true });
			case "POST /v1/invoices/in_paid/void":
				return Response.json({ code: "already_paid" }, { status: 409 });
			case "DELETE /v1/invoices/in_1":
				return new Response(null, { status: 204 });
			case "GET /v1/events":
				return new Response(`data: {"id":"in_1","cents":500,"paid":false}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			default:
				return new Response("nope", { status: 500 });
		}
	});
	return { server, seen, url: `http://localhost:${server.addr.port}` };
}

const billing = (url: string) =>
	remote(url, {
		invoices: {
			list: endpoint.get("/v1/invoices", {
				input: v({ customer: v.string(), limit: v.coerce.number().default(20) }),
				output: v({ data: v.array(Invoice) }),
			}),
			get: endpoint.get("/v1/invoices/:id", {
				input: v({ id: v.string() }),
				output: Invoice,
				errors: ["not_found"],
			}),
			void: endpoint.post("/v1/invoices/:id/void", {
				input: v({ id: v.string(), reason: v.string().optional() }),
				output: Invoice,
				errors: ["conflict"],
			}),
			remove: endpoint.delete("/v1/invoices/:id", { input: v({ id: v.string() }) }),
			events: endpoint.stream("/v1/events", { output: Invoice }),
		},
	});

Deno.test("remote: a foreign api gets the same typed call sites", async () => {
	const up = upstream();
	try {
		const client = createRemoteClient(billing(up.url), {
			headers: () => ({ authorization: "Bearer k" }),
		});

		type Invoice = { id: string; cents: number; paid: boolean };
		const _out: Equal<Awaited<ReturnType<typeof client.invoices.get>>, Invoice> = true;
		const _list: Equal<Awaited<ReturnType<typeof client.invoices.list>>, { data: Invoice[] }> =
			true;
		const _in: Equal<
			Parameters<typeof client.invoices.list>[0],
			{ customer: string; limit?: string | number }
		> = true;
		assert(_out && _list && _in);

		assertEquals(await client.invoices.list({ customer: "cus_1" }), {
			data: [{ id: "in_1", cents: 500, paid: false }],
		});
		assertEquals(up.seen[0].path, "/v1/invoices?customer=cus_1&limit=20");
		assertEquals(up.seen[0].auth, "Bearer k", "per-request headers are sent");

		assertEquals(await client.invoices.get({ id: "in_1" }), {
			id: "in_1",
			cents: 500,
			paid: false,
		});
		assertEquals(up.seen[1].path, "/v1/invoices/in_1");

		assertEquals(await client.invoices.void({ id: "in_1", reason: "duplicate" }), {
			id: "in_1",
			cents: 500,
			paid: true,
		});
		assertEquals(up.seen[2].method, "POST");
		assertEquals(JSON.parse(up.seen[2].body), { reason: "duplicate" });

		assertEquals(await client.invoices.remove({ id: "in_1" }), undefined, "204 is nothing");

		assertEquals(
			client.invoices.get.url({ id: "in_1" }),
			`${up.url}/v1/invoices/in_1`,
		);
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: their errors become ours, with the status they chose", async () => {
	const up = upstream();
	try {
		const client = createRemoteClient(billing(up.url));

		const missing = await client.invoices.get.attempt({ id: "in_9" });
		assert(!missing.ok);
		assertEquals(missing.error.code, "not_found");
		assertEquals(missing.error.status, 404);
		assertEquals(missing.error.details, { error: "no such invoice" });

		const mapped = createRemoteClient(billing(up.url), {
			onError: (_response, body) =>
				(body as { code?: string }).code === "already_paid"
					? { code: "conflict", message: "already paid" }
					: undefined,
		});
		const conflict = await mapped.invoices.void.attempt({ id: "in_paid" });
		assert(!conflict.ok);
		assertEquals(conflict.error.code, "conflict");
		assertEquals(conflict.error.message, "already paid");

		const thrown = await assertRejects(() => client.invoices.get({ id: "in_9" }), ServiceError);
		assertEquals(thrown.code, "not_found");
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: the output schema catches the boundary you don't control", async () => {
	const up = upstream();
	try {
		const client = createRemoteClient(billing(up.url));

		const drifted = await client.invoices.get.attempt({ id: "in_drift" });
		assert(!drifted.ok);
		assertEquals(drifted.error.code, "invalid");
		assert(drifted.error.message.includes("unexpected shape"), drifted.error.message);
		assertEquals(drifted.error.details, [
			{ path: ["cents"], message: "expected number, got string" },
		]);
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: a stream endpoint is iterated, not awaited", async () => {
	const up = upstream();
	try {
		const client = createRemoteClient(billing(up.url));
		const got: unknown[] = [];
		for await (const invoice of client.invoices.events()) got.push(invoice);
		assertEquals(got, [{ id: "in_1", cents: 500, paid: false }]);
		assertEquals(up.seen[0].path, "/v1/events");
	} finally {
		await up.server.shutdown();
	}
});

Deno.test("remote: list() describes what was declared", () => {
	assertEquals(
		billing("https://x").list().map((e) => `${e.verb} ${e.url}`),
		[
			"GET /v1/invoices",
			"GET /v1/invoices/:id",
			"POST /v1/invoices/:id/void",
			"DELETE /v1/invoices/:id",
			"GET /v1/events",
		],
	);
});
