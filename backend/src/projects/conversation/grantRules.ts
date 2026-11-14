/**
 * projects/conversation/grantRules.ts — what the log's own state says must
 * be written about a D3 grant (docs/PROJECT_CONVERSATION.md §7.5). Pure:
 * events computed from the folded state, appended by the caller inside the
 * critical section it already holds.
 *
 * The rule this module exists for: **a delivery's result and what that
 * result does to its grant are ONE append**. Written apart, a death between
 * the two would leave a `failed` relay under a grant that still reads live,
 * and the next agent message would be admitted and typed into a terminal.
 * So every writer of a result line (fanout.ts S2/S4, collab.ts) asks
 * `deliveryConsequence` in the same critical section and appends its answer
 * in the same batch.
 */

import {
	type DeliveryFold,
	deliveryKey,
	type Folded,
	type GrantFold,
	isResultState,
} from "./fold.js";
import type { NewEvent } from "./log.js";

export const collabOf = (grantId: string): string => `collab:${grantId}`;
export const grantIdOf = (authorizedBy: string | undefined): string | null =>
	authorizedBy?.startsWith("collab:") ? authorizedBy.slice("collab:".length) : null;

/** Relay deliveries of a grant that have not reached a result (`except`: the one being closed now). */
export function pendingRelays(state: Folded, grantId: string, except?: string): DeliveryFold[] {
	const by = collabOf(grantId);
	return [...state.deliveries.values()].filter(
		(d) =>
			d.authorizedBy === by &&
			!isResultState(d.state) &&
			deliveryKey(d.msgId, d.agentId) !== except,
	);
}

/**
 * The events that end a grant: every relay still QUEUED becomes not-sent in
 * the same append (it never had an effect), then the end itself. A delivery
 * already planned or sending is not touched — its own path finishes it, and
 * its S3 gate reads the grant as ended.
 */
export function endEvents(
	state: Folded,
	g: GrantFold,
	end: { event: "ended"; reason: string; by: string } | { event: "revoked"; by: string },
	reasons: Map<string, string> = new Map(),
): NewEvent[] {
	const out: NewEvent[] = [];
	for (const d of pendingRelays(state, g.grantId)) {
		if (d.state !== "queued") continue;
		out.push({
			ev: "delivery",
			msg_id: d.msgId,
			agent_id: d.agentId,
			state: "not-sent",
			reason: reasons.get(deliveryKey(d.msgId, d.agentId)) ?? "grant-inactive",
			authorized_by: collabOf(g.grantId),
		});
	}
	out.push({ ev: "grant", grant_id: g.grantId, ...end });
	return out;
}

export const pauseEvent = (
	g: GrantFold,
	reason: string,
	by: string,
	ref?: { msg_id: string; agent_id: string },
	detail?: Record<string, string>,
): NewEvent => ({
	ev: "grant",
	grant_id: g.grantId,
	event: "paused",
	reason,
	by,
	...(ref ? { ref } : {}),
	...(detail ? { detail } : {}),
});

/**
 * May a pause for `reason` be written now? Always on a live grant. On a
 * paused one only when it changes who can lift it: `delivery-uncertain` is
 * the one pause the Composer's evidence lifts by itself (§7.5), so any other
 * cause arriving meanwhile — the person's Pause above all — must be
 * recorded over it, or that evidence would resume a grant the person
 * paused. And the person's pause is recorded over any pause that is not
 * already theirs, so the log says who decided.
 */
export function mayPause(g: GrantFold, reason: string): boolean {
	if (g.state === "live") return true;
	if (g.state !== "paused") return false;
	if (reason === "owner") return g.reason !== "owner";
	return g.reason === "delivery-uncertain" && reason !== "delivery-uncertain";
}

/** §7.2: the last message was used and nothing of the grant is still on its way. */
export function budgetSpent(state: Folded, g: GrantFold, except?: string): boolean {
	return g.used >= g.maxMessages && pendingRelays(state, g.grantId, except).length === 0;
}

/**
 * What the end of one delivery does to its grant (§7.5 table). `r` is the
 * line being written (or, for `settled`, already written): the function
 * never assumes it is folded yet, hence `except`.
 */
export function deliveryConsequence(
	state: Folded,
	msgId: string,
	agentId: string,
	r: { state: string; reason?: string; result?: string },
): NewEvent[] {
	const m = state.messages.get(msgId);
	if (!m?.grantId) return [];
	const g = state.grants.get(m.grantId);
	if (!g || g.state === "ended") return [];
	const key = deliveryKey(msgId, agentId);

	if (m.kind !== "relay") {
		// The task itself. If it clearly never reached the initiator there is
		// nobody to consult on its behalf: nobody received the protocol.
		const never = r.state === "not-sent" || r.state === "refused" || r.state === "failed";
		return never && agentId === g.initiator
			? endEvents(state, g, { event: "ended", reason: "task-not-delivered", by: "system" })
			: [];
	}

	const delivered = r.state === "delivered" || (r.state === "settled" && r.result === "delivered");
	if (delivered) {
		const out: NewEvent[] = [];
		let paused = g.state === "paused";
		// The Composer's own evidence settled the very delivery that paused it.
		if (
			paused &&
			g.reason === "delivery-uncertain" &&
			g.pauseRef?.msg_id === msgId &&
			g.pauseRef?.agent_id === agentId
		) {
			out.push({ ev: "grant", grant_id: g.grantId, event: "resumed", by: "evidence" });
			paused = false;
		}
		if (!paused && budgetSpent(state, g, key)) {
			out.push(...endEvents(state, g, { event: "ended", reason: "budget", by: "system" }));
		}
		return out;
	}
	// An uncertain settled as anything but delivered changes nothing: it stays paused.
	if (r.state === "settled") return [];
	if (r.state === "not-sent") {
		if (r.reason === "binding-changed") {
			return endEvents(state, g, { event: "ended", reason: "binding-changed", by: "system" });
		}
		// Written by the path that already decided the grant's fate.
		if (["grant-paused", "grant-inactive", "wait-expired"].includes(r.reason ?? "")) return [];
	}
	const reason = `delivery-${r.state}`;
	return mayPause(g, reason)
		? [pauseEvent(g, reason, "system", { msg_id: msgId, agent_id: agentId })]
		: [];
}
