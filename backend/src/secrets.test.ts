/**
 * secrets.test.ts — AES-256-GCM round-trip + boot-validation coverage
 * for #186 PR 186a.
 *
 * The crypto guarantees (confidentiality + integrity via GCM auth
 * tag) are enforced by Node's `crypto` module — these tests are a
 * sanity layer over the wrapper rather than a re-validation of the
 * primitive: they pin the wrapper's contract so a future refactor
 * (e.g. switching to a different IV scheme, or moving the key
 * source) doesn't silently break boot validation, round-trip, or
 * tag-mismatch rejection.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	_clearKeyCacheForTesting,
	decryptSecret,
	type EncryptedSecret,
	encryptSecret,
	secretsEqual,
	validateSecretsKey,
} from "./secrets.js";

// 32 bytes of `0x42` repeated, base64-encoded. Deterministic so the
// boot-validation tests can flip between this, an "almost right"
// 31-byte key, and an absent key.
const VALID_KEY_B64 = Buffer.alloc(32, 0x42).toString("base64");

beforeEach(() => {
	process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY_B64;
	_clearKeyCacheForTesting();
});

afterEach(() => {
	_clearKeyCacheForTesting();
});

// ── Boot validation ──────────────────────────────────────────────────────

describe("validateSecretsKey", () => {
	it("accepts a properly-formatted 32-byte base64 key", () => {
		expect(() => validateSecretsKey()).not.toThrow();
	});

	it("throws when SECRETS_ENCRYPTION_KEY is unset (refuse-to-start)", () => {
		process.env.SECRETS_ENCRYPTION_KEY = "";
		_clearKeyCacheForTesting();
		expect(() => validateSecretsKey()).toThrowError(/SECRETS_ENCRYPTION_KEY/);
	});

	it("throws when the key decodes to the wrong length", () => {
		// 31 bytes — short by one. AES-256 demands exactly 32.
		process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(31, 0x42).toString("base64");
		_clearKeyCacheForTesting();
		expect(() => validateSecretsKey()).toThrowError(/32 bytes/);
	});

	// Boot must fail loudly so an operator who set a partially-bad
	// key (typo, line-wrapped output of `openssl rand`) gets a clear
	// error message rather than a silent-but-broken encryption path.
	// The throw runs from `index.ts` before `server.listen`, so the
	// process exits non-zero and the orchestrator (docker compose,
	// systemd) sees the failure.
	it("throws when the env value is non-base64 garbage", () => {
		// Non-base64 characters that Buffer.from(…, 'base64') silently
		// truncates rather than rejects — the resulting buffer will be
		// the WRONG LENGTH (which is what the validator catches).
		process.env.SECRETS_ENCRYPTION_KEY = "definitely-not-base64-and-too-short";
		_clearKeyCacheForTesting();
		expect(() => validateSecretsKey()).toThrowError(/32 bytes/);
	});
});

// ── Round-trip ──────────────────────────────────────────────────────────

describe("encryptSecret / decryptSecret round-trip", () => {
	it("recovers the original plaintext", () => {
		const blob = encryptSecret("sk-live-abcdef1234567890");
		expect(decryptSecret(blob)).toBe("sk-live-abcdef1234567890");
	});

	it("handles empty strings", () => {
		// Empty values shouldn't be stored as `secret` in practice
		// (POST validation should reject), but the crypto primitive
		// must not silently misbehave on the edge — empty plaintext
		// → empty plaintext, full integrity envelope intact.
		const blob = encryptSecret("");
		expect(decryptSecret(blob)).toBe("");
	});

	it("handles UTF-8 multi-byte content", () => {
		const plaintext = "naïve résumé — π ≈ 3.14 — 🔑";
		const blob = encryptSecret(plaintext);
		expect(decryptSecret(blob)).toBe(plaintext);
	});

	it("emits a fresh IV per encryption (no reuse across calls)", () => {
		// IV reuse on the SAME key in GCM is catastrophic — leaks the
		// XOR of the two plaintexts. Pin that two consecutive
		// encryptSecret calls with the same plaintext produce
		// distinct IVs (and therefore distinct ciphertexts).
		const a = encryptSecret("same plaintext");
		const b = encryptSecret("same plaintext");
		expect(a.iv).not.toBe(b.iv);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	// Reasonable upper bound: per-entry value cap is 16 KiB by the
	// #186 spec. Round-trip the full cap so the wrapper isn't hiding
	// a buffer-size assumption.
	it("handles values up to the 16 KiB cap", () => {
		const big = "x".repeat(16 * 1024);
		const blob = encryptSecret(big);
		expect(decryptSecret(blob)).toBe(big);
	});
});

// ── Tag tampering ────────────────────────────────────────────────────────

describe("decryptSecret integrity", () => {
	it("rejects ciphertext with a flipped auth-tag bit", () => {
		const blob = encryptSecret("payload");
		// Flip the last byte of the tag.
		const tag = Buffer.from(blob.tag, "base64");
		tag[tag.length - 1] ^= 0x01;
		const tampered: EncryptedSecret = { ...blob, tag: tag.toString("base64") };
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it("rejects ciphertext with a flipped IV bit", () => {
		// IV is part of the GCM authentication input; tampering with
		// it must surface as an auth-tag mismatch.
		const blob = encryptSecret("payload");
		const iv = Buffer.from(blob.iv, "base64");
		iv[0] ^= 0x01;
		const tampered: EncryptedSecret = { ...blob, iv: iv.toString("base64") };
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it("rejects ciphertext with a flipped data byte", () => {
		const blob = encryptSecret("payload");
		const ct = Buffer.from(blob.ciphertext, "base64");
		ct[0] ^= 0x01;
		const tampered: EncryptedSecret = { ...blob, ciphertext: ct.toString("base64") };
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it("rejects an IV that's the wrong length", () => {
		const blob = encryptSecret("payload");
		const tampered: EncryptedSecret = { ...blob, iv: Buffer.alloc(8).toString("base64") };
		expect(() => decryptSecret(tampered)).toThrowError(/IV/);
	});

	it("rejects a tag that's the wrong length", () => {
		const blob = encryptSecret("payload");
		const tampered: EncryptedSecret = { ...blob, tag: Buffer.alloc(8).toString("base64") };
		expect(() => decryptSecret(tampered)).toThrowError(/tag/);
	});
});

// ── secretsEqual ─────────────────────────────────────────────────────────

describe("secretsEqual", () => {
	it("returns true for the same ciphertext bytes", () => {
		const blob = encryptSecret("k");
		// Compare the same blob to itself — `secretsEqual` only
		// inspects ciphertext bytes (IVs differ between fresh
		// encrypts of the same plaintext, so equality must NOT be
		// based on plaintext content).
		expect(secretsEqual(blob, blob)).toBe(true);
	});

	it("returns false when ciphertexts differ", () => {
		const a = encryptSecret("k1");
		const b = encryptSecret("k2");
		expect(secretsEqual(a, b)).toBe(false);
	});

	it("returns false when ciphertext lengths differ", () => {
		const a = encryptSecret("short");
		const b = encryptSecret("very long plaintext value");
		expect(secretsEqual(a, b)).toBe(false);
	});
});
