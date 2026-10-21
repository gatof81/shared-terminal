/**
 * routes/files.ts — Workspace Explorer read-only file browsing.
 *
 *   GET /sessions/:id/fs/list?path=<dir>      one directory level (JSON)
 *   GET /sessions/:id/fs/preview?path=<file>  bounded text preview / kind sniff (JSON)
 *   GET /sessions/:id/fs/raw?path=<image>     image bytes for inline preview
 *
 * Full-file download stays on the existing `GET /sessions/:id/files`
 * route (#358, routes/sessions.ts); both go through workspaceFiles.ts.
 *
 * Authorization is OWNER-ONLY (`assertOwnedBy`), matching that download
 * route — deliberately NOT `assertCanObserve`. The observe tier lets a
 * group lead watch a terminal the owner can see them watching (and every
 * attach is audit-logged); arbitrary workspace reads would be a silent,
 * unlogged widening of what a lead can see. Admins are excluded for the
 * same reason: `assertCanOperate` grants terminal/exec drive, but there is
 * no audit row for "admin read file X". Widening either is a product
 * decision for a follow-up, with an observe-log story attached.
 *
 * Everything reads the host bind mount — no docker exec — so stopped and
 * soft-deleted sessions (workspace preserved) are browsable too.
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAuth } from "../auth.js";
import {
	contentDispositionFilename,
	listWorkspaceDir,
	openWorkspaceFile,
	readHead,
	validateRelPathParam,
	type WorkspaceFsError,
} from "../workspaceFiles.js";
import { handleSessionError, type RouteContext } from "./shared.js";

// Max entries returned for one directory level. Big enough for any
// directory a human browses; a 100k-entry cache dir gets the first 2000
// plus `truncated: true` instead of a multi-MB JSON body.
export const MAX_DIR_ENTRIES = 2000;

// Text preview cap. 1 MiB of source is ~25k lines — past the point where
// an in-browser highlighted view is pleasant — while keeping the JSON
// response and the server-side read buffer small. Larger files preview
// their head with `truncated: true`; the full file is one Download away.
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

// Inline image cap. Screenshots and diagrams are well under this; a
// 200 MB TIFF-as-PNG shouldn't be pushed through the backend and decoded
// in a phone browser just because someone clicked it.
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

// How far into the file to look for a NUL when deciding text vs binary.
// Same heuristic (and ballpark window) git and `file` use.
const BINARY_SNIFF_BYTES = 8000;

// Inline-previewable image types, keyed by lowercase extension. An
// allowlist — the `raw` route refuses anything else, so it can never be
// coaxed into serving e.g. HTML with a renderable content type.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
};

function imageMimeFor(name: string): string | null {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	return IMAGE_MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

export type PreviewResponse =
	| {
			kind: "text";
			path: string;
			name: string;
			size: number;
			mtime: string;
			content: string;
			truncated: boolean;
	  }
	| { kind: "image"; path: string; name: string; size: number; mtime: string; mime: string }
	| {
			kind: "binary";
			path: string;
			name: string;
			size: number;
			mtime: string;
			reason: "binary" | "too-large";
	  };

/** Text-vs-binary decision + decode for a preview head. Exported for tests. */
export function decodePreview(
	bytes: Buffer,
	truncated: boolean,
): { kind: "text"; content: string } | { kind: "binary" } {
	if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary" };
	try {
		// fatal: invalid UTF-8 → binary rather than a screen of U+FFFD.
		// stream: when we cut the file mid-way, the last 1-3 bytes may be
		// an incomplete multi-byte sequence; streaming mode holds them
		// back instead of treating the cut as corruption.
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
			stream: truncated,
		});
		return { kind: "text", content };
	} catch {
		return { kind: "binary" };
	}
}

function sendFsError(res: Response, err: WorkspaceFsError): void {
	res.status(err.status).json({ error: err.error });
}

export function registerFileRoutes(router: Router, ctx: RouteContext): void {
	const { sessions } = ctx;
	const { fileBrowseIp } = ctx.limiters;

	// Workspace contents are private and change under the user's feet —
	// never let a shared cache or the browser's HTTP cache answer for them.
	const noStore = (res: Response) => res.setHeader("Cache-Control", "no-store");

	router.get(
		"/sessions/:id/fs/list",
		// Explicit requireAuth so these routes don't silently inherit
		// their gate from the `/sessions` prefix mount in routes.ts —
		// same reasoning as the upload/download routes.
		requireAuth,
		fileBrowseIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const rel = validateRelPathParam(req.query.path, { allowEmpty: true });
			if (typeof rel !== "string") {
				sendFsError(res, rel);
				return;
			}
			try {
				// Ownership BEFORE any filesystem access: a foreign-session
				// probe gets its 404 without learning anything about that
				// workspace (not even path-exists timing).
				await sessions.assertOwnedBy(req.params.id, userId);
				const result = await listWorkspaceDir(req.params.id, rel, {
					maxEntries: MAX_DIR_ENTRIES,
				});
				if (!result.ok) {
					sendFsError(res, result);
					return;
				}
				noStore(res);
				res.json({ path: result.path, entries: result.entries, truncated: result.truncated });
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);

	router.get(
		"/sessions/:id/fs/preview",
		requireAuth,
		fileBrowseIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const rel = validateRelPathParam(req.query.path, { allowEmpty: false });
			if (typeof rel !== "string") {
				sendFsError(res, rel);
				return;
			}
			try {
				await sessions.assertOwnedBy(req.params.id, userId);
				const opened = await openWorkspaceFile(req.params.id, rel);
				if (!opened.ok) {
					sendFsError(res, opened);
					return;
				}
				const base = {
					path: opened.rel,
					name: opened.name,
					size: opened.size,
					mtime: opened.mtime.toISOString(),
				};
				let body: PreviewResponse;
				try {
					const mime = imageMimeFor(opened.name);
					if (mime !== null) {
						// Bytes come from /fs/raw; this response only tells
						// the client it may ask for them.
						body =
							opened.size <= IMAGE_PREVIEW_MAX_BYTES
								? { kind: "image", ...base, mime }
								: { kind: "binary", ...base, reason: "too-large" };
					} else {
						// Bounded read regardless of file size — never
						// readFile() here.
						const { bytes, truncated } = await readHead(
							opened.handle,
							TEXT_PREVIEW_MAX_BYTES,
							opened.size,
						);
						const decoded = decodePreview(bytes, truncated);
						body =
							decoded.kind === "text"
								? { kind: "text", ...base, content: decoded.content, truncated }
								: { kind: "binary", ...base, reason: "binary" };
					}
				} finally {
					await opened.handle.close().catch(() => {});
				}
				noStore(res);
				res.json(body);
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);

	router.get(
		"/sessions/:id/fs/raw",
		requireAuth,
		fileBrowseIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const rel = validateRelPathParam(req.query.path, { allowEmpty: false });
			if (typeof rel !== "string") {
				sendFsError(res, rel);
				return;
			}
			try {
				await sessions.assertOwnedBy(req.params.id, userId);
				const mime = imageMimeFor(rel);
				if (mime === null) {
					res.status(415).json({ error: "only image files can be previewed inline" });
					return;
				}
				const opened = await openWorkspaceFile(req.params.id, rel, {
					maxBytes: IMAGE_PREVIEW_MAX_BYTES,
				});
				if (!opened.ok) {
					sendFsError(res, opened);
					return;
				}
				let bytes: Buffer;
				try {
					// ≤ IMAGE_PREVIEW_MAX_BYTES (checked on the fstat), so a
					// bounded buffered read is fine and lets a mid-read error
					// still answer with a clean JSON 500.
					({ bytes } = await readHead(opened.handle, IMAGE_PREVIEW_MAX_BYTES, opened.size));
				} finally {
					await opened.handle.close().catch(() => {});
				}
				noStore(res);
				res.setHeader("Content-Type", mime);
				res.setHeader("X-Content-Type-Options", "nosniff");
				// SVG is an active document when navigated to directly — and
				// with the SameSite=None auth cookie, a link to this URL would
				// render it on the API origin. The frontend only ever loads
				// these bytes into an <img> via a blob: URL (where scripts never
				// run), so lock direct navigation down hard: download instead of
				// render, and a sandboxed no-script CSP if something renders it
				// anyway.
				res.setHeader(
					"Content-Disposition",
					`attachment; filename="${contentDispositionFilename(opened.name)}"`,
				);
				res.setHeader(
					"Content-Security-Policy",
					"default-src 'none'; style-src 'unsafe-inline'; sandbox",
				);
				res.end(bytes);
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);
}
