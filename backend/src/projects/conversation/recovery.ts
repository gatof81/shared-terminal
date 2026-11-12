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
 */

import { type Folded, isResultState } from "./fold.js";
import type { LogLine, NewEvent } from "./log.js";

export type RecoverySource =
	| { source: "boot" }
	| { source: "restore"; restoreId: string; manifestAt: string | null };

export function recoveryEvents(
	f: Folded,
	src: RecoverySource,
	ctx: { bootId: string; truncatedBytes: number; interleavedWriters: string[] },
): NewEvent[] {
	if (src.source === "restore" && f.restoresApplied.has(src.restoreId)) return [];
	const out: NewEvent[] = [];
	const orphaned: Array<{ msg_id: string; agent_id: string; as: string }> = [];
	for (const d of f.deliveries.values()) {
		if (isResultState(d.state)) continue;
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
		out.push(ev);
		orphaned.push({ msg_id: d.msgId, agent_id: d.agentId, as: `${ev.state}{${ev.reason}}` });
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
		// Grants exist from D3 on; with D1 alone there is nothing to close.
		grants_closed: [],
	};
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
