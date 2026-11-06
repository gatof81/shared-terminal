/**
 * composerBg.test.ts — the pure ack attribution, duplicate exclusion,
 * transcript parsing and configuration of §8.1.12.
 */

import { describe, expect, it } from "vitest";
import {
	bgConfigFromEnv,
	bgFlagEnabled,
	duplicateAfter,
	ENQUEUE_WINDOW_MS,
	hookCandidates,
	ourEnqueueLatencyMs,
	parseBgVersions,
	parseTranscript,
	pendingSameContent,
	transcriptConfirms,
	transcriptPathOf,
	transcriptRel,
} from "./composerBg.js";
import { normalizeText, textHash } from "./composerText.js";
import type { PersistedEvent } from "./store.js";

const CID = "dda484d8-c2a9-4997-af5a-42fbe372cb91";
const H = textHash(normalizeText("hello"));
const T0 = "2026-11-06T00:00:00.000Z";
const T0MS = Date.parse(T0);
let seq = 0;
const ev = (
	over: Partial<PersistedEvent> & { data?: Record<string, unknown> },
): PersistedEvent => ({
	seq: ++seq,
	ts: T0,
	ev: "user_prompt",
	prompt_id: null,
	turn_id: null,
	agent_id: null,
	pane: null,
	data: {},
	...over,
});
const prompt = (text: string, pid: string, ts = T0, data: Record<string, unknown> = {}) =>
	ev({ ev: "user_prompt", prompt_id: pid, ts, data: { prompt: text, ...data } });

describe("config", () => {
	it("flag: only true / 1", () => {
		expect(bgFlagEnabled(undefined)).toBe(false);
		expect(bgFlagEnabled("")).toBe(false);
		expect(bgFlagEnabled("yes")).toBe(false);
		expect(bgFlagEnabled("true")).toBe(true);
		expect(bgFlagEnabled("1")).toBe(true);
	});
	it("versions: exact list, EMPTY by default, malformed throws", () => {
		expect([...parseBgVersions(undefined)]).toEqual([]);
		expect([...parseBgVersions("")]).toEqual([]);
		expect([...parseBgVersions(" 2.1.314 , 2.1.318")]).toEqual(["2.1.314", "2.1.318"]);
		expect(() => parseBgVersions(">=2.1.314")).toThrow(/not a version/);
		expect(() => parseBgVersions("2.1")).toThrow();
	});
});

describe("hookCandidates (cond. 1: new prompt_id, same hash, after t0, human)", () => {
	it("a prompt_id seen earlier (the running turn) is never a candidate", () => {
		const evs = [prompt("SLOW", "p-run", "2026-11-05T23:59:59.000Z"), prompt("hello", "p-run")];
		expect(hookCandidates(evs, { cid: CID, t0: T0, hash: H })).toEqual([]);
	});
	it("a new prompt_id after t0 with the same normalized hash is", () => {
		const evs = [prompt("hello  \n", "p-new", "2026-11-06T00:00:00.050Z")];
		expect(hookCandidates(evs, { cid: CID, t0: T0, hash: H })).toEqual([
			{ cid: CID, promptId: "p-new", seq: evs[0]?.seq, ts: "2026-11-06T00:00:00.050Z" },
		]);
	});
	it("before t0, another hash, a non-human source, unverified origin, or no prompt_id: never", () => {
		const evs = [
			prompt("hello", "a", "2026-11-05T23:59:59.999Z"),
			prompt("hello!", "b"),
			prompt("hello", "c", T0, { source: "task" }),
			prompt("hello", "d", T0, { origin: "unverified" }),
			ev({ ev: "user_prompt", prompt_id: null, data: { prompt: "hello" } }),
			ev({ ev: "internal_prompt", prompt_id: "e", data: {} }),
		];
		expect(hookCandidates(evs, { cid: CID, t0: T0, hash: H })).toEqual([]);
	});
	it("order is by seq, not by array order", () => {
		const a = prompt("SLOW", "p-x");
		const b = prompt("hello", "p-x");
		expect(hookCandidates([b, a], { cid: CID, t0: T0, hash: H })).toEqual([]);
	});
});

const enq = (content: string, atMs: number, sessionId = CID, operation = "enqueue") =>
	JSON.stringify({
		type: "queue-operation",
		operation,
		timestamp: new Date(atMs).toISOString(),
		sessionId,
		content,
	});
const deq = (atMs: number, sessionId = CID) =>
	JSON.stringify({
		type: "queue-operation",
		operation: "dequeue",
		timestamp: new Date(atMs).toISOString(),
		sessionId,
	});
const user = (promptId: string, promptSource: string, sessionId = CID, atMs = T0MS + 100) =>
	JSON.stringify({
		type: "user",
		promptSource,
		promptId,
		sessionId,
		timestamp: new Date(atMs).toISOString(),
		message: { role: "user", content: "hello" },
	});

describe("transcript (cond. 2)", () => {
	it("parses only what the ack needs: hashes, never content", () => {
		const e = parseTranscript(
			`garbage}\n${enq("hello", T0MS + 10)}\n${user("p", "queued")}\n{"type":"assistant"}\n`,
		);
		expect(e).toHaveLength(2);
		expect(JSON.stringify(e)).not.toContain("hello");
		expect(e[0]?.contentHash).toBe(H);
	});
	it("confirms with an enqueue ≤ 2 s after t0 and a `queued` entry with the hook's promptId", () => {
		const e = parseTranscript(
			[enq("hello", T0MS + 60), deq(T0MS + 70), user("p1", "queued")].join("\n"),
		);
		expect(transcriptConfirms(e, { cid: CID, t0Ms: T0MS, hash: H, promptId: "p1" })).toBe(true);
	});
	it.each([
		["enqueue too late", [enq("hello", T0MS + ENQUEUE_WINDOW_MS + 1), user("p1", "queued")]],
		["enqueue before t0", [enq("hello", T0MS - 1000), user("p1", "queued")]],
		["other content", [enq("hell0", T0MS + 10), user("p1", "queued")]],
		["other conversation", [enq("hello", T0MS + 10, "other"), user("p1", "queued")]],
		["typed, not queued", [enq("hello", T0MS + 10), user("p1", "typed")]],
		["other promptId", [enq("hello", T0MS + 10), user("p2", "queued")]],
		["no enqueue", [user("p1", "queued")]],
		["no dequeue of ours", [enq("hello", T0MS + 10), user("p1", "queued")]],
	])("%s ⇒ not confirmed", (_l, lines) => {
		const e = parseTranscript(lines.join("\n"));
		expect(transcriptConfirms(e, { cid: CID, t0Ms: T0MS, hash: H, promptId: "p1" })).toBe(false);
	});
	it("S2: ours enqueued then taken back with popAll, then a foreign identical text queued ⇒ NOT confirmed", () => {
		const e = parseTranscript(
			[
				enq("hello", T0MS + 50),
				enq("hello", T0MS + 60, CID, "popAll"),
				enq("hello", T0MS + 30_000),
				deq(T0MS + 30_010),
				user("p-foreign", "queued", CID, T0MS + 30_020),
			].join("\n"),
		);
		expect(transcriptConfirms(e, { cid: CID, t0Ms: T0MS, hash: H, promptId: "p-foreign" })).toBe(
			false,
		);
	});
	it("S2: ours lost by a teardown (never dequeued), then a foreign identical text queued ⇒ NOT confirmed", () => {
		const e = parseTranscript(
			[
				enq("hello", T0MS + 50),
				// the worker restarted; the queue it held is gone, nothing says so
				enq("hello", T0MS + 60_000),
				deq(T0MS + 60_010),
				user("p-foreign", "queued", CID, T0MS + 60_020),
			].join("\n"),
		);
		expect(transcriptConfirms(e, { cid: CID, t0Ms: T0MS, hash: H, promptId: "p-foreign" })).toBe(
			false,
		);
	});
	it("S2: two identical enqueues inside the window are ambiguous ⇒ NOT confirmed", () => {
		const e = parseTranscript(
			[
				enq("hello", T0MS + 50),
				enq("hello", T0MS + 900),
				deq(T0MS + 1000),
				user("p1", "queued", CID, T0MS + 1010),
			].join("\n"),
		);
		expect(transcriptConfirms(e, { cid: CID, t0Ms: T0MS, hash: H, promptId: "p1" })).toBe(false);
	});
	it("S2: FIFO pairing — another text queued before ours is consumed first, ours pairs with ITS entry", () => {
		const lines = [
			enq("other text", T0MS + 10),
			enq("hello", T0MS + 50),
			deq(T0MS + 5000),
			deq(T0MS + 5001),
			user("p-other", "queued", CID, T0MS + 5010),
			user("p-ours", "queued", CID, T0MS + 5020),
		].join("\n");
		const e = parseTranscript(lines);
		expect(transcriptConfirms(e, { cid: CID, t0Ms: T0MS, hash: H, promptId: "p-ours" })).toBe(true);
		expect(transcriptConfirms(e, { cid: CID, t0Ms: T0MS, hash: H, promptId: "p-other" })).toBe(
			false,
		);
	});
	it("D1 pendingSameContent: only a same-content item still queued, or taken and not yet run, is pending", () => {
		const q = { cid: CID, hash: H };
		const p = (lines: string[]) => pendingSameContent(parseTranscript(lines.join("\n")), q);
		// Ran (enqueue, dequeue, queued entry): nothing pending — repeating it is allowed.
		expect(p([enq("hello", 0), deq(1), user("p", "queued", CID, 2)])).toBe(false);
		// Taken back with ↑: nothing pending.
		expect(p([enq("hello", 0), enq("hello", 1, CID, "popAll")])).toBe(false);
		// Still waiting in the queue: pending.
		expect(p([enq("hello", 0)])).toBe(true);
		// Dequeued but its prompt not written yet: pending.
		expect(p([enq("hello", 0), deq(1)])).toBe(true);
		// Another text pending, or another conversation: not ours to worry about.
		expect(p([enq("other", 0)])).toBe(false);
		expect(p([enq("hello", 0, "x")])).toBe(false);
		// FIFO: two items, the first ran, the second (ours' twin) still queued.
		expect(p([enq("other", 0), enq("hello", 1), deq(2), user("p", "queued", CID, 3)])).toBe(true);
	});
	it("transcriptRel maps only the container's ~/.claude/projects/<p>/<uuid>.jsonl", () => {
		expect(transcriptRel(`/home/developer/.claude/projects/-w/${CID}.jsonl`)).toBe(
			`.st/claude-state/projects/-w/${CID}.jsonl`,
		);
		for (const bad of [
			`/home/developer/.claude/projects/../x/${CID}.jsonl`,
			`/home/developer/.claude/projects/-w/a/${CID}.jsonl`,
			`/tmp/projects/-w/${CID}.jsonl`,
			"/home/developer/.claude/projects/-w/notes.txt",
			`/home/developer/.claude/projects//${CID}.jsonl`,
		])
			expect(transcriptRel(bad)).toBeNull();
	});
	it("transcriptPathOf: the newest session_start's", () => {
		const a = ev({ ev: "session_start", data: { transcript_path: "/a" } });
		const b = ev({ ev: "session_start", data: { transcript_path: "/b" } });
		expect(transcriptPathOf([b, a])).toBe("/b");
		expect(transcriptPathOf([])).toBeNull();
	});
});

describe("duplicateAfter", () => {
	it("resume, then the same text with a new prompt_id ⇒ the duplicate", () => {
		const ack = prompt("hello", "p1");
		const evs = [
			ack,
			ev({ ev: "session_start", data: { source: "resume" } }),
			prompt("hello", "p2"),
		];
		expect(duplicateAfter(evs, { hash: H, ackSeq: ack.seq, ackPromptId: "p1" })).toMatchObject({
			seq: evs[2]?.seq,
			promptId: "p2",
			blockers: [],
		});
	});
	const dup = (evs: PersistedEvent[], ack: PersistedEvent) =>
		duplicateAfter(evs, { hash: H, ackSeq: ack.seq, ackPromptId: "p1" });
	const resume = () => ev({ ev: "session_start", data: { source: "resume" } });
	const end = (kind: "turn_end" | "turn_failed", promptId: string | null) =>
		ev({ ev: kind, prompt_id: promptId, data: {} });
	it("round 3: the ack's own turn finished (turn_end / turn_failed) BEFORE the resume ⇒ blocked, never proven", () => {
		for (const k of ["turn_end", "turn_failed"] as const) {
			const ack = prompt("hello", "p1");
			const r = dup([ack, end(k, "p1"), resume(), prompt("hello", "p2")], ack);
			expect(r).toMatchObject({ promptId: "p2", blockers: ["turn-finished-before-resume"] });
		}
	});
	it("SF-1 (A): a gap between the ack and the repeat (a lost turn_end) ⇒ blocked", () => {
		const ack = prompt("hello", "p1");
		const gap = ev({ ev: "gap", data: { reason: "relay_dropped" } });
		expect(dup([ack, gap, resume(), prompt("hello", "p2")], ack)?.blockers).toEqual(["gap"]);
		const ack2 = prompt("hello", "p1");
		const gap2 = ev({ ev: "gap", data: { reason: "relay_dropped" } });
		expect(dup([ack2, resume(), gap2, prompt("hello", "p2")], ack2)?.blockers).toEqual(["gap"]);
	});
	it("SF-1 (B/C): a turn end with SOMEONE ELSE'S or a null prompt_id before the resume ⇒ blocked", () => {
		for (const pid of ["p-unannounced", null]) {
			const ack = prompt("hello", "p1");
			expect(
				dup([ack, end("turn_end", pid), resume(), prompt("hello", "p2")], ack)?.blockers,
			).toEqual(["turn-end-before-resume"]);
		}
	});
	it("SF-1 (F): stop mid-turn, --bg --resume, ANOTHER turn finishes, the same text typed much later ⇒ blocked", () => {
		const ack = prompt("hello", "p1");
		const r = dup(
			[
				ack,
				resume(),
				prompt("something else", "p-other"),
				end("turn_end", "p-other"),
				ev({ ts: "2026-11-06T01:00:00.000Z", ev: "notification", data: {} }),
				prompt("hello", "p-much-later"),
			],
			ack,
		);
		expect(r).toMatchObject({ promptId: "p-much-later" });
		expect(r?.blockers).toEqual(["prompt-before-repeat", "turn-end-before-repeat"]);
	});
	it("SF-1 M6: a turn end of the ack's prompt_id AFTER the resume and BEFORE the repeat ⇒ blocked", () => {
		const ack = prompt("hello", "p1");
		expect(
			dup([ack, resume(), end("turn_end", "p1"), prompt("hello", "p2")], ack)?.blockers,
		).toEqual(["turn-end-before-repeat"]);
	});
	it("SF-1: a human prompt between the ack and the resume ⇒ blocked; the clean crash sequence ⇒ no blockers", () => {
		const ack = prompt("hello", "p1");
		expect(
			dup([ack, prompt("busy-typed", "p1"), resume(), prompt("hello", "p2")], ack)?.blockers,
		).toEqual(["prompt-before-repeat"]);
		const ack2 = prompt("hello", "p1");
		const tool = ev({ ev: "tool_start", prompt_id: "p1", data: {} });
		expect(dup([ack2, tool, resume(), prompt("hello", "p2")], ack2)?.blockers).toEqual([]);
		// A turn end AFTER the repeat (the re-run's own end) does not matter.
		const ack3 = prompt("hello", "p1");
		expect(
			dup([ack3, resume(), prompt("hello", "p2"), end("turn_end", "p2")], ack3)?.blockers,
		).toEqual([]);
	});
	it("M8: popAll on an item already TAKEN (dequeued, not yet run) loses ours ⇒ not confirmed, not pending", () => {
		const lines = [
			enq("hello", T0MS + 50),
			deq(T0MS + 60),
			enq("x", T0MS + 70, CID, "popAll"),
			user("p1", "queued", CID, T0MS + 80),
		];
		const e = parseTranscript(lines.join("\n"));
		expect(transcriptConfirms(e, { cid: CID, t0Ms: T0MS, hash: H, promptId: "p1" })).toBe(false);
	});
	it("ourEnqueueLatencyMs: the single in-window enqueue, else null", () => {
		expect(
			ourEnqueueLatencyMs(parseTranscript(enq("hello", T0MS + 37)), {
				cid: CID,
				t0Ms: T0MS,
				hash: H,
			}),
		).toBe(37);
		expect(
			ourEnqueueLatencyMs(
				parseTranscript([enq("hello", T0MS + 1), enq("hello", T0MS + 2)].join("\n")),
				{
					cid: CID,
					t0Ms: T0MS,
					hash: H,
				},
			),
		).toBeNull();
	});
	it("without a resume, or with the same prompt_id, or another text: nothing", () => {
		const ack = prompt("hello", "p1");
		expect(
			duplicateAfter([ack, prompt("hello", "p2")], { hash: H, ackSeq: ack.seq, ackPromptId: "p1" }),
		).toBeNull();
		const r = ev({ ev: "session_start", data: { source: "resume" } });
		expect(
			duplicateAfter([ack, r, prompt("hello", "p1")], {
				hash: H,
				ackSeq: ack.seq,
				ackPromptId: "p1",
			}),
		).toBeNull();
		expect(
			duplicateAfter([ack, r, prompt("bye", "p3")], {
				hash: H,
				ackSeq: ack.seq,
				ackPromptId: "p1",
			}),
		).toBeNull();
		const c = ev({ ev: "session_start", data: { source: "clear" } });
		expect(
			duplicateAfter([ack, c, prompt("hello", "p4")], {
				hash: H,
				ackSeq: ack.seq,
				ackPromptId: "p1",
			}),
		).toBeNull();
	});
});

describe("bgConfigFromEnv (boot): flag off reads nothing strictly and logs nothing", () => {
	const SIDA = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	it("unset ⇒ off, no warning, no log line (boot logs unchanged)", () => {
		expect(bgConfigFromEnv({}, true)).toEqual({
			enabled: false,
			versions: new Set(),
			sessions: new Set(),
			warnings: [],
		});
		expect(bgConfigFromEnv({ CONVERSATION_COMPOSER_BG_ENABLED: "" }, true).warnings).toEqual([]);
	});
	it("off with a malformed list ⇒ boots, only a warning (decided in round 2)", () => {
		const c = bgConfigFromEnv(
			{ COMPOSER_BG_CLI_VERSIONS: ">=2.1", COMPOSER_BG_SESSIONS: "nope" },
			true,
		);
		expect(c.enabled).toBe(false);
		expect(c.warnings).toHaveLength(2);
		expect(c.warnings[0]).toMatch(/ignored: the background transport is off/);
	});
	it("on with a malformed list ⇒ throws (the backend refuses to start)", () => {
		expect(() =>
			bgConfigFromEnv(
				{ CONVERSATION_COMPOSER_BG_ENABLED: "true", COMPOSER_BG_CLI_VERSIONS: ">=2.1" },
				true,
			),
		).toThrow(/not a version/);
		expect(() =>
			bgConfigFromEnv(
				{ CONVERSATION_COMPOSER_BG_ENABLED: "true", COMPOSER_BG_SESSIONS: "x" },
				true,
			),
		).toThrow(/not a session id/);
	});
	it("on without the composer ⇒ off, warned", () => {
		const c = bgConfigFromEnv({ CONVERSATION_COMPOSER_BG_ENABLED: "1" }, false);
		expect(c.enabled).toBe(false);
		expect(c.warnings[0]).toMatch(/composer is disabled/);
	});
	it("on: versions and the session allowlist; an empty allowlist is warned (no session uses it)", () => {
		const c = bgConfigFromEnv(
			{
				CONVERSATION_COMPOSER_BG_ENABLED: "true",
				COMPOSER_BG_CLI_VERSIONS: "2.1.318",
				COMPOSER_BG_SESSIONS: ` ${SIDA.toUpperCase()} `,
			},
			true,
		);
		expect(c.enabled).toBe(true);
		expect([...c.versions]).toEqual(["2.1.318"]);
		expect([...c.sessions]).toEqual([SIDA]);
		expect(bgConfigFromEnv({ CONVERSATION_COMPOSER_BG_ENABLED: "true" }, true).warnings[0]).toMatch(
			/no session uses it/,
		);
	});
});
