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
	/** Gate test: parks owner reservations (an ingest mid-flight) while set. */
	holdOwner: null as Promise<void> | null,
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		dbStubs.calls.push(sql);
		if (dbStubs.holdOwner && /^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			await dbStubs.holdOwner;
		}
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
					tab_id: params[6],
					pane_id: params[7],
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
		if (/^UPDATE claude_conversations SET pane_id = NULL/.test(sql)) {
			// releaseConversationBinding (v1.7.2): [status_at, cid, owner]
			const row = dbStubs.conversations.get(String(params[1]));
			if (row && row.st_session_id === params[2]) {
				row.pane_id = null;
				row.tab_id = null;
				row.status = "disconnected";
				row.status_evidence = "reconcile";
				row.status_at = params[0];
			}
			return { results: [], success: true, meta: {} };
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
				row.tab_id = params[4];
				row.pane_id = params[5];
			}
			return { results: [], success: true, meta: {} };
		}
		// v1.8 §6.2: the list now reads rows + owner metadata in one query (no metadata here).
		if (/^SELECT 'c' AS src/.test(sql)) {
			const rows = Array.from(dbStubs.conversations.values())
				.filter((r) => r.st_session_id === params[0])
				.map((r) => ({
					src: "c",
					meta_cid: r.session_id,
					meta_custom_title: null,
					meta_archived_at: null,
					...r,
				}));
			return { results: rows, success: true, meta: {} };
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
	dbStubs.holdOwner = null;
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
	SESSION_END_GRACE_MS,
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

describe("v1.7.2 integrity gate (#505 review)", () => {
	async function boundIn(cid: string) {
		session("s1");
		await service.ingest("s1", "%0", hook("SessionStart", { source: "startup", ...PANE }, cid));
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }, cid),
		);
		await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1" }, cid));
		await store.flush("s1", cid);
		await service.shutdown(); // flushes the heartbeat: the D1 row carries the binding
	}
	const releaseWrites = () =>
		dbStubs.calls.filter((q) => /^UPDATE claude_conversations SET pane_id = NULL/.test(q)).length;
	const indexOnDisk = async (cid: string) =>
		JSON.parse(await fs.readFile(store.indexPath("s1", cid), "utf8")) as {
			paneId: string | null;
			tabId: string | null;
			state: { status: string; at: number };
		};
	async function restart(storeFs?: StoreFs) {
		await service.shutdown();
		store = new ConversationStore({
			workspaceRoot: root,
			now: () => now,
			...(storeFs ? { fs: storeFs } : {}),
		});
		service = makeService();
	}

	// 1 — idempotent and recoverable
	it("1a: releaseBindings is idempotent — a second stop writes nothing and keeps status_at", async () => {
		await boundIn("a");
		await service.onSessionDown("s1");
		const first = await indexOnDisk("a");
		const writes = releaseWrites();
		const d1Updates = dbStubs.calls.length;
		now += 60_000;
		await service.onSessionDown("s1");
		expect(releaseWrites(), "no D1 release on the second run").toBe(writes);
		expect(
			dbStubs.calls.slice(d1Updates).filter((q) => /^UPDATE claude_conversations/.test(q)),
		).toHaveLength(0);
		expect(await indexOnDisk("a")).toEqual(first);
	});

	it("1b: D1 failing during the stop — the index is released, the row is completed by the boot reconcile", async () => {
		await boundIn("a");
		expect(dbStubs.conversations.get("a")).toMatchObject({ pane_id: "%0" });
		dbStubs.fail = true;
		await service.onSessionDown("s1");
		expect((await indexOnDisk("a")).paneId).toBeNull();
		expect(dbStubs.conversations.get("a"), "D1 still stale after the failed write").toMatchObject({
			pane_id: "%0",
		});
		dbStubs.fail = false;
		await restart();
		session("s1", { status: "stopped" });
		await service.reconcile();
		expect(dbStubs.conversations.get("a")).toMatchObject({
			pane_id: null,
			tab_id: null,
			status: "disconnected",
		});
	});

	it("1c: the snapshot write failing — memory keeps the released state, the next run makes it durable", async () => {
		await boundIn("a");
		let failIndex = true;
		const flaky: StoreFs = {
			mkdir: (p, o) => fs.mkdir(p, o),
			appendFile: (p, d) => fs.appendFile(p, d),
			writeFile: async (p, d) => {
				if (failIndex && String(p).includes(".index.json")) throw new Error("ENOSPC");
				return fs.writeFile(p, d);
			},
			rename: (a, b) => fs.rename(a, b),
			rm: (p, o) => fs.rm(p, o),
			stat: (p) => fs.stat(p),
			readFile: (p, e) => fs.readFile(p, e),
			readdir: (p) => fs.readdir(p),
		} as StoreFs;
		await restart(flaky);
		await service.onSessionDown("s1");
		expect((await indexOnDisk("a")).paneId, "disk still stale").toBe("%0");
		expect(
			store.getResidentIndex("s1", "a")?.paneId,
			"memory answers the released state",
		).toBeNull();
		expect((await service.summaries("s1"))[0]).toMatchObject({
			paneId: null,
			status: "disconnected",
		});
		failIndex = false;
		await service.onSessionDown("s1");
		expect(await indexOnDisk("a")).toMatchObject({
			paneId: null,
			state: { status: "disconnected" },
		});
	});

	// 2 — non-resident conversations, recreation
	it("2: a conversation known only on disk (never loaded by this process) loses its binding on stop/recreate", async () => {
		await boundIn("a");
		await restart();
		expect(service.runtimeFor("a")).toBeUndefined();
		await service.onSessionDown("s1");
		expect(await indexOnDisk("a")).toMatchObject({
			paneId: null,
			tabId: null,
			state: { status: "disconnected" },
		});
		expect(dbStubs.conversations.get("a")).toMatchObject({ pane_id: null, status: "disconnected" });
		// N starts and another conversation reports from %0.
		await resumeIdle("n1");
		const onPane = (await service.summaries("s1"))
			.filter((x) => x.paneId === "%0")
			.map((x) => x.sessionId);
		expect(onPane).toEqual(["n1"]);
	});

	// 3 — a reused pane never enables the composer for an earlier conversation
	it("3: after a stop, a verified idle probe in the NEW start does not hand %0 back to the earlier conversation", async () => {
		await boundIn("a");
		await service.onSessionDown("s1");
		await resumeIdle("n1");
		// Even if the new start's probe listed `a` (pid numbers are reused) as
		// idle, interactive and under %0, `a` has no binding: nothing verifies.
		box.probe = [interactive("a"), interactive("n1")];
		await service.probeAndApply("s1");
		const a = await state("a");
		expect(a).toMatchObject({ paneId: null });
		expect(a?.status).not.toBe("waiting_input");
		expect((await state("n1"))?.status).toBe("waiting_input");
	});

	// 4 — events stay intact; new ones are appended
	it("4: the original events are byte-identical after stop, probes and reconcile; later lines only append with growing seq", async () => {
		await boundIn("a");
		const before = await fs.readFile(store.eventsPath("s1", "a"), "utf8");
		box.probe = [interactive("a")];
		await service.probeAndApply("s1");
		await service.onSessionDown("s1");
		await restart();
		session("s1", { status: "stopped" });
		await service.reconcile();
		await store.flush("s1", "a");
		const after = await fs.readFile(store.eventsPath("s1", "a"), "utf8");
		expect(after.startsWith(before), "the earlier bytes were rewritten").toBe(true);
		const seqs = after
			.split("\n")
			.filter(Boolean)
			.map((l) => (JSON.parse(l) as { seq: number }).seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	// 5 — late work from the previous start
	it("5a: a probe of O that answers after the stop and N's first hook re-enables nothing", async () => {
		session("s1");
		let answer!: (entries: ProbeEntry[]) => void;
		const late = new Promise<ProbeEntry[]>((r) => {
			answer = r;
		});
		service = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store,
			now: () => now,
			execCapture: async (_sid, cmd) => {
				const out = (s: string) => ({
					stdout: Buffer.from(s),
					exitCode: 0,
					truncated: false,
					timedOut: false,
				});
				if (cmd.join(" ") === PROBE_ARGV.join(" ")) return out(JSON.stringify(await late));
				if (cmd.includes("display")) return out(`${PANE_PID} 0 0 claude\n`);
				if (cmd.includes("st-ancestry")) return out("yes\n");
				return out("");
			},
		});
		await service.ingest("s1", "%0", hook("SessionStart", { source: "startup", ...PANE }, "x"));
		const inFlight = service.probeAndApply("s1"); // O's probe, held
		await service.onSessionDown("s1"); // O stops (recreate)
		await service.ingest("s1", "%0", hook("SessionStart", { source: "resume", ...PANE }, "x")); // N
		answer([interactive("x")]); // O's late answer: "x idle, interactive, under %0"
		expect(await inFlight, "the late probe is discarded").toBe(false);
		expect((await state("x"))?.status).toBe("unknown");
		const probes = (await readEvents("s1", "x")).filter((e) => e.ev === "probe");
		expect(probes).toHaveLength(0);
	});

	it("5b: a hook of O still being ingested when the stop lands does not bind %0 (not_running)", async () => {
		session("s1");
		let open!: () => void;
		dbStubs.holdOwner = new Promise<void>((r) => {
			open = r;
		});
		const late = service.ingest(
			"s1",
			"%0",
			hook("SessionStart", { source: "startup", ...PANE }, "old"),
		);
		await vi.waitFor(() =>
			expect(dbStubs.calls.some((q) => /^INSERT OR IGNORE INTO claude_conversations/.test(q))).toBe(
				true,
			),
		);
		await service.onSessionDown("s1");
		dbStubs.holdOwner = null;
		open();
		expect(await late).toEqual({ accepted: false, reason: "not_running" });
		await resumeIdle("n1");
		const onPane = (await service.summaries("s1"))
			.filter((x) => x.paneId === "%0")
			.map((x) => x.sessionId);
		expect(onPane).toEqual(["n1"]);
	});

	// 6 — bounded probing
	it("6a: concurrent sweeps and a targeted probe share ONE probe exec per session", async () => {
		vi.useFakeTimers();
		try {
			session("s1");
			await service.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }, "c1"),
			);
			await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1" }, "c1"));
			box.probe = [interactive("c1")];
			now += SILENCE_PROBE_AFTER_MS;
			await Promise.all([
				service.sweepSilence(),
				service.sweepSilence(),
				service.probeAndApply("s1"),
			]);
			expect(box.calls.filter((c) => c.join(" ") === PROBE_ARGV.join(" "))).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("6b: a session whose probe keeps failing is probed a bounded number of times, then left alone", async () => {
		session("s1");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }, "c1"),
		);
		await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1" }, "c1"));
		box.probe = null; // fails every time
		// One sweep per minute for an hour.
		for (let m = 0; m < 60; m++) {
			now += 60_000;
			await service.sweepSilence();
		}
		const probes = box.calls.filter((c) => c.join(" ") === PROBE_ARGV.join(" ")).length;
		// due from minute 8 until it decays at minute 10: at most 3, then `unknown` (not a live claim).
		expect(probes).toBeLessThanOrEqual(3);
		expect((await state("c1"))?.status).toBe("unknown");
	});

	it("6c: a waiting conversation that is re-confirmed costs one probe per ~8 min, not one per sweep", async () => {
		session("s1");
		await service.ingest("s1", "%0", hook("SessionStart", { source: "startup", ...PANE }, "c1"));
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "a", prompt_id: "p1" }, "c1"),
		);
		await service.ingest("s1", "%0", hook("Stop", { prompt_id: "p1" }, "c1"));
		box.probe = [interactive("c1")];
		for (let m = 0; m < 60; m++) {
			now += 60_000;
			await service.sweepSilence();
		}
		const probes = box.calls.filter((c) => c.join(" ") === PROBE_ARGV.join(" ")).length;
		expect(probes).toBeLessThanOrEqual(8);
		expect(probes).toBeGreaterThanOrEqual(6);
		expect((await state("c1"))?.status).toBe("waiting_input");
	});
});

describe("v1.8.5 — who may hold a pane (§5.2): resume, takeover and the children of a pane", () => {
	const panes = async () =>
		Object.fromEntries((await service.summaries("s1")).map((x) => [x.sessionId, x.paneId]));
	async function interactiveIn(cid: string, source = "startup") {
		session("s1");
		await service.ingest("s1", "%0", hook("SessionStart", { source, ...PANE }, cid));
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "a", prompt_id: `p-${cid}` }, cid),
		);
	}

	it("a `claude -p` started from the interactive conversation's Bash (same pane) does not take the pane", async () => {
		await interactiveIn("main");
		await service.ingest(
			"s1",
			"%0",
			hook(
				"SessionStart",
				{ source: "startup", st: { pane: "%0", tmux_session: "tab-1", argv_flags: ["-p"] } },
				"child",
			),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "x", prompt_id: "pc" }, "child"),
		);
		await store.flush("s1", "main");
		await store.flush("s1", "child");
		expect(await panes()).toMatchObject({ main: "%0", child: null });
		expect((await state("main"))?.statusEvidence).not.toBe("binding_lost");
	});

	it("a teammate never takes a held pane, but keeps its own (tmux-mode split pane)", async () => {
		await interactiveIn("main");
		await service.ingest(
			"s1",
			"%0",
			hook(
				"SessionStart",
				{ source: "startup", st: { pane: "%0", argv_flags: ["--agent-name=helper"] } },
				"mate",
			),
		);
		await store.flush("s1", "mate");
		expect(await panes()).toMatchObject({ main: "%0", mate: null });
		await service.ingest(
			"s1",
			"%1",
			hook(
				"SessionStart",
				{ source: "startup", st: { pane: "%1", argv_flags: ["--agent-name=other"] } },
				"mate2",
			),
		);
		await store.flush("s1", "mate2");
		expect(await panes()).toMatchObject({ main: "%0", mate2: "%1" });
	});

	it("a conversation bound as unknown lets go of the pane when its SessionStart shows it is a claude -p", async () => {
		session("s1");
		await service.ingest(
			"s1",
			"%3",
			hook("UserPromptSubmit", { prompt: "x", prompt_id: "pk" }, "kid"),
		);
		await store.flush("s1", "kid");
		expect((await panes()).kid).toBe("%3");
		await service.ingest(
			"s1",
			"%3",
			hook("SessionStart", { source: "startup", st: { pane: "%3", argv_flags: ["-p"] } }, "kid"),
		);
		await store.flush("s1", "kid");
		expect((await panes()).kid).toBeNull();
	});

	it("once the end grace has elapsed the exited holder (ended · hook:SessionEnd) no longer keeps the pane", async () => {
		vi.useFakeTimers();
		try {
			await interactiveIn("done");
			await service.ingest("s1", "%0", hook("SessionEnd", { reason: "prompt_input_exit" }, "done"));
			now += SESSION_END_GRACE_MS + 1;
			await vi.advanceTimersByTimeAsync(SESSION_END_GRACE_MS + 1);
			await service.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: "x", prompt_id: "pg" }, "late"),
			);
			await store.flush("s1", "late");
			expect((await panes()).late).toBe("%0");
		} finally {
			vi.useRealTimers();
		}
	});

	it("an exiting holder still keeps an unknown conversation off the pane until the end grace elapses or the probe finds it gone", async () => {
		await interactiveIn("done");
		await service.ingest("s1", "%0", hook("SessionEnd", { reason: "prompt_input_exit" }, "done"));
		// `ending` (≤ the end grace): the CLI may still be in the pane — no bind.
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "x", prompt_id: "pn" }, "late"),
		);
		await store.flush("s1", "late");
		expect((await panes()).late).toBeNull();
		// The probe finds no process: the holder is released; the next report binds.
		box.probe = [];
		await service.probeAndApply("s1");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "y", prompt_id: "pn2" }, "late"),
		);
		await store.flush("s1", "late");
		expect((await panes()).late).toBe("%0");
	});

	it("a conversation whose SessionStart was never seen (kind unknown) never takes a held pane, but binds a free one", async () => {
		await interactiveIn("main");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "x", prompt_id: "pu" }, "orphan"),
		);
		await store.flush("s1", "orphan");
		expect(await panes()).toMatchObject({ main: "%0", orphan: null });
		// On a free pane it binds (the only reporter there).
		await service.ingest(
			"s1",
			"%1",
			hook("UserPromptSubmit", { prompt: "y", prompt_id: "pf" }, "free"),
		);
		await store.flush("s1", "free");
		expect((await panes()).free).toBe("%1");
	});

	it("a new interactive conversation in the pane (/clear, a new claude) takes it: the old one is binding_lost", async () => {
		await interactiveIn("old");
		now += 1000;
		await interactiveIn("new", "clear");
		expect(await panes()).toMatchObject({ old: null, new: "%0" });
		expect(await state("old")).toMatchObject({ status: "unknown", statusEvidence: "binding_lost" });
	});

	it("resuming the earlier conversation in that pane restores its binding (and releases the other)", async () => {
		await interactiveIn("a");
		now += 1000;
		await interactiveIn("b", "clear");
		now += 1000;
		await service.ingest("s1", "%0", hook("SessionStart", { source: "resume", ...PANE }, "a"));
		expect(await panes()).toMatchObject({ a: "%0", b: null });
	});

	it("an interactive conversation that lost its pane gets it back from its next prompt in that pane", async () => {
		await interactiveIn("a");
		now += 1000;
		await interactiveIn("b", "clear");
		// The person goes back to `a` in that pane (e.g. via the CLI's own switch): its prompt comes from %0.
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "back", prompt_id: "pa2" }, "a"),
		);
		await store.flush("s1", "a");
		expect((await panes()).a).toBe("%0");
	});

	it("a session whose hooks carry no pane (a background Claude session: no TMUX_PANE) is never bound and releases nobody", async () => {
		await interactiveIn("main");
		session("s1");
		await service.ingest(
			"s1",
			undefined,
			hook(
				"SessionStart",
				{ source: "fork", st: { argv_flags: ["--fork-session", "--resume"] } },
				"bg",
			),
		);
		await service.ingest(
			"s1",
			undefined,
			hook("UserPromptSubmit", { prompt: "z", prompt_id: "pb" }, "bg"),
		);
		await store.flush("s1", "bg");
		expect(await panes()).toMatchObject({ main: "%0", bg: null });
		expect((await state("bg"))?.canSendInput).toBe(false);
	});

	it("G4: a teammate/unknown never ends up sharing a pane with an evicted live holder", async () => {
		await interactiveIn("main");
		await store.flush("s1", "main");
		await store.close("s1", "main"); // evicted: runtime kept, index only on disk
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "x", prompt_id: "pu" }, "orphan"),
		);
		await service.ingest(
			"s1",
			"%0",
			hook(
				"SessionStart",
				{ source: "startup", st: { pane: "%0", argv_flags: ["--agent-name=h"] } },
				"mate",
			),
		);
		// Let the async disk checks settle, then read: one holder only.
		await new Promise((r) => setTimeout(r, 20));
		await store.flush("s1", "orphan");
		await store.flush("s1", "mate");
		const p = await panes();
		expect(p).toMatchObject({ main: "%0", orphan: null, mate: null });
		expect(Object.values(p).filter((x) => x === "%0")).toHaveLength(1);
	});

	it("G4: an evicted holder that has ended does not keep a free pane from an unknown", async () => {
		vi.useFakeTimers();
		try {
			await interactiveIn("done");
			await service.ingest("s1", "%0", hook("SessionEnd", { reason: "prompt_input_exit" }, "done"));
			now += SESSION_END_GRACE_MS + 1;
			await vi.advanceTimersByTimeAsync(SESSION_END_GRACE_MS + 1);
			await store.flush("s1", "done");
			await store.close("s1", "done");
			await service.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: "x", prompt_id: "pz" }, "late"),
			);
			await vi.advanceTimersByTimeAsync(20);
			await store.flush("s1", "late");
			await store.flush("s1", "done");
			// One holder: the ended one let go (state kept — not a binding_lost).
			expect(await panes()).toMatchObject({ late: "%0", done: null });
			expect((await state("done"))?.status).toBe("ended");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a resident holder that has ended lets go when an unknown binds the pane: one holder", async () => {
		vi.useFakeTimers();
		try {
			await interactiveIn("done");
			await service.ingest("s1", "%0", hook("SessionEnd", { reason: "prompt_input_exit" }, "done"));
			now += SESSION_END_GRACE_MS + 1;
			await vi.advanceTimersByTimeAsync(SESSION_END_GRACE_MS + 1);
			await service.ingest(
				"s1",
				"%0",
				hook("UserPromptSubmit", { prompt: "x", prompt_id: "pz" }, "late"),
			);
			const p = await panes();
			expect(p).toMatchObject({ late: "%0", done: null });
			expect(Object.values(p).filter((x) => x === "%0")).toHaveLength(1);
			expect((await state("done"))?.status).toBe("ended");
		} finally {
			vi.useRealTimers();
		}
	});

	it("resuming the interactive conversation after an unknown bound a freed pane leaves exactly one holder", async () => {
		await interactiveIn("a");
		now += 1000;
		await interactiveIn("b", "clear"); // a: binding_lost, b holds %0
		await service.ingest("s1", "%0", hook("SessionEnd", { reason: "clear" }, "b"));
		now += 1000;
		await service.ingest("s1", "%0", hook("SessionStart", { source: "resume", ...PANE }, "a"));
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "u", prompt_id: "pu" }, "u"),
		);
		now += 1000;
		await service.ingest("s1", "%0", hook("SessionStart", { source: "resume", ...PANE }, "a"));
		const p = await panes();
		expect(p.a).toBe("%0");
		expect(Object.values(p).filter((x) => x === "%0")).toHaveLength(1);
	});

	it("G4: an evicted peer whose index snapshot is unreadable keeps an unknown unbound (fail closed)", async () => {
		await interactiveIn("main");
		await store.flush("s1", "main");
		await store.close("s1", "main");
		await fs.writeFile(store.indexPath("s1", "main"), "{not json");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "x", prompt_id: "pu" }, "orphan"),
		);
		await new Promise((r) => setTimeout(r, 20));
		await store.flush("s1", "orphan");
		expect(
			(await service.summaries("s1")).find((x) => x.sessionId === "orphan")?.paneId,
		).toBeNull();
	});

	it("G4: an interactive conversation that binds while an unknown's disk check is pending wins — one holder", async () => {
		// Reads of `ev`'s index can be held, so the unknown's bind waits on it.
		let gate: Promise<void> = Promise.resolve();
		const gated: StoreFs = {
			mkdir: (p, o) => fs.mkdir(p, o),
			appendFile: (p, d) => fs.appendFile(p, d),
			writeFile: (p, d) => fs.writeFile(p, d),
			rename: (a, b) => fs.rename(a, b),
			rm: (p, o) => fs.rm(p, o),
			stat: (p) => fs.stat(p),
			readFile: async (p, e) => {
				if (String(p) === store.indexPath("s1", "ev")) await gate;
				return fs.readFile(p, e);
			},
			readdir: (p) => fs.readdir(p),
		} as StoreFs;
		await service.shutdown();
		store = new ConversationStore({ workspaceRoot: root, now: () => now, fs: gated });
		service = makeService();
		// An evicted peer (ended, its own pane gone) makes the unknown's bind async.
		await interactiveIn("ev");
		await service.ingest("s1", "%0", hook("SessionEnd", { reason: "clear" }, "ev"));
		await store.flush("s1", "ev");
		await store.close("s1", "ev");
		let release!: () => void;
		gate = new Promise<void>((r) => {
			release = r;
		});
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "x", prompt_id: "pu" }, "orphan"),
		);
		now += 1000;
		await interactiveIn("main");
		release();
		await new Promise((r) => setTimeout(r, 20));
		await store.flush("s1", "orphan");
		const p = await panes();
		expect(p).toMatchObject({ main: "%0", orphan: null });
		expect(Object.values(p).filter((x) => x === "%0")).toHaveLength(1);
	});

	it("G4: an interactive conversation still takes the pane from an evicted holder (unchanged)", async () => {
		await interactiveIn("old");
		await store.flush("s1", "old");
		await store.close("s1", "old");
		now += 1000;
		await interactiveIn("new", "clear");
		await vi.waitFor(async () => expect(await panes()).toMatchObject({ old: null, new: "%0" }));
		expect(await state("old")).toMatchObject({ status: "unknown", statusEvidence: "binding_lost" });
	});
});
