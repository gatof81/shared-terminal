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

import { pino } from "pino";

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

export const logger = pino({
	level: process.env.LOG_LEVEL ?? defaultLevel,
	transport,
	// Redaction acts on field paths, not message-string substrings. Listed
	// here are the known carriers of secret material in this codebase —
	// adding a new auth path that lands a JWT or invite plaintext into a
	// log object should grow this list, not depend on every caller
	// remembering to scrub.
	redact: {
		paths: [
			"password",
			"passwordHash",
			"password_hash",
			"token",
			"jwt",
			"jwtSecret",
			"JWT_SECRET",
			"inviteCode",
			"invite_code",
			"code",
			"authorization",
			"Authorization",
			"cookie",
			"Cookie",
		],
		censor: "[redacted]",
	},
});
