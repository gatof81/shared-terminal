/**
 * projects/conversation/writerLock.ts against the real util-linux flock
 * (PROJECT_CONVERSATION.md §2.1, T22b): one holder at a time, released when
 * the helper goes away, and the loss is reported.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, promises as fs, statSync } from "node:fs";
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

describe.skipIf(!haveFlock)("the lock file (§2: 0600)", () => {
	const real = (cmd: string, args: string[]) =>
		nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });

	it("is created 0600 before the helper runs, and an existing 0644 one is narrowed", async () => {
		const p = path.join(dir, ".writer.lock");
		let modeSeen = -1;
		const r = await acquireWriterLock(p, {
			spawn: (cmd, args) => {
				modeSeen = statSync(p).mode & 0o777;
				return real(cmd, args);
			},
		});
		expect(r.ok).toBe(true);
		expect(modeSeen).toBe(0o600);
		if (r.ok) r.lock.release();

		await fs.chmod(p, 0o644);
		let r2 = await acquireWriterLock(p);
		for (let i = 0; i < 20 && !r2.ok; i++) {
			await new Promise((res) => setTimeout(res, 50));
			r2 = await acquireWriterLock(p);
		}
		expect(r2.ok).toBe(true);
		expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
		if (r2.ok) r2.lock.release();
	});

	it("a symlink or a directory at the lock path is refused before any helper runs", async () => {
		const target = path.join(dir, "elsewhere");
		await fs.writeFile(target, "", { mode: 0o644 });
		await fs.chmod(target, 0o644);
		const p = path.join(dir, ".writer.lock");
		await fs.symlink(target, p);
		let spawned = false;
		const spawn = (cmd: string, args: string[]) => {
			spawned = true;
			return real(cmd, args);
		};
		expect(await acquireWriterLock(p, { spawn })).toMatchObject({ ok: false, reason: "error" });
		await fs.rm(p);
		await fs.mkdir(p);
		expect(await acquireWriterLock(p, { spawn })).toMatchObject({ ok: false, reason: "error" });
		expect(spawned).toBe(false);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
	});
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
