/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
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

export interface Schema<Out, In = Out> {
	check(value: unknown, path: Path, issues: Issue[]): unknown;

	/** returns the (coerced) value typed, or throws a `ValidationError` (422) with every issue */
	parse(value: unknown): Out;

	/** like `parse`, without throwing */
	safeParse(value: unknown): Result<Out>;

	/**
	 * a type guard. would `parse` accept it? for a coercing schema the
	 * narrowed type describes what `parse` returns, not the raw input
	 */
	is(value: unknown): value is Out;

	/** the key may be missing (or `undefined`) when used in `v.object` */
	optional(): OptionalSchema<Out, In>;

	nullable(): Schema<Out | null, In | null>;

	/** a missing or `undefined` value becomes `value`; the key may be missing in `v.object` */
	default(value: Out): DefaultSchema<Out, In>;

	/** an extra condition on an already-valid value */
	refine(predicate: (value: Out) => boolean, message?: string): Schema<Out, In>;
}

export interface OptionalSchema<Out, In = Out> extends Schema<Out | undefined, In | undefined> {
	readonly [optional]: true;
}

/** the value is filled in when absent, so the output is never `undefined` */
export interface DefaultSchema<Out, In = Out> extends Schema<Out, In | undefined> {
	readonly [optional]: true;
}

/** what a schema produces */
export type Infer<S> = S extends Schema<infer Out, any> ? Out : never;

/** what a schema accepts */
export type InferInput<S> = S extends Schema<any, infer In> ? In : never;

type Shape = Record<string, Schema<any, any>>;

/** keys that may be absent in the input *and* stay possibly undefined in the output */
type OptionalKeys<S extends Shape> = {
	[K in keyof S]: S[K] extends { readonly [optional]: true }
		? (undefined extends Infer<S[K]> ? K : never)
		: never;
}[keyof S];

/** keys a caller may leave out */
type OptionalInputKeys<S extends Shape> = {
	[K in keyof S]: S[K] extends { readonly [optional]: true } ? K : never;
}[keyof S];

// deno-lint-ignore ban-types
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type InferShape<S extends Shape> = Simplify<
	& { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> }
	& { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

type InferInputShape<S extends Shape> = Simplify<
	& { [K in Exclude<keyof S, OptionalInputKeys<S>>]: InferInput<S[K]> }
	& { [K in OptionalInputKeys<S>]?: InferInput<S[K]> }
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
export function schema<Out, In = Out>(check: Check): Schema<Out, In> {
	const self: Schema<Out, In> = {
		check,
		parse(value) {
			const issues: Issue[] = [];
			const out = check(value, [], issues);
			if (issues.length) throw new ValidationError(issues);
			return out as Out;
		},
		safeParse(value) {
			const issues: Issue[] = [];
			const out = check(value, [], issues);
			return issues.length ? { ok: false, issues } : { ok: true, value: out as Out };
		},
		is(value): value is Out {
			const issues: Issue[] = [];
			check(value, [], issues);
			return issues.length === 0;
		},
		optional() {
			const wrapped = schema<Out | undefined, In | undefined>((value, path, issues) =>
				value === undefined ? undefined : check(value, path, issues)
			);
			return Object.assign(wrapped, { [optional]: true as const }) as OptionalSchema<Out, In>;
		},
		nullable() {
			return schema<Out | null, In | null>((value, path, issues) =>
				value === null ? null : check(value, path, issues)
			);
		},
		default(fallback) {
			const wrapped = schema<Out, In | undefined>((value, path, issues) =>
				value === undefined ? fallback : check(value, path, issues)
			);
			return Object.assign(wrapped, { [optional]: true as const }) as DefaultSchema<Out, In>;
		},
		refine(predicate, message = "invalid value") {
			return schema<Out, In>((value, path, issues) => {
				const before = issues.length;
				const out = check(value, path, issues);
				if (issues.length === before && !predicate(out as Out)) issues.push({ path, message });
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

function object<S extends Shape>(
	shape: S,
	options: ObjectOptions = {},
): Schema<InferShape<S>, InferInputShape<S>> {
	return schema<InferShape<S>, InferInputShape<S>>((value, path, issues) => {
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

function array<Out, In>(item: Schema<Out, In>, options: ArrayOptions = {}): Schema<Out[], In[]> {
	return schema<Out[], In[]>((value, path, issues) =>
		expect("array", value, path, issues)
			? checkArray(value as unknown[], item, options, path, issues)
			: value
	);
}

function record<Out, In>(item: Schema<Out, In>): Schema<Record<string, Out>, Record<string, In>> {
	return schema<Record<string, Out>, Record<string, In>>((value, path, issues) => {
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

function tuple<const S extends readonly Schema<any, any>[]>(
	items: S,
): Schema<
	{ -readonly [K in keyof S]: Infer<S[K]> },
	{ -readonly [K in keyof S]: InferInput<S[K]> }
> {
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

function union<const S extends readonly Schema<any, any>[]>(
	...members: S
): Schema<Infer<S[number]>, InferInput<S[number]>> {
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
	return schema<string, string>((value, path, issues) => {
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
	number: (options: NumberOptions = {}): Schema<number, number | string> =>
		schema<number, number | string>((value, path, issues) => {
			const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
			if (typeof n !== "number" || Number.isNaN(n)) {
				issues.push({ path, message: `expected a number, got ${typeOf(value)}` });
				return value;
			}
			return checkNumber(n, options, path, issues);
		}),

	/** booleans and `"true"/"false"`, `"1"/"0"`, `"on"/"off"`, `"yes"/"no"`; `""` is `false` (an unticked box) */
	boolean: (): Schema<boolean, boolean | string> =>
		schema<boolean, boolean | string>((value, path, issues) => {
			if (typeof value === "boolean") return value;
			const s = typeof value === "string" ? value.trim().toLowerCase() : undefined;
			if (s !== undefined && TRUE.has(s)) return true;
			if (s !== undefined && FALSE.has(s)) return false;
			issues.push({ path, message: `expected a boolean, got ${typeOf(value)}` });
			return value;
		}),

	/** strings, plus numbers, booleans and bigints as their string form */
	string: (options: StringOptions = {}): Schema<string, string | number | boolean | bigint> =>
		schema<string, string | number | boolean | bigint>((value, path, issues) => {
			const type = typeof value;
			if (type === "number" || type === "boolean" || type === "bigint") {
				return checkString(String(value), options, path, issues);
			}
			return expect("string", value, path, issues)
				? checkString(value as string, options, path, issues)
				: value;
		}),

	/** a `Date`, or anything `new Date()` accepts that yields a valid one */
	date: (): Schema<Date, Date | string | number> =>
		schema<Date, Date | string | number>((value, path, issues) => {
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
	array: <Out, In>(
		item: Schema<Out, In>,
		options: ArrayOptions = {},
	): DefaultSchema<Out[], In | In[]> =>
		Object.assign(
			schema<Out[], In | In[]>((value, path, issues) => {
				const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
				return checkArray(list, item, options, path, issues);
			}),
			{ [optional]: true as const },
		) as DefaultSchema<Out[], In | In[]>,
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
	<S extends Shape>(shape: S, options?: ObjectOptions): Schema<InferShape<S>, InferInputShape<S>>;
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
	optional<Out, In>(inner: Schema<Out, In>): OptionalSchema<Out, In>;
	nullable<Out, In>(inner: Schema<Out, In>): Schema<Out | null, In | null>;
	default<Out, In>(inner: Schema<Out, In>, value: Out): DefaultSchema<Out, In>;
	any(): Schema<unknown>;
	email(): Schema<Email, string>;
	url(): Schema<Url, string>;
	uuid(): Schema<Uuid, string>;
	/** a type guard as a schema. `message` is reported when it fails */
	guard<T>(test: (value: unknown) => value is T, message?: string): Schema<T>;
	/** for recursive shapes, the schema is looked up on first use */
	lazy<Out, In = Out>(resolve: () => Schema<Out, In>): Schema<Out, In>;
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
		optional: <Out, In>(inner: Schema<Out, In>) => inner.optional(),
		nullable: <Out, In>(inner: Schema<Out, In>) => inner.nullable(),
		default: <Out, In>(inner: Schema<Out, In>, value: Out) => inner.default(value),
		any: () => schema<unknown>((value) => value),
		email: () => format((s) => EMAIL_RE.test(s), "an email address") as Schema<Email, string>,
		url: () => format((s) => URL.canParse(s), "a url") as Schema<Url, string>,
		uuid: () => format((s) => UUID_RE.test(s), "a uuid") as Schema<Uuid, string>,
		guard: <T>(test: (value: unknown) => value is T, message = "invalid value") =>
			schema<T>((value, path, issues) => {
				if (!test(value)) issues.push({ path, message });
				return value;
			}),
		lazy: <Out, In = Out>(resolve: () => Schema<Out, In>) => {
			let resolved: Schema<Out, In> | undefined;
			return schema<Out, In>((value, path, issues) =>
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
