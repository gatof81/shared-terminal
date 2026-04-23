import { describe, expect, it } from "vitest";
import {
        EnvVarValidationError,
        MAX_ENV_VAR_COUNT,
        MAX_ENV_VAR_NAME_LENGTH,
        MAX_ENV_VAR_VALUE_LENGTH,
        MAX_ENV_VARS_TOTAL_BYTES,
        validateEnvVars,
} from "./envVarValidation.js";

describe("validateEnvVars", () => {
        it("returns an empty object for undefined or empty-object input", () => {
                // `undefined` means the field was omitted from the body (POST
                // /sessions allows that; the route defaults to an empty env).
                // `{}` is the explicit "clear everything" shape used by the
                // PATCH route. `null` is deliberately excluded — see the next
                // test for why.
                expect(validateEnvVars(undefined)).toEqual({});
                expect(validateEnvVars({})).toEqual({});
        });

        it("rejects null so a client bug can't silently wipe env on PATCH", () => {
                // The PATCH /sessions/:id/env handler rejects `undefined`
                // with a 400 ("body.envVars is required") so callers are
                // forced to be explicit. But `null` slips past that check
                // (null !== undefined) — if we collapsed null to {} here,
                // a frontend that forgot to guard a nullable field would
                // silently wipe the user's env vars instead of 400ing.
                // Reject null as invalid shape.
                expect(() => validateEnvVars(null)).toThrow(/must be an object/);
        });

        it("accepts conventional env var shapes", () => {
                const input = {
                        DATABASE_URL: "postgres://localhost/db",
                        _LEADING_UNDERSCORE: "ok",
                        WITH_DIGITS_123: "v1",
                        ONE_CHAR_NAME: "x",
                        A: "minimal",
                };
                // Result should be strictly equal by value (same keys, same values).
                expect(validateEnvVars(input)).toEqual(input);
        });

        it("strips prototype-chain properties", () => {
                // Constructing an object with an inherited property so we can verify
                // the validator only looks at own enumerable keys — a conventional
                // POST body won't carry this, but a malicious client could.
                const parent = { INHERITED: "should-not-appear" };
                const child = Object.create(parent);
                child.OWN = "visible";
                const result = validateEnvVars(child);
                expect(result).toEqual({ OWN: "visible" });
                // Object.hasOwn (ES2022) is biome's preferred form over
                // Object.prototype.hasOwnProperty.call — same semantics, no
                // prototype-chain surprise if the object itself defines a
                // `hasOwnProperty` key. Node 16.9+ ships it; our backend is on
                // Node 20, so unconditionally safe.
                expect(Object.hasOwn(result, "INHERITED")).toBe(false);
        });

        // ── type/shape errors ──────────────────────────────────────────────

        it("rejects non-object inputs", () => {
                expect(() => validateEnvVars("foo")).toThrow(EnvVarValidationError);
                expect(() => validateEnvVars(42)).toThrow(EnvVarValidationError);
                expect(() => validateEnvVars(true)).toThrow(EnvVarValidationError);
                expect(() => validateEnvVars([])).toThrow(EnvVarValidationError);
        });

        it("rejects non-string values", () => {
                expect(() => validateEnvVars({ FOO: 123 })).toThrow(/must be a string/);
                expect(() => validateEnvVars({ FOO: null })).toThrow(/must be a string/);
                expect(() => validateEnvVars({ FOO: { nested: "obj" } })).toThrow(/must be a string/);
        });

        // ── name-shape errors ──────────────────────────────────────────────

        it("rejects keys that start with a digit", () => {
                expect(() => validateEnvVars({ "1FOO": "v" })).toThrow(/not a valid POSIX/);
        });

        it("rejects keys containing '=' or whitespace", () => {
                expect(() => validateEnvVars({ "FOO=BAR": "v" })).toThrow(/not a valid POSIX/);
                expect(() => validateEnvVars({ "FOO BAR": "v" })).toThrow(/not a valid POSIX/);
                expect(() => validateEnvVars({ "FOO\tBAR": "v" })).toThrow(/not a valid POSIX/);
                expect(() => validateEnvVars({ "FOO\nBAR": "v" })).toThrow(/not a valid POSIX/);
        });

        it("rejects keys with dashes, dots, or non-ASCII", () => {
                expect(() => validateEnvVars({ "FOO-BAR": "v" })).toThrow(/not a valid POSIX/);
                expect(() => validateEnvVars({ "FOO.BAR": "v" })).toThrow(/not a valid POSIX/);
                expect(() => validateEnvVars({ "FÖO": "v" })).toThrow(/not a valid POSIX/);
        });

        it("rejects empty-string keys", () => {
                expect(() => validateEnvVars({ "": "v" })).toThrow(/non-empty/);
        });

        // ── length/size caps ───────────────────────────────────────────────

        it("rejects keys longer than MAX_ENV_VAR_NAME_LENGTH", () => {
                const longKey = "A".repeat(MAX_ENV_VAR_NAME_LENGTH + 1);
                expect(() => validateEnvVars({ [longKey]: "v" })).toThrow(
                        new RegExp(`exceeds ${MAX_ENV_VAR_NAME_LENGTH} characters`),
                );
        });

        it("accepts keys exactly at MAX_ENV_VAR_NAME_LENGTH", () => {
                const boundaryKey = "A".repeat(MAX_ENV_VAR_NAME_LENGTH);
                expect(() => validateEnvVars({ [boundaryKey]: "v" })).not.toThrow();
        });

        it("rejects values longer than MAX_ENV_VAR_VALUE_LENGTH", () => {
                const longValue = "x".repeat(MAX_ENV_VAR_VALUE_LENGTH + 1);
                expect(() => validateEnvVars({ FOO: longValue })).toThrow(
                        new RegExp(`exceeds ${MAX_ENV_VAR_VALUE_LENGTH} characters`),
                );
        });

        it("rejects payloads with more than MAX_ENV_VAR_COUNT entries", () => {
                const tooMany: Record<string, string> = {};
                for (let i = 0; i <= MAX_ENV_VAR_COUNT; i++) tooMany[`VAR_${i}`] = "v";
                expect(() => validateEnvVars(tooMany)).toThrow(
                        new RegExp(`not contain more than ${MAX_ENV_VAR_COUNT} entries`),
                );
        });

        it("accepts exactly MAX_ENV_VAR_COUNT entries", () => {
                const maxed: Record<string, string> = {};
                for (let i = 0; i < MAX_ENV_VAR_COUNT; i++) maxed[`VAR_${i}`] = "v";
                expect(() => validateEnvVars(maxed)).not.toThrow();
        });

        it("rejects payloads whose total serialised size exceeds MAX_ENV_VARS_TOTAL_BYTES", () => {
                // Pack values up to the per-value cap and count entries until we clear
                // the total-bytes threshold. Keeps the test honest against the exact
                // constant values without hard-coding sizes.
                const bigValue = "x".repeat(MAX_ENV_VAR_VALUE_LENGTH);
                const bigPayload: Record<string, string> = {};
                let i = 0;
                while (JSON.stringify(bigPayload).length <= MAX_ENV_VARS_TOTAL_BYTES && i < MAX_ENV_VAR_COUNT) {
                        bigPayload[`V_${i}`] = bigValue;
                        i++;
                }
                expect(() => validateEnvVars(bigPayload)).toThrow(/total size/);
        });

        // ── structural / content hazards ───────────────────────────────────

        it("rejects values containing NUL bytes", () => {
                expect(() => validateEnvVars({ FOO: "a\0b" })).toThrow(/NUL byte/);
        });

        it("permits values with newlines and shell metacharacters", () => {
                // Docker passes env directly to execve — no shell parsing — so these
                // are safe to store. Test pins the behaviour so a future validator
                // change doesn't silently break users with multi-line PEM keys etc.
                const result = validateEnvVars({
                        CERT: "-----BEGIN-----\nline2\nline3\n-----END-----",
                        QUOTE_ME: `"double" 'single' $VAR;rm -rf /`,
                });
                expect(result.CERT).toContain("line2");
                expect(result.QUOTE_ME).toContain("rm -rf");
        });

        // ── denylist ───────────────────────────────────────────────────────

        it("rejects reserved names that would hijack the shell's environment", () => {
                // Not a privilege boundary in a single-tenant shell (the user
                // can `export` these anyway), but baking them into the session
                // config would silently affect every process the session
                // spawns. Explicit reject keeps session env transparent.
                expect(() => validateEnvVars({ PATH: "/evil" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ HOME: "/tmp/x" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ USER: "root" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ LOGNAME: "root" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ SHELL: "/bin/sh" })).toThrow(/reserved/);
        });

        it("rejects all LD_* dynamic-linker variables (prefix match)", () => {
                // LD_PRELOAD and friends are the obvious ones; the prefix
                // match also catches less-well-known vectors (LD_AUDIT,
                // LD_DEBUG, LD_ORIGIN_PATH) and future additions we haven't
                // enumerated individually.
                expect(() => validateEnvVars({ LD_PRELOAD: "/x.so" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ LD_LIBRARY_PATH: "/x" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ LD_AUDIT: "/x.so" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ LD_DEBUG: "symbols" })).toThrow(/reserved/);
                // Catch-all: any LD_-prefixed name, even one we don't know
                // about, is rejected. Guards against future linker additions.
                expect(() => validateEnvVars({ LD_MADE_UP_TOMORROW: "x" })).toThrow(/reserved/);
        });

        it("does NOT reject names that merely look similar to reserved ones", () => {
                // The denylist is exact-match on names and prefix-match on
                // LD_*. A user's own `PATHS`, `HOMEBREW_*`, or `LD` (no
                // underscore) aren't linker/identity vectors and must still
                // be allowed.
                const result = validateEnvVars({
                        PATHS: "ok",
                        HOMEBREW_PREFIX: "/opt/homebrew",
                        LD: "not-a-linker-var",
                        MYPATH: "ok",
                        USERLAND: "ok",
                });
                expect(result.PATHS).toBe("ok");
                expect(result.HOMEBREW_PREFIX).toBe("/opt/homebrew");
                expect(result.LD).toBe("not-a-linker-var");
                expect(result.MYPATH).toBe("ok");
                expect(result.USERLAND).toBe("ok");
        });

        it("denylist fires AFTER the POSIX-name check, so garbage keys get the real error", () => {
                // A caller sending 'LD-PRELOAD' (dash, not underscore) should
                // see "not a valid POSIX env var name" — the actual problem —
                // not the less-specific "reserved" message. Preserves error
                // clarity and makes debugging client bugs easier.
                expect(() => validateEnvVars({ "LD-PRELOAD": "x" })).toThrow(/not a valid POSIX/);
        });

        it("rejects interpreter/runtime injection vars (Node, Python, JVM, Ruby, Perl)", () => {
                // Round-2 reviewer noted the denylist's stated goal — "no silent
                // hooks in the shell startup" — was incomplete while NODE_OPTIONS,
                // PYTHONSTARTUP, JAVA_TOOL_OPTIONS, RUBYOPT, PERL5OPT etc. could
                // still slip through. Each of these is honoured by its runtime at
                // interpreter startup and could inject code into every invocation.
                expect(() => validateEnvVars({ NODE_OPTIONS: "--require /evil.js" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ NODE_PATH: "/evil" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ PYTHONPATH: "/evil" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ PYTHONSTARTUP: "/evil.py" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ PYTHONINSPECT: "1" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ PYTHONHOME: "/evil" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ PYTHONBREAKPOINT: "sys.exit" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ JAVA_TOOL_OPTIONS: "-javaagent:/x.jar" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ _JAVA_OPTIONS: "-Dfoo=bar" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ JDK_JAVA_OPTIONS: "-Xmx1g" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ RUBYOPT: "-r/evil" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ RUBYLIB: "/evil" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ PERL5OPT: "-Mevil" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ PERL5LIB: "/evil" })).toThrow(/reserved/);
        });

        it("rejects all DYLD_* dynamic-linker variables (macOS prefix match)", () => {
                // macOS counterpart to LD_*. Our runtime is Linux, but we want a
                // clear 400 rather than a silently-ignored value when somebody
                // pastes a DYLD_* var from habit.
                expect(() => validateEnvVars({ DYLD_INSERT_LIBRARIES: "/x.dylib" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ DYLD_LIBRARY_PATH: "/x" })).toThrow(/reserved/);
                expect(() => validateEnvVars({ DYLD_MADE_UP_TOMORROW: "x" })).toThrow(/reserved/);
        });

        // ── prototype-pollution vector names ──────────────────────────────

        it("rejects __proto__, constructor, prototype with a specific message", () => {
                // These pass the POSIX-identifier regex (all letters/underscores)
                // and so would otherwise be accepted by the POSIX check. Rejecting
                // them explicitly gives the caller a specific error and means the
                // normalised output object can safely be a plain {} without being
                // hit by the Object.prototype setter dance on assignment.
                for (const name of ["__proto__", "constructor", "prototype"]) {
                        expect(() => validateEnvVars({ [name]: "x" })).toThrow(EnvVarValidationError);
                        expect(() => validateEnvVars({ [name]: "x" })).toThrow(/conflicts with JS object semantics/);
                }
        });

        it("returns a plain object — Object.prototype methods work directly on the result", () => {
                // The previous implementation returned an Object.create(null) map,
                // which would TypeError if a future caller did `.hasOwnProperty`,
                // `.toString`, etc. directly. Switched to plain {} now that
                // __proto__ is rejected at validation time; this test pins that
                // direct Object.prototype calls work.
                const result = validateEnvVars({ FOO: "bar" });
                // These would all throw "is not a function" on a null-proto
                // object. The direct `.hasOwnProperty` method call is the
                // exact pattern this test exists to pin — swapping to
                // Object.hasOwn would still pass on a null-proto object
                // (Object.hasOwn doesn't consult the prototype) and so would
                // defeat the purpose. We want to catch the day someone
                // re-introduces Object.create(null) and breaks callers that
                // use the native method form. Hence the biome-ignore on the
                // next line only.
                // biome-ignore lint/suspicious/noPrototypeBuiltins: see comment above — this test intentionally exercises the prototype-method form.
                expect(result.hasOwnProperty("FOO")).toBe(true);
                expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
                expect(typeof result.toString).toBe("function");
        });
});
