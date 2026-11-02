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

// ── P1-C / P1-B: a session whose row has no container_id may still own a
// container (a spawn whose D1 write failed; a pre-fail-closed teardown
// that nulled the id on a daemon error). kill() must look it up by its
// deterministic name, prove it is THIS session's (the workspace bind),
// and never read a daemon failure as "nothing there".
const WORKSPACE_ROOT_FOR_TESTS = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";

function makeDmByRef(
	sessions: SessionManager,
	byRef: Record<string, FakeContainer | (() => never)>,
): { dm: DockerManager; getContainer: ReturnType<typeof vi.fn> } {
	const dm = new DockerManager(sessions);
	const getContainer = vi.fn((ref: string) => {
		const c = byRef[ref];
		if (typeof c === "function") return c();
		if (!c) throw new Error(`test: unexpected getContainer(${ref})`);
		return c;
	});
	(dm as unknown as { docker: unknown }).docker = { getContainer };
	return { dm, getContainer };
}

describe("DockerManager.kill() with container_id = NULL — lookup by name with identity (P1-C/P1-B)", () => {
	it("finds the session's container by its deterministic name, validates the workspace bind, removes it", async () => {
		const { sessions, spies } = makeSessions(null);
		const owned = makeContainer({
			inspect: vi.fn(async () => ({
				Id: "c-by-name",
				State: { Running: true },
				HostConfig: { Binds: [`${WORKSPACE_ROOT_FOR_TESTS}/s1:/home/developer/workspace`] },
			})),
		});
		const { dm } = makeDmByRef(sessions, { "st-s1": owned, "c-by-name": owned });
		await expect(dm.kill("s1")).resolves.toBeUndefined();
		expect(owned.remove).toHaveBeenCalledTimes(1);
		// The row already says NULL: nothing to write.
		expect(spies.setContainerId).not.toHaveBeenCalled();
	});

	it("a container holding the name but mounting ANOTHER workspace is not ours: left alone", async () => {
		const { sessions } = makeSessions(null);
		const foreign = makeContainer({
			inspect: vi.fn(async () => ({
				Id: "c-foreign",
				State: { Running: true },
				HostConfig: {
					Binds: [`${WORKSPACE_ROOT_FOR_TESTS}/other-session:/home/developer/workspace`],
				},
			})),
		});
		const { dm } = makeDmByRef(sessions, { "st-s1": foreign, "c-foreign": foreign });
		await expect(dm.kill("s1")).resolves.toBeUndefined();
		expect(foreign.stop).not.toHaveBeenCalled();
		expect(foreign.remove).not.toHaveBeenCalled();
	});

	it("the name answers 404: nothing to tear down, kill completes", async () => {
		const { sessions } = makeSessions(null);
		const gone = makeContainer({
			inspect: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const { dm } = makeDmByRef(sessions, { "st-s1": gone });
		await expect(dm.kill("s1")).resolves.toBeUndefined();
		expect(gone.remove).not.toHaveBeenCalled();
	});

	it("daemon unreachable during the lookup: kill rejects — absence is never assumed", async () => {
		const { sessions } = makeSessions(null);
		const down = makeContainer({
			inspect: vi.fn(async () => {
				throw socketError("ECONNREFUSED");
			}),
		});
		const { dm } = makeDmByRef(sessions, { "st-s1": down });
		await expect(dm.kill("s1")).rejects.toThrow(/ECONNREFUSED/);
	});

	it("the stored id is gone (404) but the name holds the session's container: that one is removed too", async () => {
		const { sessions, spies } = makeSessions("c-stale");
		const stale = makeContainer({
			stop: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
			remove: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const live = makeContainer({
			inspect: vi.fn(async () => ({
				Id: "c-live",
				State: { Running: true },
				HostConfig: { Binds: [`${WORKSPACE_ROOT_FOR_TESTS}/s1:/home/developer/workspace`] },
			})),
		});
		const { dm } = makeDmByRef(sessions, { "c-stale": stale, "st-s1": live, "c-live": live });
		await expect(dm.kill("s1")).resolves.toBeUndefined();
		expect(live.remove).toHaveBeenCalledTimes(1);
		expect(spies.setContainerId).toHaveBeenCalledWith("s1", null);
	});
});

// ── P2 (3rd review): stopContainer() with no usable container_id must still
// find the session's live container by name (identity-checked), stop it
// WITHOUT removing it, keep the row referencing it, and never read a daemon
// failure as "nothing to stop".
describe("DockerManager.stopContainer() with container_id NULL or stale (P2)", () => {
	function owned(id: string): FakeContainer {
		return makeContainer({
			inspect: vi.fn(async () => ({
				Id: id,
				State: { Running: true },
				HostConfig: { Binds: [`${WORKSPACE_ROOT_FOR_TESTS}/s1:/home/developer/workspace`] },
			})),
		});
	}

	it("container_id NULL, own container running under the name: it is stopped, kept, and the row now references it", async () => {
		const { sessions, spies } = makeSessions(null);
		const live = owned("c-live");
		const { dm } = makeDmByRef(sessions, { "st-s1": live, "c-live": live });
		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		expect(live.stop).toHaveBeenCalledTimes(1);
		expect(live.remove).not.toHaveBeenCalled();
		expect(spies.setContainerId).toHaveBeenCalledWith("s1", "c-live");
		expect(spies.updateStatus).toHaveBeenCalledWith("s1", "stopped");
		expect(spies.recordContainerGone).not.toHaveBeenCalled();
	});

	it("stale container_id (404), own container running under the name: stopped, kept, row re-pointed — not marked gone", async () => {
		const { sessions, spies } = makeSessions("c-stale");
		const stale = makeContainer({
			stop: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const live = owned("c-live");
		const { dm } = makeDmByRef(sessions, { "c-stale": stale, "st-s1": live, "c-live": live });
		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		expect(live.stop).toHaveBeenCalledTimes(1);
		expect(live.remove).not.toHaveBeenCalled();
		expect(spies.recordContainerGone).not.toHaveBeenCalled();
		expect(spies.setContainerId).toHaveBeenCalledWith("s1", "c-live");
		expect(spies.updateStatus).toHaveBeenCalledWith("s1", "stopped");
	});

	it("truly absent (stale id 404 AND name 404): recorded gone, consistently", async () => {
		const { sessions, spies } = makeSessions("c-stale");
		const stale = makeContainer({
			stop: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const none = makeContainer({
			inspect: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const { dm } = makeDmByRef(sessions, { "c-stale": stale, "st-s1": none });
		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		expect(spies.recordContainerGone).toHaveBeenCalledWith("s1");
		expect(spies.updateStatus).not.toHaveBeenCalledWith("s1", "stopped");
	});

	it("container_id NULL and the name answers 404: recorded gone (stopped + NULL), not a bare status write", async () => {
		const { sessions, spies } = makeSessions(null);
		const none = makeContainer({
			inspect: vi.fn(async () => {
				throw dockerHttpError(404, "no such container");
			}),
		});
		const { dm } = makeDmByRef(sessions, { "st-s1": none });
		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		expect(spies.recordContainerGone).toHaveBeenCalledWith("s1");
	});

	it("daemon unreachable during the name lookup: rejects, status untouched, mappings untouched", async () => {
		const { sessions, spies } = makeSessions(null);
		const down = makeContainer({
			inspect: vi.fn(async () => {
				throw socketError("ECONNREFUSED");
			}),
		});
		const { dm } = makeDmByRef(sessions, { "st-s1": down });
		await expect(dm.stopContainer("s1")).rejects.toThrow(/ECONNREFUSED/);
		expect(spies.updateStatus).not.toHaveBeenCalled();
		expect(spies.recordContainerGone).not.toHaveBeenCalled();
		expect(portMappingDeletes()).toBe(0);
	});

	it("the name is held by a container with ANOTHER session's bind: left alone, our row recorded gone", async () => {
		const { sessions, spies } = makeSessions(null);
		const foreign = makeContainer({
			inspect: vi.fn(async () => ({
				Id: "c-foreign",
				State: { Running: true },
				HostConfig: { Binds: [`${WORKSPACE_ROOT_FOR_TESTS}/other:/home/developer/workspace`] },
			})),
		});
		const { dm } = makeDmByRef(sessions, { "st-s1": foreign, "c-foreign": foreign });
		await expect(dm.stopContainer("s1")).resolves.toBeUndefined();
		expect(foreign.stop).not.toHaveBeenCalled();
		expect(foreign.remove).not.toHaveBeenCalled();
		expect(spies.recordContainerGone).toHaveBeenCalledWith("s1");
	});
});
