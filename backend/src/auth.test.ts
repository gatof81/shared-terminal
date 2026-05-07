import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetJwtSecretForTests,
	AUTH_COOKIE_NAME,
	extractTokenFromCookieHeader,
	isAllowedWsOrigin,
	originMatches,
	parseCorsOrigins,
	requireAuth,
	validateJwtSecret,
	warnIfWildcardCorsInProduction,
} from "./auth.js";
import { logger } from "./logger.js";

// These tests manipulate process.env.{JWT_SECRET, NODE_ENV} and spy on
// the pino logger's `warn` method (production code now logs through the
// shared logger, not raw console). Snapshot + restore each to avoid
// cross-test leakage.
describe("validateJwtSecret", () => {
	const originalEnv = { ...process.env };
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		delete process.env.JWT_SECRET;
		delete process.env.NODE_ENV;
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {
			/* swallow */
		});
		// Reset the module-level captured secret so each test starts from
		// "validateJwtSecret has not run yet". Without this, the capture
		// from an earlier successful validate leaks into later tests.
		__resetJwtSecretForTests();
	});

	afterEach(() => {
		// Restore the real process.env in place — reassigning with
		// `process.env = …` would drop Node's string-coercion behaviour and
		// break any module that captured a reference to the original object.
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, originalEnv);
		warnSpy.mockRestore();
	});

	it("throws in production when JWT_SECRET is unset", () => {
		process.env.NODE_ENV = "production";
		expect(() => validateJwtSecret()).toThrow(/JWT_SECRET must be set/);
	});

	it("throws in production when JWT_SECRET still equals the insecure default", () => {
		process.env.NODE_ENV = "production";
		process.env.JWT_SECRET = "change-me-in-production";
		expect(() => validateJwtSecret()).toThrow(/JWT_SECRET must be set/);
	});

	it("accepts a non-default JWT_SECRET in production", () => {
		process.env.NODE_ENV = "production";
		process.env.JWT_SECRET = "a-real-secret-from-a-secrets-manager";
		expect(() => validateJwtSecret()).not.toThrow();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("in dev, warns when JWT_SECRET is unset but does not throw", () => {
		// No NODE_ENV set — treated as dev.
		expect(() => validateJwtSecret()).not.toThrow();
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/JWT_SECRET is not set/);
	});

	it("in dev, warns when the insecure default is in use", () => {
		process.env.JWT_SECRET = "change-me-in-production";
		expect(() => validateJwtSecret()).not.toThrow();
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/insecure placeholder/);
	});

	it("in dev, stays silent when a real secret is supplied", () => {
		process.env.JWT_SECRET = "real-dev-secret";
		expect(() => validateJwtSecret()).not.toThrow();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	// Regression: `!raw` is true for both undefined and "". Without the
	// matching `raw || DEFAULT` on the capture line, an empty-string env
	// var would be captured verbatim and used to sign tokens.
	it("throws in production when JWT_SECRET is an empty string", () => {
		process.env.NODE_ENV = "production";
		process.env.JWT_SECRET = "";
		expect(() => validateJwtSecret()).toThrow(/JWT_SECRET must be set/);
	});

	it("in dev, treats an empty-string JWT_SECRET as unset", () => {
		process.env.JWT_SECRET = "";
		expect(() => validateJwtSecret()).not.toThrow();
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/JWT_SECRET is not set/);
	});
});

// Pinning the four branches of the CSWSH policy documented on the
// function. The `allowlist` shapes mirror what `CORS_ORIGINS.split(",")`
// produces in index.ts (the real caller) — NOT an arbitrary array
// literal — so these tests catch a regression where someone changes the
// parse at the call site without updating the helper.
describe("isAllowedWsOrigin", () => {
	const ALLOWED_ORIGIN = "https://terminal.example.com";
	const allowlist = [ALLOWED_ORIGIN, "https://other.example.com"];

	// ── Branch 1: absent Origin ────────────────────────────────────────
	it("allows a missing Origin header (non-browser client)", () => {
		// Browsers ALWAYS send Origin on WS. The CSWSH threat strictly
		// requires a browser, so absent Origin is out of scope.
		expect(isAllowedWsOrigin(undefined, allowlist, "production")).toBe(true);
	});

	it("allows an empty-string Origin the same as absent", () => {
		// Some proxies normalise missing headers to empty strings. The
		// helper has to cover both shapes or this branch is a lie.
		expect(isAllowedWsOrigin("", allowlist, "production")).toBe(true);
	});

	// ── Branch 2: explicit match ───────────────────────────────────────
	it("allows an Origin that exactly matches the allowlist", () => {
		expect(isAllowedWsOrigin(ALLOWED_ORIGIN, allowlist, "production")).toBe(true);
	});

	it("rejects a prefix of an allowlisted origin", () => {
		// e.g. `https://terminal.example.com` is allowed, but
		// `https://terminal.example.co` must NOT match. Guard against a
		// future "use startsWith" refactor.
		expect(isAllowedWsOrigin("https://terminal.example.co", allowlist, "production")).toBe(false);
	});

	it("rejects an origin that contains an allowlisted origin as a substring", () => {
		// Classic `attackerour-domain.com` bypass: make sure exact-match
		// semantics hold.
		expect(
			isAllowedWsOrigin("https://attackerhttps://terminal.example.com", allowlist, "production"),
		).toBe(false);
	});

	it("is case-sensitive on the host portion", () => {
		// Origin header is always sent lowercase by browsers. A case
		// mismatch from our allowlist therefore indicates either a
		// hand-crafted request or a misconfiguration — either way, not
		// an allow.
		expect(isAllowedWsOrigin("HTTPS://terminal.example.com", allowlist, "production")).toBe(false);
	});

	// ── Branch 3: wildcard ─────────────────────────────────────────────
	it("rejects a non-matching origin under '*' in production", () => {
		expect(isAllowedWsOrigin("https://evil.example.com", ["*"], "production")).toBe(false);
	});

	it("allows a non-matching origin under '*' outside production", () => {
		// undefined NODE_ENV is the local-dev case (nothing set).
		expect(isAllowedWsOrigin("https://evil.example.com", ["*"], undefined)).toBe(true);
		expect(isAllowedWsOrigin("https://evil.example.com", ["*"], "development")).toBe(true);
		expect(isAllowedWsOrigin("https://evil.example.com", ["*"], "test")).toBe(true);
	});

	it("still allows an explicit-match origin even when '*' and prod coexist", () => {
		// A deployment could have CORS_ORIGINS="*,https://real-frontend"
		// (unusual but legal). The explicit entry should take precedence
		// over the wildcard's production-refusal.
		expect(isAllowedWsOrigin(ALLOWED_ORIGIN, ["*", ALLOWED_ORIGIN], "production")).toBe(true);
	});

	// ── Branch 4: everything else ─────────────────────────────────────
	it("rejects any origin when the allowlist is empty", () => {
		// `"".split(",")` returns `[""]`, not `[]`, so the call-site
		// shape has one empty-string entry. An empty string isn't a
		// valid origin and shouldn't be treated as one — but the caller
		// could also realistically pass `[]` after a future refactor,
		// so pin both.
		expect(isAllowedWsOrigin("https://anything.example", [], "production")).toBe(false);
		expect(isAllowedWsOrigin("https://anything.example", [""], "production")).toBe(false);
	});

	it("rejects a non-allowlisted origin with no wildcard present", () => {
		expect(isAllowedWsOrigin("https://evil.example.com", allowlist, "production")).toBe(false);
	});

	// ── Glob entries (single-DNS-label `*`) ───────────────────────────
	// Useful for Cloudflare Pages preview URLs where each push lands on
	// a fresh subdomain — listing `https://*.<project>.pages.dev` once
	// covers them all without shipping a bypass for arbitrary origins.
	describe("glob entries", () => {
		const globAllow = ["https://*.shared-terminal.pages.dev"];

		it("matches a single-label substitution", () => {
			expect(
				isAllowedWsOrigin("https://abc123.shared-terminal.pages.dev", globAllow, "production"),
			).toBe(true);
			expect(
				isAllowedWsOrigin("https://feat-foo.shared-terminal.pages.dev", globAllow, "production"),
			).toBe(true);
		});

		it("rejects an origin with two labels where the glob expects one", () => {
			// `*` is `[^.]+` — no dots — so a multi-label segment doesn't
			// match. Closes the `attacker.shared-terminal.pages.dev.evil.com`
			// suffix-bypass class.
			expect(
				isAllowedWsOrigin("https://a.b.shared-terminal.pages.dev", globAllow, "production"),
			).toBe(false);
		});

		it("rejects an origin that prepends/appends extra to the glob shape", () => {
			expect(
				isAllowedWsOrigin(
					"https://abc.shared-terminal.pages.dev.evil.com",
					globAllow,
					"production",
				),
			).toBe(false);
			expect(
				isAllowedWsOrigin(
					"https://evil.https://abc.shared-terminal.pages.dev",
					globAllow,
					"production",
				),
			).toBe(false);
		});

		it("rejects a same-host origin on the wrong scheme", () => {
			expect(
				isAllowedWsOrigin("http://abc.shared-terminal.pages.dev", globAllow, "production"),
			).toBe(false);
		});

		it("doesn't treat a literal-dot in the glob as a regex wildcard", () => {
			// The pattern `https://*.shared-terminal.pages.dev` must NOT
			// match `https://abc.shared-terminalApages.dev` — escaping
			// the dots in the entry is load-bearing.
			expect(
				isAllowedWsOrigin("https://abc.shared-terminalXpages.dev", globAllow, "production"),
			).toBe(false);
		});

		it("mixed allowlist: exact + glob both work, neither shadows the other", () => {
			const mixed = ["https://prod.example.com", "https://*.staging.example.com"];
			expect(isAllowedWsOrigin("https://prod.example.com", mixed, "production")).toBe(true);
			expect(isAllowedWsOrigin("https://api.staging.example.com", mixed, "production")).toBe(true);
			expect(isAllowedWsOrigin("https://other.example.com", mixed, "production")).toBe(false);
		});

		it("a glob entry does NOT make bare `*` semantics fire", () => {
			// `https://*.example.com` is a glob, not the wildcard token.
			// The prod-deny path on bare `*` should not engage from a glob.
			expect(
				isAllowedWsOrigin("https://attacker.example.org", ["https://*.example.com"], "production"),
			).toBe(false);
		});
	});
});

// Direct contract tests for `originMatches`. The `isAllowedWsOrigin` block
// already exercises the helper indirectly, but those tests bind the
// behaviour to the WS branch's specific shape — a future refactor of the
// CORS middleware in index.ts could disconnect it from `originMatches`
// without breaking any of those WS-flavoured assertions. Pinning the
// helper as its own thing keeps the contract stable across both callers.
describe("originMatches", () => {
	it("returns false for an empty allowlist", () => {
		expect(originMatches("https://anything.example", [])).toBe(false);
	});

	it("matches an exact entry", () => {
		expect(originMatches("https://app.example.com", ["https://app.example.com"])).toBe(true);
	});

	it("rejects a near-miss exact entry (case, trailing slash)", () => {
		expect(originMatches("https://APP.example.com", ["https://app.example.com"])).toBe(false);
		expect(originMatches("https://app.example.com/", ["https://app.example.com"])).toBe(false);
	});

	it("matches a single-DNS-label glob", () => {
		expect(originMatches("https://abc.example.com", ["https://*.example.com"])).toBe(true);
	});

	it("rejects a multi-label substitution", () => {
		// Glob `*` is `[^.]+` — refuses dots inside the substitution,
		// so `a.b.example.com` doesn't match `*.example.com`.
		expect(originMatches("https://a.b.example.com", ["https://*.example.com"])).toBe(false);
	});

	it("rejects a suffix-bypass shape", () => {
		// `https://app.example.com.evil.com` must not match
		// `https://*.example.com` — the trailing anchor (`$`) blocks
		// any characters past the pattern.
		expect(originMatches("https://app.example.com.evil.com", ["https://*.example.com"])).toBe(
			false,
		);
	});

	it("treats the literal `.` in the pattern as a literal dot, not regex any-char", () => {
		// The escape pass turns `.` into `\.`. A character that's not
		// a dot in the matching position must NOT match.
		expect(originMatches("https://abc.exampleAcom", ["https://*.example.com"])).toBe(false);
	});

	it('skips bare `"*"` entries (callers handle that token separately)', () => {
		// CORS middleware downgrades bare `*` to no-credentials wildcard;
		// `isAllowedWsOrigin` denies in production. If `originMatches`
		// treated `*` as match-everything, both policies would silently
		// bypass.
		expect(originMatches("https://anything.example", ["*"])).toBe(false);
	});

	it("works in a mixed allowlist of exact + glob entries", () => {
		const mixed = ["https://prod.example.com", "https://*.staging.example.com"];
		expect(originMatches("https://prod.example.com", mixed)).toBe(true);
		expect(originMatches("https://api.staging.example.com", mixed)).toBe(true);
		expect(originMatches("https://other.example.com", mixed)).toBe(false);
	});

	it("supports multiple `*` substitutions in one entry", () => {
		// Not the common case, but the regex compilation has no special
		// limit on `*` count — pin the behaviour so it can't silently
		// regress.
		expect(originMatches("https://a.b.example.com", ["https://*.*.example.com"])).toBe(true);
		expect(originMatches("https://a.b.c.example.com", ["https://*.*.example.com"])).toBe(false);
	});
});

// The warning is a startup-time signal for the "CORS_ORIGINS='*' in
// production" foot-gun. Test it via an injected logger so we don't have
// to spy on console.warn globally.
describe("warnIfWildcardCorsInProduction", () => {
	it("warns when '*' is present and NODE_ENV=production", () => {
		const warn = vi.fn();
		warnIfWildcardCorsInProduction(["*"], "production", { warn });
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]?.[0]).toMatch(/CORS_ORIGINS contains '\*' in production/);
	});

	it("still warns when '*' is mixed with explicit entries in production", () => {
		// Defence in depth: the explicit entries give most users a
		// working WS, but the '*' is still a live attack surface via the
		// HTTP layer, so the warning should fire anyway.
		const warn = vi.fn();
		warnIfWildcardCorsInProduction(["*", "https://frontend"], "production", { warn });
		expect(warn).toHaveBeenCalledOnce();
	});

	it("stays quiet outside production regardless of wildcard", () => {
		const warn = vi.fn();
		warnIfWildcardCorsInProduction(["*"], undefined, { warn });
		warnIfWildcardCorsInProduction(["*"], "development", { warn });
		warnIfWildcardCorsInProduction(["*"], "test", { warn });
		expect(warn).not.toHaveBeenCalled();
	});

	it("stays quiet when '*' is absent in production", () => {
		const warn = vi.fn();
		warnIfWildcardCorsInProduction(["https://frontend"], "production", { warn });
		expect(warn).not.toHaveBeenCalled();
	});
});

// Regression coverage for the original parse — `CORS_ORIGINS.split(",")`
// with no trim silently broke exact-match enforcement on any origin past
// the first if the operator wrote the obvious comma-space form. Caught
// in review of the initial CSWSH fix; these tests pin the call-site
// parse shape so a future refactor that drops the trim is a test
// failure, not a production incident.
describe("parseCorsOrigins", () => {
	it("defaults to ['*'] when unset", () => {
		expect(parseCorsOrigins(undefined)).toEqual(["*"]);
	});

	it("returns [] when blank or whitespace-only (opt-in HTTP deny-all)", () => {
		// An operator who blanks CORS_ORIGINS= in a secrets manager
		// gets "deny all cross-origin HTTP" — NOT wildcard allow. The
		// old behaviour silently widened blank to ["*"] after PR #64;
		// issue #65 restored the explicit deny-all path. Note the
		// different semantics vs undefined (the unset case above):
		//   - undefined → ["*"]    (dev default, no config)
		//   - ""        → []       (explicit lock-down)
		// The WS allowlist treats [] as branch-4-deny, matching intent.
		expect(parseCorsOrigins("")).toEqual([]);
		expect(parseCorsOrigins("   ")).toEqual([]);
	});

	it("trims whitespace around each entry", () => {
		// The original bug. Leading spaces after commas used to produce
		// [' https://b.example.com'] which never equalled the Origin
		// header the browser actually sends.
		expect(parseCorsOrigins("https://a.example.com, https://b.example.com")).toEqual([
			"https://a.example.com",
			"https://b.example.com",
		]);
	});

	it("handles tabs and surrounding whitespace uniformly", () => {
		expect(parseCorsOrigins("\thttps://a ,https://b\t")).toEqual(["https://a", "https://b"]);
	});

	it("drops empty entries after trimming", () => {
		// Trailing comma is common in edit-via-secrets-manager flows.
		// Leaves the allowlist clean instead of carrying a "" entry
		// that would match a literal empty Origin header (branch 2 of
		// isAllowedWsOrigin) — an ambiguous failure mode we'd rather
		// not have.
		expect(parseCorsOrigins("https://a,,https://b,")).toEqual(["https://a", "https://b"]);
	});

	it("preserves '*' when explicitly set", () => {
		// Don't accidentally strip the wildcard. The default fallback
		// above produces the same output, but the explicit path must
		// also round-trip.
		expect(parseCorsOrigins("*")).toEqual(["*"]);
		expect(parseCorsOrigins("*, https://b")).toEqual(["*", "https://b"]);
	});
});

// ── Cookie auth primitives (#18) ───────────────────────────────────────────

describe("extractTokenFromCookieHeader", () => {
	it("returns null on missing or malformed inputs", () => {
		expect(extractTokenFromCookieHeader(undefined)).toBeNull();
		expect(extractTokenFromCookieHeader("")).toBeNull();
		// No `=` at all → ignore the part.
		expect(extractTokenFromCookieHeader("badheader")).toBeNull();
		// Cookie with our name but empty value → null, not "".
		expect(extractTokenFromCookieHeader(`${AUTH_COOKIE_NAME}=`)).toBeNull();
	});

	it("picks our cookie out of a multi-cookie header regardless of position", () => {
		expect(
			extractTokenFromCookieHeader(`other=value; ${AUTH_COOKIE_NAME}=tok-123; trailing=stuff`),
		).toBe("tok-123");
		expect(extractTokenFromCookieHeader(`${AUTH_COOKIE_NAME}=tok-first; other=ignored`)).toBe(
			"tok-first",
		);
	});

	it("trims surrounding whitespace on both name and value", () => {
		expect(extractTokenFromCookieHeader(`  ${AUTH_COOKIE_NAME} = tok-spacey  `)).toBe("tok-spacey");
	});

	it("URL-decodes percent-encoded values", () => {
		// `=` shows up in the JWT padding for some payloads; servers
		// percent-encode cookie values when setting them. Make sure we
		// undo that on read.
		const encoded = encodeURIComponent("tok+with/special=chars");
		expect(extractTokenFromCookieHeader(`${AUTH_COOKIE_NAME}=${encoded}`)).toBe(
			"tok+with/special=chars",
		);
	});

	it("returns the raw value when decodeURIComponent throws on a malformed sequence", () => {
		// `%E0%A4%A` is a truncated UTF-8 sequence that decodeURIComponent
		// rejects with URIError. We'd rather hand the verifier a string
		// it'll reject downstream than 500 the request here.
		expect(extractTokenFromCookieHeader(`${AUTH_COOKIE_NAME}=tok%E0%A4%A`)).toBe("tok%E0%A4%A");
	});

	it("ignores cookies with other names", () => {
		expect(extractTokenFromCookieHeader("session=foo; csrf=bar")).toBeNull();
	});

	it("flattens an array Cookie header (not standard but tolerated)", () => {
		// Some frameworks coerce duplicate Cookie headers into a string[].
		// Joining mirrors what the browser actually transmits — a single
		// string with `; ` between entries.
		expect(extractTokenFromCookieHeader(["other=value", `${AUTH_COOKIE_NAME}=tok-arr`])).toBe(
			"tok-arr",
		);
	});
});

describe("requireAuth", () => {
	const TEST_SECRET = "test-secret-do-not-use-in-prod";
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.JWT_SECRET = TEST_SECRET;
		__resetJwtSecretForTests();
		validateJwtSecret();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, originalEnv);
		__resetJwtSecretForTests();
	});

	type CookieReq = Request & { cookies?: Record<string, string> };

	function makeReq(opts: { cookies?: Record<string, string>; cookieHeader?: string }): CookieReq {
		return {
			cookies: opts.cookies,
			headers: { cookie: opts.cookieHeader },
		} as unknown as CookieReq;
	}

	function makeRes(): {
		res: Response;
		status: ReturnType<typeof vi.fn>;
		json: ReturnType<typeof vi.fn>;
	} {
		const json = vi.fn();
		const status = vi.fn(() => ({ json }) as unknown as Response);
		return {
			res: { status } as unknown as Response,
			status,
			json,
		};
	}

	it("401s when no cookie is present anywhere", () => {
		const req = makeReq({});
		const { res, status, json } = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		requireAuth(req, res, next);

		expect(status).toHaveBeenCalledWith(401);
		expect(json).toHaveBeenCalledWith({ error: "Missing or invalid auth cookie" });
		expect(next).not.toHaveBeenCalled();
	});

	it("401s when the cookie carries a malformed JWT", () => {
		const req = makeReq({ cookies: { [AUTH_COOKIE_NAME]: "not-a-jwt" } });
		const { res, status, json } = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		requireAuth(req, res, next);

		expect(status).toHaveBeenCalledWith(401);
		expect(json).toHaveBeenCalledWith({ error: "Missing or invalid auth cookie" });
		expect(next).not.toHaveBeenCalled();
	});

	it("populates userId/username from a valid cookie via cookie-parser path", () => {
		const token = jwt.sign({ sub: "u-1", username: "alice" }, TEST_SECRET);
		const req = makeReq({ cookies: { [AUTH_COOKIE_NAME]: token } });
		const { res } = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		requireAuth(req, res, next);

		const reqWithIdent = req as unknown as { userId: string; username: string };
		expect(reqWithIdent.userId).toBe("u-1");
		expect(reqWithIdent.username).toBe("alice");
		expect(next).toHaveBeenCalled();
	});

	it("falls back to the raw Cookie header when req.cookies is absent", () => {
		// Simulates a path that bypassed cookie-parser. The fallback exists
		// strictly for defence in depth — if the middleware is wired
		// correctly the bypass never fires, but a future test stubbing
		// the express stack should still authenticate.
		const token = jwt.sign({ sub: "u-2", username: "bob" }, TEST_SECRET);
		const req = makeReq({ cookieHeader: `other=x; ${AUTH_COOKIE_NAME}=${token}` });
		const { res } = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		requireAuth(req, res, next);

		const reqWithIdent = req as unknown as { userId: string; username: string };
		expect(reqWithIdent.userId).toBe("u-2");
		expect(next).toHaveBeenCalled();
	});

	it("prefers req.cookies over the raw Cookie header (cookie-parser is authoritative)", () => {
		// If both somehow exist, the parsed map wins so behaviour matches
		// the rest of the app, which trusts cookie-parser.
		const tokenA = jwt.sign({ sub: "from-cookies", username: "a" }, TEST_SECRET);
		const tokenB = jwt.sign({ sub: "from-header", username: "b" }, TEST_SECRET);
		const req = makeReq({
			cookies: { [AUTH_COOKIE_NAME]: tokenA },
			cookieHeader: `${AUTH_COOKIE_NAME}=${tokenB}`,
		});
		const { res } = makeRes();
		const next = vi.fn() as unknown as NextFunction;

		requireAuth(req, res, next);

		expect((req as unknown as { userId: string }).userId).toBe("from-cookies");
		expect(next).toHaveBeenCalled();
	});
});
