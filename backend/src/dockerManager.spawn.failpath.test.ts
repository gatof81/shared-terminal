/**
 * spawn() fail paths (P1-B): the container Docker actually created must
 * never be left without a reference. Either its id is in D1 before
 * anything can fail after the create, or — when D1 itself refuses the
 * write — the created container is removed by its exact id, fail-closed.
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

function fakeSessions(setContainerId = vi.fn(async () => undefined)) {
	const meta = {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running" as const,
		containerId: null,
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
	};
	const spies = {
		getOrThrow: vi.fn(async () => meta),
		get: vi.fn(async () => meta),
		setContainerId,
	};
	return { sessions: spies as unknown as SessionManager, spies };
}

function makeDm(sessions: SessionManager, container: Record<string, unknown>) {
	const dm = new DockerManager(sessions);
	const createContainer = vi.fn(async () => container);
	(dm as unknown as { docker: unknown }).docker = {
		createContainer,
		getContainer: vi.fn(() => container),
	};
	return { dm, createContainer };
}

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	});
});

describe("spawn(): the created container is always reachable afterwards (P1-B)", () => {
	it("start() fails after create: the created id was persisted first, so kill() can find it", async () => {
		const { sessions, spies } = fakeSessions();
		const container = {
			id: "created-1",
			start: vi.fn(async () => {
				throw dockerHttpError(500, "driver failed programming external connectivity");
			}),
			remove: vi.fn(async () => undefined),
		};
		const { dm } = makeDm(sessions, container);
		await expect(dm.spawn("sess-1")).rejects.toThrow(/driver failed/);
		expect(spies.setContainerId).toHaveBeenCalledWith("sess-1", "created-1");
		const persistedAt =
			spies.setContainerId.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
		const startedAt = container.start.mock.invocationCallOrder[0] ?? 0;
		expect(persistedAt, "the id is in D1 before start() can fail").toBeLessThan(startedAt);
	});

	it("D1 refuses the container_id write: the created container is removed by its exact id, never started", async () => {
		const setContainerId = vi.fn(async () => {
			throw new Error("D1 unavailable (HTTP 503)");
		});
		const { sessions } = fakeSessions(setContainerId);
		const container = {
			id: "created-2",
			start: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
		};
		const { dm } = makeDm(sessions, container);
		const err = await dm.spawn("sess-1").catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		// Generic to the client (POST /sessions echoes the message); the D1
		// words stay in the log.
		expect((err as Error).message).toMatch(/could not be registered; its container was removed/);
		expect((err as Error).message).not.toMatch(/D1 unavailable|503/);
		expect(container.remove).toHaveBeenCalledTimes(1);
		expect(container.remove.mock.calls[0]?.[0]).toMatchObject({ force: true });
		expect(container.start).not.toHaveBeenCalled();
	});

	it("D1 refuses the write AND Docker cannot confirm the removal: spawn rejects with a generic message, details logged", async () => {
		const setContainerId = vi.fn(async () => {
			throw new Error("D1 unavailable (HTTP 503)");
		});
		const { sessions } = fakeSessions(setContainerId);
		const container = {
			id: "created-3",
			start: vi.fn(async () => undefined),
			remove: vi.fn(async () => {
				throw socketError("ECONNREFUSED");
			}),
		};
		const { dm } = makeDm(sessions, container);
		const err = await dm.spawn("sess-1").catch((e: Error) => e);
		expect((err as Error).message).toMatch(/could not be confirmed removed/);
		expect((err as Error).message).not.toMatch(/D1 unavailable|ECONNREFUSED|docker\.sock/);
		expect(container.remove).toHaveBeenCalledTimes(1);
		expect(container.start).not.toHaveBeenCalled();
	});
});
