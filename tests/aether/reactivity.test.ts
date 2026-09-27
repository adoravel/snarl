/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assertEquals } from "@std/assert";
import "./globals.ts";
import { effect, setEffectErrorHandler, signal } from "@404/aether/reactivity";

Deno.test("effects: one that throws is reported, and the rest keep updating", () => {
	const errors: unknown[] = [];
	const restore = setEffectErrorHandler((error) => errors.push(error));
	try {
		const count = signal(0);
		const seen: number[] = [];

		effect(() => {
			if (count() === 2) throw new Error("boom");
		});
		effect(() => void seen.push(count()));

		count(1);
		count(2);
		count(3);

		assertEquals(errors.length, 1);
		assertEquals((errors[0] as Error).message, "boom");
		assertEquals(seen, [0, 1, 2, 3], "the second effect is unaffected");
	} finally {
		setEffectErrorHandler(restore);
	}
});
