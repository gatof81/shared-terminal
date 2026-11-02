/**
 * dockerManager.failpath.test.ts — DIAGNOSTIC evidence for the audit of
 * `kill()` (H2) and `stopContainer()` (H3) against main 2ea5700.
 *
 * Pins the fail-closed behaviour the two teardown verbs SHOULD have:
 * a legitimate "already gone / already stopped" Docker answer (404, 304)
 * completes the teardown, while a daemon failure (socket ECONNREFUSED /
 * EACCES, HTTP 500, ambiguous 409) must NOT write the D1 state that
 * claims the teardown happened (container_id → NULL, status → stopped),
 * because the container may still be running. A retry once the daemon
 * is healthy must converge.
 *
 * Cases tagged `[passes today]` are regression guards for the legitimate
 * paths; the rest FAIL on main — that is the evidence.
 *
 * Harness mirrors dockerManager.test.ts: `./db.js` is stubbed so
 * `clearPortMappings` is observable through `d1Query`, the Dockerode
 * instance is swapped for a fake before any method runs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [] as unknown[], meta: { changes: 0 } })),
}));
vi.mock("./db.js", () => dbStubs);

import { DockerManager } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

// ── Error shapes (docker-modem) ─────────────────────────────────────────────
// An HTTP answer outside the accepted set → Error with `statusCode` +
// `reason` (modem.js buildPayload). A socket failure → the Node error
// itself (`code`, `syscall`), NO statusCode.

function dockerHttpError(statusCode: number, reason: string): Error {
	const e = new Error(`(HTTP code ${statusCode}) ${reason}`) as Error & {
		statusCode: number;
		reason: string;
	};
	e.statusCode = statusCode;
	e.reason = reason;
	return e;
}

function socketError(code: string): Error {
	const e = new Error(`connect ${code} /var/run/docker.sock`) as NodeJS.ErrnoException;
	e.code = code;
	e.syscall = "connect";
	return e;
}

// ── Fakes ───────────────────────────────────────────────────────────────────

function makeSessions(containerId: string | null = "c-1") {
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
	return { sessions: spies as unknown as SessionManager, spies };
}

interface FakeContainer {
	stop: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
	inspect: ReturnType<typeof vi.fn>;
}

function makeContainer(over: Partial<FakeContainer> = {}): FakeContainer {
	return {
		stop: vi.fn(async () => undefined),
		remove: vi.fn(async () => undefined),
		inspect: vi.fn(async () => ({ Id: "c-1", State: { Running: true }, HostConfig: {} })),
		...over,
	};
}

function makeDm(sessions: SessionManager, container: FakeContainer): DockerManager {
	const dm = new DockerManager(sessions);
	(dm as unknown as { docker: unknown }).docker = {
		getContainer: vi.fn(() => container),
	};
	return dm;
}

function portMappingDeletes(): number {
	return dbStubs.d1Query.mock.calls.filter((c) =>
		String((c as unknown[])[0]).includes("DELETE FROM sessions_port_mappings"),
	).length;
}

afterEach(() => {
	dbStubs.d1Query.mockClear();
});

// ── kill() (H2) ─────────────────────────────────────────────────────────────

describe("DockerManager.kill() — Docker failure vs genuinely gone (H2)", () => {
	it("[passes today] 404 on stop AND remove is 'already gone': nulls container_id and clears mappings", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			stop: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
			remove: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.kill("s1")).resolves.toBeUndefined();
		expect(spies.setContainerId).toHaveBeenCalledWith("s1", null);
		expect(portMappingDeletes()).toBe(1);
	});

	it("[passes today] 304 on stop (already stopped) + successful remove completes the teardown", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			stop: vi.fn(async () => {
				throw dockerHttpError(304, "container already stopped");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.kill("s1")).resolves.toBeUndefined();
		expect(container.remove).toHaveBeenCalledTimes(1);
		expect(spies.setContainerId).toHaveBeenCalledWith("s1", null);
	});

	it("daemon unreachable (ECONNREFUSED on stop and remove): rejects and KEEPS container_id", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			stop: vi.fn(async () => {
				throw socketError("ECONNREFUSED");
			}),
			remove: vi.fn(async () => {
				throw socketError("ECONNREFUSED");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.kill("s1")).rejects.toThrow();
		// The container was never confirmed gone — its id is the only
		// handle the next /start, reconcile or operator has.
		expect(spies.setContainerId).not.toHaveBeenCalled();
	});

	it("remove answers HTTP 500 (daemon error): rejects and KEEPS container_id", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			remove: vi.fn(async () => {
				throw dockerHttpError(500, "server error");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.kill("s1")).rejects.toThrow();
		expect(spies.setContainerId).not.toHaveBeenCalled();
	});

	it("socket EACCES (backend lost access to the docker socket): rejects and KEEPS container_id", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			stop: vi.fn(async () => {
				throw socketError("EACCES");
			}),
			remove: vi.fn(async () => {
				throw socketError("EACCES");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.kill("s1")).rejects.toThrow();
		expect(spies.setContainerId).not.toHaveBeenCalled();
	});

	it("remove answers 409 (removal in progress) while inspect still finds the container: does not null container_id", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			remove: vi.fn(async () => {
				throw dockerHttpError(409, "removal of container c-1 is already in progress");
			}),
		});
		const dm = makeDm(sessions, container);

		await dm.kill("s1").catch(() => undefined);
		// 409 is ambiguous: only a confirmed 404 (inspect) may drop the id.
		expect(spies.setContainerId).not.toHaveBeenCalled();
	});

	it("convergence: a kill that failed on an unreachable daemon succeeds when retried against a healthy one", async () => {
		const { sessions, spies } = makeSessions();
		let healthy = false;
		const container = makeContainer({
			stop: vi.fn(async () => {
				if (!healthy) throw socketError("ECONNREFUSED");
			}),
			remove: vi.fn(async () => {
				if (!healthy) throw socketError("ECONNREFUSED");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.kill("s1")).rejects.toThrow();
		expect(spies.setContainerId).not.toHaveBeenCalled();

		healthy = true;
		await expect(dm.kill("s1")).resolves.toBeUndefined();
		expect(spies.setContainerId).toHaveBeenCalledTimes(1);
		expect(spies.setContainerId).toHaveBeenCalledWith("s1", null);
	});
});

// ── stopContainer() (H3) ────────────────────────────────────────────────────

describe("DockerManager.stopContainer() — Docker failure vs already stopped (H3)", () => {
	it("[passes today] 304 (already stopped) lands status=stopped", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			stop: vi.fn(async () => {
				throw dockerHttpError(304, "container already stopped");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		expect(spies.updateStatus).toHaveBeenCalledWith("s1", "stopped");
		expect(portMappingDeletes()).toBe(1);
	});

	it("[passes today] 404 (container gone) still lands the session as not running", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			stop: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		const stopped = spies.updateStatus.mock.calls.some((c) => (c as unknown[])[1] === "stopped");
		expect(stopped || spies.recordContainerGone.mock.calls.length > 0).toBe(true);
	});

	it("daemon unreachable (ECONNREFUSED): rejects, status stays running, mappings untouched", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			stop: vi.fn(async () => {
				throw socketError("ECONNREFUSED");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.stopContainer("s1")).rejects.toThrow();
		// The container is (as far as anyone knows) still running: D1 must
		// keep saying so, otherwise the idle sweeper, quotas, reconcile and
		// the dispatcher all lose sight of a live container.
		expect(spies.updateStatus).not.toHaveBeenCalledWith("s1", "stopped");
		expect(portMappingDeletes()).toBe(0);
	});

	it("HTTP 500 from stop: rejects, status stays running, mappings untouched", async () => {
		const { sessions, spies } = makeSessions();
		const container = makeContainer({
			stop: vi.fn(async () => {
				throw dockerHttpError(500, "server error");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.stopContainer("s1")).rejects.toThrow();
		expect(spies.updateStatus).not.toHaveBeenCalledWith("s1", "stopped");
		expect(portMappingDeletes()).toBe(0);
	});

	it("convergence: a stop that failed on an unreachable daemon succeeds when retried", async () => {
		const { sessions, spies } = makeSessions();
		let healthy = false;
		const container = makeContainer({
			stop: vi.fn(async () => {
				if (!healthy) throw socketError("ECONNREFUSED");
			}),
		});
		const dm = makeDm(sessions, container);

		await expect(dm.stopContainer("s1")).rejects.toThrow();
		expect(spies.updateStatus).not.toHaveBeenCalled();

		healthy = true;
		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		expect(spies.updateStatus).toHaveBeenCalledTimes(1);
		expect(spies.updateStatus).toHaveBeenCalledWith("s1", "stopped");
	});
});
