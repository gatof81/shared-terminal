/**
 * projects/conversation/outbox.ts — PROJECT_CONVERSATION.md §7.3 rules 1–5,
 * §7.3.1 and §7.5 (write detection, unverified), against the REAL Files
 * opener on a real filesystem (links, FIFOs, swaps), the real store, fan-out
 * and collab, with D1, the capture and the Composer faked.
 *
 * The property behind every negative case: what is not a verified message
 * of a live grant's fixed participant NEVER becomes a delivery. `afterEach`
 * re-checks it on the log itself: every relay `message` has an
 * `outbox{accepted, origin: match}` whose sha256 is the sha256 the message
 * was built from, and `checkLog` finds nothing.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-outbox-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	return dir;
});

import type { HttpResult } from "../../conversation/composer.js";
import type { EventMeta, PersistedEvent } from "../../conversation/store.js";
import { listWorkspaceDir, openWorkspaceFile } from "../../workspaceFiles.js";
import { ProjectCollab, type RecipientState } from "./collab.js";
import { shortMsgId } from "./collabText.js";
import { type ProjectBindings, ProjectFanout } from "./fanout.js";
import { LOG_FILE, type LogLine } from "./log.js";
import { checkLog } from "./logCheck.js";
import { type OutboxDeps, OutboxWatcher } from "./outbox.js";
import { projectDir } from "./paths.js";
import { ProjectConversationStore } from "./store.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const SA = "5a000000-0000-4000-8000-0000000000aa";
const SB = "5b000000-0000-4000-8000-0000000000bb";
const SX = "5c000000-0000-4000-8000-0000000000cc";
const CID: Record<string, string> = { [SA]: "cid-a", [SB]: "cid-b", [SX]: "cid-x" };
const MATCH: EventMeta = { origin: "match" };
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const ABS = "/home/developer/workspace/.st-outbox/";

let now: number;
let store: ProjectConversationStore;
let collab: ProjectCollab;
let outbox: OutboxWatcher;
let grantId: string;
let composerTexts: Array<{ sid: string; text: string }>;
let bindings: () => ProjectBindings;
let conversation: Map<string, RecipientState>;
let openFile: OutboxDeps["openFile"];
const listeners = new Set<
	(sid: string, cid: string, ev: PersistedEvent, meta?: EventMeta) => void
>();
let seq = 0;

function bindingsOf(over: Partial<Record<string, { epoch?: number; removed?: boolean }>> = {}) {
	const m: ProjectBindings = new Map();
	for (const [agent, sid] of [
		[A, SA],
		[B, SB],
	] as const) {
		m.set(agent, {
			removed: over[agent]?.removed ?? false,
			binding: { bindingId: `bind-${agent[0]}`, epoch: over[agent]?.epoch ?? 1, sessionId: sid },
		});
	}
	return m;
}

async function lines(): Promise<LogLine[]> {
	const raw = await fs.readFile(path.join(projectDir(ROOT, PID), LOG_FILE), "utf8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as LogLine);
}
const outboxLines = async () => (await lines()).filter((l) => l.ev === "outbox");
const relays = async () => (await lines()).filter((l) => l.ev === "message" && l.kind === "relay");
const relayTexts = () => composerTexts.filter((c) => c.text.includes("<<<ST-MSG"));

// As in collab.test.ts: after the minimum, wait (bounded) until the relay has
// nothing running and the log stopped growing — an append is an fsync.
async function settle(rounds = 30): Promise<void> {
	const tick = async () => {
		await outbox.idle();
		await new Promise((r) => setTimeout(r, 2));
	};
	for (let i = 0; i < rounds; i++) await tick();
	const work = collab as unknown as { draining: Map<string, unknown>; inFlight: Set<string> };
	const size = async () => (await lines().catch(() => [])).length;
	let seen = await size();
	for (let quiet = 0, i = 0; quiet < 3 && i < 400; i++) {
		await tick();
		const now = await size();
		quiet = work.draining.size === 0 && work.inFlight.size === 0 && now === seen ? quiet + 1 : 0;
		seen = now;
	}
}

/** One capture event as the store would hand it to a listener. */
function emit(
	sid: string,
	ev: "tool_start" | "tool_end",
	data: Record<string, unknown>,
	// No default: `undefined` is a case of its own (an event with no verdict).
	meta: EventMeta | undefined,
	over: Partial<PersistedEvent> = {},
): void {
	const e = {
		seq: ++seq,
		ts: new Date(now).toISOString(),
		ev,
		prompt_id: "p",
		turn_id: null,
		agent_id: null,
		pane: "%1",
		data,
		...over,
	} as PersistedEvent;
	for (const l of listeners) l(sid, over.cid ?? CID[sid] ?? "cid-?", e, meta);
}
declare module "../../conversation/store.js" {
	interface PersistedEvent {
		cid?: string;
	}
}

let toolN = 0;
/** The two events of a successful Write, as the CLI's hooks produce them. */
function wrote(
	sid: string,
	name: string,
	o: {
		start?: EventMeta | undefined | "absent";
		end?: EventMeta | undefined | "absent";
		tool?: string;
		absPath?: string;
		ok?: boolean;
		agentId?: string | null;
		id?: string;
	} = {},
): string {
	const id = o.id ?? `toolu_${++toolN}`;
	const tool = o.tool ?? "Write";
	const over = { agent_id: o.agentId ?? null };
	if (o.start !== "absent") {
		emit(
			sid,
			"tool_start",
			{ tool_name: tool, tool_use_id: id, summary: { file_path: o.absPath ?? ABS + name } },
			"start" in o ? (o.start as EventMeta | undefined) : MATCH,
			over,
		);
	}
	if (o.end !== "absent") {
		emit(
			sid,
			"tool_end",
			{ tool_name: tool, tool_use_id: id, ok: o.ok ?? true },
			"end" in o ? (o.end as EventMeta | undefined) : MATCH,
			over,
		);
	}
	return id;
}

const fileText = (header: Record<string, string>, body: string) =>
	`---\nst: 1\n${Object.entries({ collab: grantId, ...header })
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n")}\n---\n${body}\n`;
async function put(sid: string, name: string, content: string | Buffer): Promise<string> {
	const dir = path.join(ROOT, sid, ".st-outbox");
	await fs.mkdir(dir, { recursive: true });
	const p = path.join(dir, name);
	await fs.writeFile(p, content);
	return p;
}
const ask = (body = "¿Qué versión usa el servicio?") => fileText({ to: B, kind: "ask" }, body);

beforeEach(async () => {
	now = Date.parse("2026-11-14T12:00:00.000Z");
	seq = 0;
	listeners.clear();
	composerTexts = [];
	bindings = () => bindingsOf();
	conversation = new Map<string, RecipientState>([
		[SA, { kind: "busy", cid: "cid-a" }],
		[SB, { kind: "ready", cid: "cid-b" }],
		[SX, { kind: "ready", cid: "cid-x" }],
	]);
	openFile = (sid, rel, o) => openWorkspaceFile(sid, rel, o);
	for (const s of [SA, SB, SX]) await fs.mkdir(path.join(ROOT, s), { recursive: true });
	store = await ProjectConversationStore.start({
		workspaceRoot: ROOT,
		bootId: "boot",
		acquire: async () => ({
			ok: true,
			lock: { held: () => true, onLost: () => {}, release: () => {} },
		}),
		now: () => new Date(now),
	});
	const fanout = new ProjectFanout({
		store,
		relay: true,
		now: () => now,
		bindings: async () => bindings(),
		target: async (sid) => ({ kind: "ok", cid: CID[sid] as string }),
		sessionMeta: async () => ({ userId: OWNER }),
		composerSend: async (input): Promise<HttpResult> => {
			composerTexts.push({ sid: input.stSessionId, text: input.body.text });
			return {
				status: 202,
				body: { result: "delivered", promptId: `p${composerTexts.length}`, seq: 1 },
			};
		},
		onDelivered: () => {},
		onUncertain: () => {},
	});
	collab = new ProjectCollab({
		store,
		fanout,
		now: () => now,
		bindings: async () => bindings(),
		recipient: async (sid) => conversation.get(sid) ?? { kind: "none" },
		onCaptureEvent: () => () => {},
		gateIntervalMs: 3_600_000,
	});
	await collab.start([]);
	outbox = new OutboxWatcher({
		collab,
		now: () => now,
		onCaptureEvent: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		bindings: async () => bindings(),
		conversation: async (sid) => conversation.get(sid) ?? { kind: "none" },
		openFile: (sid, rel, o) => openFile(sid, rel, o),
		listDir: (sid, rel, o) => listWorkspaceDir(sid, rel, o),
		sweepIntervalMs: 3_600_000,
	});
	outbox.start();
	const r = await fanout.send(OWNER, PID, {
		clientMessageId: crypto.randomUUID(),
		text: "Tarea.",
		to: [A],
		collab: { mode: "ask", with: B, maxMessages: 4 },
	});
	grantId = (r.body as { grantId: string }).grantId;
	await settle();
});

afterEach(async () => {
	await settle();
	const ls = await lines();
	const accepted = ls.filter((l) => l.ev === "outbox" && l.event === "accepted");
	for (const m of ls.filter((l) => l.ev === "message" && l.kind === "relay")) {
		const o = accepted.find((x) => x.msg_id === m.msg_id);
		expect(o, "a relay without an admitted outbox").toBeDefined();
		expect(o?.origin).toBe("match");
		expect((m.relay as { file_sha256: string }).file_sha256).toBe(o?.sha256);
	}
	expect(relayTexts().length).toBeLessThanOrEqual(accepted.length);
	expect(checkLog(ls).violations).toEqual([]);
	outbox.stop();
	collab.stop();
	await store.close();
	await fs.rm(ROOT, { recursive: true, force: true });
});
afterAll(async () => {
	await fs.rm(ROOT, { recursive: true, force: true });
});

describe("M3: a whole consult through files", () => {
	it("ask → delivered to B; reply → delivered to A; the bytes on disk are the message", async () => {
		const q = ask();
		await put(SA, "q1.md", q);
		const tool = wrote(SA, "q1.md");
		await settle();
		const [o1] = await outboxLines();
		expect(o1).toMatchObject({
			event: "accepted",
			origin: "match",
			path: ".st-outbox/q1.md",
			sha256: sha(q),
			bytes: Buffer.byteLength(q),
			tool_use_id: tool,
			from: { agent_id: A, sid: SA, cid: "cid-a", binding_id: "bind-a", epoch: 1 },
		});
		expect(relayTexts()).toHaveLength(1);
		expect(relayTexts()[0]).toMatchObject({ sid: SB });
		expect(relayTexts()[0]?.text).toContain("\n¿Qué versión usa el servicio?\nST-MSG ");

		const msgId = o1?.msg_id as string;
		conversation.set(SA, { kind: "ready", cid: "cid-a" });
		await put(SB, "r1.md", fileText({ to: A, kind: "reply", re: shortMsgId(msgId) }, "La 2.4."));
		wrote(SB, "r1.md");
		await settle();
		expect((await relays()).map((m) => [m.from, m.to, m.in_reply_to, m.text])).toEqual([
			[A, [B], null, "¿Qué versión usa el servicio?"],
			[B, [A], msgId, "La 2.4."],
		]);
		expect(relayTexts().map((c) => c.sid)).toEqual([SB, SA]);
		expect(outbox.stats.admitted).toEqual({ accepted: 2 });
	});
});

describe("rule 1 — the event (M4)", () => {
	const cases: Array<[string, Parameters<typeof wrote>[2]]> = [
		["no tool_end", { end: "absent" }],
		["no tool_start", { start: "absent" }],
		["a failed Write", { ok: false }],
		["Edit instead of Write", { tool: "Edit" }],
		["a subagent's Write", { agentId: "agent-7" }],
		["a path with ..", { absPath: "/home/developer/workspace/.st-outbox/../.st-outbox/q1.md" }],
		["a nested path", { absPath: `${ABS}sub/q1.md` }],
		["another directory", { absPath: "/home/developer/workspace/notes/q1.md" }],
		["a relative path", { absPath: ".st-outbox/q1.md" }],
		["a hidden name", { absPath: `${ABS}.q1.md` }],
		["not .md", { absPath: `${ABS}q1.txt` }],
	];
	for (const [name, o] of cases) {
		it(`${name} is not a message: nothing written, nothing delivered`, async () => {
			await put(SA, "q1.md", ask());
			wrote(SA, "q1.md", o);
			await settle();
			expect(await outboxLines()).toEqual([]);
			expect(relayTexts()).toHaveLength(0);
		});
	}

	it("the two events must share session, conversation and tool_use_id", async () => {
		await put(SA, "q1.md", ask());
		// end under another id
		wrote(SA, "q1.md", { end: "absent", id: "toolu_a" });
		wrote(SA, "q1.md", { start: "absent", id: "toolu_b" });
		// end from another conversation of the same session
		wrote(SA, "q1.md", { end: "absent", id: "toolu_c" });
		emit(SA, "tool_end", { tool_name: "Write", tool_use_id: "toolu_c", ok: true }, MATCH, {
			cid: "cid-other",
		});
		// end from another session
		wrote(SA, "q1.md", { end: "absent", id: "toolu_d" });
		emit(SB, "tool_end", { tool_name: "Write", tool_use_id: "toolu_d", ok: true }, MATCH);
		await settle();
		expect(await outboxLines()).toEqual([]);
	});

	it("an event replayed after its admission does nothing; the same file under a new tool use is a duplicate", async () => {
		await put(SA, "q1.md", ask());
		const id = wrote(SA, "q1.md");
		await settle();
		const before = (await lines()).length;
		emit(SA, "tool_end", { tool_name: "Write", tool_use_id: id, ok: true }, MATCH);
		wrote(SA, "q1.md");
		await settle();
		expect((await lines()).length).toBe(before);
		expect(relayTexts()).toHaveLength(1);
		expect(outbox.stats.admitted).toEqual({ accepted: 1, duplicate: 1 });
	});
});

describe("rule 2 — origin, fail closed (§7.3.1, M4)", () => {
	const notMatch: Array<[string, EventMeta | undefined]> = [
		["no verdict at all (not received through this process)", undefined],
		["unchecked (origin check off)", { origin: "unchecked" }],
		["mismatch (another container with this session's token)", { origin: "mismatch" }],
		["loopback (the backend's own host)", { origin: "loopback" }],
		["inspect_timeout (Docker did not answer in time)", { origin: "inspect_timeout" }],
		["inspect_pending", { origin: "inspect_pending" }],
		[
			"container_replaced (the address of the previous container)",
			{ origin: "container_replaced" },
		],
		["no_remote", { origin: "no_remote" }],
		["an empty verdict", { origin: "" }],
		["a look-alike", { origin: "Match" }],
	];
	for (const [name, meta] of notMatch) {
		for (const which of ["start", "end"] as const) {
			it(`${which} with ${name} ⇒ not a message`, async () => {
				await put(SA, "q1.md", ask());
				wrote(SA, "q1.md", { [which]: meta });
				await settle();
				expect(await outboxLines()).toEqual([]);
				expect(relayTexts()).toHaveLength(0);
				expect(outbox.stats.originNotMatched).toBe(1);
			});
		}
	}

	it("a verified write right after an unverified one of the same file is still admitted on its own events", async () => {
		await put(SA, "q1.md", ask());
		wrote(SA, "q1.md", { start: { origin: "mismatch" }, end: { origin: "mismatch" } });
		await settle();
		expect(await outboxLines()).toEqual([]);
		wrote(SA, "q1.md");
		await settle();
		expect((await outboxLines()).map((l) => l.event)).toEqual(["accepted"]);
	});
});

describe("rule 3 — identity (M4)", () => {
	it("a session outside the grant writes nothing, even with a perfect file and events", async () => {
		await put(SX, "q1.md", ask());
		wrote(SX, "q1.md");
		await settle();
		expect(await outboxLines()).toEqual([]);
		expect(outbox.stats).toMatchObject({ admitted: {}, notAMessage: {} });
	});

	for (const [name, set] of [
		["another epoch in D1", () => (bindings = () => bindingsOf({ [A]: { epoch: 2 } }))],
		["the agent removed", () => (bindings = () => bindingsOf({ [A]: { removed: true } }))],
		[
			"the agent bound elsewhere",
			() =>
				(bindings = () => {
					const m = bindingsOf();
					m.set(A, { removed: false, binding: { bindingId: "bind-a", epoch: 1, sessionId: SX } });
					return m;
				}),
		],
		[
			"D1 failing",
			() =>
				(bindings = () => {
					throw new Error("d1 down");
				}),
		],
	] as const) {
		it(`${name} ⇒ not a message`, async () => {
			await put(SA, "q1.md", ask());
			set();
			wrote(SA, "q1.md");
			await settle();
			expect(await outboxLines()).toEqual([]);
			expect(outbox.stats.notAMessage).toEqual({ identity: 1 });
			bindings = () => bindingsOf();
		});
	}

	for (const [name, state] of [
		["two interactive conversations", { kind: "ambiguous" }],
		["no interactive conversation", { kind: "none" }],
		[
			"the event from a conversation that is not the session's interactive one",
			{ kind: "busy", cid: "cid-zz" },
		],
	] as const) {
		it(`${name} ⇒ not a message`, async () => {
			await put(SA, "q1.md", ask());
			conversation.set(SA, state as RecipientState);
			wrote(SA, "q1.md");
			await settle();
			expect(await outboxLines()).toEqual([]);
			expect(outbox.stats.notAMessage).toEqual({ conversation: 1 });
		});
	}

	it("after a revoke the participant's writes are nothing; while paused they are rejected", async () => {
		await put(SA, "q1.md", ask());
		await collab.action(OWNER, PID, grantId, "pause");
		wrote(SA, "q1.md");
		await settle();
		expect((await outboxLines()).map((l) => [l.event, l.reason])).toEqual([
			["rejected", "grant-paused"],
		]);
		await collab.action(OWNER, PID, grantId, "revoke");
		wrote(SA, "q1.md");
		await settle();
		expect(await outboxLines()).toHaveLength(1);
		expect(relayTexts()).toHaveLength(0);
	});

	it("after expiry the participant's writes are nothing", async () => {
		await put(SA, "q1.md", ask());
		now += 3 * 3_600_000;
		wrote(SA, "q1.md");
		await settle();
		expect(await outboxLines()).toEqual([]);
		expect(relayTexts()).toHaveLength(0);
	});
});

describe("rules 4–5 — the file, read once (M4, M5)", () => {
	const dir = (sid: string) => path.join(ROOT, sid, ".st-outbox");

	it("a symlink leaf — to a workspace file or to /etc/passwd — is refused and its target never read", async () => {
		await fs.mkdir(dir(SA), { recursive: true });
		await fs.writeFile(path.join(ROOT, SA, "real.md"), ask());
		await fs.symlink(path.join(ROOT, SA, "real.md"), path.join(dir(SA), "in.md"));
		await fs.symlink("/etc/passwd", path.join(dir(SA), "out.md"));
		wrote(SA, "in.md");
		wrote(SA, "out.md");
		await settle();
		expect((await outboxLines()).map((l) => [l.event, l.reason, l.sha256])).toEqual([
			["rejected", "file-not-found", undefined],
			["rejected", "file-not-found", undefined],
		]);
		expect(JSON.stringify(await lines())).not.toContain("root:");
		expect(relayTexts()).toHaveLength(0);
	});

	it("the outbox directory itself a symlink out of the workspace ⇒ refused, nothing read", async () => {
		const outside = path.join(ROOT, "outside-secret");
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "q1.md"), ask("secreto de otro lado"));
		await fs.symlink(outside, dir(SA));
		wrote(SA, "q1.md");
		await settle();
		expect((await outboxLines()).map((l) => [l.event, l.reason])).toEqual([
			["rejected", "file-not-found"],
		]);
		expect(JSON.stringify(await lines())).not.toContain("secreto");
	});

	it("the outbox directory a symlink to a restricted place of the workspace ⇒ refused", async () => {
		await fs.mkdir(path.join(ROOT, SA, ".ssh"), { recursive: true });
		await fs.writeFile(path.join(ROOT, SA, ".ssh", "q1.md"), ask("clave"));
		await fs.symlink(path.join(ROOT, SA, ".ssh"), dir(SA));
		wrote(SA, "q1.md");
		await settle();
		expect((await outboxLines()).map((l) => [l.event, l.reason])).toEqual([
			["rejected", "file-restricted"],
		]);
		expect(JSON.stringify(await lines())).not.toContain("clave");
	});

	it("a FIFO, a directory, a missing file: refused without blocking", async () => {
		await fs.mkdir(dir(SA), { recursive: true });
		execFileSync("mkfifo", [path.join(dir(SA), "fifo.md")]);
		await fs.mkdir(path.join(dir(SA), "dir.md"));
		const t0 = Date.now();
		wrote(SA, "fifo.md");
		wrote(SA, "dir.md");
		wrote(SA, "gone.md");
		await settle();
		expect(Date.now() - t0).toBeLessThan(3000);
		expect((await outboxLines()).map((l) => [l.event, l.reason])).toEqual([
			["rejected", "file-not-regular"],
			["rejected", "file-not-regular"],
			["rejected", "file-not-found"],
		]);
		// Three rejections of one agent: the grant is paused.
		expect((await lines()).filter((l) => l.ev === "grant").pop()).toMatchObject({
			event: "paused",
			reason: "too-many-rejections",
		});
	});

	it("larger than 64 KiB, NUL, not UTF-8, an invalid header", async () => {
		await put(SA, "big.md", ask("x".repeat(64 * 1024)));
		await put(SA, "nul.md", Buffer.concat([Buffer.from(ask()), Buffer.from([0])]));
		wrote(SA, "big.md");
		wrote(SA, "nul.md");
		await settle();
		expect((await outboxLines()).map((l) => [l.event, l.reason])).toEqual([
			["rejected", "file-too-large"],
			["rejected", "file-nul"],
		]);
		await collab.action(OWNER, PID, grantId, "revoke");
	});

	it("exactly 64 KiB is read whole (and then refused by the text rules, not truncated)", async () => {
		const head = ask("");
		const body = "y".repeat(64 * 1024 - Buffer.byteLength(head));
		const text = head.replace(/\n$/, `${body}\n`);
		expect(Buffer.byteLength(text)).toBe(64 * 1024);
		await put(SA, "edge.md", text);
		wrote(SA, "edge.md");
		await settle();
		const [o] = await outboxLines();
		expect(o).toMatchObject({ event: "rejected", sha256: sha(text), bytes: 64 * 1024 });
		expect(String(o?.reason)).toMatch(/^text-/);
	});

	it("M5: a file swapped AFTER the open — content, symlink, FIFO — delivers exactly the bytes opened", async () => {
		for (const [name, swap] of [
			[
				"other content",
				(p: string) => fs.writeFile(`${p}.new`, ask("OTRO")).then(() => fs.rename(`${p}.new`, p)),
			],
			["a symlink", (p: string) => fs.rm(p).then(() => fs.symlink("/etc/passwd", p))],
			["a FIFO", (p: string) => fs.rm(p).then(() => void execFileSync("mkfifo", [p]))],
		] as const) {
			const file = `swap-${name.replace(/\W/g, "")}.md`;
			const original = ask(`original ${name}`);
			const p = await put(SA, file, original);
			openFile = async (sid, rel, o) => {
				const r = await openWorkspaceFile(sid, rel, o);
				// The agent replaces the name between the open and the read.
				await swap(p);
				return r;
			};
			const before = relayTexts().length;
			wrote(SA, file);
			await settle();
			const o = (await outboxLines()).pop();
			expect(o).toMatchObject({ event: "accepted", sha256: sha(original) });
			expect((await relays()).pop()?.text).toBe(`original ${name}`);
			expect(relayTexts()[before]?.text).toContain(`original ${name}`);
			// Let B's delivery finish so the next message is not `queue-full`.
			await settle();
		}
		expect(JSON.stringify(await lines())).not.toContain("root:");
		expect(JSON.stringify(await lines())).not.toContain("OTRO");
	});

	it("M5: a file swapped BEFORE the open delivers what is there at the open, hashed as read", async () => {
		const p = await put(SA, "q1.md", ask("antes"));
		const id = wrote(SA, "q1.md", { end: "absent" });
		await fs.writeFile(p, ask("después"));
		emit(SA, "tool_end", { tool_name: "Write", tool_use_id: id, ok: true }, MATCH);
		await settle();
		expect((await outboxLines()).pop()).toMatchObject({
			event: "accepted",
			sha256: sha(ask("después")),
		});
		expect((await relays()).pop()?.text).toBe("después");
		// And a change after the admission changes nothing that was recorded or sent.
		await fs.writeFile(p, ask("más tarde"));
		await settle();
		expect(await relays()).toHaveLength(1);
		expect(relayTexts()).toHaveLength(1);
	});

	it("messages of one session are admitted in the order their events arrived", async () => {
		conversation.set(SB, { kind: "busy", cid: "cid-b" });
		await put(SA, "one.md", ask("uno"));
		await put(SA, "two.md", ask("dos"));
		wrote(SA, "one.md");
		wrote(SA, "two.md");
		await settle();
		expect((await outboxLines()).map((l) => [l.path, l.event, l.reason])).toEqual([
			[".st-outbox/one.md", "accepted", undefined],
			[".st-outbox/two.md", "rejected", "queue-full"],
		]);
	});
});

describe("§7.5 — write detection (M15)", () => {
	const edit = (sid: string, tool: string, file: string, agentId: string | null = null) =>
		emit(
			sid,
			"tool_start",
			{ tool_name: tool, tool_use_id: `toolu_w${++toolN}`, summary: { file_path: file } },
			undefined,
			{ agent_id: agentId },
		);
	const lastGrant = async () => (await lines()).filter((l) => l.ev === "grant").pop();

	it("the consulted agent editing outside its outbox pauses the grant; the initiator's work does not", async () => {
		edit(SA, "Write", "/home/developer/workspace/src/a.ts");
		edit(SA, "Edit", "/home/developer/workspace/src/a.ts");
		await settle();
		expect(await lastGrant()).toMatchObject({ event: "created" });
		edit(SB, "Edit", "/home/developer/workspace/src/b.ts");
		await settle();
		expect(await lastGrant()).toMatchObject({
			event: "paused",
			reason: "write-observed",
			by: "system",
			detail: { tool: "Edit", cid: "cid-b" },
		});
	});

	for (const tool of ["Write", "MultiEdit", "NotebookEdit"]) {
		it(`${tool} by the consulted agent — also from a subagent, also without a verified origin`, async () => {
			edit(SB, tool, "/home/developer/workspace/x", "agent-3");
			await settle();
			expect(await lastGrant()).toMatchObject({ event: "paused", reason: "write-observed" });
		});
	}

	it("its own outbox, and tools that do not write files, are not a write", async () => {
		edit(SB, "Write", `${ABS}r1.md`);
		edit(SB, "Read", "/home/developer/workspace/src/b.ts");
		edit(SB, "Bash", "/home/developer/workspace/src/b.ts");
		await settle();
		expect(await lastGrant()).toMatchObject({ event: "created" });
	});
});

describe("§7.5 — files the log knows nothing about (M17)", () => {
	// File times are set against the test's clock, which is what the sweep reads.
	const aged = async (p: string, ms: number) => {
		const t = new Date(now - ms);
		await fs.utimes(p, t, t);
	};
	const old = (p: string) => aged(p, 5 * 60_000);
	it("a message written while nobody was listening is recorded once as unverified and never sent", async () => {
		const text = ask("escrito con el backend caído");
		await old(await put(SA, "lost.md", text));
		await outbox.sweep();
		await outbox.sweep();
		await settle();
		expect(await outboxLines()).toMatchObject([
			{
				event: "unverified",
				origin: "none",
				path: ".st-outbox/lost.md",
				sha256: sha(text),
				kind: "ask",
				from: { agent_id: A, sid: SA },
			},
		]);
		expect(await relays()).toEqual([]);
		expect(relayTexts()).toHaveLength(0);
		// The agent writes it again with the backend up: admitted normally.
		wrote(SA, "lost.md");
		await settle();
		expect((await outboxLines()).map((l) => l.event)).toEqual(["unverified", "accepted"]);
	});

	it("skipped: a fresh file, an admitted file, another grant's file, a link, a non-message", async () => {
		await aged(await put(SA, "fresh.md", ask("recién")), 60_000);
		await put(SA, "done.md", ask("ya admitido"));
		wrote(SA, "done.md");
		await settle();
		await old(path.join(ROOT, SA, ".st-outbox", "done.md"));
		await old(await put(SA, "other.md", ask("x").replace(grantId, "c-000000000000")));
		await old(await put(SA, "notes.md", "apuntes sin cabecera"));
		await fs.symlink("/etc/passwd", path.join(ROOT, SA, ".st-outbox", "link.md"));
		await old(await put(SX, "foreign.md", ask("de una sesión ajena")));
		await outbox.sweep();
		await settle();
		expect((await outboxLines()).map((l) => [l.event, l.path])).toEqual([
			["accepted", ".st-outbox/done.md"],
		]);
	});

	it("bounded: at most 8 unverified lines per grant", async () => {
		for (let i = 0; i < 11; i++) await old(await put(SA, `u${i}.md`, ask(`n ${i}`)));
		await outbox.sweep();
		await settle();
		expect(await outboxLines()).toHaveLength(8);
	});
});

describe("bounded work per session (security review of D3-b)", () => {
	it("a burst of verified pairs queues at most 4 admissions; the rest are dropped before any D1 read", async () => {
		let reads = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		bindings = (() => {
			reads++;
			return gate.then(() => bindingsOf());
		}) as unknown as typeof bindings;
		for (let i = 0; i < 40; i++) wrote(SA, `b${i}.md`);
		await new Promise((r) => setTimeout(r, 20));
		expect(outbox.stats.notAMessage.backlog).toBe(36);
		release();
		bindings = () => bindingsOf();
		await settle();
		expect(reads).toBeLessThanOrEqual(4);
	});

	it("a grant that can neither admit nor record more costs no D1 read", async () => {
		await collab.action(OWNER, PID, grantId, "pause");
		for (let i = 0; i < 8; i++) {
			wrote(SA, `gone${i}.md`);
			await settle(3);
		}
		expect(await outboxLines()).toHaveLength(8);
		let reads = 0;
		bindings = () => {
			reads++;
			return bindingsOf();
		};
		for (let i = 0; i < 6; i++) {
			wrote(SA, `more${i}.md`);
			await settle(3);
		}
		expect(reads).toBe(0);
		expect(outbox.stats.notAMessage.saturated).toBe(6);
		expect(await outboxLines()).toHaveLength(8);
	});

	it("unverified starts are not kept, and one session's burst never evicts another's pending start", async () => {
		await put(SB, "r.md", fileText({ to: A, kind: "ask" }, "de B"));
		conversation.set(SA, { kind: "ready", cid: "cid-a" });
		const id = wrote(SB, "r.md", { end: "absent" });
		for (let i = 0; i < 300; i++)
			wrote(SA, `x${i}.md`, { end: "absent", start: { origin: "mismatch" } });
		for (let i = 0; i < 300; i++) wrote(SA, `y${i}.md`, { end: "absent" });
		emit(SB, "tool_end", { tool_name: "Write", tool_use_id: id, ok: true }, MATCH);
		await settle();
		expect((await outboxLines()).map((l) => [l.event, l.path])).toEqual([
			["accepted", ".st-outbox/r.md"],
		]);
	});

	it("a misnamed file inside the outbox directory is ignored, not reported as a write", async () => {
		for (const name of ["my reply.md", "notes.txt", `${"a".repeat(120)}.md`]) {
			emit(
				SB,
				"tool_start",
				{ tool_name: "Write", tool_use_id: `t-${name.length}`, summary: { file_path: ABS + name } },
				MATCH,
			);
		}
		await settle();
		expect((await lines()).filter((l) => l.ev === "grant").pop()).toMatchObject({
			event: "created",
		});
	});
});
