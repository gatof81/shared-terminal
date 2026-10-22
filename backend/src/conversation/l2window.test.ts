/**
 * l2window.test.ts — docs/CONVERSATION.md §4.4.1, the accepted L2 scope:
 * the budget holds for active messages and for the last
 * MESSAGE_SEALED_MAX (4096) sealed ids; an id evicted from that window
 * may start a new budget. Drives the real sealing path past the window
 * and checks the behaviour before and after eviction, live and after a
 * restart, with memory bounded throughout.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	conversations: new Map<string, string>(),
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			if (!dbStubs.conversations.has(String(params[0]))) {
				dbStubs.conversations.set(String(params[0]), String(params[1]));
			}
		}
		if (/^SELECT st_session_id FROM claude_conversations/.test(sql)) {
			const owner = dbStubs.conversations.get(String(params[0]));
			return { results: owner ? [{ st_session_id: owner }] : [], success: true, meta: {} };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import { ConversationService } from "./service.js";
import { ConversationStore, MESSAGE_OPEN_MAX, MESSAGE_SEALED_MAX } from "./store.js";

let root: string;
let store: ConversationStore;
let service: ConversationService;

const delta = (id: string, index: number, text: string, final: boolean) => ({
	hook_event_name: "MessageDisplay",
	session_id: "c1",
	cwd: "/w",
	prompt_id: "p",
	message_id: id,
	index,
	final,
	delta: text,
});

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-l2win-"));
	dbStubs.conversations.clear();
	store = new ConversationStore({ workspaceRoot: root });
	service = new ConversationService({ workspaceRoot: root, enabled: true, port: 3001, store });
});
afterEach(async () => {
	await service.shutdown();
	await fs.rm(root, { recursive: true, force: true });
});

describe("§4.4.1 — L2 window of the last 4096 sealed ids", () => {
	it("an id stays sealed while inside the window and may restart a budget once evicted (live and after restart)", async () => {
		expect(MESSAGE_SEALED_MAX).toBe(4096);
		// Seal "target" first, then MESSAGE_SEALED_MAX - 1 more ids: target is
		// the OLDEST entry of a full window.
		await service.ingest("s1", "%0", delta("target", 0, "x", true));
		for (let i = 0; i < MESSAGE_SEALED_MAX - 1; i++) {
			await service.ingest("s1", "%0", delta(`m${i}`, 0, "x", true));
		}
		let index = store.getResidentIndex("s1", "c1");
		expect(index?.sealedMessages).toHaveLength(MESSAGE_SEALED_MAX);
		expect(index?.sealedMessages[0]).toBe("target");

		// Before eviction: still sealed ⇒ a late delta is dropped.
		expect(await service.ingest("s1", "%0", delta("target", 1, "late", false))).toEqual({
			accepted: false,
			reason: "truncated",
		});

		// Same state after a restart from disk.
		await service.shutdown();
		const store2 = new ConversationStore({ workspaceRoot: root });
		const svc2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: store2,
		});
		expect(await svc2.ingest("s1", "%0", delta("target", 2, "late", false))).toEqual({
			accepted: false,
			reason: "truncated",
		});

		// One more sealed id pushes "target" out of the window.
		await svc2.ingest("s1", "%0", delta("overflow", 0, "x", true));
		index = store2.getResidentIndex("s1", "c1");
		expect(index?.sealedMessages).toHaveLength(MESSAGE_SEALED_MAX);
		expect(index?.sealedMessages.includes("target")).toBe(false);
		// The second-oldest is still sealed.
		expect(await svc2.ingest("s1", "%0", delta("m0", 1, "late", false))).toEqual({
			accepted: false,
			reason: "truncated",
		});

		// After eviction: the documented behaviour — a new budget starts.
		expect((await svc2.ingest("s1", "%0", delta("target", 3, "again", false))).accepted).toBe(true);
		expect(store2.getResidentIndex("s1", "c1")?.messageBytes.target).toEqual({
			bytes: 5,
			truncated: false,
		});

		// Memory stayed bounded the whole way.
		expect(Object.keys(index?.messageBytes ?? {}).length).toBeLessThanOrEqual(MESSAGE_OPEN_MAX);
		await svc2.shutdown();
	}, 120_000);
});
