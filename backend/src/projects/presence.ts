/**
 * projects/presence.ts — an agent's presence in P3a (docs/PROJECTS.md §5),
 * derived ONLY from what D1 already holds: the bound session's status and
 * the capture's conversation rows. No probe, no Docker, no new evidence:
 * this is a reading of the capture's state, never a second state machine.
 *
 * Pure and unit-tested. The freshness rule is the frontend's
 * (`STALE_EVIDENCE_MS` / `lastEvidenceAt` in conversationModel.ts): a live
 * claim whose newest evidence is ≥ 10 min old proves nothing, so it reads
 * `unknown` — never `working`, and never counted as zero.
 */

export const PRESENCE_STALE_MS = 10 * 60 * 1000;

export type PresenceValue =
	| "working"
	| "waiting_input"
	| "needs_attention"
	| "disconnected"
	| "unknown";

export interface Presence {
	value: PresenceValue;
	/** Why, when the value alone does not say it (`waiting_permission`, `stale`, `session-stopped`…). */
	detail?: string;
	/**
	 * Where the evidence comes from: `session` (the session row), `capture`
	 * (no usable conversation evidence), or the prefix of the capture's own
	 * `status_evidence` (`hook`, `probe`, `reconcile`, `timeout`…).
	 */
	source: string;
	/** When that evidence was produced; null when there is none. */
	at: string | null;
	/** Only on `waiting_input`: true iff a probe (identity verified) said so (CONVERSATION.md §5.3). */
	verified?: boolean;
}

export interface PresenceConversation {
	status: string;
	statusEvidence: string;
	statusAt: string;
	lastEventAt: string | null;
}

export interface PresenceInput {
	/** The bound session's status; null when its row no longer exists. */
	sessionStatus: string | null;
	/** False when the conversation read failed: the answer is `unknown`, never a guess. */
	conversationsRead: boolean;
	/** The deciding conversation (see `decidingConversation`), or null. */
	conversation: PresenceConversation | null;
	/** The instant the session status was read (ISO). */
	readAt: string;
	now: number;
}

const LIVE_CLAIMS = new Set([
	"running",
	"waiting_background",
	"waiting_input",
	"waiting_permission",
]);

/**
 * The newer of the state's time and the last activity. The epoch is "no time"
 * (a state that has none, or a `lastEventAt` the store could not recover —
 * CONVERSATION.md §4.1), so it counts as no evidence: `at` null, `t` NaN.
 */
function newestEvidence(c: PresenceConversation): { at: string | null; t: number } {
	const time = (v: string | null) => {
		const t = v === null ? Number.NaN : Date.parse(v);
		return t > 0 ? t : Number.NaN;
	};
	const s = time(c.statusAt);
	const e = time(c.lastEventAt);
	if (Number.isNaN(s) && Number.isNaN(e)) return { at: null, t: Number.NaN };
	if (Number.isNaN(e) || (!Number.isNaN(s) && s >= e)) return { at: c.statusAt, t: s };
	return { at: c.lastEventAt as string, t: e };
}

function evidenceSource(statusEvidence: string): string {
	const i = statusEvidence.indexOf(":");
	return (i === -1 ? statusEvidence : statusEvidence.slice(0, i)) || "capture";
}

export function derivePresence(input: PresenceInput): Presence {
	if (input.sessionStatus === null) {
		return { value: "disconnected", detail: "session-gone", source: "session", at: input.readAt };
	}
	if (input.sessionStatus !== "running") {
		return {
			value: "disconnected",
			detail: `session-${input.sessionStatus}`,
			source: "session",
			at: input.readAt,
		};
	}
	if (!input.conversationsRead) {
		return { value: "unknown", detail: "capture-unreadable", source: "capture", at: null };
	}
	const c = input.conversation;
	if (c === null) return { value: "unknown", source: "capture", at: null };

	const { at, t } = newestEvidence(c);
	const source = evidenceSource(c.statusEvidence);
	if (LIVE_CLAIMS.has(c.status) && (Number.isNaN(t) || input.now - t >= PRESENCE_STALE_MS)) {
		return { value: "unknown", detail: "stale", source, at };
	}
	switch (c.status) {
		case "running":
		case "waiting_background":
			return { value: "working", source, at };
		case "waiting_input":
			return { value: "waiting_input", source, at, verified: source === "probe" };
		case "waiting_permission":
			return { value: "needs_attention", detail: "waiting_permission", source, at };
		case "disconnected":
		case "ended":
			return { value: "disconnected", detail: c.status, source, at };
		default:
			// error, ending, unknown — and any status a later contract adds.
			return { value: "unknown", detail: c.status, source, at };
	}
}

/**
 * Which conversation decides (PROJECTS.md §5): the one with the newest
 * evidence among those whose pane is bound. Pane bindings are released at
 * every container stop (CONVERSATION.md v1.7.2), so a bound pane means the
 * current start — an old `ended` conversation (after `/clear`) never makes
 * a live agent look disconnected.
 */
export function decidingConversation<T extends PresenceConversation & { paneId: string | null }>(
	rows: readonly T[],
): T | null {
	let best: T | null = null;
	let bestT = Number.NEGATIVE_INFINITY;
	for (const r of rows) {
		if (r.paneId === null) continue;
		const { t } = newestEvidence(r);
		const key = Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
		if (best === null || key > bestT) {
			best = r;
			bestT = key;
		}
	}
	return best;
}
