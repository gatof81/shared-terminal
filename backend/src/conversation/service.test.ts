/**
 * service.test.ts — the orchestrator against a real temp directory and a
 * mocked D1: the §3.1 authorisation rows, §3.2 session_mismatch, §3.3
 * gap attribution, §2.5 revocation mid-stream, §4.6 ordering gaps, §5
 * binding/kind/title, state transitions through a realistic turn, the
 * "no D1 per event" rule, lifecycle hooks, reconcile and probes.
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
		if (
			/^SELECT session_id, conversation_requested, ingest_token_hash FROM sessions WHERE status/.test(
				sql,
			)
		) {
			const out = Array.from(dbStubs.sessions.entries())
				.filter(([, r]) => r.status === "running")
				.map(([session_id, r]) => ({
					session_id,
					conversation_requested: r.conversation_requested,
					ingest_token_hash: r.ingest_token_hash,
				}));
			return { results: out, success: true, meta: {} };
		}
		if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			const cid = String(params[0]);
			if (!dbStubs.conversations.has(cid)) {
				dbStubs.conversations.set(cid, {
					session_id: cid,
					st_session_id: params[1],
					kind: params[2],
					title: params[5],
					status: params[8],
					status_evidence: params[9],
					status_at: params[10],
					last_seq: params[16],
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
			if (row && row.st_session_id === owner) {
				row.kind = params[0];
				row.title = params[3];
				row.status = params[6];
				row.status_evidence = params[7];
				row.status_at = params[8];
				row.last_seq = params[14];
			}
			return { results: [], success: true, meta: {} };
		}
		if (/^SELECT \* FROM claude_conversations WHERE st_session_id/.test(sql)) {
			const rows = Array.from(dbStubs.conversations.values()).filter(
				(r) => r.st_session_id === params[0],
			);
			return { results: rows, success: true, meta: {} };
		}
		if (/^DELETE FROM claude_conversations/.test(sql)) {
			for (const [k, r] of dbStubs.conversations)
				if (r.st_session_id === params[0]) dbStubs.conversations.delete(k);
			return { results: [], success: true, meta: {} };
		}
		if (/^UPDATE sessions SET/.test(sql)) {
			const sid = String(params[params.length - 1]);
			const row = dbStubs.sessions.get(sid);
			if (row && sql.includes("ingest_token_hash = NULL, ingest_token_hash_suspended = NULL")) {
				row.ingest_token_hash = null;
				row.ingest_token_hash_suspended = null;
				row.conversation_requested = 0;
			} else if (row && sql.includes("ingest_token_hash_suspended = COALESCE")) {
				// suspendIngestToken (idempotent, 3.0d audit A1.2)
				row.ingest_token_hash_suspended = row.ingest_token_hash ?? row.ingest_token_hash_suspended;
				row.ingest_token_hash = null;
				row.conversation_requested = 0;
			}
			return { results: [], success: true, meta: {} };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => dbStubs.calls.length,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import { hooksFilePath } from "./activation.js";
import { generateIngestToken, hashIngestToken } from "./registry.js";
import { writeGlobalRevocation, writeSessionRevocation } from "./revocation.js";
import { ConversationService } from "./service.js";
import { ConversationStore, type StoreFs } from "./store.js";

let root: string;
let store: ConversationStore;
let service: ConversationService;
let now = 1_700_000_000_000;
const TOKEN = generateIngestToken();

function session(sid: string, patch: Record<string, unknown> = {}) {
	dbStubs.sessions.set(sid, {
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: hashIngestToken(TOKEN),
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: `cid-${sid}`,
		...patch,
	});
}
const H = (over: Record<string, string | undefined> = {}) => ({
	authorization: `Bearer ${TOKEN}`,
	stSession: "s1",
	tmuxPane: "%0",
	...over,
});
const hook = (name: string, body: Record<string, unknown> = {}, cid = "c1") => ({
	hook_event_name: name,
	session_id: cid,
	cwd: "/home/developer/workspace",
	transcript_path: "/t",
	...body,
});
async function readEvents(sid: string, cid: string) {
	await store.flush(sid, cid);
	const content = await fs.readFile(store.eventsPath(sid, cid), "utf8");
	return content
		.split("\n")
		.filter(Boolean)
		.map(
			(l) =>
				JSON.parse(l) as {
					seq: number;
					ev: string;
					data: Record<string, unknown>;
					agent_id: string | null;
				},
		);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-svc-"));
	dbStubs.sessions.clear();
	dbStubs.conversations.clear();
	dbStubs.calls.length = 0;
	dbStubs.fail = false;
	now = 1_700_000_000_000;
	store = new ConversationStore({ workspaceRoot: root, now: () => now });
	service = new ConversationService({
		workspaceRoot: root,
		enabled: true,
		port: 3001,
		store,
		now: () => now,
	});
});
afterEach(async () => {
	await service.shutdown();
	await fs.rm(root, { recursive: true, force: true });
});

describe("authorize — §3.1 rows", () => {
	it("missing headers → missing_auth", async () => {
		expect(await service.authorize({})).toEqual({ accepted: false, reason: "missing_auth" });
		expect(await service.authorize({ authorization: "Bearer x", stSession: undefined })).toEqual({
			accepted: false,
			reason: "missing_auth",
		});
		expect(await service.authorize({ authorization: "Bearer notahex", stSession: "s1" })).toEqual({
			accepted: false,
			reason: "missing_auth",
		});
	});
	it("flag off → disabled before any D1 call", async () => {
		const off = new ConversationService({ workspaceRoot: root, enabled: false, port: 3001, store });
		session("s1");
		expect(await off.authorize(H())).toEqual({ accepted: false, reason: "disabled" });
		expect(dbStubs.calls).toHaveLength(0);
	});
	it("requested=0 → disabled; bad token → bad_token; not running → not_running; unknown session → bad_token", async () => {
		session("s1", { conversation_requested: 0 });
		expect(await service.authorize(H())).toEqual({ accepted: false, reason: "disabled" });
		service.invalidateToken("s1");
		session("s1", { ingest_token_hash: hashIngestToken(generateIngestToken()) });
		expect(await service.authorize(H())).toEqual({ accepted: false, reason: "bad_token" });
		service.invalidateToken("s1");
		session("s1", { status: "stopped" });
		expect(await service.authorize(H())).toEqual({ accepted: false, reason: "not_running" });
		expect(await service.authorize(H({ stSession: "nope" }))).toEqual({
			accepted: false,
			reason: "bad_token",
		});
	});
	it("valid → ok, and the token cache serves repeats without D1", async () => {
		session("s1");
		expect(await service.authorize(H())).toEqual({ ok: true, stSessionId: "s1" });
		const calls = dbStubs.calls.length;
		for (let i = 0; i < 50; i++) await service.authorize(H());
		expect(dbStubs.calls.length).toBe(calls);
	});
});

describe("ingest — a realistic turn", () => {
	it("persists the sequence, derives kind/title/binding and walks the state machine", async () => {
		session("s1");
		await service.ingest(
			"s1",
			"%0",
			hook("SessionStart", {
				source: "startup",
				st: {
					claude_version: "2.1.308",
					tmux_session: "tab-1",
					pane: "%0",
					argv_flags: ["--dangerously-skip-permissions"],
				},
			}),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "Fix the bug in auth.ts please", prompt_id: "p1" }),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("PreToolUse", {
				prompt_id: "p1",
				tool_name: "Read",
				tool_use_id: "t1",
				tool_input: { file_path: "/w/auth.ts" },
			}),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("PostToolUse", {
				prompt_id: "p1",
				tool_name: "Read",
				tool_use_id: "t1",
				tool_input: {},
				tool_response: "contents",
				duration_ms: 3,
			}),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("MessageDisplay", {
				prompt_id: "p1",
				turn_id: "tn",
				message_id: "m1",
				index: 0,
				final: false,
				delta: "Working…\n",
			}),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("MessageDisplay", {
				prompt_id: "p1",
				turn_id: "tn",
				message_id: "m1",
				index: 1,
				final: true,
				delta: "Done.",
			}),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("Stop", {
				prompt_id: "p1",
				stop_hook_active: false,
				last_assistant_message: "Working…\nDone.",
				background_tasks: [],
			}),
		);
		const events = await readEvents("s1", "c1");
		expect(events.map((e) => e.ev)).toEqual([
			"session_start",
			"user_prompt",
			"tool_start",
			"tool_end",
			"assistant_delta",
			"assistant_delta",
			"turn_end",
		]);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		const index = store.getResidentIndex("s1", "c1");
		expect(index).toMatchObject({
			kind: "interactive",
			title: "Fix the bug in auth.ts please",
			tabId: "tab-1",
			paneId: "%0",
			claudeVersion: "2.1.308",
			lastPromptId: "p1",
		});
		expect(index?.state).toMatchObject({ status: "waiting_input", evidence: "hook:Stop" });
		expect(JSON.stringify(events)).not.toContain("contents");
	});

	it("headless kind from -p, teammate from --agent-name, injected prompts never title", async () => {
		session("s1");
		await service.ingest(
			"s1",
			undefined,
			hook("SessionStart", { source: "startup", st: { argv_flags: ["-p"] } }, "h1"),
		);
		await service.ingest(
			"s1",
			"%2",
			hook(
				"SessionStart",
				{ source: "startup", st: { argv_flags: ["--agent-name", "worker"] } },
				"t1",
			),
		);
		await service.ingest(
			"s1",
			"%2",
			hook("UserPromptSubmit", { prompt: "from the lead", source: "system" }, "t1"),
		);
		expect(store.getResidentIndex("s1", "h1")?.kind).toBe("headless");
		expect(store.getResidentIndex("s1", "t1")?.kind).toBe("teammate");
		expect(store.getResidentIndex("s1", "t1")?.title).toBeNull();
	});

	it("§3.2: a Claude session id already bound to another ST session is refused", async () => {
		session("s1");
		session("s2");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		expect(
			await service.ingest("s2", "%0", hook("UserPromptSubmit", { prompt: "b", prompt_id: "p2" })),
		).toEqual({ accepted: false, reason: "session_mismatch" });
		expect(service.stats.rejected.session_mismatch).toBe(1);
	});

	it("§4.6: duplicates are dropped; two agents in one turn both persist", async () => {
		session("s1");
		const stop = (agent: string) =>
			hook("SubagentStop", {
				prompt_id: "p1",
				agent_id: agent,
				agent_type: "Explore",
				stop_hook_active: false,
				last_assistant_message: `result ${agent}`,
			});
		expect((await service.ingest("s1", "%0", stop("a1"))).accepted).toBe(true);
		expect((await service.ingest("s1", "%0", stop("a2"))).accepted).toBe(true);
		expect(await service.ingest("s1", "%0", stop("a1"))).toEqual({
			accepted: false,
			reason: "duplicate",
		});
		const events = await readEvents("s1", "c1");
		expect(events.filter((e) => e.ev === "agent_end")).toHaveLength(2);
		expect(store.getResidentIndex("s1", "c1")?.agents).toMatchObject({
			a1: { hasResult: true },
			a2: { hasResult: true },
		});
	});

	it("§4.6: out-of-order deltas and a Stop without its prompt produce explicit gaps", async () => {
		session("s1");
		await service.ingest(
			"s1",
			"%0",
			hook("MessageDisplay", {
				prompt_id: "p1",
				message_id: "m",
				index: 0,
				final: false,
				delta: "a\n",
			}),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("MessageDisplay", {
				prompt_id: "p1",
				message_id: "m",
				index: 3,
				final: true,
				delta: "d",
			}),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("Stop", { prompt_id: "p9", stop_hook_active: false, last_assistant_message: "x" }),
		);
		const gaps = (await readEvents("s1", "c1")).filter((e) => e.ev === "gap").map((e) => e.data);
		expect(gaps).toEqual([
			{ reason: "missing_delta", message_id: "m", range: [1, 2] },
			{ reason: "missing_prompt", prompt_id: "p9" },
		]);
		expect(store.getResidentIndex("s1", "c1")?.gapsCount).toBe(2);
	});

	it("§3.2.1 relay reports: relay_dropped before the carrying event, relay_restart only for a known conversation", async () => {
		session("s1");
		// Restart reported on the first event of a NEW conversation: nothing was lost to it.
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }), {
			dropped: 0,
			droppedBytes: 0,
			unattributed: 0,
			restarted: true,
		});
		await readEvents("s1", "c1");
		// Same conversation, now known: restart + losses, then the event itself.
		await service.ingest(
			"s1",
			"%0",
			hook("Stop", { prompt_id: "p1", stop_hook_active: false, last_assistant_message: "x" }),
			{ dropped: 3, droppedBytes: 1200, unattributed: 2, restarted: true },
		);
		const events = await readEvents("s1", "c1");
		expect(events.map((e) => [e.ev, e.data.reason ?? null])).toEqual([
			["user_prompt", null],
			["gap", "relay_restart"],
			["gap", "relay_dropped"],
			["turn_end", null],
		]);
		expect(events[2].data).toEqual({ reason: "relay_dropped", dropped: 3, dropped_bytes: 1200 });
		expect(service.stats).toMatchObject({
			relayDropped: 3,
			relayDroppedUnattributed: 2,
			relayRestarts: 2,
			unattributedGaps: 1,
		});
	});

	it("§3.2.1 a duplicate still delivers the relay report", async () => {
		session("s1");
		const prompt = hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" });
		await service.ingest("s1", "%0", prompt);
		expect(
			await service.ingest("s1", "%0", prompt, {
				dropped: 1,
				droppedBytes: 10,
				unattributed: 0,
				restarted: false,
			}),
		).toEqual({ accepted: false, reason: "duplicate" });
		const gaps = (await readEvents("s1", "c1")).filter((e) => e.ev === "gap").map((e) => e.data);
		expect(gaps).toEqual([{ reason: "relay_dropped", dropped: 1, dropped_bytes: 10 }]);
	});

	it("a resume with no prior events records history_unavailable", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("SessionStart", { source: "resume" }));
		const events = await readEvents("s1", "c1");
		expect(events[0].data).toMatchObject({ reason: "history_unavailable", source: "resume" });
	});

	it("malformed bodies: attributed by unique pane, otherwise counted as unattributed", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		expect(
			await service.ingest("s1", "%0", { hook_event_name: "UserPromptSubmit", session_id: "c1" }),
		).toEqual({ accepted: false, reason: "malformed" });
		await service.noteUnparseable("s1", "%0", "too_large");
		await service.noteUnparseable("s1", "%9", "invalid_json");
		const gaps = (await readEvents("s1", "c1")).filter((e) => e.ev === "gap").map((e) => e.data);
		expect(gaps).toEqual([
			{ reason: "malformed", detail: "UserPromptSubmit without prompt", hook: "UserPromptSubmit" },
			{ reason: "malformed", detail: "too_large" },
		]);
		expect(service.stats.unattributedGaps).toBe(1);
		expect(service.stats.rejected).toMatchObject({ malformed: 1, too_large: 1, invalid_json: 1 });
	});

	it("§5.2: the newest conversation on a pane takes the binding; the previous one loses it", async () => {
		session("s1");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "first", prompt_id: "p1" }, "c1"),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("SessionStart", { source: "clear", st: { pane: "%0", tmux_session: "tab-1" } }, "c2"),
		);
		expect(store.getResidentIndex("s1", "c2")?.paneId).toBe("%0");
		expect(store.getResidentIndex("s1", "c1")).toMatchObject({
			paneId: null,
			state: { status: "unknown", evidence: "binding_lost" },
		});
	});

	it("SessionEnd: ending → ended after the grace, binding cleared on clear/resume, reopened by a later event", async () => {
		vi.useFakeTimers();
		try {
			session("s1");
			await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
			await service.ingest("s1", "%0", hook("SessionEnd", { reason: "clear" }));
			expect(store.getResidentIndex("s1", "c1")?.state.status).toBe("ending");
			now += 6_000;
			await vi.advanceTimersByTimeAsync(6_000);
			expect(store.getResidentIndex("s1", "c1")).toMatchObject({
				state: { status: "ended" },
				paneId: null,
				endReason: "clear",
			});
			await service.ingest("s1", "%0", hook("SessionStart", { source: "resume" }));
			expect(store.getResidentIndex("s1", "c1")?.state.status).toBe("unknown");
			expect(store.getResidentIndex("s1", "c1")?.endedAt).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("no D1 per event", () => {
	it("1000 events cost a bounded, constant number of D1 calls", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p0" }));
		await store.flush("s1", "c1");
		const before = dbStubs.calls.length;
		for (let i = 0; i < 1000; i++) {
			await service.ingest(
				"s1",
				"%0",
				hook("MessageDisplay", {
					prompt_id: "p0",
					message_id: "m",
					index: i,
					final: i === 999,
					delta: `l${i}\n`,
				}),
			);
		}
		await store.flush("s1", "c1");
		expect(dbStubs.calls.length - before).toBeLessThanOrEqual(2);
	});
});

describe("§2.5 revocation observed mid-stream", () => {
	it("rejects with reason revoked, removes the hooks file and appends exactly one gap revoked", async () => {
		session("s1");
		await fs.mkdir(path.dirname(hooksFilePath(root, "s1")), { recursive: true });
		await fs.writeFile(hooksFilePath(root, "s1"), "x");
		await fs.mkdir(path.join(root, ".st-control", "s1"), { recursive: true });
		await fs.writeFile(path.join(root, ".st-control", "s1", "relay.enabled"), "");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		await writeSessionRevocation(root, "s1", { at: "t", by: "cli" });
		expect(
			await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1", stop_hook_active: false })),
		).toEqual({ accepted: false, reason: "revoked" });
		expect(
			await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1", stop_hook_active: true })),
		).toEqual({ accepted: false, reason: "revoked" });
		await expect(fs.stat(hooksFilePath(root, "s1"))).rejects.toThrow();
		// 3.0d: the authorization marker goes with it (§2.5, §2.7.5).
		await expect(fs.stat(path.join(root, ".st-control", "s1", "relay.enabled"))).rejects.toThrow();
		const events = await readEvents("s1", "c1");
		expect(events.filter((e) => e.ev === "gap" && e.data.reason === "revoked")).toHaveLength(1);
		expect(events[0].ev).toBe("user_prompt");
	});
	it("the global marker revokes every session", async () => {
		session("s1");
		await writeGlobalRevocation(root, { at: "t", by: "cli" });
		expect(
			await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" })),
		).toEqual({ accepted: false, reason: "revoked" });
	});
});

describe("lifecycle, list, reconcile, probe", () => {
	it("onSessionDown marks disconnected and closes; list reflects it from D1", async () => {
		session("s1");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "hello there", prompt_id: "p1" }),
		);
		await service.onSessionDown("s1");
		const row = dbStubs.conversations.get("c1");
		expect(row).toMatchObject({ status: "disconnected", title: "hello there" });
		const listed = await service.list("s1");
		expect(listed.conversations[0]).toMatchObject({
			sessionId: "c1",
			status: "disconnected",
			canSendInput: false,
			title: "hello there",
		});
		// No Docker port wired in this harness: no container is ever seen
		// and the current image is unknown, so nothing is promised (§2.7.6).
		expect(listed.capture).toEqual({
			requested: true,
			effective: false,
			effectiveAfterRestart: false,
			requiresRecreate: false,
			pendingReasons: ["image-without-relay"],
			checkedAt: null,
		});
	});
	it("onSessionPurged removes rows, files and managed dir", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		await fs.mkdir(path.dirname(hooksFilePath(root, "s1")), { recursive: true });
		await fs.writeFile(hooksFilePath(root, "s1"), "x");
		await service.onSessionPurged("s1");
		expect(dbStubs.conversations.size).toBe(0);
		await expect(fs.stat(path.join(root, ".claude-managed", "s1"))).rejects.toThrow();
	});
	it("probe results drive the state and are persisted as probe events", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		now += 10;
		service.applyProbe("s1", [
			{ sessionId: "c1", kind: "interactive", status: "waiting", waitingFor: "permission prompt" },
		]);
		expect(store.getResidentIndex("s1", "c1")?.state).toMatchObject({
			status: "waiting_permission",
			evidence: "probe:waiting",
		});
		now += 10;
		service.applyProbe("s1", []);
		expect(store.getResidentIndex("s1", "c1")?.state).toMatchObject({
			status: "ended",
			evidence: "probe:absent",
		});
		const events = await readEvents("s1", "c1");
		expect(events.filter((e) => e.ev === "probe").map((e) => e.data)).toEqual([
			{ found: true, status: "waiting", waitingFor: "permission prompt" },
			{ found: false },
		]);
	});
	it("reconcile with the flag off only removes stale hooks files and relay markers", async () => {
		const off = new ConversationService({ workspaceRoot: root, enabled: false, port: 3001, store });
		await fs.mkdir(path.dirname(hooksFilePath(root, "s9")), { recursive: true });
		await fs.writeFile(hooksFilePath(root, "s9"), "x");
		await fs.mkdir(path.join(root, ".st-control", "s8"), { recursive: true });
		await fs.writeFile(path.join(root, ".st-control", "s8", "relay.enabled"), "");
		await off.reconcile();
		await expect(fs.stat(hooksFilePath(root, "s9"))).rejects.toThrow();
		await expect(fs.stat(path.join(root, ".st-control", "s8", "relay.enabled"))).rejects.toThrow();
		expect(dbStubs.calls).toHaveLength(0);
	});
	it("reconcile retires the leftovers of a session that isn't running (stopped without retain, or deleted)", async () => {
		session("s4", { status: "stopped", conversation_requested: 0, ingest_token_hash: null });
		for (const sid of ["s4", "gone"]) {
			await fs.mkdir(path.dirname(hooksFilePath(root, sid)), { recursive: true });
			await fs.writeFile(hooksFilePath(root, sid), "x");
			await fs.mkdir(path.join(root, ".st-control", sid), { recursive: true });
			await fs.writeFile(path.join(root, ".st-control", sid, "relay.enabled"), "");
		}
		await service.reconcile();
		for (const sid of ["s4", "gone"]) {
			await expect(fs.stat(hooksFilePath(root, sid))).rejects.toThrow();
			await expect(fs.stat(path.join(root, ".st-control", sid, "relay.enabled"))).rejects.toThrow();
		}
	});
	it("reconcile writes and removes nothing for a session whose recreation is unresolved (§2.7.4), fail-closed on a failing check", async () => {
		session("s1"); // requested + hash: would normally get a file
		session("s2", { conversation_requested: 0, ingest_token_hash: null }); // orphan file: would normally go
		await fs.mkdir(path.dirname(hooksFilePath(root, "s2")), { recursive: true });
		await fs.writeFile(hooksFilePath(root, "s2"), "x");
		const exec = vi.fn();
		const svc2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: new ConversationStore({ workspaceRoot: root }),
			execCapture: exec,
			isRecreateUnresolved: async (sid) => {
				if (sid === "s1") return true;
				throw new Error("EIO");
			},
		});
		await svc2.reconcile();
		await expect(fs.stat(hooksFilePath(root, "s1"))).rejects.toThrow();
		expect(await fs.readFile(hooksFilePath(root, "s2"), "utf8")).toBe("x");
		expect(exec).not.toHaveBeenCalled();
		await svc2.shutdown();
	});

	it("reconcile: marker wins over D1, files follow requested∧hash, restart gap + probe per session", async () => {
		session("s1"); // requested + hash → should have a file
		session("s2", { conversation_requested: 0, ingest_token_hash: null }); // orphan file to remove
		session("s3"); // revoked marker but D1 says requested
		await fs.mkdir(path.dirname(hooksFilePath(root, "s2")), { recursive: true });
		await fs.writeFile(hooksFilePath(root, "s2"), "x");
		await writeSessionRevocation(root, "s3", { at: "t", by: "cli" });
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		await store.flush("s1", "c1");
		const exec = vi.fn(async () => ({
			stdout: Buffer.from(
				JSON.stringify([{ sessionId: "c1", kind: "interactive", status: "busy" }]),
			),
			exitCode: 0,
			truncated: false,
			timedOut: false,
		}));
		// 3.0d: full write authorization needs a real container view — the
		// running container with this session's token and both mounts.
		const svc2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: new ConversationStore({ workspaceRoot: root }),
			execCapture: exec,
			captureDocker: {
				inspectCapture: async () => ({
					exists: true,
					running: true,
					token: TOKEN,
					managedMount: true,
					controlMount: true,
					imageId: "sha256:i",
					imageRelay2: true,
				}),
				currentImage: async () => ({ imageId: "sha256:i", relay2: true }),
				probeRelay: async () => true,
			},
		});
		await svc2.reconcile();
		expect(await fs.readFile(hooksFilePath(root, "s1"), "utf8")).toContain("127.0.0.1:47613");
		expect(
			await fs.stat(path.join(root, ".st-control", "s1", "relay.enabled")).then(() => true),
		).toBe(true);
		await expect(fs.stat(hooksFilePath(root, "s2"))).rejects.toThrow();
		expect(dbStubs.sessions.get("s3")).toMatchObject({
			conversation_requested: 0,
			ingest_token_hash: null,
		});
		expect(exec).toHaveBeenCalledWith(
			"s1",
			["claude", "agents", "--json"],
			expect.objectContaining({ timeoutMs: 5000 }),
		);
		const content = await fs.readFile(store.eventsPath("s1", "c1"), "utf8");
		expect(content).toContain('"reason":"backend_restart"');
		expect(content).toContain('"ev":"probe"');
		await svc2.shutdown();
	});
});

describe("§4.2.1 the CLI's task notification is not the person's prompt", () => {
	// The pilot's seq 21–23 (CLI 2.1.308): the subagent ends, 69 ms later a
	// UserPromptSubmit carries a <task-notification> for its Agent tool, and
	// the assistant's next turn (new prompt_id) follows. Synthetic ids only.
	const notification = (toolUseId: string, taskId: string) =>
		[
			"<task-notification>",
			`<task-id>${taskId}</task-id>`,
			`<tool-use-id>${toolUseId}</tool-use-id>`,
			"<status>completed</status>",
			"<summary>Agent completed</summary>",
			"<result>",
			"the subagent's own report text",
			"</result>",
			"</task-notification>",
		].join("\n");

	it("is persisted as internal_prompt without text, keeps the turn correlation and leaves the title", async () => {
		session("s1");
		const ingest = (body: Record<string, unknown>) =>
			service.ingest("s1", "%0", hook(String(body.hook_event_name), body));
		await ingest({
			hook_event_name: "UserPromptSubmit",
			prompt: "Run the audit with a subagent",
			prompt_id: "p1",
		});
		await ingest({
			hook_event_name: "PreToolUse",
			prompt_id: "p1",
			tool_name: "Agent",
			tool_use_id: "toolu_01NrcdMjX7yQ2bK9vTz3Lm4W",
			tool_input: {
				subagent_type: "Explore",
				description: "audit files",
				prompt: "secret instructions",
			},
		});
		await ingest({
			hook_event_name: "SubagentStart",
			prompt_id: "p1",
			agent_id: "afc95b2b37cb620a1",
			agent_type: "Explore",
		});
		await ingest({
			hook_event_name: "SubagentStop",
			prompt_id: "p1",
			agent_id: "afc95b2b37cb620a1",
			agent_type: "Explore",
			stop_hook_active: false,
			last_assistant_message: "the subagent's own report text",
		});
		// seq 22: the synthetic prompt, with the NEXT turn's prompt_id.
		await ingest({
			hook_event_name: "UserPromptSubmit",
			prompt: notification("toolu_01NrcdMjX7yQ2bK9vTz3Lm4W", "afc95b2b37cb620a1"),
			prompt_id: "p2",
		});
		expect(store.getResidentIndex("s1", "c1")?.state.status).toBe("running");
		await ingest({
			hook_event_name: "MessageDisplay",
			prompt_id: "p2",
			message_id: "m2",
			index: 0,
			final: true,
			delta: "Continuing.",
		});
		await ingest({
			hook_event_name: "Stop",
			prompt_id: "p2",
			stop_hook_active: false,
			last_assistant_message: "Continuing.",
		});

		const events = await readEvents("s1", "c1");
		expect(events.map((e) => e.ev)).toEqual([
			"user_prompt",
			"tool_start",
			"agent_start",
			"agent_end",
			"internal_prompt",
			"assistant_delta",
			"turn_end",
		]);
		const internal = events[4] as unknown as { prompt_id: string; data: Record<string, unknown> };
		expect(internal.prompt_id).toBe("p2");
		expect(internal.data).toEqual({
			notice: "task-notification",
			task_id: "afc95b2b37cb620a1",
			tool_use_id: "toolu_01NrcdMjX7yQ2bK9vTz3Lm4W",
			status: "completed",
			prompt_bytes: expect.any(Number),
		});
		// The result is stored once, in agent_end; the notification carries no text.
		const line = JSON.stringify(internal);
		expect(line).not.toContain("subagent's own report");
		expect(line).not.toContain("<task-notification>");
		// Turn correlation intact: the Stop for p2 found its prompt (no missing_prompt gap)…
		expect(events.filter((e) => e.ev === "gap")).toEqual([]);
		const index = store.getResidentIndex("s1", "c1");
		expect(index?.lastPromptId).toBe("p2");
		// …the state followed the turn, and the title is still the person's prompt.
		expect(index?.state.status).toBe("waiting_input");
		expect(index?.title).toBe("Run the audit with a subagent");
	});

	it("a notification as the first prompt gives no title; a duplicate delivery is deduped by prompt_id", async () => {
		session("s1");
		const body = {
			hook_event_name: "UserPromptSubmit",
			prompt: notification("toolu_01SuzrSX6G4ikw9fPVXhR188", "btesl5hn3"),
			prompt_id: "p7",
		};
		await service.ingest("s1", "%0", hook("UserPromptSubmit", body));
		await service.ingest("s1", "%0", hook("UserPromptSubmit", body));
		const events = await readEvents("s1", "c1");
		expect(events.map((e) => e.ev)).toEqual(["internal_prompt"]);
		expect(store.getResidentIndex("s1", "c1")?.title).toBeNull();
	});

	it("an unverifiable notification shape is a user_prompt marked unverified and never the title", async () => {
		session("s1");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", {
				prompt: notification("not-a-tool-use-id", "btesl5hn3"),
				prompt_id: "p1",
			}),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "real question", prompt_id: "p2" }),
		);
		const events = await readEvents("s1", "c1");
		expect(events.map((e) => [e.ev, e.data.origin ?? null])).toEqual([
			["user_prompt", "unverified"],
			["user_prompt", null],
		]);
		expect(store.getResidentIndex("s1", "c1")?.title).toBe("real question");
	});
});

describe("§4.6 turn correlation survives late persistence and restarts (Work P2-2)", () => {
	// A StoreFs whose appendFile parks every write while `hold` is on until
	// the test releases it, and reports when the write is really on disk:
	// the deterministic barrier for "ingested, not yet persisted".
	function gatedFs() {
		const parked: Array<{ data: string; release: () => void; done: Promise<void> }> = [];
		let hold = false;
		return {
			parked,
			holdWrites(on: boolean) {
				hold = on;
			},
			/** Wait (bounded) until `n` writes are parked. */
			async parkedCount(n: number): Promise<number> {
				for (let i = 0; i < 2000 && parked.length < n; i++) {
					await new Promise((r) => setImmediate(r));
				}
				return parked.length;
			},
			/** Release the parked write whose line contains `needle`; resolves once it is ON DISK. */
			release(needle: string): Promise<void> {
				const i = parked.findIndex((p) => p.data.includes(needle));
				if (i === -1) throw new Error(`no parked write containing ${needle}`);
				const [p] = parked.splice(i, 1);
				p.release();
				// On disk, plus one turn for appendOne's bookkeeping after its await.
				return p.done.then(() => new Promise((r) => setImmediate(r)));
			},
			async releaseAll(): Promise<void> {
				const all = parked.splice(0);
				for (const p of all) p.release();
				await Promise.all(all.map((p) => p.done));
				await new Promise((r) => setImmediate(r));
			},
			fs: {
				mkdir: (p: string, o: { recursive: true }) => fs.mkdir(p, o),
				appendFile: async (p: string, data: string) => {
					if (!hold) return fs.appendFile(p, data);
					let finish: () => void = () => {};
					const done = new Promise<void>((r) => {
						finish = r;
					});
					await new Promise<void>((release) => parked.push({ data, release, done }));
					try {
						await fs.appendFile(p, data);
					} finally {
						finish();
					}
				},
				writeFile: (p: string, d: string) => fs.writeFile(p, d),
				rename: (a: string, b: string) => fs.rename(a, b),
				rm: (p: string, o: { force: true; recursive?: boolean }) => fs.rm(p, o),
				stat: (p: string) => fs.stat(p),
				readFile: (p: string, e: "utf8") => fs.readFile(p, e),
				readdir: (p: string) => fs.readdir(p),
			} as StoreFs,
		};
	}
	const NOTICE = [
		"<task-notification>",
		"<task-id>afc95b2b37cb620a1</task-id>",
		"<tool-use-id>toolu_01NrcdMjX7yQ2bK9vTz3Lm4W</tool-use-id>",
		"<status>completed</status>",
		"</task-notification>",
	].join("\n");

	it("Work's interleaving: p1 write pending → internal_prompt p2 → p1 lands → Stop p2 with p2 pending ⇒ no gap", async () => {
		session("s1");
		const gate = gatedFs();
		const gstore = new ConversationStore({ workspaceRoot: root, now: () => now, fs: gate.fs });
		const gservice = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: gstore,
			now: () => now,
		});
		try {
			gate.holdWrites(true);
			// 1. p1 ingested; its write parks.
			await gservice.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: "first", prompt_id: "p1" }),
			);
			expect(await gate.parkedCount(1)).toBe(1);
			expect(gate.parked.map((p) => JSON.parse(p.data).prompt_id)).toEqual(["p1"]);
			const index = gstore.getResidentIndex("s1", "c1");
			expect([index?.lastPromptId, index?.persistedPromptId]).toEqual(["p1", null]);
			// 2. internal_prompt p2 ingested: the live correlation moves to p2; its write queues behind p1.
			await gservice.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: NOTICE, prompt_id: "p2" }),
			);
			expect(index?.lastPromptId).toBe("p2");
			// 3. p1's write completes — it must NOT take the correlation back.
			await gate.release('"prompt_id":"p1"');
			expect([index?.lastPromptId, index?.persistedPromptId]).toEqual(["p2", "p1"]);
			// p2's write is now the parked one.
			expect(await gate.parkedCount(1)).toBe(1);
			expect(gate.parked.map((p) => JSON.parse(p.data).ev)).toEqual(["internal_prompt"]);
			// 4. Stop p2 arrives while p2 is still not on disk.
			await gservice.ingest(
				"s1",
				"%0",
				hook("Stop", { prompt_id: "p2", stop_hook_active: false, last_assistant_message: "done" }),
			);
			// 5. Everything lands; the file holds the three events and no gap.
			gate.holdWrites(false);
			await gate.releaseAll();
			await gstore.flush("s1", "c1");
			const lines = (await fs.readFile(gstore.eventsPath("s1", "c1"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as { ev: string; prompt_id: string | null });
			expect(lines.map((l) => [l.ev, l.prompt_id])).toEqual([
				["user_prompt", "p1"],
				["internal_prompt", "p2"],
				["turn_end", "p2"],
			]);
			expect([index?.lastPromptId, index?.persistedPromptId, index?.gapsCount]).toEqual([
				"p2",
				"p2",
				0,
			]);
		} finally {
			gate.holdWrites(false);
			await gate.releaseAll();
			await gservice.shutdown();
		}
	});

	it("restart: the correlation is rebuilt from the file, never from the dead process's memory", async () => {
		session("s1");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "first", prompt_id: "p1" }),
		);
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: NOTICE, prompt_id: "p2" }));
		await service.ingest(
			"s1",
			"%0",
			hook("MessageDisplay", {
				prompt_id: "p2",
				message_id: "m",
				index: 0,
				final: true,
				delta: "x",
			}),
		);
		await store.flush("s1", "c1");
		await service.shutdown();
		const indexPath = store.indexPath("s1", "c1");

		// (a) A clean snapshot: live = persisted = the newest prompt on disk.
		const s2 = new ConversationStore({ workspaceRoot: root, now: () => now });
		const i2 = await s2.open("s1", "c1");
		expect([i2.lastPromptId, i2.persistedPromptId, i2.eventsCount]).toEqual(["p2", "p2", 3]);
		// A new process's Stop p2 finds its prompt: no missing_prompt gap.
		const svc2 = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: s2,
			now: () => now,
		});
		await svc2.ingest(
			"s1",
			"%0",
			hook("Stop", { prompt_id: "p2", stop_hook_active: false, last_assistant_message: "r2" }),
		);
		await s2.flush("s1", "c1");
		await svc2.shutdown();
		const afterStop = (await fs.readFile(s2.eventsPath("s1", "c1"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l).ev);
		expect(afterStop).toEqual(["user_prompt", "internal_prompt", "assistant_delta", "turn_end"]);

		// (b) A snapshot whose LIVE value (p3) never reached the disk is not believed.
		const snap = JSON.parse(await fs.readFile(indexPath, "utf8"));
		await fs.writeFile(
			indexPath,
			JSON.stringify({ ...snap, lastPromptId: "p3", persistedPromptId: "p2" }),
		);
		const i3 = await new ConversationStore({ workspaceRoot: root, now: () => now }).open(
			"s1",
			"c1",
		);
		expect([i3.lastPromptId, i3.persistedPromptId]).toEqual(["p2", "p2"]);

		// (c) A stale snapshot (offset behind the file): the re-scanned tail advances both.
		await fs.writeFile(
			indexPath,
			JSON.stringify({ ...snap, lastPromptId: "p0", persistedPromptId: "p0", offset: 0 }),
		);
		const i4 = await new ConversationStore({ workspaceRoot: root, now: () => now }).open(
			"s1",
			"c1",
		);
		expect([i4.lastPromptId, i4.persistedPromptId, i4.eventsCount]).toEqual(["p2", "p2", 4]);

		// (d) No snapshot at all: a full rebuild from the file.
		await fs.rm(indexPath);
		const i5 = await new ConversationStore({ workspaceRoot: root, now: () => now }).open(
			"s1",
			"c1",
		);
		expect([i5.lastPromptId, i5.persistedPromptId, i5.eventsCount]).toEqual(["p2", "p2", 4]);
	});
});
