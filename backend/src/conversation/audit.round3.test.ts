/**
 * audit.round3.test.ts — regressions for the Work re-verification of
 * PR #446 (commit 1482b9b). Every test here fails against 1482b9b.
 *
 *   B4  a NEW ingest admitted during the purge adopts the bumped epoch
 *       and survives the cleanup
 *   B6  recovery rebuilds open tallies without the live caps
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	sessions: new Map<string, Record<string, unknown>>(),
	conversations: new Map<string, Record<string, unknown>>(),
	calls: [] as string[],
	/** Per-cid gate for the ownership SELECT. */
	selectGates: new Map<string, Promise<void>>(),
	/** Cids whose ownership SELECT is currently parked on its gate. */
	parked: new Set<string>(),
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		dbStubs.calls.push(sql);
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql)) {
			const row = dbStubs.sessions.get(String(params[0]));
			return { results: row ? [row] : [], success: true, meta: {} };
		}
		if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			const cid = String(params[0]);
			if (!dbStubs.conversations.has(cid)) {
				dbStubs.conversations.set(cid, { session_id: cid, st_session_id: params[1] });
			}
			return { results: [], success: true, meta: {} };
		}
		if (/^SELECT st_session_id FROM claude_conversations/.test(sql)) {
			const gate = dbStubs.selectGates.get(String(params[0]));
			if (gate) {
				dbStubs.parked.add(String(params[0]));
				await gate;
			}
			const row = dbStubs.conversations.get(String(params[0]));
			return {
				results: row ? [{ st_session_id: row.st_session_id }] : [],
				success: true,
				meta: {},
			};
		}
		if (/^DELETE FROM claude_conversations/.test(sql)) {
			for (const [k, r] of dbStubs.conversations) {
				if (r.st_session_id === params[0]) dbStubs.conversations.delete(k);
			}
			return { results: [], success: true, meta: {} };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => dbStubs.calls.length,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import { generateIngestToken, hashIngestToken } from "./registry.js";
import { sessionConversationsDir } from "./revocation.js";
import { ConversationService } from "./service.js";
import { ConversationStore, MESSAGE_OPEN_MAX } from "./store.js";

let root: string;
let store: ConversationStore;
let service: ConversationService;
const TOKEN = generateIngestToken();
const H = (sid: string) => ({ authorization: `Bearer ${TOKEN}`, stSession: sid, tmuxPane: "%0" });

function session(sid: string) {
	dbStubs.sessions.set(sid, {
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: hashIngestToken(TOKEN),
		ingest_token_hash_suspended: null,
		user_id: "u1",
	});
}
const hook = (name: string, body: Record<string, unknown>, cid: string) => ({
	hook_event_name: name,
	session_id: cid,
	cwd: "/w",
	...body,
});
const prompt = (cid: string, text: string) =>
	hook("UserPromptSubmit", { prompt: text, prompt_id: `p-${cid}-${text}` }, cid);
const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);
function gate(cid: string): () => void {
	let release: () => void = () => undefined;
	dbStubs.selectGates.set(
		cid,
		new Promise<void>((r) => {
			release = r;
		}),
	);
	return () => {
		dbStubs.selectGates.delete(cid);
		release();
	};
}
const settle = () => new Promise((r) => setTimeout(r, 30));

async function assertNothingFor(sid: string, cids: string[]) {
	expect(await exists(sessionConversationsDir(root, sid))).toBe(false);
	for (const cid of cids) {
		expect(service.runtimeFor(cid)).toBeUndefined();
		expect(dbStubs.conversations.has(cid)).toBe(false);
	}
	expect(service.heartbeatPending(sid)).toBe(0);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-audit3-"));
	dbStubs.sessions.clear();
	dbStubs.conversations.clear();
	dbStubs.calls.length = 0;
	dbStubs.selectGates.clear();
	dbStubs.parked.clear();
	store = new ConversationStore({ workspaceRoot: root });
	service = new ConversationService({ workspaceRoot: root, enabled: true, port: 3001, store });
});
afterEach(async () => {
	for (const release of Array.from(dbStubs.selectGates.keys())) dbStubs.selectGates.delete(release);
	await service.shutdown();
	await fs.rm(root, { recursive: true, force: true });
});

describe("B4 (round 3) — admission is closed during and after the purge", () => {
	it("A parked on the ownership SELECT, purge waits, B enters for another cid: both refused, nothing reappears", async () => {
		session("s1");
		session("s2");
		await service.ingest("s2", "%0", prompt("n1", "neighbour"));
		await store.flush("s2", "n1");

		const releaseA = gate("cA");
		const a = service.ingest("s1", "%0", prompt("cA", "a"));
		await vi.waitFor(() => expect(dbStubs.parked.has("cA")).toBe(true));

		const purge = service.onSessionPurged("s1");
		let purged = false;
		void purge.then(() => {
			purged = true;
		});
		await settle();
		expect(purged).toBe(false); // the purge is waiting for A

		// B arrives for a different cid of the same session while the purge waits.
		const releaseB = gate("cB");
		const b = service.ingest("s1", "%0", prompt("cB", "b"));

		releaseA();
		await purge;
		releaseB();
		const [outA, outB] = await Promise.all([a, b]);

		expect(outA).toEqual({ accepted: false, reason: "not_running" });
		expect(outB).toEqual({ accepted: false, reason: "not_running" });
		await settle();
		await assertNothingFor("s1", ["cA", "cB"]);
		// The neighbour is intact.
		expect(await fs.readFile(store.eventsPath("s2", "n1"), "utf8")).toContain("neighbour");
		expect(dbStubs.conversations.get("n1")?.st_session_id).toBe("s2");
		expect(service.runtimeFor("n1")).toBeDefined();
	});

	it("authorisation obtained before the purge does not admit a body received during or after it", async () => {
		session("s1");
		await service.ingest("s1", "%0", prompt("c1", "warm"));
		expect(await service.authorize(H("s1"))).toEqual({ ok: true, stSessionId: "s1" });

		const releaseX = gate("cX");
		const parked = service.ingest("s1", "%0", prompt("cX", "x"));
		await vi.waitFor(() => expect(dbStubs.parked.has("cX")).toBe(true));
		const purge = service.onSessionPurged("s1");
		await new Promise((r) => setImmediate(r));

		// Body received DURING the purge, with the earlier authorisation.
		expect(await service.ingest("s1", "%0", prompt("c1", "during"))).toEqual({
			accepted: false,
			reason: "not_running",
		});
		expect(await service.ingest("s1", "%0", prompt("cNew", "during"))).toEqual({
			accepted: false,
			reason: "not_running",
		});

		releaseX();
		await purge;
		await parked;

		// Body received AFTER the purge; a fresh authorisation is refused too
		// (the token cache was dropped and the tombstone wins over D1).
		expect(await service.authorize(H("s1"))).toEqual({ accepted: false, reason: "not_running" });
		expect(await service.ingest("s1", "%0", prompt("c1", "after"))).toEqual({
			accepted: false,
			reason: "not_running",
		});
		await settle();
		await assertNothingFor("s1", ["c1", "cX", "cNew"]);
	});

	it("the purge does not wait for another session's parked creation", async () => {
		session("s1");
		session("s2");
		const releaseOther = gate("other");
		const other = service.ingest("s2", "%0", prompt("other", "o"));
		await vi.waitFor(() => expect(dbStubs.parked.has("other")).toBe(true));
		await service.ingest("s1", "%0", prompt("c1", "a"));
		await service.onSessionPurged("s1"); // must resolve while s2 is still parked
		await assertNothingFor("s1", ["c1"]);
		releaseOther();
		expect((await other).accepted).toBe(true);
	});
});

describe("B6 (round 3) — recovery applies the same caps and seals as live processing", () => {
	const delta = (id: string, final = false) =>
		hook("MessageDisplay", { prompt_id: "p", message_id: id, index: 0, final, delta: "x" }, "c1");

	it("restoring an older snapshot and replaying a tail of 300 open messages yields the live state", async () => {
		session("s1");
		await service.ingest("s1", "%0", delta("seed"));
		await service.shutdown();
		const snapshot = await fs.readFile(store.indexPath("s1", "c1"), "utf8");

		for (let i = 0; i < 300; i++) await service.ingest("s1", "%0", delta(`m${i}`));
		for (let i = 0; i < 5; i++) await service.ingest("s1", "%0", delta(`f${i}`, true));
		await store.flush("s1", "c1");
		const live = store.getResidentIndex("s1", "c1");
		const liveOpen = Object.keys(live?.messageBytes ?? {}).sort();
		const liveSealed = [...(live?.sealedMessages ?? [])].sort();
		expect(liveOpen.length).toBeLessThanOrEqual(MESSAGE_OPEN_MAX);

		// Put the older snapshot back and reopen from disk.
		await fs.writeFile(store.indexPath("s1", "c1"), snapshot);
		const store2 = new ConversationStore({ workspaceRoot: root });
		const recovered = await store2.open("s1", "c1");
		const open = Object.keys(recovered.messageBytes).sort();
		const sealed = [...recovered.sealedMessages].sort();

		expect(open.length).toBeLessThanOrEqual(MESSAGE_OPEN_MAX);
		expect(open).toEqual(liveOpen);
		expect(sealed).toEqual(liveSealed);
		expect(Object.keys(recovered.messageIndex).sort()).toEqual(liveOpen);

		// And the recovered service refuses a delta for a cap-sealed message.
		const svc2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: store2,
		});
		const sealedOpen = liveSealed.find((id) => id.startsWith("m") || id === "seed");
		expect(sealedOpen).toBeDefined();
		expect(
			await svc2.ingest(
				"s1",
				"%0",
				hook(
					"MessageDisplay",
					{ prompt_id: "p", message_id: sealedOpen, index: 1, final: false, delta: "late" },
					"c1",
				),
			),
		).toEqual({ accepted: false, reason: "truncated" });
		await svc2.shutdown();
	});
});
