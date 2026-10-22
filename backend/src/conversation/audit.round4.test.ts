/**
 * audit.round4.test.ts — Work re-verification of PR #446 (commit
 * 39c2443): a delta refused because its message is sealed must leave no
 * side effects (no `missing_delta` gap, no recreated `messageIndex`
 * entry), while live gap detection and recovery stay exact.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	owners: new Map<string, string>(),
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			if (!dbStubs.owners.has(String(params[0])))
				dbStubs.owners.set(String(params[0]), String(params[1]));
		}
		if (/^SELECT st_session_id FROM claude_conversations/.test(sql)) {
			const owner = dbStubs.owners.get(String(params[0]));
			return { results: owner ? [{ st_session_id: owner }] : [], success: true, meta: {} };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import { ConversationService } from "./service.js";
import { ConversationStore, MESSAGE_OPEN_MAX } from "./store.js";

let root: string;
let store: ConversationStore;
let service: ConversationService;

const delta = (id: string, index: number, final: boolean, text = "line\n") => ({
	hook_event_name: "MessageDisplay",
	session_id: "c1",
	cwd: "/w",
	prompt_id: "p",
	message_id: id,
	index,
	final,
	delta: text,
});
async function lines() {
	await store.flush("s1", "c1");
	return (await fs.readFile(store.eventsPath("s1", "c1"), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { ev: string; data: Record<string, unknown> });
}
const gaps = async () => (await lines()).filter((e) => e.ev === "gap").map((e) => e.data);

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-audit4-"));
	dbStubs.owners.clear();
	store = new ConversationStore({ workspaceRoot: root });
	service = new ConversationService({ workspaceRoot: root, enabled: true, port: 3001, store });
});
afterEach(async () => {
	await service.shutdown();
	await fs.rm(root, { recursive: true, force: true });
});

describe("B6 (round 4) — refused sealed deltas have no side effects", () => {
	it("1. final index=0 then a late index=1: refused, no new gap, no messageIndex entry", async () => {
		expect((await service.ingest("s1", "%0", delta("m", 0, true))).accepted).toBe(true);
		expect(await service.ingest("s1", "%0", delta("m", 1, false))).toEqual({
			accepted: false,
			reason: "truncated",
		});
		expect(await gaps()).toEqual([]);
		const index = store.getResidentIndex("s1", "c1");
		expect(index?.messageIndex).not.toHaveProperty("m");
		expect(index?.messageBytes).not.toHaveProperty("m");
		expect(index?.sealedMessages).toEqual(["m"]);
	});

	it("2. thousands of finalised messages plus late deltas keep messageIndex bounded", async () => {
		for (let i = 0; i < 3000; i++) {
			await service.ingest("s1", "%0", delta(`m${i}`, 0, true));
			await service.ingest("s1", "%0", delta(`m${i}`, 5, false));
			// Let the L6 queue drain so backpressure gaps don't mask the check.
			if (i % 100 === 99) await store.flush("s1", "c1");
		}
		const index = store.getResidentIndex("s1", "c1");
		expect(Object.keys(index?.messageIndex ?? {})).toHaveLength(0);
		expect(Object.keys(index?.messageBytes ?? {})).toHaveLength(0);
		expect(await gaps()).toEqual([]);
		expect(index?.sealedMessages.length).toBeLessThanOrEqual(4096);
	}, 120_000);

	it("3. recovery from a genuinely stale snapshot matches the live messageIndex, messageBytes and sealedMessages", async () => {
		await service.ingest("s1", "%0", delta("early", 0, false));
		await service.shutdown(); // snapshot taken here
		const snapshot = await fs.readFile(store.indexPath("s1", "c1"), "utf8");
		// Tail after the snapshot: open, finalised, late-refused and over-cap messages.
		await service.ingest("s1", "%0", delta("early", 1, true));
		await service.ingest("s1", "%0", delta("early", 2, false)); // refused
		for (let i = 0; i < MESSAGE_OPEN_MAX + 20; i++)
			await service.ingest("s1", "%0", delta(`o${i}`, 0, false));
		await service.ingest("s1", "%0", delta("o5", 1, false));
		await service.ingest("s1", "%0", delta("f", 0, true));
		await store.flush("s1", "c1");
		const live = structuredClone(store.getResidentIndex("s1", "c1"));
		// The snapshot on disk is newer now; put the stale one back.
		await fs.writeFile(store.indexPath("s1", "c1"), snapshot);
		const recovered = await new ConversationStore({ workspaceRoot: root }).open("s1", "c1");
		expect(recovered.messageIndex).toEqual(live?.messageIndex);
		expect(recovered.messageBytes).toEqual(live?.messageBytes);
		expect(recovered.sealedMessages).toEqual(live?.sealedMessages);
	});

	it("4. consecutive valid deltas including the final produce no false gaps; a real hole still does", async () => {
		for (let i = 0; i < 5; i++) await service.ingest("s1", "%0", delta("a", i, i === 4));
		expect(await gaps()).toEqual([]);
		await service.ingest("s1", "%0", delta("b", 0, false));
		await service.ingest("s1", "%0", delta("b", 3, true)); // 1 and 2 missing; final checked before sealing
		expect(await gaps()).toEqual([{ reason: "missing_delta", message_id: "b", range: [1, 2] }]);
		expect(store.getResidentIndex("s1", "c1")?.messageIndex).not.toHaveProperty("b");
	});
});
