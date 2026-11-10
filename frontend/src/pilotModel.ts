/**
 * pilotModel.ts — "Ask the agents" (Pilot 1, docs/design/project-chat/18).
 * Pure and unit-tested; the DOM is pilotPanel.ts.
 *
 * One message, sent by the person, to several agents of a project: one
 * ordinary Composer send per agent (CONVERSATION.md §8), each with its own
 * clientMessageId. Nothing here is a new transport or a new rule; the
 * server decides every send. What this module adds is the reading side:
 *
 * **A reply is attributed to a send only on evidence, never on time.** The
 * evidence is the `prompt_id` of the CLI's own `user_prompt` that the
 * Composer acknowledged (a 202 `delivered` with `promptId`, or later the
 * send's own `composer_send` event carrying `result: delivered` and
 * `prompt_id` for the same `client_message_id`). The reply is then exactly
 * the events whose `prompt_id` is that one. A send without that evidence
 * (`unconfirmed`, `uncertain`, `misdelivered`, a refusal) has no reply: the
 * lane says so, and events that arrive meanwhile are never shown as an
 * answer to it, however close in time.
 *
 * Owner decisions D-PIL1–D-PIL5 (2026-11-10): reuse the Composer from a new
 * client without changing it; the panel lives on the project page; forward
 * with preview, editable text and an explicit click; temporary until P7;
 * every send independent (a busy / 409 / unconfirmed never blocks another).
 */

import type { ComposerSendResult, ConversationSummary } from "./api.js";
import { explainCode } from "./composerText.js";
import { buildThread, type ConversationEvent, type ThreadItem } from "./conversationModel.js";

// ── Opt-in (per browser) ────────────────────────────────────────────────────

const STORAGE_KEY = "st.pilotAskAgents";

/**
 * `?pilot=1` turns the panel on in this browser, `?pilot=0` off; the
 * choice is kept in localStorage (like `?ui=v2`). Returns the new value and
 * whether the address carried the parameter (the caller strips it).
 */
export function pilotFromLocation(
	search: string,
	stored: string | null,
): { enabled: boolean; fromUrl: boolean } {
	const v = new URLSearchParams(search).get("pilot");
	if (v === "1") return { enabled: true, fromUrl: true };
	if (v === "0") return { enabled: false, fromUrl: true };
	return { enabled: stored === "1", fromUrl: false };
}

export function readPilotStored(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

/**
 * Read `?pilot=` once at start: persist it, strip it from the address (the
 * same handling as `?ui=`), and return whether the panel is on here.
 */
export function initPilotOptIn(): boolean {
	const { enabled, fromUrl } = pilotFromLocation(location.search, readPilotStored());
	if (fromUrl) {
		writePilotStored(enabled);
		const url = new URL(location.href);
		url.searchParams.delete("pilot");
		history.replaceState(history.state, "", url.pathname + url.search + url.hash);
	}
	return enabled;
}

export function writePilotStored(enabled: boolean): void {
	try {
		if (enabled) localStorage.setItem(STORAGE_KEY, "1");
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* private mode: the opt-in lasts this page load only */
	}
}

// ── Which conversation of an agent receives ─────────────────────────────────

export type Target =
	| { kind: "ok"; cid: string; lastSeq: number }
	| { kind: "none"; reason: string }
	| { kind: "ambiguous"; count: number };

/**
 * The agent's session conversation a send goes to: the live interactive one
 * bound to a pane that the server says can take input. Exactly one, or the
 * panel does not guess: none ⇒ the reason; several ⇒ ambiguous (the person
 * picks in that agent's Chat).
 */
export function pickTarget(convs: readonly ConversationSummary[]): Target {
	const live = convs.filter((c) => c.kind === "interactive" && c.paneId !== null && !c.endedAt);
	const ready = live.filter((c) => c.canSendInput);
	if (ready.length === 1)
		return { kind: "ok", cid: ready[0]!.sessionId, lastSeq: ready[0]!.lastSeq };
	if (ready.length > 1) return { kind: "ambiguous", count: ready.length };
	if (live.length === 0)
		return { kind: "none", reason: "no Claude conversation in a terminal pane" };
	const blocked = live.find((c) => c.composer?.blocked);
	if (blocked)
		return { kind: "none", reason: explainCode("send-in-progress", blocked.composer?.reason) };
	return { kind: "none", reason: "can't take a message right now (open its Chat to see why)" };
}

// ── A send's outcome ────────────────────────────────────────────────────────

/** The evidence that ties replies to a send. */
export interface Correlation {
	promptId: string;
	/** The `user_prompt`'s seq when known: replies are at or after it. */
	seq: number | null;
}

export type SendState =
	| { kind: "sending" }
	| { kind: "delivered"; corr: Correlation }
	/** Accepted by the server, delivery not proven yet: waiting for the send's own event. */
	| { kind: "pending"; result: "uncertain" | "accepted" }
	/** Final (§8.1.6): the CLI did not show the message as received; nothing is attributed. */
	| { kind: "unconfirmed" }
	| { kind: "misdelivered" }
	/** The server says delivered but names no prompt id: final, and nothing can be attributed. */
	| { kind: "delivered-unattributed" }
	/** Settled by an operator (§8.1.10: `discarded` / `sent-manually`). */
	| { kind: "resolved"; outcome: string }
	| { kind: "refused"; status: number; text: string }
	| { kind: "error"; text: string };

/** States no later event changes: the panel stops following for them. */
export function isFinal(st: SendState): boolean {
	return (
		st.kind === "misdelivered" ||
		st.kind === "unconfirmed" ||
		st.kind === "delivered-unattributed" ||
		st.kind === "resolved" ||
		st.kind === "refused" ||
		st.kind === "error"
	);
}

/** The HTTP answer of one Composer send (§8.1), as a lane state. Never retried. */
export function sendStateOf(r: ComposerSendResult): SendState {
	const b = r.body;
	if (r.status === 202 || r.status === 200) {
		if (b.result === "delivered" && typeof b.promptId === "string" && b.promptId) {
			return {
				kind: "delivered",
				corr: { promptId: b.promptId, seq: typeof b.seq === "number" ? b.seq : null },
			};
		}
		if (b.result === "misdelivered") return { kind: "misdelivered" };
		// The server's `delivered` without a prompt id (its candidate had none):
		// final, but there is no evidence to attribute a reply on.
		if (b.result === "delivered") return { kind: "delivered-unattributed" };
		if (b.result === "unconfirmed") return { kind: "unconfirmed" };
		if (b.result === "uncertain" || b.result === "accepted") {
			return { kind: "pending", result: b.result };
		}
		return { kind: "pending", result: "uncertain" };
	}
	const code = typeof b.error === "string" ? b.error : "";
	return {
		kind: "refused",
		status: r.status,
		text: code ? explainCode(code, b.detail) : `The server answered ${r.status}.`,
	};
}

/**
 * A later `composer_send` event of THIS send (same client_message_id) that
 * settles it: delivered with the CLI's prompt id, or misdelivered. Anything
 * else (another send's event, a state without a result) changes nothing.
 */
export function settleFromEvent(e: ConversationEvent, clientMessageId: string): SendState | null {
	if (e.ev !== "composer_send" || e.data.client_message_id !== clientMessageId) return null;
	const d = e.data;
	// Only the event that RECORDS a decision counts: its `state` is the
	// decision. Later events of the same send (`released`, duplicate markers)
	// repeat `result` and may carry another prompt id; they decide nothing.
	const is = (v: string) => d.state === v;
	if (is("delivered")) {
		if (typeof d.prompt_id === "string" && d.prompt_id) {
			return {
				kind: "delivered",
				corr: { promptId: d.prompt_id, seq: typeof d.seq === "number" ? d.seq : null },
			};
		}
		// A recorded `delivered` without a prompt id: final, unattributable.
		// (The background transport's `delivered` always carries one.)
		return { kind: "delivered-unattributed" };
	}
	if (is("misdelivered")) return { kind: "misdelivered" };
	if (is("failed")) {
		// The answer the server recorded for it (a late failure, a cancellation).
		const body = (d.http as { body?: { error?: unknown; detail?: unknown } } | undefined)?.body;
		const code = typeof body?.error === "string" ? body.error : "delivery-failed";
		const detail = typeof body?.detail === "string" ? body.detail : undefined;
		return { kind: "refused", status: 0, text: explainCode(code, detail) };
	}
	if (is("resolved")) {
		return { kind: "resolved", outcome: typeof d.outcome === "string" ? d.outcome : "resolved" };
	}
	if (is("unconfirmed")) return { kind: "unconfirmed" };
	return null;
}

// ── The reply ───────────────────────────────────────────────────────────────

export interface Reply {
	/** The thread of exactly the correlated events (user prompt, tools, answer). */
	items: ThreadItem[];
	/**
	 * A `turn_end`/`turn_failed` for this prompt arrived. Not necessarily the
	 * last: `Stop` can fire again for the same prompt id when a hook blocks
	 * and the turn goes on, so the answer can still change.
	 */
	finished: boolean;
	failed: boolean;
	/**
	 * Another prompt joined the turn: text typed while the CLI was busy is
	 * submitted with the prompt id of the turn in progress (CONVERSATION.md
	 * §8.1.7), so the answer may be to both. Shown, never hidden; not
	 * forwardable as this agent's answer to this message.
	 */
	ambiguous: boolean;
	/** The answer to forward: the turn's report, else the last assistant text. */
	answer: string | null;
}

/** Events of the send's prompt — by `prompt_id` only, never by position or time. */
export function correlated(
	events: readonly ConversationEvent[],
	corr: Correlation,
): ConversationEvent[] {
	return events.filter(
		(e) =>
			e.prompt_id === corr.promptId &&
			e.ev !== "composer_send" &&
			(corr.seq === null || e.seq >= corr.seq),
	);
}

export function replyOf(events: readonly ConversationEvent[], corr: Correlation): Reply {
	const mine = correlated(events, corr);
	const thread = buildThread(mine);
	const finished = mine.some((e) => e.ev === "turn_end" || e.ev === "turn_failed");
	const failed = mine.some((e) => e.ev === "turn_failed");
	const prompts = mine.filter((e) => e.ev === "user_prompt" || e.ev === "internal_prompt");
	const ambiguous =
		corr.seq !== null ? prompts.some((e) => e.seq !== corr.seq) : prompts.length > 1;
	let answer: string | null = null;
	for (const it of thread.items) {
		if (it.kind === "report" && it.text) answer = it.text;
		else if (it.kind === "assistant" && it.report) answer = it.report.text;
	}
	if (answer === null) {
		const last = [...thread.items].reverse().find((it) => it.kind === "assistant");
		if (last && last.kind === "assistant" && last.text) answer = last.text;
	}
	return { items: thread.items, finished, failed, ambiguous, answer };
}

/**
 * Events of the conversation after the send that are NOT attributed to it
 * (no evidence yet, or another prompt). Only counted, never shown as a reply.
 */
export function unattributedCount(
	events: readonly ConversationEvent[],
	after: number,
	corr: Correlation | null,
): number {
	return events.filter(
		(e) =>
			e.seq > after &&
			e.ev !== "composer_send" &&
			e.ev !== "probe" &&
			(corr === null || e.prompt_id !== corr.promptId),
	).length;
}

// ── Forward ─────────────────────────────────────────────────────────────────

/** The draft a forward pre-fills: who said it, then the text, for the person to edit. */
export function forwardDraft(fromHandle: string, answer: string): string {
	return `From @${fromHandle}:\n\n${answer}`;
}

export function newClientMessageId(): string {
	return crypto.randomUUID();
}
