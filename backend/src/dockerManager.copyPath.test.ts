/**
 * dockerManager.copyPath.test.ts — the real `recreatePort().copyPath`
 * (CONVERSATION.md §2.7.7 carry-over) against a mocked dockerode: `mayAct`
 * is asked before the source GET AND again once it answered, so a copy
 * whose attempt lost its authority while the GET was pending never starts
 * the PUT into N, and the source stream is destroyed (its connection freed).
 */
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	// DockerManager reads WORKSPACE_ROOT at module load.
	const root = `${process.env.TMPDIR ?? "/tmp"}/st-dm-copy-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = root;
	return { root };
});
vi.mock("./db.js", () => ({
	d1Query: vi.fn(async () => ({ results: [] as unknown[], meta: { changes: 0 } })),
}));

import { DockerManager } from "./dockerManager.js";
import { deferred } from "./recreate/engine.testutil.js";
import type { SessionManager } from "./sessionManager.js";

afterAll(async () => {
	await fs.rm(env.root, { recursive: true, force: true });
});

function makeDm() {
	const dm = new DockerManager({} as unknown as SessionManager);
	const get = deferred<PassThrough>();
	const getArchive = vi.fn(() => get.promise);
	const putArchive = vi.fn(async (s: PassThrough) => {
		s.resume();
		await new Promise((r) => s.on("end", r));
	});
	(dm as unknown as { docker: unknown }).docker = {
		getContainer: vi.fn((id: string) =>
			id === "O" ? { getArchive } : id === "N" ? { putArchive } : {},
		),
	};
	return { port: dm.recreatePort(), get, getArchive, putArchive };
}

describe("recreatePort().copyPath", () => {
	it("authorization lost while the GET is pending: no putArchive, the source stream is destroyed, the copy throws 'not started'", async () => {
		const { port, get, getArchive, putArchive } = makeDm();
		let authorized = true;
		const p = port.copyPath("O", "/home/developer/.npm", "N", "/home/developer", () => authorized);
		await vi.waitFor(() => expect(getArchive).toHaveBeenCalledTimes(1));
		// The epoch closes (shutdown, T_rec, lease lost) while the GET is out.
		authorized = false;
		const src = new PassThrough();
		get.resolve(src);
		// Without the second check the PUT would consume this and resolve.
		src.end(Buffer.alloc(4));
		await expect(p).rejects.toThrow(/not started/);
		expect(putArchive).not.toHaveBeenCalled();
		expect(src.destroyed).toBe(true);
	});

	it("still authorized after the GET ⇒ the PUT goes out and the bytes are counted", async () => {
		const { port, get, putArchive } = makeDm();
		const p = port.copyPath("O", "/tmp/x", "N", "/tmp", () => true);
		const src = new PassThrough();
		get.resolve(src);
		await vi.waitFor(() => expect(putArchive).toHaveBeenCalledTimes(1));
		src.end(Buffer.alloc(10));
		await expect(p).resolves.toEqual({ bytes: 10 });
	});

	it("not authorized from the start: not even the GET goes out", async () => {
		const { port, getArchive, putArchive } = makeDm();
		await expect(port.copyPath("O", "/tmp/x", "N", "/tmp", () => false)).rejects.toThrow(
			/not started/,
		);
		expect(getArchive).not.toHaveBeenCalled();
		expect(putArchive).not.toHaveBeenCalled();
	});
});
