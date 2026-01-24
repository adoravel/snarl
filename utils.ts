/**
 * Copyright (c) 2025 adoravel
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

/**
 * @module utils
 * Shared utility types, HTTP Error classes, and routing helpers.
 */

export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/**
 * Represents a standard HTTP method.
 */
export type Method = typeof httpMethods[number];

type ExtractParameterNames<S extends string> = S extends `${string}:${infer Param}/${infer Rest}`
	? Param | ExtractParameterNames<`/${Rest}`>
	: S extends `${string}:${infer Param}` ? Param
	: never;

type Skippable<S extends string, T> = S extends `${string}?` ? T | undefined
	: T;

type StripOptional<S extends string> = S extends `${infer P}?` ? P : S;

/**
 * Constructs a typed object for route parameters.
 * @example ParametersOf<"/cats/:id/meows/:meowId"> // { id: string; meowId: string }
 */
export type ParametersOf<S extends string> = {
	[K in ExtractParameterNames<S> as StripOptional<K>]: Skippable<K, string>;
};

/**
 * A typed wrapper around `URLPattern` that stores the raw path string.
 */
export interface PreciseURLPattern<S extends string> extends URLPattern {
	readonly raw: S;
}

/**
 * Creates a type-safe `URLPattern` instance.
 * @param init - The URL pattern init object.
 * @returns A URLPattern with type information.
 */
export function url<const S extends string>(
	init: URLPatternInit & { pathname: S },
): PreciseURLPattern<S> {
	const pattern = new URLPattern(init) as PreciseURLPattern<S>;
	return (((pattern as any).raw = init.pathname), pattern);
}

/**
 * A base error class for all HTTP errors.
 * Throwing this inside a handler will be caught and converted to a JSON response.
 */
export class HttpError extends Error {
	/**
	 * @param status - The HTTP status code (e.g., 404).
	 * @param message - The error message.
	 * @param headers - Optional headers to include in the response (e.g., Retry-After).
	 */
	constructor(
		public status: number,
		message: string,
		public headers?: HeadersInit,
	) {
		super(message);
		this.name = "HttpError";
	}
}

/** Error 400 Bad Request */
export class BadRequestError extends HttpError {
	constructor(message: string = "Bad Request") {
		super(400, message);
	}
}

/** Error 401 Unauthorized */
export class UnauthorizedError extends HttpError {
	constructor(message: string = "Unauthorized") {
		super(401, message);
	}
}

/** Error 403 Forbidden */
export class ForbiddenError extends HttpError {
	constructor(message: string = "Forbidden") {
		super(403, message);
	}
}

/** Error 404 Not Found */
export class NotFoundError extends HttpError {
	constructor(message: string = "Not Found") {
		super(404, message);
	}
}

/** Error 405 Method Not Allowed */
export class MethodNotAllowedError extends HttpError {
	constructor(message: string = "Method Not Allowed") {
		super(405, message);
	}
}

/** Error 409 Conflict */
export class ConflictError extends HttpError {
	constructor(message: string = "Conflict") {
		super(409, message);
	}
}

/** Error 422 Unprocessable Entity */
export class UnprocessableEntityError extends HttpError {
	constructor(message: string = "Unprocessable Entity") {
		super(422, message);
	}
}

/** Error 429 Too Many Requests */
export class TooManyRequestsError extends HttpError {
	constructor(message: string = "Too Many Requests", retryAfter?: string) {
		super(429, message, retryAfter ? { "Retry-After": retryAfter } : undefined);
	}
}

/** Error 500 Internal Server Error */
export class InternalServerError extends HttpError {
	constructor(message: string = "Internal Server Error") {
		super(500, message);
	}
}
