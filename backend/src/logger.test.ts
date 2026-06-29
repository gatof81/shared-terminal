/**
 * logger.test.ts — redaction coverage (#305).
 *
 * pino matches redact paths exactly from the root, so the bare `cookie` /
 * `authorization` keys only scrub a TOP-LEVEL field. These tests pin that
 * the JWT-bearing headers are also scrubbed when logged nested (the shape a
 * future `logger.info({ req })` / `logger.warn({ headers })` would produce),
 * so the redaction list can't silently regress to top-level-only.
 */

import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS } from "./logger.js";

// Build a logger with the real production redact paths but pointed at a
// capturing stream, so we assert on exactly what would be serialised.
function captureLog(obj: unknown): string {
	let out = "";
	const sink = new Writable({
		write(chunk, _enc, cb) {
			out += chunk.toString();
			cb();
		},
	});
	const l = pino({ level: "info", redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, sink);
	l.info(obj as Record<string, unknown>, "test");
	return out;
}

describe("logger redaction (#305)", () => {
	const JWT = "st_token=eyJhbGciOi.SECRET.SIG";

	it("redacts a top-level cookie / authorization", () => {
		const out = captureLog({ cookie: JWT, authorization: "Bearer SECRET" });
		expect(out).not.toMatch(/SECRET/);
		expect(out).toMatch(/\[redacted\]/);
	});

	it("redacts a one-level-nested headers.cookie / headers.authorization", () => {
		const out = captureLog({ headers: { cookie: JWT, authorization: "Bearer SECRET" } });
		expect(out).not.toMatch(/SECRET/);
		// Assert the field was censored (not merely absent) — a mis-spelled
		// path that pino never matches would also satisfy `not.toMatch`.
		expect(out).toMatch(/\[redacted\]/);
	});

	it("redacts a two-level-nested req.headers.cookie / req.headers.authorization", () => {
		const out = captureLog({ req: { headers: { cookie: JWT, authorization: "Bearer SECRET" } } });
		expect(out).not.toMatch(/SECRET/);
		expect(out).toMatch(/\[redacted\]/);
	});

	it("redacts a Set-Cookie response header (top-level and nested under headers)", () => {
		// setAuthCookie delivers the JWT via Set-Cookie; res.getHeaders()
		// lowercases the key.
		const top = captureLog({ "set-cookie": JWT });
		expect(top).not.toMatch(/eyJhbGciOi/);
		expect(top).toMatch(/\[redacted\]/);
		const nested = captureLog({ headers: { "set-cookie": JWT } });
		expect(nested).not.toMatch(/eyJhbGciOi/);
		expect(nested).toMatch(/\[redacted\]/);
	});

	it("does not over-redact a benign numeric `code` field", () => {
		// Guard the deliberate choice to redact `inviteCode`/`invite_code`
		// but NOT a bare `code` (HTTP status / error code).
		const out = captureLog({ code: 503 });
		expect(out).toMatch(/503/);
		expect(out).not.toMatch(/\[redacted\]/);
	});
});
