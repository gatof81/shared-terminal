/**
 * projects/conversation/log.ts — PROJECT_CONVERSATION.md §2: fsync before
 * acknowledging, poison on any write error, size check against another
 * writer, whole-batch durability, and the open-time truncation/unverifiable
 * rules.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOG_FILE, ProjectLog, ProjectLogError, parseLog } from "./log.js";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-plog-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const held = { lockHeld: () => true };
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

describe("parseLog", () => {
	const l1 = line({ seq: 1, ev: "message", at: "t", w: "a", bn: 1 });
	const l2 = line({ seq: 2, ev: "delivery", at: "t", w: "a", bn: 0 });
	it("acknowledged batches only: a torn tail and an incomplete last batch are dropped", () => {
		const full = parseLog(Buffer.from(l1 + l2));
		expect("lines" in full && full.lines.length).toBe(2);
		const torn = parseLog(Buffer.from(l1 + l2.slice(0, 10)));
		expect(torn).toMatchObject({ validBytes: 0, tailBytes: l1.length + 10 });
		const half = parseLog(Buffer.from(l1));
		expect(half).toMatchObject({ lines: [], validBytes: 0 });
	});
	it("a bad line in the acknowledged part is unverifiable, never skipped", () => {
		expect(parseLog(Buffer.from(`{nope}\n${l2}`))).toHaveProperty("unverifiable");
		expect(parseLog(Buffer.from(line({ seq: 2, ev: "x", at: "t", w: "a", bn: 0 })))).toHaveProperty(
			"unverifiable",
		);
		// a batch whose countdown breaks: two writers glued together
		const glued =
			line({ seq: 1, ev: "m", at: "t", w: "a", bn: 2 }) +
			line({ seq: 2, ev: "m", at: "t", w: "b", bn: 0 });
		expect(parseLog(Buffer.from(glued))).toHaveProperty("unverifiable");
	});
});

describe("ProjectLog", () => {
	it("assigns contiguous seq, writes one batch, survives reopen", async () => {
		const { log } = await ProjectLog.open(dir, "boot-1", held);
		const a = await log.append([
			{ ev: "message", msg_id: "m1" },
			{ ev: "delivery", msg_id: "m1" },
		]);
		expect(a.map((l) => [l.seq, l.bn, l.w])).toEqual([
			[1, 1, "boot-1"],
			[2, 0, "boot-1"],
		]);
		await log.close();
		const again = await ProjectLog.open(dir, "boot-2", held);
		expect(again.lines.map((l) => l.seq)).toEqual([1, 2]);
		const b = await again.log.append([{ ev: "x" }]);
		expect(b[0]?.seq).toBe(3);
		await again.log.close();
		expect((await fs.stat(path.join(dir, LOG_FILE))).mode & 0o777).toBe(0o600);
	});

	it("T1: a failed fsync is persist-failed and poisons; nothing more is written until reopen", async () => {
		let fail = true;
		const { log } = await ProjectLog.open(dir, "b", {
			...held,
			syncFile: async (fh) => {
				if (fail) throw new Error("EIO");
				await fh.sync();
			},
		});
		await expect(log.append([{ ev: "message" }])).rejects.toMatchObject({ code: "persist-failed" });
		fail = false;
		await expect(log.append([{ ev: "message" }])).rejects.toMatchObject({ code: "persist-failed" });
		expect(log.isPoisoned).toBe(true);
		await log.close();
	});

	it("T22c: bytes appended by someone else poison the writer before it writes", async () => {
		const { log } = await ProjectLog.open(dir, "b", held);
		await log.append([{ ev: "message" }]);
		await fs.appendFile(
			path.join(dir, LOG_FILE),
			line({ seq: 2, ev: "x", at: "t", w: "other", bn: 0 }),
		);
		await expect(log.append([{ ev: "delivery" }])).rejects.toBeInstanceOf(ProjectLogError);
		expect(log.isPoisoned).toBe(true);
		await log.close();
	});

	it("T22c: a lost writer lock poisons before writing", async () => {
		let ok = true;
		const { log } = await ProjectLog.open(dir, "b", { lockHeld: () => ok });
		ok = false;
		await expect(log.append([{ ev: "m" }])).rejects.toMatchObject({ code: "persist-failed" });
		expect((await fs.stat(path.join(dir, LOG_FILE))).size).toBe(0);
		await log.close();
	});

	it("T4b: a torn tail is truncated on open; a bad middle line is unverifiable", async () => {
		const good = line({ seq: 1, ev: "m", at: "t", w: "a", bn: 0 });
		const torn = `{"seq":2,"ev`;
		await fs.writeFile(path.join(dir, LOG_FILE), `${good}${torn}`);
		const r = await ProjectLog.open(dir, "b", held);
		expect(r.truncatedBytes).toBe(torn.length);
		expect((await fs.stat(path.join(dir, LOG_FILE))).size).toBe(good.length);
		await r.log.close();
		await fs.writeFile(path.join(dir, LOG_FILE), `garbage\n${good}`);
		await expect(ProjectLog.open(dir, "b", held)).rejects.toMatchObject({
			code: "project-log-unverifiable",
		});
	});

	it("the cap refuses a new append; the margin lets in-flight work finish", async () => {
		const { log } = await ProjectLog.open(dir, "b", { ...held, maxBytes: 150 });
		await log.append([{ ev: "m", pad: "x".repeat(60) }]);
		await expect(log.append([{ ev: "m", pad: "x".repeat(60) }])).rejects.toMatchObject({
			code: "project-log-full",
		});
		await expect(log.append([{ ev: "d" }], { allowMargin: true })).resolves.toHaveLength(1);
		expect(log.isPoisoned).toBe(false);
		await log.close();
	});

	it("a directory fsync that failed at creation is redone on every reopen before any append", async () => {
		const synced: string[] = [];
		const eio = Object.assign(new Error("EIO"), { code: "EIO" });
		// Creation: the file is made, its directory fsync fails ⇒ open throws.
		await expect(
			ProjectLog.open(dir, "b", {
				...held,
				fsyncDir: async () => {
					throw eio;
				},
			}),
		).rejects.toBe(eio);
		await expect(fs.stat(path.join(dir, LOG_FILE))).resolves.toBeTruthy();
		// The file now exists. Reopening with the fsync still failing must throw
		// again — never hand out a writer that would acknowledge appends.
		await expect(
			ProjectLog.open(dir, "b", {
				...held,
				fsyncDir: async () => {
					throw eio;
				},
			}),
		).rejects.toBe(eio);
		// And with it working, the directory IS synced on the reopen.
		const { log } = await ProjectLog.open(dir, "b", {
			...held,
			fsyncDir: async (d) => {
				synced.push(d);
			},
		});
		expect(synced).toEqual([dir]);
		await expect(log.append([{ ev: "m" }])).resolves.toHaveLength(1);
		await log.close();
	});

	it("assertAppendable predicts the append's refusal without writing or poisoning", async () => {
		let ok = true;
		const { log } = await ProjectLog.open(dir, "b", { lockHeld: () => ok, maxBytes: 150 });
		const ev = { ev: "m", pad: "x".repeat(60) };
		expect(() => log.assertAppendable([ev])).not.toThrow();
		await log.append([ev]);
		expect(() => log.assertAppendable([ev])).toThrow(
			expect.objectContaining({ code: "project-log-full" }),
		);
		await expect(log.append([ev])).rejects.toMatchObject({ code: "project-log-full" });
		expect(() => log.assertAppendable([{ ev: "d" }], { allowMargin: true })).not.toThrow();
		ok = false;
		expect(() => log.assertAppendable([{ ev: "d" }])).toThrow(
			expect.objectContaining({ code: "persist-failed" }),
		);
		expect(log.isPoisoned).toBe(false);
		const size = (await fs.stat(path.join(dir, LOG_FILE))).size;
		expect(size).toBe(log.bytes);
		await log.close();
	});

	it("refuses a symlinked log", async () => {
		await fs.writeFile(path.join(dir, "elsewhere"), "");
		await fs.symlink(path.join(dir, "elsewhere"), path.join(dir, LOG_FILE));
		await expect(ProjectLog.open(dir, "b", held)).rejects.toThrow();
	});
});
