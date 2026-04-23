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

export class EnvVarValidationError extends Error {
        constructor(message: string) {
                super(message);
                this.name = "EnvVarValidationError";
        }
}

/**
 * Validate and normalise an envVars payload.
 *
 * Accepts `undefined` (treated as an empty map) so route handlers can pass
 * the raw body field without a null-coalesce at every call site.
 *
 * Returns a plain `Record<string, string>` stripped of any inherited /
 * non-enumerable properties — callers can safely JSON-stringify or iterate
 * without worrying about prototype pollution from user input.
 */
export function validateEnvVars(
        envVars: unknown,
): Record<string, string> {
        if (envVars === undefined || envVars === null) return {};

        // Must be a plain object. Arrays and other exotics pass `typeof === "object"`
        // but would iterate in surprising ways; refuse up front.
        if (typeof envVars !== "object" || Array.isArray(envVars)) {
                throw new EnvVarValidationError("envVars must be an object");
        }

        // Use Object.entries so we only see the object's own enumerable string-keyed
        // properties — not anything from the prototype chain. This also matches the
        // iteration order we'd get from JSON.parse output.
        const entries = Object.entries(envVars as Record<string, unknown>);

        if (entries.length > MAX_ENV_VAR_COUNT) {
                throw new EnvVarValidationError(
                        `envVars may not contain more than ${MAX_ENV_VAR_COUNT} entries (got ${entries.length})`,
                );
        }

        const normalised: Record<string, string> = Object.create(null);
        for (const [name, value] of entries) {
                if (typeof name !== "string" || name.length === 0) {
                        throw new EnvVarValidationError("envVars keys must be non-empty strings");
                }
                if (name.length > MAX_ENV_VAR_NAME_LENGTH) {
                        throw new EnvVarValidationError(
                                `envVars key '${name.slice(0, 32)}…' exceeds ${MAX_ENV_VAR_NAME_LENGTH} characters`,
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
