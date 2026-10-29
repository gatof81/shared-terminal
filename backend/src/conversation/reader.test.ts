/**
 * reader.test.ts — the streaming reads behind `GET …/events`,
 * `GET …/events/:seq` and the WS replay (CONVERSATION.md §6).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOne, readPage, streamEvents } from "./reader.js";
import type { PersistedEvent } from "./store.js";

let dir: string;
let file: string;

function ev(seq: number, data: Record<string, unknown> = {}): PersistedEvent {
	return {
		seq,
		ts: new Date(1_700_000_000_000 + seq).toISOString(),
		ev: "user_prompt",
		prompt_id: null,
		turn_id: null,
		agent_id: null,
		pane: null,
		data,
	};
}
async function write(events: PersistedEvent[], tail = ""): Promise<void> {
	await fs.writeFile(file, events.map((e) => `${JSON.stringify(e)}\n`).join("") + tail);
}
const seqs = (events: PersistedEvent[]) => events.map((e) => e.seq);
const page = (q: Partial<Parameters<typeof readPage>[1]> = {}) =>
	readPage(file, { before: null, limit: 200, firstRetainedSeq: 1, maxBytes: 8 << 20, ...q });

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-reader-"));
	file = path.join(dir, "c.events.jsonl");
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("readPage", () => {
	it("returns the newest `limit` events ascending, with hasMore", async () => {
		await write(Array.from({ length: 10 }, (_, i) => ev(i + 1)));
		const p = await page({ limit: 3 });
		expect(seqs(p.events)).toEqual([8, 9, 10]);
		expect(p.hasMore).toBe(true);
		const all = await page({ limit: 50 });
		expect(seqs(all.events)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(all.hasMore).toBe(false);
	});

	it("`before` is exclusive and pages backwards to the start", async () => {
		await write(Array.from({ length: 10 }, (_, i) => ev(i + 1)));
		const p1 = await page({ before: 8, limit: 3 });
		expect(seqs(p1.events)).toEqual([5, 6, 7]);
		expect(p1.hasMore).toBe(true);
		const p2 = await page({ before: 5, limit: 3 });
		expect(seqs(p2.events)).toEqual([2, 3, 4]);
		const p3 = await page({ before: 2, limit: 3 });
		expect(seqs(p3.events)).toEqual([1]);
		expect(p3.hasMore).toBe(false);
	});

	it("never serves below firstRetainedSeq; before ≤ firstRetainedSeq ⇒ empty, no more", async () => {
		await write(Array.from({ length: 10 }, (_, i) => ev(i + 1)));
		const p = await page({ firstRetainedSeq: 6, limit: 50 });
		expect(seqs(p.events)).toEqual([6, 7, 8, 9, 10]);
		expect(p.hasMore).toBe(false);
		expect(await page({ firstRetainedSeq: 6, before: 6 })).toEqual({ events: [], hasMore: false });
		expect(await page({ firstRetainedSeq: 6, before: 3 })).toEqual({ events: [], hasMore: false });
	});

	it("past the byte budget drops the OLDEST selected events, keeps the newest, says hasMore", async () => {
		const big = "x".repeat(1000);
		await write(Array.from({ length: 5 }, (_, i) => ev(i + 1, { prompt: big })));
		const lineBytes = `${JSON.stringify(ev(1, { prompt: big }))}`.length;
		const p = await page({ maxBytes: lineBytes * 2 + 10 });
		expect(seqs(p.events)).toEqual([4, 5]);
		expect(p.hasMore).toBe(true);
		// One event bigger than the budget still comes back alone (progress).
		const tiny = await page({ maxBytes: 10 });
		expect(seqs(tiny.events)).toEqual([5]);
		expect(tiny.hasMore).toBe(true);
	});

	it("skips a torn last line and survives a missing file", async () => {
		await write([ev(1), ev(2)], '{"seq":3,"ts":"2023');
		expect(seqs((await page()).events)).toEqual([1, 2]);
		await fs.rm(file);
		expect(await page()).toEqual({ events: [], hasMore: false });
	});

	it("20k events: a 500-event page and a full stream each under 500 ms", async () => {
		const n = 20_000;
		await write(
			Array.from({ length: n }, (_, i) => ev(i + 1, { prompt: `prompt number ${i} `.repeat(4) })),
		);
		let t = performance.now();
		const p = await page({ limit: 500 });
		const pageMs = performance.now() - t;
		expect(p.events).toHaveLength(500);
		expect(p.events[499].seq).toBe(n);
		t = performance.now();
		let count = 0;
		for await (const _ of streamEvents(file)) count++;
		const streamMs = performance.now() - t;
		expect(count).toBe(n);
		expect(pageMs).toBeLessThan(500);
		expect(streamMs).toBeLessThan(500);
	});
});

describe("readOne", () => {
	it("finds the exact seq, and nothing below firstRetainedSeq or past the end", async () => {
		await write(Array.from({ length: 5 }, (_, i) => ev(i + 1, { n: i + 1 })));
		expect((await readOne(file, 3, 1))?.data).toEqual({ n: 3 });
		expect(await readOne(file, 3, 4)).toBeNull();
		expect(await readOne(file, 9, 1)).toBeNull();
	});
});
