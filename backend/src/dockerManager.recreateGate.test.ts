/**
 * dockerManager.recreateGate.test.ts — DockerManager's side of the 3.0d
 * `recreate-unresolved` gate (CONVERSATION.md §2.7.4): `reconcile` leaves
 * an unresolved session alone (fail-closed when the check itself fails),
 * and a hard delete's purge removes the session's control dir — which it
 * only reaches once the lifecycle gate let the delete through.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	// DockerManager reads WORKSPACE_ROOT at module load.
	const root = `${process.env.TMPDIR ?? "/tmp"}/st-dm-gate-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = root;
	return { root };
});
const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [] as unknown[], meta: { changes: 0 } })),
}));
vi.mock("./db.js", () => dbStubs);

import { DockerManager } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function makeSessions(): SessionManager {
	return {
		updateStatus: vi.fn(async () => undefined),
		recordContainerGone: vi.fn(async () => undefined),
		setContainerId: vi.fn(async () => undefined),
	} as unknown as SessionManager;
}

function makeDm(running: boolean) {
	const sessions = makeSessions();
	const dm = new DockerManager(sessions);
	const inspect = vi.fn(async () => ({ State: { Running: running }, HostConfig: {} }));
	(dm as unknown as { docker: unknown }).docker = { getContainer: vi.fn(() => ({ inspect })) };
	return { dm, sessions, inspect };
}

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue({ results: [], meta: { changes: 0 } });
});
afterAll(async () => {
	await fs.rm(env.root, { recursive: true, force: true });
});

describe("DockerManager.reconcile and recreate-unresolved", () => {
	function oneRunningRow() {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ session_id: SID, container_id: "cid-o" }],
			meta: { changes: 0 },
		});
	}

	it("an unresolved session is skipped: no status flip, no container inspection", async () => {
		const { dm, sessions, inspect } = makeDm(false);
		dm.setRecreateUnresolvedCheck(async () => true);
		oneRunningRow();
		await dm.reconcile();
		expect(inspect).not.toHaveBeenCalled();
		expect(sessions.updateStatus).not.toHaveBeenCalled();
		expect(sessions.recordContainerGone).not.toHaveBeenCalled();
	});

	it("a failing check counts as unresolved (fail-closed)", async () => {
		const { dm, sessions, inspect } = makeDm(false);
		dm.setRecreateUnresolvedCheck(async () => {
			throw new Error("EIO");
		});
		oneRunningRow();
		await dm.reconcile();
		expect(inspect).not.toHaveBeenCalled();
		expect(sessions.updateStatus).not.toHaveBeenCalled();
	});

	it("a resolved session is reconciled as before", async () => {
		const { dm, sessions } = makeDm(false);
		dm.setRecreateUnresolvedCheck(async () => false);
		oneRunningRow();
		await dm.reconcile();
		expect(sessions.updateStatus).toHaveBeenCalledWith(SID, "stopped");
	});
});

describe("DockerManager.purgeWorkspace and the control dir", () => {
	it("hard delete removes <WORKSPACE_ROOT>/.st-control/<sid> with the workspace", async () => {
		const control = path.join(env.root, ".st-control", SID);
		await fs.mkdir(control, { recursive: true });
		await fs.writeFile(path.join(control, "recreate-attempt.json"), "{}");
		await fs.mkdir(path.join(env.root, SID), { recursive: true });
		const { dm } = makeDm(false);
		await dm.purgeWorkspace(SID);
		await expect(fs.stat(control)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(env.root, SID))).rejects.toMatchObject({ code: "ENOENT" });
		// Other sessions' control dirs are untouched.
		const other = path.join(env.root, ".st-control", "11111111-1111-4111-8111-111111111111");
		await fs.mkdir(other, { recursive: true });
		await dm.purgeWorkspace(SID);
		expect((await fs.stat(other)).isDirectory()).toBe(true);
	});
});
