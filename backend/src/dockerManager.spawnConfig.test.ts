/**
 * dockerManager.spawnConfig.test.ts — config-applied spawn tests for #185 (PR 185b1).
 *
 * The existing dockerManager.test.ts harness focuses on the attach + tmux
 * side and never exercises `createContainer`. This file fills the gap:
 * it mocks `Dockerode.createContainer` directly so we can assert the
 * `HostConfig.Memory` / `HostConfig.NanoCpus` and `Env` values that PR
 * 185b1 derives from `session_configs`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

// Stub the fs ops spawn() touches: mkdir creates the bind-mount target,
// chown applies WORKSPACE_UID/GID. In tests the bind-mount path under
// `/var/shared-terminal/workspaces/...` is unwritable; we don't actually
// need a real dir since `createContainer` is mocked too. Keep the
// signatures faithful so the behaviour matches what spawn expects.
vi.mock("node:fs", () => ({
	promises: {
		mkdir: vi.fn(async () => undefined),
		chown: vi.fn(async () => undefined),
		readdir: vi.fn(async () => []),
		stat: vi.fn(async () => ({ size: 0 })),
		lstat: vi.fn(async () => ({ size: 0, isFile: () => false })),
		chmod: vi.fn(async () => undefined),
		rename: vi.fn(async () => undefined),
		unlink: vi.fn(async () => undefined),
		rm: vi.fn(async () => undefined),
	},
}));

import { DockerManager, mergeEnvForSpawn } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

// ── Fakes ────────────────────────────────────────────────────────────────

function fakeSessions(): SessionManager {
	const meta = {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running" as const,
		containerId: null,
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars: { LEGACY_KEY: "legacy" },
		createdAt: new Date(),
		lastConnectedAt: null,
	};
	return {
		getOrThrow: vi.fn(async () => meta),
		get: vi.fn(async () => meta),
		setContainerId: vi.fn(async () => {
			/* noop */
		}),
	} as unknown as SessionManager;
}

interface CapturedCreate {
	opts: Record<string, unknown>;
}

function makeDmWithCreateCapture(): { dm: DockerManager; captured: CapturedCreate } {
	const captured: CapturedCreate = { opts: {} };
	const dm = new DockerManager(fakeSessions());
	const fakeContainer = {
		id: "container-abc",
		start: vi.fn(async () => {
			/* noop */
		}),
	};
	const fakeDocker = {
		createContainer: vi.fn(async (opts: Record<string, unknown>) => {
			captured.opts = opts;
			return fakeContainer;
		}),
		getContainer: vi.fn(() => fakeContainer),
	};
	(dm as unknown as { docker: unknown }).docker = fakeDocker;
	return { dm, captured };
}

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	});
});

// ── mergeEnvForSpawn ─────────────────────────────────────────────────────

describe("mergeEnvForSpawn", () => {
	it("returns the legacy env unchanged when no config envVars are supplied", () => {
		expect(mergeEnvForSpawn({ FOO: "1", BAR: "2" }, undefined).sort()).toEqual(["BAR=2", "FOO=1"]);
	});

	it("returns the config env unchanged when legacy is empty", () => {
		expect(mergeEnvForSpawn({}, { ALPHA: "a" })).toEqual(["ALPHA=a"]);
	});

	it("unions both stores", () => {
		const got = mergeEnvForSpawn({ A: "1" }, { B: "2" });
		expect(got.sort()).toEqual(["A=1", "B=2"]);
	});

	// Round-3 documented decision: union with config-wins on key collision.
	// The user typed an override into the new modal — they expect it to
	// beat whatever is in the legacy store.
	it("config takes precedence on key collisions", () => {
		expect(mergeEnvForSpawn({ DUP: "legacy" }, { DUP: "from-config" })).toEqual([
			"DUP=from-config",
		]);
	});
});

// ── DockerManager.spawn applies session_configs ──────────────────────────

describe("DockerManager.spawn config-applied", () => {
	it("falls back to default Memory/NanoCpus when no session_configs row exists", async () => {
		// `beforeEach` already resets d1Query to return `results: []`, so
		// this test exercises the no-row path without needing a per-test
		// mock override.
		const { dm, captured } = makeDmWithCreateCapture();
		await dm.spawn("sess-1");
		const hc = captured.opts.HostConfig as { Memory: number; NanoCpus: number };
		expect(hc.Memory).toBe(2 * 1024 * 1024 * 1024);
		expect(hc.NanoCpus).toBe(2_000_000_000);
		// Bare-create env path: only the legacy session.envVars + the
		// always-on terminal env. No config env merged in.
		expect(captured.opts.Env).toContain("LEGACY_KEY=legacy");
	});

	it("applies cpu_limit / mem_limit from the session_configs row", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [
				{
					session_id: "sess-1",
					workspace_strategy: null,
					cpu_limit: 4_000_000_000,
					mem_limit: 8 * 1024 * 1024 * 1024,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: null,
					bootstrapped_at: null,
				},
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const { dm, captured } = makeDmWithCreateCapture();
		await dm.spawn("sess-1");
		const hc = captured.opts.HostConfig as { Memory: number; NanoCpus: number };
		expect(hc.Memory).toBe(8 * 1024 * 1024 * 1024);
		expect(hc.NanoCpus).toBe(4_000_000_000);
	});

	// Backend-injected fixed entries (SESSION_ID, SESSION_NAME, TERM,
	// COLORTERM) must survive the merge — SESSION_ID in particular is
	// load-bearing for #191 hook self-identification. The denylist
	// already prevents users from setting SESSION_ID/SESSION_NAME in
	// config; this test guards against an accidental refactor that
	// drops the hardcoded entries entirely.
	it("preserves backend-injected SESSION_ID / SESSION_NAME / TERM / COLORTERM in the final Env", async () => {
		const { dm, captured } = makeDmWithCreateCapture();
		await dm.spawn("sess-1");
		const env = captured.opts.Env as string[];
		expect(env).toContain("SESSION_ID=sess-1");
		expect(env).toContain("SESSION_NAME=test");
		expect(env).toContain("TERM=xterm-256color");
		expect(env).toContain("COLORTERM=truecolor");
	});

	it("merges config.envVars into the docker-run Env (config-wins on collision)", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [
				{
					session_id: "sess-1",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: JSON.stringify({ NEW_KEY: "from-config", LEGACY_KEY: "wins" }),
					bootstrapped_at: null,
				},
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const { dm, captured } = makeDmWithCreateCapture();
		await dm.spawn("sess-1");
		const env = captured.opts.Env as string[];
		expect(env).toContain("NEW_KEY=from-config");
		// Round-3 decision: config-wins on collision. Legacy "legacy"
		// must NOT appear; only the config "wins" value.
		expect(env).toContain("LEGACY_KEY=wins");
		expect(env).not.toContain("LEGACY_KEY=legacy");
	});

	// One field set, the other null: the unset field must fall back to
	// its respective default, NOT to 0 (which would be the value of a
	// `?? 0` typo). Pinning the half-and-half case stops a refactor that
	// loses one of the `?? DEFAULT_*` fallbacks from passing CI.
	it("falls back to default for any cap that is null on the row", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [
				{
					session_id: "sess-1",
					workspace_strategy: null,
					cpu_limit: 4_000_000_000,
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
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const { dm, captured } = makeDmWithCreateCapture();
		await dm.spawn("sess-1");
		const hc = captured.opts.HostConfig as { Memory: number; NanoCpus: number };
		expect(hc.NanoCpus).toBe(4_000_000_000);
		expect(hc.Memory).toBe(2 * 1024 * 1024 * 1024); // default, not 0
	});

	// Availability over correctness for config reads: a transient D1
	// failure shouldn't gate session creation. Logging-only fallback.
	it("falls back to defaults if session_configs read throws", async () => {
		dbStubs.d1Query.mockRejectedValueOnce(new Error("D1 transient"));
		const { dm, captured } = makeDmWithCreateCapture();
		await expect(dm.spawn("sess-1")).resolves.toBeDefined();
		const hc = captured.opts.HostConfig as { Memory: number; NanoCpus: number };
		expect(hc.Memory).toBe(2 * 1024 * 1024 * 1024);
		expect(hc.NanoCpus).toBe(2_000_000_000);
	});
});
