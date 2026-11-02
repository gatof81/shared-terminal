/**
 * service.reconciliation.test.ts — CONVERSATION.md v1.7.2 (Chat backend
 * P1): the resumed conversation that sat at "not at its prompt", background
 * jobs, the §5.3 silence, restarts and container recreation. Harness copied
 * from service.test.ts — the orchestrator against a real temp directory and a
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

import {
	SILENCE_PROBE_AFTER_MS,
	TARGETED_PROBE_DELAY_MS,
	UNKNOWN_AFTER_SILENCE_MS,
} from "./limits.js";
import { PROBE_ARGV, type ProbeEntry } from "./probe.js";

// ── A container behind execCapture: the probe, tmux display, the ancestry ──

interface FakeContainer {
	probe: ProbeEntry[] | null;
	/** `tmux display -p -t <pane>` per pane; missing = the pane does not exist. */
	panes: Map<string, string>;
	/** "yes" / "no" per `pid:panePid`; missing = "no". */
	ancestry: Map<string, string>;
	calls: string[][];
}

let box: FakeContainer;
const PANE_PID = 2158;
const CLAUDE_PID = 2307;
const BG_PID = 261394;

function makeService(): ConversationService {
	return new ConversationService({
		workspaceRoot: root,
		enabled: true,
		port: 3001,
		store,
		now: () => now,
		execCapture: async (_sid, cmd) => {
			box.calls.push(cmd);
			const out = (s: string, exitCode = 0) => ({
				stdout: Buffer.from(s),
				exitCode,
				truncated: false,
				timedOut: false,
			});
			if (cmd.join(" ") === PROBE_ARGV.join(" ")) {
				return box.probe ? out(JSON.stringify(box.probe)) : out("", 1);
			}
			if (cmd.includes("display")) {
				const pane = cmd[cmd.indexOf("-t") + 1]!;
				const st = box.panes.get(pane);
				return st ? out(`${st}\n`) : out("", 1);
			}
			if (cmd.includes("st-ancestry")) {
				const [pid, target] = cmd.slice(-2);
				return out(`${box.ancestry.get(`${pid}:${target}`) ?? "no"}\n`);
			}
			return out("", 127);
		},
	});
}

beforeEach(async () => {
	box = {
		probe: null,
		panes: new Map([["%0", `${PANE_PID} 0 0 claude`]]),
		ancestry: new Map([
			[`${CLAUDE_PID}:${PANE_PID}`, "yes"],
			[`${BG_PID}:${PANE_PID}`, "yes"],
		]),
		calls: [],
	};
	await service.shutdown();
	service = makeService();
});

const PANE = { st: { pane: "%0", tmux_session: "tab-1" } };
const interactive = (cid: string, status: ProbeEntry["status"] = "idle"): ProbeEntry => ({
	sessionId: cid,
	kind: "interactive",
	pid: CLAUDE_PID,
	...(status ? { status } : {}),
});

async function state(cid: string) {
	await store.flush("s1", cid);
	return (await service.summaries("s1")).find((x) => x.sessionId === cid);
}

async function resumeIdle(cid = "old") {
	session("s1");
	await service.ingest("s1", "%0", hook("SessionStart", { source: "resume", ...PANE }, cid));
}

describe("v1.7.2 — the resumed conversation (Educación HZ, 'not at its prompt')", () => {
	it("a resume left `unknown` is resolved by the targeted probe when the interactive CLI in that pane is idle", async () => {
		vi.useFakeTimers();
		try {
			box.probe = [interactive("old")];
			await resumeIdle();
			expect((await state("old"))?.status).toBe("unknown");
			now += TARGETED_PROBE_DELAY_MS;
			await vi.advanceTimersByTimeAsync(TARGETED_PROBE_DELAY_MS);
			expect(await state("old")).toMatchObject({
				status: "waiting_input",
				statusEvidence: "probe:idle",
				paneId: "%0",
			});
			const probes = (await readEvents("s1", "old")).filter((e) => e.ev === "probe");
			expect(probes.at(-1)?.data).toMatchObject({
				kind: "interactive",
				verified: true,
				applied: true,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("a background job for the cid that DESCENDS from the pane does not count: stays `unknown`", async () => {
		vi.useFakeTimers();
		try {
			box.probe = [{ sessionId: "old", kind: "background", pid: BG_PID, status: "idle" }];
			await resumeIdle();
			now += TARGETED_PROBE_DELAY_MS;
			await vi.advanceTimersByTimeAsync(TARGETED_PROBE_DELAY_MS);
			expect((await state("old"))?.status).toBe("unknown");
			const probes = (await readEvents("s1", "old")).filter((e) => e.ev === "probe");
			expect(probes.at(-1)?.data).toMatchObject({
				kind: "background",
				verified: false,
				applied: false,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("an interactive entry whose pid is not under the bound pane, or a pane that no longer exists: stays `unknown`", async () => {
		box.probe = [{ ...interactive("old"), pid: 9999 }];
		await resumeIdle();
		await service.probeAndApply("s1");
		expect((await state("old"))?.status).toBe("unknown");
		box.probe = [interactive("old")];
		box.panes.clear();
		await service.probeAndApply("s1");
		expect((await state("old"))?.status).toBe("unknown");
	});

	it("an entry with no readable status is not `idle`", async () => {
		box.probe = [{ sessionId: "old", kind: "interactive", pid: CLAUDE_PID }];
		await resumeIdle();
		await service.probeAndApply("s1");
		expect((await state("old"))?.status).toBe("unknown");
		const probes = (await readEvents("s1", "old")).filter((e) => e.ev === "probe");
		expect(probes.at(-1)?.data).toMatchObject({ status: null, applied: false });
	});

	it("busy applies without verification (it never enables a send)", async () => {
		box.probe = [{ sessionId: "old", kind: "background", pid: BG_PID, status: "busy" }];
		await resumeIdle();
		await service.probeAndApply("s1");
		expect((await state("old"))?.status).toBe("running");
	});

	it("a probe never revives an ended conversation; a hook does", async () => {
		vi.useFakeTimers();
		try {
			session("s1");
			await service.ingest("s1", "%0", hook("SessionStart", { source: "startup", ...PANE }, "c1"));
			await service.ingest("s1", "%0", hook("SessionEnd", { reason: "prompt_input_exit" }, "c1"));
			now += 6_000;
			await vi.advanceTimersByTimeAsync(6_000);
			expect((await state("c1"))?.status).toBe("ended");
			box.probe = [interactive("c1", "busy")];
			await service.probeAndApply("s1");
			expect((await state("c1"))?.status).toBe("ended");
			box.probe = [interactive("c1")];
			await service.probeAndApply("s1");
			expect((await state("c1"))?.status).toBe("ended");
			await service.ingest("s1", "%0", hook("SessionStart", { source: "resume", ...PANE }, "c1"));
			expect((await state("c1"))?.status).toBe("unknown");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a Terminal prompt still moves it the ordinary way (running → waiting_input by hook)", async () => {
		await resumeIdle();
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "hola", prompt_id: "p1" }, "old"),
		);
		await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1" }, "old"));
		expect(await state("old")).toMatchObject({
			status: "waiting_input",
			statusEvidence: "hook:Stop",
		});
	});
});

describe("v1.7.2 — §5.3 silence", () => {
	async function waitingAt(cid = "c1") {
		session("s1");
		await service.ingest("s1", "%0", hook("SessionStart", { source: "startup", ...PANE }, cid));
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }, cid),
		);
		await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1" }, cid));
		expect((await state(cid))?.status).toBe("waiting_input");
	}

	it("a conversation really waiting at its prompt is re-confirmed by a probe and never decays", async () => {
		await waitingAt();
		box.probe = [interactive("c1")];
		for (let i = 0; i < 6; i++) {
			now += SILENCE_PROBE_AFTER_MS;
			await service.sweepSilence();
			expect(await state("c1")).toMatchObject({
				status: "waiting_input",
				statusEvidence: "probe:idle",
			});
		}
		expect(Date.parse((await state("c1"))!.statusAt)).toBe(now);
	});

	it("no evidence for 10 min (probe failing) ⇒ unknown · timeout; before that nothing changes", async () => {
		await waitingAt();
		box.probe = null;
		now += SILENCE_PROBE_AFTER_MS;
		await service.sweepSilence();
		expect((await state("c1"))?.status).toBe("waiting_input");
		now += UNKNOWN_AFTER_SILENCE_MS - SILENCE_PROBE_AFTER_MS;
		await service.sweepSilence();
		expect(await state("c1")).toMatchObject({ status: "unknown", statusEvidence: "timeout" });
	});

	it("an unverified idle (background job) is not evidence: the claim still decays", async () => {
		await waitingAt();
		box.probe = [{ sessionId: "c1", kind: "background", pid: BG_PID, status: "idle" }];
		now += UNKNOWN_AFTER_SILENCE_MS;
		await service.sweepSilence();
		expect(await state("c1")).toMatchObject({ status: "unknown", statusEvidence: "timeout" });
	});

	it("a long turn that keeps emitting hooks is never probed nor decayed", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }));
		for (let i = 0; i < 20; i++) {
			now += 60_000;
			await service.ingest(
				"s1",
				"%0",
				hook("PreToolUse", {
					prompt_id: "p1",
					tool_name: "Bash",
					tool_use_id: `t${i}`,
					tool_input: {},
				}),
			);
			await service.sweepSilence();
		}
		expect((await state("c1"))?.status).toBe("running");
		expect(box.calls.filter((c) => c.join(" ") === PROBE_ARGV.join(" "))).toHaveLength(0);
	});

	it("unknown and ended are not live claims: the sweep leaves them (and probes nothing for them)", async () => {
		await resumeIdle();
		now += UNKNOWN_AFTER_SILENCE_MS * 2;
		await service.sweepSilence();
		expect((await state("old"))?.status).toBe("unknown");
		expect(box.calls).toHaveLength(0);
	});
});

describe("v1.7.2 — bindings across stops, restarts and recreation (§5.2)", () => {
	async function boundIn(cid: string) {
		session("s1");
		await service.ingest("s1", "%0", hook("SessionStart", { source: "startup", ...PANE }, cid));
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }, cid),
		);
		await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1" }, cid));
	}
	const onPane = async (pane: string) =>
		(await service.summaries("s1"))
			.filter((x) => x.paneId === pane)
			.map((x) => x.sessionId)
			.sort();

	it("a stop releases EVERY conversation's binding — resident or only on disk — and leaves the events untouched", async () => {
		await boundIn("a");
		await store.flush("s1", "a");
		const eventsBefore = await fs.readFile(store.eventsPath("s1", "a"), "utf8");
		// Restart: a new process with no runtime for `a`.
		await service.shutdown();
		store = new ConversationStore({ workspaceRoot: root, now: () => now });
		service = makeService();
		await boundIn("b");
		await service.onSessionDown("s1");
		const all = await service.summaries("s1");
		expect(all.map((x) => [x.sessionId, x.status, x.paneId, x.tabId]).sort()).toEqual([
			["a", "disconnected", null, null],
			["b", "disconnected", null, null],
		]);
		expect(await fs.readFile(store.eventsPath("s1", "a"), "utf8")).toBe(eventsBefore);
	});

	it("recreation: after O stops, N's %0 is never inherited — only the conversation that reports from it binds", async () => {
		await boundIn("cur");
		await service.onSessionDown("s1");
		now += 60_000;
		await resumeIdle("old");
		expect(await onPane("%0")).toEqual(["old"]);
		expect((await state("cur"))?.status).toBe("disconnected");
	});

	it("an evicted (non-resident) holder of the pane loses it when another conversation binds there", async () => {
		await boundIn("cur");
		await store.flush("s1", "cur");
		await store.close("s1", "cur"); // G4 eviction: runtime kept, index not resident
		await resumeIdle("old");
		await vi.waitFor(async () => expect(await onPane("%0")).toEqual(["old"]));
		expect(await state("cur")).toMatchObject({ status: "unknown", statusEvidence: "binding_lost" });
	});

	it("a probe that finds no process releases the pane (ended · probe:absent)", async () => {
		await boundIn("cur");
		box.probe = [];
		await service.probeAndApply("s1");
		expect(await state("cur")).toMatchObject({
			status: "ended",
			statusEvidence: "probe:absent",
			paneId: null,
		});
	});

	it("boot reconcile releases the bindings a stop left behind before this rule (session found stopped)", async () => {
		await boundIn("cur");
		await store.flush("s1", "cur");
		await service.shutdown();
		store = new ConversationStore({ workspaceRoot: root, now: () => now });
		service = makeService();
		session("s1", { status: "stopped" });
		await service.reconcile();
		expect(await state("cur")).toMatchObject({ paneId: null, status: "disconnected" });
	});

	it("an unresolved recreation is never written: reconcile leaves its bindings alone", async () => {
		await boundIn("cur");
		await store.flush("s1", "cur");
		await service.shutdown();
		store = new ConversationStore({ workspaceRoot: root, now: () => now });
		service = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store,
			now: () => now,
			isRecreateUnresolved: async () => true,
		});
		session("s1", { status: "stopped" });
		await service.reconcile();
		expect((await state("cur"))?.paneId).toBe("%0");
	});
});
