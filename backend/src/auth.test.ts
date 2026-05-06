import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetJwtSecretForTests,
	isAllowedWsOrigin,
	parseCorsOrigins,
	validateJwtSecret,
	warnIfWildcardCorsInProduction,
} from "./auth.js";

// These tests manipulate process.env.{JWT_SECRET, NODE_ENV} and use a
// spy on console.warn. Snapshot + restore each to avoid cross-test leakage.
describe("validateJwtSecret", () => {
	const originalEnv = { ...process.env };
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		delete process.env.JWT_SECRET;
		delete process.env.NODE_ENV;
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
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
