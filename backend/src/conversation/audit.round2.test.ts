/**
 * audit.round2.test.ts — regressions for the Work re-verification of
 * PR #446 (commit 22fe37e). Every test here fails against 22fe37e.
 *
 *   B3  comments / unsupported syntax leaking through the segment split
 *   B4  in-flight ownership reservation surviving a purge
 *   B6  L2 budget restarting when a per-message counter is evicted
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	sessions: new Map<string, Record<string, unknown>>(),
	conversations: new Map<string, Record<string, unknown>>(),
	calls: [] as string[],
	/** When set, the ownership SELECT waits on this promise before answering (B4). */
	delaySelect: null as Promise<void> | null,
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
			if (dbStubs.delaySelect) await dbStubs.delaySelect;
			const row = dbStubs.conversations.get(String(params[0]));
			return {
				results: row ? [{ st_session_id: row.st_session_id }] : [],
				success: true,
				meta: {},
			};
		}
		if (/^UPDATE claude_conversations SET/.test(sql)) {
			const cid = String(params[params.length - 2]);
			const row = dbStubs.conversations.get(cid);
			if (row) row.updated = (Number(row.updated) || 0) + 1;
			return { results: [], success: true, meta: {} };
		}
		if (/^DELETE FROM claude_conversations/.test(sql)) {
			for (const [k, r] of dbStubs.conversations)
				if (r.st_session_id === params[0]) dbStubs.conversations.delete(k);
			return { results: [], success: true, meta: {} };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => dbStubs.calls.length,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import { L2_MESSAGE_BYTES } from "./limits.js";
import { bashPrograms, summarizeToolInput } from "./redact.js";
import { generateIngestToken, hashIngestToken } from "./registry.js";
import { sessionConversationsDir } from "./revocation.js";
import { ConversationService } from "./service.js";
import { ConversationStore, MESSAGE_OPEN_MAX, MESSAGE_SEALED_MAX } from "./store.js";

let root: string;
let store: ConversationStore;
let service: ConversationService;
const TOKEN = generateIngestToken();

function session(sid: string) {
	dbStubs.sessions.set(sid, {
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: hashIngestToken(TOKEN),
		ingest_token_hash_suspended: null,
		user_id: "u1",
	});
}
const hook = (name: string, body: Record<string, unknown> = {}, cid = "c1") => ({
	hook_event_name: name,
	session_id: cid,
	cwd: "/w",
	...body,
});
const delta = (id: string, index: number, text: string, final = false, cid = "c1") =>
	hook("MessageDisplay", { prompt_id: "p1", message_id: id, index, final, delta: text }, cid);
const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);
async function persistedFor(sid: string, cid: string, messageId: string) {
	await store.flush(sid, cid);
	const content = await fs.readFile(store.eventsPath(sid, cid), "utf8");
	let bytes = 0;
	for (const l of content.split("\n").filter(Boolean)) {
		const e = JSON.parse(l);
		if (e.ev === "assistant_delta" && e.data.message_id === messageId)
			bytes += Buffer.byteLength(String(e.data.delta));
	}
	return bytes;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-audit2-"));
	dbStubs.sessions.clear();
	dbStubs.conversations.clear();
	dbStubs.calls.length = 0;
	dbStubs.delaySelect = null;
	store = new ConversationStore({ workspaceRoot: root });
	service = new ConversationService({ workspaceRoot: root, enabled: true, port: 3001, store });
});
afterEach(async () => {
	await service.shutdown();
	await fs.rm(root, { recursive: true, force: true });
});

// ── B3 ──────────────────────────────────────────────────────────────────────

describe("B3 (round 2) — comments and unsupported syntax", () => {
	const commands = [
		"echo ok # note; SECRET_TOKEN_123",
		"ls # see | SECRET_PIPE_456",
		"true # and && SECRET_AND_789",
		"echo a # c\nSECRET_LINE_012 --flag",
		"echo ok #SECRET_NOSPACE_345; ls",
		"grep -r TODO . ; echo *SECRET_GLOB*",
		"cd ~SECRET_TILDE && ls",
		"!SECRET_HISTORY",
	];
	it("omits programs whenever a command carries a comment or any unsupported construct", () => {
		for (const cmd of commands) {
			expect(bashPrograms(cmd), cmd).toBeNull();
			const text = JSON.stringify(summarizeToolInput("Bash", { command: cmd }));
			expect(text, cmd).not.toMatch(/SECRET/);
			expect(text).toContain('"programs_omitted":true');
		}
	});
	it("keeps naming programs for plain pipelines (no regression of the allowlist)", () => {
		expect(bashPrograms("npm test && git push | tee log; ./deploy.sh")).toEqual([
			"npm",
			"git",
			"tee",
			"deploy.sh",
		]);
		expect(bashPrograms("git clone https://user:tok3n@github.com/x/y.git && cd y")).toEqual([
			"git",
			"cd",
		]);
		expect(bashPrograms("AWS_SECRET_ACCESS_KEY=abc aws s3 ls | head")).toEqual(["aws", "head"]);
	});
});

// ── B4 ──────────────────────────────────────────────────────────────────────

describe("B4 (round 2) — purge invalidates in-flight work", () => {
	it("a delayed ownership SELECT released after the purge cannot recreate runtime, files, rows or heartbeats", async () => {
		session("s1");
		session("s2");
		await service.ingest(
			"s2",
			"%0",
			hook("UserPromptSubmit", { prompt: "neighbour", prompt_id: "n1" }, "c9"),
		);
		await store.flush("s2", "c9");

		let release: () => void = () => undefined;
		dbStubs.delaySelect = new Promise<void>((r) => {
			release = r;
		});
		// The ingest reaches the ownership SELECT and parks there.
		const pending = service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "first", prompt_id: "p1" }),
		);
		await vi.waitFor(() =>
			expect(dbStubs.calls.some((c) => c.startsWith("SELECT st_session_id"))).toBe(true),
		);

		// Purge while the reservation is in flight, then let the SELECT answer.
		const purge = service.onSessionPurged("s1");
		await new Promise((r) => setImmediate(r));
		release();
		const [outcome] = await Promise.all([pending, purge]);

		expect(outcome).toEqual({ accepted: false, reason: "not_running" });
		expect(service.runtimeFor("c1")).toBeUndefined();
		expect(await exists(sessionConversationsDir(root, "s1"))).toBe(false);
		expect(dbStubs.conversations.has("c1")).toBe(false);
		expect(service.heartbeatPending("s1")).toBe(0);
		// Nothing resurrects later either.
		await new Promise((r) => setTimeout(r, 30));
		expect(await exists(sessionConversationsDir(root, "s1"))).toBe(false);
		expect(service.runtimeFor("c1")).toBeUndefined();
		// The neighbour is intact.
		expect(await fs.readFile(store.eventsPath("s2", "c9"), "utf8")).toContain("neighbour");
		expect(dbStubs.conversations.get("c9")?.st_session_id).toBe("s2");
	});

	it("an ingest already past the ownership check that reaches enqueue after the purge is refused", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		// Park the revocation stat so the purge lands between authorisation and enqueue.
		const realStat = fs.stat.bind(fs);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const spy = vi
			.spyOn(fs, "stat")
			.mockImplementation(async (p: Parameters<typeof fs.stat>[0], ...rest: unknown[]) => {
				if (String(p).endsWith("REVOKED")) await gate;
				return (realStat as (...a: unknown[]) => Promise<unknown>)(p, ...rest) as never;
			});
		try {
			const pending = service.ingest(
				"s1",
				"%0",
				hook("Stop", { prompt_id: "p1", stop_hook_active: false }),
			);
			await new Promise((r) => setImmediate(r));
			const purge = service.onSessionPurged("s1");
			await new Promise((r) => setImmediate(r));
			release();
			const [outcome] = await Promise.all([pending, purge]);
			expect(outcome).toEqual({ accepted: false, reason: "not_running" });
		} finally {
			spy.mockRestore();
		}
		expect(await exists(sessionConversationsDir(root, "s1"))).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(await exists(sessionConversationsDir(root, "s1"))).toBe(false);
	});

	it("appends still queued at purge time never recreate the directory", async () => {
		session("s1");
		for (let i = 0; i < 40; i++)
			await service.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: `m${i}`, prompt_id: `p${i}` }),
			);
		await service.onSessionPurged("s1");
		await new Promise((r) => setTimeout(r, 50));
		expect(await exists(sessionConversationsDir(root, "s1"))).toBe(false);
		expect(service.heartbeatPending("s1")).toBe(0);
	});
});

// ── B6 ──────────────────────────────────────────────────────────────────────

describe("B6 (round 2) — the L2 budget is never restarted", () => {
	const chunk = (bytes: number) => "x".repeat(bytes);

	it("1 MiB for A, 65 other messages, another delta for A: A stays ≤ 1 MiB", async () => {
		session("s1");
		await service.ingest("s1", "%0", delta("A", 0, chunk(L2_MESSAGE_BYTES)));
		for (let i = 0; i < 65; i++) {
			expect((await service.ingest("s1", "%0", delta(`m${i}`, 0, "hello", true))).accepted).toBe(
				true,
			);
		}
		// The crossing delta is persisted CUT (to zero bytes here) with the
		// visible flag; everything after it is dropped. On 22fe37e the 65
		// messages evicted A's tally, so this delta was stored in full.
		const crossing = await service.ingest("s1", "%0", delta("A", 1, chunk(1024)));
		expect(crossing.accepted).toBe(true);
		expect(await service.ingest("s1", "%0", delta("A", 2, chunk(1024)))).toEqual({
			accepted: false,
			reason: "truncated",
		});
		expect(await persistedFor("s1", "c1", "A")).toBeLessThanOrEqual(L2_MESSAGE_BYTES);
		await store.flush("s1", "c1");
		const lines = (await fs.readFile(store.eventsPath("s1", "c1"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const aDeltas = lines.filter((e) => e.ev === "assistant_delta" && e.data.message_id === "A");
		expect(aDeltas).toHaveLength(2);
		expect(aDeltas[1].data).toMatchObject({ delta: "", truncated: true });
	});

	it("…and after a reopen/restart with the snapshot on disk", async () => {
		session("s1");
		await service.ingest("s1", "%0", delta("A", 0, chunk(L2_MESSAGE_BYTES)));
		for (let i = 0; i < 65; i++) await service.ingest("s1", "%0", delta(`m${i}`, 0, "hello", true));
		await service.shutdown();
		const store2 = new ConversationStore({ workspaceRoot: root });
		const svc2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: store2,
		});
		const crossing = await svc2.ingest("s1", "%0", delta("A", 1, chunk(1024)));
		expect(crossing.accepted).toBe(true);
		expect(await svc2.ingest("s1", "%0", delta("A", 2, chunk(1024)))).toEqual({
			accepted: false,
			reason: "truncated",
		});
		// A finalised message never reopens either.
		expect(await svc2.ingest("s1", "%0", delta("m3", 1, "late"))).toEqual({
			accepted: false,
			reason: "truncated",
		});
		await svc2.shutdown();
		store = store2;
		expect(await persistedFor("s1", "c1", "A")).toBeLessThanOrEqual(L2_MESSAGE_BYTES);
	});

	it("a snapshot that lags the file still recovers the seal and the tally", async () => {
		session("s1");
		await service.ingest("s1", "%0", delta("A", 0, chunk(600 * 1024)));
		await service.shutdown(); // snapshot
		await service.ingest("s1", "%0", delta("A", 1, chunk(600 * 1024))); // crosses, after the snapshot
		await service.ingest("s1", "%0", delta("B", 0, "done", true)); // finalised after the snapshot
		await store.flush("s1", "c1");
		const svc2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: new ConversationStore({ workspaceRoot: root }),
		});
		expect(await svc2.ingest("s1", "%0", delta("A", 2, "more"))).toEqual({
			accepted: false,
			reason: "truncated",
		});
		expect(await svc2.ingest("s1", "%0", delta("B", 1, "late"))).toEqual({
			accepted: false,
			reason: "truncated",
		});
		await svc2.shutdown();
	});

	it("memory stays bounded: open tallies ≤ MESSAGE_OPEN_MAX, sealed ids ≤ MESSAGE_SEALED_MAX", async () => {
		session("s1");
		for (let i = 0; i < MESSAGE_OPEN_MAX + 50; i++)
			await service.ingest("s1", "%0", delta(`open${i}`, 0, "x"));
		for (let i = 0; i < 300; i++) await service.ingest("s1", "%0", delta(`fin${i}`, 0, "x", true));
		const index = store.getResidentIndex("s1", "c1");
		expect(Object.keys(index?.messageBytes ?? {}).length).toBeLessThanOrEqual(MESSAGE_OPEN_MAX);
		expect(index?.sealedMessages.length).toBeLessThanOrEqual(MESSAGE_SEALED_MAX);
		// An open message sealed by the cap does not reopen.
		expect(await service.ingest("s1", "%0", delta("open0", 1, "late"))).toEqual({
			accepted: false,
			reason: "truncated",
		});
	});
});
