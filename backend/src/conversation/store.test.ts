/**
 * store.test.ts — docs/CONVERSATION.md §3.3 / §4.4 against a real temp
 * directory: `seq` monotonic under concurrency, recovery from the FILE
 * (the index is only a cache), rotation (L7), the queue budgets (L6, G1),
 * a failing disk (gap backpressure, never a thrown error), and the G4
 * resident-index LRU.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationStore, type PendingEvent, type StoreFs } from "./store.js";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-conv-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const ev = (i: number, extra: Partial<PendingEvent> = {}): PendingEvent => ({
	ev: "user_prompt",
	prompt_id: `p${i}`,
	turn_id: null,
	agent_id: null,
	pane: "%0",
	data: { prompt: `hello ${i}` },
	...extra,
});

async function readLines(file: string) {
	const content = await fs.readFile(file, "utf8");
	const out: Array<{ seq: number; ev: string; data: Record<string, unknown> }> = [];
	for (const l of content.split("\n").filter(Boolean)) {
		try {
			out.push(JSON.parse(l));
		} catch {
			/* torn line left by a simulated crash */
		}
	}
	return out;
}

describe("ConversationStore — seq and persistence", () => {
	it("assigns strictly increasing seq to 1000 concurrently enqueued events", async () => {
		const store = new ConversationStore({
			workspaceRoot: root,
			limits: { queueEvents: 5000, queueBytes: 64 << 20, totalQueueBytes: 128 << 20 },
		});
		await store.open("s1", "c1");
		for (let i = 0; i < 1000; i++) expect(store.enqueue("s1", "c1", ev(i))).toBe("queued");
		await store.flush("s1", "c1");
		const lines = await readLines(store.eventsPath("s1", "c1"));
		expect(lines).toHaveLength(1000);
		for (const [i, l] of lines.entries()) expect(l.seq).toBe(i + 1);
		expect(store.getResidentIndex("s1", "c1")?.lastSeq).toBe(1000);
		expect(store.stats.persisted).toBe(1000);
	});

	it("recovers lastSeq from the FILE even when the index snapshot is stale or lies", async () => {
		const store = new ConversationStore({
			workspaceRoot: root,
			limits: { flushEveryEvents: 1000 },
		});
		await store.open("s1", "c1");
		for (let i = 0; i < 20; i++) store.enqueue("s1", "c1", ev(i));
		await store.flush("s1", "c1");
		// Tamper: an index that claims fewer events than the file holds.
		const idx = JSON.parse(await fs.readFile(store.indexPath("s1", "c1"), "utf8"));
		idx.lastSeq = 3;
		idx.offset = 0;
		idx.eventsCount = 3;
		await fs.writeFile(store.indexPath("s1", "c1"), JSON.stringify(idx));
		// And a torn last line from a crash mid-append.
		await fs.appendFile(store.eventsPath("s1", "c1"), '{"seq":21,"ev":"user_pro');
		const store2 = new ConversationStore({ workspaceRoot: root });
		const index = await store2.open("s1", "c1");
		expect(index.lastSeq).toBe(20);
		expect(index.eventsCount).toBe(20);
		expect(index.firstRetainedSeq).toBe(1);
		store2.enqueue("s1", "c1", ev(99));
		await store2.flush("s1", "c1");
		const lines = await readLines(store2.eventsPath("s1", "c1"));
		expect(lines.at(-1)?.seq).toBe(21);
	});

	it("trusts the index up to its offset and scans only the tail", async () => {
		const store = new ConversationStore({ workspaceRoot: root, limits: { flushEveryEvents: 5 } });
		await store.open("s1", "c1");
		for (let i = 0; i < 7; i++) store.enqueue("s1", "c1", ev(i));
		await store.flush("s1", "c1");
		const store2 = new ConversationStore({ workspaceRoot: root });
		const index = await store2.open("s1", "c1");
		expect(index.lastSeq).toBe(7);
		expect(index.eventsCount).toBe(7);
	});

	it("readEvents pages after a seq", async () => {
		const store = new ConversationStore({ workspaceRoot: root });
		await store.open("s1", "c1");
		for (let i = 0; i < 10; i++) store.enqueue("s1", "c1", ev(i));
		await store.flush("s1", "c1");
		const page = await store.readEvents("s1", "c1", 7, 2);
		expect(page.map((e) => e.seq)).toEqual([8, 9]);
	});

	it("listConversationIds finds ids from events and index files", async () => {
		const store = new ConversationStore({ workspaceRoot: root });
		await store.open("s1", "c1");
		store.enqueue("s1", "c1", ev(1));
		await store.flush("s1", "c1");
		await store.open("s1", "c2");
		await store.flush("s1", "c2");
		expect((await store.listConversationIds("s1")).sort()).toEqual(["c1"]);
		store.enqueue("s1", "c2", ev(1));
		await store.flush("s1", "c2");
		expect((await store.listConversationIds("s1")).sort()).toEqual(["c1", "c2"]);
	});
});

describe("ConversationStore — L7 rotation", () => {
	it("rotates to .1, starts the new file with a gap rotated and keeps seq monotonic", async () => {
		const store = new ConversationStore({ workspaceRoot: root, limits: { fileBytes: 600 } });
		await store.open("s1", "c1");
		for (let i = 0; i < 12; i++) store.enqueue("s1", "c1", ev(i));
		await store.flush("s1", "c1");
		expect(store.stats.rotations).toBeGreaterThanOrEqual(1);
		await fs.stat(`${store.eventsPath("s1", "c1")}.1`);
		const lines = await readLines(store.eventsPath("s1", "c1"));
		expect(lines[0].ev).toBe("gap");
		expect(lines[0].data.reason).toBe("rotated");
		const index = store.getResidentIndex("s1", "c1");
		expect(index?.firstRetainedSeq).toBe(lines[0].seq);
		expect(index?.lastSeq).toBe(lines.at(-1)?.seq);
		for (let i = 1; i < lines.length; i++) expect(lines[i].seq).toBe(lines[i - 1].seq + 1);
		// A fresh open after rotation recovers from the current file only.
		const store2 = new ConversationStore({ workspaceRoot: root });
		const reopened = await store2.open("s1", "c1");
		expect(reopened.lastSeq).toBe(index?.lastSeq);
		expect(reopened.firstRetainedSeq).toBe(lines[0].seq);
	});
});

describe("ConversationStore — queue budgets and disk failure", () => {
	it("L6: overflow drops events and records one gap backpressure before the next persisted event", async () => {
		const store = new ConversationStore({ workspaceRoot: root, limits: { queueEvents: 3 } });
		await store.open("s1", "c1");
		// The first enqueue starts the chain; the queue is drained
		// asynchronously, so pile up synchronously past the budget.
		const results = Array.from({ length: 6 }, (_, i) => store.enqueue("s1", "c1", ev(i)));
		expect(results.filter((r) => r === "dropped").length).toBeGreaterThan(0);
		await store.flush("s1", "c1");
		expect(store.enqueue("s1", "c1", ev(100))).toBe("queued");
		await store.flush("s1", "c1");
		const lines = await readLines(store.eventsPath("s1", "c1"));
		const gap = lines.find((l) => l.ev === "gap");
		expect(gap?.data).toMatchObject({ reason: "backpressure", scope: "conversation" });
		expect(gap?.data.dropped).toBe(results.filter((r) => r === "dropped").length);
		expect(store.stats.dropped).toBeGreaterThan(0);
	});

	it("G1: the global budget drops with scope global", async () => {
		const store = new ConversationStore({
			workspaceRoot: root,
			limits: { queueEvents: 1000, queueBytes: 64 << 20, totalQueueBytes: 300 },
		});
		await store.open("s1", "c1");
		await store.open("s1", "c2");
		const r = [
			store.enqueue("s1", "c1", ev(1)),
			store.enqueue("s1", "c1", ev(2)),
			store.enqueue("s1", "c2", ev(3)),
			store.enqueue("s1", "c2", ev(4)),
		];
		expect(r).toContain("dropped");
		await store.flush("s1", "c1");
		expect(store.enqueue("s1", "c2", ev(5))).toBe("queued");
		await store.flush("s1", "c2");
		const lines = await readLines(store.eventsPath("s1", "c2"));
		expect(lines.some((l) => l.ev === "gap" && l.data.scope === "global")).toBe(true);
	});

	it("a failing disk never throws: lost events become a gap once the disk is back", async () => {
		let failing = true;
		const realFs = fs as unknown as StoreFs;
		const flaky: StoreFs = {
			...realFs,
			mkdir: (p, o) => realFs.mkdir(p, o),
			appendFile: async (p, d) => {
				if (failing) throw new Error("EIO");
				return realFs.appendFile(p, d);
			},
			writeFile: (p, d) => realFs.writeFile(p, d),
			rename: (a, b) => realFs.rename(a, b),
			rm: (p, o) => realFs.rm(p, o),
			stat: (p) => realFs.stat(p),
			readFile: (p, e) => realFs.readFile(p, e),
			readdir: (p) => realFs.readdir(p),
		};
		const store = new ConversationStore({ workspaceRoot: root, fs: flaky });
		await store.open("s1", "c1");
		expect(store.enqueue("s1", "c1", ev(1))).toBe("queued");
		expect(store.enqueue("s1", "c1", ev(2))).toBe("queued");
		await store.flush("s1", "c1");
		// ev1 fails, the drop report fails, ev2 fails: three attempts, two lost events.
		expect(store.stats.appendFailures).toBe(3);
		failing = false;
		store.enqueue("s1", "c1", ev(3));
		await store.flush("s1", "c1");
		const lines = await readLines(store.eventsPath("s1", "c1"));
		expect(lines[0].ev).toBe("gap");
		expect(lines[0].data).toMatchObject({ reason: "backpressure", scope: "disk", dropped: 2 });
		expect(lines[1].data.prompt).toBe("hello 3");
		expect(lines.map((l) => l.seq)).toEqual([1, 2]);
	});
});

describe("ConversationStore — G4 resident LRU", () => {
	it("keeps at most N indexes resident and flushes evicted ones to disk", async () => {
		const store = new ConversationStore({ workspaceRoot: root, limits: { residentIndexes: 3 } });
		for (let i = 0; i < 100; i++) {
			await store.open("s1", `c${i}`);
			store.enqueue("s1", `c${i}`, ev(i));
			await store.flush("s1", `c${i}`);
		}
		expect(store.residentCount()).toBeLessThanOrEqual(3);
		expect(store.stats.evictions).toBeGreaterThanOrEqual(97);
		// An evicted conversation reopens from its snapshot + file.
		const idx = await store.open("s1", "c0");
		expect(idx.lastSeq).toBe(1);
		expect(await store.peekIndex("s1", "c50")).toMatchObject({ cid: "c50", lastSeq: 1 });
	});
});
