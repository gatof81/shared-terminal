/**
 * projects/conversation/writerLock.ts against the real util-linux flock
 * (PROJECT_CONVERSATION.md §2.1, T22b): one holder at a time, released when
 * the helper goes away, and the loss is reported.
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWriterLock, FLOCK_PATH } from "./writerLock.js";

const haveFlock = existsSync(FLOCK_PATH);
let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-wlock-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!haveFlock)("acquireWriterLock (real flock)", () => {
	it("T22b: a second holder is refused; after release the next one gets it", async () => {
		const p = path.join(dir, ".writer.lock");
		const a = await acquireWriterLock(p);
		expect(a.ok).toBe(true);
		const b = await acquireWriterLock(p);
		expect(b).toMatchObject({ ok: false, reason: "busy" });
		if (a.ok) a.lock.release();
		// the helper exits on EOF; the kernel releases the lock with it
		let c = await acquireWriterLock(p);
		for (let i = 0; i < 20 && !c.ok; i++) {
			await new Promise((r) => setTimeout(r, 50));
			c = await acquireWriterLock(p);
		}
		expect(c.ok).toBe(true);
		if (c.ok) c.lock.release();
	});

	it("T22c: the helper dying is reported as a loss, and the lock is free again", async () => {
		const p = path.join(dir, ".writer.lock");
		let child: import("node:child_process").ChildProcess | undefined;
		const { spawn } = await import("node:child_process");
		const r = await acquireWriterLock(p, {
			spawn: (cmd, args) => {
				child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
				return child;
			},
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const lost = new Promise<void>((resolve) => r.lock.onLost(resolve));
		child?.kill("SIGKILL");
		await lost;
		expect(r.lock.held()).toBe(false);
		// With --close the lock dies with flock itself: free at once (a short
		// retry only absorbs the exit being reported before the kernel unlock).
		let again = await acquireWriterLock(p);
		for (let i = 0; i < 10 && !again.ok; i++) {
			await new Promise((res) => setTimeout(res, 20));
			again = await acquireWriterLock(p);
		}
		expect(again.ok).toBe(true);
		if (again.ok) again.lock.release();
	});
});

describe("acquireWriterLock without flock", () => {
	it("a missing binary is no-flock, never a held lock", async () => {
		const r = await acquireWriterLock(path.join(dir, "l"), { flockPath: "/nonexistent/flock" });
		expect(r).toMatchObject({ ok: false, reason: "no-flock" });
	});
});
