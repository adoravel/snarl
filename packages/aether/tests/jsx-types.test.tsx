/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { computed, signal } from "../src/reactivity/mod.ts";

const flag = signal(true);
const count = computed(() => 1);
const text = signal("a");
const maybe = signal<string>();

export const accepted = {
	named: <button type="button" disabled={flag} class={computed(() => "a")} value={text} />,
	checked: <input checked={flag} value={text} />,
	href: <a href={computed(() => "/")}>x</a>,
	style: <div style={computed(() => ({ color: "red" }))} />,

	div: <div draggable={flag} tabIndex={count} title={text} hidden={flag} />,
	optional: <div title={maybe} lang={maybe} />,
	img: <img alt={text} width={count} height={count} />,
	input: <input placeholder={text} readOnly={flag} required={flag} type="email" />,
	label: <label htmlFor={text} />,
	cell: <td colSpan={count} rowSpan={count} />,
	option: <option selected={flag} value={text} />,
	svg: <svg viewBox={text} />,

	static: <div draggable class="x" tabIndex={0} title="t" />,

	patterns: <div data-open={flag} aria-hidden={flag} class:on={flag} />,
	bind: <input bind:value={text} oninput={(event) => event.currentTarget.value} />,

	camel: <button type="button" onClick={(event) => event.currentTarget.disabled} />,
	colon: <button type="button" on:click={(event) => event.currentTarget.disabled} />,
	lower: <button type="button" onclick={(event) => event.currentTarget.disabled} />,

	unknown: <div hx-get="/x" data-anything="y" />,
};

export const rejected = {
	// @ts-expect-error a boolean attribute does not take an object
	object: <div draggable={computed(() => ({}))} />,
	// @ts-expect-error nor a signal of one
	signal: <div hidden={signal({})} />,
	// @ts-expect-error and the static case is unchanged
	static: <div tabIndex={{}} />,
	// @ts-expect-error a handler is given the event, not an arbitrary argument
	handler: <button type="button" onClick={(event: number) => event} />,
};

Deno.test("jsx types: reactive attributes and handlers type-check", () => {
	if (Object.keys(accepted).length !== 19 || Object.keys(rejected).length !== 4) {
		throw new Error("a case was dropped from the type test");
	}
});
