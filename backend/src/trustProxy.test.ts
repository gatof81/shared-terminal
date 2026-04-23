import { describe, expect, it, vi } from "vitest";
import {
        parseTrustProxy,
        TrustProxyError,
        warnIfProductionMisconfigured,
} from "./trustProxy.js";

describe("parseTrustProxy", () => {
        // ── unset / blank ──────────────────────────────────────────────────

        it("returns undefined for unset / empty / whitespace-only input", () => {
                expect(parseTrustProxy(undefined)).toBeUndefined();
                expect(parseTrustProxy("")).toBeUndefined();
                expect(parseTrustProxy("   ")).toBeUndefined();
                expect(parseTrustProxy("\t\n")).toBeUndefined();
        });

        // ── foot-gun: "true" ───────────────────────────────────────────────

        it("rejects the literal string 'true' with an actionable message", () => {
                // Covers the most likely mistake — an operator reading
                // 'trust proxy' as a boolean. Message must name the correct
                // alternative so the fix is obvious from the error alone.
                expect(() => parseTrustProxy("true")).toThrow(TrustProxyError);
                try {
                        parseTrustProxy("true");
                } catch (err) {
                        expect((err as Error).message).toMatch(/leftmost.*X-Forwarded-For/);
                        expect((err as Error).message).toMatch(/TRUST_PROXY=1/);
                }
        });

        // ── falsy forms ────────────────────────────────────────────────────

        it("coerces '0' and 'false' to the literal boolean false", () => {
                // We deliberately emit boolean false instead of relying on
                // Express's compileTrust(0) behaviour, which is undocumented.
                expect(parseTrustProxy("0")).toBe(false);
                expect(parseTrustProxy("false")).toBe(false);
                expect(parseTrustProxy(" false ")).toBe(false);
        });

        // ── hop counts ─────────────────────────────────────────────────────

        it("parses non-negative integer hop counts to numbers", () => {
                expect(parseTrustProxy("1")).toBe(1);
                expect(parseTrustProxy("2")).toBe(2);
                expect(parseTrustProxy("10")).toBe(10);
                expect(parseTrustProxy(" 1 ")).toBe(1);
        });

        it("rejects signed, fractional, or scientific-notation numbers", () => {
                // These slip past a naive `Number("…")` check but aren't
                // legitimate hop counts.
                expect(() => parseTrustProxy("-1")).toThrow(TrustProxyError);
                expect(() => parseTrustProxy("+1")).toThrow(TrustProxyError);
                expect(() => parseTrustProxy("1.5")).toThrow(TrustProxyError);
                expect(() => parseTrustProxy("1e2")).toThrow(TrustProxyError);
        });

        // ── named presets ──────────────────────────────────────────────────

        it("accepts Express's documented named presets", () => {
                expect(parseTrustProxy("loopback")).toBe("loopback");
                expect(parseTrustProxy("linklocal")).toBe("linklocal");
                expect(parseTrustProxy("uniquelocal")).toBe("uniquelocal");
        });

        it("rejects typos of preset names", () => {
                // Without this guard, Express would silently treat 'loopbakc'
                // as a literal hostname to trust — which is worse than
                // failing loudly.
                expect(() => parseTrustProxy("loopbakc")).toThrow(TrustProxyError);
                expect(() => parseTrustProxy("link-local")).toThrow(TrustProxyError); // dash not allowed
                expect(() => parseTrustProxy("unique_local")).toThrow(TrustProxyError);
        });

        // ── IPs and CIDRs ──────────────────────────────────────────────────

        it("accepts IPv4, IPv6, and CIDR shapes", () => {
                expect(parseTrustProxy("10.0.0.1")).toBe("10.0.0.1");
                expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
                expect(parseTrustProxy("::1")).toBe("::1");
                expect(parseTrustProxy("2001:db8::/32")).toBe("2001:db8::/32");
        });

        it("accepts comma-separated lists of IPs / presets", () => {
                expect(parseTrustProxy("10.0.0.0/8, loopback")).toBe("10.0.0.0/8, loopback");
                expect(parseTrustProxy("loopback,linklocal")).toBe("loopback,linklocal");
        });

        it("rejects a list if any single token is unrecognised", () => {
                // Wholesale refuse the whole value rather than silently
                // accepting the good tokens — the unrecognised one is almost
                // certainly the bug that needs fixing.
                expect(() => parseTrustProxy("loopback,not-a-thing")).toThrow(TrustProxyError);
                expect(() => parseTrustProxy("yes")).toThrow(TrustProxyError);
                expect(() => parseTrustProxy("cloudflare")).toThrow(TrustProxyError);
        });

        it("error message names the offending token so ops can fix it fast", () => {
                try {
                        parseTrustProxy("loopback,not-a-thing,10.0.0.0/8");
                        expect.fail("should have thrown");
                } catch (err) {
                        expect((err as Error).message).toContain("not-a-thing");
                }
        });
});

describe("warnIfProductionMisconfigured", () => {
        it("warns when NODE_ENV=production and TRUST_PROXY is unset", () => {
                const logger = { warn: vi.fn() };
                warnIfProductionMisconfigured(undefined, "production", logger);
                expect(logger.warn).toHaveBeenCalledOnce();
                expect(logger.warn.mock.calls[0][0]).toMatch(/TRUST_PROXY is unset/);
        });

        it("warns when NODE_ENV=production and TRUST_PROXY is whitespace-only", () => {
                // Common manifestation in k8s / docker-compose when a secret
                // is defined but unset — the value surfaces as "" or "   ".
                const logger = { warn: vi.fn() };
                warnIfProductionMisconfigured("   ", "production", logger);
                expect(logger.warn).toHaveBeenCalledOnce();
        });

        it("stays quiet when NODE_ENV is anything other than production", () => {
                const logger = { warn: vi.fn() };
                warnIfProductionMisconfigured(undefined, "development", logger);
                warnIfProductionMisconfigured(undefined, "test", logger);
                warnIfProductionMisconfigured(undefined, undefined, logger);
                expect(logger.warn).not.toHaveBeenCalled();
        });

        it("stays quiet when TRUST_PROXY is set in production", () => {
                // We don't re-validate here — that's parseTrustProxy's job.
                // The warning is strictly about the "unset" case.
                const logger = { warn: vi.fn() };
                warnIfProductionMisconfigured("1", "production", logger);
                warnIfProductionMisconfigured("loopback", "production", logger);
                warnIfProductionMisconfigured("false", "production", logger);
                expect(logger.warn).not.toHaveBeenCalled();
        });
});
