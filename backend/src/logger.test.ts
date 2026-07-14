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
import { REDACT_PATHS, requestIdMixin } from "./logger.js";
import { runWithRequestId } from "./requestContext.js";

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
		// Capital-case bracket paths get their own coverage so a syntax error
		// in those entries can't survive the suite via a lowercase test value.
		const topCap = captureLog({ "Set-Cookie": JWT });
		expect(topCap).not.toMatch(/eyJhbGciOi/);
		expect(topCap).toMatch(/\[redacted\]/);
		const nestedCap = captureLog({ headers: { "Set-Cookie": JWT } });
		expect(nestedCap).not.toMatch(/eyJhbGciOi/);
		expect(nestedCap).toMatch(/\[redacted\]/);
	});

	it("redacts a two-level-nested res.headers set-cookie", () => {
		// `logger.warn({ res: { headers: res.getHeaders() } })` nests
		// set-cookie one level deeper than the `*[...]` wildcard reaches.
		const out = captureLog({ res: { headers: { "set-cookie": JWT } } });
		expect(out).not.toMatch(/eyJhbGciOi/);
		expect(out).toMatch(/\[redacted\]/);
	});

	it("does not over-redact a benign numeric `code` field", () => {
		// Guard the deliberate choice to redact `inviteCode`/`invite_code`
		// but NOT a bare `code` (HTTP status / error code).
		const out = captureLog({ code: 503 });
		expect(out).toMatch(/503/);
		expect(out).not.toMatch(/\[redacted\]/);
	});
});

describe("requestIdMixin (#376)", () => {
	// Same captured-stream pattern as the redaction tests: build a pino
	// with the real mixin so the assertion covers the serialised line,
	// not just the mixin's return value.
	function captureLine(fn: (l: pino.Logger) => void): string {
		let out = "";
		const sink = new Writable({
			write(chunk, _enc, cb) {
				out += chunk.toString();
				cb();
			},
		});
		const l = pino({ level: "info", mixin: requestIdMixin }, sink);
		fn(l);
		return out;
	}

	it("stamps the ambient id onto a line logged inside a context", () => {
		const out = captureLine((l) => runWithRequestId("cafe0123deadbeef", () => l.info("hi")));
		expect(JSON.parse(out).requestId).toBe("cafe0123deadbeef");
	});

	it("adds no requestId field outside any context", () => {
		// Boot/sweeper/reconcile lines must not grow `requestId: undefined`.
		const out = captureLine((l) => l.info("hi"));
		expect(JSON.parse(out)).not.toHaveProperty("requestId");
	});

	it("child loggers inherit the mixin — the wsHandler shape", () => {
		// wsHandler captures the id eagerly via logger.child({requestId})
		// because socket events fire outside the upgrade's context; a line
		// from such a child must carry the captured id even with no
		// ambient context active.
		const out = captureLine((l) => l.child({ requestId: "feedface00000000" }).info("hi"));
		expect(JSON.parse(out).requestId).toBe("feedface00000000");
	});

	it("does not emit the key twice when a bound child logs inside a context", () => {
		// A wsHandler child's setup-time calls run INSIDE the upgrade's
		// context, so bindings and mixin are both live — pino concatenates
		// them without dedupe. Assert on the RAW line: JSON.parse silently
		// collapses duplicate keys, so it can't catch this regression.
		const out = captureLine((l) =>
			runWithRequestId("cafe0123deadbeef", () =>
				l.child({ requestId: "cafe0123deadbeef" }).info("hi"),
			),
		);
		expect(out.match(/"requestId"/g)).toHaveLength(1);
	});

	it("the bound id wins over a different ambient id", () => {
		// The child pinned the connection's id at upgrade time; a log call
		// that happens to run inside some OTHER request's context (e.g. a
		// broadcaster fan-out triggered by another user's attach) must keep
		// the connection's id, not inherit the bystander's.
		const out = captureLine((l) =>
			runWithRequestId("aaaaaaaaaaaaaaaa", () =>
				l.child({ requestId: "bbbbbbbbbbbbbbbb" }).info("hi"),
			),
		);
		expect(out.match(/"requestId"/g)).toHaveLength(1);
		expect(JSON.parse(out).requestId).toBe("bbbbbbbbbbbbbbbb");
	});
});
