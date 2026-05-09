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
			envVars: { FOO: "bar" },
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

	// Repo URL scheme allowlist — closes the file:// / ssh:// hole the
	// review bot flagged. PR 188 will read these values straight into a
	// git-clone consumer, so refusing them at ingest is the only place
	// this can be blocked without a duplicate validator downstream.
	it("rejects repo URLs with file:// or ssh:// schemes", () => {
		for (const url of ["file:///etc/passwd", "ssh://attacker.example/r", "javascript:alert(1)"]) {
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

	it("accepts https / http / git scheme repo URLs", () => {
		expect(
			validateSessionConfig({
				repos: [
					{ url: "https://example.com/r" },
					{ url: "http://example.com/r" },
					{ url: "git://example.com/r" },
				],
			}),
		).toBeDefined();
	});

	// envVars contents must run through validateEnvVars (POSIX key shape,
	// caps, NUL rejection, denylist) — the Zod record-of-strings is a
	// shape check, not a content check.
	it("rejects config.envVars with denylisted keys (LD_PRELOAD)", () => {
		expect(() => validateSessionConfig({ envVars: { LD_PRELOAD: "/evil.so" } })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects config.envVars with non-POSIX key shapes", () => {
		expect(() => validateSessionConfig({ envVars: { "BAD-KEY": "x" } })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects config.envVars values containing NUL bytes", () => {
		expect(() => validateSessionConfig({ envVars: { GOOD_NAME: "value\0withnul" } })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects config.envVars exceeding the entry-count cap", () => {
		const big: Record<string, string> = {};
		for (let i = 0; i < 65; i++) big[`KEY_${i}`] = "v";
		expect(() => validateSessionConfig({ envVars: big })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("attributes envVars validation errors to the config.envVars path", () => {
		try {
			validateSessionConfig({ envVars: { PATH: "x" } });
		} catch (err) {
			expect((err as SessionConfigValidationError).path).toBe("config.envVars");
			return;
		}
		throw new Error("expected throw");
	});
});

// ── isEmptyConfig ─────────────────────────────────────────────────────────

describe("isEmptyConfig", () => {
	it("returns true for an object with no defined fields", () => {
		expect(isEmptyConfig({} as SessionConfig)).toBe(true);
	});

	it("returns false when any field is defined", () => {
		expect(isEmptyConfig({ cpuLimit: 1 })).toBe(false);
		expect(isEmptyConfig({ envVars: {} })).toBe(false); // the empty object is itself a defined value
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

	it("serialises envVars + ports JSON columns", async () => {
		await persistSessionConfig("sess-2", {
			ports: [{ port: 3000, protocol: "http" }],
			envVars: { FOO: "bar" },
		});
		const [, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(params?.[8]).toBe(JSON.stringify([{ port: 3000, protocol: "http" }]));
		expect(params?.[9]).toBe(JSON.stringify({ FOO: "bar" }));
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
					env_vars_json: JSON.stringify({ FOO: "bar" }),
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
		expect(got?.envVars).toEqual({ FOO: "bar" });
		// D1 returns suffix-less UTC; getter must not interpret as local.
		expect(got?.bootstrappedAt?.toISOString()).toBe("2026-05-08T12:00:00.000Z");
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
