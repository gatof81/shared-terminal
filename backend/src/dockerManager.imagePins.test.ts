/**
 * dockerManager.imagePins.test.ts — spawn pins the image before the create
 * and the container's actual image after it (imagePins.ts), and a pin that
 * fails never blocks the spawn.
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

import { DockerManager } from "./dockerManager.js";
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

const IMG = `sha256:${"e".repeat(64)}`;

function makeDm(opts: { tagFails?: boolean } = {}) {
	const order: string[] = [];
	const sessions = fakeSessions();
	(sessions.setContainerId as ReturnType<typeof vi.fn>).mockImplementation(async () => {
		order.push("persist");
	});
	const dm = new DockerManager(sessions);
	const fakeContainer = {
		id: "c".repeat(64),
		start: vi.fn(async () => {
			order.push("start");
		}),
		remove: vi.fn(async () => undefined),
		inspect: vi.fn(async () => {
			order.push("inspect container");
			return { Id: "c".repeat(64), Image: IMG, NetworkSettings: { Ports: {} } };
		}),
	};
	const pins = new Set<string>();
	const docker = {
		createContainer: vi.fn(async () => {
			order.push("create");
			return fakeContainer;
		}),
		getContainer: vi.fn(() => fakeContainer),
		getImage: vi.fn((ref: string) => ({
			inspect: async () => {
				if (ref === "shared-terminal-session" || ref === IMG || pins.has(ref))
					return { Id: IMG, RepoTags: [] };
				throw Object.assign(new Error("404"), { statusCode: 404 });
			},
			tag: async ({ repo, tag }: { repo: string; tag: string }) => {
				order.push(`tag ${ref === IMG ? "id" : ref}`);
				if (opts.tagFails) throw new Error("daemon busy");
				pins.add(`${repo}:${tag}`);
			},
		})),
	};
	(dm as unknown as { docker: unknown }).docker = docker;
	return { dm, order, pins, docker };
}

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue({ results: [], success: true, meta: {} });
	delete process.env.SESSION_IMAGE_PINS;
});

describe("spawn pins the session image", () => {
	it("before the create, and the container's own image after it, before start", async () => {
		const { dm, order, pins } = makeDm();
		await dm.spawn("sess-1");
		expect(order).toEqual(["tag id", "create", "persist", "inspect container", "start"]);
		expect([...pins]).toEqual([`shared-terminal-session-pin:${"e".repeat(64)}`]);
	});

	it("a failing pin never blocks the spawn", async () => {
		const { dm, order } = makeDm({ tagFails: true });
		await expect(dm.spawn("sess-1")).resolves.toBe("c".repeat(64));
		expect(order).toContain("create");
		expect(order.at(-1)).toBe("start");
	});

	it("SESSION_IMAGE_PINS=off: no Docker image call at all", async () => {
		process.env.SESSION_IMAGE_PINS = "off";
		const { dm, docker, order } = makeDm();
		await dm.spawn("sess-1");
		expect(docker.getImage).not.toHaveBeenCalled();
		expect(order).toEqual(["create", "persist", "start"]);
	});
});

describe("boot", () => {
	it("reconcile runs the pin pass (recovery after a restart or a crash between create and pin)", async () => {
		const { dm } = makeDm();
		const pass = vi.spyOn(dm, "pinAllSessionImages").mockResolvedValue(undefined);
		await dm.reconcile();
		expect(pass).toHaveBeenCalledTimes(1);
	});
});
