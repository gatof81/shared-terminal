/**
 * dockerManager.purge.test.ts — a hard delete's `purgeWorkspace` removes
 * everything of the session under WORKSPACE_ROOT (workspace, uploads, and
 * the dirs the removed conversation capture / recreation left: event log,
 * control dir, hooks file), never another session's, never outside the root.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	// DockerManager reads WORKSPACE_ROOT at module load.
	const root = `${process.env.TMPDIR ?? "/tmp"}/st-dm-purge-${process.pid}-${Date.now()}`;
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

function makeDm() {
	const dm = new DockerManager(makeSessions());
	return { dm };
}

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue({ results: [], meta: { changes: 0 } });
});
afterAll(async () => {
	await fs.rm(env.root, { recursive: true, force: true });
});

describe("DockerManager.purgeWorkspace", () => {
	const DIRS = (sid: string) => [
		path.join(env.root, sid),
		path.join(env.root, ".uploads", sid),
		path.join(env.root, ".conversations", sid),
		path.join(env.root, ".st-control", sid),
		path.join(env.root, ".claude-managed", sid),
	];

	it("hard delete removes the workspace, uploads and the leftover capture/control dirs of that session only", async () => {
		const OTHER = "11111111-1111-4111-8111-111111111111";
		for (const d of [...DIRS(SID), ...DIRS(OTHER)]) {
			await fs.mkdir(d, { recursive: true });
			await fs.writeFile(path.join(d, "f"), "x");
		}
		const { dm } = makeDm();
		await dm.purgeWorkspace(SID);
		for (const d of DIRS(SID)) {
			await expect(fs.stat(d)).rejects.toMatchObject({ code: "ENOENT" });
		}
		for (const d of DIRS(OTHER)) expect((await fs.stat(d)).isDirectory()).toBe(true);
		// Idempotent: nothing left to remove is not an error.
		await dm.purgeWorkspace(SID);
	});

	it("refuses an id that resolves outside the root before removing anything", async () => {
		const outside = path.join(path.dirname(env.root), `st-dm-purge-outside-${process.pid}`);
		await fs.mkdir(outside, { recursive: true });
		const { dm } = makeDm();
		await expect(dm.purgeWorkspace(`../${path.basename(outside)}`)).rejects.toThrow(
			/refusing to purge outside root/,
		);
		expect((await fs.stat(outside)).isDirectory()).toBe(true);
		await fs.rm(outside, { recursive: true, force: true });
	});
});
