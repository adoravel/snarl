/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { LimitedBytesTransformStream } from "@std/streams";
import { HttpError, PayloadTooLargeError } from "../errors.ts";

export interface MultipartOptions {
	/** maximum total size in bytes for the entire multipart payload. defaults to 10 MB */
	maxTotalSize?: number;
	/** maximum allowed size per file in bytes. checked after parsing */
	maxFileSize?: number;
}

export interface MultipartResult {
	fields: Record<string, string>;
	files: Record<string, UploadedFile>;
}

export interface UploadedFile {
	name: string;
	filename: string;
	type: string;
	size: number;
	content: Uint8Array;
}

/**
 * Parses multipart form data from a request with a total size limit.
 *
 * @example
 * ```ts
 * const { fields, files } = await createMultipartReader(request, { maxTotalSize: 5 * 1024 * 1024 });
 * ```
 */
export async function createMultipartReader(
	request: Request,
	options: MultipartOptions = {},
): Promise<MultipartResult> {
	const { maxTotalSize = 10_485_760 } = options;

	const body = request.body?.pipeThrough(
		new LimitedBytesTransformStream(maxTotalSize, { error: true }),
	);
	const req = new Request(request, { body });

	try {
		const form = await req.formData();
		return await parseFormData(form, options.maxFileSize);
	} catch (error: any) {
		if (error instanceof RangeError && error.message.includes("exceeds size limit")) {
			throw new PayloadTooLargeError(`Payload exceeds the ${maxTotalSize}-byte limit`);
		}
		const message = "message" in error ? error.message : String(error);
		throw new HttpError(400, `Failed to parse multipart data: ${message}`);
	}
}

/**
 * Extracts fields and files from a `FormData` object.
 */
async function parseFormData(formData: FormData, maxFileSize?: number): Promise<MultipartResult> {
	const fields: Record<string, string> = {};
	const files: Record<string, UploadedFile> = {};

	for (const [name, value] of formData.entries()) {
		if (value instanceof File) {
			if (maxFileSize && value.size > maxFileSize) {
				throw new PayloadTooLargeError(
					`File "${value.name}" exceeds the ${maxFileSize}-byte limit`,
				);
			}
			const content = new Uint8Array(await value.arrayBuffer());
			files[name] = {
				name,
				filename: value.name,
				type: value.type || "application/octet-stream",
				size: value.size,
				content,
			};
		} else {
			fields[name] = value;
		}
	}

	return { fields, files };
}
