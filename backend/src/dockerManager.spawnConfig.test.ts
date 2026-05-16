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

import { buildContainerEnv, DockerManager, mergeEnvForSpawn } from "./dockerManager.js";
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

function makeDmWithCreateCapture(
	// #190 PR 190b — optional `inspectPorts` lets a test seed Docker's
	// post-start `NetworkSettings.Ports` shape so we can assert that
	// `setPortMappings` runs with the kernel-assigned host ports.
	// Default is `{}` (no published ports), which matches today's
	// non-port tests — they exercise the no-config / cpu+mem-only paths
	// where `config?.ports` is undefined and the post-start inspect
	// branch is short-circuited entirely.
	inspectPorts?: Record<string, Array<{ HostIp?: string; HostPort: string }> | null>,
): { dm: DockerManager; captured: CapturedCreate } {
	const captured: CapturedCreate = { opts: {} };
	const dm = new DockerManager(fakeSessions());
	const fakeContainer = {
		id: "container-abc",
		start: vi.fn(async () => {
			/* noop */
		}),
		inspect: vi.fn(async () => ({
			NetworkSettings: { Ports: inspectPorts ?? {} },
		})),
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

// ── buildContainerEnv ────────────────────────────────────────────────────

describe("buildContainerEnv", () => {
	function toMap(env: string[]): Record<string, string> {
		const m: Record<string, string> = {};
		for (const e of env) {
			const eq = e.indexOf("=");
			m[e.slice(0, eq)] = e.slice(eq + 1);
		}
		return m;
	}
	function countOccurrences(env: string[], name: string): number {
		return env.filter((e) => e.startsWith(`${name}=`)).length;
	}

	it("emits SESSION_ID / SESSION_NAME / TERM / COLORTERM when no user env supplied", () => {
		const env = buildContainerEnv("sess-x", "my-session", []);
		const m = toMap(env);
		expect(m.SESSION_ID).toBe("sess-x");
		expect(m.SESSION_NAME).toBe("my-session");
		expect(m.TERM).toBe("xterm-256color");
		expect(m.COLORTERM).toBe("truecolor");
	});

	// Dedupe is the whole point of the helper — duplicates make the
	// effective value depend on which reader resolves it (getenv first-
	// wins vs bash startup last-wins). Asserting one entry per name
	// regardless of input shape locks the invariant.
	it("emits exactly one entry per name, even when defaults overlap with user env", () => {
		const env = buildContainerEnv("sess-x", "my-session", ["TERM=tmux-256color", "FOO=bar"]);
		expect(countOccurrences(env, "TERM")).toBe(1);
		expect(countOccurrences(env, "COLORTERM")).toBe(1);
		expect(countOccurrences(env, "SESSION_ID")).toBe(1);
		expect(countOccurrences(env, "SESSION_NAME")).toBe(1);
		expect(countOccurrences(env, "FOO")).toBe(1);
	});

	// Round-4 fix: user TERM/COLORTERM must be honoured. Previous
	// ordering (hardcoded first, user spread last) made TERM hard-
	// defaulted under getenv first-wins semantics.
	it("user-supplied TERM / COLORTERM beat the hardcoded defaults", () => {
		const env = buildContainerEnv("sess-x", "my-session", [
			"TERM=tmux-256color",
			"COLORTERM=24bit",
		]);
		const m = toMap(env);
		expect(m.TERM).toBe("tmux-256color");
		expect(m.COLORTERM).toBe("24bit");
	});

	// Defence-in-depth: SESSION_ID / SESSION_NAME come after user env in
	// the precedence chain. The denylist already prevents these names
	// from arriving in userEnv, but if a future caller bypasses validation
	// (e.g. a direct D1 write) the infra values still win.
	it("SESSION_ID / SESSION_NAME are immutable from user env", () => {
		const env = buildContainerEnv("sess-x", "my-session", [
			"SESSION_ID=spoofed",
			"SESSION_NAME=other",
		]);
		const m = toMap(env);
		expect(m.SESSION_ID).toBe("sess-x");
		expect(m.SESSION_NAME).toBe("my-session");
	});

	it("skips malformed env entries missing '='", () => {
		// Validators upstream already reject these, but a future regression
		// shouldn't corrupt the Map iteration.
		const env = buildContainerEnv("sess-x", "my-session", ["BAREWORD", "=NOKEY", "FOO=bar"]);
		const m = toMap(env);
		expect(m.FOO).toBe("bar");
		expect(countOccurrences(env, "BAREWORD")).toBe(0);
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
					allow_privileged_ports: null,
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
					allow_privileged_ports: null,
					// Storage shape (#186): typed entry list, plain rows have
					// `{ name, type: "plain", value }`. The route encrypts
					// secret entries before they land here.
					env_vars_json: JSON.stringify([
						{ name: "NEW_KEY", type: "plain", value: "from-config" },
						{ name: "LEGACY_KEY", type: "plain", value: "wins" },
					]),
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

	// PR #210 round 4: previous tests covered only `plain` rows in the
	// stored shape, so the `secret` branch of `decryptStoredEntries`
	// — and the merge of decrypted plaintext into Env — was untested
	// at the spawn layer. Use the real `encryptSecret` primitive to
	// build a stored secret row and assert the plaintext lands in
	// the container Env.
	it("decrypts a secret-typed stored entry and surfaces plaintext in Env", async () => {
		// Set the AES key the secrets module needs. Tests above the
		// `describe` already use the same constant; reset cache to be
		// safe for any test that might run before this one.
		process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString("base64");
		const { _clearKeyCacheForTesting, encryptSecret } = await import("./secrets.js");
		_clearKeyCacheForTesting();
		const blob = encryptSecret("sk-prod-realvalue");
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
					allow_privileged_ports: null,
					env_vars_json: JSON.stringify([
						{
							name: "API_KEY",
							type: "secret",
							ciphertext: blob.ciphertext,
							iv: blob.iv,
							tag: blob.tag,
						},
					]),
					bootstrapped_at: null,
				},
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const { dm, captured } = makeDmWithCreateCapture();
		await dm.spawn("sess-1");
		const env = captured.opts.Env as string[];
		// Plaintext recovered + handed to docker run. Ciphertext or
		// any base64-y string in the Env array would mean the
		// decrypt path didn't fire.
		expect(env).toContain("API_KEY=sk-prod-realvalue");
		expect(env.some((e) => e.includes(blob.ciphertext))).toBe(false);
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
					allow_privileged_ports: null,
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

	// ── #190 PR 190b — port wiring ──────────────────────────────────────

	// Helper builds a session_configs row mock with ports + the
	// privileged-toggle in one call so the per-test mocks stay short.
	function mockConfigRow(opts: {
		ports?: Array<{ container: number; public: boolean }>;
		allowPrivilegedPorts?: boolean;
	}): void {
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
					ports_json: opts.ports ? JSON.stringify(opts.ports) : null,
					allow_privileged_ports: opts.allowPrivilegedPorts ? 1 : null,
					env_vars_json: null,
					bootstrapped_at: null,
				},
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
	}

	it("emits ExposedPorts and PortBindings (HostPort=0) for each declared port", async () => {
		mockConfigRow({
			ports: [
				{ container: 3000, public: false },
				{ container: 5500, public: true },
			],
		});
		const { dm, captured } = makeDmWithCreateCapture({
			"3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }],
			"5500/tcp": [{ HostIp: "0.0.0.0", HostPort: "32769" }],
		});
		await dm.spawn("sess-1");
		expect(captured.opts.ExposedPorts).toEqual({
			"3000/tcp": {},
			"5500/tcp": {},
		});
		const hc = captured.opts.HostConfig as {
			PortBindings: Record<string, Array<{ HostPort: string }>>;
		};
		// HostPort: "0" tells Docker to pick a kernel-assigned ephemeral
		// port at start time. The actual bound port comes back via
		// inspect() and lands in `sessions_port_mappings`.
		expect(hc.PortBindings).toEqual({
			"3000/tcp": [{ HostPort: "0" }],
			"5500/tcp": [{ HostPort: "0" }],
		});
	});

	it("omits ExposedPorts/PortBindings entries when no ports are declared", async () => {
		// Bare-create path (no config row): ExposedPorts and PortBindings
		// must be empty objects, not undefined — Docker's createContainer
		// rejects PortBindings if ExposedPorts is missing for any key,
		// but accepts an empty pair.
		const { dm, captured } = makeDmWithCreateCapture();
		await dm.spawn("sess-1");
		expect(captured.opts.ExposedPorts).toEqual({});
		expect((captured.opts.HostConfig as { PortBindings: object }).PortBindings).toEqual({});
	});

	it("adds CAP_NET_BIND_SERVICE only when allowPrivilegedPorts is true", async () => {
		mockConfigRow({
			ports: [{ container: 80, public: true }],
			allowPrivilegedPorts: true,
		});
		const { dm, captured } = makeDmWithCreateCapture({
			"80/tcp": [{ HostPort: "32768" }],
		});
		await dm.spawn("sess-1");
		const hc = captured.opts.HostConfig as { CapAdd: string[] | undefined };
		expect(hc.CapAdd).toEqual(["NET_BIND_SERVICE"]);
	});

	it("leaves CapAdd undefined when allowPrivilegedPorts is omitted", async () => {
		mockConfigRow({ ports: [{ container: 3000, public: false }] });
		const { dm, captured } = makeDmWithCreateCapture({
			"3000/tcp": [{ HostPort: "32768" }],
		});
		await dm.spawn("sess-1");
		const hc = captured.opts.HostConfig as { CapAdd: string[] | undefined };
		expect(hc.CapAdd).toBeUndefined();
	});

	// CAP_NET_BIND_SERVICE is the ONLY capability we re-grant. A
	// future refactor that accidentally widens CapAdd would defeat
	// the whole point of `CapDrop: ["ALL"]`.
	it("never adds any capability other than NET_BIND_SERVICE", async () => {
		mockConfigRow({
			ports: [{ container: 22, public: false }],
			allowPrivilegedPorts: true,
		});
		const { dm, captured } = makeDmWithCreateCapture({
			"22/tcp": [{ HostPort: "32768" }],
		});
		await dm.spawn("sess-1");
		const hc = captured.opts.HostConfig as { CapAdd: string[] | undefined };
		expect(hc.CapAdd).toEqual(["NET_BIND_SERVICE"]);
		expect(hc.CapAdd?.length).toBe(1);
	});

	it("persists kernel-assigned host ports via setPortMappings after start", async () => {
		mockConfigRow({
			ports: [
				{ container: 3000, public: false },
				{ container: 5500, public: true },
			],
		});
		const { dm } = makeDmWithCreateCapture({
			"3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }],
			"5500/tcp": [{ HostIp: "0.0.0.0", HostPort: "32769" }],
		});
		await dm.spawn("sess-1");
		// `setPortMappings` issues DELETE then one INSERT per mapping.
		// Mock call sequence after the config-read at index 0:
		//   [1] DELETE FROM sessions_port_mappings WHERE session_id = ?
		//   [2] INSERT INTO sessions_port_mappings (..., 3000, 32768)
		//   [3] INSERT INTO sessions_port_mappings (..., 5500, 32769)
		const calls = dbStubs.d1Query.mock.calls;
		const deleteIdx = calls.findIndex((c) =>
			(c[0] as string).match(/DELETE FROM sessions_port_mappings/),
		);
		expect(deleteIdx).toBeGreaterThanOrEqual(0);
		expect(calls[deleteIdx + 1]?.[0]).toMatch(/INSERT INTO sessions_port_mappings/);
		// 4th arg is `is_public` (SQLite boolean idiom): 0 for the
		// private port, 1 for the public one — folded onto the row by
		// `annotateWithPublic` from `config.ports[i].public`.
		expect(calls[deleteIdx + 1]?.[1]).toEqual(["sess-1", 3000, 32768, 0]);
		expect(calls[deleteIdx + 2]?.[1]).toEqual(["sess-1", 5500, 32769, 1]);
	});

	it("does not call setPortMappings when no ports are declared (no DELETE on a clean spawn)", async () => {
		// `config?.ports` is undefined here (no config row at all). The
		// spawn path should skip the inspect+persist branch entirely so
		// a session that never declares ports doesn't even touch the
		// port-mappings table — no row writes, no D1 round-trips.
		const { dm } = makeDmWithCreateCapture();
		await dm.spawn("sess-1");
		const portMappingCalls = dbStubs.d1Query.mock.calls.filter((c) =>
			(c[0] as string).match(/sessions_port_mappings/),
		);
		expect(portMappingCalls).toEqual([]);
	});

	it("logs and continues when inspect() throws after start", async () => {
		mockConfigRow({ ports: [{ container: 3000, public: false }] });
		const { dm } = makeDmWithCreateCapture();
		// Override inspect to throw, simulating a transient daemon
		// hiccup right after start. The container itself is up, so
		// killing it now would cost the user the bootstrap pipeline's
		// progress over a recoverable error. Reconcile() resyncs on
		// the next backend boot.
		const docker = (dm as unknown as { docker: { getContainer: () => unknown } }).docker;
		const fakeContainer = docker.getContainer() as {
			start: ReturnType<typeof vi.fn>;
			inspect: ReturnType<typeof vi.fn>;
		};
		fakeContainer.inspect = vi.fn(async () => {
			throw new Error("daemon unreachable");
		});
		await expect(dm.spawn("sess-1")).resolves.toBeDefined();
	});
});

// ── DockerManager.updateResources (#270) ────────────────────────────────────

describe("DockerManager.updateResources", () => {
	interface CapturedUpdate {
		opts: Record<string, unknown>;
	}

	function makeDmWithUpdateCapture(): { dm: DockerManager; captured: CapturedUpdate } {
		const captured: CapturedUpdate = { opts: {} };
		const dm = new DockerManager(fakeSessions());
		const fakeContainer = {
			update: vi.fn(async (opts: Record<string, unknown>) => {
				captured.opts = opts;
				return undefined;
			}),
		};
		const fakeDocker = {
			getContainer: vi.fn(() => fakeContainer),
		};
		(dm as unknown as { docker: unknown }).docker = fakeDocker;
		return { dm, captured };
	}

	it("forwards NanoCpus when only cpuLimit is set", async () => {
		const { dm, captured } = makeDmWithUpdateCapture();
		await dm.updateResources("c1", { cpuLimit: 1_500_000_000 });
		expect(captured.opts).toEqual({ NanoCpus: 1_500_000_000 });
	});

	it("forwards Memory AND MemorySwap (swap-disabled) when only memLimit is set", async () => {
		const { dm, captured } = makeDmWithUpdateCapture();
		await dm.updateResources("c1", { memLimit: 1024 * 1024 * 1024 });
		// MemorySwap === Memory disables swap (matches the spawn shape).
		expect(captured.opts).toEqual({
			Memory: 1024 * 1024 * 1024,
			MemorySwap: 1024 * 1024 * 1024,
		});
	});

	it("forwards both when both are set", async () => {
		const { dm, captured } = makeDmWithUpdateCapture();
		await dm.updateResources("c1", { cpuLimit: 2_000_000_000, memLimit: 4 * 1024 * 1024 * 1024 });
		expect(captured.opts).toEqual({
			NanoCpus: 2_000_000_000,
			Memory: 4 * 1024 * 1024 * 1024,
			MemorySwap: 4 * 1024 * 1024 * 1024,
		});
	});

	it("propagates the underlying dockerode error so the route can pattern-match", async () => {
		const dm = new DockerManager(fakeSessions());
		const fakeContainer = {
			update: vi.fn(async () => {
				throw new Error("Minimum memory limit lower than current usage");
			}),
		};
		(dm as unknown as { docker: { getContainer: () => unknown } }).docker = {
			getContainer: () => fakeContainer,
		};
		await expect(dm.updateResources("c1", { memLimit: 1024 * 1024 * 1024 })).rejects.toThrow(
			/lower than current/i,
		);
	});
});
