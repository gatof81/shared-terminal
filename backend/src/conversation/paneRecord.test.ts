/**
 * paneRecord.test.ts — CONVERSATION.md §8.1.4.1: the durable pane record.
 * Atomic write, strict read (anything unexpected is `unreadable`, never
 * repaired or deleted), listing with unreadable files reported, removal.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PaneRecord, PaneRecordStore } from "./paneRecord.js";

const SID = "11111111-2222-4333-8444-555555555555";
let root: string;
let store: PaneRecordStore;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-pane-"));
	store = new PaneRecordStore(root);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function record(over: Partial<PaneRecord> = {}): PaneRecord {
	return {
		v: 1,
		sid: SID,
		pane_id: "%3",
		pane_pid: 700,
		container_id: "c1",
		cid: "conv-a",
		client_message_id: "4f2a9c7e-1b3d-4e5f-8a6b-9c0d1e2f3a4b",
		text_hash: "ab".repeat(32),
		prepared_at: "2026-10-30T10:00:00.000Z",
		state: "prepared",
		result: "pending",
		phase: "active",
		execs: [],
		updated_at: "2026-10-30T10:00:00.000Z",
		...over,
	};
}

describe("PaneRecordStore", () => {
	it("writes under .st-control/<sid>/composer/<digits>.json, reads it back, lists and removes it", async () => {
		const r = record({ execs: [{ id: "e1", step: "paste", created_at: "t", settled: null }] });
		await store.write(r);
		expect(store.file(SID, "%3")).toBe(path.join(root, ".st-control", SID, "composer", "3.json"));
		expect(await store.read(SID, "%3")).toEqual({ kind: "ok", record: r });
		expect(await store.list(SID)).toEqual({ records: [r], unreadable: [] });
		expect(await store.sessionsWithRecords()).toEqual([SID]);
		await store.remove(SID, "%3");
		expect(await store.read(SID, "%3")).toEqual({ kind: "none" });
		expect(await store.list(SID)).toEqual({ records: [], unreadable: [] });
		await store.remove(SID, "%3"); // idempotent
	});
	it("leaves no temp file behind and overwrites atomically", async () => {
		await store.write(record());
		await store.write(record({ state: "entered", phase: "completed" }));
		const files = await fs.readdir(path.join(root, ".st-control", SID, "composer"));
		expect(files).toEqual(["3.json"]);
		expect(
			(await store.read(SID, "%3")).kind === "ok" &&
				((await store.read(SID, "%3")) as { record: PaneRecord }).record.state,
		).toBe("entered");
	});
	it("a corrupt, foreign or unknown-version record is unreadable and is NOT deleted", async () => {
		const dir = path.join(root, ".st-control", SID, "composer");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "3.json"), "{not json");
		await fs.writeFile(
			path.join(dir, "4.json"),
			JSON.stringify(record({ pane_id: "%4", sid: "99999999-2222-4333-8444-555555555555" })),
		);
		await fs.writeFile(
			path.join(dir, "5.json"),
			JSON.stringify({ ...record({ pane_id: "%5" }), v: 2 }),
		);
		await fs.writeFile(
			path.join(dir, "6.json"),
			JSON.stringify({ ...record({ pane_id: "%6" }), extra: 1 }),
		);
		await fs.writeFile(path.join(dir, "7.json"), JSON.stringify(record({ pane_id: "%8" }))); // name/pane mismatch
		await fs.writeFile(path.join(dir, "stray.txt"), "x");
		const l = await store.list(SID);
		expect(l.records).toEqual([]);
		expect(l.unreadable.map((u) => u.split(":")[0]).sort()).toEqual([
			"3.json",
			"4.json",
			"5.json",
			"6.json",
			"7.json",
			"stray.txt",
		]);
		expect((await store.read(SID, "%3")).kind).toBe("unreadable");
		expect((await fs.readdir(dir)).length).toBe(6);
	});
	it("refuses unsafe ids before touching the filesystem", () => {
		expect(() => store.file("../x", "%1")).toThrow(/unsafe session id/);
		expect(() => store.file(SID, "../1")).toThrow(/unsafe pane id/);
		expect(() => store.file(SID, "%1; rm")).toThrow(/unsafe pane id/);
	});
});
