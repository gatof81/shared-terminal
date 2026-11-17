/**
 * projects/conversation/queue.ts — the one queue of `queued` deliveries
 * (docs/PROJECT_CONVERSATION.md §3.6, §7.5).
 *
 * A delivery waits here until its recipient is free, whoever authorized it:
 * the person (`whenFree`, §3.6) or a D3 grant (a relay, §7.5). The queue is
 * the log — `delivery{queued}` lines — and this module only decides WHEN
 * each one is attempted:
 *
 *   one line per recipient   the queued deliveries of an agent are attempted
 *                            oldest first (by seq), one at a time, across
 *                            sources: a message never overtakes an older one
 *                            that is still waiting for the same agent.
 *   independent recipients   a busy agent never holds another agent's line.
 *
 * What an attempt DOES is the source's business (`attempt`): its own
 * authorization, limits and ends, and then the same S2–S4 as every delivery
 * (fanout.deliver) — intent on disk before the effect, one Composer call at
 * most, nothing retried. Nothing here is a correctness property held in
 * memory: the indexes are caches of the log, rebuilt from it at start, and
 * every attempt re-reads the log under the lock.
 */

import { randomUUID } from "node:crypto";
import type { ArtifactRef } from "./artifacts.js";
import { composeText } from "./artifacts.js";
import { BINDING_READ_MS, type ProjectBindings, type ProjectFanout } from "./fanout.js";
import { type DeliveryFold, deliveryKey, type Folded } from "./fold.js";
import { grantIdOf } from "./grantRules.js";
import type { LogLine } from "./log.js";
import type { ProjectConversationStore } from "./store.js";

/** The gate is re-evaluated at least this often while something is queued. */
export const GATE_INTERVAL_MS = 30_000;
/** §3.6: a message of the person that waited this long is closed `wait-expired`. */
export const OWNER_QUEUE_WAIT_MS = 24 * 60 * 60_000;

/** §3.6: how long a refusal that says "not now" keeps its recipient's line waiting. */
export const REFUSED_HOLD_MS = 10 * 60_000;
/** §3.6: past this, a result nobody settled or marked done stops holding the line. */
export const LINE_HOLD_MAX_MS = 24 * 60 * 60_000;

/** Composer refusals that describe the moment, not something a person has to look at. */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set(["busy", "rate-limited", "shutting-down"]);

/**
 * §3.6 "la fila se detiene": the delivery that keeps an agent's queued
 * deliveries waiting, or null.
 *
 * The gate only knows what the capture says about the recipient. After a
 * delivery whose effect on the pane is not known to be clean, that is not
 * enough: the Composer's pane record may still be unreleased, or text may sit
 * in the input, and every message behind it would leave the queue only to be
 * `refused` — final, and the person would have to write each one again. So
 * the line is judged on the LAST delivery that left for this agent (from the
 * queue or sent directly, of any source):
 *
 *   in flight                          hold: one at a time;
 *   delivered, settled as delivered    open;
 *   or resolved by an admin
 *   refused "not now" (busy, …)        hold for REFUSED_HOLD_MS — longer than
 *                                      the silence sweep needs to correct a
 *                                      stale `waiting_input` (CONVERSATION.md §5.3);
 *   anything else                      hold until the Composer's evidence
 *                                      settles it clean, the person marks it
 *                                      done (`owner_ack`) or resumes the
 *                                      consult it paused, a later delivery to
 *                                      the agent is delivered, or 24 h pass.
 *
 * Pure, from the log: nothing is written while a line is held, and what is
 * queued behind it stays cancellable and keeps its own expiry.
 */
export function lineHold(state: Folded, agentId: string, nowMs: number): DeliveryFold | null {
	let last: DeliveryFold | undefined;
	for (const d of state.deliveries.values()) {
		// `not-sent` never reached the Composer: it says nothing about the pane.
		if (d.agentId !== agentId || d.state === "queued" || d.state === "not-sent") continue;
		if (!last || d.lastSeq > last.lastSeq) last = d;
	}
	if (!last) return null;
	if (last.state === "planned" || last.state === "placing" || last.state === "sending") return last;
	if (last.state === "delivered") return null;
	if (last.state === "settled" && (last.result === "delivered" || last.result === "resolved"))
		return null;
	// The person looked at it: resumed the consult it paused (§7.6), or marked it done.
	const grant = state.grants.get(grantIdOf(last.authorizedBy) ?? "");
	if (grant?.personResumedSeq !== undefined && grant.personResumedSeq > last.lastSeq) return null;
	for (const a of state.acks.values()) {
		const t = a.target as { msg_id?: string; agent_id?: string } | undefined;
		if (t?.msg_id === last.msgId && (t.agent_id === undefined || t.agent_id === agentId))
			return null;
	}
	const age = nowMs - Date.parse(last.lastAt);
	const limit =
		last.state === "refused" && TRANSIENT_REFUSALS.has(last.reason ?? "")
			? REFUSED_HOLD_MS
			: LINE_HOLD_MAX_MS;
	return age >= limit ? null : last;
}

export type RecipientState =
	| { kind: "ready"; cid: string }
	| { kind: "busy"; cid: string }
	| { kind: "none" }
	| { kind: "ambiguous" };

/**
 * What one attempt left behind:
 *   done   the delivery is no longer queued (sent, or closed);
 *   wait   still queued because of its RECIPIENT (busy, absent, binding not
 *          readable, its line held by an earlier delivery — `lineHold`):
 *          younger deliveries to that agent wait behind it;
 *   skip   still queued for a reason of its own (a paused grant): it does
 *          not hold the agent's line.
 */
export type Attempt = "done" | "wait" | "skip";

export interface QueueDeps {
	store: ProjectConversationStore;
	/** Capture events of any session: only a hint to re-evaluate the gate. */
	onCaptureEvent(listener: (sid: string) => void): () => void;
	/** The source's own attempt, chosen by the delivery's `authorized_by`. */
	attempt(
		projectId: string,
		d: { msgId: string; agentId: string; authorizedBy: string },
	): Promise<Attempt>;
	gateIntervalMs?: number;
	log?: { warn(m: string): void };
}

export class DeliveryQueue {
	/** Project → queued delivery key → the session it waits for. A cache of the log. */
	private readonly queued = new Map<string, Map<string, string>>();
	private readonly draining = new Map<string, { again: boolean }>();
	/** `${project}/${agent}` lines being walked. */
	private readonly walking = new Set<string>();
	private unsubs: Array<() => void> = [];
	private interval: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(private readonly deps: QueueDeps) {}

	/** After the store opened its projects (boot recovery already written). */
	async start(projectIds: readonly string[]): Promise<void> {
		this.unsubs.push(this.deps.store.onAppend((pid, lines) => this.onAppend(pid, lines)));
		this.unsubs.push(
			this.deps.onCaptureEvent((sid) => {
				for (const [pid, keys] of this.queued) {
					for (const s of keys.values()) {
						if (s === sid) {
							this.kick(pid);
							break;
						}
					}
				}
			}),
		);
		for (const pid of projectIds) {
			try {
				const { state } = await this.deps.store.view(pid);
				for (const d of state.deliveries.values()) {
					if (d.state === "queued") this.note(pid, d.msgId, d.agentId, d.binding?.sid ?? "");
				}
				this.kick(pid);
			} catch (err) {
				this.warn(`${pid}: queue not resumed`, err);
			}
		}
		this.interval = setInterval(() => {
			for (const pid of this.queued.keys()) this.kick(pid);
		}, this.deps.gateIntervalMs ?? GATE_INTERVAL_MS);
		this.interval.unref?.();
	}

	stop(): void {
		this.stopped = true;
		for (const u of this.unsubs) u();
		this.unsubs = [];
		clearInterval(this.interval);
	}

	private note(pid: string, msgId: string, agentId: string, sid: string | null): void {
		const key = deliveryKey(msgId, agentId);
		let keys = this.queued.get(pid);
		if (sid !== null) {
			if (!keys) {
				keys = new Map();
				this.queued.set(pid, keys);
			}
			keys.set(key, sid);
		} else if (keys) {
			keys.delete(key);
			if (keys.size === 0) this.queued.delete(pid);
		}
	}

	/** Synchronous, inside the append: caches and scheduling only. */
	private onAppend(pid: string, lines: readonly LogLine[]): void {
		if (this.stopped) return;
		let kick = false;
		for (const l of lines) {
			// The person marking a delivery done may open the line it held.
			if (l.ev === "owner_ack") kick = true;
			if (l.ev !== "delivery") continue;
			const queued = l.state === "queued";
			const sid = (l.binding as { sid?: string } | undefined)?.sid ?? "";
			this.note(pid, l.msg_id as string, l.agent_id as string, queued ? sid : null);
			// A new arrival, and anything that may have freed an agent's line.
			kick = true;
		}
		if (kick && this.queued.has(pid)) setImmediate(() => this.kick(pid));
	}

	/** Nothing is being drained or attempted right now (tests wait on it). */
	get idle(): boolean {
		return this.draining.size === 0 && this.walking.size === 0;
	}

	/** Single-flight per project; a kick during a drain runs one more pass. */
	kick(projectId: string): void {
		if (this.stopped) return;
		const cur = this.draining.get(projectId);
		if (cur) {
			cur.again = true;
			return;
		}
		const slot = { again: false };
		this.draining.set(projectId, slot);
		void (async () => {
			try {
				do {
					slot.again = false;
					await this.drain(projectId);
				} while (slot.again && !this.stopped);
			} catch (err) {
				this.warn(`drain ${projectId}`, err);
			} finally {
				this.draining.delete(projectId);
			}
		})();
	}

	private async drain(projectId: string): Promise<void> {
		const agents = await this.deps.store.critical(projectId, async (tx) => {
			const set = new Set<string>();
			for (const d of tx.state.deliveries.values()) if (d.state === "queued") set.add(d.agentId);
			return [...set];
		});
		for (const agentId of agents) {
			const line = `${projectId}/${agentId}`;
			if (this.walking.has(line)) continue;
			this.walking.add(line);
			// Not awaited as a group: each agent's line is walked on its own.
			void this.walk(projectId, agentId)
				.catch((err) => this.warn(`line ${line}`, err))
				.finally(() => this.walking.delete(line));
		}
	}

	/** One agent's line, oldest first, until one of its deliveries has to wait for the agent. */
	private async walk(projectId: string, agentId: string): Promise<void> {
		const skipped = new Set<string>();
		while (!this.stopped) {
			// Re-read every round: a cancel, an end or a new arrival changes the line.
			const head = await this.deps.store.critical(projectId, async (tx) => {
				let first: { msgId: string; authorizedBy: string; seq: number } | null = null;
				for (const d of tx.state.deliveries.values()) {
					if (d.state !== "queued" || d.agentId !== agentId) continue;
					if (skipped.has(d.msgId)) continue;
					if (!first || d.lastSeq < first.seq)
						first = { msgId: d.msgId, authorizedBy: d.authorizedBy ?? "", seq: d.lastSeq };
				}
				return first;
			});
			if (!head) return;
			const r = await this.deps.attempt(projectId, { ...head, agentId });
			if (r === "wait") return;
			// `done` that left it queued would loop forever: treat as skipped too.
			skipped.add(head.msgId);
		}
	}

	private warn(what: string, err: unknown): void {
		this.deps.log?.warn(`[queue] ${what}: ${(err as Error).message}`);
	}
}

// ── The person's own queued messages (§3.6) ─────────────────────────────────

export interface OwnerQueueDeps {
	store: ProjectConversationStore;
	fanout: Pick<ProjectFanout, "deliver">;
	/** One uncached D1 read (the fan-out's own). */
	bindings(ownerId: string, projectId: string): Promise<ProjectBindings | null>;
	recipient(sid: string): Promise<RecipientState>;
	now?: () => number;
	log?: { warn(m: string): void };
}

/**
 * One attempt of a delivery the person queued with `whenFree`. Its binding
 * was fixed when it was queued; here it is compared with D1 again, the
 * recipient is asked, and only then `queued → planned` is written and the
 * ordinary S2–S4 runs. Every close before that is a `not-sent`: nothing
 * reached the agent.
 */
export async function attemptOwnerDelivery(
	deps: OwnerQueueDeps,
	projectId: string,
	msgId: string,
	agentId: string,
): Promise<Attempt> {
	const now = () => (deps.now ?? Date.now)();
	const key = deliveryKey(msgId, agentId);
	const snap = await deps.store.critical(projectId, async (tx) => {
		const d = tx.state.deliveries.get(key);
		const m = tx.state.messages.get(msgId);
		if (!d || d.state !== "queued" || d.authorizedBy !== "owner" || !m?.by || !d.binding)
			return null;
		return {
			by: m.by,
			text: m.text ?? "",
			refs: (m.artifacts ?? []) as ArtifactRef[],
			fixed: d.binding,
			queuedAt: Date.parse(d.queuedAt ?? ""),
			held: lineHold(tx.state, agentId, now()) !== null,
		};
	});
	if (!snap) return "done";
	const close = async (reason: string): Promise<Attempt> => {
		try {
			await deps.store.critical(projectId, async (tx) => {
				if (tx.state.deliveries.get(key)?.state !== "queued") return;
				await tx.append(
					[
						{
							ev: "delivery",
							msg_id: msgId,
							agent_id: agentId,
							state: "not-sent",
							reason,
							authorized_by: "owner",
						},
					],
					{ allowMargin: true },
				);
			});
		} catch (err) {
			// Poisoned or lock lost: it stays queued on disk and nothing is sent.
			deps.log?.warn(`[queue] close ${key}: ${(err as Error).message}`);
			return "wait";
		}
		return "done";
	};
	if (Number.isFinite(snap.queuedAt) && now() - snap.queuedAt > OWNER_QUEUE_WAIT_MS)
		return close("wait-expired");

	let timer: NodeJS.Timeout | undefined;
	const b = await Promise.race([
		deps.bindings(snap.by, projectId).catch(() => undefined),
		new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), BINDING_READ_MS);
		}),
	]);
	clearTimeout(timer);
	if (b === undefined) return "wait"; // unverified: tried again
	const cur = b?.get(agentId);
	if (
		!b ||
		!cur ||
		cur.removed ||
		!cur.binding ||
		cur.binding.bindingId !== snap.fixed.binding_id ||
		cur.binding.epoch !== snap.fixed.epoch ||
		cur.binding.sessionId !== snap.fixed.sid
	) {
		// Never redirected to whatever the agent is bound to now (§3.6).
		return close("binding-changed");
	}
	if (snap.held) return "wait";
	const r = await deps.recipient(snap.fixed.sid).catch(() => ({ kind: "none" }) as const);
	if (r.kind === "busy" || r.kind === "none") return "wait";
	if (r.kind === "ambiguous") return close("ambiguous-target");

	let planned: LogLine | undefined;
	let held = false;
	try {
		await deps.store.critical(projectId, async (tx) => {
			// A cancel written before this line wins.
			if (tx.state.deliveries.get(key)?.state !== "queued") return;
			// So does a result that landed since the snapshot (a direct send's).
			held = lineHold(tx.state, agentId, now()) !== null;
			if (held) return;
			[planned] = await tx.append(
				[
					{
						ev: "delivery",
						msg_id: msgId,
						agent_id: agentId,
						state: "planned",
						binding: { ...snap.fixed, cid: r.cid },
						composer_client_message_id: randomUUID(),
						authorized_by: "owner",
					},
				],
				{ allowMargin: true },
			);
		});
	} catch (err) {
		deps.log?.warn(`[queue] plan ${key}: ${(err as Error).message}`);
		return "wait";
	}
	if (!planned) return held ? "wait" : "done";
	await deps.fanout.deliver(
		snap.by,
		projectId,
		msgId,
		agentId,
		planned,
		composeText(snap.text, snap.refs),
		snap.refs,
		new Map(),
		{ authorizedBy: "owner" },
	);
	return "done";
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/**
 * The queue with its two sources: the person's `whenFree` deliveries, and —
 * when D3 is on — the relays of `collab()`. A relay found queued while D3 is
 * off (left by a run that had it on) waits untouched.
 */
export function createDeliveryQueue(
	deps: OwnerQueueDeps & {
		onCaptureEvent: QueueDeps["onCaptureEvent"];
		collab?: () =>
			| { attempt(pid: string, msgId: string, agentId: string): Promise<Attempt> }
			| undefined;
		gateIntervalMs?: number;
	},
): DeliveryQueue {
	return new DeliveryQueue({
		store: deps.store,
		onCaptureEvent: deps.onCaptureEvent,
		gateIntervalMs: deps.gateIntervalMs,
		log: deps.log,
		attempt: (pid, d) => {
			if (d.authorizedBy === "owner") return attemptOwnerDelivery(deps, pid, d.msgId, d.agentId);
			const c = deps.collab?.();
			return c ? c.attempt(pid, d.msgId, d.agentId) : Promise.resolve("skip");
		},
	});
}
