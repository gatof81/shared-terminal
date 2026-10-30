/**
 * composer.test.ts — CONVERSATION.md §8 and the §10 "3.2 composer" checklist
 * against a real ConversationStore and a real PaneRecordStore in a temp
 * directory, with a scripted Docker port (every exec is identified by its
 * argv; a test can park, fail or lose any step behind a barrier) and a
 * scripted probe. Timers are a seam (`after`) the tests fire by hand, so
 * every race below is deterministic: the only waiting is `until(...)` on a
 * condition the code under test produces (disk writes are real).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "../types.js";
import { type ComposerDockerPort, ComposerService, parseCliVersions } from "./composer.js";
import { CSI_U_NEWLINE, normalizeText, textHash } from "./composerText.js";
import { PaneRecordStore } from "./paneRecord.js";
import type { ProbeEntry } from "./probe.js";
import { ConversationStore, type PendingEvent } from "./store.js";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CID = "conv-a";
const PANE = "%3";
const PANE_PID = 700;
const CLAUDE_PID = 733;
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const RULE = "─".repeat(40);

// ── Scripted Docker ─────────────────────────────────────────────────────────

type Step = "display" | "capture" | "ancestry" | "paste" | "newline" | "enter" | "other";
interface Call {
	id: string;
	step: Step;
	cmd: string[];
	stdin: string | null;
	started: boolean;
}
function stepOf(cmd: string[]): Step {
	const j = cmd.join(" ");
	if (j.includes("tmux display")) return "display";
	if (j.includes("capture-pane")) return "capture";
	if (j.includes("st-ancestry")) return "ancestry";
	if (j.includes("load-buffer")) return "paste";
	if (j.includes(CSI_U_NEWLINE)) return "newline";
	if (j.endsWith("Enter")) return "enter";
	return "other";
}

class FakeDocker implements ComposerDockerPort {
	calls: Call[] = [];
	paneState = `${PANE_PID} 0 0 claude`;
	/** A fixed capture (precondition tests); null = render what was typed. */
	dump: string | null = null;
	/** When true the echo never appears (the CLI did not consume the paste). */
	frozenEcho = false;
	typed = "";
	ancestry = "yes";
	container: "running" | "stopped" | "gone" = "running";
	/** Per step: outcomes for successive execs of that step; default exit 0. */
	script = new Map<Step, Array<{ exit: number | null } | "park" | "reject">>();
	parked = new Map<string, (r: { exit: number | null }) => void>();
	states = new Map<string, { running: boolean; exitCode: number | null } | null>();
	private n = 0;
	/** The effect steps that started, in order (reads excluded). */
	effectSteps(): string[] {
		return this.calls
			.filter((c) => c.started && ["paste", "newline", "enter"].includes(c.step))
			.map((c) => c.step);
	}
	pastes(): Call[] {
		return this.calls.filter((c) => c.step === "paste");
	}
	release(id: string, exit: number | null): void {
		const r = this.parked.get(id);
		if (!r) throw new Error(`exec ${id} not parked`);
		this.parked.delete(id);
		r({ exit });
	}
	async exec(
		_container: string,
		cmd: string[],
		stdin: Buffer | null,
		onCreated: (id: string) => Promise<boolean>,
	) {
		const step = stepOf(cmd);
		const id = `e${++this.n}-${step}`;
		const call: Call = { id, step, cmd, stdin: stdin?.toString("utf8") ?? null, started: false };
		this.calls.push(call);
		const q = this.script.get(step);
		const plan = q && q.length > 0 ? q.shift()! : { exit: 0 };
		if (plan === "reject") throw new Error("docker: cannot create exec");
		if (!(await onCreated(id))) return { execId: id, exitCode: null, stdout: "" };
		call.started = true;
		let outcome: { exit: number | null };
		if (plan === "park") outcome = await new Promise((r) => this.parked.set(id, r));
		else outcome = plan;
		if (outcome.exit !== null) this.states.set(id, { running: false, exitCode: outcome.exit });
		else this.states.set(id, null);
		// The pane's echo of a settled effect, as the real CLI shows it.
		if (outcome.exit === 0 && !this.frozenEcho) {
			if (step === "paste") this.typed += call.stdin ?? "";
			else if (step === "newline") this.typed += "\n";
			else if (step === "enter") this.typed = "";
		}
		const stdout =
			step === "display"
				? `${this.paneState}\n`
				: step === "capture"
					? (this.dump ?? `${RULE}\n❯ ${this.typed}\n${RULE}\n  ⏵⏵ auto mode on`)
					: step === "ancestry"
						? `${this.ancestry}\n`
						: "";
		return { execId: id, exitCode: outcome.exit, stdout };
	}
	async execState(id: string) {
		return this.states.has(id) ? this.states.get(id)! : null;
	}
	async containerState() {
		return this.container;
	}
}

// ── Timers seam ─────────────────────────────────────────────────────────────

class Timers {
	pending: Array<{ ms: number; fire: () => void }> = [];
	after = (ms: number) => new Promise<void>((r) => this.pending.push({ ms, fire: r }));
	/** Fire every pending timer of exactly `ms` (T_http or T_ack). */
	fire(ms: number): void {
		const now = this.pending.filter((t) => t.ms === ms);
		this.pending = this.pending.filter((t) => t.ms !== ms);
		for (const t of now) t.fire();
	}
}

// ── Harness ─────────────────────────────────────────────────────────────────

async function until(pred: () => boolean | Promise<boolean>, label = "condition"): Promise<void> {
	const deadline = Date.now() + 4000;
	while (!(await pred())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}
const settle = () => new Promise((r) => setTimeout(r, 25));

let root: string;
let store: ConversationStore;
let records: PaneRecordStore;
/** Every listener the services under test registered; `killProcess()` cuts them all (a SIGKILL observes nothing more). */
let listeners: Array<() => void> = [];
function killProcess(): void {
	for (const u of listeners) u();
	listeners = [];
}
/**
 * The pane lock is released a few microtasks after the event a test waited
 * for (the release runs inside it); a send fired in that window is a
 * legitimate transient 409. Tests that model a LATER send wait for the lock.
 */
const lockFree = (service: ComposerService, pane = PANE) =>
	until(
		() =>
			(service as unknown as { lock: { heldBy(k: string): unknown } }).lock.heldBy(
				`${SID}\u0000${pane}`,
			) === null,
		"pane lock free",
	);
let docker: FakeDocker;
let timers: Timers;
let probe: ProbeEntry[] | null;
let captureEffective: boolean;
let meta: SessionMeta;
let now: number;

function makeService(over: Partial<ConstructorParameters<typeof ComposerService>[0]> = {}) {
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
		...over,
	});
}

async function seedConversation(
	cid = CID,
	over: Partial<{ kind: string; paneId: string | null; claudeVersion: string | null }> = {},
) {
	await store.open(SID, cid);
	store.update(SID, cid, (i) => {
		i.kind = (over.kind ?? "interactive") as typeof i.kind;
		i.paneId = over.paneId === undefined ? PANE : over.paneId;
		i.claudeVersion = over.claudeVersion === undefined ? "2.1.314" : over.claudeVersion;
	});
	await store.flush(SID, cid);
}

const audit = { calls: 0, fail: false };
function send(service: ComposerService, text: string, id = ID1, cid = CID, callerId = "owner") {
	return service.send({
		stSessionId: SID,
		cid,
		callerId,
		meta,
		body: { text, clientMessageId: id },
		audit: async () => {
			audit.calls++;
			if (audit.fail) throw new Error("d1 down");
		},
	});
}

/** A human `user_prompt` landing in `cid` from `pane`, as the ingest would persist it. */
async function promptArrives(
	text: string,
	cid = CID,
	pane = PANE,
	data: Record<string, unknown> = {},
) {
	await store.open(SID, cid);
	const pending: PendingEvent = {
		ev: "user_prompt",
		prompt_id: `p-${Math.random().toString(36).slice(2, 8)}`,
		turn_id: null,
		agent_id: null,
		pane,
		data: { prompt: text, ...data },
	};
	store.enqueue(SID, cid, pending);
	await store.flush(SID, cid);
	return pending.prompt_id;
}

async function eventsOf(cid = CID) {
	await store.flush(SID, cid);
	const raw = await fs.readFile(store.eventsPath(SID, cid), "utf8").catch(() => "");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { ev: string; data: Record<string, unknown> });
}
const composerStates = async (cid = CID) =>
	(await eventsOf(cid)).filter((e) => e.ev === "composer_send").map((e) => e.data.state as string);
const recordGone = () => records.read(SID, PANE).then((r) => r.kind === "none");
const recordIs = (pred: (r: Record<string, unknown>) => boolean) =>
	records
		.read(SID, PANE)
		.then((r) => r.kind === "ok" && pred(r.record as unknown as Record<string, unknown>));
const resolve = (
	service: ComposerService,
	outcome: "discarded" | "sent-manually" | "reconcile",
	id = ID1,
) => {
	const a = { calls: 0 };
	return service
		.resolve({
			stSessionId: SID,
			paneId: PANE,
			clientMessageId: id,
			outcome,
			by: "adm",
			audit: async () => {
				a.calls++;
			},
		})
		.then((r) => ({ ...r, auditCalls: a.calls }));
};

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-composer-"));
	now = 1_800_000_000_000;
	store = new ConversationStore({ workspaceRoot: root, now: () => now });
	records = new PaneRecordStore(root);
	listeners = [];
	docker = new FakeDocker();
	timers = new Timers();
	probe = [{ sessionId: CID, kind: "interactive", pid: CLAUDE_PID, status: "idle" }];
	captureEffective = true;
	audit.calls = 0;
	audit.fail = false;
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
	await seedConversation();
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("happy path (§8.1.5, §8.1.7)", () => {
	it("prepared is durable before the first effect; paste/newline/Enter; the ack delivers; the pane is released; replay answers the same", async () => {
		const service = makeService();
		let recordAtFirstEffect: string | null = null;
		let eventsAtFirstEffect: string[] = [];
		const origExec = docker.exec.bind(docker);
		docker.exec = async (c, cmd, stdin, onCreated) =>
			origExec(c, cmd, stdin, async (id) => {
				if (stepOf(cmd) === "paste" && recordAtFirstEffect === null) {
					recordAtFirstEffect = (await records.read(SID, PANE)).kind;
					eventsAtFirstEffect = await composerStates();
				}
				return onCreated(id);
			});
		const p = send(service, "hello\n\nworld");
		await until(() => docker.effectSteps().length === 5, "effects");
		expect(docker.effectSteps()).toEqual(["paste", "newline", "newline", "paste", "enter"]);
		expect(docker.pastes().map((c) => c.stdin)).toEqual(["hello", "world"]);
		expect(recordAtFirstEffect).toBe("ok");
		expect(eventsAtFirstEffect).toEqual(["prepared"]);
		const promptId = await promptArrives("hello\n\nworld");
		const r = await p;
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ result: "delivered", clientMessageId: ID1, promptId });
		await until(recordGone, "release");
		expect(await composerStates()).toEqual(["prepared", "entered", "delivered", "released"]);
		for (const e of (await eventsOf()).filter((x) => x.ev === "composer_send")) {
			expect(e.data.text).toBeUndefined();
			expect(e.data.text_hash).toBe(textHash(normalizeText("hello\n\nworld")));
			expect(e.data.pane_id).toBe(PANE);
		}
		// Replay: the same id answers the recorded HTTP, with no effect.
		const calls = docker.calls.length;
		expect(await send(service, "hello\n\nworld")).toEqual(r);
		expect(docker.calls.length).toBe(calls);
		expect(store.getResidentIndex(SID, CID)?.composerSends?.[ID1]?.status).toBe(202);
	});

	it("the ack needs the same pane and a human origin; other panes, injected and unverified prompts never count; T_ack ⇒ unconfirmed", async () => {
		const service = makeService();
		const p = send(service, "same text");
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("same text", CID, "%9"); // other pane
		await promptArrives("same text", CID, PANE, { source: "sdk" }); // injected
		await promptArrives("same text", CID, PANE, { origin: "unverified" }); // unverified
		await settle();
		timers.fire(8_000);
		const r = await p;
		expect(r.body).toMatchObject({ result: "unconfirmed", clientMessageId: ID1 });
		await until(recordGone);
		expect(await composerStates()).toEqual(["prepared", "entered", "unconfirmed", "released"]);
	});

	it("misdelivered: the same pane handed the text to another conversation (/clear window)", async () => {
		await seedConversation("conv-b");
		const service = makeService();
		const p = send(service, "where did it go");
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("where did it go", "conv-b", PANE);
		const r = await p;
		expect(r.body).toMatchObject({ result: "misdelivered", conversation: "conv-b" });
		await until(recordGone);
		expect(await composerStates()).toEqual(["prepared", "entered", "misdelivered", "released"]);
	});

	it("two panes, identical text, interleaved prompts: each send is confirmed by its own pane only", async () => {
		await seedConversation("conv-b", { paneId: "%4" });
		probe = [
			{ sessionId: CID, kind: "interactive", pid: CLAUDE_PID, status: "idle" },
			{ sessionId: "conv-b", kind: "interactive", pid: 800, status: "idle" },
		];
		const service = makeService();
		const pA = send(service, "twin", ID1, CID);
		await until(() => docker.effectSteps().filter((s) => s === "enter").length === 1);
		docker.paneState = "900 0 0 claude";
		const pB = send(service, "twin", ID2, "conv-b");
		await until(() => docker.effectSteps().filter((s) => s === "enter").length === 2);
		await promptArrives("twin", "conv-b", "%4"); // B's own, first
		await promptArrives("twin", CID, PANE);
		const [a, b] = await Promise.all([pA, pB]);
		expect(a.body).toMatchObject({ result: "delivered" });
		expect(b.body).toMatchObject({ result: "delivered" });
	});
});

describe("validation and preconditions (§8.1.2, §8.1.3): no effect, no record", () => {
	const noEffects = async () => {
		expect(docker.effectSteps()).toEqual([]);
		expect(await records.read(SID, PANE)).toEqual({ kind: "none" });
		expect(await composerStates()).toEqual([]);
	};
	it("400s", async () => {
		const service = makeService();
		expect((await send(service, "")).body.error).toBe("empty-text");
		expect((await send(service, "/help")).body.error).toBe("unsupported-prefix");
		expect((await send(service, "a\u0007")).body.error).toBe("control-bytes");
		const bad = await service.send({
			stSessionId: SID,
			cid: CID,
			callerId: "owner",
			meta,
			body: { text: "x" },
			audit: async () => undefined,
		});
		expect(bad.body.error).toBe("invalid-body");
		await noEffects();
	});
	it("busy / dialog / copy-mode / dead / foreground / composer text / probe / binding / capture / version / not running / kind", async () => {
		const service = makeService();
		const expectCode = async (code: string, detail?: string) => {
			const r = await send(service, "hi", ID1);
			expect([r.status, r.body.error]).toEqual([409, code]);
			if (detail) expect(r.body.detail).toBe(detail);
		};
		probe![0]!.status = "busy";
		await expectCode("busy");
		probe![0]!.status = "waiting";
		probe![0]!.waitingFor = "dialog open";
		await expectCode("needs-terminal", "dialog open");
		probe![0]!.waitingFor = "input needed";
		docker.paneState = `${PANE_PID} 1 0 claude`;
		await expectCode("needs-terminal", "copy-mode");
		docker.paneState = `${PANE_PID} 0 1 claude`;
		await expectCode("needs-terminal", "pane-dead");
		docker.paneState = `${PANE_PID} 0 0 bash`;
		await expectCode("needs-terminal", "foreground:bash");
		docker.paneState = `${PANE_PID} 0 0 claude`;
		docker.dump = `${RULE}\n❯ partial\n${RULE}\n`;
		await expectCode("composer-not-empty", "text");
		docker.dump = "no marker here";
		await expectCode("composer-not-empty", "no-prompt-marker");
		docker.dump = null;
		docker.ancestry = "no";
		await expectCode("binding-stale");
		docker.ancestry = "yes";
		probe = [{ sessionId: "other", kind: "interactive", pid: 1, status: "idle" }];
		await expectCode("probe-failed");
		probe = null;
		await expectCode("probe-failed");
		probe = [{ sessionId: CID, kind: "interactive", pid: CLAUDE_PID, status: "idle" }];
		captureEffective = false;
		await expectCode("capture-inactive");
		captureEffective = true;
		await seedConversation(CID, { claudeVersion: "2.1.310" });
		await expectCode("cli-unvalidated");
		await seedConversation(CID, { claudeVersion: "2.1.314" });
		meta = { ...meta, status: "stopped" };
		await expectCode("session-not-running");
		meta = { ...meta, status: "running" };
		await seedConversation(CID, { kind: "headless" });
		await expectCode("not-interactive");
		await noEffects();
	});
	it("a cross-user send writes the operate row before any effect, fail-closed; the event says admin", async () => {
		const service = makeService();
		audit.fail = true;
		const r = await send(service, "hi", ID1, CID, "admin-1");
		expect([r.status, r.body.error]).toEqual([500, "audit-failed"]);
		expect(audit.calls).toBe(1);
		await noEffects();
		audit.fail = false;
		const p = send(service, "hi", ID2, CID, "admin-1");
		await until(() => docker.effectSteps().includes("enter"));
		expect(audit.calls).toBe(2);
		expect(docker.effectSteps()).toEqual(["paste", "enter"]);
		await promptArrives("hi");
		expect((await p).body.result).toBe("delivered");
		expect((await eventsOf()).find((e) => e.ev === "composer_send")?.data.actor).toBe("admin");
	});
});

describe("exclusion by pane and idempotency (§8.1.4)", () => {
	it("two conversations on the same pane: one delivers, the other 409; a different pane is not blocked", async () => {
		await seedConversation("conv-b"); // same pane
		await seedConversation("conv-c", { paneId: "%5" });
		probe = [
			{ sessionId: CID, kind: "interactive", pid: CLAUDE_PID, status: "idle" },
			{ sessionId: "conv-b", kind: "interactive", pid: CLAUDE_PID, status: "idle" },
			{ sessionId: "conv-c", kind: "interactive", pid: 950, status: "idle" },
		];
		docker.script.set("paste", ["park"]);
		const service = makeService();
		const pA = send(service, "a", ID1, CID);
		await until(() => docker.parked.size === 1);
		const rB = await send(service, "b", ID2, "conv-b");
		expect(rB.status).toBe(409);
		expect(rB.body).toMatchObject({ error: "send-in-progress", clientMessageId: ID1 });
		docker.paneState = "960 0 0 claude";
		const pC = send(service, "c", ID3, "conv-c");
		await until(() => docker.effectSteps().filter((s) => s === "enter").length === 1, "C's Enter");
		docker.release(docker.pastes()[0]!.id, 0);
		await until(() => docker.effectSteps().filter((s) => s === "enter").length === 2, "A's Enter");
		await promptArrives("a", CID, PANE);
		await promptArrives("c", "conv-c", "%5");
		expect((await pA).body.result).toBe("delivered");
		expect((await pC).body.result).toBe("delivered");
	});

	it("double click: one delivery sequence; the same id in flight answers 202 uncertain with no effect", async () => {
		docker.script.set("paste", ["park"]);
		const service = makeService();
		const p1 = send(service, "once");
		await until(() => docker.parked.size === 1);
		const r2 = await send(service, "once");
		expect(r2.status).toBe(202);
		expect(r2.body).toMatchObject({ result: "uncertain", clientMessageId: ID1 });
		expect(docker.pastes().length).toBe(1);
		docker.release(docker.pastes()[0]!.id, 0);
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("once");
		expect((await p1).body.result).toBe("delivered");
		expect(docker.pastes().length).toBe(1);
	});

	it("a known failure at paste k: k−1 pastes, no Enter, 502, released; the replay is 502 again, never 202", async () => {
		docker.script.set("paste", [{ exit: 1 }]);
		const service = makeService();
		const r1 = await send(service, "a\nb");
		expect(r1.status).toBe(502);
		expect(r1.body).toMatchObject({
			error: "delivery-failed",
			stage: "paste",
			segmentsSent: 0,
			segments: 2,
		});
		await until(recordGone, "release");
		expect(docker.effectSteps()).toEqual(["paste"]);
		expect(await composerStates()).toEqual(["prepared", "failed", "released"]);
		expect(await send(service, "a\nb")).toEqual(r1);
	});
});

describe("Work round 1 (#488): release identity, shutdown, released-before-remove, T_http completion", () => {
	it("P1: a late release never removes the successor's record — releases run under the pane lock and remove by identity", async () => {
		const service = makeService();
		const realRemove = records.remove.bind(records);
		let mode: "fail" | "park" | "ok" = "fail";
		const parked: Array<() => void> = [];
		let attempts = 0;
		records.remove = (async (sid, pane, id) => {
			attempts++;
			if (mode === "fail") throw new Error("EIO");
			if (mode === "park") await new Promise<void>((r) => parked.push(r));
			return realRemove(sid, pane, id);
		}) as typeof records.remove;
		// A delivered, but its record removal failed: A stays live, its record stale.
		const pA = send(service, "first");
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("first");
		expect((await pA).body).toMatchObject({ result: "delivered" });
		await until(async () => (await composerStates()).at(-1) === "released");
		await until(() => attempts === 1, "A's removal attempted (and failed)");
		expect((await records.read(SID, PANE)).kind).toBe("ok");
		// B and C arrive together. B takes the pane lock and retries A's release
		// there (parked at the removal); C cannot interleave: the lock is held.
		mode = "park";
		docker.script.set("paste", ["park"]);
		await lockFree(service);
		const pB = send(service, "second", ID2);
		await until(() => parked.length === 1, "B parked at A's removal");
		const rC = await send(service, "third", ID3);
		expect(rC.body).toMatchObject({ error: "send-in-progress" });
		mode = "ok";
		parked[0]!();
		// B is now the pane's operation, mid-delivery (its paste is parked)…
		await until(() => docker.parked.size === 1, "B's paste parked");
		const during = await records.read(SID, PANE);
		expect(during.kind === "ok" && during.record.client_message_id).toBe(ID2);
		// …and nothing that happened before can remove ITS record: a direct
		// late removal in A's name finds another owner and leaves it alone.
		expect(await realRemove(SID, PANE, ID1)).toBe("other");
		expect((await records.read(SID, PANE)).kind).toBe("ok");
		docker.release(docker.pastes()[1]!.id, 0);
		await until(() => docker.effectSteps().filter((x) => x === "enter").length === 2);
		await promptArrives("second");
		expect((await pB).body).toMatchObject({ result: "delivered" });
		await until(recordGone, "B released");
	});

	it("P1: shutdown cancels the active executor durably and refuses new sends; a late paste answer is evidence, never a continuation", async () => {
		docker.script.set("paste", ["park"]);
		const service = makeService();
		const p = send(service, "l1\nl2\nl3");
		await until(() => docker.parked.size === 1);
		await service.shutdown();
		await until(
			() =>
				recordIs(
					(x) =>
						x.phase === "cancelled" && x.cancel_reason === "shutdown" && x.state === "uncertain",
				),
			"cancellation written by shutdown",
		);
		expect((await send(service, "x", ID2)).status).toBe(503);
		expect((await send(service, "x", ID2)).body).toMatchObject({ error: "shutting-down" });
		expect((await p).body).toMatchObject({ result: "uncertain" });
		// The late success of the first paste: evidence for that exec only.
		docker.release(docker.pastes()[0]!.id, 0);
		await until(async () => (await composerStates()).at(-1) === "released", "settled by evidence");
		expect(docker.effectSteps()).toEqual(["paste"]); // no newline, no l2, no Enter
		expect(await composerStates()).toEqual(["prepared", "uncertain", "failed", "released"]);
	});

	it("P2: a `released` event that cannot be persisted keeps the record; after a restart the same id replays, it is not a new paste", async () => {
		const service = makeService();
		const real = store.enqueue.bind(store);
		let failReleased = true;
		store.enqueue = ((sid, cid, ev) => {
			if (
				failReleased &&
				ev.ev === "composer_send" &&
				(ev.data as { state: string }).state === "released"
			)
				return "dropped";
			return real(sid, cid, ev);
		}) as typeof store.enqueue;
		const p = send(service, "keep me");
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("keep me");
		expect((await p).body).toMatchObject({ result: "delivered" });
		await until(async () => (await composerStates()).at(-1) === "delivered");
		await new Promise((r) => setTimeout(r, 50));
		// Not released: the record stays (its state is still the result, not `released`).
		expect(await recordIs((x) => x.state === "delivered" && x.result === "delivered")).toBe(true);
		expect((await composerStates()).includes("released")).toBe(false);
		// The process dies; a new one over the same files, with a working store.
		killProcess();
		failReleased = false;
		store = new ConversationStore({ workspaceRoot: root });
		await seedConversation();
		docker = new FakeDocker();
		const s2 = makeService();
		const r = await send(s2, "keep me", ID1);
		expect(r.body).toMatchObject({ result: "delivered" });
		expect(docker.effectSteps()).toEqual([]); // a replay, not a second delivery
		await until(recordGone, "released on recovery");
		expect((await composerStates()).at(-1)).toBe("released");
	});

	it("P2: T_http completes the cancellation while an exec hangs — the record says cancelled, reconcile is possible (not 409), and evidence releases", async () => {
		docker.script.set("paste", ["park"]); // never answered
		const service = makeService();
		const p = send(service, "stuck");
		await until(() => docker.parked.size === 1);
		timers.fire(30_000);
		expect((await p).body).toMatchObject({ result: "uncertain" });
		await until(
			() => recordIs((x) => x.phase === "cancelled" && x.cancel_reason === "t-http"),
			"cancellation written by the timer",
		);
		await lockFree(service);
		// The executor's exclusion is released: reconcile is 200, the pane stays blocked by the pending paste.
		const rec = await service.resolve({
			stSessionId: SID,
			paneId: PANE,
			clientMessageId: ID1,
			outcome: "reconcile",
			by: "admin-1",
			audit: async () => undefined,
		});
		expect(rec.status).toBe(200);
		expect(rec.body).toMatchObject({ effects: "pending", released: false });
		expect((await send(service, "y", ID2)).body).toMatchObject({
			error: "send-in-progress",
			detail: "effects-pending",
		});
		// Evidence: the container is gone ⇒ reconcile settles and releases.
		docker.container = "stopped";
		const rec2 = await service.resolve({
			stSessionId: SID,
			paneId: PANE,
			clientMessageId: ID1,
			outcome: "reconcile",
			by: "admin-1",
			audit: async () => undefined,
		});
		expect(rec2.body).toMatchObject({ released: true });
		await until(recordGone);
		expect(docker.effectSteps()).toEqual(["paste"]);
	});

	it("P2: T_http bounds the whole request — a precondition that hangs answers uncertain; when it finally returns, nothing starts and the id is new", async () => {
		docker.script.set("display", ["park"]); // the pane-state read hangs
		const service = makeService();
		const p = send(service, "late");
		await until(() => docker.parked.size === 1);
		timers.fire(30_000);
		expect((await p).body).toMatchObject({ result: "uncertain", clientMessageId: ID1 });
		docker.release([...docker.parked.keys()][0]!, 0);
		await new Promise((r) => setTimeout(r, 50));
		expect(docker.effectSteps()).toEqual([]);
		expect((await records.read(SID, PANE)).kind).toBe("none");
		expect(await composerStates()).toEqual([]);
		// The same id is a new attempt now (never an operation).
		const p2 = send(service, "late", ID1);
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("late");
		expect((await p2).body).toMatchObject({ result: "delivered" });
	});
});

describe("review fixes (PR #488)", () => {
	it("a dropped `entered` event never flips a delivered message to failed", async () => {
		const service = makeService();
		// The store refuses exactly the `entered` event (L6 full / not open).
		const real = store.enqueue.bind(store);
		let dropped = 0;
		store.enqueue = ((sid, cid, ev) => {
			if (ev.ev === "composer_send" && (ev.data as { state: string }).state === "entered") {
				dropped++;
				return "dropped";
			}
			return real(sid, cid, ev);
		}) as typeof store.enqueue;
		const p = send(service, "hello");
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("hello");
		const r = await p;
		expect(dropped).toBe(1);
		expect(r.body).toMatchObject({ result: "delivered" });
		await until(recordGone, "release");
		expect(await composerStates()).toEqual(["prepared", "delivered", "released"]);
		expect((await service.adminStats()).persistFailuresSinceBoot).toBe(1);
	});

	it("a failed record removal keeps the op live; the next send on the pane re-evaluates and releases it", async () => {
		const service = makeService();
		const realRemove = records.remove.bind(records);
		let fail = true;
		records.remove = (async (sid, pane, id) => {
			if (fail) throw new Error("EIO");
			return realRemove(sid, pane, id);
		}) as typeof records.remove;
		const p = send(service, "first");
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("first");
		expect((await p).body).toMatchObject({ result: "delivered" });
		await until(async () => (await composerStates()).at(-1) === "released", "released event");
		expect((await records.read(SID, PANE)).kind).toBe("ok"); // the stale record
		fail = false;
		await lockFree(service);
		const p2 = send(service, "second", ID2);
		await until(
			() => docker.effectSteps().filter((s) => s === "enter").length === 2,
			"second Enter",
		);
		await promptArrives("second");
		expect((await p2).body).toMatchObject({ result: "delivered" });
		// One `released` for the first op, not two.
		expect((await composerStates()).filter((x) => x === "released")).toHaveLength(2);
		await until(recordGone, "second release");
	});

	it("a failed record listing does not mark the session recovered: 409 unverifiable now, normal later", async () => {
		const service = makeService();
		const realList = records.list.bind(records);
		let fail = true;
		records.list = (async (sid) => {
			if (fail) throw new Error("EIO");
			return realList(sid);
		}) as typeof records.list;
		expect((await send(service, "x")).body).toMatchObject({
			error: "send-in-progress",
			detail: "unverifiable",
		});
		fail = false;
		const p = send(service, "x");
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("x");
		expect((await p).body).toMatchObject({ result: "delivered" });
	});

	it("an admin resolution during the live T_ack wait wins: the late ack conclusion writes nothing and no record is re-created", async () => {
		const service = makeService();
		const p = send(service, "quiet");
		await until(() => docker.effectSteps().includes("enter"));
		await until(async () => (await composerStates()).at(-1) === "entered", "entered");
		// No candidate arrives; the operator declares it discarded while the ack is still waiting.
		const r = await service.resolve({
			stSessionId: SID,
			paneId: PANE,
			clientMessageId: ID1,
			outcome: "discarded",
			by: "admin-1",
			audit: async () => undefined,
		});
		expect(r.status).toBe(200);
		await until(recordGone, "released by the resolution");
		timers.fire(8_000); // T_ack: the live conclusion runs now
		const res = await p;
		await new Promise((r) => setTimeout(r, 50));
		expect((await records.read(SID, PANE)).kind).toBe("none");
		const states = await composerStates();
		expect(states).toEqual(["prepared", "entered", "resolved", "released"]);
		// The waiting request got the resolution's recorded answer, not an ack result.
		expect(res).toMatchObject({ status: 202, body: { result: "resolved", outcome: "discarded" } });
	});

	it("parseCliVersions: unset ⇒ default, configured ⇒ exactly the list, malformed ⇒ refuses", () => {
		expect([...parseCliVersions(undefined)]).toEqual(["2.1.314"]);
		expect([...parseCliVersions(" 2.1.320 , 2.1.314 ")]).toEqual(["2.1.320", "2.1.314"]);
		expect(() => parseCliVersions("2.1.320-rc1")).toThrow(/not a version/);
		expect(() => parseCliVersions("2.1.320, latest")).toThrow(/latest/);
	});
});

describe("paste consumption (§8.1.5 paso 2b, smoke 2026-10-30)", () => {
	it("no byte follows a paste the CLI has not echoed: polls, then fails closed with the text possibly in the input", async () => {
		docker.frozenEcho = true;
		const service = makeService();
		const p = send(service, "a\nb");
		// The first paste settled; the executor is now polling the input region.
		await until(() => docker.calls.filter((c) => c.step === "capture").length >= 3, "polling");
		expect(docker.effectSteps()).toEqual(["paste"]);
		for (let i = 0; i < 40; i++) {
			timers.fire(50);
			await new Promise((r) => setImmediate(r));
		}
		const r = await p;
		expect(r.status).toBe(502);
		expect(r.body).toMatchObject({
			error: "delivery-failed",
			stage: "paste",
			segmentsSent: 1,
			segments: 2,
			detail: "not-consumed",
		});
		await until(recordGone, "release");
		// Neither the newline nor the Enter was ever sent.
		expect(docker.effectSteps()).toEqual(["paste"]);
		expect(await composerStates()).toEqual(["prepared", "failed", "released"]);
	});

	it("identical consecutive lines: each paste waits for its OWN echo (count-based), then delivers", async () => {
		const service = makeService();
		const p = send(service, "same\nsame\nsame");
		await until(() => docker.effectSteps().includes("enter"));
		expect(docker.effectSteps()).toEqual([
			"paste",
			"newline",
			"paste",
			"newline",
			"paste",
			"enter",
		]);
		await promptArrives("same\nsame\nsame");
		expect((await p).body.result).toBe("delivered");
		// One capture before and at least one after every paste.
		expect(docker.calls.filter((c) => c.step === "capture").length).toBeGreaterThanOrEqual(4);
	});
});

describe("delayed effects and cancellation (§8.1.4 reglas 3–7, §10)", () => {
	it("paste delayed: T_http answers uncertain, nothing continues, the pane blocks; a late success settles to failed and releases", async () => {
		docker.script.set("paste", [{ exit: 0 }, "park"]);
		const service = makeService();
		const p = send(service, "l1\nl2\nl3");
		await until(() => docker.parked.size === 1);
		expect(docker.effectSteps()).toEqual(["paste", "newline", "paste"]);
		timers.fire(30_000);
		const r = await p;
		expect(r.body).toMatchObject({ result: "uncertain", clientMessageId: ID1 });
		expect((await send(service, "x", ID2)).body).toMatchObject({ error: "send-in-progress" });
		expect((await send(service, "l1\nl2\nl3", ID1)).body).toMatchObject({ result: "uncertain" });
		// The late answer is a success — but the operation is cancelled: no l3, no Enter.
		docker.release(docker.pastes()[1]!.id, 0);
		await until(recordGone, "release after late answer");
		expect(docker.effectSteps()).toEqual(["paste", "newline", "paste"]);
		// T_http recorded the unknown outcome; the late answer settled it as failed.
		expect(await composerStates()).toEqual(["prepared", "uncertain", "failed", "released"]);
		// The pane is free again — but l1/l2 sit in the CLI's input: the person
		// clears them (Ctrl-U) after checking the Terminal, as the 502 asked.
		docker.typed = "";
		await lockFree(service);
		const p3 = send(service, "next", ID2);
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("next");
		expect((await p3).body.result).toBe("delivered");
	});

	it("a paste with an unknown outcome: uncertain stays, a second send is 409 effects-pending, inspect 404 keeps it pending, a numeric exit releases through reconcile", async () => {
		docker.script.set("paste", [{ exit: null }]);
		const service = makeService();
		const r = await send(service, "hang");
		expect(r.body).toMatchObject({ result: "uncertain" });
		await until(() => recordIs((x) => x.phase === "cancelled" && x.state === "uncertain"));
		expect((await send(service, "y", ID2)).body).toMatchObject({
			error: "send-in-progress",
			detail: "effects-pending",
		});
		let res = await resolve(service, "reconcile");
		expect(res.body).toMatchObject({ effects: "pending", released: false, result: "pending" });
		docker.states.set(docker.pastes()[0]!.id, { running: false, exitCode: 0 });
		res = await resolve(service, "reconcile");
		expect(res.body).toMatchObject({ effects: "settled", released: true, result: "failed" });
		expect(await recordGone()).toBe(true);
		expect(await composerStates()).toEqual(["prepared", "uncertain", "failed", "released"]);
	});

	it("Enter delayed: uncertain without delivered; a late 0 becomes entered and the CLI's ack then delivers", async () => {
		docker.script.set("enter", ["park"]);
		const service = makeService();
		const p = send(service, "enter late");
		await until(() => docker.parked.size === 1);
		timers.fire(30_000);
		expect((await p).body).toMatchObject({ result: "uncertain" });
		docker.release(docker.calls.find((c) => c.step === "enter")!.id, 0);
		await settle();
		const res = await resolve(service, "reconcile");
		expect(res.body.result).toBe("pending"); // entered: waiting for the ack, still blocked
		expect(await recordGone()).toBe(false);
		await promptArrives("enter late");
		await until(recordGone, "release after ack");
		expect(await composerStates()).toEqual([
			"prepared",
			"uncertain",
			"entered",
			"delivered",
			"released",
		]);
	});

	it("result ≠ eligibility: an ack with a pending paste records delivered but keeps the pane blocked; container-gone evidence releases", async () => {
		docker.script.set("paste", [{ exit: 0 }, { exit: null }]);
		const service = makeService();
		expect((await send(service, "a\nb")).body).toMatchObject({ result: "uncertain" });
		await until(() => recordIs((x) => x.phase === "cancelled"));
		await promptArrives("a\nb"); // a candidate lands while effects are pending
		let res = await resolve(service, "reconcile");
		expect(res.body).toMatchObject({ effects: "pending", released: false });
		expect((await send(service, "z", ID2)).body).toMatchObject({
			error: "send-in-progress",
			detail: "effects-pending",
		});
		docker.container = "gone";
		res = await resolve(service, "reconcile");
		expect(res.body).toMatchObject({ effects: "settled", released: true });
		const released = (await eventsOf()).find(
			(e) => e.ev === "composer_send" && e.data.state === "released",
		);
		expect(released?.data.evidence).toBe("container-gone");
	});
});

describe("administrative resolution (§8.1.11)", () => {
	it("Case A: before the first effect the executor is active ⇒ 409 operation-active, nothing written, the send goes on", async () => {
		docker.script.set("display", [{ exit: 0 }, "park"]); // the precheck (first effect) is parked
		const service = makeService();
		const p = send(service, "A");
		await until(() => docker.parked.size === 1);
		expect((await records.read(SID, PANE)).kind).toBe("ok");
		const r = await resolve(service, "discarded");
		expect([r.status, r.body.error, r.auditCalls]).toEqual([409, "operation-active", 0]);
		expect(await composerStates()).toEqual(["prepared"]);
		docker.release(docker.calls.filter((c) => c.step === "display")[1]!.id, 0);
		await until(() => docker.effectSteps().includes("enter"));
		expect(docker.effectSteps()).toEqual(["paste", "enter"]);
		await promptArrives("A");
		expect((await p).body.result).toBe("delivered");
	});
	it("Case B: between segments ⇒ 409 for resolve and reconcile, 409 send-in-progress for another send; the sequence completes", async () => {
		docker.script.set("paste", [{ exit: 0 }, "park"]);
		const service = makeService();
		const p = send(service, "l1\nl2");
		await until(() => docker.parked.size === 1);
		expect(docker.effectSteps()).toEqual(["paste", "newline", "paste"]);
		expect((await resolve(service, "discarded")).body.error).toBe("operation-active");
		expect((await resolve(service, "reconcile")).body.error).toBe("operation-active");
		expect((await send(service, "B", ID2)).body.error).toBe("send-in-progress");
		docker.release(docker.pastes()[1]!.id, 0);
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("l1\nl2");
		expect((await p).body.result).toBe("delivered");
	});
	it("positive: a cancelled operation takes one declaration (operate row), keeps pending effects, reconcile repeats without a second row, evidence releases", async () => {
		docker.script.set("paste", [{ exit: null }]);
		const service = makeService();
		expect((await send(service, "gone wrong")).body.result).toBe("uncertain");
		await until(() => recordIs((x) => x.phase === "cancelled"));
		const r1 = await resolve(service, "discarded");
		expect(r1.status).toBe(200);
		expect(r1.body).toMatchObject({ result: "resolved", effects: "pending", released: false });
		expect(r1.auditCalls).toBe(1);
		const r2 = await resolve(service, "discarded");
		expect([r2.body.error, r2.auditCalls]).toEqual(["not-pending", 0]);
		const r3 = await resolve(service, "reconcile");
		expect(r3.body).toMatchObject({ result: "resolved", effects: "pending", released: false });
		expect(r3.auditCalls).toBe(0);
		expect((await send(service, "next", ID2)).body.error).toBe("send-in-progress");
		docker.states.set(docker.pastes()[0]!.id, { running: false, exitCode: 0 });
		const r4 = await resolve(service, "reconcile");
		expect(r4.body).toMatchObject({ released: true });
		expect(await composerStates()).toEqual(["prepared", "uncertain", "resolved", "released"]);
	});
	it("no operation on the pane ⇒ 404", async () => {
		const service = makeService();
		expect((await resolve(service, "reconcile")).status).toBe(404);
	});
});

describe("restart and durability (§8.1.4 reglas 8–10, §10)", () => {
	it("crash before the first effect: prepared survives, the new process marks it uncertain{orphaned} and blocks; never resends; the same id is not new", async () => {
		docker.script.set("display", [{ exit: 0 }, "park"]); // the process dies while the precheck is in flight
		const s1 = makeService();
		void send(s1, "lost in crash");
		await until(() => docker.parked.size === 1);
		docker = new FakeDocker(); // a new process: new Docker view, same files
		const s2 = makeService();
		const r = await send(s2, "another", ID2);
		expect(r.body).toMatchObject({ error: "send-in-progress", detail: "effects-pending" });
		expect(
			await recordIs(
				(x) => x.phase === "cancelled" && x.cancel_reason === "orphaned" && x.state === "uncertain",
			),
		).toBe(true);
		expect(docker.effectSteps()).toEqual([]);
		expect((await send(s2, "lost in crash", ID1)).body).toMatchObject({ result: "uncertain" });
		expect((await composerStates()).at(-1)).toBe("uncertain");
	});
	it("crash after a paste, before the newline: the new process marks it uncertain{orphaned}, settles the paste from evidence, never resends; the pane stays blocked until resolved", async () => {
		docker.script.set("paste", [{ exit: 0 }, "park"]); // the process dies while paste 2 is in flight
		const s1 = makeService();
		void send(s1, "l1\nl2\nl3");
		await until(() => docker.parked.size === 1);
		expect(docker.effectSteps()).toEqual(["paste", "newline", "paste"]);
		const dead = docker;
		docker = new FakeDocker(); // a new process: its Docker view has no memory of the parked exec
		const s2 = makeService();
		// The pane is blocked for everyone, nothing is resent, the same id is not new.
		expect((await send(s2, "x", ID2)).body).toMatchObject({
			error: "send-in-progress",
			detail: "effects-pending",
		});
		expect((await send(s2, "l1\nl2\nl3", ID1)).body).toMatchObject({ result: "uncertain" });
		expect(docker.effectSteps()).toEqual([]);
		expect(await recordIs((x) => x.phase === "cancelled" && x.cancel_reason === "orphaned")).toBe(
			true,
		);
		// Evidence for the parked exec: the new process inspects it as exited 0 ⇒ settled, failed, released.
		docker.states.set(dead.pastes()[1]!.id, { running: false, exitCode: 0 });
		const r = await s2.resolve({
			stSessionId: SID,
			paneId: PANE,
			clientMessageId: ID1,
			outcome: "reconcile",
			by: "admin-1",
			audit: async () => undefined,
		});
		expect(r.status).toBe(200);
		await until(recordGone, "released by evidence");
		expect(docker.effectSteps()).toEqual([]); // still nothing resent: no l3, no Enter
		expect((await composerStates()).slice(-2)).toEqual(["failed", "released"]);
		expect((await send(s2, "l1\nl2\nl3", ID1)).status).toBe(502); // the replay is the recorded failure
	});
	it("crash after the Enter, before the final: the deferred ack over persisted events delivers; L7 rotation does not lose the block", async () => {
		const s1 = makeService();
		void send(s1, "survives");
		await until(async () => (await composerStates()).join() === "prepared,entered");
		killProcess(); // the process dies (SIGKILL): it observes nothing from here on
		await promptArrives("survives");
		// Rotate the events file hard: the pane record is independent of L7.
		store = new ConversationStore({
			workspaceRoot: root,
			now: () => now,
			limits: { fileBytes: 400 },
		});
		await store.open(SID, CID);
		for (let i = 0; i < 2; i++) {
			store.enqueue(SID, CID, {
				ev: "probe",
				prompt_id: null,
				turn_id: null,
				agent_id: null,
				pane: null,
				data: { found: true, status: "idle", pad: "x".repeat(60) },
			});
		}
		await store.flush(SID, CID);
		expect(store.stats.rotations).toBeGreaterThan(0);
		expect((await records.read(SID, PANE)).kind).toBe("ok");
		docker = new FakeDocker();
		const s2 = makeService();
		await s2.recover(SID);
		await until(recordGone, "release after deferred ack");
		// The small file limit keeps rotating as the recovery writes; the last
		// composer event still standing is the release, carrying the result.
		const all = await store.readEvents(SID, CID, 0, Number.MAX_SAFE_INTEGER, { archive: true });
		const last = all.filter((e) => e.ev === "composer_send").at(-1);
		expect(last?.data).toMatchObject({
			state: "released",
			result: "delivered",
			evidence: "inspected",
		});
	});
	it("a corrupt pane record makes the whole session unverifiable; nothing is deleted", async () => {
		const dir = path.join(root, ".st-control", SID, "composer");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "7.json"), "{corrupt");
		const service = makeService();
		const r = await send(service, "hi");
		expect(r.body).toMatchObject({ error: "send-in-progress", detail: "unverifiable" });
		expect(docker.calls.length).toBe(0);
		expect(await fs.readFile(path.join(dir, "7.json"), "utf8")).toBe("{corrupt");
		const av = await service.availability(SID, [{ cid: CID, kind: "interactive", paneId: PANE }], {
			captureEffective: true,
			callerMayOperate: true,
		});
		expect(av.get(CID)).toEqual({
			canSendInput: false,
			composer: { blocked: true, reason: "unverifiable" },
		});
	});
	it("a released id outside the 256 window is a new attempt; one inside replays without effects", async () => {
		const service = makeService();
		for (let i = 0; i < 300; i++) {
			store.enqueue(SID, CID, {
				ev: "composer_send",
				prompt_id: null,
				turn_id: null,
				agent_id: null,
				pane: PANE,
				data: {
					client_message_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
					state: "released",
					http: { status: 202, body: { result: "unconfirmed" } },
				},
			});
			// Under the L6 queue budget: flush every few events.
			if (i % 50 === 49) await store.flush(SID, CID);
		}
		await store.flush(SID, CID);
		const sends = store.getResidentIndex(SID, CID)!.composerSends ?? {};
		expect(Object.keys(sends).length).toBe(256);
		expect(sends["00000000-0000-4000-8000-000000000000"]).toBeUndefined();
		expect(sends["00000000-0000-4000-8000-000000000299"]?.status).toBe(202);
		const p = send(service, "again", "00000000-0000-4000-8000-000000000000");
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("again");
		expect((await p).body.result).toBe("delivered");
		const calls = docker.calls.length;
		expect((await send(service, "x", "00000000-0000-4000-8000-000000000299")).body).toEqual({
			result: "unconfirmed",
		});
		expect(docker.calls.length).toBe(calls);
	});
});

describe("availability (§6, orientative)", () => {
	it("needs interactive + pane + capture + not blocked; a blocked pane reports why", async () => {
		docker.script.set("paste", ["park"]);
		const service = makeService();
		const p = send(service, "a");
		await until(() => docker.parked.size === 1);
		const av = await service.availability(
			SID,
			[
				{ cid: CID, kind: "interactive", paneId: PANE },
				{ cid: "h", kind: "headless", paneId: null },
			],
			{ captureEffective: true, callerMayOperate: true },
		);
		expect(av.get(CID)).toMatchObject({
			canSendInput: false,
			composer: { blocked: true, reason: "in-progress", clientMessageId: ID1 },
		});
		expect(av.get("h")).toEqual({ canSendInput: false, composer: { blocked: false } });
		docker.release(docker.pastes()[0]!.id, 0);
		await until(() => docker.effectSteps().includes("enter"));
		await promptArrives("a");
		await p;
		await until(recordGone);
		const av2 = await service.availability(SID, [{ cid: CID, kind: "interactive", paneId: PANE }], {
			captureEffective: true,
			callerMayOperate: true,
		});
		expect(av2.get(CID)).toEqual({ canSendInput: true, composer: { blocked: false } });
		const av3 = await service.availability(SID, [{ cid: CID, kind: "interactive", paneId: PANE }], {
			captureEffective: null,
			callerMayOperate: true,
		});
		expect(av3.get(CID)?.canSendInput).toBe(false);
	});
});
