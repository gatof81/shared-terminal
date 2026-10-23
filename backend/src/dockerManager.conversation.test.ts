/**
 * dockerManager.conversation.test.ts — Phase 3 lifecycle wiring
 * (docs/CONVERSATION.md §2.4): with no hooks installed, `createContainer`
 * receives exactly the pre-Phase-3 Env/Binds (behaviour-neutral); with
 * hooks, the token rides Env at infra precedence and the managed dir is
 * bound read-only; stop/kill/purge notify the subsystem and a failing
 * prepare never blocks a spawn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [] as unknown[], success: true as const, meta: {} })),
}));
vi.mock("./db.js", () => dbStubs);

const osStubs = vi.hoisted(() => ({ cpuCount: 64 }));
vi.mock("node:os", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:os")>();
	const cpus = () => new Array(osStubs.cpuCount).fill(real.cpus()[0] ?? {});
	return { ...real, cpus, default: { ...real, cpus } };
});

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

import {
	buildContainerEnv,
	type ConversationLifecycleHooks,
	DockerManager,
} from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

function fakeSessions(
	envVars: Record<string, string> = { ST_INGEST_TOKEN: "user-tries-to-shadow" },
) {
	const meta = {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running" as const,
		containerId: "cid-1",
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars,
		createdAt: new Date(),
		lastConnectedAt: null,
		externalRef: null,
	};
	return {
		getOrThrow: vi.fn(async () => meta),
		get: vi.fn(async () => meta),
		setContainerId: vi.fn(async () => undefined),
		updateStatus: vi.fn(async () => undefined),
	} as unknown as SessionManager;
}

function makeDm(envVars?: Record<string, string>) {
	const captured: { opts: Record<string, unknown> } = { opts: {} };
	const dm = new DockerManager(fakeSessions(envVars));
	const fakeContainer = {
		id: "container-abc",
		start: vi.fn(async () => undefined),
		stop: vi.fn(async () => undefined),
		remove: vi.fn(async () => undefined),
		inspect: vi.fn(async () => ({ NetworkSettings: { Ports: {} } })),
	};
	(dm as unknown as { docker: unknown }).docker = {
		createContainer: vi.fn(async (opts: Record<string, unknown>) => {
			captured.opts = opts;
			return fakeContainer;
		}),
		getContainer: vi.fn(() => fakeContainer),
	};
	return { dm, captured };
}

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue({ results: [], success: true, meta: {} });
});

describe("spawn without conversation hooks", () => {
	it("keeps the pre-Phase-3 Env and Binds exactly", async () => {
		const { dm, captured } = makeDm();
		await dm.spawn("sess-1");
		const hc = captured.opts.HostConfig as { Binds: string[] };
		expect(hc.Binds).toEqual([
			"/var/shared-terminal/workspaces/sess-1:/home/developer/workspace",
			"/var/shared-terminal/workspaces/.uploads/sess-1:/home/developer/uploads:ro",
		]);
		const env = captured.opts.Env as string[];
		expect(env.filter((e) => e.startsWith("ST_INGEST_TOKEN="))).toEqual([
			"ST_INGEST_TOKEN=user-tries-to-shadow",
		]);
	});
});

describe("spawn with conversation hooks", () => {
	it("adds the ro managed bind and the token at infra precedence (user env cannot shadow it)", async () => {
		const { dm, captured } = makeDm();
		const hooks: ConversationLifecycleHooks = {
			prepareSpawn: vi.fn(async () => ({
				env: ["ST_INGEST_TOKEN=deadbeef"],
				binds: [
					"/var/shared-terminal/workspaces/.claude-managed/sess-1:/etc/claude-code/managed-settings.d:ro",
				],
			})),
			onSessionDown: vi.fn(async () => undefined),
			onSessionPurged: vi.fn(async () => undefined),
		};
		dm.setConversationHooks(hooks);
		await dm.spawn("sess-1");
		const hc = captured.opts.HostConfig as { Binds: string[] };
		expect(hc.Binds[2]).toBe(
			"/var/shared-terminal/workspaces/.claude-managed/sess-1:/etc/claude-code/managed-settings.d:ro",
		);
		const env = captured.opts.Env as string[];
		expect(env.filter((e) => e.startsWith("ST_INGEST_TOKEN="))).toEqual([
			"ST_INGEST_TOKEN=deadbeef",
		]);
		expect(hooks.prepareSpawn).toHaveBeenCalledWith("sess-1");
	});
	it("§2.6 a proxy in the session env gets 127.0.0.1 in NO_PROXY only when capture is on", async () => {
		const proxied = { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "internal.example" };
		const off = makeDm(proxied);
		await off.dm.spawn("sess-1");
		const offEnv = off.captured.opts.Env as string[];
		expect(offEnv).toContain("NO_PROXY=internal.example");
		expect(offEnv.some((e) => e.startsWith("no_proxy="))).toBe(false);

		const on = makeDm(proxied);
		on.dm.setConversationHooks({
			prepareSpawn: vi.fn(async () => ({ env: ["ST_INGEST_TOKEN=deadbeef"], binds: [] })),
			onSessionDown: vi.fn(async () => undefined),
			onSessionPurged: vi.fn(async () => undefined),
		});
		await on.dm.spawn("sess-1");
		const onEnv = on.captured.opts.Env as string[];
		expect(onEnv).toContain("NO_PROXY=internal.example,127.0.0.1");
		expect(onEnv).toContain("no_proxy=127.0.0.1");
		expect(onEnv).toContain("HTTPS_PROXY=http://proxy:3128");
	});
	it("a failing prepare logs and spawns without capture", async () => {
		const { dm, captured } = makeDm();
		dm.setConversationHooks({
			prepareSpawn: vi.fn(async () => {
				throw new Error("D1 down");
			}),
			onSessionDown: vi.fn(async () => undefined),
			onSessionPurged: vi.fn(async () => undefined),
		});
		await expect(dm.spawn("sess-1")).resolves.toBe("container-abc");
		expect((captured.opts.HostConfig as { Binds: string[] }).Binds).toHaveLength(2);
	});
	it("stop and kill notify onSessionDown; purge notifies onSessionPurged; failures there never throw", async () => {
		const { dm } = makeDm();
		const hooks: ConversationLifecycleHooks = {
			prepareSpawn: vi.fn(async () => ({ env: [], binds: [] })),
			onSessionDown: vi.fn(async () => {
				throw new Error("boom");
			}),
			onSessionPurged: vi.fn(async () => undefined),
		};
		dm.setConversationHooks(hooks);
		await dm.stopContainer("sess-1");
		await dm.kill("sess-1");
		expect(hooks.onSessionDown).toHaveBeenCalledTimes(2);
		await dm.purgeWorkspace("sess-1");
		expect(hooks.onSessionPurged).toHaveBeenCalledWith("sess-1");
	});
});

describe("buildContainerEnv infra entries", () => {
	it("infra entries override user entries and SESSION_* stay intact", () => {
		const env = buildContainerEnv(
			"sid",
			"name",
			["ST_INGEST_TOKEN=user", "FOO=1"],
			["ST_INGEST_TOKEN=infra"],
		);
		expect(env).toContain("ST_INGEST_TOKEN=infra");
		expect(env).not.toContain("ST_INGEST_TOKEN=user");
		expect(env).toContain("SESSION_ID=sid");
		expect(env.filter((e) => e.startsWith("ST_INGEST_TOKEN=")).length).toBe(1);
	});
});
