/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * @module validate
 * a small schema validator whose definitions are also the types.
 *
 * @example
 * ```ts
 * const User = v({
 *   name: v.string({ min: 1, max: 64 }),
 *   email: v.email(),
 *   age: v.optional(v.number({ int: true, min: 0 })),
 *   role: v.enum(["admin", "member"]),
 * });
 * type User = Infer<typeof User>;
 * // { name: string; email: Email; role: "admin" | "member"; age?: number }
 *
 * app.post("/users", async (ctx) => {
 *   const user = await ctx.body.json(User); // 422 with the issues if it doesn't fit
 *   ...
 * });
 * ```
 */

import { HttpError } from "./errors.ts";

/** where an issue was found, e.g. `["contact", 0, "email"]` */
export type Path = (string | number)[];

export interface Issue {
	path: Path;
	message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

declare const brand: unique symbol;

/** a nominal string: `string & Brand<"email">` is a string that went through `v.email()` */
export type Brand<Name extends string> = { readonly [brand]: Name };

export type Email = string & Brand<"email">;
export type Url = string & Brand<"url">;
export type Uuid = string & Brand<"uuid">;

const optional: unique symbol = Symbol("snarl.optional");

export interface Schema<T> {
	/** collects issues for `value` under `path`. the building block every other method uses */
	check(value: unknown, path: Path, issues: Issue[]): void;

	/** returns `value` typed, or throws a `ValidationError` (422) with every issue */
	parse(value: unknown): T;

	/** like `parse`, without throwing */
	safeParse(value: unknown): Result<T>;

	/** a type guard */
	is(value: unknown): value is T;

	/** the key may be missing (or `undefined`) when used in `v.object` */
	optional(): OptionalSchema<T>;
	nullable(): Schema<T | null>;

	/** an extra condition on an already-valid value */
	refine(predicate: (value: T) => boolean, message?: string): Schema<T>;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
	readonly [optional]: true;
}

/** the type a schema validates */
export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;

type OptionalKeys<S extends Shape> = {
	[K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];

// deno-lint-ignore ban-types
type Simplify<T> = { [K in keyof T]: T[K] } & {};

type InferShape<S extends Shape> = Simplify<
	& { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> }
	& { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

/** a 422 carrying every issue; the default error handler puts them in the response body */
export class ValidationError extends HttpError {
	constructor(public readonly issues: Issue[]) {
		super(422, describe(issues), undefined, issues);
		this.name = "ValidationError";
	}
}

function describe(issues: Issue[]): string {
	const first = issues[0];
	const where = first.path.length ? ` at ${formatPath(first.path)}` : "";
	const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
	return `${first.message}${where}${more}`;
}

export function formatPath(path: Path): string {
	return path.map((p, i) => typeof p === "number" ? `[${p}]` : i ? `.${p}` : p).join("");
}

type Check = (value: unknown, path: Path, issues: Issue[]) => void;

/** builds a schema from its check. this is all `v.guard` needs, and how new kinds are added */
export function schema<T>(check: Check): Schema<T> {
	const self: Schema<T> = {
		check,
		parse(value) {
			const issues: Issue[] = [];
			check(value, [], issues);
			if (issues.length) throw new ValidationError(issues);
			return value as T;
		},
		safeParse(value) {
			const issues: Issue[] = [];
			check(value, [], issues);
			return issues.length ? { ok: false, issues } : { ok: true, value: value as T };
		},
		is(value): value is T {
			const issues: Issue[] = [];
			check(value, [], issues);
			return issues.length === 0;
		},
		optional() {
			const wrapped = schema<T | undefined>((value, path, issues) => {
				if (value !== undefined) check(value, path, issues);
			});
			return Object.assign(wrapped, { [optional]: true as const }) as OptionalSchema<T>;
		},
		nullable() {
			return schema<T | null>((value, path, issues) => {
				if (value !== null) check(value, path, issues);
			});
		},
		refine(predicate, message = "invalid value") {
			return schema<T>((value, path, issues) => {
				const before = issues.length;
				check(value, path, issues);
				if (issues.length === before && !predicate(value as T)) issues.push({ path, message });
			});
		},
	};
	return self;
}

function typeOf(value: unknown): "null" | "array" | typeof value {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function expect(type: string, value: unknown, path: Path, issues: Issue[]): boolean {
	if (typeOf(value) === type) return true;
	issues.push({ path, message: `expected ${type}, got ${typeOf(value)}` });
	return false;
}

export interface StringOptions {
	min?: number;
	max?: number;
	pattern?: RegExp;
	/** the message for a failed `pattern` */
	message?: string;
}

export interface NumberOptions {
	min?: number;
	max?: number;
	int?: boolean;
}

export interface ArrayOptions {
	min?: number;
	max?: number;
}

export interface ObjectOptions {
	/** reject keys the shape doesn't declare. off by default */
	strict?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function string(options: StringOptions = {}): Schema<string> {
	return schema<string>((value, path, issues) => {
		if (!expect("string", value, path, issues)) return;
		const s = value as string;
		if (options.min !== undefined && s.length < options.min) {
			issues.push({ path, message: `expected at least ${options.min} characters` });
		}
		if (options.max !== undefined && s.length > options.max) {
			issues.push({ path, message: `expected at most ${options.max} characters` });
		}
		if (options.pattern && !options.pattern.test(s)) {
			issues.push({ path, message: options.message ?? `expected to match ${options.pattern}` });
		}
	});
}

function number(options: NumberOptions = {}): Schema<number> {
	return schema<number>((value, path, issues) => {
		if (!expect("number", value, path, issues)) return;
		const n = value as number;
		if (Number.isNaN(n)) return void issues.push({ path, message: "expected a number, got NaN" });
		if (options.int && !Number.isInteger(n)) issues.push({ path, message: "expected an integer" });
		if (options.min !== undefined && n < options.min) {
			issues.push({ path, message: `expected at least ${options.min}` });
		}
		if (options.max !== undefined && n > options.max) {
			issues.push({ path, message: `expected at most ${options.max}` });
		}
	});
}

function object<S extends Shape>(shape: S, options: ObjectOptions = {}): Schema<InferShape<S>> {
	return schema<InferShape<S>>((value, path, issues) => {
		if (!expect("object", value, path, issues)) return;
		const record = value as Record<string, unknown>;
		for (const key in shape) {
			const field = shape[key];
			if (!(key in record) && !(optional in field)) {
				issues.push({ path: [...path, key], message: "required" });
				continue;
			}
			field.check(record[key], [...path, key], issues);
		}
		if (options.strict) {
			for (const key of Object.keys(record)) {
				if (!(key in shape)) issues.push({ path: [...path, key], message: "unknown key" });
			}
		}
	});
}

function array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
	return schema<T[]>((value, path, issues) => {
		if (!expect("array", value, path, issues)) return;
		const list = value as unknown[];
		if (options.min !== undefined && list.length < options.min) {
			issues.push({ path, message: `expected at least ${options.min} items` });
		}
		if (options.max !== undefined && list.length > options.max) {
			issues.push({ path, message: `expected at most ${options.max} items` });
		}
		list.forEach((entry, i) => item.check(entry, [...path, i], issues));
	});
}

function record<T>(item: Schema<T>): Schema<Record<string, T>> {
	return schema<Record<string, T>>((value, path, issues) => {
		if (!expect("object", value, path, issues)) return;
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			item.check(entry, [...path, key], issues);
		}
	});
}

function tuple<const S extends readonly Schema<unknown>[]>(
	items: S,
): Schema<{ -readonly [K in keyof S]: Infer<S[K]> }> {
	return schema((value, path, issues) => {
		if (!expect("array", value, path, issues)) return;
		const list = value as unknown[];
		if (list.length !== items.length) {
			issues.push({ path, message: `expected ${items.length} items, got ${list.length}` });
		}
		items.forEach((item, i) => item.check(list[i], [...path, i], issues));
	});
}

function union<const S extends readonly Schema<unknown>[]>(
	...members: S
): Schema<Infer<S[number]>> {
	return schema((value, path, issues) => {
		const attempts: Issue[][] = [];
		for (const member of members) {
			const own: Issue[] = [];
			member.check(value, path, own);
			if (own.length === 0) return;
			attempts.push(own);
		}
		const closest = attempts.reduce((a, b) => (b.length < a.length ? b : a));
		issues.push(...closest);
	});
}

function literal<const T extends string | number | boolean | null>(expected: T): Schema<T> {
	return schema<T>((value, path, issues) => {
		if (value !== expected) {
			issues.push({ path, message: `expected ${JSON.stringify(expected)}` });
		}
	});
}

function enumeration<const T extends readonly (string | number)[]>(values: T): Schema<T[number]> {
	return schema<T[number]>((value, path, issues) => {
		if (!values.includes(value as T[number])) {
			issues.push({
				path,
				message: `expected one of ${values.map((v) => JSON.stringify(v)).join(", ")}`,
			});
		}
	});
}

/**
 * schema builders. `v(shape)` is `v.object(shape)`; each builder returns a
 * `Schema` whose `parse`/`is` narrow to the inferred type. add your own with
 * `v.guard` or by calling `schema()` directly
 */
export const v: {
	<S extends Shape>(shape: S, options?: ObjectOptions): Schema<InferShape<S>>;
	object: typeof object;
	string: typeof string;
	number: typeof number;
	boolean(): Schema<boolean>;
	literal: typeof literal;
	enum: typeof enumeration;
	array: typeof array;
	record: typeof record;
	tuple: typeof tuple;
	union: typeof union;
	optional<T>(inner: Schema<T>): OptionalSchema<T>;
	nullable<T>(inner: Schema<T>): Schema<T | null>;
	any(): Schema<unknown>;
	email(): Schema<Email>;
	url(): Schema<Url>;
	uuid(): Schema<Uuid>;
	/** a type guard as a schema. `message` is reported when it fails */
	guard<T>(guard: (value: unknown) => value is T, message?: string): Schema<T>;
	/** for recursive shapes: the schema is looked up on first use */
	lazy<T>(resolve: () => Schema<T>): Schema<T>;
} = Object.assign(
	<S extends Shape>(shape: S, options?: ObjectOptions) => object(shape, options),
	{
		object,
		string,
		number,
		boolean: () =>
			schema<boolean>((value, path, issues) => void expect("boolean", value, path, issues)),
		literal,
		enum: enumeration,
		array,
		record,
		tuple,
		union,
		optional: <T>(inner: Schema<T>) => inner.optional(),
		nullable: <T>(inner: Schema<T>) => inner.nullable(),
		any: () => schema<unknown>(() => {}),
		email: () =>
			schema<Email>((value, path, issues) => {
				if (expect("string", value, path, issues) && !EMAIL_RE.test(value as string)) {
					issues.push({ path, message: "expected an email address" });
				}
			}),
		url: () =>
			schema<Url>((value, path, issues) => {
				if (expect("string", value, path, issues) && !URL.canParse(value as string)) {
					issues.push({ path, message: "expected a url" });
				}
			}),
		uuid: () =>
			schema<Uuid>((value, path, issues) => {
				if (expect("string", value, path, issues) && !UUID_RE.test(value as string)) {
					issues.push({ path, message: "expected a uuid" });
				}
			}),
		guard: <T>(guard: (value: unknown) => value is T, message = "invalid value") =>
			schema<T>((value, path, issues) => {
				if (!guard(value)) issues.push({ path, message });
			}),
		lazy: <T>(resolve: () => Schema<T>) => {
			let resolved: Schema<T> | undefined;
			return schema<T>((value, path, issues) =>
				(resolved ??= resolve()).check(value, path, issues)
			);
		},
	},
);

/** `schema.parse(data)`, for when reading left to right reads better */
export function validate<T>(target: Schema<T>, data: unknown): T {
	return target.parse(data);
}
