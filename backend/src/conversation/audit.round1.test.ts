/**
 * audit.round1.test.ts — regressions for the six findings of the Work
 * audit on PR #446 (commit 04babc1). Each block names its finding; every
 * test here fails against that commit.
 *
 *   B1  path traversal via session ids used as path components
 *   B2  concurrent first events / eviction during I/O → duplicate seq
 *   B3  Bash program extraction leaking argument values via quotes
 *   B4  hard delete leaving `.conversations/<sid>` behind
 *   B5  ownership of a Claude session id re-assignable across ST sessions
 *   B6  L2 applied per delta instead of accumulated per message
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	sessions: new Map<string, Record<string, unknown>>(),
	conversations: new Map<string, Record<string, unknown>>(),
	calls: [] as string[],
	fail: false,
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		dbStubs.calls.push(sql);
		if (dbStubs.fail) throw new Error("D1 down");
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql)) {
			const row = dbStubs.sessions.get(String(params[0]));
			return { results: row ? [row] : [], success: true, meta: {} };
		}
		if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			const cid = String(params[0]);
			if (!dbStubs.conversations.has(cid)) {
				dbStubs.conversations.set(cid, {
					session_id: cid,
					st_session_id: params[1],
					status: params[8],
				});
			}
			return { results: [], success: true, meta: {} };
		}
		if (/^SELECT st_session_id FROM claude_conversations/.test(sql)) {
			const row = dbStubs.conversations.get(String(params[0]));
			return {
				results: row ? [{ st_session_id: row.st_session_id }] : [],
				success: true,
				meta: {},
			};
		}
		if (/^UPDATE claude_conversations SET/.test(sql)) {
			const cid = String(params[params.length - 2]);
			const owner = String(params[params.length - 1]);
			const row = dbStubs.conversations.get(cid);
			if (row && row.st_session_id === owner) row.status = params[6];
			return { results: [], success: true, meta: {} };
		}
		if (/^SELECT \* FROM claude_conversations WHERE st_session_id/.test(sql)) {
			return {
				results: Array.from(dbStubs.conversations.values()).filter(
					(r) => r.st_session_id === params[0],
				),
				success: true,
				meta: {},
			};
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

import { hooksFilePath } from "./activation.js";
import { L2_MESSAGE_BYTES } from "./limits.js";
import { normalizeHookInput } from "./normalize.js";
import { bashPrograms, summarizeToolInput } from "./redact.js";
import { generateIngestToken, hashIngestToken } from "./registry.js";
import { revokedPath, sessionConversationsDir, writeSessionRevocation } from "./revocation.js";
import { ConversationService } from "./service.js";
import { ConversationStore, type PendingEvent, type StoreFs } from "./store.js";

let root: string;
let store: ConversationStore;
let service: ConversationService;
const TOKEN = generateIngestToken();

function session(sid: string, patch: Record<string, unknown> = {}) {
	dbStubs.sessions.set(sid, {
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: hashIngestToken(TOKEN),
		ingest_token_hash_suspended: null,
		user_id: "u1",
		...patch,
	});
}
const hook = (name: string, body: Record<string, unknown> = {}, cid = "c1") => ({
	hook_event_name: name,
	session_id: cid,
	cwd: "/w",
	...body,
});
const ev = (i: number): PendingEvent => ({
	ev: "user_prompt",
	prompt_id: `p${i}`,
	turn_id: null,
	agent_id: null,
	pane: null,
	data: { prompt: `x${i}` },
});
async function readEvents(sid: string, cid: string) {
	await store.flush(sid, cid);
	const content = await fs.readFile(store.eventsPath(sid, cid), "utf8");
	const out: Array<{ seq: number; ev: string; data: Record<string, unknown> }> = [];
	for (const l of content.split("\n").filter(Boolean)) {
		try {
			out.push(JSON.parse(l));
		} catch {
			/* torn */
		}
	}
	return out;
}
const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-audit-"));
	dbStubs.sessions.clear();
	dbStubs.conversations.clear();
	dbStubs.calls.length = 0;
	dbStubs.fail = false;
	store = new ConversationStore({ workspaceRoot: root });
	service = new ConversationService({ workspaceRoot: root, enabled: true, port: 3001, store });
});
afterEach(async () => {
	await service.shutdown();
	await fs.rm(root, { recursive: true, force: true });
});

// ── B1 ──────────────────────────────────────────────────────────────────────

describe("B1 — path traversal", () => {
	const bad = [
		"../../etc/passwd",
		"..",
		".",
		"a/b",
		"a\\b",
		"/abs",
		".hidden",
		"",
		"x".repeat(129),
		"c1\0",
	];
	it("normalize refuses traversal-shaped Claude session ids as malformed", () => {
		for (const id of bad) {
			const r = normalizeHookInput({
				hook_event_name: "Stop",
				session_id: id,
				stop_hook_active: false,
			});
			expect(r.ok, `id ${JSON.stringify(id)} must be malformed`).toBe(false);
		}
		expect(
			normalizeHookInput({
				hook_event_name: "Stop",
				session_id: "9bc9d901-c8f7-4173-b017-dfc49c3c1778",
				stop_hook_active: false,
			}).ok,
		).toBe(true);
	});
	it("the store refuses to build any path from an unsafe component", () => {
		for (const id of bad) {
			expect(() => store.eventsPath("s1", id)).toThrow();
			expect(() => store.indexPath("s1", id)).toThrow();
			expect(() => store.sessionDir(id)).toThrow();
			expect(() => sessionConversationsDir(root, id)).toThrow();
		}
	});
	it("ingest with a traversal cid writes nothing outside the session dir", async () => {
		session("s1");
		await fs.writeFile(path.join(root, "victim.txt"), "intact");
		const out = await service.ingest("s1", "%0", {
			hook_event_name: "Stop",
			session_id: "../../victim",
			stop_hook_active: false,
		});
		expect(out).toEqual({ accepted: false, reason: "malformed" });
		await service.shutdown();
		expect(await fs.readFile(path.join(root, "victim.txt"), "utf8")).toBe("intact");
		expect(await exists(path.join(root, ".conversations", "s1"))).toBe(false);
	});
	it("a traversal-shaped X-ST-Session is rejected before any lookup", async () => {
		session("s1");
		for (const sid of ["../s1", "a/b", ".", "..", "x".repeat(129)]) {
			expect(await service.authorize({ authorization: `Bearer ${TOKEN}`, stSession: sid })).toEqual(
				{ accepted: false, reason: "missing_auth" },
			);
		}
		expect(dbStubs.calls).toHaveLength(0);
	});
	it("two ST sessions never share files", async () => {
		session("s1");
		session("s2");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "one", prompt_id: "p1" }, "c1"),
		);
		await service.ingest(
			"s2",
			"%0",
			hook("UserPromptSubmit", { prompt: "two", prompt_id: "p2" }, "c2"),
		);
		await store.flush("s1", "c1");
		await store.flush("s2", "c2");
		expect(await fs.readdir(path.join(root, ".conversations", "s1"))).toEqual(
			expect.arrayContaining(["c1.events.jsonl"]),
		);
		expect(await fs.readdir(path.join(root, ".conversations", "s2"))).not.toContain(
			"c1.events.jsonl",
		);
	});
});

// ── B2 ──────────────────────────────────────────────────────────────────────

describe("B2 — single writer per conversation", () => {
	it("concurrent opens of the same conversation share one resident entry", async () => {
		const [a, b, c] = await Promise.all([
			store.open("s1", "c1"),
			store.open("s1", "c1"),
			store.open("s1", "c1"),
		]);
		expect(a).toBe(b);
		expect(b).toBe(c);
		expect(store.residentCount()).toBe(1);
	});
	it("20 concurrent first events for a new conversation get 20 unique seqs and one runtime", async () => {
		session("s1");
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				service.ingest(
					"s1",
					"%0",
					hook("UserPromptSubmit", { prompt: `m${i}`, prompt_id: `p${i}` }),
				),
			),
		);
		expect(results.every((r) => r.accepted)).toBe(true);
		const events = await readEvents("s1", "c1");
		expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		expect(new Set(events.map((e) => e.data.prompt)).size).toBe(20);
	});
	it("an entry with an append in flight (queue empty) is never evicted, and no second writer appears", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const real = fs as unknown as StoreFs;
		let blockFirst = true;
		const slow: StoreFs = {
			...real,
			mkdir: (p, o) => real.mkdir(p, o),
			appendFile: async (p, d) => {
				if (blockFirst) {
					blockFirst = false;
					await gate;
				}
				return real.appendFile(p, d);
			},
			writeFile: (p, d) => real.writeFile(p, d),
			rename: (a, b) => real.rename(a, b),
			rm: (p, o) => real.rm(p, o),
			stat: (p) => real.stat(p),
			readFile: (p, e) => real.readFile(p, e),
			readdir: (p) => real.readdir(p),
		};
		const s = new ConversationStore({
			workspaceRoot: root,
			fs: slow,
			limits: { residentIndexes: 1 },
		});
		const idx1 = await s.open("s1", "c1");
		expect(s.enqueue("s1", "c1", ev(1))).toBe("queued");
		await new Promise((r) => setImmediate(r)); // let drain shift the event and block in appendFile
		await s.open("s1", "c2"); // would evict c1 on the old code (queue is empty)
		expect(s.getResidentIndex("s1", "c1")).toBe(idx1);
		// A reopen while blocked must return the SAME writer, not a stale copy.
		expect(await s.open("s1", "c1")).toBe(idx1);
		expect(s.enqueue("s1", "c1", ev(2))).toBe("queued");
		release();
		await s.flush("s1", "c1");
		const content = await fs.readFile(s.eventsPath("s1", "c1"), "utf8");
		const seqs = content
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l).seq);
		expect(seqs).toEqual([1, 2]);
	});
});

// ── B3 ──────────────────────────────────────────────────────────────────────

describe("B3 — Bash summaries never carry argument values", () => {
	const adversarial = [
		'curl -d "user|password123" https://x',
		"echo 'a; SECRET=hunter2 run' | tee out",
		"FOO=bar$(cat ~/.aws/credentials) deploy",
		'git commit -m "fix && TOKEN=abc"',
		"echo a\\|b",
		"cat <<EOF\n| leaked-token\nEOF",
		"(cd a && ls); nohup node s.js &",
		"{ echo x; } | grep secret",
	];
	it("omits programs for any ambiguous syntax and keeps only safe metadata", () => {
		for (const cmd of adversarial) {
			expect(bashPrograms(cmd), cmd).toBeNull();
			const s = summarizeToolInput("Bash", { command: cmd });
			expect(s).toEqual({ command_bytes: Buffer.byteLength(cmd), programs_omitted: true });
			const text = JSON.stringify(s);
			for (const leak of ["password123", "hunter2", "credentials", "TOKEN", "leaked", "secret"]) {
				expect(text).not.toContain(leak);
			}
		}
	});
	it("never reads past the first token of a segment (arguments are not programs)", () => {
		expect(bashPrograms("mail -s subject secret@example.test")).toEqual(["mail"]);
		expect(bashPrograms("sudo -u app python3 x.py")).toEqual([]);
		expect(bashPrograms("env FOO=1 python3 x.py; time make")).toEqual([]);
		expect(bashPrograms("--flag-only value; ls")).toEqual(["ls"]);
	});
	it("still names programs for plain pipelines", () => {
		expect(bashPrograms("npm test && git push | tee log; ./deploy.sh")).toEqual([
			"npm",
			"git",
			"tee",
			"deploy.sh",
		]);
		expect(bashPrograms("A=1 B=2 /usr/bin/python3 -m x || echo fail")).toEqual(["python3", "echo"]);
	});
});

// ── B4 ──────────────────────────────────────────────────────────────────────

describe("B4 — hard delete removes everything and stays removed", () => {
	it("purges events, indexes, rotations and markers; other sessions untouched", async () => {
		session("s1");
		session("s2");
		const small = new ConversationStore({ workspaceRoot: root, limits: { fileBytes: 400 } });
		const svc = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: small,
		});
		for (let i = 0; i < 8; i++)
			await svc.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: `m${i}`, prompt_id: `p${i}` }),
			);
		await svc.ingest(
			"s2",
			"%0",
			hook("UserPromptSubmit", { prompt: "other", prompt_id: "q1" }, "c9"),
		);
		await small.flush("s1", "c1");
		await small.flush("s2", "c9");
		await writeSessionRevocation(root, "s1", { at: "t", by: "api" });
		await fs.mkdir(path.dirname(hooksFilePath(root, "s1")), { recursive: true });
		await fs.writeFile(hooksFilePath(root, "s1"), "x");
		const dir = sessionConversationsDir(root, "s1");
		expect((await fs.readdir(dir)).sort()).toEqual(
			expect.arrayContaining(["REVOKED", "c1.events.jsonl", "c1.events.jsonl.1", "c1.index.json"]),
		);
		await svc.onSessionPurged("s1");
		expect(await exists(dir)).toBe(false);
		expect(await exists(revokedPath(root, "s1"))).toBe(false);
		expect(await exists(path.join(root, ".claude-managed", "s1"))).toBe(false);
		expect(await exists(sessionConversationsDir(root, "s2"))).toBe(true);
		expect(await fs.readFile(small.eventsPath("s2", "c9"), "utf8")).toContain('"other"');
		expect(dbStubs.conversations.has("c9")).toBe(true);
		expect(dbStubs.conversations.has("c1")).toBe(false);
		await svc.shutdown();
	});
	it("writes queued before the purge cannot resurrect the directory afterwards", async () => {
		session("s1");
		for (let i = 0; i < 50; i++)
			await service.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: `m${i}`, prompt_id: `p${i}` }),
			);
		// Do NOT flush: the queue is still draining when the purge starts.
		await service.onSessionPurged("s1");
		const dir = sessionConversationsDir(root, "s1");
		expect(await exists(dir)).toBe(false);
		await new Promise((r) => setTimeout(r, 50));
		expect(await exists(dir)).toBe(false);
		// No late heartbeat re-created the row.
		await new Promise((r) => setTimeout(r, 20));
		expect(dbStubs.conversations.has("c1")).toBe(false);
	});
	it("a reopen attempt during the purge is refused", async () => {
		await store.open("s1", "c1");
		store.enqueue("s1", "c1", ev(1));
		const purge = store.purgeSession("s1");
		await expect(store.open("s1", "c1")).rejects.toThrow(/purged/);
		expect(store.enqueue("s1", "c1", ev(2))).toBe("not_open");
		await purge;
		expect(await exists(sessionConversationsDir(root, "s1"))).toBe(false);
	});
});

// ── B5 ──────────────────────────────────────────────────────────────────────

describe("B5 — ownership of a Claude session id is reserved once in D1", () => {
	it("a second ST session cannot claim an existing cid, even after a stop or a restart", async () => {
		session("s1");
		session("s2");
		expect(
			(await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" })))
				.accepted,
		).toBe(true);
		await service.onSessionDown("s1");
		expect(
			await service.ingest("s2", "%0", hook("UserPromptSubmit", { prompt: "b", prompt_id: "p2" })),
		).toEqual({ accepted: false, reason: "session_mismatch" });
		// Fresh process: the in-memory owner cache is empty, D1 is the authority.
		const restarted = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: new ConversationStore({ workspaceRoot: root }),
		});
		expect(
			await restarted.ingest(
				"s2",
				"%0",
				hook("UserPromptSubmit", { prompt: "c", prompt_id: "p3" }),
			),
		).toEqual({ accepted: false, reason: "session_mismatch" });
		expect(
			(
				await restarted.ingest(
					"s1",
					"%0",
					hook("UserPromptSubmit", { prompt: "d", prompt_id: "p4" }),
				)
			).accepted,
		).toBe(true);
		expect(dbStubs.conversations.get("c1")?.st_session_id).toBe("s1");
		await restarted.shutdown();
	});
	it("concurrent first discovery from two ST sessions admits exactly one", async () => {
		session("s1");
		session("s2");
		const [a, b] = await Promise.all([
			service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" })),
			service.ingest("s2", "%0", hook("UserPromptSubmit", { prompt: "b", prompt_id: "p2" })),
		]);
		expect([a.accepted, b.accepted].filter(Boolean)).toHaveLength(1);
		const owner = dbStubs.conversations.get("c1")?.st_session_id;
		expect(["s1", "s2"]).toContain(owner);
		const loser = owner === "s1" ? b : a;
		expect(loser).toEqual({ accepted: false, reason: "session_mismatch" });
	});
	it("heartbeats never re-point a row, and ownership costs no D1 call per event", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		const before = dbStubs.calls.length;
		for (let i = 0; i < 200; i++)
			await service.ingest(
				"s1",
				"%0",
				hook("MessageDisplay", {
					prompt_id: "p1",
					message_id: "m",
					index: i,
					final: false,
					delta: "x\n",
				}),
			);
		expect(dbStubs.calls.length - before).toBeLessThanOrEqual(1);
		expect(dbStubs.calls.filter((c) => c.startsWith("INSERT OR REPLACE"))).toHaveLength(0);
		for (const c of dbStubs.calls.filter((c) => c.startsWith("UPDATE claude_conversations"))) {
			expect(c).toContain("WHERE session_id = ? AND st_session_id = ?");
		}
	});
	it("an unverifiable owner (D1 down) is refused, never provisionally accepted", async () => {
		session("s1");
		await service.authorize({ authorization: `Bearer ${TOKEN}`, stSession: "s1" }); // warm the token cache
		dbStubs.fail = true;
		expect(
			await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" })),
		).toEqual({ accepted: false, reason: "owner_unverified" });
		dbStubs.fail = false;
		expect(
			(await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" })))
				.accepted,
		).toBe(true);
	});
});

// ── B6 ──────────────────────────────────────────────────────────────────────

describe("B6 — L2 is accumulated per message", () => {
	const chunk = (bytes: number, ch = "é") => ch.repeat(Math.floor(bytes / Buffer.byteLength(ch)));
	const delta = (index: number, text: string, final = false) =>
		hook("MessageDisplay", { prompt_id: "p1", message_id: "m", index, final, delta: text });

	it("the delta that crosses 1 MiB is cut on a UTF-8 boundary with a visible flag; later deltas are dropped; final persists empty", async () => {
		session("s1");
		const part = chunk(400 * 1024);
		expect((await service.ingest("s1", "%0", delta(0, part))).accepted).toBe(true);
		expect((await service.ingest("s1", "%0", delta(1, part))).accepted).toBe(true);
		expect((await service.ingest("s1", "%0", delta(2, part))).accepted).toBe(true);
		expect(await service.ingest("s1", "%0", delta(3, part))).toEqual({
			accepted: false,
			reason: "truncated",
		});
		expect((await service.ingest("s1", "%0", delta(4, "tail", true))).accepted).toBe(true);
		const events = (await readEvents("s1", "c1")).filter((e) => e.ev === "assistant_delta");
		expect(events).toHaveLength(4);
		const total = events.reduce((n, e) => n + Buffer.byteLength(String(e.data.delta)), 0);
		expect(total).toBeLessThanOrEqual(L2_MESSAGE_BYTES);
		expect(total).toBeGreaterThan(L2_MESSAGE_BYTES - 4);
		expect(events[2].data.truncated).toBe(true);
		expect(events[2].data.original_bytes).toBe(3 * Buffer.byteLength(part));
		// Cut on a code-point boundary: the stored text round-trips.
		expect(Buffer.from(String(events[2].data.delta), "utf8").toString("utf8")).toBe(
			String(events[2].data.delta),
		);
		expect(events[3].data).toMatchObject({ final: true, delta: "", truncated: true });
	});
	it("the budget survives a restart (index snapshot) and a snapshot that lags the file", async () => {
		session("s1");
		const part = chunk(600 * 1024, "x");
		await service.ingest("s1", "%0", delta(0, part));
		await service.shutdown(); // snapshot written
		await service.ingest("s1", "%0", delta(1, part)); // crosses; after the snapshot
		await store.flush("s1", "c1");
		// New process: snapshot says 600 KiB; the file tail adds the rest.
		const store2 = new ConversationStore({ workspaceRoot: root });
		const svc2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: store2,
		});
		expect(await svc2.ingest("s1", "%0", delta(2, "more"))).toEqual({
			accepted: false,
			reason: "truncated",
		});
		expect((await svc2.ingest("s1", "%0", delta(3, "", true))).accepted).toBe(true);
		await svc2.shutdown();
	});
	it("a single oversized delta is capped too", async () => {
		session("s1");
		await service.ingest("s1", "%0", delta(0, chunk(L2_MESSAGE_BYTES + 10, "x")));
		const events = await readEvents("s1", "c1");
		expect(Buffer.byteLength(String(events[0].data.delta))).toBeLessThanOrEqual(L2_MESSAGE_BYTES);
		expect(events[0].data.truncated).toBe(true);
	});
});
