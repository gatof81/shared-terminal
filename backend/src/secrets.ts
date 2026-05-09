/**
 * secrets.ts — AES-256-GCM encrypt/decrypt for `secret`-typed env-var
 * entries (#186).
 *
 * Threat model the encryption is solving:
 * - **Storage at rest.** D1 dumps and backups should not contain
 *   plaintext API keys / DB URLs / OAuth tokens that the user marked
 *   secret. A compromised D1 export hands an attacker only ciphertext
 *   plus IVs + auth tags; without `SECRETS_ENCRYPTION_KEY` (held in
 *   the backend's env), they cannot recover plaintext.
 * - **Listing endpoints.** Routes that return session metadata
 *   (`GET /api/sessions/:id`) must NEVER serialize ciphertext or
 *   plaintext for secret entries — only `isSet`. Encrypt-on-persist
 *   means the route handler never has plaintext after validation, so
 *   a future serialization mistake can leak ciphertext at worst,
 *   never plaintext.
 * - **Docker run.** The container itself has to receive plaintext
 *   (env vars are passed via `execve`), so decrypt happens INSIDE
 *   `DockerManager` at spawn time and the plaintext lives only in
 *   memory for the duration of the `docker run` call. No log line
 *   echoes the post-decrypt value.
 *
 * What this is NOT solving:
 * - Compromise of the backend process (the key is in env, plaintext
 *   passes through memory at spawn time, the container has the env).
 *   That's a different problem with different mitigations (process
 *   isolation, secrets-management service); not in scope.
 * - Key rotation. If `SECRETS_ENCRYPTION_KEY` changes, every existing
 *   secret entry becomes undecryptable. A future rotation tool is
 *   tracked under #200's deferred work. Operator runbook: #204.
 *
 * Crypto choices:
 * - AES-256-GCM. AEAD — confidentiality + integrity in one mode, no
 *   separate MAC bookkeeping. The auth tag is the only thing standing
 *   between us and a chosen-ciphertext attack so callers MUST persist
 *   it alongside ciphertext + IV.
 * - 96-bit IV (12 bytes), generated fresh per encryption via
 *   `crypto.randomBytes`. NIST SP 800-38D explicitly recommends 96
 *   bits as the GCM IV size; deterministic counter mode is an
 *   alternative but adds state we don't need.
 * - Key delivered as base64-encoded 32 bytes via env var. Validated
 *   at boot — the process refuses to start if the key is missing or
 *   the wrong length.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 32; // AES-256 = 256-bit key
const IV_BYTES = 12; // GCM-recommended 96-bit IV
const TAG_BYTES = 16; // AES-GCM produces a 128-bit auth tag
const ENV_VAR = "SECRETS_ENCRYPTION_KEY";

let cachedKey: Buffer | null = null;

/**
 * Resolve the AES key from the env var. Memoised to avoid re-decoding
 * + re-validating on every encrypt/decrypt call. Cleared by
 * `validateSecretsKey` so tests can swap keys mid-run.
 */
function getKey(): Buffer {
	if (cachedKey) return cachedKey;
	const raw = process.env[ENV_VAR] ?? "";
	if (!raw) {
		throw new Error(
			`${ENV_VAR} is not set; secrets cannot be encrypted/decrypted. ` +
				"Generate one with `openssl rand -base64 32` and set it in your env.",
		);
	}
	let decoded: Buffer;
	try {
		decoded = Buffer.from(raw, "base64");
	} catch (err) {
		throw new Error(`${ENV_VAR} is not valid base64: ${(err as Error).message}`);
	}
	if (decoded.length !== KEY_BYTES) {
		throw new Error(
			`${ENV_VAR} must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length}). ` +
				"Generate one with `openssl rand -base64 32`.",
		);
	}
	cachedKey = decoded;
	return cachedKey;
}

/**
 * Boot-time check called from `index.ts` so the process refuses to
 * start with no / malformed key — same shape as `validateD1Config`
 * + `validateJwtSecret`. Resets the cache so a test setting the env
 * var afterwards is picked up.
 */
export function validateSecretsKey(): void {
	cachedKey = null;
	getKey(); // throws if invalid
}

/**
 * Encrypt a UTF-8 plaintext. Returns base64-encoded ciphertext + IV +
 * auth tag — the three fields stored on a `secret` env-var entry.
 * `randomBytes(IV_BYTES)` is fresh per call, never reused.
 */
export interface EncryptedSecret {
	ciphertext: string; // base64
	iv: string; // base64
	tag: string; // base64
}

export function encryptSecret(plaintext: string): EncryptedSecret {
	const key = getKey();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		ciphertext: ciphertext.toString("base64"),
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
	};
}

/**
 * Decrypt back to UTF-8 plaintext. Throws on auth-tag mismatch
 * (tampered ciphertext / wrong key / corrupted IV) — the GCM mode's
 * integrity check is the only thing that distinguishes valid
 * ciphertext from any random byte string, so the throw must NOT be
 * swallowed by callers.
 */
export function decryptSecret(blob: EncryptedSecret): string {
	const key = getKey();
	const iv = Buffer.from(blob.iv, "base64");
	const tag = Buffer.from(blob.tag, "base64");
	const ciphertext = Buffer.from(blob.ciphertext, "base64");
	if (iv.length !== IV_BYTES) {
		throw new Error(`secret IV must be ${IV_BYTES} bytes (got ${iv.length})`);
	}
	if (tag.length !== TAG_BYTES) {
		throw new Error(`secret tag must be ${TAG_BYTES} bytes (got ${tag.length})`);
	}
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return plaintext.toString("utf-8");
}

/**
 * Constant-time compare two `EncryptedSecret` blobs by ciphertext.
 * Used by the merge path that needs to detect "same secret already
 * stored" without leaking timing on prefix-match. Currently unused
 * in this PR but exported for #195 (templates) which dedups secrets
 * across template loads. Kept here so the timing-safe primitive
 * lives in the crypto module rather than duplicated at call sites.
 */
export function secretsEqual(a: EncryptedSecret, b: EncryptedSecret): boolean {
	const aBuf = Buffer.from(a.ciphertext, "base64");
	const bBuf = Buffer.from(b.ciphertext, "base64");
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}

/** Test-only: clear the memoised key. Public-but-test-only, called
 * from test setup that swaps `SECRETS_ENCRYPTION_KEY` between cases. */
export function _clearKeyCacheForTesting(): void {
	cachedKey = null;
}
