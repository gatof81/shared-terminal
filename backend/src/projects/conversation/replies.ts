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
 *              T_SETTLE = 10 s (CONVERSATION.md §4.6's repeated-Stop
 *              window), watching for the same violations plus a second close
 *              with P. Then write `reply_ref`, `exact` only if nothing broke
 *              it AND this process observed the whole window: the window is
 *              measured on the MONOTONIC clock from the moment this process
 *              saw the `turn_end` live, never from wall-clock stamps, so a
 *              jump of the system clock can only lengthen it. A `turn_end`
 *              this process did not see live (received before it started)
 *              is `ambiguous{settle-unobserved}`.
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
/** How long an uncertain delivery is watched for the Composer's own evidence. */
export const SETTLE_WATCH_MS = 24 * 60 * 60_000;
/**
 * Condition 1 (P is new) only needs the prompts just before the ack: a
 * queued input is announced with the CURRENT turn's prompt id, i.e. a few
 * events back. Reading from here instead of from 0 bounds the catch-up.
 */
export const PRE_ACK_SCAN = 2_000;
/**
 * How many live `turn_end` sightings the watcher remembers (all
 * conversations). A watch starts after the Composer's ack and S4, so a fast
 * turn can end before it exists; the sighting is kept here, not per watch.
 * Evicting one only makes that reply `settle-unobserved` (fail closed).
 */
export const LIVE_SIGHTINGS_MAX = 4_096;

const PROMPTS = new Set(["user_prompt", "internal_prompt"]);
const CLOSES = new Set(["turn_end", "turn_failed"]);

export interface ReplyDeps {
	store: ProjectConversationStore;
	onCaptureEvent(listener: (sid: string, cid: string, ev: PersistedEvent) => void): () => void;
	/** Capture events with seq > after, ascending, rotated generation included. */
	readCapture(sid: string, cid: string, after: number): Promise<PersistedEvent[]>;
	/** When this process started: a capture event received before it was not observed live. */
	bootAt: number;
	/** Wall clock: only for stamps written to the log. */
	now?: () => number;
	/** Monotonic clock (ms): the settle and late windows are measured on it alone. */
	monoNow?: () => number;
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
	/** Every step of this watch runs on this chain: never two at once (an
	 *  await inside one step must not let the next event see a stale phase). */
	chain: Promise<void>;
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
	chain: Promise<void>;
	timer?: NodeJS.Timeout;
}

const COMPOSER_FINAL = new Set(["delivered", "unconfirmed", "misdelivered", "failed", "resolved"]);

export class ReplyWatcher {
	private readonly byConv = new Map<string, Array<Watch | Settle>>();
	/** Monotonic time at which this process saw each `turn_end` live, by `sid/cid/seq`. */
	private readonly liveAt = new Map<string, number>();
	private readonly unlisten: () => void;
	private stopped = false;
	/** Catch-up reads load a capture file each; one at a time bounds memory. */
	private reads: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: ReplyDeps) {
		this.unlisten = deps.onCaptureEvent((sid, cid, ev) => this.onEvent(sid, cid, ev));
	}

	stop(): void {
		this.stopped = true;
		this.unlisten();
		for (const list of this.byConv.values()) {
			for (const w of list) if (w.timer) clearTimeout(w.timer);
		}
		this.byConv.clear();
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private mono(): number {
		return (this.deps.monoNow ?? (() => performance.now()))();
	}

	private step(w: Watch | Settle, fn: () => Promise<void>): void {
		w.chain = w.chain.then(fn).catch((err) => {
			this.deps.log?.warn(`[projects] reply watch step failed: ${(err as Error).message}`);
		});
	}

	private read(sid: string, cid: string, after: number): Promise<PersistedEvent[]> {
		const r = this.reads.then(() => this.deps.readCapture(sid, cid, after));
		this.reads = r.catch(() => {});
		return r;
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
			chain: Promise.resolve(),
		};
		this.add(ref.sid, ref.cid, w);
		this.step(w, () => this.catchUp(w));
	}

	/** An `uncertain` delivery: settle it from the capture's `composer_send` evidence only (§3.1). */
	watchUncertain(
		s: Omit<Settle, "kind" | "phase" | "queue" | "lastSeq" | "chain" | "timer">,
	): void {
		if (this.stopped) return;
		const w: Settle = {
			...s,
			kind: "settle",
			phase: "catching-up",
			queue: [],
			lastSeq: 0,
			chain: Promise.resolve(),
		};
		this.add(s.sid, s.cid, w);
		// Bounded: a send whose Composer operation never resolves is not
		// followed forever (the delivery simply stays uncertain).
		w.timer = setTimeout(() => {
			w.phase = "done";
			this.remove(s.sid, s.cid, w);
		}, SETTLE_WATCH_MS);
		w.timer.unref?.();
		this.step(w, async () => {
			try {
				const evs = await this.read(s.sid, s.cid, 0);
				for (const ev of evs) await this.applySettle(w, ev);
				while (w.queue.length > 0) await this.applySettle(w, w.queue.shift() as PersistedEvent);
				if (w.phase !== "done") w.phase = "live";
			} catch (err) {
				this.deps.log?.warn(
					`[projects] settle watch ${s.msgId}/${s.agentId}: ${(err as Error).message}`,
				);
				this.remove(s.sid, s.cid, w);
			}
		});
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
		// Stamped on arrival, whether or not a watch exists yet or is catching
		// up: the watch may apply the file copy (same seq) later.
		if (ev.ev === "turn_end") {
			const k = `${sid}/${cid}/${ev.seq}`;
			if (!this.liveAt.has(k)) {
				this.liveAt.set(k, this.mono());
				if (this.liveAt.size > LIVE_SIGHTINGS_MAX) {
					this.liveAt.delete(this.liveAt.keys().next().value as string);
				}
			}
		}
		const list = this.byConv.get(`${sid}/${cid}`);
		if (!list) return;
		for (const w of [...list]) {
			if (w.phase === "catching-up") {
				w.queue.push(ev);
				continue;
			}
			if (w.kind === "reply") this.step(w, () => this.apply(w, ev));
			else this.step(w, () => this.applySettle(w, ev));
		}
	}

	private async catchUp(w: Watch): Promise<void> {
		try {
			// Condition 1 (P is new) looks a bounded stretch before the ack.
			const evs = await this.read(w.ref.sid, w.ref.cid, Math.max(0, w.ref.ackSeq - PRE_ACK_SCAN));
			for (const ev of evs) {
				if (ev.seq < w.ref.ackSeq) {
					if (PROMPTS.has(ev.ev) && ev.prompt_id === w.ref.promptId) w.violation ??= "queued";
					w.lastSeq = ev.seq;
					continue;
				}
				await this.apply(w, ev);
			}
			// Live events stay queued until the file AND the queue are applied;
			// the phase flips only when nothing is left (no await in between).
			while (w.queue.length > 0) await this.apply(w, w.queue.shift() as PersistedEvent);
			if (w.phase === "catching-up") w.phase = "waiting";
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
			if (isPrompt || (w.lateUntil !== undefined && this.mono() > w.lateUntil)) {
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
		// turn_end with P. The window starts when this process saw it live, on
		// the monotonic clock: that moment is at or after its receipt, so the
		// window observed here always covers the 10 s after the receipt. The
		// capture's `ts` and Date.now() are wall clock — a step of the system
		// clock (NTP, an operator) between the two would shorten the window
		// to nothing — so neither ever decides `exact`.
		w.turnEnd = ev;
		const seenAt = this.liveAt.get(`${w.ref.sid}/${w.ref.cid}/${ev.seq}`);
		const settleMs = this.deps.settleMs ?? T_SETTLE_MS;
		const remaining = seenAt === undefined ? 0 : Math.max(0, seenAt + settleMs - this.mono());
		await this.write(w.ref.projectId, (st) =>
			st.settling.has(deliveryKey(w.ref.msgId, w.ref.agentId)) ||
			st.replyRefs.has(deliveryKey(w.ref.msgId, w.ref.agentId))
				? null
				: {
						ev: "reply_settling",
						...this.refFields(w, ev),
						// Informational (wall clock); the window itself is monotonic.
						settle_until: new Date(this.now() + remaining).toISOString(),
					},
		);
		// Not seen live by this process ⇒ the window was not observed whole
		// here — never exact (§4.1). The wall-clock stamp is kept as a second,
		// fail-closed check: one before this process started is never exact
		// either (a clock stepped back can only make this stricter).
		if (seenAt === undefined || !(Date.parse(ev.ts) >= this.deps.bootAt)) {
			await this.writeRef(w, ev, "ambiguous{settle-unobserved}");
			this.toAfter(w);
			return;
		}
		w.phase = "settling";
		this.armSettle(w, ev, seenAt + settleMs);
	}

	/** `exact` is decided only once the monotonic clock is past `deadline`. */
	private armSettle(w: Watch, ev: PersistedEvent, deadline: number): void {
		w.timer = setTimeout(
			() =>
				this.step(w, async () => {
					if (w.phase !== "settling" || this.stopped) return;
					// A timer may fire a little early (rounding); never decide before the end.
					if (this.mono() < deadline) {
						this.armSettle(w, ev, deadline);
						return;
					}
					await this.writeRef(w, ev, w.violation ? `ambiguous{${w.violation}}` : "exact");
					this.toAfter(w);
				}),
			Math.max(0, Math.ceil(deadline - this.mono())),
		);
	}

	private toAfter(w: Watch): void {
		w.phase = "after";
		w.lateUntil = this.mono() + LATE_WINDOW_MS;
		if (w.timer) clearTimeout(w.timer);
		w.timer = setTimeout(() => this.step(w, async () => this.finish(w)), LATE_WINDOW_MS);
		w.timer.unref?.();
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
		if (w.timer) clearTimeout(w.timer);
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
