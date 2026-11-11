/**
 * projects/conversation/replies.ts — attributing a reply to a delivery
 * (docs/PROJECT_CONVERSATION.md §4.1) and settling an `uncertain` one from
 * the Composer's own evidence (§3.1).
 *
 * For each delivered delivery it follows the capture of `(sid, cid)` from
 * the acknowledged prompt P on. Nothing here sends, and nothing here copies
 * the agent's text into the project log: a `reply_ref` holds a hash and a
 * seq range.
 *
 *   waiting  — until the first close with P. Anything that §4.1 lists as
 *              breaking attribution (another prompt, a close with another or
 *              no prompt id, a gap, P not new) is remembered as a violation.
 *   settling — `turn_end` with P seen: write `reply_settling`, wait
 *              T_SETTLE = 10 s from its receipt (CONVERSATION.md §4.6's
 *              repeated-Stop window), watching for the same violations plus a
 *              second close with P. Then write `reply_ref`, `exact` only if
 *              nothing broke it AND this process observed the whole window:
 *              a `turn_end` received before this process started (found when
 *              catching up from the file) is `ambiguous{settle-unobserved}`.
 *   after    — a later close with P is `reply_late_close`, until the next
 *              prompt (a new turn) or LATE_WINDOW_MS.
 *
 * Every write goes through `store.critical` and checks the folded state
 * first, so a watch resumed after a restart never writes twice.
 *
 * Live events can arrive while a watch catches up from the file; they are
 * queued and applied after it, deduplicated by capture seq — the same rule
 * as conversation/ws.ts.
 */

import { createHash } from "node:crypto";
import type { PersistedEvent } from "../../conversation/store.js";
import type { DeliveredRef } from "./fanout.js";
import { deliveryKey, type Folded } from "./fold.js";
import type { ProjectConversationStore } from "./store.js";

export const T_SETTLE_MS = 10_000;
export const LATE_WINDOW_MS = 30 * 60_000;

const PROMPTS = new Set(["user_prompt", "internal_prompt"]);
const CLOSES = new Set(["turn_end", "turn_failed"]);

export interface ReplyDeps {
	store: ProjectConversationStore;
	onCaptureEvent(listener: (sid: string, cid: string, ev: PersistedEvent) => void): () => void;
	/** Capture events with seq > after, ascending, rotated generation included. */
	readCapture(sid: string, cid: string, after: number): Promise<PersistedEvent[]>;
	/** When this process started: a capture event received before it was not observed live. */
	bootAt: number;
	now?: () => number;
	settleMs?: number;
	log?: { warn(m: string): void };
}

type Phase = "catching-up" | "waiting" | "settling" | "after" | "done";

interface Watch {
	kind: "reply";
	ref: DeliveredRef;
	phase: Phase;
	violation: string | null;
	lastSeq: number;
	queue: PersistedEvent[];
	turnEnd?: PersistedEvent;
	timer?: NodeJS.Timeout;
	lateUntil?: number;
}

interface Settle {
	kind: "settle";
	projectId: string;
	msgId: string;
	agentId: string;
	sid: string;
	cid: string;
	ccmid: string;
	phase: "catching-up" | "live" | "done";
	queue: PersistedEvent[];
	lastSeq: number;
}

const COMPOSER_FINAL = new Set(["delivered", "unconfirmed", "misdelivered", "failed", "resolved"]);

export class ReplyWatcher {
	private readonly byConv = new Map<string, Array<Watch | Settle>>();
	private readonly unlisten: () => void;
	private stopped = false;

	constructor(private readonly deps: ReplyDeps) {
		this.unlisten = deps.onCaptureEvent((sid, cid, ev) => this.onEvent(sid, cid, ev));
	}

	stop(): void {
		this.stopped = true;
		this.unlisten();
		for (const list of this.byConv.values()) {
			for (const w of list) if (w.kind === "reply" && w.timer) clearTimeout(w.timer);
		}
		this.byConv.clear();
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private add(sid: string, cid: string, w: Watch | Settle): void {
		const key = `${sid}/${cid}`;
		const list = this.byConv.get(key) ?? [];
		list.push(w);
		this.byConv.set(key, list);
	}

	private remove(sid: string, cid: string, w: Watch | Settle): void {
		const key = `${sid}/${cid}`;
		const list = (this.byConv.get(key) ?? []).filter((x) => x !== w);
		if (list.length === 0) this.byConv.delete(key);
		else this.byConv.set(key, list);
	}

	/** A delivery the Composer acknowledged: follow its reply. */
	watch(ref: DeliveredRef): void {
		if (this.stopped) return;
		const w: Watch = {
			kind: "reply",
			ref,
			phase: "catching-up",
			violation: null,
			lastSeq: 0,
			queue: [],
		};
		this.add(ref.sid, ref.cid, w);
		void this.catchUp(w);
	}

	/** An `uncertain` delivery: settle it from the capture's `composer_send` evidence only (§3.1). */
	watchUncertain(s: Omit<Settle, "kind" | "phase" | "queue" | "lastSeq">): void {
		if (this.stopped) return;
		const w: Settle = { ...s, kind: "settle", phase: "catching-up", queue: [], lastSeq: 0 };
		this.add(s.sid, s.cid, w);
		void (async () => {
			try {
				const evs = await this.deps.readCapture(s.sid, s.cid, 0);
				for (const ev of evs) await this.applySettle(w, ev);
				w.phase = w.phase === "done" ? "done" : "live";
				for (const ev of w.queue.splice(0)) await this.applySettle(w, ev);
			} catch (err) {
				this.deps.log?.warn(
					`[projects] settle watch ${s.msgId}/${s.agentId}: ${(err as Error).message}`,
				);
				this.remove(s.sid, s.cid, w);
			}
		})();
	}

	/** Boot: resume every delivery of a project whose outcome is still being decided. */
	async resume(projectId: string): Promise<void> {
		const { state } = await this.deps.store.view(projectId);
		for (const d of state.deliveries.values()) {
			if (!d.binding) continue;
			const key = deliveryKey(d.msgId, d.agentId);
			const delivered =
				d.state === "delivered" || (d.state === "settled" && d.result === "delivered");
			if (delivered && d.promptId && d.ackSeq !== undefined && !state.replyRefs.has(key)) {
				this.watch({
					projectId,
					msgId: d.msgId,
					agentId: d.agentId,
					sid: d.binding.sid,
					cid: d.binding.cid,
					promptId: d.promptId,
					ackSeq: d.ackSeq,
				});
			} else if (d.state === "uncertain" && d.sent && d.composerClientMessageId) {
				this.watchUncertain({
					projectId,
					msgId: d.msgId,
					agentId: d.agentId,
					sid: d.binding.sid,
					cid: d.binding.cid,
					ccmid: d.composerClientMessageId,
				});
			}
		}
	}

	private onEvent(sid: string, cid: string, ev: PersistedEvent): void {
		const list = this.byConv.get(`${sid}/${cid}`);
		if (!list) return;
		for (const w of [...list]) {
			if (w.phase === "catching-up") {
				w.queue.push(ev);
				continue;
			}
			if (w.kind === "reply") void this.apply(w, ev);
			else void this.applySettle(w, ev);
		}
	}

	private async catchUp(w: Watch): Promise<void> {
		try {
			// From the start of the file: condition 1 (P is new) looks before the ack.
			const evs = await this.deps.readCapture(w.ref.sid, w.ref.cid, 0);
			for (const ev of evs) {
				if (ev.seq < w.ref.ackSeq) {
					if (PROMPTS.has(ev.ev) && ev.prompt_id === w.ref.promptId) w.violation ??= "queued";
					w.lastSeq = ev.seq;
					continue;
				}
				if (w.phase === "catching-up") w.phase = "waiting";
				await this.apply(w, ev);
			}
			if (w.phase === "catching-up") w.phase = "waiting";
			for (const ev of w.queue.splice(0)) await this.apply(w, ev);
		} catch (err) {
			this.deps.log?.warn(
				`[projects] reply watch ${w.ref.msgId}/${w.ref.agentId}: ${(err as Error).message}`,
			);
			this.remove(w.ref.sid, w.ref.cid, w);
		}
	}

	/** Applies one capture event, in seq order, at most once. */
	private async apply(w: Watch, ev: PersistedEvent): Promise<void> {
		if (ev.seq <= w.lastSeq || w.phase === "done") return;
		w.lastSeq = ev.seq;
		if (ev.seq <= w.ref.ackSeq) return; // the acknowledged prompt itself
		const P = w.ref.promptId;
		const isPrompt = PROMPTS.has(ev.ev);
		const isClose = CLOSES.has(ev.ev);
		const withP = ev.prompt_id === P;

		if (w.phase === "after") {
			if (isPrompt || (w.lateUntil !== undefined && this.now() > w.lateUntil)) {
				this.finish(w);
				return;
			}
			if (isClose && withP) {
				await this.write(w.ref.projectId, (st) =>
					st.lateCloses.has(`${w.ref.msgId}/${w.ref.agentId}/${ev.seq}`)
						? null
						: {
								ev: "reply_late_close",
								msg_id: w.ref.msgId,
								agent_id: w.ref.agentId,
								prompt_id: P,
								capture_seq: ev.seq,
							},
				);
			}
			return;
		}

		if (w.phase === "settling") {
			if (isClose && withP) w.violation ??= "second-close";
			else if (isPrompt || isClose) w.violation ??= "mixed-input";
			else if (ev.ev === "gap") w.violation ??= "gap";
			return;
		}

		// waiting
		if (isPrompt) {
			w.violation ??= "mixed-input";
			return;
		}
		if (ev.ev === "gap") {
			w.violation ??= "gap";
			return;
		}
		if (!isClose) return;
		if (!withP) {
			w.violation ??= "mixed-input";
			return;
		}
		if (ev.ev === "turn_failed") {
			await this.writeRef(w, ev, "failed");
			this.finish(w);
			return;
		}
		// turn_end with P: the settle window starts at its receipt by the backend.
		w.turnEnd = ev;
		const received = Date.parse(ev.ts);
		const settleMs = this.deps.settleMs ?? T_SETTLE_MS;
		const until = received + settleMs;
		await this.write(w.ref.projectId, (st) =>
			st.settling.has(deliveryKey(w.ref.msgId, w.ref.agentId)) ||
			st.replyRefs.has(deliveryKey(w.ref.msgId, w.ref.agentId))
				? null
				: {
						ev: "reply_settling",
						...this.refFields(w, ev),
						settle_until: new Date(until).toISOString(),
					},
		);
		// The capture stamps an event when the backend receives it: one stamped
		// before this process started was received by a previous one, so the
		// window was not observed whole here — never exact (§4.1). Whether this
		// watch saw it live or read it from the file does not matter: every
		// event of the window is in the file and is applied either way.
		if (!(received >= this.deps.bootAt)) {
			await this.writeRef(w, ev, "ambiguous{settle-unobserved}");
			this.toAfter(w);
			return;
		}
		w.phase = "settling";
		w.timer = setTimeout(
			() => {
				void (async () => {
					if (w.phase !== "settling" || this.stopped) return;
					await this.writeRef(w, ev, w.violation ? `ambiguous{${w.violation}}` : "exact");
					this.toAfter(w);
				})();
			},
			Math.max(0, until - this.now()),
		);
	}

	private toAfter(w: Watch): void {
		w.phase = "after";
		w.lateUntil = this.now() + LATE_WINDOW_MS;
	}

	private finish(w: Watch): void {
		w.phase = "done";
		if (w.timer) clearTimeout(w.timer);
		this.remove(w.ref.sid, w.ref.cid, w);
	}

	private refFields(w: Watch, close: PersistedEvent): Record<string, unknown> {
		const report =
			typeof close.data?.last_assistant_message === "string"
				? close.data.last_assistant_message
				: null;
		return {
			msg_id: w.ref.msgId,
			agent_id: w.ref.agentId,
			sid: w.ref.sid,
			cid: w.ref.cid,
			prompt_id: w.ref.promptId,
			seq_from: w.ref.ackSeq,
			seq_to: close.seq,
			turn_end_seq: close.seq,
			report_sha256:
				report === null ? null : createHash("sha256").update(report, "utf8").digest("hex"),
			report_bytes: report === null ? 0 : Buffer.byteLength(report, "utf8"),
			truncated: close.data?.truncated === true,
		};
	}

	private async writeRef(w: Watch, close: PersistedEvent, attribution: string): Promise<void> {
		await this.write(w.ref.projectId, (st) =>
			st.replyRefs.has(deliveryKey(w.ref.msgId, w.ref.agentId))
				? null
				: { ev: "reply_ref", ...this.refFields(w, close), attribution },
		);
	}

	private async applySettle(w: Settle, ev: PersistedEvent): Promise<void> {
		if (w.phase === "done" || ev.seq <= w.lastSeq) return;
		w.lastSeq = ev.seq;
		if (ev.ev !== "composer_send") return;
		const d = ev.data ?? {};
		if (d.client_message_id !== w.ccmid) return;
		const state = typeof d.state === "string" ? d.state : "";
		if (!COMPOSER_FINAL.has(state)) return;
		const promptId = typeof d.prompt_id === "string" ? d.prompt_id : (ev.prompt_id ?? undefined);
		const seq = typeof d.seq === "number" ? d.seq : undefined;
		const result =
			state === "resolved" ? (typeof d.outcome === "string" ? d.outcome : "resolved") : state;
		const written = await this.write(w.projectId, (st) => {
			const cur = st.deliveries.get(deliveryKey(w.msgId, w.agentId));
			if (!cur || cur.state !== "uncertain") return null;
			return {
				ev: "delivery",
				msg_id: w.msgId,
				agent_id: w.agentId,
				state: "settled",
				result,
				http: {
					status: 202,
					result,
					...(promptId ? { promptId } : {}),
					...(seq !== undefined ? { seq } : {}),
				},
				evidence: { capture_seq: ev.seq },
				authorized_by: "owner",
			};
		});
		w.phase = "done";
		this.remove(w.sid, w.cid, w);
		if (written && result === "delivered" && promptId && seq !== undefined) {
			this.watch({
				projectId: w.projectId,
				msgId: w.msgId,
				agentId: w.agentId,
				sid: w.sid,
				cid: w.cid,
				promptId,
				ackSeq: seq,
			});
		}
	}

	/** One critical section; `build` decides from the folded state whether anything is still to write. */
	private async write(
		projectId: string,
		build: (st: Folded) => Record<string, unknown> | null,
	): Promise<boolean> {
		try {
			return await this.deps.store.critical(projectId, async (tx) => {
				const ev = build(tx.state);
				if (!ev) return false;
				await tx.append([ev as { ev: string } & Record<string, unknown>], { allowMargin: true });
				return true;
			});
		} catch (err) {
			this.deps.log?.warn(
				`[projects] ${projectId}: reply record not written (${(err as Error).message})`,
			);
			return false;
		}
	}
}
