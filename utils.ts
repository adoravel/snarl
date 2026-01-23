/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export type Method = typeof httpMethods[number];

export type ExtractParameterNames<S extends string> = S extends `${string}:${infer Param}/${infer Rest}`
	? Param | ExtractParameterNames<`/${Rest}`>
	: S extends `${string}:${infer Param}` ? Param
	: never;

export type Skippable<S extends string, T> = S extends `${string}?` ? T | undefined
	: T;

export type StripOptional<S extends string> = S extends `${infer P}?` ? P : S;

export type ParametersOf<S extends string> = {
	[K in ExtractParameterNames<S> as StripOptional<K>]: Skippable<K, string>;
};

export interface PreciseURLPattern<S extends string> extends URLPattern {
	readonly raw: S;
}

export function url<const S extends string>(
	init: URLPatternInit & { pathname: S },
): PreciseURLPattern<S> {
	const pattern = new URLPattern(init) as PreciseURLPattern<S>;
	return (((pattern as any).raw = init.pathname), pattern);
}
