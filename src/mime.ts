/**
 * Copyright (c) 2025-2026 kylia
 * SPDX-License-Identifier: Apache-2.0
 */

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".webp": "image/webp",
	".webm": "video/webm",
	".mp4": "video/mp4",
};

export function getContentType(ext: string): string | undefined {
	return CONTENT_TYPES[ext] ?? CONTENT_TYPES[`.${ext}`];
}
