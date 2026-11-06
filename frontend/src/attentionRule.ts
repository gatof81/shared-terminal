/**
 * attentionRule.ts — what a conversation's state asks of the person, from its
 * last evidence. ONE rule for every surface: the conversation switcher, the
 * per-project attention signal (docs/design/attention-signal.md) and, when
 * the backend endpoint lands, `GET /api/activity` — which must carry a
 * byte-identical copy of this file (like composerText.ts), so the counts on
 * a badge and the sections of the switcher can never disagree.
 *
 * Pure and dependency-free on purpose: no imports, no DOM, no clock.
 *
 * Owner decision (2026-11-06, option A):
 * - attention ("needs you"): `waiting_permission` with FRESH evidence only;
 * - ready: `waiting_input` with fresh evidence — Claude at its prompt; a
 *   secondary, discreet indicator (every idle CLI is "ready", so counting it
 *   as "needs you" would bury the real permission prompts);
 * - working: `running` and `waiting_background` with fresh evidence;
 * - stale: a live claim whose evidence is older than the window — never
 *   shown as activity;
 * - unknown: `unknown`; other: everything else (ended, error, …).
 */

export type AttentionKind = "attention" | "ready" | "working" | "stale" | "unknown" | "other";

/** A live claim older than this proves nothing (10 min). */
export const ATTENTION_STALE_MS = 10 * 60 * 1000;

const LIVE = new Set(["running", "waiting_input", "waiting_background", "waiting_permission"]);

/**
 * Last evidence (ms since epoch): the newer of the state's time and the last
 * event, falling back to whichever parses; NaN when neither does.
 */
export function lastEvidenceMs(statusAt: string, lastEventAt?: string | null): number {
	const s = Date.parse(statusAt);
	const e = Date.parse(lastEventAt ?? "");
	if (Number.isNaN(e)) return s;
	if (Number.isNaN(s)) return e;
	return Math.max(s, e);
}

export function attentionKind(
	c: { status: string; statusAt: string; lastEventAt?: string | null },
	now: number,
	staleMs: number = ATTENTION_STALE_MS,
): AttentionKind {
	if (c.status === "unknown") return "unknown";
	if (!LIVE.has(c.status)) return "other";
	const at = lastEvidenceMs(c.statusAt, c.lastEventAt);
	if (Number.isNaN(at) || now - at >= staleMs) return "stale";
	if (c.status === "waiting_permission") return "attention";
	if (c.status === "waiting_input") return "ready";
	return "working";
}
