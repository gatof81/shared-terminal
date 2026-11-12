/**
 * store.rotation.test.ts — turn correlation (docs/CONVERSATION.md §4.6
 * "Correlación de turno", cases A/B/C) across an L7 rotation and a
 * restart (#485, follow-up of #482). The "L7 rotation" describe in
 * store.test.ts checks `lastSeq`/`firstRetainedSeq` after a reopen; this
 * file pins `persistedPromptId`/`lastPromptId` and the counters for the
 * snapshot shapes a restart can meet after a rotation: up to date, legacy
 * (no `persistedPromptId`), and one taken BEFORE the rotation (the process
 * died between the `rename` to `.1` and the next index write).
 *
 * Kept apart from store.test.ts on purpose: the helpers below are minimal
 * copies, not imports, so this file has no coupling to that one's setup.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The service (case 4) reserves conversation ownership in D1 on first
// discovery; only that read is answered, as the owner the test ingests for.
vi.mock("../db.js", () => ({
	d1Query: vi.fn(async (sql: string) => ({
		results: /^SELECT st_session_id FROM claude_conversations/.test(sql)
			? [{ st_session_id: "s1" }]
			: [],
		success: true,
		meta: {},
	})),
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));

import { ConversationService } from "./service.js";
import { ConversationStore, type PendingEvent, type StoreFs } from "./store.js";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-conv-rot-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

// The manual probe of #485: 600-byte files and 12 prompts p0…p11.
const FILE_BYTES = 600;
const PROMPTS = 12;

const ev = (i: number): PendingEvent => ({
	ev: "user_prompt",
	prompt_id: `p${i}`,
	turn_id: null,
	agent_id: null,
	pane: "%0",
	data: { prompt: `hello ${i}` },
});

type Line = { seq: number; ev: string; prompt_id: string | null; data: Record<string, unknown> };
async function readLines(file: string): Promise<Line[]> {
	const content = await fs.readFile(file, "utf8");
	return content
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Line);
}

/**
 * Real fs, except that renaming the events file to `.1` (a rotation)
 * first copies the index snapshot as it stands at that instant — what a
 * process that died right after the `rename`, before its next index write,
 * leaves on disk. With `flushEveryEvents: 1` that snapshot is the state
 * after the line before the one that triggered the rotation.
 */
function rotationSnapshotFs(indexPath: () => string) {
	const snapshots: string[] = [];
	const fsx: StoreFs = {
		mkdir: (p, o) => fs.mkdir(p, o),
		appendFile: (p, d) => fs.appendFile(p, d),
		writeFile: (p, d) => fs.writeFile(p, d),
		rename: async (from, to) => {
			if (to === `${from}.1`) snapshots.push(await fs.readFile(indexPath(), "utf8"));
			return fs.rename(from, to);
		},
		rm: (p, o) => fs.rm(p, o),
		stat: (p) => fs.stat(p),
		readFile: (p, e) => fs.readFile(p, e),
		readdir: (p) => fs.readdir(p),
	} as StoreFs;
	return { fs: fsx, snapshots };
}

/** Write p0…p11 under the probe's limits; returns the store and the pre-rotation snapshots. */
async function writeProbe() {
	let store!: ConversationStore;
	const g = rotationSnapshotFs(() => store.indexPath("s1", "c1"));
	store = new ConversationStore({
		workspaceRoot: root,
		fs: g.fs,
		limits: { fileBytes: FILE_BYTES, flushEveryEvents: 1 },
	});
	await store.open("s1", "c1");
	for (let i = 0; i < PROMPTS; i++) store.enqueue("s1", "c1", ev(i));
	await store.flush("s1", "c1");
	const current = await readLines(store.eventsPath("s1", "c1"));
	return { store, snapshots: g.snapshots, current };
}

describe("ConversationStore — L7 rotation × turn correlation after a restart (§4.6, #485)", () => {
	it("the probe's shape: the current file is `gap rotated` + p11", async () => {
		const { store, current } = await writeProbe();
		expect(store.stats.rotations).toBe(3);
		expect(current.map((l) => [l.seq, l.ev, l.prompt_id])).toEqual([
			[14, "gap", null],
			[15, "user_prompt", "p11"],
		]);
		expect(current[0].data).toMatchObject({ reason: "rotated", archived_up_to_seq: 13 });
	});

	it("case A, modern snapshot up to date after the rotation → p11, lastSeq 15, 2 events", async () => {
		await writeProbe();
		const reopened = await new ConversationStore({ workspaceRoot: root }).open("s1", "c1");
		expect(reopened.persistedPromptId).toBe("p11");
		expect(reopened.lastPromptId).toBe("p11");
		expect(reopened.lastSeq).toBe(15);
		expect(reopened.firstRetainedSeq).toBe(14);
		expect([reopened.eventsCount, reopened.gapsCount]).toEqual([2, 1]);
	});

	it("case C, legacy snapshot (no persistedPromptId) after the rotation → p11 from the current file's prefix, the live value ignored", async () => {
		const { store } = await writeProbe();
		const indexPath = store.indexPath("s1", "c1");
		const snap = JSON.parse(await fs.readFile(indexPath, "utf8")) as Record<string, unknown>;
		const size = (await fs.stat(store.eventsPath("s1", "c1"))).size;
		// The snapshot covers the whole current file: p11 is only in the
		// prefix before `offset`, never in a re-scanned tail.
		expect(snap.offset).toBe(size);
		delete snap.persistedPromptId;
		// A legacy snapshot's lastPromptId is the dead process's LIVE value:
		// never proof of anything on disk.
		snap.lastPromptId = "live-only";
		await fs.writeFile(indexPath, JSON.stringify(snap));

		const reopened = await new ConversationStore({ workspaceRoot: root }).open("s1", "c1");
		expect(reopened.persistedPromptId).toBe("p11");
		expect(reopened.lastPromptId).toBe("p11");
		expect(reopened.lastSeq).toBe(15);
		expect(reopened.firstRetainedSeq).toBe(14);
		expect([reopened.eventsCount, reopened.gapsCount]).toEqual([2, 1]);
		expect(reopened.offset).toBe(size);
	});

	it("modern snapshot from BEFORE the rotation (crash between rename and the index write) → offset past EOF, full rescan: p11 and the current file's counters", async () => {
		const { store, snapshots } = await writeProbe();
		const preRotation = snapshots.at(-1) as string;
		const snap = JSON.parse(preRotation) as Record<string, unknown>;
		const size = (await fs.stat(store.eventsPath("s1", "c1"))).size;
		// The precondition of the reset: the snapshot describes the file that
		// is now `.1`, larger than the new current file.
		expect(snap.offset).toBeGreaterThan(size);
		expect(snap.persistedPromptId).not.toBe("p11");
		await fs.writeFile(store.indexPath("s1", "c1"), preRotation);

		const reopened = await new ConversationStore({ workspaceRoot: root }).open("s1", "c1");
		expect(reopened.persistedPromptId).toBe("p11");
		expect(reopened.lastPromptId).toBe("p11");
		expect(reopened.lastSeq).toBe(15);
		expect(reopened.firstRetainedSeq).toBe(14);
		// Counters are the current file's alone, not the archived file's
		// carried over from the stale snapshot.
		expect([reopened.eventsCount, reopened.gapsCount]).toEqual([2, 1]);
		expect(reopened.eventsBytes).toBe(size);
		expect(reopened.offset).toBe(size);
	});
});

describe("ConversationService — rotation on the last prompt + crash before the snapshot (§4.6, #485)", () => {
	const hook = (name: string, body: Record<string, unknown>) => ({
		hook_event_name: name,
		session_id: "c1",
		cwd: "/home/developer/workspace",
		transcript_path: "/t",
		...body,
	});

	it("the prompt only in `.1` is recovered as null and the Stop of its turn writes a conservative missing_prompt", async () => {
		let store!: ConversationStore;
		const g = rotationSnapshotFs(() => store.indexPath("s1", "c1"));
		store = new ConversationStore({
			workspaceRoot: root,
			fs: g.fs,
			limits: { fileBytes: FILE_BYTES, flushEveryEvents: 1 },
		});
		const service = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store,
		});
		// Prompt after prompt until one of them is the line that triggers the
		// first rotation: that prompt then exists only in `.1`.
		let last = "";
		for (let i = 0; i < 50 && store.stats.rotations === 0; i++) {
			last = `p${i}`;
			await service.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: `hello ${i}`, prompt_id: last }),
			);
			await store.flush("s1", "c1");
		}
		expect(store.stats.rotations).toBe(1);
		expect(store.getResidentIndex("s1", "c1")?.lastPromptId).toBe(last);
		const events = store.eventsPath("s1", "c1");
		expect((await readLines(events)).map((l) => [l.ev, l.prompt_id])).toEqual([["gap", null]]);
		expect((await readLines(`${events}.1`)).at(-1)?.prompt_id).toBe(last);
		await service.shutdown();

		// The crash: what is on disk is the snapshot written before the
		// rotation, not the one the clean shutdown left.
		const preRotation = g.snapshots[0] as string;
		expect(JSON.parse(preRotation).persistedPromptId).not.toBe(last);
		await fs.writeFile(store.indexPath("s1", "c1"), preRotation);

		const store2 = new ConversationStore({ workspaceRoot: root });
		const reopened = await store2.open("s1", "c1");
		// The prompt did reach the disk, but only the archive holds it and
		// recovery reads the current file: no evidence ⇒ nothing claimed.
		expect(reopened.persistedPromptId).toBeNull();
		expect(reopened.lastPromptId).toBeNull();
		expect([reopened.eventsCount, reopened.gapsCount]).toEqual([1, 1]);

		const service2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: store2,
		});
		try {
			await service2.ingest(
				"s1",
				"%0",
				hook("Stop", { prompt_id: last, stop_hook_active: false, last_assistant_message: "r" }),
			);
			await store2.flush("s1", "c1");
			const after = await readLines(events);
			expect(after.map((l) => [l.ev, l.data.reason ?? null])).toEqual([
				["gap", "rotated"],
				["gap", "missing_prompt"],
				["turn_end", null],
			]);
			expect(after[1].data).toEqual({ reason: "missing_prompt", prompt_id: last });
		} finally {
			await service2.shutdown();
		}
	});
});
