/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import express from "./express.ts";
import hono from "./hono.ts";
import oak from "./oak.ts";
import snarl from "./snarl.ts";

export default {
	express: (port: number, signal: AbortSignal) => {
		const server = express.listen(port);
		signal.addEventListener("abort", () => server.close());
	},
	oak: (port: number, signal: AbortSignal) => oak.listen({ port, signal }),
	snarl: (port: number, signal: AbortSignal) => Deno.serve({ port, signal }, snarl),
	hono: (port: number, signal: AbortSignal) => Deno.serve({ port, signal }, hono),
};
