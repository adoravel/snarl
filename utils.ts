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

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
		public headers?: HeadersInit,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export class BadRequestError extends HttpError {
	constructor(message: string = "Bad Request") {
		super(400, message);
	}
}

export class UnauthorizedError extends HttpError {
	constructor(message: string = "Unauthorized") {
		super(401, message);
	}
}

export class ForbiddenError extends HttpError {
	constructor(message: string = "Forbidden") {
		super(403, message);
	}
}

export class NotFoundError extends HttpError {
	constructor(message: string = "Not Found") {
		super(404, message);
	}
}

export class MethodNotAllowedError extends HttpError {
	constructor(message: string = "Method Not Allowed") {
		super(405, message);
	}
}

export class ConflictError extends HttpError {
	constructor(message: string = "Conflict") {
		super(409, message);
	}
}

export class UnprocessableEntityError extends HttpError {
	constructor(message: string = "Unprocessable Entity") {
		super(422, message);
	}
}

export class TooManyRequestsError extends HttpError {
	constructor(message: string = "Too Many Requests", retryAfter?: string) {
		super(429, message, retryAfter ? { "Retry-After": retryAfter } : undefined);
	}
}

export class InternalServerError extends HttpError {
	constructor(message: string = "Internal Server Error") {
		super(500, message);
	}
}
