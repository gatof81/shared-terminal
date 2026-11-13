/**
 * projects/conversation/store.ts — §2: the directory chain of a project log
 * is re-synced on every open, not only when this process created it. A
 * creation whose parent fsync failed leaves an entry the disk may still lose;
 * finding it on the next open proves nothing about its durability.
 *
 * Own file because it replaces `fsyncDir` module-wide.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_FILE } from "./log.js";
import { projectDir, projectsRoot } from "./paths.js";
import { ProjectConversationStore } from "./store.js";

const synced = vi.hoisted(() => [] as string[]);
vi.mock("../../recreateAttempt.js", async (orig) => {
	const real = await orig<typeof import("../../recreateAttempt.js")>();
	return {
		...real,
		fsyncDir: async (d: string) => {
			synced.push(d);
			await real.fsyncDir(d);
		},
	};
});

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-pstore-dur-"));
	synced.length = 0;
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function start() {
	return ProjectConversationStore.start({
		workspaceRoot: root,
		bootId: "b",
		acquire: async () => ({
			ok: true,
			lock: { held: () => true, onLost: () => {}, release: () => {} },
		}),
	});
}

describe("re-sync of the directory chain on every open", () => {
	it("a reopen of an existing project fsyncs the workspace root, .projects/ and .projects/<pid>/", async () => {
		const first = await start();
		await first.view(PID);
		await first.close();
		await expect(fs.stat(path.join(projectDir(root, PID), LOG_FILE))).resolves.toBeTruthy();

		synced.length = 0;
		const again = await start();
		await again.view(PID);
		await again.close();
		const dirs = synced.map((d) => path.resolve(d));
		expect(dirs).toContain(path.resolve(root)); // holds `.projects/`'s entry
		expect(dirs).toContain(path.resolve(projectsRoot(root))); // holds `<pid>/`'s entry
		expect(dirs).toContain(path.resolve(projectDir(root, PID))); // holds the log's entry
	});
});
