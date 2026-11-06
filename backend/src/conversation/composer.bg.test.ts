/**
 * composer.bg.test.ts — CONVERSATION.md §8.1.12 (v1.9 proposal, EXPERIMENTAL)
 * against a real ConversationStore and a real PaneRecordStore in a temp
 * directory, a scripted Docker port (the in-container client is recognised
 * by its fixed argv; its stdin says inspect or reply), a scripted probe and
 * an in-memory transcript. Timers are the `after` seam, fired by hand.
 *
 * What these pin: the flag-off path is today's; the precondition order and
 * every refusal leave no effect; the double idle read; the job/process/
 * daemon identity; the duplicate exclusion; every reply outcome and its
 * transition; the ack attribution (new prompt_id + transcript enqueue +
 * `queued`); `duplicated`; restart recovery by evidence, never resending.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "../types.js";
import { BG_CLIENT_ARGV, BG_CLIENT_PROGRAM } from "./bgTransport.js";
import { type ComposerDockerPort, ComposerService } from "./composer.js";
import type { TranscriptPort } from "./composerBg.js";
import { PaneRecordStore } from "./paneRecord.js";
import type { ProbeEntry } from "./probe.js";
import { ConversationStore } from "./store.js";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CID = "dda484d8-c2a9-4997-af5a-42fbe372cb91";
const CID2 = "115ac1a7-35ec-475d-b138-731588fd8ed8";
const SHORT = "dda484d8";
const JOB = `job:${SHORT}`;
const WORKER = 900;
const WORKER_START = "5000";
const PTY_HOST = 850;
const DAEMON = 800;
const DAEMON_START = "4000";
const EXE =
	"/home/developer/workspace/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
const CFG = "/home/developer/.claude";
const NONCE = "1b7b6e46";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const TPATH = `/home/developer/.claude/projects/-home-developer-workspace/${CID}.jsonl`;
const TPATH2 = `/home/developer/.claude/projects/-home-developer-workspace/${CID2}.jsonl`;

// ── Scripted Docker ─────────────────────────────────────────────────────────

type Step = "status" | "stat" | "exelink" | "inode" | "version" | "inspect" | "reply" | "other";
interface Call {
	id: string;
	step: Step;
	cmd: string[];
	stdin: string | null;
	user?: string;
	started: boolean;
}

function stepOf(cmd: string[], stdin: string | null): Step {
	if (cmd.length === BG_CLIENT_ARGV.length && cmd.at(-1) === BG_CLIENT_PROGRAM) {
		const mode = stdin ? (JSON.parse(stdin) as { mode: string }).mode : "";
		return mode === "reply" ? "reply" : "inspect";
	}
	const j = cmd.join(" ");
	if (j.endsWith("--version")) return "version";
	if (j.endsWith("/status")) return "status";
	if (j.endsWith("/stat")) return "stat";
	if (j.includes("stat -L")) return "inode";
	if (j.includes("readlink /proc/")) return "exelink";
	return "other";
}
const pidOf = (cmd: string[]): number => {
	const m = cmd.join(" ").match(/\/proc\/(\d+)\//);
	return m ? Number(m[1]) : 0;
};

class FakeDocker implements ComposerDockerPort {
	calls: Call[] = [];
	container: "running" | "stopped" | "gone" = "running";
	versions = new Map<number, string>([
		[WORKER, "2.1.318"],
		[DAEMON, "2.1.318"],
	]);
	starts = new Map<number, string>([
		[WORKER, WORKER_START],
		[DAEMON, DAEMON_START],
	]);
	uid = "Uid:\t1000\t1000\t1000\t1000";
	/** Knobs of the inspect answer. */
	ins = {
		configDir: CFG,
		statusPid: DAEMON as number | null,
		statusStart: DAEMON_START as string | null,
		rosterPid: DAEMON as number | null,
		peerPid: DAEMON as number | null,
		daemonExe: EXE as string | null,
		daemonStart: DAEMON_START as string | null,
		job: {
			short: SHORT,
			nonce: NONCE,
			pid: PTY_HOST,
			cliVersion: "2.1.318",
			outcome: false,
			dying: false,
		} as Record<string, unknown> | null,
		worker: { ppid: PTY_HOST as number | null, start: WORKER_START as string | null, exe: EXE },
		session: {
			sessionId: CID,
			status: "idle",
			procStart: WORKER_START,
			jobId: SHORT,
			kind: "bg",
			waiting: false,
		} as Record<string, unknown> | null,
	};
	inspectExit: number | null = 0;
	/** Successive reply outcomes: a code line, "park", or an exit. */
	replies: Array<string | "park" | { exit: number | null; out?: string } | "reject"> = [];
	parked = new Map<string, (r: { exit: number | null; out: string }) => void>();
	states = new Map<string, { running: boolean; exitCode: number | null } | null>();
	private n = 0;

	replyCalls(): Call[] {
		return this.calls.filter((c) => c.step === "reply");
	}
	startedReplies(): Call[] {
		return this.replyCalls().filter((c) => c.started);
	}
	release(id: string, exit: number | null, out = ""): void {
		const r = this.parked.get(id);
		if (!r) throw new Error(`exec ${id} not parked`);
		this.parked.delete(id);
		r({ exit, out });
	}
	inspectOut(): string {
		const i = this.ins;
		return `ST-BG inspect ${JSON.stringify({
			configDir: i.configDir,
			daemon: {
				statusPid: i.statusPid,
				statusStart: i.statusStart,
				rosterPid: i.rosterPid,
				peerPid: i.peerPid,
				exe: i.daemonExe,
				start: i.daemonStart,
			},
			job: i.job,
			worker: i.worker,
			session: i.session,
		})}\n`;
	}
	async exec(
		_container: string,
		cmd: string[],
		stdin: Buffer | null,
		onCreated: (id: string) => Promise<boolean>,
		opts?: { user?: string },
	) {
		const s = stdin?.toString("utf8") ?? null;
		const step = stepOf(cmd, s);
		const id = `e${++this.n}-${step}`;
		const call: Call = { id, step, cmd, stdin: s, user: opts?.user, started: false };
		this.calls.push(call);
		let plan: string | "park" | { exit: number | null; out?: string } | "reject" = {
			exit: 0,
		};
		if (step === "reply") plan = this.replies.length ? (this.replies.shift() as typeof plan) : "ok";
		if (plan === "reject") throw new Error("docker: cannot create exec");
		if (!(await onCreated(id))) return { execId: id, exitCode: null, stdout: "" };
		call.started = true;
		if (step === "reply") {
			let res: { exit: number | null; out: string };
			if (plan === "park") res = await new Promise((r) => this.parked.set(id, r));
			else if (typeof plan === "string") res = { exit: 0, out: `ST-BG ${plan}\n` };
			else res = { exit: plan.exit, out: plan.out ?? "" };
			this.states.set(id, res.exit === null ? null : { running: false, exitCode: res.exit });
			return { execId: id, exitCode: res.exit, stdout: res.out };
		}
		const pid = pidOf(cmd);
		let stdout = "";
		let exit: number | null = 0;
		if (step === "inspect") {
			stdout = this.inspectOut();
			exit = this.inspectExit;
		} else if (step === "status") stdout = `Name:\tclaude\n${this.uid}\n`;
		else if (step === "stat")
			stdout = `${pid} (claude) S ${pid === WORKER ? PTY_HOST : 1} 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${this.starts.get(pid) ?? "1"} 0 0\n`;
		else if (step === "exelink") stdout = `${EXE}\n`;
		else if (step === "inode") stdout = "64768:4242\n";
		else if (step === "version") stdout = `${this.versions.get(pid) ?? "9.9.9"} (Claude Code)\n`;
		this.states.set(id, { running: false, exitCode: exit });
		return { execId: id, exitCode: exit, stdout };
	}
	async execState(id: string) {
		return this.states.has(id) ? (this.states.get(id) ?? null) : null;
	}
	async containerState() {
		return this.container;
	}
}

// ── Timers / transcript ─────────────────────────────────────────────────────

class Timers {
	pending: Array<{ ms: number; fire: () => void }> = [];
	after = (ms: number) => new Promise<void>((r) => this.pending.push({ ms, fire: r }));
	fire(ms: number): void {
		const now = this.pending.filter((t) => t.ms === ms);
		this.pending = this.pending.filter((t) => t.ms !== ms);
		for (const t of now) t.fire();
	}
	fireAll(): void {
		const now = this.pending;
		this.pending = [];
		for (const t of now) t.fire();
	}
}

class Transcripts implements TranscriptPort {
	files = new Map<string, string[]>();
	readable = true;
	async readTail(_sid: string, p: string) {
		if (!this.readable) return null;
		const lines = this.files.get(p);
		return lines ? `${lines.join("\n")}\n` : null;
	}
	add(p: string, entry: Record<string, unknown>): void {
		const arr = this.files.get(p) ?? [];
		arr.push(JSON.stringify(entry));
		this.files.set(p, arr);
	}
}

async function until(pred: () => boolean | Promise<boolean>, label = "condition"): Promise<void> {
	const deadline = Date.now() + 4000;
	while (!(await pred())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

// ── Harness ─────────────────────────────────────────────────────────────────

let root: string;
let store: ConversationStore;
let records: PaneRecordStore;
let listeners: Array<() => void> = [];
let docker: FakeDocker;
let timers: Timers;
let transcripts: Transcripts;
let probe: ProbeEntry[] | null;
let captureEffective: boolean;
let meta: SessionMeta;
let now: number;
const iso = (ms: number) => new Date(ms).toISOString();

function makeService(
	over: Partial<ConstructorParameters<typeof ComposerService>[0]> = {},
	bgOver: Partial<NonNullable<ConstructorParameters<typeof ComposerService>[0]["bg"]>> = {},
) {
	return new ComposerService({
		enabled: true,
		store,
		records,
		docker,
		sessions: { getOrThrow: async () => meta },
		conversation: {
			probeSession: async () => probe,
			onPersistedEvent: (l) => {
				const u = store.onEvent(l);
				listeners.push(u);
				return u;
			},
			captureEffective: async () => captureEffective,
		},
		now: () => now,
		after: timers.after,
		tHttpMs: 30_000,
		tAckMs: 8_000,
		bg: {
			enabled: true,
			versions: new Set(["2.1.318"]),
			sessions: new Set([SID]),
			transcripts,
			pollMs: 1_000,
			jobCheckMs: 30_000,
			...bgOver,
		},
		...over,
	});
}

async function seedBgConversation(cid = CID, tpath = TPATH) {
	await store.open(SID, cid);
	store.update(SID, cid, (i) => {
		i.kind = "interactive";
		i.paneId = null;
	});
	store.enqueue(SID, cid, {
		ev: "session_start",
		prompt_id: null,
		turn_id: null,
		agent_id: null,
		pane: null,
		data: { source: "startup", transcript_path: tpath },
	});
	await store.flush(SID, cid);
}

function send(service: ComposerService, text: string, id = ID1, cid = CID, callerId = "owner") {
	return service.send({
		stSessionId: SID,
		cid,
		callerId,
		meta,
		body: { text, clientMessageId: id },
		audit: async () => undefined,
	});
}

/** A human `user_prompt` as the ingest would persist it (no pane: a background job has none). */
async function promptArrives(text: string, promptId: string, cid = CID) {
	await store.open(SID, cid);
	store.enqueue(SID, cid, {
		ev: "user_prompt",
		prompt_id: promptId,
		turn_id: null,
		agent_id: null,
		pane: null,
		data: { prompt: text },
	});
	await store.flush(SID, cid);
}

async function sessionStart(source: string, cid = CID, tpath = TPATH) {
	await store.open(SID, cid);
	store.enqueue(SID, cid, {
		ev: "session_start",
		prompt_id: null,
		turn_id: null,
		agent_id: null,
		pane: null,
		data: { source, transcript_path: tpath },
	});
	await store.flush(SID, cid);
}

/** What the CLI writes for a reply: enqueue then a `queued` user entry. */
function transcriptReply(text: string, promptId: string, atMs: number, cid = CID, p = TPATH) {
	transcripts.add(p, {
		type: "queue-operation",
		operation: "enqueue",
		timestamp: iso(atMs),
		sessionId: cid,
		content: text,
	});
	transcripts.add(p, {
		type: "queue-operation",
		operation: "dequeue",
		timestamp: iso(atMs + 10),
		sessionId: cid,
	});
	transcripts.add(p, {
		type: "user",
		promptSource: "queued",
		promptId,
		timestamp: iso(atMs + 20),
		sessionId: cid,
		message: { role: "user", content: text },
	});
}

async function eventsOf(cid = CID) {
	await store.flush(SID, cid);
	const raw = await fs.readFile(store.eventsPath(SID, cid), "utf8").catch(() => "");
	return raw
		.split("\n")
		.filter(Boolean)
		.map(
			(l) => JSON.parse(l) as { ev: string; pane: string | null; data: Record<string, unknown> },
		);
}
const composerStates = async (cid = CID) =>
	(await eventsOf(cid)).filter((e) => e.ev === "composer_send").map((e) => e.data.state as string);
const jobRecord = () => records.read(SID, JOB);

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-composer-bg-"));
	now = 1_800_000_000_000;
	store = new ConversationStore({ workspaceRoot: root, now: () => now });
	records = new PaneRecordStore(root);
	listeners = [];
	docker = new FakeDocker();
	timers = new Timers();
	transcripts = new Transcripts();
	transcripts.files.set(TPATH, []);
	probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: WORKER, status: "idle" }];
	captureEffective = true;
	meta = {
		sessionId: SID,
		userId: "owner",
		name: "s",
		status: "running",
		containerId: "cont-1",
		containerName: "st-x",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
	} as unknown as SessionMeta;
	await seedBgConversation();
});
afterEach(async () => {
	for (const u of listeners) u();
	listeners = [];
	await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * The job lock is released a few microtasks after the record goes (the
 * release runs inside it): a send fired in that window is a legitimate
 * transient 409. Tests that model a LATER send wait for it.
 */
const lockFree = (service: ComposerService) =>
	until(
		() =>
			(service as unknown as { lock: { heldBy(k: string): unknown } }).lock.heldBy(
				`${SID}\u0000${JOB}`,
			) === null,
		"job lock free",
	);

/** Nothing may happen for a refused send: no reply exec, no record, no event. */
async function nothingHappened() {
	expect(docker.replyCalls()).toEqual([]);
	expect(await jobRecord()).toEqual({ kind: "none" });
	expect(await composerStates()).toEqual([]);
}

/** Drive a send to `accepted` and the CLI's answer for an idle job. */
async function deliverIdle(service: ComposerService, text: string, promptId = "p-new", id = ID1) {
	const t0 = now;
	const r = send(service, text, id);
	await until(async () => (await composerStates()).includes("accepted"), "accepted");
	transcriptReply(text, promptId, t0 + 60);
	await promptArrives(text, promptId);
	return r;
}

// ── Flag off ────────────────────────────────────────────────────────────────

describe("flag off: today's behaviour, byte for byte", () => {
	it("a pane-less conversation is refused not-interactive with no exec, no probe", async () => {
		let probed = 0;
		const service = makeService(
			{
				conversation: {
					probeSession: async () => {
						probed++;
						return probe;
					},
					onPersistedEvent: (l) => store.onEvent(l),
					captureEffective: async () => true,
				},
			},
			{ enabled: false },
		);
		const r = await send(service, "hello");
		expect(r).toEqual({ status: 409, body: { error: "not-interactive" } });
		expect(docker.calls).toEqual([]);
		expect(probed).toBe(0);
		await nothingHappened();
	});
	it("availability: no transport, canSendInput false, as before", async () => {
		const service = makeService({}, { enabled: false });
		const av = await service.availability(SID, [{ cid: CID, kind: "interactive", paneId: null }], {
			captureEffective: true,
			callerMayOperate: true,
		});
		expect(av.get(CID)).toEqual({ canSendInput: false, composer: { blocked: false } });
		expect(service.bgEnabled).toBe(false);
	});
	it("no bg deps at all is the same as off", async () => {
		const service = makeService({ bg: undefined });
		expect((await send(service, "hello")).body).toEqual({ error: "not-interactive" });
		expect(docker.calls).toEqual([]);
	});
});

// ── Availability ────────────────────────────────────────────────────────────

describe("availability with the flag on (orientative)", () => {
	it("marks a pane-less conversation as background and sendable", async () => {
		const service = makeService();
		const av = await service.availability(
			SID,
			[
				{ cid: CID, kind: "interactive", paneId: null },
				{ cid: CID2, kind: "headless", paneId: null },
			],
			{ captureEffective: true, callerMayOperate: true },
		);
		expect(av.get(CID)).toEqual({
			canSendInput: true,
			transport: "background",
			composer: { blocked: false },
		});
		expect(av.get(CID2)?.transport).toBeUndefined();
		expect(av.get(CID2)?.canSendInput).toBe(false);
	});
	it("an ended conversation is not a candidate", async () => {
		const service = makeService();
		const av = await service.availability(
			SID,
			[{ cid: CID, kind: "interactive", paneId: null, endedAt: iso(now) }],
			{ captureEffective: true, callerMayOperate: true },
		);
		expect(av.get(CID)?.transport).toBeUndefined();
	});
	it("a job record naming the conversation blocks it", async () => {
		const service = makeService();
		docker.replies = ["park"];
		void send(service, "hello");
		await until(async () => (await jobRecord()).kind === "ok", "record");
		const av = await service.availability(SID, [{ cid: CID, kind: "interactive", paneId: null }], {
			captureEffective: true,
			callerMayOperate: true,
		});
		expect(av.get(CID)?.canSendInput).toBe(false);
		expect(av.get(CID)?.composer.blocked).toBe(true);
		expect(av.get(CID)?.composer.clientMessageId).toBe(ID1);
	});
});

// ── Text rules first ────────────────────────────────────────────────────────

describe("validateText/normalizeText unchanged, before anything", () => {
	it.each([
		["/clear", "unsupported-prefix"],
		["!rm -rf x", "unsupported-prefix"],
		["a\u001b[13;2ub", "control-bytes"],
		["", "empty-text"],
	])("%j ⇒ 400 %s, no probe, no exec", async (text, code) => {
		const service = makeService();
		const r = await send(service, text);
		expect(r).toEqual({ status: 400, body: { error: code } });
		expect(docker.calls).toEqual([]);
		await nothingHappened();
	});
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("idle job: accepted, then delivered by the complete ack", () => {
	it("one reply exec, as the worker's uid, fixed argv, text on stdin only", async () => {
		const service = makeService();
		const r = await deliverIdle(service, "hello from chat");
		expect(await r).toEqual({
			status: 202,
			body: {
				result: "delivered",
				clientMessageId: ID1,
				promptId: "p-new",
				seq: expect.any(Number),
			},
		});
		const calls = docker.replyCalls();
		expect(calls).toHaveLength(1);
		const c = calls[0] as Call;
		expect(c.cmd).toEqual([...BG_CLIENT_ARGV]);
		expect(c.cmd).not.toContain("hello from chat");
		expect(c.user).toBe("1000");
		const stdin = JSON.parse(c.stdin as string);
		expect(stdin).toEqual({
			mode: "reply",
			pid: WORKER,
			short: SHORT,
			start: WORKER_START,
			exe: EXE,
			cid: CID,
			nonce: NONCE,
			ptyHostPid: PTY_HOST,
			daemonPid: DAEMON,
			daemonStart: DAEMON_START,
			daemonExe: EXE,
			text: "hello from chat",
		});
		// nextTurn is the program's literal, never a parameter.
		expect(c.stdin).not.toContain("nextTurn");
		expect(BG_CLIENT_PROGRAM).toContain('"nextTurn": True');
		await until(async () => (await jobRecord()).kind === "none", "released");
		expect(await composerStates()).toEqual(["prepared", "accepted", "delivered", "released"]);
		const evs = (await eventsOf()).filter((e) => e.ev === "composer_send");
		expect(evs.every((e) => e.pane === null)).toBe(true);
		expect(evs[0]?.data).toMatchObject({ transport: "background", job: SHORT, pane_id: JOB });
		// Every in-container read ran as the worker's uid, never root.
		expect(docker.calls.filter((x) => x.step === "inspect").every((x) => x.user === "1000")).toBe(
			true,
		);
	});

	it("no ack in the HTTP budget ⇒ 202 accepted (not delivered); T_ack_bg ⇒ unconfirmed, released", async () => {
		const service = makeService();
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		timers.fire(8_000);
		expect(await r).toEqual({ status: 202, body: { result: "accepted", clientMessageId: ID1 } });
		const rec = await jobRecord();
		expect(rec.kind === "ok" && rec.record.state).toBe("accepted");
		// The same id again learns `accepted`, never a new send.
		expect((await send(service, "hello")).body).toMatchObject({ result: "accepted" });
		expect(docker.replyCalls()).toHaveLength(1);
		// Another id on the same job: blocked by the record.
		expect((await send(service, "other", ID2)).body).toMatchObject({
			error: "send-in-progress",
			clientMessageId: ID1,
		});
		now += 10 * 60_000 + 1;
		timers.fire(1_000);
		await until(async () => (await composerStates()).includes("unconfirmed"), "unconfirmed");
		await until(async () => (await jobRecord()).kind === "none", "released");
		const ev = (await eventsOf()).find(
			(e) => e.ev === "composer_send" && e.data.state === "unconfirmed",
		);
		expect(ev?.data.detail).toBe("t-ack-bg");
		expect(docker.replyCalls()).toHaveLength(1);
	});

	it("a late complete ack after `accepted` still delivers (queued behind a turn)", async () => {
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
		now += 40_000;
		transcriptReply("hello", "p-late", t0 + 30);
		await promptArrives("hello", "p-late");
		await until(async () => (await composerStates()).includes("delivered"), "delivered");
		await until(async () => (await jobRecord()).kind === "none", "released");
		// The replay answer is the delivered one.
		expect((await send(service, "hello")).body).toMatchObject({
			result: "delivered",
			promptId: "p-late",
		});
	});
});

// ── Preconditions ───────────────────────────────────────────────────────────

describe("preconditions: contract order, 409, no effect", () => {
	const cases: Array<[string, () => void, Record<string, unknown>]> = [
		[
			"session not running",
			() => (meta.status = "stopped" as never),
			{ error: "session-not-running" },
		],
		["capture inactive", () => (captureEffective = false), { error: "capture-inactive" }],
		["probe fails", () => (probe = null), { error: "probe-failed" }],
		["probe lists no cid", () => (probe = []), { error: "probe-failed" }],
		[
			"probe says interactive (no pane)",
			() => ((probe as ProbeEntry[])[0]!.kind = "interactive"),
			{ error: "not-interactive", detail: "kind:interactive" },
		],
		[
			"no job id",
			() => delete (probe as ProbeEntry[])[0]!.id,
			{ error: "binding-stale", detail: "job-id" },
		],
		[
			"malformed job id",
			() => ((probe as ProbeEntry[])[0]!.id = "../x"),
			{ error: "binding-stale", detail: "job-id" },
		],
		[
			"two probe entries claim the conversation",
			() =>
				(probe as ProbeEntry[]).push({
					sessionId: CID,
					kind: "background",
					id: SHORT,
					pid: 999,
					status: "idle",
				}),
			{ error: "binding-stale", detail: "ambiguous" },
		],
		["probe busy", () => ((probe as ProbeEntry[])[0]!.status = "busy"), { error: "busy" }],
		[
			"probe waiting (input needed is still waiting: v1 never answers a dialog)",
			() => {
				const e = (probe as ProbeEntry[])[0]!;
				e.status = "waiting";
				e.waitingFor = "input needed";
			},
			{ error: "needs-terminal", detail: "input needed" },
		],
		[
			"probe idle with a waitingFor",
			() => ((probe as ProbeEntry[])[0]!.waitingFor = "permission prompt"),
			{ error: "needs-terminal", detail: "permission prompt" },
		],
		[
			"probe status missing",
			() => delete (probe as ProbeEntry[])[0]!.status,
			{ error: "needs-terminal", detail: "status-unknown" },
		],
		[
			"worker runs as root",
			() => (docker.uid = "Uid:\t0\t0\t0\t0"),
			{ error: "binding-stale", detail: "process" },
		],
		[
			"session file names another conversation (/clear since the probe)",
			() => ((docker.ins.session as Record<string, unknown>).sessionId = CID2),
			{ error: "binding-stale", detail: "session-file:session-id" },
		],
		[
			"session file of another process start",
			() => ((docker.ins.session as Record<string, unknown>).procStart = "1"),
			{ error: "binding-stale", detail: "session-file:start" },
		],
		[
			"session file not a bg job",
			() => ((docker.ins.session as Record<string, unknown>).kind = "interactive"),
			{ error: "binding-stale", detail: "session-file:kind" },
		],
		[
			"double idle: probe idle, session file busy",
			() => ((docker.ins.session as Record<string, unknown>).status = "busy"),
			{ error: "busy", detail: "session-file" },
		],
		[
			"session file waiting",
			() => ((docker.ins.session as Record<string, unknown>).waiting = true),
			{ error: "needs-terminal", detail: "session-file" },
		],
		[
			"fake socket: the peer of control.sock is not the supervisor",
			() => (docker.ins.peerPid = 4242),
			{ error: "binding-stale", detail: "daemon" },
		],
		[
			"roster and status disagree on the supervisor",
			() => (docker.ins.rosterPid = 801),
			{ error: "binding-stale", detail: "daemon" },
		],
		[
			"supervisor restarted (another start time)",
			() => (docker.ins.daemonStart = "4001"),
			{ error: "binding-stale", detail: "daemon" },
		],
		[
			"no daemon answers list",
			() => (docker.ins.job = null),
			{ error: "binding-stale", detail: "job" },
		],
		[
			"job gone from the daemon",
			() => (docker.ins.job = { absent: true }),
			{ error: "binding-stale", detail: "job" },
		],
		[
			"job's pty host is not the worker's parent (re-created job)",
			() => ((docker.ins.job as Record<string, unknown>).pid = 851),
			{ error: "binding-stale", detail: "job" },
		],
		[
			"job dying",
			() => ((docker.ins.job as Record<string, unknown>).dying = true),
			{ error: "binding-stale", detail: "job" },
		],
		[
			"inspect unusable",
			() => (docker.inspectExit = 1),
			{ error: "binding-stale", detail: "inspect" },
		],
		[
			"version not validated",
			() => docker.versions.set(WORKER, "2.1.316"),
			{ error: "cli-unvalidated" },
		],
		[
			"daemon of another version (would ESKEW)",
			() => docker.versions.set(DAEMON, "2.1.316"),
			{ error: "cli-unvalidated", detail: "daemon-skew" },
		],
		[
			"the daemon's record of the job's version differs",
			() => ((docker.ins.job as Record<string, unknown>).cliVersion = "2.1.316"),
			{ error: "cli-unvalidated", detail: "daemon-skew" },
		],
		[
			"transcript unreadable",
			() => (transcripts.readable = false),
			{ error: "transcript-unavailable" },
		],
	];
	it.each(cases)("%s", async (_label, arrange, body) => {
		arrange();
		const service = makeService();
		const r = await send(service, "hello");
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject(body);
		await nothingHappened();
	});

	it("default version list is EMPTY ⇒ cli-unvalidated not-allowed", async () => {
		const service = makeService({}, { versions: new Set() });
		const r = await send(service, "hello");
		expect(r).toEqual({
			status: 409,
			body: { error: "cli-unvalidated", version: "2.1.318", detail: "not-allowed" },
		});
		await nothingHappened();
	});

	it("order: busy is decided before any /proc read; identity before versions", async () => {
		(probe as ProbeEntry[])[0]!.status = "busy";
		const service = makeService();
		await send(service, "hello");
		expect(docker.calls).toEqual([]);
		(probe as ProbeEntry[])[0]!.status = "idle";
		docker.ins.peerPid = 1;
		docker.calls = [];
		await send(service, "hello");
		expect(docker.calls.some((c) => c.step === "version")).toBe(false);
	});
});

// ── Duplicate exclusion ─────────────────────────────────────────────────────

describe("D1 identical messages: refused only while pending or ambiguous (§8.1.12.5 cond. 3)", () => {
	it("resend after delivered ⇒ allowed (a confirmed, released send never blocks)", async () => {
		const service = makeService();
		await deliverIdle(service, "continue", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		await lockFree(service);
		now += 1_000;
		docker.replies = ["park"];
		void send(service, "continue", ID2);
		await until(() => docker.replyCalls().length === 2, "second reply");
	});
	it("the same text as a fully run earlier prompt (typed, in the transcript) ⇒ allowed", async () => {
		await promptArrives("continue", "p-human");
		transcriptReply("continue", "p-human", now - 5_000);
		docker.replies = ["park"];
		const service = makeService();
		void send(service, "continue");
		await until(() => docker.replyCalls().length === 1, "reply");
	});
	it("resend while ours is accepted ⇒ refused (the job is blocked by our record)", async () => {
		const service = makeService();
		void send(service, "continue");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		const r = await send(service, "continue", ID2);
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ error: "send-in-progress", clientMessageId: ID1 });
		expect(docker.replyCalls()).toHaveLength(1);
	});
	it("an unresolved send of ours of the same text on ANOTHER job of this conversation ⇒ duplicate-pending own-pending", async () => {
		const at = iso(now);
		await records.write({
			v: 1,
			sid: SID,
			pane_id: "job:beefbeef",
			pane_pid: 777,
			container_id: "cont-1",
			cid: CID,
			client_message_id: ID2,
			text_hash: (await import("./composerText.js")).textHash("continue"),
			prepared_at: at,
			state: "accepted",
			result: "pending",
			phase: "completed",
			execs: [{ id: "x", step: "reply", created_at: at, settled: { exit_code: 0, at } }],
			job: {
				short: "beefbeef",
				pid: 777,
				start: "1",
				exe: EXE,
				// The fake daemon reports this nonce: the record is not "relaunched".
				nonce: NONCE,
				pty_host_pid: 2,
				daemon_pid: DAEMON,
				daemon_start: DAEMON_START,
				daemon_exe: EXE,
				version: "2.1.318",
				uid: 1000,
				config_dir: CFG,
			},
			updated_at: at,
		});
		const service = makeService();
		const r = await send(service, "continue");
		expect(r).toEqual({
			status: 409,
			body: { error: "duplicate-pending", detail: "own-pending", clientMessageId: ID2 },
		});
		expect(docker.replyCalls()).toEqual([]);
	});
	it("resend after unconfirmed ⇒ refused until the person confirms they checked the Terminal", async () => {
		const service = makeService();
		void send(service, "continue");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		now += 10 * 60_000 + 1;
		timers.fire(1_000);
		await until(async () => (await composerStates()).includes("unconfirmed"), "unconfirmed");
		await until(async () => (await jobRecord()).kind === "none", "released");
		await lockFree(service);
		const refused = await send(service, "continue", ID2);
		expect(refused).toEqual({
			status: 409,
			body: {
				error: "duplicate-pending",
				detail: "unconfirmed-unacknowledged",
				clientMessageId: ID1,
			},
		});
		// A different text is not concerned.
		docker.replies = ["park"];
		// The person checked: the same text again, acknowledging that send.
		const ID3 = "33333333-3333-4333-8333-333333333333";
		void service.send({
			stSessionId: SID,
			cid: CID,
			callerId: "owner",
			meta,
			body: { text: "continue", clientMessageId: ID3, acknowledgeUnconfirmed: ID1 },
			audit: async () => undefined,
		});
		await until(() => docker.replyCalls().length === 2, "second reply");
		const ev = (await eventsOf()).find(
			(e) => e.ev === "composer_send" && e.data.state === "acknowledged",
		);
		expect(ev?.data).toMatchObject({ client_message_id: ID1, by: "owner" });
	});
	it("the acknowledgement is durable: a new process does not ask again", async () => {
		const a = makeService();
		void send(a, "continue");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		now += 10 * 60_000 + 1;
		timers.fire(1_000);
		await until(async () => (await jobRecord()).kind === "none", "released");
		await lockFree(a);
		docker.replies = ["ENOJOB"];
		const second = await a.send({
			stSessionId: SID,
			cid: CID,
			callerId: "owner",
			meta,
			body: { text: "continue", clientMessageId: ID2, acknowledgeUnconfirmed: ID1 },
			audit: async () => undefined,
		});
		expect(second.status, JSON.stringify(second.body)).toBe(502);
		await until(async () => (await jobRecord()).kind === "none", "second released");
		await lockFree(a);
		for (const u of listeners) u();
		listeners = [];
		const b = makeService();
		docker.replies = ["park"];
		void send(b, "continue", "44444444-4444-4444-8444-444444444444");
		await until(() => docker.replyCalls().length === 3, "third reply");
	});
	it("a foreign same-content enqueue still pending in the CLI queue ⇒ duplicate-pending queue-pending", async () => {
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(now - 3_000),
			sessionId: CID,
			content: "continue",
		});
		const service = makeService();
		expect((await send(service, "continue")).body).toEqual({
			error: "duplicate-pending",
			detail: "queue-pending",
		});
		await nothingHappened();
	});
	it("a same-content item taken but not yet run ⇒ refused; once run ⇒ allowed", async () => {
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(now - 3_000),
			sessionId: CID,
			content: "continue",
		});
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "dequeue",
			timestamp: iso(now - 2_900),
			sessionId: CID,
		});
		const service = makeService();
		expect((await send(service, "continue")).body).toMatchObject({ detail: "queue-pending" });
		await lockFree(service);
		transcripts.add(TPATH, {
			type: "user",
			promptSource: "queued",
			promptId: "p-q",
			timestamp: iso(now - 2_800),
			sessionId: CID,
		});
		docker.replies = ["park"];
		void send(service, "continue", ID2);
		await until(() => docker.replyCalls().length === 1, "reply");
	});
});

// ── Reply outcomes ──────────────────────────────────────────────────────────

describe("reply outcomes — every code, no retry", () => {
	it.each([
		"ENOJOB",
		"ERESPAWNING",
		"ENOREPLY",
		"ESKEW",
		"EAUTH",
		"EUNVERIFIED",
	])("%s ⇒ 502 delivery-failed, failed, released, ONE reply", async (code) => {
		docker.replies = [code];
		const service = makeService();
		const r = await send(service, "hello");
		expect(r).toEqual({
			status: 502,
			body: {
				error: "delivery-failed",
				stage: "reply",
				segmentsSent: 0,
				segments: 1,
				detail: code,
			},
		});
		await until(async () => (await jobRecord()).kind === "none", "released");
		expect(await composerStates()).toEqual(["prepared", "failed", "released"]);
		expect(docker.replyCalls()).toHaveLength(1);
	});

	it.each([
		["stale-session", 409, "binding-stale"],
		["stale-process", 409, "binding-stale"],
		["stale-daemon", 409, "binding-stale"],
		["stale-job", 409, "binding-stale"],
		["busy", 409, "busy"],
		["waiting", 409, "needs-terminal"],
		["no-key", 502, "delivery-failed"],
	])("in-exec re-read abort %s ⇒ %d %s, nothing written, released", async (code, status, error) => {
		docker.replies = [code];
		const service = makeService();
		const r = await send(service, "hello");
		expect(r.status).toBe(status);
		expect(r.body).toMatchObject({ error });
		await until(async () => (await jobRecord()).kind === "none", "released");
		expect(await composerStates()).toEqual(["prepared", "failed", "released"]);
	});

	it("connection lost after writing (no-answer) ⇒ 202 uncertain, the job stays blocked; a later complete ack delivers", async () => {
		const t0 = now;
		docker.replies = ["no-answer"];
		const service = makeService();
		const r = await send(service, "hello");
		expect(r).toEqual({
			status: 202,
			body: { result: "uncertain", clientMessageId: ID1, effects: "settled" },
		});
		expect((await send(service, "x", ID2)).body).toMatchObject({ error: "send-in-progress" });
		transcriptReply("hello", "p-1", t0 + 40);
		await promptArrives("hello", "p-1");
		await until(async () => (await composerStates()).includes("delivered"), "delivered");
		await until(async () => (await jobRecord()).kind === "none", "released");
		expect(docker.replyCalls()).toHaveLength(1);
	});

	it("uncertain never expires into unconfirmed", async () => {
		docker.replies = ["no-answer"];
		const service = makeService();
		await send(service, "hello");
		now += 11 * 60_000;
		timers.fire(1_000);
		await new Promise((r) => setTimeout(r, 50));
		const rec = await jobRecord();
		expect(rec.kind === "ok" && rec.record.state).toBe("uncertain");
		expect(await composerStates()).not.toContain("unconfirmed");
	});

	it("an unrecognised daemon answer after the write (unknown-answer) ⇒ uncertain, settled, kept — never failed", async () => {
		docker.replies = ["unknown-answer"];
		const service = makeService();
		const r = await send(service, "hello");
		expect(r).toEqual({
			status: 202,
			body: { result: "uncertain", clientMessageId: ID1, effects: "settled" },
		});
		expect(await composerStates()).toEqual(["prepared", "uncertain"]);
		expect((await jobRecord()).kind).toBe("ok");
	});

	it.each([
		[{ exit: 0, out: "garbage\n" }],
		[{ exit: 1, out: "" }],
		[{ exit: 0, out: "ST-BG ok\nST-BG ok\n" }],
	])("unparseable / non-zero exit %j ⇒ uncertain (maybe written), never failed", async (plan) => {
		docker.replies = [plan];
		const service = makeService();
		const r = await send(service, "hello");
		expect(r.body).toMatchObject({ result: "uncertain" });
		expect(await composerStates()).toEqual(["prepared", "uncertain"]);
	});

	it("exec of unknown termination ⇒ uncertain, effects pending, blocked; settled only by evidence", async () => {
		docker.replies = [{ exit: null }];
		const service = makeService();
		const r = await send(service, "hello");
		expect(r.body).toMatchObject({ result: "uncertain", effects: "pending" });
		expect((await send(service, "x", ID2)).body).toMatchObject({
			error: "send-in-progress",
			detail: "effects-pending",
		});
		const rec = await jobRecord();
		expect(rec.kind === "ok" && rec.record.execs.map((e) => [e.step, e.settled])).toEqual([
			["reply", null],
		]);
	});

	it("exec creation rejected ⇒ 502 exec-rejected, failed", async () => {
		docker.replies = ["reject"];
		const service = makeService();
		const r = await send(service, "hello");
		expect(r.body).toMatchObject({ error: "delivery-failed", detail: "exec-rejected" });
	});

	it("T_http while the reply runs ⇒ 202 uncertain; its late `ok` is recorded as accepted, nothing restarts", async () => {
		docker.replies = ["park"];
		const service = makeService();
		const r = send(service, "hello");
		await until(() => docker.parked.size === 1, "parked");
		timers.fire(30_000);
		expect((await r).body).toMatchObject({ result: "uncertain" });
		const [id] = [...docker.parked.keys()];
		docker.release(id as string, 0, "ST-BG ok\n");
		await until(async () => (await composerStates()).includes("accepted"), "late accepted");
		expect(docker.replyCalls()).toHaveLength(1);
	});
});

// ── Ack attribution ─────────────────────────────────────────────────────────

describe("ack attribution (§8.1.12.5)", () => {
	it("text typed while idle (`typed`, no enqueue) is never our ack", async () => {
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		transcripts.add(TPATH, {
			type: "user",
			promptSource: "typed",
			promptId: "p-typed",
			timestamp: iso(t0 + 50),
			sessionId: CID,
		});
		await promptArrives("hello", "p-typed");
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
		expect(await composerStates()).not.toContain("delivered");
	});

	it("text typed while busy (running turn's prompt_id) is never our ack, even with an enqueue", async () => {
		const service = makeService();
		const t0 = now;
		await promptArrives("SLOW turn", "p-running");
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(t0 + 30),
			sessionId: CID,
			content: "hello",
		});
		await promptArrives("hello", "p-running");
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
		expect(await composerStates()).not.toContain("delivered");
	});

	it("S2: ours enqueued then taken back (popAll), then a foreign identical text queued ⇒ NOT delivered", async () => {
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(t0 + 40),
			sessionId: CID,
			content: "hello",
		});
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "popAll",
			timestamp: iso(t0 + 900),
			sessionId: CID,
			content: "hello",
		});
		// Another reply client sends the same words later; the CLI runs them.
		transcriptReply("hello", "p-foreign", t0 + 40_000);
		await promptArrives("hello", "p-foreign");
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
		await new Promise((x) => setTimeout(x, 50));
		expect(await composerStates()).not.toContain("delivered");
	});

	it("S2: ours enqueued and lost by a teardown, then a foreign identical text queued ⇒ NOT delivered", async () => {
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(t0 + 40),
			sessionId: CID,
			content: "hello",
		});
		transcriptReply("hello", "p-foreign", t0 + 60_000);
		await promptArrives("hello", "p-foreign");
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
		await new Promise((x) => setTimeout(x, 50));
		expect(await composerStates()).not.toContain("delivered");
	});

	it("an enqueue more than 2 s after t0 does not confirm", async () => {
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		transcriptReply("hello", "p-x", t0 + 2_500);
		await promptArrives("hello", "p-x");
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
	});

	it("the hook without the `queued` entry does not confirm", async () => {
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(t0 + 30),
			sessionId: CID,
			content: "hello",
		});
		await promptArrives("hello", "p-x");
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
	});

	it("/clear in the window: the complete ack lands in the job's next conversation ⇒ misdelivered", async () => {
		await seedBgConversation(CID2, TPATH2);
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		probe = [{ sessionId: CID2, kind: "background", id: SHORT, pid: WORKER, status: "busy" }];
		transcriptReply("hello", "p-2", t0 + 40, CID2, TPATH2);
		await promptArrives("hello", "p-2", CID2);
		expect(await r).toEqual({
			status: 202,
			body: { result: "misdelivered", clientMessageId: ID1, conversation: CID2 },
		});
	});

	it("a complete ack in a conversation that is NOT this job's is not claimed", async () => {
		await seedBgConversation(CID2, TPATH2);
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		probe = [{ sessionId: CID2, kind: "background", id: "beefbeef", pid: 999, status: "idle" }];
		transcriptReply("hello", "p-2", t0 + 40, CID2, TPATH2);
		await promptArrives("hello", "p-2", CID2);
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
	});

	it("complete acks in two conversations ⇒ no unequivocal attribution ⇒ unconfirmed", async () => {
		await seedBgConversation(CID2, TPATH2);
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		transcriptReply("hello", "p-2", t0 + 40, CID2, TPATH2);
		await promptArrives("hello", "p-2", CID2);
		transcriptReply("hello", "p-1", t0 + 40);
		await promptArrives("hello", "p-1");
		const body = (await r).body;
		expect(body).toMatchObject({ result: expect.stringMatching(/unconfirmed|delivered/) });
		// The single-candidate window may have closed on CID first; whichever
		// came first, two confirmed candidates never yield misdelivered.
		expect(body.result).not.toBe("misdelivered");
	});

	it("job gone while accepted (list: absent) ⇒ unconfirmed early", async () => {
		const service = makeService();
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		timers.fire(8_000);
		expect((await r).body).toMatchObject({ result: "accepted" });
		docker.ins.job = { absent: true };
		now += 31_000;
		timers.fire(1_000);
		await until(async () => (await composerStates()).includes("unconfirmed"), "unconfirmed");
		const ev = (await eventsOf()).find(
			(e) => e.ev === "composer_send" && e.data.state === "unconfirmed",
		);
		expect(ev?.data.detail).toBe("job-gone");
	});

	it("job relaunched (another nonce) ⇒ unconfirmed", async () => {
		const service = makeService();
		void send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		(docker.ins.job as Record<string, unknown>).nonce = "ffffffff";
		now += 31_000;
		timers.fire(1_000);
		await until(async () => (await composerStates()).includes("unconfirmed"), "unconfirmed");
	});
});

// ── duplicated ──────────────────────────────────────────────────────────────

describe("duplicated marker (§8.1.12.5)", () => {
	it("a resume with another pid and the same text again ⇒ one `duplicated` event, no new ack", async () => {
		const service = makeService();
		const r = await deliverIdle(service, "hello", "p-1");
		expect((await r).body).toMatchObject({ result: "delivered" });
		await until(async () => (await jobRecord()).kind === "none", "released");
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "busy" }];
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		await until(async () => (await composerStates()).includes("duplicated"), "duplicated");
		const states = await composerStates();
		expect(states.filter((s) => s === "duplicated")).toHaveLength(1);
		expect(states.filter((s) => s === "delivered")).toHaveLength(1);
	});
	it("S4: after a backend restart the watch is re-armed from the delivered send's events", async () => {
		const a = makeService();
		await deliverIdle(a, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		for (const u of listeners) u();
		listeners = [];
		const b = makeService();
		await b.recover(SID);
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "busy" }];
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		await until(async () => (await composerStates()).includes("duplicated"), "duplicated");
		expect((await composerStates()).filter((x) => x === "duplicated")).toHaveLength(1);
	});
	it("S4: a relaunch duplicate that happened while no backend was watching is marked on recovery", async () => {
		const a = makeService();
		await deliverIdle(a, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		for (const u of listeners) u();
		listeners = [];
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "busy" }];
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		const b = makeService();
		await b.recover(SID);
		await until(async () => (await composerStates()).includes("duplicated"), "duplicated");
	});
	it("S4: past T_ack_bg nothing is re-armed", async () => {
		const a = makeService();
		await deliverIdle(a, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		for (const u of listeners) u();
		listeners = [];
		now += 10 * 60_000 + 1;
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "busy" }];
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		const b = makeService();
		await b.recover(SID);
		await new Promise((r) => setTimeout(r, 50));
		expect(await composerStates()).not.toContain("duplicated");
	});
	it("the same pid (no relaunch) is not marked", async () => {
		const service = makeService();
		await deliverIdle(service, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		await sessionStart("resume");
		await promptArrives("hello", "p-again");
		await new Promise((r) => setTimeout(r, 50));
		expect(await composerStates()).not.toContain("duplicated");
	});
});

describe("D4 duplicated markers: proven vs possible, persistent and idempotent", () => {
	const markers = async () =>
		(await eventsOf()).filter(
			(e) =>
				e.ev === "composer_send" &&
				(e.data.state === "duplicated" || e.data.state === "possible-duplicate"),
		);
	it("proven: both prompt_ids recorded; never written twice, even by a second process", async () => {
		const a = makeService();
		await deliverIdle(a, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "busy" }];
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		await until(async () => (await markers()).length === 1, "marker");
		const m = (await markers())[0];
		expect(m?.data).toMatchObject({
			state: "duplicated",
			first_prompt_id: "p-1",
			prompt_id: "p-rerun",
			job_pid: 901,
		});
		// Restart: the new process re-arms, re-checks and must NOT write it again.
		for (const u of listeners) u();
		listeners = [];
		const b = makeService();
		await b.recover(SID);
		await promptArrives("unrelated", "p-x");
		await new Promise((r) => setTimeout(r, 80));
		expect(await markers()).toHaveLength(1);
	});
	it("possible: a resume and the same text again, but no probe shows the relaunch ⇒ possible-duplicate, once", async () => {
		const a = makeService();
		await deliverIdle(a, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		probe = null;
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		await until(() => timers.pending.some((t) => t.ms === 3_000), "retry scheduled");
		timers.fire(3_000);
		await until(async () => (await markers()).length === 1, "possible marker");
		expect((await markers())[0]?.data).toMatchObject({
			state: "possible-duplicate",
			first_prompt_id: "p-1",
			prompt_id: "p-rerun",
			reason: "probe-failed",
		});
		await promptArrives("other", "p-y");
		timers.fire(3_000);
		await new Promise((r) => setTimeout(r, 50));
		expect((await markers()).filter((m) => m.data.state === "possible-duplicate")).toHaveLength(1);
		// The proof arriving later adds the proven marker (a different kind), once.
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "idle" }];
		await promptArrives("again", "p-z");
		await until(async () => (await markers()).some((m) => m.data.state === "duplicated"), "proven");
		expect((await markers()).map((m) => m.data.state).sort()).toEqual([
			"duplicated",
			"possible-duplicate",
		]);
	});
});

describe("round 3: D4 proof requires an UNFINISHED turn; idempotency across processes; evidence-time window", () => {
	const markers = async () =>
		(await eventsOf()).filter(
			(e) =>
				e.ev === "composer_send" &&
				(e.data.state === "duplicated" || e.data.state === "possible-duplicate"),
		);
	const turnEnd = async (promptId: string) => {
		await store.open(SID, CID);
		store.enqueue(SID, CID, {
			ev: "turn_end",
			prompt_id: promptId,
			turn_id: null,
			agent_id: null,
			pane: null,
			data: {},
		});
		await store.flush(SID, CID);
	};
	it("a person: the turn finished, then stop + --bg --resume (new pid) and the same words retyped ⇒ possible-duplicate, never duplicated", async () => {
		const service = makeService();
		await deliverIdle(service, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		await turnEnd("p-1");
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "idle" }];
		await sessionStart("resume");
		await promptArrives("hello", "p-retyped");
		await until(async () => (await markers()).length === 1, "marker");
		expect((await markers())[0]?.data).toMatchObject({
			state: "possible-duplicate",
			reason: "turn-finished-before-resume",
			first_prompt_id: "p-1",
			prompt_id: "p-retyped",
		});
		await new Promise((r) => setTimeout(r, 50));
		expect((await markers()).some((m) => m.data.state === "duplicated")).toBe(false);
	});
	it("SF-1 (A, service): a gap between the ack and the repeat, even with a new pid ⇒ possible-duplicate{gap}", async () => {
		const service = makeService();
		await deliverIdle(service, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		await store.open(SID, CID);
		store.enqueue(SID, CID, {
			ev: "gap",
			prompt_id: null,
			turn_id: null,
			agent_id: null,
			pane: null,
			data: { reason: "relay_dropped" },
		});
		await store.flush(SID, CID);
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "busy" }];
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		await until(async () => (await markers()).length === 1, "marker");
		expect((await markers())[0]?.data).toMatchObject({
			state: "possible-duplicate",
			reason: "gap",
		});
	});
	it("SF-1 (F, service): stop mid-turn, resume, another turn finishes, the same text later, new pid ⇒ possible-duplicate", async () => {
		const service = makeService();
		await deliverIdle(service, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "idle" }];
		await sessionStart("resume");
		await promptArrives("other work", "p-other");
		await turnEnd("p-other");
		now += 5 * 60_000;
		await promptArrives("hello", "p-later");
		await until(async () => (await markers()).length === 1, "marker");
		expect((await markers())[0]?.data).toMatchObject({
			state: "possible-duplicate",
			reason: "prompt-before-repeat,turn-end-before-repeat",
		});
	});
	it("a crash mid-turn (no turn_end before the resume) with another pid ⇒ duplicated (proven)", async () => {
		const service = makeService();
		await deliverIdle(service, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "busy" }];
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		await until(async () => (await markers()).length === 1, "marker");
		expect((await markers())[0]?.data.state).toBe("duplicated");
	});
	it("M17: possible-duplicate is written once even when a SECOND process observes the same evidence", async () => {
		const a = makeService();
		await deliverIdle(a, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		await turnEnd("p-1");
		await sessionStart("resume");
		await promptArrives("hello", "p-retyped");
		await until(async () => (await markers()).length === 1, "first marker");
		for (const u of listeners) u();
		listeners = [];
		const b = makeService();
		await b.recover(SID);
		await promptArrives("noise", "p-n");
		await new Promise((r) => setTimeout(r, 80));
		expect(await markers()).toHaveLength(1);
	});
	it("evidence time: a relaunch INSIDE the window, observed by a backend that restarted AFTER it, is still judged (catch-up)", async () => {
		const a = makeService();
		await deliverIdle(a, "hello", "p-1");
		await until(async () => (await jobRecord()).kind === "none", "released");
		for (const u of listeners) u();
		listeners = [];
		probe = [{ sessionId: CID, kind: "background", id: SHORT, pid: 901, status: "busy" }];
		now += 60_000;
		await sessionStart("resume");
		await promptArrives("hello", "p-rerun");
		now += 20 * 60_000; // the new process starts long after the window
		const b = makeService();
		await b.recover(SID);
		await until(async () => (await markers()).length === 1, "catch-up marker");
		expect((await markers())[0]?.data.state).toBe("duplicated");
	});
});

describe("scenario 12 — identical text collisions: `delivered` is NEVER set by text coincidence alone", () => {
	const neverDelivered = async () => {
		timers.fire(8_000);
		await new Promise((r) => setTimeout(r, 50));
		expect(await composerStates()).not.toContain("delivered");
		expect(await composerStates()).not.toContain("misdelivered");
	};
	const enqueue = (atMs: number, content = "hello") =>
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(atMs),
			sessionId: CID,
			content,
		});
	const dequeue = (atMs: number) =>
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "dequeue",
			timestamp: iso(atMs),
			sessionId: CID,
		});
	const userEntry = (promptId: string, promptSource: string, atMs: number) =>
		transcripts.add(TPATH, {
			type: "user",
			promptSource,
			promptId,
			timestamp: iso(atMs),
			sessionId: CID,
		});
	it("human typed the same text while busy BEFORE our enqueue (running turn's prompt_id; their item first in the queue)", async () => {
		const service = makeService();
		const t0 = now;
		await promptArrives("SLOW turn", "p-run");
		void send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		enqueue(t0 + 20); // the person's, while busy
		await promptArrives("hello", "p-run"); // its hook: the running turn's id
		enqueue(t0 + 40); // ours
		dequeue(t0 + 5_000);
		userEntry("p-a", "queued", t0 + 5_010); // the person's item ran first
		await neverDelivered();
	});
	it("human typed the same text while busy AFTER our enqueue (two identical enqueues in the window)", async () => {
		const service = makeService();
		const t0 = now;
		await promptArrives("SLOW turn", "p-run");
		void send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		enqueue(t0 + 40); // ours
		enqueue(t0 + 900); // the person's, same text
		await promptArrives("hello", "p-run");
		dequeue(t0 + 5_000);
		userEntry("p-ours", "queued", t0 + 5_010);
		await promptArrives("hello", "p-ours");
		await neverDelivered();
	});
	it("ours popped with ↑ and the person resubmits the same text (typed, new prompt_id)", async () => {
		const service = makeService();
		const t0 = now;
		void send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		enqueue(t0 + 40);
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "popAll",
			timestamp: iso(t0 + 500),
			sessionId: CID,
			content: "hello",
		});
		userEntry("p-typed", "typed", t0 + 1_500);
		await promptArrives("hello", "p-typed");
		await neverDelivered();
	});
	it("ours popped and the person re-queues the same text while busy (queued, new prompt_id)", async () => {
		const service = makeService();
		const t0 = now;
		void send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		enqueue(t0 + 40);
		transcripts.add(TPATH, {
			type: "queue-operation",
			operation: "popAll",
			timestamp: iso(t0 + 500),
			sessionId: CID,
			content: "hello",
		});
		enqueue(t0 + 1_500);
		dequeue(t0 + 6_000);
		userEntry("p-requeued", "queued", t0 + 6_010);
		await promptArrives("hello", "p-requeued");
		await neverDelivered();
	});
	it("hook gap: ours ran in the transcript but its UserPromptSubmit never arrived — and an unrelated same-text hook did", async () => {
		const service = makeService();
		const t0 = now;
		const r = send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		enqueue(t0 + 40);
		dequeue(t0 + 50);
		userEntry("p-ours-no-hook", "queued", t0 + 60);
		// A hook with the same words but another prompt id (e.g. the person).
		userEntry("p-human", "typed", t0 + 3_000);
		await promptArrives("hello", "p-human");
		await neverDelivered();
		expect((await r).body).toMatchObject({ result: "accepted" });
		// And at T_ack_bg it ends unconfirmed, never delivered.
		now += 10 * 60_000 + 1;
		timers.fire(1_000);
		await until(async () => (await composerStates()).includes("unconfirmed"), "unconfirmed");
	});
});

describe("D2 transcript unavailable after acceptance ⇒ unconfirmed, never failed, never retried", () => {
	it("a hook candidate but no readable transcript: unconfirmed{transcript-unavailable} at T_ack_bg", async () => {
		const service = makeService();
		void send(service, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		transcripts.readable = false;
		await promptArrives("hello", "p-1");
		timers.fire(8_000);
		await new Promise((r) => setTimeout(r, 30));
		expect(await composerStates()).not.toContain("delivered");
		now += 10 * 60_000 + 1;
		timers.fire(1_000);
		await until(async () => (await composerStates()).includes("unconfirmed"), "unconfirmed");
		const ev = (await eventsOf()).find(
			(e) => e.ev === "composer_send" && e.data.state === "unconfirmed",
		);
		expect(ev?.data.detail).toBe("transcript-unavailable");
		expect(await composerStates()).not.toContain("failed");
		expect(docker.replyCalls()).toHaveLength(1);
	});
});

describe("D3 a custom CLAUDE_CONFIG_DIR is refused, with no inferred path", () => {
	it("the worker's config dir is not the container default ⇒ 409 unsupported-config-dir, no effect", async () => {
		docker.ins.configDir = "/home/developer/custom-claude";
		const service = makeService();
		expect(await send(service, "hello")).toEqual({
			status: 409,
			body: { error: "unsupported-config-dir" },
		});
		await nothingHappened();
	});
});

describe("COMPOSER_BG_SESSIONS: the transport applies only to listed sessions", () => {
	it("a session not listed is refused exactly as with the flag off (no probe, no exec) and not marked background", async () => {
		const service = makeService(
			{},
			{ sessions: new Set(["99999999-9999-4999-8999-999999999999"]) },
		);
		expect((await send(service, "hello")).body).toEqual({ error: "not-interactive" });
		expect(docker.calls).toEqual([]);
		const av = await service.availability(SID, [{ cid: CID, kind: "interactive", paneId: null }], {
			captureEffective: true,
			callerMayOperate: true,
		});
		expect(av.get(CID)).toEqual({ canSendInput: false, composer: { blocked: false } });
	});
});

// ── Restart recovery ────────────────────────────────────────────────────────

describe("restart recovery: evidence only, nothing resent", () => {
	it("prepared with a pending exec: settled by execState, stays uncertain, never resent; a later ack delivers", async () => {
		const t0 = now;
		docker.replies = ["park"];
		const a = makeService();
		void send(a, "hello");
		await until(() => docker.parked.size === 1, "parked");
		for (const u of listeners) u();
		listeners = [];
		// A new process: the parked exec ended meanwhile (exit 0, output lost).
		const [id] = [...docker.parked.keys()];
		docker.states.set(id as string, { running: false, exitCode: 0 });
		const b = makeService();
		await b.recover(SID);
		let rec = await jobRecord();
		expect(rec.kind === "ok" && [rec.record.state, rec.record.phase]).toEqual([
			"uncertain",
			"cancelled",
		]);
		expect(rec.kind === "ok" && rec.record.execs[0]?.settled?.exit_code).toBe(0);
		expect(docker.replyCalls()).toHaveLength(1);
		expect((await send(b, "x", ID2)).body).toMatchObject({ error: "send-in-progress" });
		transcriptReply("hello", "p-1", t0 + 40);
		await promptArrives("hello", "p-1");
		await until(async () => (await composerStates()).includes("delivered"), "delivered");
		await until(async () => (await jobRecord()).kind === "none", "released");
		rec = await jobRecord();
		expect(rec.kind).toBe("none");
		expect(docker.replyCalls()).toHaveLength(1);
	});

	it("accepted: re-evaluated from the persisted events + transcript ⇒ delivered", async () => {
		const t0 = now;
		const a = makeService();
		void send(a, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		for (const u of listeners) u();
		listeners = [];
		transcriptReply("hello", "p-1", t0 + 40);
		await promptArrives("hello", "p-1");
		const b = makeService();
		await b.recover(SID);
		await until(async () => (await jobRecord()).kind === "none", "released");
		const states = await composerStates();
		expect(states).toContain("delivered");
		expect(docker.replyCalls()).toHaveLength(1);
	});

	it("accepted past T_ack_bg with no ack ⇒ unconfirmed on recovery", async () => {
		const a = makeService();
		void send(a, "hello");
		await until(async () => (await composerStates()).includes("accepted"), "accepted");
		for (const u of listeners) u();
		listeners = [];
		now += 10 * 60_000 + 1;
		const b = makeService();
		await b.recover(SID);
		await until(async () => (await jobRecord()).kind === "none", "released");
		expect(await composerStates()).toContain("unconfirmed");
		expect(docker.replyCalls()).toHaveLength(1);
	});

	it("an orphaned active record whose exec was never created ⇒ failed, released", async () => {
		const at = iso(now);
		await records.write({
			v: 1,
			sid: SID,
			pane_id: JOB,
			pane_pid: WORKER,
			container_id: "cont-1",
			cid: CID,
			client_message_id: ID1,
			text_hash: "h",
			prepared_at: at,
			state: "prepared",
			result: "pending",
			phase: "active",
			execs: [],
			job: {
				short: SHORT,
				pid: WORKER,
				start: WORKER_START,
				exe: EXE,
				nonce: NONCE,
				pty_host_pid: PTY_HOST,
				daemon_pid: DAEMON,
				daemon_start: DAEMON_START,
				daemon_exe: EXE,
				version: "2.1.318",
				uid: 1000,
				config_dir: CFG,
			},
			updated_at: at,
		});
		const b = makeService();
		await b.recover(SID);
		await until(async () => (await jobRecord()).kind === "none", "released");
		expect(docker.replyCalls()).toHaveLength(0);
	});
});

// ── Admin ───────────────────────────────────────────────────────────────────

describe("admin resolution of a job record (§8.1.11)", () => {
	it("an uncertain job op can be declared and released once settled", async () => {
		docker.replies = ["no-answer"];
		const service = makeService();
		await send(service, "hello");
		const r = await service.resolve({
			stSessionId: SID,
			paneId: JOB,
			clientMessageId: ID1,
			outcome: "sent-manually",
			by: "adm",
			audit: async () => undefined,
		});
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ result: "resolved", released: true });
		const panes = await service.panes(SID);
		expect(panes.panes).toEqual([]);
	});
});
