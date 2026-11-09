/**
 * projectModel.ts — the pure half of the Projects & Agents UI (P3a,
 * docs/PROJECTS.md; design 16 §4). No DOM, no requests, no clock: every
 * rule the screens apply is here, so it is unit-tested once and every
 * surface (sidebar, project page, agent page, dialogs) says the same thing.
 *
 * Vocabulary (D-UX7): the team agents of a project are "agents"; the CLI's
 * own helpers inside a conversation are "subagents" and never appear here.
 */

import type { Presence, SessionBinding } from "./api.js";
import { ATTENTION_STALE_MS } from "./attentionRule.js";
import { relativeDate } from "./format.js";

// ── Presence (PROJECTS.md §5, rule 2) ───────────────────────────────────────

export type PresenceTone = "working" | "ready" | "attention" | "off" | "unknown";

export interface PresenceView {
	/** The chip's words. */
	label: string;
	tone: PresenceTone;
	/** Why, in words — null when the label says it all. */
	reason: string | null;
	/** "via hook · 2 min ago" / "no evidence" — every state says what it rests on. */
	evidence: string;
}

/**
 * Where "now" is on the SERVER's clock: the `generatedAt` of an answer and
 * the local time (ms, the browser's own clock) that answer was received.
 * The server's `at` is never compared with the browser clock directly — a
 * phone an hour off would turn every claim stale (or keep a dead one
 * fresh). Only the browser's own elapsed time since receipt is added:
 *
 *     age = (generatedAt − at) + (now − receivedAt)
 *
 * A clock offset does not age, so the receipt of ANY directory answer
 * places "now" for evidence read in another answer too.
 */
export interface ServerClock {
	generatedAt: string;
	receivedAt: number;
}

/** The server-clock "now", or NaN when the clock is missing or unreadable. */
export function serverNow(clock: ServerClock | null, now: number): number {
	if (clock === null) return Number.NaN;
	const g = Date.parse(clock.generatedAt);
	if (Number.isNaN(g) || !Number.isFinite(clock.receivedAt)) return Number.NaN;
	return g + (now - clock.receivedAt);
}

// Maps, never `obj[serverString]` (a detail named "constructor" must miss).
const DISCONNECTED_REASON: ReadonlyMap<string, string> = new Map([
	["session-stopped", "session stopped"],
	["session-terminated", "session terminated"],
	["session-failed", "session failed"],
	["session-gone", "the session no longer exists"],
	["agent-removed", "agent removed"],
	["unbound", "no session bound"],
	["ended", "Claude ended"],
	["disconnected", "Claude disconnected"],
]);

const STALE_REASON = "the last evidence is more than 10 min old";

const UNKNOWN_REASON: ReadonlyMap<string, string> = new Map([
	["stale", STALE_REASON],
	["capture-unreadable", "the capture could not be read"],
	["no-conversation", "no Claude conversation captured yet"],
	["error", "the capture reports an error"],
	["ending", "the conversation is ending"],
	["unknown", "the capture does not know"],
]);

const SOURCE_LABEL: ReadonlyMap<string, string> = new Map([
	["hook", "hook"],
	["probe", "probe"],
	["session", "session status"],
	["capture", "capture"],
	["directory", "directory"],
]);

/**
 * The sources that are evidence FROM the agent: a hook of its CLI, or a
 * probe of it (a probe only moves the state when it asserts it, e.g.
 * `probe:busy`). `capture` is NOT one: backend presence.ts uses it for "no
 * usable conversation evidence" (an empty status_evidence). `session` and
 * `directory` only say a container runs or a binding exists — never that
 * Claude does anything.
 */
const AGENT_EVIDENCE: ReadonlySet<string> = new Set(["hook", "probe"]);
/**
 * A request addressed to the person must come from the CLI itself (its
 * hook), not from a probe's reading of a status line (owner, 2026-11-09).
 */
const ATTENTION_EVIDENCE: ReadonlySet<string> = new Set(["hook"]);

/** "via hook · 2 min ago"; "no evidence" when there is none. `now` on the server's clock. */
export function evidenceText(p: Pick<Presence, "source" | "at">, now: number): string {
	if (p.at === null || Number.isNaN(Date.parse(p.at))) return "no evidence";
	const source = SOURCE_LABEL.get(p.source) ?? (p.source || "unknown source");
	return `via ${source} · ${relativeDate(p.at, now)}`;
}

type Freshness = "fresh" | "stale" | "none" | "unverifiable";

/** How old the evidence is, on the server's clock alone (see ServerClock). */
function freshness(p: Pick<Presence, "at">, srvNow: number): Freshness {
	const at = p.at === null ? Number.NaN : Date.parse(p.at);
	if (Number.isNaN(at)) return "none";
	if (Number.isNaN(srvNow)) return "unverifiable";
	return srvNow - at < ATTENTION_STALE_MS ? "fresh" : "stale";
}

/**
 * What a live claim (working / ready / needs you) becomes when its
 * evidence can't carry it. Never a live state.
 */
function notLive(f: Freshness, evidence: string): PresenceView {
	if (f === "none") return { label: "No evidence", tone: "unknown", reason: null, evidence };
	if (f === "stale")
		return { label: "No recent activity", tone: "unknown", reason: STALE_REASON, evidence };
	return {
		label: "State unknown",
		tone: "unknown",
		reason: "the server's time is not known yet, so the evidence's age can't be checked",
		evidence,
	};
}

/**
 * The honest wording of a presence (owner rules, 2026-11-09). A live state
 * is shown only with recent evidence from the agent itself:
 *  - "Working": `working` from capture evidence (`hook`/`probe`/`capture`,
 *    never `session`/`directory` — a running container is not a working
 *    Claude) with a valid `at` younger than 10 min;
 *  - "Needs you": `needs_attention` + `detail: waiting_permission` from the
 *    CLI's own hook, fresh — never `waiting_input`, never a probe alone;
 *  - "Ready" / "Ready (unverified)": `waiting_input`, fresh;
 *  - evidence ≥ 10 min old (or the server's own `stale`) is "No recent
 *    activity"; none at all is "No evidence"; anything unrecognised is
 *    "State unknown" — never zero, idle or a live word.
 * Age is measured on the server's clock (`clock`, see ServerClock); `now`
 * is the browser's, used only for the time elapsed since receipt.
 */
export function presentPresence(p: Presence, clock: ServerClock | null, now: number): PresenceView {
	const srvNow = serverNow(clock, now);
	const evidence = evidenceText(p, Number.isNaN(srvNow) ? now : srvNow);
	const f = freshness(p, srvNow);
	switch (p.value) {
		case "working":
			if (!AGENT_EVIDENCE.has(p.source))
				return {
					label: "State unknown",
					tone: "unknown",
					reason: "no evidence from Claude itself",
					evidence,
				};
			if (f !== "fresh") return notLive(f, evidence);
			return { label: "Working", tone: "working", reason: null, evidence };
		case "waiting_input":
			if (f !== "fresh") return notLive(f, evidence);
			return p.verified === true
				? { label: "Ready", tone: "ready", reason: null, evidence }
				: {
						label: "Ready (unverified)",
						tone: "ready",
						reason: "Claude looks idle at its prompt; no probe confirmed it",
						evidence,
					};
		case "needs_attention":
			if (p.detail !== "waiting_permission")
				return {
					label: "State unknown",
					tone: "unknown",
					reason: "unrecognised attention state",
					evidence,
				};
			if (!ATTENTION_EVIDENCE.has(p.source))
				return {
					label: "State unknown",
					tone: "unknown",
					reason: "a permission prompt not confirmed by Claude's own hook",
					evidence,
				};
			if (f !== "fresh") return notLive(f, evidence);
			return {
				label: "Needs you",
				tone: "attention",
				reason: "waiting for a permission answer",
				evidence,
			};
		case "disconnected":
			return {
				label: "Disconnected",
				tone: "off",
				reason: (p.detail && DISCONNECTED_REASON.get(p.detail)) ?? p.detail ?? null,
				evidence,
			};
		case "unknown":
			if (p.at === null && !p.detail) {
				return { label: "No evidence", tone: "unknown", reason: null, evidence };
			}
			if (p.detail === "stale")
				return { label: "No recent activity", tone: "unknown", reason: STALE_REASON, evidence };
			return {
				label: "State unknown",
				tone: "unknown",
				reason: (p.detail && UNKNOWN_REASON.get(p.detail)) ?? p.detail ?? null,
				evidence,
			};
		default:
			return { label: "State unknown", tone: "unknown", reason: null, evidence };
	}
}

const SUMMARY_BUCKETS: ReadonlyArray<[PresenceTone, string]> = [
	["attention", "needs you"],
	["working", "working"],
	["ready", "ready"],
	["off", "disconnected"],
	["unknown", "no recent activity or unknown"],
];

/**
 * The project page's one-line summary: a count per DISPLAYED tone — the
 * same `presentPresence` views the cards show, so the two can't disagree.
 * Empty buckets are left out.
 */
export function presenceSummary(views: ReadonlyArray<Pick<PresenceView, "tone">>): string[] {
	const counts = new Map<PresenceTone, number>();
	for (const v of views) counts.set(v.tone, (counts.get(v.tone) ?? 0) + 1);
	const parts: string[] = [];
	for (const [tone, words] of SUMMARY_BUCKETS) {
		const n = counts.get(tone) ?? 0;
		if (n > 0) parts.push(`${n} ${words}`);
	}
	return parts;
}

// ── Sessions by binding (rule 1) ────────────────────────────────────────────

export interface BindableSession {
	sessionId: string;
	status: string;
	binding?: SessionBinding | null;
}

export interface SessionGroups<S> {
	/** Bound to an agent (server order). */
	bound: Array<{ session: S; binding: SessionBinding }>;
	/** `binding: null` — «Unassigned sessions». */
	unassigned: S[];
	/** The key is ABSENT: the directory read failed. Never "unassigned". */
	unknown: S[];
}

export function hasBindingKey(s: object): boolean {
	// JSON rows are plain objects: `in` sees exactly the keys the server sent.
	return "binding" in s;
}

export function groupSessionsByBinding<S extends BindableSession>(sessions: S[]): SessionGroups<S> {
	const groups: SessionGroups<S> = { bound: [], unassigned: [], unknown: [] };
	for (const s of sessions) {
		if (!hasBindingKey(s) || s.binding === undefined) groups.unknown.push(s);
		else if (s.binding === null) groups.unassigned.push(s);
		else if (typeof s.binding === "object") groups.bound.push({ session: s, binding: s.binding });
		else groups.unknown.push(s);
	}
	return groups;
}

/**
 * The sessions an agent may be created on: known to be unassigned (null,
 * never an absent key) and not terminated — the server refuses a
 * soft-deleted one as `session-not-found`. Stopped and failed ones may be
 * bound (PROJECTS.md §4.3).
 */
export function bindableSessions<S extends BindableSession>(sessions: S[]): S[] {
	return sessions.filter(
		(s) => hasBindingKey(s) && s.binding === null && s.status !== "terminated",
	);
}

// ── Input rules (mirrors PROJECTS.md §4.1 / §4.3; the server decides) ──────

export const HANDLE_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const PROJECT_NAME_MAX = 80;
export const ROLE_MAX = 60;

// biome-ignore lint/suspicious/noControlCharactersInRegex: the rule is exactly "no control characters".
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export function validateProjectName(raw: string): string | null {
	const name = raw.trim().normalize("NFC");
	if (name === "") return "Give the project a name.";
	if ([...name].length > PROJECT_NAME_MAX) return `At most ${PROJECT_NAME_MAX} characters.`;
	if (CONTROL_RE.test(name)) return "No control characters.";
	return null;
}

export function validateHandle(raw: string): string | null {
	if (raw === "") return "Give the agent a handle.";
	if (!HANDLE_RE.test(raw))
		return "2–32 characters: lowercase letters, digits and dashes, starting with a letter.";
	return null;
}

export function validateRole(raw: string): string | null {
	const role = raw.trim();
	if ([...role].length > ROLE_MAX) return `At most ${ROLE_MAX} characters.`;
	if (CONTROL_RE.test(role)) return "No control characters.";
	return null;
}

// ── Error wording (rule 5: decide by `error`, never by `message`) ───────────

const ERROR_TEXT: ReadonlyMap<string, string> = new Map([
	["session-taken", "That session already belongs to another agent."],
	[
		"handle-taken",
		"That handle already exists in this project (handles of removed agents stay reserved).",
	],
	["session-not-found", "Not found."],
	["project-not-found", "Not found."],
	["agent-not-found", "Not found."],
	["agent-limit", "You reached the maximum (32 agents per project)."],
	["project-limit", "You reached the maximum (50 projects)."],
	["outcome-unknown", "The result could not be confirmed. Retry — it is safe."],
	["agent-active", "Remove the agent first."],
	["invalid-name", "That name is not valid."],
	["invalid-handle", "That handle is not valid."],
	["invalid-role", "That role is not valid."],
	["invalid-session-id", "That session is not valid."],
	["network", "No answer from the server. Retry — it is safe."],
	["bad-answer", "The server's answer could not be read. Retry — it is safe."],
	["rate-limited", "Too many requests — wait a moment and try again."],
]);

export function projectErrorText(code: string, status: number): string {
	if (status === 429) return ERROR_TEXT.get("rate-limited")!;
	return ERROR_TEXT.get(code) ?? `Something went wrong (${code || status}).`;
}

/** A `can` refusal's reason, in words (the server's codes; unknown ones verbatim). */
export function refusalText(reason: string): string {
	if (reason === "agent-limit") return "This project has the maximum of 32 agents.";
	if (reason === "project-limit") return "You have the maximum of 50 projects.";
	if (reason === "agent-removed") return "This agent was removed.";
	return reason;
}

const RETIRE_REASON: ReadonlyMap<string, string> = new Map([["agent-removed", "agent removed"]]);

export function retireReasonText(reason: string | null): string {
	if (reason === null) return "";
	return RETIRE_REASON.get(reason) ?? reason;
}

// ── Idempotent creation (rule 4) ────────────────────────────────────────────
//
// One `clientRequestId` per user action, reused ONLY to retry that same
// action. The machine below is the whole policy; the dialogs just follow it.
//
//   editing ──send──▶ sending ──201──────────────▶ done (replayed is success)
//                        │  ──503 / no answer ──▶ unknown ──Retry (same id)──▶ sending
//                        └─ refusal ─────────────▶ editing (id retired), error shown —
//                                                  after an `unknown`, reload first
//
// While `unknown` the inputs are frozen: the lost attempt may still land
// with THAT body, and a retry under the same id with another body is an
// `idempotency-conflict`. Nothing here retries on its own.

export type CreationPhase = "editing" | "sending" | "unknown" | "done";

export type CreationOutcome =
	| { kind: "created"; replayed: boolean }
	| { kind: "unknown"; code: string }
	| { kind: "refused"; code: string; status: number };

export interface CreationStep {
	/** What the dialog shows. */
	phase: CreationPhase;
	/** Words for the person; null when nothing needs saying. */
	message: string | null;
	/** The list may now hold what a lost attempt created: re-read it BEFORE showing `message`. */
	reloadFirst: boolean;
}

/**
 * Which answers prove nothing about a write: a 503 (`outcome-unknown`), any
 * other 5xx, no answer at all, a 2xx without the expected body. A 4xx is a
 * refusal (the server decided — or the rate limiter did, before any write).
 */
export function classifyCreation(
	answer: { ok: true; replayed: boolean } | { ok: false; status: number; code: string },
): CreationOutcome {
	if (answer.ok) return { kind: "created", replayed: answer.replayed };
	const { status, code } = answer;
	if (code === "network" || code === "bad-answer" || status === 0 || status >= 500)
		return { kind: "unknown", code: code || "outcome-unknown" };
	return { kind: "refused", code, status };
}

export class CreationAttempt {
	phase: CreationPhase = "editing";
	private requestId: string | null = null;
	/** A 503/no-answer was seen for the current id. */
	private sawUnknown = false;

	constructor(private readonly mint: () => string) {}

	/** Inputs are editable only while editing. */
	get inputsLocked(): boolean {
		return this.phase !== "editing";
	}

	/** The id for the request about to leave: a new one, or the SAME one on a retry. */
	send(): string {
		if (this.phase === "sending" || this.phase === "done")
			throw new Error(`cannot send while ${this.phase}`);
		if (this.phase === "editing" || this.requestId === null) this.requestId = this.mint();
		this.phase = "sending";
		return this.requestId;
	}

	/** The person gives up after an unknown outcome or a refusal: back to editing, id retired. */
	abandon(): void {
		if (this.phase === "sending") return;
		this.phase = "editing";
		this.requestId = null;
		this.sawUnknown = false;
	}

	receive(outcome: CreationOutcome): CreationStep {
		if (this.phase !== "sending") throw new Error("no request in flight");
		switch (outcome.kind) {
			case "created":
				this.phase = "done";
				return { phase: "done", message: null, reloadFirst: false };
			case "unknown":
				this.phase = "unknown";
				this.sawUnknown = true;
				return {
					phase: "unknown",
					message:
						outcome.code === "outcome-unknown"
							? projectErrorText("outcome-unknown", 503)
							: projectErrorText(outcome.code, 0),
					reloadFirst: false,
				};
			case "refused": {
				// A 429 after an unknown outcome is the rate limiter refusing the
				// RETRY before any write: it says nothing about the lost attempt,
				// which can still land. Keep the id (and the frozen inputs) so the
				// next Retry stays idempotent — a fresh id could create a second
				// project, since names are not unique (PROJECTS.md §3).
				if (outcome.status === 429 && this.sawUnknown) {
					this.phase = "unknown";
					return {
						phase: "unknown",
						message: projectErrorText(outcome.code, 429),
						reloadFirst: false,
					};
				}
				// A refusal is final for THIS id; the next action mints a new
				// one (an `idempotency-conflict` is a client error: same rule).
				const reloadFirst = this.sawUnknown;
				this.phase = "editing";
				this.requestId = null;
				this.sawUnknown = false;
				return {
					phase: "editing",
					message: projectErrorText(outcome.code, outcome.status),
					reloadFirst,
				};
			}
		}
	}
}

// ── Misc ────────────────────────────────────────────────────────────────────

export function agentCountText(n: number): string {
	return n === 1 ? "1 agent" : `${n} agents`;
}

export function providerText(provider: string): string {
	return provider === "claude-code" ? "Claude Code" : provider;
}

/** The title of a project page (names only — tabTitle.ts's rule). */
export function pageTitle(projectName: string | null, handle: string | null): string {
	const project = projectName ?? "Project";
	return handle ? `@${handle} · ${project}` : project;
}
