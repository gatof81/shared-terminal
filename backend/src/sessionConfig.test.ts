import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock d1Query before importing the module under test so the persistence
// helpers exercise the same code path as production without hitting D1.
const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import {
	getSessionConfig,
	isEmptyConfig,
	persistSessionConfig,
	type SessionConfig,
	SessionConfigSchema,
	SessionConfigValidationError,
	validateSessionConfig,
} from "./sessionConfig.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockImplementation(async () => ({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
});

// ── Schema validation ─────────────────────────────────────────────────────

describe("validateSessionConfig", () => {
	it("returns undefined for an absent config (bare POST compatibility)", () => {
		expect(validateSessionConfig(undefined)).toBeUndefined();
		expect(validateSessionConfig(null)).toBeUndefined();
	});

	it("accepts a fully-populated config and returns the typed shape", () => {
		const raw = {
			workspaceStrategy: "clone",
			cpuLimit: 2_000_000_000,
			memLimit: 4 * 1024 * 1024 * 1024,
			idleTtlSeconds: 3600,
			postCreateCmd: "npm install",
			postStartCmd: "npm run dev",
			repos: [{ url: "https://github.com/example/repo", ref: "main" }],
			ports: [{ port: 3000, protocol: "http" }],
			envVars: [{ name: "FOO", type: "plain", value: "bar" }],
		};
		const got = validateSessionConfig(raw);
		expect(got).toEqual(raw);
	});

	it("accepts an empty config object", () => {
		expect(validateSessionConfig({})).toEqual({});
	});

	it("rejects unknown top-level keys with a precise error path", () => {
		expect(() => validateSessionConfig({ totallyBogusField: 1 })).toThrowError(
			SessionConfigValidationError,
		);
		try {
			validateSessionConfig({ totallyBogusField: 1 });
		} catch (err) {
			// `.strict()` on the schema flags unknown keys; we don't
			// pin the exact Zod message but assert the path includes
			// the offending key so a future Zod upgrade rephrasing
			// the message doesn't break this test.
			expect((err as SessionConfigValidationError).message).toMatch(/totallyBogusField/);
		}
	});

	it("rejects negative cpuLimit", () => {
		expect(() => validateSessionConfig({ cpuLimit: -1 })).toThrowError(
			SessionConfigValidationError,
		);
		try {
			validateSessionConfig({ cpuLimit: -1 });
		} catch (err) {
			expect((err as SessionConfigValidationError).path).toBe("config.cpuLimit");
		}
	});

	it("rejects an absurd memLimit", () => {
		expect(() => validateSessionConfig({ memLimit: Number.MAX_SAFE_INTEGER })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects out-of-range port numbers", () => {
		expect(() => validateSessionConfig({ ports: [{ port: 0 }] })).toThrowError(
			SessionConfigValidationError,
		);
		expect(() => validateSessionConfig({ ports: [{ port: 70000 }] })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects unknown enum values for workspaceStrategy", () => {
		expect(() => validateSessionConfig({ workspaceStrategy: "wipe" })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("caps the number of repos / ports", () => {
		const tooManyRepos = Array.from({ length: 11 }, (_, i) => ({
			url: `https://example.com/r${i}`,
		}));
		expect(() => validateSessionConfig({ repos: tooManyRepos })).toThrowError(
			SessionConfigValidationError,
		);
		const tooManyPorts = Array.from({ length: 21 }, (_, i) => ({ port: 3000 + i }));
		expect(() => validateSessionConfig({ ports: tooManyPorts })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects a postCreateCmd above the size cap", () => {
		expect(() => validateSessionConfig({ postCreateCmd: "x".repeat(8 * 1024 + 1) })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// Empty hook commands are indistinguishable from "no hook configured"
	// once stored — refuse them at ingest so the bootstrap runner in PR
	// 185b can use a presence-only check instead of a truthy check.
	it("rejects an empty postCreateCmd / postStartCmd", () => {
		expect(() => validateSessionConfig({ postCreateCmd: "" })).toThrowError(
			SessionConfigValidationError,
		);
		expect(() => validateSessionConfig({ postStartCmd: "" })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// Same reasoning as the empty-hook rule — stored "" ref would be
	// indistinguishable from "no ref" and would push `git clone --branch ""`
	// into PR 188's consumer.
	it("rejects an empty repo ref", () => {
		expect(() =>
			validateSessionConfig({ repos: [{ url: "https://example.com/r", ref: "" }] }),
		).toThrowError(SessionConfigValidationError);
	});

	// Repo URL scheme allowlist — closes the file:// / ssh:// hole the
	// review bot flagged. PR 188 will read these values straight into a
	// git-clone consumer, so refusing them at ingest is the only place
	// this can be blocked without a duplicate validator downstream.
	it("rejects repo URLs with non-https schemes", () => {
		// Allowlist is https:// only. http:// is rejected because a MITM
		// on the path between the container and the public mirror can
		// inject content which then runs as postCreate/postStart inside
		// the container. ssh:// / git:// / file:// are rejected for the
		// SSRF / arbitrary-path reasons documented on the regex.
		for (const url of [
			"http://example.com/r",
			"file:///etc/passwd",
			"ssh://attacker.example/r",
			"git://attacker.example:9418/r",
			"javascript:alert(1)",
		]) {
			expect(() => validateSessionConfig({ repos: [{ url }] })).toThrowError(
				SessionConfigValidationError,
			);
		}
	});

	it("rejects repo URLs that are not URLs at all", () => {
		expect(() => validateSessionConfig({ repos: [{ url: "just-a-name" }] })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("accepts https:// repo URLs", () => {
		expect(
			validateSessionConfig({
				repos: [{ url: "https://example.com/r" }, { url: "https://github.com/o/p" }],
			}),
		).toBeDefined();
	});

	// envVars contents flow through validateEnvVars per-entry — POSIX
	// name format is also enforced by Zod regex (uppercase only), but
	// the denylist (PATH/LD_*/SESSION_ID/etc.) and NUL-byte rejection
	// fire from the existing `validateEnvVars` routine reused on the
	// new typed-array shape.
	it("rejects config.envVars entries with denylisted names (LD_PRELOAD)", () => {
		expect(() =>
			validateSessionConfig({
				envVars: [{ name: "LD_PRELOAD", type: "plain", value: "/evil.so" }],
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects entry names that fail the uppercase POSIX regex", () => {
		// "BAD-KEY" has a dash and lowercase — fails the Zod regex
		// `/^[A-Z_][A-Z0-9_]*$/` enforced on each entry's name.
		expect(() =>
			validateSessionConfig({ envVars: [{ name: "BAD-KEY", type: "plain", value: "x" }] }),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects entry values containing NUL bytes", () => {
		expect(() =>
			validateSessionConfig({
				envVars: [{ name: "GOOD_NAME", type: "plain", value: "value\0withnul" }],
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects entries exceeding the 64-entry cap", () => {
		const big = Array.from({ length: 65 }, (_, i) => ({
			name: `KEY_${i}`,
			type: "plain" as const,
			value: "v",
		}));
		expect(() => validateSessionConfig({ envVars: big })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// Duplicate-name dedup fires inside validateSessionConfig (not in
	// Zod itself — discriminated unions don't dedup by a shared key).
	it("rejects duplicate entry names", () => {
		expect(() =>
			validateSessionConfig({
				envVars: [
					{ name: "FOO", type: "plain", value: "a" },
					{ name: "FOO", type: "plain", value: "b" },
				],
			}),
		).toThrowError(/duplicate entry name 'FOO'/);
	});

	// `secret-slot` is the template-load wire shape; never valid on
	// POST /sessions because there's no value to persist.
	it("rejects 'secret-slot' entries (template-load only)", () => {
		expect(() =>
			validateSessionConfig({ envVars: [{ name: "FOO", type: "secret-slot" }] }),
		).toThrowError(/secret-slot/);
	});

	it("rejects an empty secret value", () => {
		// Plain values can be empty (POSIX `KEY=`); secret values must
		// have content — an "empty secret" is meaningless and was
		// almost certainly a UX bug at the form layer.
		expect(() =>
			validateSessionConfig({ envVars: [{ name: "FOO", type: "secret", value: "" }] }),
		).toThrowError(SessionConfigValidationError);
	});

	it("attributes envVars validation errors to the config.envVars path", () => {
		try {
			validateSessionConfig({ envVars: [{ name: "PATH", type: "plain", value: "x" }] });
		} catch (err) {
			expect((err as SessionConfigValidationError).path).toBe("config.envVars");
			return;
		}
		throw new Error("expected throw");
	});

	// PR #210 round 1: legacy validateEnvVars enforces 128-char name
	// and 4096-char value caps; the typed path advertises 256 / 16 KiB
	// per the #186 spec. Pin that the typed caps actually take effect
	// (i.e. the targeted checkEnvVarSafety helper isn't re-applying
	// the legacy length limits).
	it("accepts entry names up to 256 chars (typed path cap, not legacy 128)", () => {
		const longName = "A".repeat(256);
		expect(
			validateSessionConfig({
				envVars: [{ name: longName, type: "plain", value: "x" }],
			}),
		).toBeDefined();
	});

	it("accepts entry values up to 16 KiB (typed path cap, not legacy 4096)", () => {
		// 5000 ASCII chars exceeds the legacy 4096 char cap but is
		// well under the typed-path 16 KiB byte cap. Validation must
		// accept; if validateEnvVars's length cap leaks into the
		// typed path again, this trips immediately.
		const fiveK = "x".repeat(5000);
		expect(
			validateSessionConfig({
				envVars: [{ name: "FOO", type: "plain", value: fiveK }],
			}),
		).toBeDefined();
	});

	it("rejects an entry list that exceeds the 256 KiB aggregate ceiling", () => {
		// Each entry: name ~3 chars + ~16 KiB value = ~16 KiB. 17
		// entries lands at ~272 KiB, over the cap. Lower-numbered
		// names so the regex passes (`E0`–`E9`, `EA`–`EG`).
		const entries = Array.from({ length: 17 }, (_, i) => ({
			name: `E${String.fromCharCode(0x41 + i)}`,
			type: "plain" as const,
			value: "x".repeat(16 * 1024),
		}));
		expect(() => validateSessionConfig({ envVars: entries })).toThrowError(/total size .+ exceeds/);
	});

	it("accepts a mixed plain + secret entry list", () => {
		const got = validateSessionConfig({
			envVars: [
				{ name: "FOO", type: "plain", value: "bar" },
				{ name: "API_KEY", type: "secret", value: "sk-test-1234" },
			],
		});
		expect(got?.envVars).toHaveLength(2);
	});
});

// ── isEmptyConfig ─────────────────────────────────────────────────────────

describe("isEmptyConfig", () => {
	it("returns true for an object with no defined fields", () => {
		expect(isEmptyConfig({} as SessionConfig)).toBe(true);
	});

	it("returns false when any field is defined", () => {
		expect(isEmptyConfig({ cpuLimit: 1 })).toBe(false);
		// An empty array is itself a defined value (jsonOrNull will
		// collapse it to NULL on the way to D1, but isEmptyConfig is
		// only the "skip the INSERT entirely" predicate).
		expect(isEmptyConfig({ envVars: [] })).toBe(false);
	});
});

// ── Persistence ──────────────────────────────────────────────────────────

describe("persistSessionConfig", () => {
	it("issues an UPSERT with the right column set", async () => {
		const config: SessionConfig = {
			cpuLimit: 1_000_000_000,
			postCreateCmd: "echo hi",
			repos: [{ url: "https://example.com/r" }],
		};
		await persistSessionConfig("sess-1", config);
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/INSERT INTO session_configs/);
		expect(sql).toMatch(/ON CONFLICT\(session_id\) DO UPDATE/);
		// First param is the session id; structured fields land as their
		// scalar values; sub-records are JSON-serialised; absent fields
		// are passed as NULL so the UPSERT clears them on a re-bind.
		expect(params).toEqual([
			"sess-1",
			null, // workspace_strategy
			1_000_000_000, // cpu_limit
			null, // mem_limit
			null, // idle_ttl_seconds
			"echo hi", // post_create_cmd
			null, // post_start_cmd
			JSON.stringify([{ url: "https://example.com/r" }]),
			null, // ports_json
			null, // env_vars_json
		]);
	});

	// Invariant lock for the `bootstrapped_at` NULL-on-create gate that
	// PR 185b's bootstrap runner depends on. The column is nullable in
	// the DDL with no DEFAULT, and the INSERT column list deliberately
	// omits it — both must stay that way or the one-shot postCreate hook
	// would silently never fire (a data-loss-class regression).
	it("must NOT include bootstrapped_at in the INSERT column list", async () => {
		await persistSessionConfig("sess-bootstrap", { cpuLimit: 1 });
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).not.toMatch(/bootstrapped_at/);
		// Defensive cross-check: the params length must match the column
		// count, so a future caller adding bootstrapped_at to either side
		// without updating the other trips this assertion immediately.
		expect((params as unknown[]).length).toBe(10);
	});

	it("collapses empty array sub-records to NULL (no D1 row bloat)", async () => {
		await persistSessionConfig("sess-empty", {
			repos: [],
			ports: [],
			envVars: [],
		});
		const [, params] = dbStubs.d1Query.mock.calls[0]!;
		// repos_json (param[7]), ports_json (param[8]), env_vars_json (param[9])
		expect(params?.[7]).toBeNull();
		expect(params?.[8]).toBeNull();
		expect(params?.[9]).toBeNull();
	});

	it("serialises envVars + ports JSON columns (storage shape)", async () => {
		await persistSessionConfig("sess-2", {
			ports: [{ port: 3000, protocol: "http" }],
			// Already-encrypted storage shape — the route encrypts
			// before calling persistSessionConfig.
			envVars: [
				{ name: "FOO", type: "plain", value: "bar" },
				{
					name: "API_KEY",
					type: "secret",
					ciphertext: "ZW5jcnlwdGVk",
					iv: "MTIzNDU2Nzg5MDEy",
					tag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
				},
			],
		});
		const [, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(params?.[8]).toBe(JSON.stringify([{ port: 3000, protocol: "http" }]));
		const envJson = JSON.parse(params?.[9] as string) as unknown[];
		expect(envJson).toHaveLength(2);
		expect(envJson[0]).toMatchObject({ name: "FOO", type: "plain", value: "bar" });
		expect(envJson[1]).toMatchObject({
			name: "API_KEY",
			type: "secret",
			ciphertext: "ZW5jcnlwdGVk",
		});
		// Critical: no `value` field on the secret row — only
		// ciphertext + iv + tag. A future serializer mistake that
		// re-introduces plaintext would trip this.
		expect(envJson[1]).not.toHaveProperty("value");
	});
});

describe("getSessionConfig", () => {
	it("returns null when no row exists", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(getSessionConfig("missing")).resolves.toBeNull();
	});

	it("rehydrates a stored row into the typed shape", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-3",
					workspace_strategy: "preserve",
					cpu_limit: 2_000_000_000,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: "npm i",
					post_start_cmd: null,
					repos_json: JSON.stringify([{ url: "https://example.com/r" }]),
					ports_json: null,
					env_vars_json: JSON.stringify([{ name: "FOO", type: "plain", value: "bar" }]),
					bootstrapped_at: "2026-05-08 12:00:00",
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-3");
		expect(got).not.toBeNull();
		expect(got?.workspaceStrategy).toBe("preserve");
		expect(got?.cpuLimit).toBe(2_000_000_000);
		expect(got?.repos).toEqual([{ url: "https://example.com/r" }]);
		expect(got?.envVars).toEqual([{ name: "FOO", type: "plain", value: "bar" }]);
		// D1 returns suffix-less UTC; getter must not interpret as local.
		expect(got?.bootstrappedAt?.toISOString()).toBe("2026-05-08T12:00:00.000Z");
	});

	// PR #210 round 2 fix: `session_configs.env_vars_json` had a
	// pre-typed-shape that wrote `{"FOO":"bar"}` (plain Record). On
	// deploy with existing rows, the new code casted that object to
	// EnvVarEntryStored[] and dropped every env var because objects
	// have no `.length`. Backward-compat shim promotes legacy Records
	// to typed `plain` entries on the fly.
	// PR #210 round 3 fix: a hand-crafted D1 row that snuck a
	// `secret-slot` entry into storage, or a `secret` entry missing
	// ciphertext/iv/tag, must NOT reach the decrypt path — that
	// would let a write-capable D1 attacker DoS the session by
	// causing every spawn to throw. Filter at rehydration; log +
	// drop the bad entry; keep the good ones.
	it("filters out structurally-invalid array entries (defence against crafted D1 rows)", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-bad-array",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: JSON.stringify([
						// Valid plain — kept.
						{ name: "FOO", type: "plain", value: "bar" },
						// Valid secret — kept.
						{
							name: "API_KEY",
							type: "secret",
							ciphertext: "Y3Q=",
							iv: "MTIzNDU2Nzg5MDEy",
							tag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
						},
						// secret-slot in storage — must be dropped (the
						// decryptor would crash on the missing fields).
						{ name: "STRAY_SLOT", type: "secret-slot" },
						// Secret missing tag — must be dropped (the GCM
						// auth check would throw on every spawn).
						{ name: "BROKEN_SECRET", type: "secret", ciphertext: "Y3Q=", iv: "x" },
						// Plain missing value — must be dropped.
						{ name: "BROKEN_PLAIN", type: "plain" },
						// Wrong shape (no name) — dropped.
						{ type: "plain", value: "x" },
					]),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-bad-array");
		expect(got?.envVars).toHaveLength(2);
		expect(got?.envVars?.[0]).toMatchObject({ name: "FOO", type: "plain", value: "bar" });
		expect(got?.envVars?.[1]).toMatchObject({ name: "API_KEY", type: "secret" });
	});

	it("rehydrates legacy Record<string,string> env_vars_json into typed plain entries", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-legacy",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					// Pre-typed shape: Record<string,string>.
					env_vars_json: JSON.stringify({ FOO: "bar", BAR: "baz" }),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-legacy");
		expect(got?.envVars).toEqual([
			{ name: "FOO", type: "plain", value: "bar" },
			{ name: "BAR", type: "plain", value: "baz" },
		]);
	});

	it("skips non-string values in legacy Record env_vars_json without throwing", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-mixed",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: JSON.stringify({ FOO: "bar", BAD: 42 }),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-mixed");
		// FOO survives; BAD (numeric) is logged + skipped rather than
		// crashing the spawn path. Defensive against a future migration
		// that wrote a non-string by mistake.
		expect(got?.envVars).toEqual([{ name: "FOO", type: "plain", value: "bar" }]);
	});

	it("degrades malformed JSON columns to undefined instead of throwing", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-bad-json",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					// All three JSON columns deliberately broken — a direct
					// SQL write or migration corruption is the only way to
					// reach this state, and the row should still be readable.
					repos_json: "{not json",
					ports_json: "[oh no",
					env_vars_json: "definitely not",
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-bad-json");
		expect(got).not.toBeNull();
		expect(got?.repos).toBeUndefined();
		expect(got?.ports).toBeUndefined();
		expect(got?.envVars).toBeUndefined();
	});

	it("treats unknown workspace_strategy values as undefined (defence-in-depth)", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-4",
					workspace_strategy: "weird-future-value",
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: null,
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-4");
		expect(got?.workspaceStrategy).toBeUndefined();
	});
});

// ── Schema export ────────────────────────────────────────────────────────

describe("SessionConfigSchema export", () => {
	it("is reusable for fragment validation in tests / future child issues", () => {
		// Smoke check: parsing through the bare schema (skipping the
		// validateSessionConfig wrapper) yields the same data shape.
		const r = SessionConfigSchema.safeParse({ cpuLimit: 1 });
		expect(r.success).toBe(true);
	});
});
