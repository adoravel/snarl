/**
 * Copyright (c) 2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * a base error class for all HTTP errors.
 * throwing this inside a handler will be caught and converted to a JSON response
 */
export class HttpError extends Error {
	/**
	 * @param status the HTTP status code (e.g., `404`).
	 * @param message the error message.
	 * @param headers optional headers to include in the response (e.g., `Retry-After`).
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
