/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { Fragment, type JSX, jsx } from "@july/snarl/jsx-runtime";
import { type IslandMeta, markIslandUsed } from "./registry.ts";
import { isJsxElement } from "@july/snarl";
import { isReactive } from "../reactivity/mod.ts";

function comment(data: string): JSX.Element {
	return jsx(Fragment, { dangerouslySetInnerHTML: { __html: `<!--${data}-->` } });
}

export interface IslandWrapperOptions {
	/** wrapper element tag around the hydration marker. defaults to "div" */
	as?: string;
}

/**
 * @param name a stable id, unique across the app
 * @param Component the plain isomorphic component to wrap
 * @param moduleUrl `import.meta.resolve(...)` of the file `Component` came from
 */
export function island<P extends Record<string, unknown>>(
	meta: IslandMeta,
	options: IslandWrapperOptions = {},
): (props: P) => JSX.Element {
	const tag = options.as ?? "div";
	const Component = meta.Component as (props: P) => JSX.Node;

	function IslandWrapper(props: P): JSX.Element {
		props ??= {} as P;
		const { children, ...serialisable } = props as Record<string, unknown>;

		assertSerialisableProps(meta.id, serialisable);
		markIslandUsed(meta.id);

		const rendered = Component(
			children != null
				? {
					...props,
					children: [comment("x-slot"), children as JSX.Node, comment("/x-slot")],
				}
				: props,
		);
		const slot = children != null
			? jsx("template", { "data-x-slot": "", children: children as JSX.Node })
			: null;

		return jsx(tag, {
			"data-x-id": meta.id,
			"data-x-props": JSON.stringify(serialisable),
			children: [slot, rendered],
		});
	}

	Object.defineProperty(IslandWrapper, "name", {
		value: `Island(${meta.exportName})`,
		configurable: true,
	});

	return IslandWrapper;
}

const KNOWN_NON_SERIALISABLE = [
	[Set, "Set"],
	[Map, "Map"],
	[RegExp, "RegExp"],
	[WeakMap, "WeakMap"],
	[WeakSet, "WeakSet"],
	[ArrayBuffer, "ArrayBuffer"],
	[Promise, "Promise"],
] as const;

function assertSerialisableProps(id: string, props: Record<string, unknown>): void {
	const seen = new WeakSet<object>();

	function visit(path: string, value: unknown): void {
		if (
			value === null ||
			value === undefined ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			return;
		}

		if (typeof value === "bigint" || typeof value === "symbol") {
			throw new Error(
				`aether: island "${id}" prop "${path}" has unsupported type ${typeof value}`,
			);
		}

		if (typeof value === "function") {
			if (isReactive(value)) {
				throw new Error(
					`aether: island "${id}" prop "${path}" is a signal/computed. Reactive state can't cross ` +
						`the island boundary. consider using \`sharedSignal(key, initial)\``,
				);
			}
			throw new Error(
				`aether: island "${id}" prop "${path}" is a function and can't cross to the client`,
			);
		}

		if (typeof value !== "object") {
			throw new Error(
				`aether: island "${id}" prop "${path}" has unsupported type ${typeof value}`,
			);
		}

		for (const [ctor, label] of KNOWN_NON_SERIALISABLE) {
			if (value instanceof ctor) {
				throw new Error(
					`aether: island "${id}" prop "${path}" is a ${label}, which serializes to "{}" and ` +
						`silently loses its data. convert it before passing it to the island`,
				);
			}
		}
		if (isJsxElement(value)) {
			throw new Error(
				`aether: island "${id}" prop "${path}" is JSX. only "children" can carry JSX into an ` +
					`island.`,
			);
		}

		const objectValue = value as object;
		if (seen.has(objectValue)) {
			throw new Error(`aether: island "${id}" prop "${path}" contains a circular value`);
		}
		seen.add(objectValue);

		if (Array.isArray(objectValue)) {
			objectValue.forEach((item, index) => visit(`${path}[${index}]`, item));
			return;
		}

		for (const key of Object.keys(objectValue)) {
			visit(`${path}.${key}`, (objectValue as Record<string, unknown>)[key]);
		}
	}

	for (const key of Object.keys(props)) {
		visit(key, props[key]);
	}
}
