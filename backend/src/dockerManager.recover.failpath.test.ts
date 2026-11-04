/**
 * Recovery of a session's own stopped container when the row's id is
 * NULL or stale (4th review of #502): stop must not report success unless
 * the recovered identity is persisted; /start must reuse that container
 * (never remove it for its name — its writable layer is data); a daemon
 * error during recovery means neither destruction nor respawn; a foreign
 * container holding the name is neither adopted nor removed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

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

// Image pins (imagePins.ts) have their own tests (imagePins.test.ts,
// dockerManager.imagePins.test.ts); this file's Docker fake has no image API,
// so the strict pin is stood in by an identity resolve and a passing check.
vi.mock("./imagePins.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./imagePins.js")>()),
	ensurePinned: vi.fn(async (_d: unknown, ref: string) => ref),
	verifyCreated: vi.fn(async () => undefined),
}));

import { DockerManager } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

const ROOT = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";

function dockerHttpError(statusCode: number, reason: string): Error {
	const e = new Error(`(HTTP code ${statusCode}) ${reason}`) as Error & { statusCode: number };
	e.statusCode = statusCode;
	return e;
}
function socketError(code: string): Error {
	const e = new Error(`connect ${code} /var/run/docker.sock`) as NodeJS.ErrnoException;
	e.code = code;
	return e;
}

function makeSessions(containerId: string | null) {
	const meta = {
		sessionId: "s1",
		userId: "u1",
		name: "test",
		status: "running" as const,
		containerId,
		containerName: "st-s1",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
	};
	const spies = {
		get: vi.fn(async () => meta),
		getOrThrow: vi.fn(async () => meta),
		updateStatus: vi.fn(async () => undefined),
		setContainerId: vi.fn(async () => undefined),
		recordContainerGone: vi.fn(async () => undefined),
	};
	return { sessions: spies as unknown as SessionManager, spies, meta };
}

interface Fake {
	id: string;
	stop: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
	inspect: ReturnType<typeof vi.fn>;
}

function fake(id: string, over: Partial<Fake> = {}): Fake {
	return {
		id,
		stop: vi.fn(async () => undefined),
		start: vi.fn(async () => undefined),
		remove: vi.fn(async () => undefined),
		inspect: vi.fn(async () => ({
			Id: id,
			State: { Running: false },
			HostConfig: {
				Binds: [`${ROOT}/s1:/home/developer/workspace`],
				CapDrop: ["ALL"],
				SecurityOpt: [],
			},
		})),
		...over,
	};
}

function foreign(id: string): Fake {
	return fake(id, {
		inspect: vi.fn(async () => ({
			Id: id,
			State: { Running: false },
			HostConfig: {
				Binds: [`${ROOT}/someone-else:/home/developer/workspace`],
				CapDrop: ["ALL"],
				SecurityOpt: [],
			},
		})),
	});
}

function makeDm(
	sessions: SessionManager,
	byRef: Record<string, Fake>,
	createContainer: ReturnType<typeof vi.fn> = vi.fn(async () => {
		throw new Error("test: createContainer must not be called");
	}),
) {
	const dm = new DockerManager(sessions);
	const getContainer = vi.fn((ref: string) => {
		const c = byRef[ref];
		if (!c) throw new Error(`test: unexpected getContainer(${ref})`);
		return c;
	});
	(dm as unknown as { docker: unknown }).docker = { getContainer, createContainer };
	return { dm, getContainer, createContainer };
}

afterEach(() => {
	dbStubs.d1Query.mockClear();
});

describe("stop recovered by name: the identity must be persisted before the stop counts", () => {
	it("Docker confirms the stop but setContainerId fails: rejects, status NOT written, container kept", async () => {
		const { sessions, spies } = makeSessions(null);
		spies.setContainerId.mockRejectedValue(new Error("D1 unavailable"));
		const live = fake("c-live", {
			inspect: vi.fn(async () => ({
				Id: "c-live",
				State: { Running: true },
				HostConfig: { Binds: [`${ROOT}/s1:/home/developer/workspace`] },
			})),
		});
		const { dm } = makeDm(sessions, { "st-s1": live, "c-live": live });
		await expect(dm.stopContainer("s1")).rejects.toThrow();
		expect(live.stop).toHaveBeenCalledTimes(1);
		expect(live.remove).not.toHaveBeenCalled();
		expect(spies.updateStatus).not.toHaveBeenCalled();
		expect(spies.recordContainerGone).not.toHaveBeenCalled();
	});

	it("retry after D1 recovers: 304 on the already-stopped container, identity persisted, status written once", async () => {
		const { sessions, spies } = makeSessions(null);
		spies.setContainerId.mockRejectedValueOnce(new Error("D1 unavailable"));
		const live = fake("c-live", {
			stop: vi
				.fn(async () => undefined)
				.mockImplementationOnce(async () => undefined)
				.mockImplementation(async () => {
					throw dockerHttpError(304, "container already stopped");
				}),
			inspect: vi.fn(async () => ({
				Id: "c-live",
				State: { Running: false },
				HostConfig: { Binds: [`${ROOT}/s1:/home/developer/workspace`] },
			})),
		});
		const { dm } = makeDm(sessions, { "st-s1": live, "c-live": live });
		await expect(dm.stopContainer("s1")).rejects.toThrow(/D1 unavailable/);
		expect(spies.updateStatus).not.toHaveBeenCalled();
		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		expect(spies.setContainerId).toHaveBeenLastCalledWith("s1", "c-live");
		expect(spies.updateStatus).toHaveBeenCalledTimes(1);
		expect(spies.updateStatus).toHaveBeenCalledWith("s1", "stopped");
		expect(live.remove).not.toHaveBeenCalled();
	});
});

describe("/start recovers the session's own stopped container by name — never removes it", () => {
	it("container_id NULL: the stopped container under the name is adopted and started; no create, no remove", async () => {
		const { sessions, spies } = makeSessions(null);
		const stopped = fake("c-stopped");
		const { dm, createContainer } = makeDm(sessions, { "st-s1": stopped, "c-stopped": stopped });
		await expect(dm.startContainer("s1")).resolves.toBeUndefined();
		expect(stopped.start).toHaveBeenCalledTimes(1);
		expect(stopped.remove).not.toHaveBeenCalled();
		expect(createContainer).not.toHaveBeenCalled();
		expect(spies.setContainerId).toHaveBeenCalledWith("s1", "c-stopped");
		expect(spies.updateStatus).toHaveBeenCalledWith("s1", "running");
	});

	it("stale container_id (404) with the session's container under the name: adopted and started; no create, no remove", async () => {
		const { sessions, spies } = makeSessions("c-stale");
		const stale = fake("c-stale", {
			inspect: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const stopped = fake("c-stopped");
		const { dm, createContainer } = makeDm(sessions, {
			"c-stale": stale,
			"st-s1": stopped,
			"c-stopped": stopped,
		});
		await expect(dm.startContainer("s1")).resolves.toBeUndefined();
		expect(stopped.start).toHaveBeenCalledTimes(1);
		expect(stopped.remove).not.toHaveBeenCalled();
		expect(createContainer).not.toHaveBeenCalled();
		expect(spies.setContainerId).toHaveBeenCalledWith("s1", "c-stopped");
		expect(spies.setContainerId).not.toHaveBeenCalledWith("s1", null);
	});

	it("daemon error during the recovery lookup (NULL id): rejects; nothing created, removed or started", async () => {
		const { sessions, spies } = makeSessions(null);
		const down = fake("x", {
			inspect: vi.fn(async () => {
				throw socketError("ECONNREFUSED");
			}),
		});
		const { dm, createContainer } = makeDm(sessions, { "st-s1": down });
		await expect(dm.startContainer("s1")).rejects.toThrow(/ECONNREFUSED/);
		expect(createContainer).not.toHaveBeenCalled();
		expect(down.remove).not.toHaveBeenCalled();
		expect(down.start).not.toHaveBeenCalled();
		expect(spies.updateStatus).not.toHaveBeenCalled();
	});

	it("daemon error inspecting the stored id: rejects instead of respawning over it", async () => {
		const { sessions, spies } = makeSessions("c-1");
		const c1 = fake("c-1", {
			inspect: vi.fn(async () => {
				throw socketError("ECONNREFUSED");
			}),
		});
		const { dm, createContainer } = makeDm(sessions, { "c-1": c1 });
		await expect(dm.startContainer("s1")).rejects.toThrow(/ECONNREFUSED/);
		expect(createContainer).not.toHaveBeenCalled();
		expect(spies.setContainerId).not.toHaveBeenCalledWith("s1", null);
		expect(c1.remove).not.toHaveBeenCalled();
	});

	it("a foreign container holds the name: not adopted, not removed; the create's 409 surfaces", async () => {
		const { sessions } = makeSessions(null);
		const other = foreign("c-other");
		const createContainer = vi.fn(async () => {
			throw dockerHttpError(409, `Conflict. The container name "/st-s1" is already in use`);
		});
		const { dm } = makeDm(sessions, { "st-s1": other, "c-other": other }, createContainer);
		await expect(dm.startContainer("s1")).rejects.toThrow(/409|in use|not this session/);
		expect(other.start).not.toHaveBeenCalled();
		expect(other.remove).not.toHaveBeenCalled();
	});

	it("the recovered identity cannot be persisted: rejects before starting anything", async () => {
		const { sessions, spies } = makeSessions(null);
		spies.setContainerId.mockRejectedValue(new Error("D1 unavailable"));
		const stopped = fake("c-stopped");
		const { dm, createContainer } = makeDm(sessions, { "st-s1": stopped, "c-stopped": stopped });
		await expect(dm.startContainer("s1")).rejects.toThrow(/D1 unavailable/);
		expect(stopped.start).not.toHaveBeenCalled();
		expect(stopped.remove).not.toHaveBeenCalled();
		expect(createContainer).not.toHaveBeenCalled();
	});
});
