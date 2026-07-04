/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/**
 * represents a standard HTTP method
 */
export type Method = typeof httpMethods[number];

type ExtractParameterNames<S extends string> = S extends `${string}:${infer Param}/${infer Rest}`
	? Param | ExtractParameterNames<`/${Rest}`>
	: S extends `${string}:${infer Param}` ? Param
	: S extends `${string}/*${infer Name}` ? (Name extends "" ? "*" : Name)
	: never;

type Skippable<S extends string, T> = S extends `${string}?` ? T | undefined
	: T;

type StripOptional<S extends string> = S extends `${infer P}?` ? P : S;

/**
 * constructs a typed object for route parameters
 * @example ParametersOf<"/cats/:id/meows/:mrrp"> // { id: string; mrrp: string }
 * @example ParametersOf<"/bleh/*"> // { "*": string }
 */
export type ParametersOf<S extends string> = {
	[K in ExtractParameterNames<S> as StripOptional<K>]: Skippable<K, string>;
};

/**
 * a typed wrapper around `URLPattern` that stores the raw path string
 */
export interface PreciseURLPattern<S extends string> extends URLPattern {
	readonly raw: S;
}

/**
 * creates a type-safe `URLPattern` instance
 * @param init the URL pattern init object
 * @returns a URLPattern with type information
 */
export function url<const S extends string>(
	init: URLPatternInit & { pathname: S },
): PreciseURLPattern<S> {
	const pattern = new URLPattern(init) as PreciseURLPattern<S>;
	return (((pattern as any).raw = init.pathname), pattern);
}

export type ReplaceReturnType<F extends (...args: any[]) => any, T> = (
	...args: Parameters<F>
) => T;
