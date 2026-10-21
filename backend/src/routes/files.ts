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

import { pipeline } from "node:stream/promises";
import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAuth } from "../auth.js";
import { InFlightLimiter } from "../inFlightLimiter.js";
import { logger } from "../logger.js";
import {
	contentDispositionFilename,
	listWorkspaceDir,
	openWorkspaceFile,
	readHead,
	validateRelPathParam,
	type WorkspaceFsError,
} from "../workspaceFiles.js";
import { assertOwnedByOr404, handleSessionError, type RouteContext } from "./shared.js";

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
// coaxed into serving e.g. HTML with a renderable content type. A Map,
// not an object literal: the key comes from a user-controlled filename,
// and `x.constructor` / `x.__proto__` must miss rather than resolve to
// an inherited Object.prototype member.
const IMAGE_MIME_BY_EXT = new Map<string, string>([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
	["avif", "image/avif"],
	["bmp", "image/bmp"],
	["ico", "image/x-icon"],
	["svg", "image/svg+xml"],
]);

export function imageMimeFor(name: string): string | null {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	return IMAGE_MIME_BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? null;
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

// Concurrency caps (see inFlightLimiter.ts for why a per-minute rate limit
// alone doesn't bound memory). Text previews buffer up to 1 MiB plus its
// JSON encoding, so they get the tighter process-wide cap; image streams
// hold only an fd and a stream highWaterMark each, so more may run.
export const PREVIEW_IN_FLIGHT_PER_USER = 4;
export const PREVIEW_IN_FLIGHT_TOTAL = 16;
export const RAW_IN_FLIGHT_PER_USER = 4;
export const RAW_IN_FLIGHT_TOTAL = 32;
// Listings: bodies are smaller (≤2000 entries, a few hundred KB) but the
// tree fires one per expanded folder on refresh, so a bit more headroom.
export const LIST_IN_FLIGHT_PER_USER = 6;
export const LIST_IN_FLIGHT_TOTAL = 32;

/**
 * Take a slot and hold it until the RESPONSE is done — `finish` (last byte
 * handed to the OS) or `close` (client went away / socket destroyed),
 * whichever fires; release is idempotent. Not until the handler returns:
 * `res.json(body)` only queues a 1 MiB+ body, and a client that doesn't
 * drain keeps it in memory long after the handler is gone, so releasing
 * in a `finally` would let the same user stack up unbounded pending
 * responses. Error paths (4xx/5xx JSON) also end in finish/close, so
 * every early return is covered without a per-branch release.
 */
export function holdSlotUntilResponseEnds(
	slots: InFlightLimiter,
	userId: string,
	res: Response,
): boolean {
	const release = slots.tryAcquire(userId);
	if (release === null) return false;
	res.once("finish", release);
	res.once("close", release);
	return true;
}

function sendBusy(res: Response): void {
	res.setHeader("Retry-After", "1");
	res.status(429).json({ error: "Too many file requests in progress, try again shortly" });
}

export function registerFileRoutes(router: Router, ctx: RouteContext): void {
	const { sessions } = ctx;
	const { fileBrowseIp, fileRawIp } = ctx.limiters;
	// Per router (not module-level) so each test's router starts empty;
	// production builds exactly one router.
	const previewSlots = new InFlightLimiter(PREVIEW_IN_FLIGHT_PER_USER, PREVIEW_IN_FLIGHT_TOTAL);
	const rawSlots = new InFlightLimiter(RAW_IN_FLIGHT_PER_USER, RAW_IN_FLIGHT_TOTAL);
	const listSlots = new InFlightLimiter(LIST_IN_FLIGHT_PER_USER, LIST_IN_FLIGHT_TOTAL);

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
				// Ownership BEFORE any filesystem access, and foreign ==
				// missing (see assertOwnedByOr404): a probe learns nothing
				// about another workspace, not even that the session exists.
				await assertOwnedByOr404(sessions, req.params.id, userId);
				// A listing is up to MAX_DIR_ENTRIES lstats plus a JSON body
				// that, like a preview, sits in memory until the client
				// drains it — same slot discipline, own pool.
				if (!holdSlotUntilResponseEnds(listSlots, userId, res)) {
					sendBusy(res);
					return;
				}
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
				await assertOwnedByOr404(sessions, req.params.id, userId);
				if (!holdSlotUntilResponseEnds(previewSlots, userId, res)) {
					sendBusy(res);
					return;
				}
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
		// Own budget, separate from browsing: an image-heavy folder
		// shouldn't starve tree navigation, and vice versa.
		fileRawIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const rel = validateRelPathParam(req.query.path, { allowEmpty: false });
			if (typeof rel !== "string") {
				sendFsError(res, rel);
				return;
			}
			try {
				await assertOwnedByOr404(sessions, req.params.id, userId);
				// Slot BEFORE the open so a burst can't even hold fds.
				if (!holdSlotUntilResponseEnds(rawSlots, userId, res)) {
					sendBusy(res);
					return;
				}
				const opened = await openWorkspaceFile(req.params.id, rel, {
					maxBytes: IMAGE_PREVIEW_MAX_BYTES,
				});
				if (!opened.ok) {
					sendFsError(res, opened);
					return;
				}
				// Type from the resolved leaf name — the same string the
				// preview route checks — not the raw `?path=`.
				const mime = imageMimeFor(opened.name);
				if (mime === null) {
					await opened.handle.close().catch(() => {});
					res.status(415).json({ error: "only image files can be previewed inline" });
					return;
				}
				noStore(res);
				res.setHeader("Content-Type", mime);
				res.setHeader("Content-Length", String(opened.size));
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
				if (opened.size === 0) {
					await opened.handle.close().catch(() => {});
					res.end();
					return;
				}
				try {
					// Streamed from the validated fd with backpressure: memory
					// per request is one stream highWaterMark, not the image.
					// `end` pins the body to the fstat size we advertised in
					// Content-Length even if the file grows mid-stream.
					// pipeline destroys both sides (closing the fd via
					// autoClose) on read error or client abort.
					await pipeline(opened.handle.createReadStream({ start: 0, end: opened.size - 1 }), res);
				} catch (err) {
					if (!res.headersSent) {
						res.removeHeader("Content-Length");
						res.removeHeader("Content-Disposition");
						res.status(500).json({ error: "Internal server error" });
					} else {
						// Bytes already went out under a 200: kill the socket so
						// the client sees a truncated transfer, not a short EOF.
						res.destroy();
					}
					logger.warn(
						`[routes] raw preview aborted for session ${req.params.id}: ${(err as Error).message}`,
					);
				}
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);
}
