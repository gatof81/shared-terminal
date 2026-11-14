/**
 * projects/conversation/recovery.ts — what opening a project log writes
 * before anything else may (docs/PROJECT_CONVERSATION.md §3.4 rule 4, §8).
 * Pure: the events to append, computed from the folded log.
 *
 * The rule that matters: recovery NEVER calls the Composer. A delivery
 * whose intent (`sending`) is on disk without a result was maybe sent, so
 * it becomes `uncertain`; one that never reached `sending` was never sent.
 * After a restore even that distinction is gone — the backup may predate
 * the `sending` — so every unfinished delivery is `uncertain{restored}`.
 *
 * D3 (§7.5): a `queued` delivery had no effect and no intent, so a restart
 * leaves it queued; a grant survives a restart — paused (`recovered`) when
 * one of its deliveries was closed here, ended when its time passed. A
 * restore ends every grant (`interrupted`): the person is not watching the
 * collaboration the backup describes.
 */

import { type Folded, grantAlive, isResultState } from "./fold.js";
import type { LogLine, NewEvent } from "./log.js";

export type RecoverySource =
	| { source: "boot" }
	| { source: "restore"; restoreId: string; manifestAt: string | null };

export function recoveryEvents(
	f: Folded,
	src: RecoverySource,
	ctx: { bootId: string; truncatedBytes: number; interleavedWriters: string[]; nowMs?: number },
): NewEvent[] {
	if (src.source === "restore" && f.restoresApplied.has(src.restoreId)) return [];
	const out: NewEvent[] = [];
	const orphaned: Array<{ msg_id: string; agent_id: string; as: string }> = [];
	const nowMs = ctx.nowMs ?? Date.now();
	const grantIdOf = (d: { authorizedBy?: string }): string | null =>
		d.authorizedBy?.startsWith("collab:") ? d.authorizedBy.slice("collab:".length) : null;
	// Grants whose time passed while nobody was writing (boot) or that a
	// restore interrupts: closed here, and their queued deliveries with them.
	const closing = new Map<string, string>();
	for (const g of f.grants.values()) {
		if (g.state === "ended") continue;
		if (src.source === "restore") closing.set(g.grantId, "interrupted");
		else if (!grantAlive(g, nowMs)) closing.set(g.grantId, "expired");
	}
	const pausing = new Set<string>();
	for (const d of f.deliveries.values()) {
		if (isResultState(d.state)) continue;
		// A relay's grant, or the grant whose task this delivery carries.
		const relayGid = grantIdOf(d);
		const gid = relayGid ?? f.messages.get(d.msgId)?.grantId ?? null;
		// D1 lines keep their exact shape; only a relay names its authorization.
		const tail = relayGid ? { authorized_by: d.authorizedBy } : {};
		if (d.state === "queued" && src.source === "boot") {
			// Still queued unless its grant ends in this same batch.
			if (gid && (closing.has(gid) || !f.grants.has(gid) || f.grants.get(gid)?.state === "ended")) {
				out.push({
					ev: "delivery",
					msg_id: d.msgId,
					agent_id: d.agentId,
					state: "not-sent",
					reason: "grant-inactive",
					...tail,
				});
				orphaned.push({ msg_id: d.msgId, agent_id: d.agentId, as: "not-sent{grant-inactive}" });
			}
			continue;
		}
		// §7.2: a task that never reached `sending` never carried the protocol
		// to the initiator — the grant ends; anything else pauses it.
		if (gid && !relayGid && !d.sent && src.source === "boot" && !closing.has(gid)) {
			closing.set(gid, "task-not-delivered");
		}
		if (gid && !closing.has(gid)) pausing.add(gid);
		let ev: NewEvent;
		if (src.source === "restore") {
			ev = {
				ev: "delivery",
				msg_id: d.msgId,
				agent_id: d.agentId,
				state: "uncertain",
				reason: "restored",
			};
			if (d.placed) ev.files_possibly_placed = true;
		} else if (d.sent) {
			ev = {
				ev: "delivery",
				msg_id: d.msgId,
				agent_id: d.agentId,
				state: "uncertain",
				reason: "orphaned",
			};
		} else {
			ev = {
				ev: "delivery",
				msg_id: d.msgId,
				agent_id: d.agentId,
				state: "not-sent",
				reason: "persist-failed",
			};
			if (d.placed) ev.files_possibly_placed = true;
		}
		Object.assign(ev, tail);
		out.push(ev);
		orphaned.push({ msg_id: d.msgId, agent_id: d.agentId, as: `${ev.state}{${ev.reason}}` });
	}
	const grantsKept: string[] = [];
	const grantsPaused: string[] = [];
	const grantsClosed: string[] = [];
	for (const g of f.grants.values()) {
		if (g.state === "ended") continue;
		const why = closing.get(g.grantId);
		if (why) {
			out.push({ ev: "grant", grant_id: g.grantId, event: "ended", reason: why, by: "system" });
			grantsClosed.push(g.grantId);
		} else if (pausing.has(g.grantId) && g.state === "live") {
			out.push({
				ev: "grant",
				grant_id: g.grantId,
				event: "paused",
				reason: "recovered",
				by: "system",
			});
			grantsPaused.push(g.grantId);
		} else grantsKept.push(g.grantId);
	}
	// A settle window this process did not observe in full (§4.1): never exact.
	for (const [key, s] of f.settling) {
		if (f.replyRefs.has(key)) continue;
		const { seq: _s, ev: _e, at: _a, w: _w, bn: _b, settle_until: _u, ...ref } = s as LogLine;
		out.push({ ...ref, ev: "reply_ref", attribution: "ambiguous{settle-unobserved}" });
	}
	const needsRecord =
		out.length > 0 ||
		ctx.truncatedBytes > 0 ||
		ctx.interleavedWriters.length > 0 ||
		src.source === "restore";
	if (!needsRecord) return [];
	const rec: NewEvent = {
		ev: "recovery",
		boot_id: ctx.bootId,
		source: src.source,
		orphaned,
		grants_closed: grantsClosed,
	};
	// Only in a log that has grants: a D1-only log keeps its exact record.
	if (f.grants.size > 0) {
		rec.grants_kept = grantsKept;
		rec.grants_paused = grantsPaused;
	}
	if (src.source === "restore") {
		rec.restore_id = src.restoreId;
		rec.manifest_at = src.manifestAt;
	}
	if (ctx.truncatedBytes > 0) rec.truncated_bytes = ctx.truncatedBytes;
	if (ctx.interleavedWriters.length > 0) rec.foreign_writer = ctx.interleavedWriters;
	out.push(rec);
	return out;
}

/**
 * Writers whose lines are interleaved with another's (§2.1 point 4). Each
 * boot has its own id, so writers following each other is normal; one that
 * reappears after another has written is two processes on the same file.
 */
export function interleavedWriters(lines: readonly LogLine[]): string[] {
	const finished = new Set<string>();
	const bad = new Set<string>();
	let current: string | null = null;
	for (const l of lines) {
		if (l.w === current) continue;
		if (current !== null) finished.add(current);
		if (finished.has(l.w)) bad.add(l.w);
		current = l.w;
	}
	return [...bad];
}
