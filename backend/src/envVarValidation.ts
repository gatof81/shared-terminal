/**
 * envVarValidation.ts — input validation for session environment variables.
 *
 * The POST /sessions and PATCH /sessions/:id/env routes accept an
 * `envVars: Record<string, string>` payload which is handed untouched to the
 * Docker API as a container's `Env` array. Without validation, callers could:
 *   - supply a key containing `=` or whitespace (splits oddly inside the
 *     container, silently mangling neighbouring variables);
 *   - smuggle NUL bytes into a value (terminates the C-string early, truncating
 *     the actual value the container sees);
 *   - submit thousands of entries or a multi-megabyte JSON blob that will sit
 *     in D1 and be echoed on every subsequent session read.
 *
 * The validator is intentionally shell-agnostic — Docker passes `Env[]`
 * directly to `execve`, not through a shell — so we are not concerned with
 * metacharacter escaping. The rules enforce shape, size, and structural
 * sanity only.
 */

// Maximum number of distinct env vars a session may declare. Comfortably above
// the ~15 a realistic devcontainer uses; a tripwire rather than a product
// limit. Raise if a legitimate workflow needs more.
export const MAX_ENV_VAR_COUNT = 64;

// Per-name and per-value length caps. Name cap mirrors the conservative end
// of what shells accept (the POSIX minimum NAME_MAX is 255, but env names in
// practice are short). Value cap is generous enough for a connection string
// or inline JSON but refuses a multi-kB blob.
export const MAX_ENV_VAR_NAME_LENGTH = 128;
export const MAX_ENV_VAR_VALUE_LENGTH = 4096;

// Belt-and-suspenders cap on the serialised JSON payload. 64 entries ×
// (128 + 4096) ≈ 270 KiB upper bound; 64 KiB is ~16× the realistic
// full-configuration case. Prevents a malicious client from submitting
// every entry at the per-field cap to inflate the D1 row.
export const MAX_ENV_VARS_TOTAL_BYTES = 64 * 1024;

// POSIX-portable env var name: initial letter or underscore, then letters,
// digits, or underscores. Explicitly rejects `=`, whitespace, dashes, dots,
// and any non-ASCII. Matches the shape `execve` / bash / dash all accept.
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Denylist of env var names that would hijack dynamic linking, command
// resolution, interpreter/runtime behaviour, or identity. In a single-
// tenant full-shell session these are NOT a privilege-escalation vector
// — the user can `export` any of them inside their shell anyway — so
// the rule is about transparency, not isolation:
//
//   - Baking `LD_PRELOAD=/some/lib.so`, `NODE_OPTIONS=--require ...`,
//     or `JAVA_TOOL_OPTIONS=-javaagent:...` into the container env
//     means every process spawned inside the session (including
//     entrypoint scripts, hooks, and anything the user didn't type
//     themselves) inherits the hook silently. node, python, java, etc.
//     all honour these env vars at interpreter startup.
//   - A session's declared envVars are user-visible in the UI; what
//     lands inside the container should match. Letting PATH/HOME/etc.
//     through would let a caller create a session whose shell starts
//     with a config the session metadata doesn't obviously reveal.
//
// This is a blocklist, not an allowlist — novel interpreter injection
// knobs (future node/python releases) may sneak through until they're
// added here. The round-2 reviewer flagged that rightly. The trade-off
// (strictness vs not breaking legitimate workflows that set e.g.
// DATABASE_URL) favours enumerating well-known knobs; if the threat
// model ever shifts to multi-tenant, this should flip to an allowlist.
//
// Result: what you PUT in the session body matches what the shell
// SEES at startup, with no silent linker/interpreter hooks for the
// known injection surfaces.
const DENIED_ENV_VAR_NAMES = new Set([
        // Identity / shell config
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",

        // Node.js — NODE_OPTIONS accepts --require/--import which runs
        // arbitrary JS at every `node` invocation. NODE_PATH changes the
        // module resolver and would let an env set shadow stdlib requires.
        "NODE_OPTIONS",
        "NODE_PATH",

        // Python — PYTHONSTARTUP runs a file at REPL startup;
        // PYTHONINSPECT drops into a REPL after script exit (side-channel
        // for persistent code exec); PYTHONBREAKPOINT routes breakpoint()
        // through an arbitrary callable; PYTHONPATH changes module
        // resolution; PYTHONHOME relocates the interpreter stdlib.
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "PYTHONINSPECT",
        "PYTHONHOME",
        "PYTHONBREAKPOINT",

        // JVM — _JAVA_OPTIONS / JAVA_TOOL_OPTIONS / JDK_JAVA_OPTIONS are
        // all honoured by the launcher and can `-javaagent:` arbitrary
        // JARs or flip security-relevant flags.
        "JAVA_TOOL_OPTIONS",
        "_JAVA_OPTIONS",
        "JDK_JAVA_OPTIONS",

        // Ruby — RUBYOPT prepends arbitrary flags (incl. `-r<file>`)
        // to every `ruby` invocation; RUBYLIB extends $LOAD_PATH.
        "RUBYOPT",
        "RUBYLIB",

        // Perl — PERL5OPT is the Perl analogue of RUBYOPT; PERL5LIB
        // extends @INC.
        "PERL5OPT",
        "PERL5LIB",
]);

// Prefix matches for categories that grow over time (new LD_* / DYLD_*
// vars are added across linker releases; enumerating them is a moving
// target).
//   - LD_*  : glibc dynamic-linker surface on Linux (LD_PRELOAD,
//             LD_LIBRARY_PATH, LD_AUDIT, LD_DEBUG, LD_ORIGIN_PATH, …).
//   - DYLD_*: the macOS counterpart (DYLD_INSERT_LIBRARIES,
//             DYLD_LIBRARY_PATH, …). Our runtime is Linux, but the
//             session image is pulled in dev on macOS too and a user
//             might paste a DYLD_* value from habit; block it so the
//             rejection is a clear 400 rather than a "silently ignored
//             on Linux" surprise.
const DENIED_ENV_VAR_PREFIXES = ["LD_", "DYLD_"];

// Prototype-pollution vector names that pass the POSIX-identifier
// regex and would interact oddly with JS object semantics if used as
// keys. `__proto__` is the critical one: on a regular object,
// `obj["__proto__"] = "string"` invokes the Object.prototype setter
// (no-op for non-object values, silently dropping the entry) — which
// means a user-supplied `__proto__` env var either gets swallowed or
// pollutes the prototype chain depending on how downstream code
// constructs its maps. Rejecting at validation time gives the caller
// a clear 400 instead of either of those confusing outcomes, and lets
// the validator return a plain {} (no null-prototype footgun).
// `constructor` and `prototype` aren't as dangerous but are included
// for defensiveness — they're never legitimate env var names.
const PROTOTYPE_POLLUTION_NAMES = new Set(["__proto__", "constructor", "prototype"]);


export class EnvVarValidationError extends Error {
        constructor(message: string) {
                super(message);
                this.name = "EnvVarValidationError";
        }
}

/**
 * Validate and normalise an envVars payload.
 *
 * Accepts `undefined` (treated as an empty map) so the POST /sessions
 * route can pass the raw body field without a null-coalesce at the call
 * site when the field is omitted entirely.
 *
 * Does NOT accept `null`. The two callers have different contracts:
 *   - POST /sessions: envVars is optional. "Not set" is expressed by
 *     omitting the field; the body parser surfaces that as `undefined`.
 *   - PATCH /sessions/:id/env: envVars is REQUIRED (the route rejects
 *     `undefined` with a 400). "Explicitly empty" is expressed by
 *     sending `{}`.
 *
 * In neither case is `null` a meaningful shape — it can only arrive as a
 * client bug (e.g. a frontend that didn't guard a nullable field before
 * serialising). Treating `null` as `{}` on PATCH silently clears the
 * user's env vars instead of surfacing the bug, which is exactly the
 * kind of desync validation should catch. Reject it.
 *
 * Returns a plain `Record<string, string>` containing only the caller-
 * supplied own enumerable keys — no prototype-chain properties, no
 * silently-dropped `__proto__` entries (those are rejected explicitly).
 * Safe to JSON-stringify, iterate, or call Object.prototype methods on.
 */
export function validateEnvVars(
        envVars: unknown,
): Record<string, string> {
        if (envVars === undefined) return {};

        // Must be a plain object. `null` trips this branch (typeof null ===
        // "object") along with arrays and other exotics; refuse all of them
        // up front with the same "must be an object" message. The important
        // case is `null` — accepting it as an empty map would let a PATCH
        // bug silently wipe a user's env instead of 400ing.
        if (envVars === null || typeof envVars !== "object" || Array.isArray(envVars)) {
                throw new EnvVarValidationError("envVars must be an object");
        }

        // Use Object.entries so we only see the object's own enumerable string-keyed
        // properties — not anything from the prototype chain. This also matches the
        // iteration order we'd get from JSON.parse output. `Object.entries` always
        // yields string keys by spec (ES2017 §19.1.2.5), so the loop below doesn't
        // need to re-check `typeof name === "string"`.
        const entries = Object.entries(envVars as Record<string, unknown>);

        if (entries.length > MAX_ENV_VAR_COUNT) {
                throw new EnvVarValidationError(
                        `envVars may not contain more than ${MAX_ENV_VAR_COUNT} entries (got ${entries.length})`,
                );
        }

        // Plain object. Previous versions used Object.create(null) to dodge
        // the edge case where `normalised["__proto__"] = value` would invoke
        // the Object.prototype setter (silently dropping non-object values)
        // — but that traded a security non-issue for a real footgun:
        // callers can't invoke .hasOwnProperty, .toString, etc. directly on
        // the result without a TypeError. Instead we reject `__proto__` et
        // al. at the key-validation step below, which closes the original
        // concern and lets this be a normal object.
        const normalised: Record<string, string> = {};
        for (const [name, value] of entries) {
                if (name.length === 0) {
                        throw new EnvVarValidationError("envVars keys must be non-empty strings");
                }
                if (name.length > MAX_ENV_VAR_NAME_LENGTH) {
                        throw new EnvVarValidationError(
                                `envVars key '${name.slice(0, 32)}…' exceeds ${MAX_ENV_VAR_NAME_LENGTH} characters`,
                        );
                }

                // Reject prototype-pollution vector names BEFORE the POSIX
                // check: `__proto__` (and friends) match the identifier
                // regex, so the POSIX check would accept them. We want a
                // specific error message here so the caller sees *why* this
                // particular name is rejected rather than a generic "not a
                // valid name". Also means the next assignment below can be
                // a plain `normalised[name] = value` without hitting the
                // Object.prototype setter dance.
                if (PROTOTYPE_POLLUTION_NAMES.has(name)) {
                        throw new EnvVarValidationError(
                                `envVars key '${name}' is reserved (conflicts with JS object semantics)`,
                        );
                }

                if (!ENV_VAR_NAME_PATTERN.test(name)) {
                        // Include the offending key in the error so the caller can fix
                        // their payload — it came from them, so there's no leakage.
                        throw new EnvVarValidationError(
                                `envVars key '${name}' is not a valid POSIX env var name ` +
                                `(must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
                        );
                }

                // Apply the denylist AFTER the POSIX-name check: a name that
                // isn't a valid identifier couldn't match anyway, so we'd just
                // be hiding the real problem behind a less-specific error.
                if (
                        DENIED_ENV_VAR_NAMES.has(name) ||
                        DENIED_ENV_VAR_PREFIXES.some((p) => name.startsWith(p))
                ) {
                        throw new EnvVarValidationError(
                                `envVars key '${name}' is reserved and cannot be set via session config. ` +
                                `Set it inside the shell if needed.`,
                        );
                }

                // Reject any form of duplicate (including prototype-chain shadowing,
                // which Object.entries already filters, and plain repeat keys, which
                // JSON.parse collapses — but we check for completeness in case a
                // future caller constructs the object programmatically).
                if (Object.prototype.hasOwnProperty.call(normalised, name)) {
                        throw new EnvVarValidationError(`envVars contains duplicate key '${name}'`);
                }

                if (typeof value !== "string") {
                        throw new EnvVarValidationError(`envVars['${name}'] must be a string (got ${typeof value})`);
                }
                if (value.length > MAX_ENV_VAR_VALUE_LENGTH) {
                        throw new EnvVarValidationError(
                                `envVars['${name}'] exceeds ${MAX_ENV_VAR_VALUE_LENGTH} characters`,
                        );
                }
                // NUL bytes are illegal in environment values on POSIX (execve treats
                // `NUL` as the terminator). Silently accepting them would truncate the
                // value the container sees, so caller sees one thing and container sees
                // another — exactly the kind of desync a validator should catch.
                if (value.includes("\0")) {
                        throw new EnvVarValidationError(`envVars['${name}'] contains a NUL byte`);
                }
                normalised[name] = value;
        }

        // Total-size cap applies to the serialised form since that's what lands in
        // D1 and flows over the network. Using Buffer.byteLength catches multi-byte
        // UTF-8 that string.length would under-count.
        const serialisedBytes = Buffer.byteLength(JSON.stringify(normalised), "utf8");
        if (serialisedBytes > MAX_ENV_VARS_TOTAL_BYTES) {
                throw new EnvVarValidationError(
                        `envVars total size (${serialisedBytes} bytes) exceeds ${MAX_ENV_VARS_TOTAL_BYTES} bytes`,
                );
        }

        return normalised;
}
