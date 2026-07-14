/**
 * logger.ts — Backend structured logger (#5).
 *
 * Single pino instance. Replaces ad-hoc `console.{log,warn,error,debug}`
 * calls so:
 *  - Production logs are JSON, indexable by whatever ships them off the host
 *    (Cloudflare Tunnel access logs, journalctl, a future shipper).
 *  - Levels are honoured — `LOG_LEVEL=warn` actually suppresses info, where
 *    `console.log` had nothing to filter on.
 *  - Sensitive values (jwt, password fields, raw invite plaintext) are
 *    redacted at the logger boundary so a future caller can't accidentally
 *    leak by passing the wrong field into a log object.
 *
 * Dev runs through pino-pretty for human-readable output. Test runs are
 * silent by default — vi.spyOn still captures calls — so the test reporter
 * stays uncluttered.
 *
 * Migration scope: `console.*` → `logger.*` only. Request-id middleware
 * and per-WebSocket child loggers come later (deliberately scoped out of
 * the initial migration to keep the diff readable).
 */

import { type Logger, pino } from "pino";
import { getRequestId } from "./requestContext.js";

const NODE_ENV = process.env.NODE_ENV;
const isProduction = NODE_ENV === "production";
// Tests run under vitest which sets the VITEST env var; honour an explicit
// NODE_ENV=test too so the same path applies to anything else that flips it.
const isTest = NODE_ENV === "test" || process.env.VITEST === "true";

// pino-pretty as an inline transport spawns a worker thread, which clashes
// with vitest's lifecycle (the thread can outlive a test file and emit after
// teardown). Only enable it in dev, where the readability win matters.
const transport =
	!isProduction && !isTest
		? {
				target: "pino-pretty",
				options: {
					translateTime: "SYS:HH:MM:ss.l",
					ignore: "pid,hostname",
				},
			}
		: undefined;

const defaultLevel = isProduction ? "info" : isTest ? "silent" : "debug";

// Redaction acts on field paths, not message-string substrings. Listed
// here are the known carriers of secret material in this codebase — adding
// a new auth path that lands a JWT or invite plaintext into a log object
// should grow this list, not depend on every caller remembering to scrub.
//
// Field-name list, not substring match. Picked specifically so a future
// caller logging `{ code: statusCode }` (HTTP status, error code,
// anything-but-an-invite-secret) doesn't get silently redacted —
// `inviteCode` / `invite_code` cover the actual plaintext-bearing fields,
// and any new secret carrier should land here under its own specific key.
//
// Exported so the redaction behaviour can be unit-tested against a captured
// stream without reaching into the live logger's transport.
export const REDACT_PATHS = [
	"password",
	"passwordHash",
	"password_hash",
	"token",
	"jwt",
	"jwtSecret",
	"JWT_SECRET",
	"inviteCode",
	"invite_code",
	"authorization",
	"Authorization",
	"cookie",
	"Cookie",
	// Nested carriers (#305): pino matches redact paths exactly from the
	// root, so the bare keys above only scrub a TOP-LEVEL field. A future
	// caller logging a request/headers object — `logger.info({ req })` or
	// `logger.warn({ headers })` — would otherwise leak the `st_token` JWT
	// riding in the Cookie / Authorization header. `*` is a single-level
	// wildcard, so cover the realistic one-level (`headers.cookie`) and
	// two-level (`req.headers.cookie`) nestings for the JWT-bearing headers.
	"*.cookie",
	"*.Cookie",
	"*.authorization",
	"*.Authorization",
	// Only lowercase for the concrete `req.headers.*` paths: Node lowercases
	// every incoming HTTP header name, so a capital-C `req.headers.Cookie`
	// could never match a real request object. (The `*.Cookie` wildcards
	// above still cover a manually-built object with a capital key.)
	"req.headers.cookie",
	"req.headers.authorization",
	// The RESPONSE side carries the same JWT: `setAuthCookie` writes it as a
	// `Set-Cookie` header, so `logger.warn({ headers: res.getHeaders() })`
	// would leak it. The hyphen needs bracket notation in fast-redact. Node
	// lowercases response header keys too, so lowercase is the real match;
	// the capitalised variants guard manually-built objects.
	'["set-cookie"]',
	'["Set-Cookie"]',
	'*["set-cookie"]',
	'*["Set-Cookie"]',
	// Two-level concrete paths for the response side, mirroring
	// `req.headers.cookie`: a caller logging `{ res: { headers: ... } }`
	// nests set-cookie one level deeper than the `*[...]` wildcard reaches.
	'res.headers["set-cookie"]',
	'res.headers["Set-Cookie"]',
];

/**
 * Stamps the ambient request/correlation id (#376) onto every log line
 * emitted inside a request or WS-upgrade context — see requestContext.ts
 * for why the id is ambient rather than threaded through child loggers.
 * Returns `{}` outside any context so boot/sweeper/reconcile lines don't
 * grow a useless `requestId: undefined` field.
 *
 * The bindings check exists because both correlation mechanisms can be
 * live at once: wsHandler children bind requestId eagerly (socket events
 * fire outside the ALS context), but their setup-time calls still run
 * INSIDE the upgrade's context. pino concatenates child bindings and the
 * mixin result without dedupe, so stamping there again emits the key
 * twice in one JSON line — same value, but malformed enough to trip a
 * strict log pipeline. Bindings win; the mixin only fills the gap.
 *
 * Exported so the wiring can be unit-tested against a captured stream
 * (same pattern as REDACT_PATHS above).
 */
export function requestIdMixin(
	_mergeObject: object,
	_level: number,
	instance: Logger,
): { requestId?: string } {
	const requestId = getRequestId();
	if (requestId === undefined) return {};
	const bound = (instance.bindings() as { requestId?: string }).requestId;
	return bound === undefined ? { requestId } : {};
}

export const logger = pino({
	level: process.env.LOG_LEVEL ?? defaultLevel,
	transport,
	mixin: requestIdMixin,
	redact: {
		paths: REDACT_PATHS,
		censor: "[redacted]",
	},
});
