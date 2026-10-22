/**
 * conversation/ingestRoute.ts — `POST /ingest/claude/hook`
 * (docs/CONVERSATION.md §3). Mounted in index.ts BEFORE express.json,
 * cookieParser and CORS: it has its own L5-capped body reader, carries
 * no cookies and answers no browser, so none of those layers apply.
 *
 * The one rule every branch obeys: **always 204 with an empty body**.
 * A hook that saw a 4xx/5xx would surface as an error in the agent's
 * terminal; observability must never produce noise in the agent. The
 * outcome goes to counters, never to the response.
 *
 * Order (§3.1): headers → session/token/flag/running (no body yet) →
 * Content-Length vs L5 and the G2 gate → read the body → JSON parse →
 * R1/R2 → `service.ingest` (normalise, revocation stat, dedupe, state,
 * enqueue). The 204 is written as soon as the body is in memory; the
 * rest runs after the response.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { INGEST_PATH } from "./activation.js";
import { L5_BODY_BYTES } from "./limits.js";
import type { ConversationService } from "./service.js";

export interface IngestRouteOptions {
	service: ConversationService;
	/** Override for tests. */
	maxBodyBytes?: number;
}

type Req = IncomingMessage;
type Res = ServerResponse;

function header(req: Req, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}

function end204(res: Res): void {
	if (res.headersSent) return;
	res.statusCode = 204;
	res.setHeader("Cache-Control", "no-store");
	res.end();
}

/** Discard whatever the client still sends so the socket can be reused. */
function drain(req: Req): void {
	req.resume();
}

/**
 * Read at most `max` bytes. Resolves with the body, or null when the
 * stream exceeded `max` (reading stops; the rest is discarded).
 */
function readBody(req: Req, max: number): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const finish = (value: Buffer | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			total += chunk.length;
			if (total > max) {
				finish(null);
				drain(req);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => finish(Buffer.concat(chunks)));
		req.on("error", () => finish(null));
		req.on("aborted", () => finish(null));
	});
}

/**
 * Returns an Express-compatible middleware that handles exactly
 * `POST <INGEST_PATH>` and passes everything else through.
 */
export function createIngestHandler(opts: IngestRouteOptions) {
	const max = opts.maxBodyBytes ?? L5_BODY_BYTES;
	const { service } = opts;

	return async (req: Req, res: Res, next: () => void): Promise<void> => {
		if (req.url !== INGEST_PATH || req.method !== "POST") {
			next();
			return;
		}
		const pane = sanitizePane(header(req, "x-st-tmux-pane"));
		const auth = await service.authorize({
			authorization: header(req, "authorization"),
			stSession: header(req, "x-st-session"),
			tmuxPane: pane,
		});
		if (!("ok" in auth)) {
			drain(req);
			end204(res);
			return;
		}
		const stSessionId = auth.stSessionId;

		// Content-Length is required: a chunked body of unknown size cannot
		// be budgeted against R2 before it is read, and the hook client
		// always sends it. Absent or over L5 ⇒ too_large (§3.1).
		const declared = Number.parseInt(header(req, "content-length") ?? "", 10);
		if (!Number.isFinite(declared) || declared < 0 || declared > max) {
			drain(req);
			end204(res);
			await service.noteUnparseable(stSessionId, pane, "too_large");
			return;
		}
		let release: (() => void) | null = null;
		if (service.largeBodies.isLarge(declared)) {
			release = service.largeBodies.acquire();
			if (!release) {
				drain(req);
				end204(res);
				service.noteBackpressure(stSessionId, pane, "ingest");
				return;
			}
		}
		try {
			const rate = service.takeRate(stSessionId, declared);
			if (!("ok" in rate)) {
				drain(req);
				end204(res);
				return;
			}
			const body = await readBody(req, max);
			// The hook is answered here: nothing below is on its clock.
			end204(res);
			if (body === null) {
				await service.noteUnparseable(stSessionId, pane, "too_large");
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(body.toString("utf8"));
			} catch {
				await service.noteUnparseable(stSessionId, pane, "invalid_json");
				return;
			}
			await service.ingest(stSessionId, pane, parsed);
		} catch {
			// Never let an unexpected failure reach the hook as an error.
			end204(res);
		} finally {
			release?.();
		}
	};
}

/** `^%\d{1,6}$` or nothing (§3.2). */
export function sanitizePane(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const v = raw.trim();
	return /^%\d{1,6}$/.test(v) ? v : undefined;
}
