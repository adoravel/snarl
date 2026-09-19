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
 *
 * // query strings and forms only carry strings: coerce them
 * const Filters = v({
 *   page: v.coerce.number({ int: true, min: 1 }).default(1),
 *   tag: v.coerce.array(v.string()),
 * });
 * app.get("/posts", (ctx) => {
 *   const { page, tag } = ctx.query.parse(Filters); // { page: number; tag: string[] }
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

/** on a schema: the key may be missing when used in `v.object` */
const optional: unique symbol = Symbol("snarl.optional");

export interface Schema<T> {
	/**
	 * collects issues for `value` under `path` and returns the value to use:
	 * the input itself, or what a coercing schema made of it. the building
	 * block every other method uses
	 */
	check(value: unknown, path: Path, issues: Issue[]): unknown;

	/** returns the (coerced) value typed, or throws a `ValidationError` (422) with every issue */
	parse(value: unknown): T;

	/** like `parse`, without throwing */
	safeParse(value: unknown): Result<T>;

	/**
	 * a type guard: would `parse` accept it? for a coercing schema the
	 * narrowed type describes what `parse` returns, not the raw input
	 */
	is(value: unknown): value is T;

	/** the key may be missing (or `undefined`) when used in `v.object` */
	optional(): OptionalSchema<T>;
	nullable(): Schema<T | null>;

	/** a missing or `undefined` value becomes `value`; the key may be missing in `v.object` */
	default(value: T): DefaultSchema<T>;

	/** an extra condition on an already-valid value */
	refine(predicate: (value: T) => boolean, message?: string): Schema<T>;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
	readonly [optional]: true;
}

export interface DefaultSchema<T> extends Schema<T> {
	readonly [optional]: true;
}

/** the type a schema validates (and, for coercing schemas, produces) */
export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;

/** keys that may be absent in the input *and* stay possibly undefined in the output */
type OptionalKeys<S extends Shape> = {
	[K in keyof S]: S[K] extends { readonly [optional]: true }
		? (undefined extends Infer<S[K]> ? K : never)
		: never;
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

type Check = (value: unknown, path: Path, issues: Issue[]) => unknown;

/**
 * builds a schema from its check. this is all `v.guard` needs, and how new
 * kinds are added
 */
export function schema<T>(check: Check): Schema<T> {
	const self: Schema<T> = {
		check,
		parse(value) {
			const issues: Issue[] = [];
			const out = check(value, [], issues);
			if (issues.length) throw new ValidationError(issues);
			return out as T;
		},
		safeParse(value) {
			const issues: Issue[] = [];
			const out = check(value, [], issues);
			return issues.length ? { ok: false, issues } : { ok: true, value: out as T };
		},
		is(value): value is T {
			const issues: Issue[] = [];
			check(value, [], issues);
			return issues.length === 0;
		},
		optional() {
			const wrapped = schema<T | undefined>((value, path, issues) =>
				value === undefined ? undefined : check(value, path, issues)
			);
			return Object.assign(wrapped, { [optional]: true as const }) as OptionalSchema<T>;
		},
		nullable() {
			return schema<T | null>((value, path, issues) =>
				value === null ? null : check(value, path, issues)
			);
		},
		default(fallback) {
			const wrapped = schema<T>((value, path, issues) =>
				value === undefined ? fallback : check(value, path, issues)
			);
			return Object.assign(wrapped, { [optional]: true as const }) as DefaultSchema<T>;
		},
		refine(predicate, message = "invalid value") {
			return schema<T>((value, path, issues) => {
				const before = issues.length;
				const out = check(value, path, issues);
				if (issues.length === before && !predicate(out as T)) issues.push({ path, message });
				return out;
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

function checkString(s: string, options: StringOptions, path: Path, issues: Issue[]): string {
	if (options.min !== undefined && s.length < options.min) {
		issues.push({ path, message: `expected at least ${options.min} characters` });
	}
	if (options.max !== undefined && s.length > options.max) {
		issues.push({ path, message: `expected at most ${options.max} characters` });
	}
	if (options.pattern && !options.pattern.test(s)) {
		issues.push({ path, message: options.message ?? `expected to match ${options.pattern}` });
	}
	return s;
}

function string(options: StringOptions = {}): Schema<string> {
	return schema<string>((value, path, issues) =>
		expect("string", value, path, issues)
			? checkString(value as string, options, path, issues)
			: value
	);
}

function checkNumber(n: number, options: NumberOptions, path: Path, issues: Issue[]): number {
	if (Number.isNaN(n)) {
		issues.push({ path, message: "expected a number, got NaN" });
		return n;
	}
	if (options.int && !Number.isInteger(n)) issues.push({ path, message: "expected an integer" });
	if (options.min !== undefined && n < options.min) {
		issues.push({ path, message: `expected at least ${options.min}` });
	}
	if (options.max !== undefined && n > options.max) {
		issues.push({ path, message: `expected at most ${options.max}` });
	}
	return n;
}

function number(options: NumberOptions = {}): Schema<number> {
	return schema<number>((value, path, issues) =>
		expect("number", value, path, issues)
			? checkNumber(value as number, options, path, issues)
			: value
	);
}

function object<S extends Shape>(shape: S, options: ObjectOptions = {}): Schema<InferShape<S>> {
	return schema<InferShape<S>>((value, path, issues) => {
		if (!expect("object", value, path, issues)) return value;
		const input = value as Record<string, unknown>;

		let out = input;
		for (const key in shape) {
			const field = shape[key];
			if (!(key in input) && !(optional in field)) {
				issues.push({ path: [...path, key], message: "required" });
				continue;
			}
			const result = field.check(input[key], [...path, key], issues);
			if (result !== input[key] || (!(key in input) && result !== undefined)) {
				if (out === input) out = { ...input };
				out[key] = result;
			}
		}

		if (options.strict) {
			for (const key of Object.keys(input)) {
				if (!(key in shape)) issues.push({ path: [...path, key], message: "unknown key" });
			}
		}

		return out;
	});
}

function checkItems(list: unknown[], item: (entry: unknown, index: number) => unknown): unknown[] {
	let out = list;
	list.forEach((entry, i) => {
		const result = item(entry, i);
		if (result !== entry) {
			if (out === list) out = [...list];
			out[i] = result;
		}
	});
	return out;
}

function checkArray<T>(
	list: unknown[],
	item: Schema<T>,
	options: ArrayOptions,
	path: Path,
	issues: Issue[],
): unknown[] {
	if (options.min !== undefined && list.length < options.min) {
		issues.push({ path, message: `expected at least ${options.min} items` });
	}
	if (options.max !== undefined && list.length > options.max) {
		issues.push({ path, message: `expected at most ${options.max} items` });
	}
	return checkItems(list, (entry, i) => item.check(entry, [...path, i], issues));
}

function array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
	return schema<T[]>((value, path, issues) =>
		expect("array", value, path, issues)
			? checkArray(value as unknown[], item, options, path, issues)
			: value
	);
}

function record<T>(item: Schema<T>): Schema<Record<string, T>> {
	return schema<Record<string, T>>((value, path, issues) => {
		if (!expect("object", value, path, issues)) return value;
		const input = value as Record<string, unknown>;
		let out = input;
		for (const [key, entry] of Object.entries(input)) {
			const result = item.check(entry, [...path, key], issues);
			if (result !== entry) {
				if (out === input) out = { ...input };
				out[key] = result;
			}
		}
		return out;
	});
}

function tuple<const S extends readonly Schema<unknown>[]>(
	items: S,
): Schema<{ -readonly [K in keyof S]: Infer<S[K]> }> {
	return schema((value, path, issues) => {
		if (!expect("array", value, path, issues)) return value;
		const list = value as unknown[];
		if (list.length !== items.length) {
			issues.push({ path, message: `expected ${items.length} items, got ${list.length}` });
		}
		return checkItems(
			list,
			(entry, i) => items[i] ? items[i].check(entry, [...path, i], issues) : entry,
		);
	});
}

function union<const S extends readonly Schema<unknown>[]>(
	...members: S
): Schema<Infer<S[number]>> {
	return schema((value, path, issues) => {
		const attempts: Issue[][] = [];
		for (const member of members) {
			const own: Issue[] = [];
			const out = member.check(value, path, own);
			if (own.length === 0) return out;
			attempts.push(own);
		}

		const closest = attempts.reduce((a, b) => (b.length < a.length ? b : a));
		issues.push(...closest);
		return value;
	});
}

function literal<const T extends string | number | boolean | null>(expected: T): Schema<T> {
	return schema<T>((value, path, issues) => {
		if (value !== expected) issues.push({ path, message: `expected ${JSON.stringify(expected)}` });
		return value;
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
		return value;
	});
}

function format(test: (s: string) => boolean, message: string): Schema<string> {
	return schema<string>((value, path, issues) => {
		if (expect("string", value, path, issues) && !test(value as string)) {
			issues.push({ path, message: `expected ${message}` });
		}
		return value;
	});
}

const TRUE = new Set(["true", "1", "on", "yes"]);
const FALSE = new Set(["false", "0", "off", "no", ""]);

/**
 * builders that turn the strings a query string or form hands you into the
 * right type before checking it. `parse` returns the converted value
 */
const coerce = {
	/** numbers and numeric strings (`"42"`, `" 1.5 "`), not `""` or `"abc"` */
	number: (options: NumberOptions = {}): Schema<number> =>
		schema<number>((value, path, issues) => {
			const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
			if (typeof n !== "number" || Number.isNaN(n)) {
				issues.push({ path, message: `expected a number, got ${typeOf(value)}` });
				return value;
			}
			return checkNumber(n, options, path, issues);
		}),

	/** booleans and `"true"/"false"`, `"1"/"0"`, `"on"/"off"`, `"yes"/"no"`; `""` is `false` (an unticked box) */
	boolean: (): Schema<boolean> =>
		schema<boolean>((value, path, issues) => {
			if (typeof value === "boolean") return value;
			const s = typeof value === "string" ? value.trim().toLowerCase() : undefined;
			if (s !== undefined && TRUE.has(s)) return true;
			if (s !== undefined && FALSE.has(s)) return false;
			issues.push({ path, message: `expected a boolean, got ${typeOf(value)}` });
			return value;
		}),

	/** strings, plus numbers, booleans and bigints as their string form */
	string: (options: StringOptions = {}): Schema<string> =>
		schema<string>((value, path, issues) => {
			const type = typeof value;
			if (type === "number" || type === "boolean" || type === "bigint") {
				return checkString(String(value), options, path, issues);
			}
			return expect("string", value, path, issues)
				? checkString(value as string, options, path, issues)
				: value;
		}),

	/** a `Date`, or anything `new Date()` accepts that yields a valid one */
	date: (): Schema<Date> =>
		schema<Date>((value, path, issues) => {
			const date = value instanceof Date
				? value
				: typeof value === "string" || typeof value === "number"
				? new Date(value)
				: undefined;
			if (!date || Number.isNaN(date.getTime())) {
				issues.push({ path, message: `expected a date, got ${typeOf(value)}` });
				return value;
			}
			return date;
		}),

	/** an array, a lone value as a one-item array, `undefined` as `[]`: `?tag=a` and `?tag=a&tag=b` alike */
	array: <T>(item: Schema<T>, options: ArrayOptions = {}): DefaultSchema<T[]> =>
		Object.assign(
			schema<T[]>((value, path, issues) => {
				const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
				return checkArray(list, item, options, path, issues);
			}),
			{ [optional]: true as const },
		),
};

export function entriesToObject<V>(entries: Iterable<[string, V]>): Record<string, V | V[]> {
	const out: Record<string, V | V[]> = {};
	for (const [key, value] of entries) {
		const existing = out[key];
		if (existing === undefined) out[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else out[key] = [existing as V, value];
	}
	return out;
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
	default<T>(inner: Schema<T>, value: T): DefaultSchema<T>;
	any(): Schema<unknown>;
	email(): Schema<Email>;
	url(): Schema<Url>;
	uuid(): Schema<Uuid>;
	/** a type guard as a schema. `message` is reported when it fails */
	guard<T>(test: (value: unknown) => value is T, message?: string): Schema<T>;
	/** for recursive shapes, the schema is looked up on first use */
	lazy<T>(resolve: () => Schema<T>): Schema<T>;
	coerce: typeof coerce;
} = Object.assign(
	<S extends Shape>(shape: S, options?: ObjectOptions) => object(shape, options),
	{
		object,
		string,
		number,
		boolean: () =>
			schema<boolean>((value, path, issues) => (expect("boolean", value, path, issues), value)),
		literal,
		enum: enumeration,
		array,
		record,
		tuple,
		union,
		optional: <T>(inner: Schema<T>) => inner.optional(),
		nullable: <T>(inner: Schema<T>) => inner.nullable(),
		default: <T>(inner: Schema<T>, value: T) => inner.default(value),
		any: () => schema<unknown>((value) => value),
		email: () => format((s) => EMAIL_RE.test(s), "an email address") as Schema<Email>,
		url: () => format((s) => URL.canParse(s), "a url") as Schema<Url>,
		uuid: () => format((s) => UUID_RE.test(s), "a uuid") as Schema<Uuid>,
		guard: <T>(test: (value: unknown) => value is T, message = "invalid value") =>
			schema<T>((value, path, issues) => {
				if (!test(value)) issues.push({ path, message });
				return value;
			}),
		lazy: <T>(resolve: () => Schema<T>) => {
			let resolved: Schema<T> | undefined;
			return schema<T>((value, path, issues) =>
				(resolved ??= resolve()).check(value, path, issues)
			);
		},
		coerce,
	},
);

/** `schema.parse(data)`, for when reading left to right reads better */
export function validate<T>(target: Schema<T>, data: unknown): T {
	return target.parse(data);
}
