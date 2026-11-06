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
		expect(await store.remove(SID, "%3", r.client_message_id)).toBe("removed");
		expect(await store.read(SID, "%3")).toEqual({ kind: "none" });
		expect(await store.list(SID)).toEqual({ records: [], unreadable: [] });
		expect(await store.remove(SID, "%3", r.client_message_id)).toBe("absent"); // idempotent
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

describe("Work round 1 (#488)", () => {
	it("write fsyncs the directory AND every parent mkdir may have created, in order, and a sync failure propagates", async () => {
		const synced: string[] = [];
		const st = new PaneRecordStore(root, {
			fsyncDir: async (d) => {
				synced.push(path.relative(root, d) || ".");
			},
		});
		await st.write(record());
		expect(synced).toEqual([
			`.st-control/${SID}/composer`,
			`.st-control/${SID}`,
			".st-control",
			".",
		]);
		const failing = new PaneRecordStore(root, {
			fsyncDir: async () => {
				throw new Error("EIO");
			},
		});
		await expect(failing.write(record({ pane_id: "%4" }))).rejects.toThrow("EIO");
	});

	it("remove is identity-checked: another owner's record is left alone, an absent one reports absent", async () => {
		await store.write(record());
		expect(await store.remove(SID, "%3", "00000000-0000-4000-8000-000000000000")).toBe("other");
		expect((await store.read(SID, "%3")).kind).toBe("ok");
		expect(await store.remove(SID, "%3", record().client_message_id)).toBe("removed");
		expect((await store.read(SID, "%3")).kind).toBe("none");
		expect(await store.remove(SID, "%3", record().client_message_id)).toBe("absent");
	});
});

describe("v1.9 §8.1.12 job records (EXPERIMENTAL background transport)", () => {
	const job = {
		short: "dda484d8",
		pid: 900,
		start: "5000",
		exe: "/x/claude.exe",
		nonce: "1b7b6e46",
		pty_host_pid: 850,
		daemon_pid: 800,
		daemon_start: "4000",
		daemon_exe: "/x/claude.exe",
		version: "2.1.318",
		uid: 1000,
		config_dir: "/home/developer/.claude",
	};
	const jr = (over: Partial<PaneRecord> = {}) =>
		record({
			pane_id: "job:dda484d8",
			pane_pid: 900,
			job,
			state: "accepted",
			phase: "completed",
			execs: [{ id: "e1", step: "reply", created_at: "t", settled: { exit_code: 0, at: "t" } }],
			...over,
		});
	it("lives at job-<short>.json beside the pane records, round-trips and is listed", async () => {
		const r = jr();
		await store.write(r);
		await store.write(record());
		expect(store.file(SID, "job:dda484d8")).toBe(
			path.join(root, ".st-control", SID, "composer", "job-dda484d8.json"),
		);
		expect(await store.read(SID, "job:dda484d8")).toEqual({ kind: "ok", record: r });
		const l = await store.list(SID);
		expect(l.unreadable).toEqual([]);
		expect(l.records.map((x) => x.pane_id).sort()).toEqual(["%3", "job:dda484d8"]);
		expect(await store.remove(SID, "job:dda484d8", "other-id")).toBe("other");
		expect(await store.remove(SID, "job:dda484d8", r.client_message_id)).toBe("removed");
	});
	it("a job record without its target, with a foreign key, or naming another short is unreadable", async () => {
		const dir = path.join(root, ".st-control", SID, "composer");
		await fs.mkdir(dir, { recursive: true });
		const bad = [
			{ ...jr(), job: undefined },
			{ ...jr(), job: { ...job, extra: 1 } },
			{ ...jr(), job: { ...job, short: "ffffffff" } },
			{ ...jr(), job: { ...job, uid: 0 } },
			{ ...jr(), pane_id: "job:ffffffff" },
		];
		for (const [i, b] of bad.entries()) {
			await fs.writeFile(path.join(dir, "job-dda484d8.json"), JSON.stringify(b));
			const r = await store.read(SID, "job:dda484d8");
			expect(r.kind, `case ${i}`).toBe("unreadable");
		}
		// And a pane record may not carry a job target.
		await fs.writeFile(path.join(dir, "3.json"), JSON.stringify({ ...record(), job }));
		expect((await store.read(SID, "%3")).kind).toBe("unreadable");
	});
	it("an unexpected file name is still unreadable (the whole session fails closed)", async () => {
		const dir = path.join(root, ".st-control", SID, "composer");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "job-DDA484D8.json"), "{}");
		expect((await store.list(SID)).unreadable).toEqual(["job-DDA484D8.json:unexpected-file"]);
	});
	it("refuses an unsafe job key", () => {
		expect(() => store.file(SID, "job:../../x")).toThrow();
	});
});
