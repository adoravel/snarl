/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Middleware } from "../context/middleware.ts";
import type { PermissionRequirement } from "../permissions.ts";
import { preflightPermissions } from "../permissions.ts";

/**
 * conventional priority tiers. lower values sit further **outside** the
 * stack (they run earlier on the request and later on the response)
 */
export const MiddlewarePriority = {
	first: 0,
	early: 250,
	normal: 500,
	late: 750,
	last: 1000,
} as const;

export interface MiddlewareDefinition {
	/** unique id, referenced by other middlewares' `dependencies` */
	readonly name: string;
	/** lower = outer. defaults to `MiddlewarePriority.normal` */
	readonly priority?: typeof MiddlewarePriority[keyof typeof MiddlewarePriority] | number;
	/** names that must be registered and positioned outer to this middleware */
	readonly dependencies?: readonly string[];
	/** permissions this middleware needs. collected across the whole stack and requested once, up front */
	readonly permissions?: readonly PermissionRequirement[];
	/** produces the actual middleware function */
	readonly factory: () => Middleware | Promise<Middleware>;
	/** allow this registration to replace an earlier one with the same name */
	readonly override?: boolean;
}

/** anything `Router.use()` accepts */
export type MiddlewareLike = Middleware | MiddlewareDefinition | string;

export class MiddlewareResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MiddlewareResolutionError";
	}
}

const providers = new Map<string, MiddlewareDefinition>();

/** register a middleware that can be auto-pulled as a dependency or enabled via `use("name")` */
export function provideMiddleware(def: MiddlewareDefinition): void {
	providers.set(def.name, def);
}

export class MiddlewareManager {
	#defs = new Map<string, MiddlewareDefinition>();
	#insertion = new Map<string, number>();
	#seq = 0;
	#anon = 0;
	#resolved: readonly Middleware[] | null = null;
	#resolvedNames: readonly string[] = [];
	#pending: Promise<readonly Middleware[]> | null = null;

	constructor(private readonly target?: Middleware[]) {}

	get resolved(): boolean {
		return this.#resolved !== null;
	}

	/** names in resolved outer -> inner order (empty until resolved) */
	order(): readonly string[] {
		return this.#resolvedNames;
	}

	use(entry: MiddlewareLike): this {
		if (this.#resolved) {
			throw new MiddlewareResolutionError(
				"cannot register middleware after the stack has been resolved",
			);
		}

		const def = this.#normalise(entry);
		const existing = this.#defs.get(def.name);
		if (existing) {
			if (existing === def) return this;
			if (!def.override) {
				throw new MiddlewareResolutionError(
					`middleware "${def.name}" is already registered; set \`override: true\` to replace it`,
				);
			}
		} else {
			this.#insertion.set(def.name, this.#seq++);
		}
		this.#defs.set(def.name, def);
		return this;
	}

	async resolve(): Promise<readonly Middleware[]> {
		if (this.#resolved) return this.#resolved;
		this.#pending ??= this.#doResolve();
		try {
			return await this.#pending;
		} finally {
			this.#pending = null;
		}
	}

	#normalise(entry: MiddlewareLike): MiddlewareDefinition {
		if (typeof entry === "function") {
			return {
				name: `anonymous#${this.#anon++}`,
				priority: MiddlewarePriority.normal,
				factory: () => entry,
			};
		}
		if (typeof entry === "string") {
			const provided = providers.get(entry);
			if (!provided) {
				throw new MiddlewareResolutionError(
					`no middleware named "${entry}" has been provided`,
				);
			}
			return provided;
		}
		if (!entry.name || typeof entry.factory !== "function") {
			throw new MiddlewareResolutionError(
				"a middleware definition needs a non-empty `name` and a `factory`",
			);
		}
		return entry;
	}

	async #doResolve(): Promise<readonly Middleware[]> {
		const graph = new Map<string, MiddlewareDefinition>();
		const order = new Map<string, number>();
		let seq = 0;

		const add = (def: MiddlewareDefinition): void => {
			if (graph.has(def.name)) return;
			graph.set(def.name, def);
			order.set(def.name, seq++);
			for (const dep of def.dependencies ?? []) {
				if (dep === def.name) {
					throw new MiddlewareResolutionError(`middleware "${def.name}" cannot depend on itself`);
				}
				const known = this.#defs.get(dep) ?? providers.get(dep);
				if (!known) {
					throw new MiddlewareResolutionError(
						`middleware "${def.name}" depends on "${dep}", which is not registered and no provider exists for it`,
					);
				}
				add(known);
			}
		};
		for (const def of this.#defs.values()) add(def);

		const permissions = [...graph.values()].flatMap((def) => def.permissions ?? []);
		if (permissions.length) await preflightPermissions([...permissions]);

		const dependents = new Map<string, string[]>();
		const indegree = new Map<string, number>();
		for (const name of graph.keys()) {
			dependents.set(name, []);
			indegree.set(name, 0);
		}
		for (const [name, def] of graph) {
			for (const dep of def.dependencies ?? []) {
				dependents.get(dep)!.push(name);
				indegree.set(name, indegree.get(name)! + 1);
			}
		}

		const rank = (name: string): [number, number] => {
			const def = graph.get(name)!;
			return [def.priority ?? MiddlewarePriority.normal, order.get(name)!];
		};

		const ready = [...graph.keys()].filter((n) => indegree.get(n) === 0);
		const sorted: MiddlewareDefinition[] = [];

		while (ready.length) {
			ready.sort((a, b) => {
				const [pa, ia] = rank(a);
				const [pb, ib] = rank(b);
				return pa !== pb ? pa - pb : ia - ib;
			});
			const name = ready.shift()!;
			sorted.push(graph.get(name)!);
			for (const dependent of dependents.get(name)!) {
				const remaining = indegree.get(dependent)! - 1;
				indegree.set(dependent, remaining);
				if (remaining === 0) ready.push(dependent);
			}
		}

		if (sorted.length !== graph.size) {
			const remaining = new Set(
				[...graph.keys()].filter((n) => !sorted.some((d) => d.name === n)),
			);
			throw new MiddlewareResolutionError(
				`middleware dependency cycle detected: ${findCycle(graph, remaining).join(" → ")}`,
			);
		}

		const middlewares = await Promise.all(sorted.map((d) => d.factory()));
		this.#resolved = middlewares;
		this.#resolvedNames = sorted.map((d) => d.name);
		if (this.target) {
			this.target.length = 0;
			this.target.push(...middlewares);
		}
		return middlewares;
	}
}

/** traces one concrete cycle among the unresolved nodes for a useful error */
function findCycle(
	graph: Map<string, MiddlewareDefinition>,
	remaining: Set<string>,
): string[] {
	const visited = new Set<string>();
	const stack: string[] = [];
	const onStack = new Set<string>();

	const dfs = (name: string): string[] | null => {
		visited.add(name);
		onStack.add(name);
		stack.push(name);
		for (const dep of graph.get(name)!.dependencies ?? []) {
			if (!remaining.has(dep)) continue;
			if (onStack.has(dep)) return [...stack.slice(stack.indexOf(dep)), dep];
			if (!visited.has(dep)) {
				const found = dfs(dep);
				if (found) return found;
			}
		}
		stack.pop();
		onStack.delete(name);
		return null;
	};

	for (const name of remaining) {
		if (!visited.has(name)) {
			const found = dfs(name);
			if (found) return found;
		}
	}
	return [...remaining];
}
