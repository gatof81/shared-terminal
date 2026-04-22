import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateJwtSecret, __resetJwtSecretForTests } from "./auth.js";

// These tests manipulate process.env.{JWT_SECRET, NODE_ENV} and use a
// spy on console.warn. Snapshot + restore each to avoid cross-test leakage.
describe("validateJwtSecret", () => {
	const originalEnv = { ...process.env };
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		delete process.env.JWT_SECRET;
		delete process.env.NODE_ENV;
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { /* swallow */ });
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
