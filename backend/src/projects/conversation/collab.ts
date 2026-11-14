/**
 * projects/conversation/collab.ts — D3: a consult between two agents under a
 * grant the person gave with the task (docs/PROJECT_CONVERSATION.md §7).
 *
 * The grant is created by the fan-out (S1, fanout.ts). This module owns
 * everything after that:
 *
 *   admit    rules 6–8 of §7.3 — authorization, limits, idempotency — for a
 *            file whose event, origin, identity and bytes the caller already
 *            proved (outbox.ts). One critical section; a refusal is written
 *            as `outbox{rejected}`, bounded.
 *   queue    a relay waits in `queued` until its recipient is free (§7.5),
 *            then goes through the SAME S2–S4 as a delivery of the person
 *            (fanout.deliver): intent on disk before the effect, one
 *            Composer call at most, nothing retried.
 *   outcome  what a delivery's final state does to the grant (continue,
 *            pause, end) is written IN THE SAME APPEND as that final state
 *            (grantRules.ts `deliveryConsequence`, called by every writer
 *            of a result line). Only a `settled` — written by the reply
 *            watcher from the Composer's evidence — is followed up here,
 *            and at boot, because a lost follow-up of that one leaves the
 *            grant paused, never running.
 *   control  pause / resume / revoke / expiry.
 *
 * Nothing here trusts an agent's text. The body is carried, never
 * interpreted; a grant is only ever created, resumed or widened by the
 * person. And nothing here is a correctness property held in memory: the
 * indexes below are caches of the log, rebuilt from it at start, and every
 * decision is retaken from the folded state inside a critical section.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { HttpResult } from "../../conversation/composer.js";
import { normalizeText, validateText } from "../../conversation/composerText.js";
import { logErrorToHttp } from "./api.js";
import { type OutboxKind, type ParsedOutbox, relayText, shortMsgId } from "./collabText.js";
import { BINDING_READ_MS, type ProjectBindings, type ProjectFanout } from "./fanout.js";
import {
	deliveryKey,
	type Folded,
	type GrantFold,
	type GrantParticipant,
	grantAlive,
	outboxKey,
} from "./fold.js";
import {
	budgetSpent,
	collabOf,
	deliveryConsequence,
	endEvents,
	grantIdOf,
	mayPause,
	pauseEvent,
	pendingRelays,
} from "./grantRules.js";
import type { LogLine, NewEvent } from "./log.js";
import type { CriticalTx, ProjectConversationStore } from "./store.js";

/** §7.3: `outbox{rejected}` lines a grant may accumulate, and how many of one agent pause it. */
export const REJECTED_MAX_PER_GRANT = 8;
export const REJECTED_PAUSE_PER_AGENT = 3;
/** §7.5: `outbox{unverified}` lines a grant may accumulate. */
export const UNVERIFIED_MAX_PER_GRANT = 8;
/** §7.5: the gate is re-evaluated at least this often while something is queued. */
export const GATE_INTERVAL_MS = 30_000;

const GRANT_RE = /^c-[0-9a-f]{12}$/;

export type RecipientState =
	| { kind: "ready"; cid: string }
	| { kind: "busy"; cid: string }
	| { kind: "none" }
	| { kind: "ambiguous" };

export interface CollabDeps {
	store: ProjectConversationStore;
	fanout: Pick<ProjectFanout, "deliver">;
	/** One uncached D1 read (the fan-out's own). */
	bindings(ownerId: string, projectId: string): Promise<ProjectBindings | null>;
	/**
	 * The session's single interactive conversation with a pane, and whether
	 * the capture has it waiting for input (§7.5). More than one ⇒ ambiguous.
	 */
	recipient(sid: string): Promise<RecipientState>;
	/** Capture events of any session: only a hint to re-evaluate the gate. */
	onCaptureEvent(listener: (sid: string) => void): () => void;
	now?: () => number;
	gateIntervalMs?: number;
	log?: { info(m: string): void; warn(m: string): void };
}

export interface AdmitInput {
	projectId: string;
	grantId: string;
	/** The sender, as the caller verified it against D1 and the capture (§7.3 rule 3). */
	from: GrantParticipant & { cid: string };
	toolUseId: string | null;
	/** Workspace-relative, e.g. `.st-outbox/q1.md`. */
	path: string;
	/** Of the bytes read once (§7.3 rule 5); "" when the file could not be read (rule 4). */
	sha256: string;
	bytes: number;
	/** The header and body, or the reason rule 4 or the parser refused the file. */
	parsed: ParsedOutbox | { ok: false; reason: `file-${string}` };
}

export type AdmitResult =
	| { outcome: "accepted"; msgId: string; kind: OutboxKind }
	| { outcome: "rejected"; reason: string; written: boolean }
	| { outcome: "duplicate" }
	| { outcome: "ignored"; why: string };

export class ProjectCollab {
	/** Participant session → its live grant. A cache of the log (outbox.ts reads it). */
	private readonly bySession = new Map<
		string,
		{ projectId: string; grantId: string; agentId: string; consulted: boolean; createdAt: string }
	>();
	private readonly expiry = new Map<string, NodeJS.Timeout>();
	/** Projects with at least one queued relay, and the keys queued. */
	private readonly queued = new Map<string, Set<string>>();
	private readonly draining = new Map<string, { again: boolean }>();
	private readonly inFlight = new Set<string>();
	/** Projects whose log has a grant: the others pay nothing for D3. */
	private readonly withGrants = new Set<string>();
	private unsubs: Array<() => void> = [];
	private interval: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(private readonly deps: CollabDeps) {}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	/** After the store opened its projects (boot recovery already written). */
	async start(projectIds: readonly string[]): Promise<void> {
		this.unsubs.push(this.deps.store.onAppend((pid, lines) => this.onAppend(pid, lines)));
		this.unsubs.push(
			this.deps.onCaptureEvent((sid) => {
				const e = this.bySession.get(sid);
				if (e && this.queued.has(e.projectId)) this.kick(e.projectId);
			}),
		);
		for (const pid of projectIds) {
			try {
				const { state } = await this.deps.store.view(pid);
				if (state.grants.size > 0) this.withGrants.add(pid);
				for (const g of state.grants.values()) if (g.state !== "ended") this.index(pid, g);
				for (const d of state.deliveries.values()) {
					if (d.state === "queued" && grantIdOf(d.authorizedBy)) this.noteQueued(pid, d, true);
					// A `settled` whose follow-up the previous process did not write.
					if (d.state === "settled" && grantIdOf(d.authorizedBy)) {
						await this.outcome(pid, d.msgId, d.agentId);
					}
				}
				this.kick(pid);
			} catch (err) {
				this.deps.log?.warn(`[collab] ${pid}: not resumed (${(err as Error).message})`);
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
		for (const t of this.expiry.values()) clearTimeout(t);
		this.expiry.clear();
	}

	/** The live grant a session participates in, if any (§7.3 rule 3, first half). */
	grantOfSession(sid: string): { projectId: string; grantId: string; agentId: string } | null {
		return this.bySession.get(sid) ?? null;
	}

	// ── Indexes (caches of the log) ───────────────────────────────────────

	private index(
		pid: string,
		g: Pick<GrantFold, "grantId" | "participants" | "expiresAt" | "with" | "createdAt">,
	): void {
		for (const p of g.participants) {
			// A session re-bound to an agent of another project may appear in two
			// grants that are still alive; projects open in no particular order
			// at boot, so the NEWER grant keeps the entry, whichever came first.
			const cur = this.bySession.get(p.sid);
			if (cur && cur.grantId !== g.grantId && cur.createdAt > g.createdAt) continue;
			this.bySession.set(p.sid, {
				createdAt: g.createdAt,
				projectId: pid,
				grantId: g.grantId,
				agentId: p.agent_id,
				consulted: p.agent_id === g.with,
			});
		}
		clearTimeout(this.expiry.get(g.grantId));
		const t = setTimeout(
			() => void this.expire(pid, g.grantId),
			Math.max(0, Date.parse(g.expiresAt) - this.now()) + 5,
		);
		t.unref?.();
		this.expiry.set(g.grantId, t);
	}

	private unindex(grantId: string): void {
		for (const [sid, e] of this.bySession) if (e.grantId === grantId) this.bySession.delete(sid);
		clearTimeout(this.expiry.get(grantId));
		this.expiry.delete(grantId);
	}

	private noteQueued(pid: string, d: { msgId: string; agentId: string }, on: boolean): void {
		const key = deliveryKey(d.msgId, d.agentId);
		let set = this.queued.get(pid);
		if (on) {
			if (!set) {
				set = new Set();
				this.queued.set(pid, set);
			}
			set.add(key);
		} else if (set) {
			set.delete(key);
			if (set.size === 0) this.queued.delete(pid);
		}
	}

	/**
	 * Every durable line of every project passes here, synchronously, inside
	 * the append that wrote it. It only updates the caches and SCHEDULES work:
	 * the work itself re-reads the log under the lock.
	 */
	private onAppend(pid: string, lines: readonly LogLine[]): void {
		if (this.stopped) return;
		for (const l of lines) {
			if (l.ev === "grant") {
				if (l.event === "created") {
					this.withGrants.add(pid);
					this.index(pid, {
						grantId: l.grant_id as string,
						participants: l.participants as GrantParticipant[],
						expiresAt: l.expires_at as string,
						with: l.with as string,
						createdAt: l.at,
					});
				} else if (l.event === "revoked" || l.event === "ended") {
					this.unindex(l.grant_id as string);
				} else if (l.event === "resumed") {
					this.later(() => this.kick(pid));
				}
				continue;
			}
			if (l.ev !== "delivery" || !this.withGrants.has(pid)) continue;
			const msgId = l.msg_id as string;
			const agentId = l.agent_id as string;
			const state = l.state as string;
			const gid = grantIdOf(l.authorized_by as string | undefined);
			if (gid) {
				this.noteQueued(pid, { msgId, agentId }, state === "queued");
				if (state === "queued") this.later(() => this.kick(pid));
			}
			// Every other result line carries its consequence in its own append
			// (grantRules.ts). `settled` is the reply watcher's, written without
			// knowing about grants: followed up here.
			if (state === "settled") this.later(() => this.outcome(pid, msgId, agentId));
		}
	}

	private later(fn: () => unknown): void {
		setImmediate(() => {
			if (this.stopped) return;
			try {
				const r = fn();
				if (r instanceof Promise) r.catch((err) => this.warn("deferred", err));
			} catch (err) {
				this.warn("deferred", err);
			}
		});
	}

	private warn(what: string, err: unknown): void {
		this.deps.log?.warn(`[collab] ${what}: ${(err as Error).message}`);
	}

	// ── Admission (§7.3 rules 6–8) ────────────────────────────────────────

	async admit(input: AdmitInput): Promise<AdmitResult> {
		const { projectId, grantId, from } = input;
		return this.deps.store.critical(projectId, async (tx): Promise<AdmitResult> => {
			const state = tx.state;
			const g = state.grants.get(grantId);
			if (!g || !grantAlive(g, this.now())) return { outcome: "ignored", why: "grant-not-alive" };
			// The caller compared D1 with the capture; this compares the caller's
			// claim with what the person authorized. Both must hold.
			const me = g.participants.find((p) => p.agent_id === from.agent_id);
			const other = g.participants.find((p) => p.agent_id !== from.agent_id);
			if (
				!me ||
				!other ||
				me.sid !== from.sid ||
				me.binding_id !== from.binding_id ||
				me.epoch !== from.epoch
			) {
				return { outcome: "ignored", why: "not-a-participant" };
			}
			if (state.outboxAccepted.has(outboxKey(grantId, from.sid, input.path, input.sha256))) {
				return { outcome: "duplicate" };
			}
			const outbox = (event: string, extra: Record<string, unknown>): NewEvent => ({
				ev: "outbox",
				grant_id: grantId,
				event,
				from: {
					agent_id: from.agent_id,
					binding_id: from.binding_id,
					epoch: from.epoch,
					sid: from.sid,
					cid: from.cid,
				},
				...(input.toolUseId ? { tool_use_id: input.toolUseId } : {}),
				path: input.path,
				...(input.sha256 ? { sha256: input.sha256, bytes: input.bytes } : {}),
				origin: "match",
				...extra,
			});
			const reject = async (reason: string, kind?: OutboxKind): Promise<AdmitResult> => {
				// Bounded: a participant cannot grow the log by writing bad files.
				if (g.rejected >= REJECTED_MAX_PER_GRANT)
					return { outcome: "rejected", reason, written: false };
				const events = [outbox("rejected", { reason, ...(kind ? { kind } : {}) })];
				if (
					(g.rejectedBy.get(from.agent_id) ?? 0) + 1 >= REJECTED_PAUSE_PER_AGENT &&
					mayPause(g, "too-many-rejections")
				) {
					events.push(pauseEvent(g, "too-many-rejections", "system"));
				}
				await tx.append(events, { allowMargin: true });
				return { outcome: "rejected", reason, written: true };
			};

			const parsed = input.parsed;
			if (!parsed.ok) return reject(parsed.reason);
			const h = parsed.header;
			if (h.collab !== grantId) return reject("not-authorized", h.kind);
			if (g.state === "paused") return reject("grant-paused", h.kind);

			const body = normalizeText(parsed.body);
			const message = (msgId: string, to: string[], extra: Record<string, unknown>): NewEvent => ({
				ev: "message",
				msg_id: msgId,
				client_message_id: null,
				by: g.by,
				kind: "relay",
				from: from.agent_id,
				to,
				text: body,
				text_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
				request_sha256: null,
				quote_ref: null,
				in_reply_to: null,
				artifacts: [],
				...extra,
			});
			const relay = (n: number) => ({
				grant_id: grantId,
				n,
				kind: h.kind,
				file_sha256: input.sha256,
			});
			const msgId = randomUUID();

			if (h.kind === "owner" || h.kind === "done") {
				// Not delivered to an agent and not counted: it is addressed to the person.
				const events: NewEvent[] = [
					outbox("accepted", { kind: h.kind, msg_id: msgId }),
					message(msgId, [], { relay: relay(0) }),
				];
				if (h.kind === "owner") events.push(pauseEvent(g, "needs-owner", "system"));
				else events.push(...endEvents(state, g, { event: "ended", reason: "done", by: "system" }));
				await tx.append(events);
				return { outcome: "accepted", msgId, kind: h.kind };
			}

			if (h.to !== other.agent_id) return reject("not-authorized", h.kind);
			let inReplyTo: string | null = null;
			if (h.re !== null) {
				// A message of THIS grant that was (at least) sent to this agent.
				const hits = [...state.messages.values()].filter(
					(m) =>
						m.kind === "relay" &&
						m.grantId === grantId &&
						shortMsgId(m.msgId) === h.re &&
						state.deliveries.get(deliveryKey(m.msgId, from.agent_id))?.sent === true,
				);
				if (hits.length !== 1) return reject("bad-re", h.kind);
				inReplyTo = (hits[0] as { msgId: string }).msgId;
			}
			if (g.used >= g.maxMessages) return reject("budget", h.kind);
			if (body === "") return reject("empty", h.kind);
			const n = g.used + 1;
			// The text rules apply to what the recipient will actually receive.
			const v = validateText(
				relayText({
					grantId,
					n,
					maxMessages: g.maxMessages,
					from: from.agent_id,
					to: other.agent_id,
					msgId,
					body,
					nonce: "00000000",
				}),
			);
			if (!v.ok) return reject(`text-${v.code}`, h.kind);
			if (pendingRelays(state, grantId).some((d) => d.agentId === other.agent_id)) {
				return reject("queue-full", h.kind);
			}
			await tx.append([
				outbox("accepted", { kind: h.kind, msg_id: msgId }),
				message(msgId, [other.agent_id], { relay: relay(n), in_reply_to: inReplyTo }),
				{
					ev: "delivery",
					msg_id: msgId,
					agent_id: other.agent_id,
					state: "queued",
					binding: { binding_id: other.binding_id, epoch: other.epoch, sid: other.sid },
					authorized_by: collabOf(grantId),
				},
			]);
			return { outcome: "accepted", msgId, kind: h.kind };
		});
	}

	/** What outbox.ts needs to prove a sender against D1 (§7.3 rule 3): the grant as the log has it. */
	async describe(
		projectId: string,
		grantId: string,
	): Promise<{
		by: string;
		with: string;
		participants: GrantParticipant[];
		/** Nothing this grant receives now could be admitted OR recorded (see outbox.ts). */
		saturated: boolean;
	} | null> {
		return this.deps.store.critical(projectId, async (tx) => {
			const g = tx.state.grants.get(grantId);
			if (!g || !grantAlive(g, this.now())) return null;
			return {
				by: g.by,
				with: g.with,
				participants: g.participants.map((p) => ({ ...p })),
				saturated:
					g.rejected >= REJECTED_MAX_PER_GRANT && (g.state === "paused" || g.used >= g.maxMessages),
			};
		});
	}

	/**
	 * §7.5 write detection: the consulted agent (`with`) started a file-writing
	 * tool outside its outbox while the grant is live. Detection, not
	 * prevention — it pauses and shows; it needs no origin verdict because it
	 * can only make the system stop.
	 */
	async writeObserved(sid: string, detail: { tool: string; cid: string }): Promise<void> {
		const e = this.bySession.get(sid);
		// The initiator works on the person's task: its writes are not watched.
		if (!e?.consulted) return;
		await this.write(e.projectId, (state) => {
			const g = state.grants.get(e.grantId);
			if (!g || !grantAlive(g, this.now()) || !mayPause(g, "write-observed")) return [];
			const p = g.participants.find((x) => x.sid === sid);
			if (!p || p.agent_id !== g.with) return [];
			return [pauseEvent(g, "write-observed", "system", undefined, detail)];
		});
	}

	/**
	 * §7.5: a file in a participant's outbox that names this grant and that
	 * the log says nothing about (written while the backend was down, or on
	 * events whose origin was not verified). Recorded once, shown, never sent.
	 */
	async noteUnverified(input: {
		projectId: string;
		grantId: string;
		from: GrantParticipant;
		path: string;
		sha256: string;
		bytes: number;
		kind: OutboxKind;
	}): Promise<boolean> {
		let written = false;
		await this.write(input.projectId, (state) => {
			const g = state.grants.get(input.grantId);
			if (!g || !grantAlive(g, this.now()) || g.unverified >= UNVERIFIED_MAX_PER_GRANT) return [];
			if (
				!g.participants.some((p) => p.sid === input.from.sid && p.agent_id === input.from.agent_id)
			)
				return [];
			if (state.outboxSeen.has(outboxKey(input.grantId, input.from.sid, input.path, input.sha256)))
				return [];
			written = true;
			return [
				{
					ev: "outbox",
					grant_id: input.grantId,
					event: "unverified",
					from: input.from,
					path: input.path,
					sha256: input.sha256,
					bytes: input.bytes,
					kind: input.kind,
					origin: "none",
				},
			];
		});
		return written;
	}

	/** Sessions that take part in a live grant (the unverified sweep's list). */
	liveSessions(): Array<{ sid: string; projectId: string; grantId: string; agentId: string }> {
		return [...this.bySession].map(([sid, e]) => ({ sid, ...e }));
	}

	// ── Queue and gate (§7.5) ─────────────────────────────────────────────

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
		const items = await this.deps.store.critical(projectId, async (tx) =>
			[...tx.state.deliveries.values()]
				.filter((d) => d.state === "queued" && grantIdOf(d.authorizedBy))
				.map((d) => ({ msgId: d.msgId, agentId: d.agentId, queuedAt: d.queuedAt ?? "" })),
		);
		for (const it of items) {
			const key = `${projectId}/${deliveryKey(it.msgId, it.agentId)}`;
			if (this.inFlight.has(key)) continue;
			this.inFlight.add(key);
			// Not awaited as a group: one busy recipient never holds another's
			// delivery; each run is independent and ends on its own.
			void this.tryDeliver(projectId, it.msgId, it.agentId)
				.catch((err) => this.warn(`delivery ${key}`, err))
				.finally(() => this.inFlight.delete(key));
		}
	}

	private async tryDeliver(projectId: string, msgId: string, agentId: string): Promise<void> {
		const key = deliveryKey(msgId, agentId);
		// Everything read here is a hint; the decision is retaken under the lock below.
		const snap = await this.deps.store.critical(projectId, async (tx) => {
			const d = tx.state.deliveries.get(key);
			const g = tx.state.grants.get(grantIdOf(d?.authorizedBy) ?? "");
			const m = tx.state.messages.get(msgId);
			if (!d || d.state !== "queued" || !g || !m) return null;
			return {
				grantId: g.grantId,
				by: g.by,
				state: g.state,
				alive: grantAlive(g, this.now()),
				maxMessages: g.maxMessages,
				waitMs: g.maxWaitMin * 60_000,
				queuedAt: Date.parse(d.queuedAt ?? ""),
				participant: g.participants.find((p) => p.agent_id === agentId),
				from: m.from ?? "",
				n: m.relay?.n ?? 0,
				body: m.text ?? "",
			};
		});
		if (!snap) return;
		if (!snap.alive) return this.expire(projectId, snap.grantId);
		const p = snap.participant;
		if (!p) return;
		// Ends the grant because of THIS queued delivery, which gets its own reason.
		const endFor = (reason: string): Promise<void> =>
			this.write(projectId, (state) => {
				const d = state.deliveries.get(key);
				const g = state.grants.get(snap.grantId);
				if (!d || d.state !== "queued" || !g || g.state === "ended") return [];
				return endEvents(
					state,
					g,
					{ event: "ended", reason, by: "system" },
					new Map([[key, reason]]),
				);
			});

		// §7.5: a message that waited longer than the person allowed ends the consult.
		if (Number.isFinite(snap.queuedAt) && this.now() - snap.queuedAt > snap.waitMs) {
			return endFor("wait-expired");
		}
		if (snap.state !== "live") return;

		// The fixed binding, re-read from D1 (no lock held).
		let timer: NodeJS.Timeout | undefined;
		const b = await Promise.race([
			this.deps.bindings(snap.by, projectId).catch(() => undefined),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), BINDING_READ_MS);
			}),
		]);
		clearTimeout(timer);
		if (b === undefined) return; // unverified: it stays queued and is tried again
		const cur = b?.get(agentId);
		if (
			!b ||
			!cur ||
			cur.removed ||
			!cur.binding ||
			cur.binding.bindingId !== p.binding_id ||
			cur.binding.epoch !== p.epoch ||
			cur.binding.sessionId !== p.sid
		) {
			return endFor("binding-changed");
		}

		const r = await this.deps.recipient(p.sid).catch(() => ({ kind: "none" }) as const);
		if (r.kind === "busy" || r.kind === "none") return;
		if (r.kind === "ambiguous") {
			// Never a guess (§7.1): the person sorts the session out and resumes.
			return this.write(projectId, (state) => {
				const d = state.deliveries.get(key);
				const g = state.grants.get(snap.grantId);
				if (!d || d.state !== "queued" || !g || g.state === "ended") return [];
				const r = { state: "not-sent", reason: "ambiguous-target" };
				return [
					{
						ev: "delivery",
						msg_id: msgId,
						agent_id: agentId,
						...r,
						authorized_by: collabOf(snap.grantId),
					},
					...deliveryConsequence(state, msgId, agentId, r),
				];
			});
		}

		// queued → planned: the binding (now with its conversation) and the
		// Composer id are fixed here, once (§3.4 rule 3).
		let planned: LogLine | undefined;
		await this.deps.store.critical(projectId, async (tx) => {
			const d = tx.state.deliveries.get(key);
			const g = tx.state.grants.get(snap.grantId);
			if (!d || d.state !== "queued" || !g || g.state !== "live" || !grantAlive(g, this.now()))
				return;
			[planned] = await tx.append(
				[
					{
						ev: "delivery",
						msg_id: msgId,
						agent_id: agentId,
						state: "planned",
						binding: { binding_id: p.binding_id, epoch: p.epoch, sid: p.sid, cid: r.cid },
						composer_client_message_id: randomUUID(),
						authorized_by: collabOf(snap.grantId),
					},
				],
				{ allowMargin: true },
			);
		});
		if (!planned) return;
		const text = relayText({
			grantId: snap.grantId,
			n: snap.n,
			maxMessages: snap.maxMessages,
			from: snap.from,
			to: agentId,
			msgId,
			body: snap.body,
			// Drawn now, after the body was fixed: the body cannot contain it.
			nonce: randomBytes(4).toString("hex"),
		});
		await this.deps.fanout.deliver(
			snap.by,
			projectId,
			msgId,
			agentId,
			planned,
			text,
			[],
			new Map(),
			{
				authorizedBy: collabOf(snap.grantId),
				// Inside the critical section that writes `sending` (§7.5).
				gate: (state) => {
					const g = state.grants.get(snap.grantId);
					if (!g || !grantAlive(g, this.now())) return "grant-inactive";
					return g.state === "paused" ? "grant-paused" : null;
				},
			},
		);
		// The result line and its consequence for the grant were one append.
	}

	// ── What a delivery's end does to its grant (§7.5) ────────────────────

	/** Follow-up of a `settled` line (see the header): idempotent, decided from the log. */
	private async outcome(projectId: string, msgId: string, agentId: string): Promise<void> {
		await this.write(projectId, (state) => {
			const d = state.deliveries.get(deliveryKey(msgId, agentId));
			if (!d || d.state !== "settled") return [];
			return deliveryConsequence(state, msgId, agentId, { state: d.state, result: d.result });
		});
	}

	// ── Control (§7.6) ────────────────────────────────────────────────────

	private async expire(projectId: string, grantId: string): Promise<void> {
		await this.write(projectId, (state) => {
			const g = state.grants.get(grantId);
			if (!g || g.state === "ended" || grantAlive(g, this.now())) return [];
			return endEvents(state, g, { event: "ended", reason: "expired", by: "system" });
		});
	}

	/** One critical section: compute the events from the state, append them (possibly none). */
	private async write(projectId: string, fn: (state: Folded) => NewEvent[]): Promise<void> {
		try {
			await this.deps.store.critical(projectId, async (tx: CriticalTx) => {
				const events = fn(tx.state);
				if (events.length > 0) await tx.append(events, { allowMargin: true });
			});
		} catch (err) {
			// Poisoned or lock lost: nothing was written and nothing will be sent
			// (every gate reads the log); recovery decides at the next open.
			this.warn(`write ${projectId}`, err);
		}
	}

	async action(
		ownerId: string,
		projectId: string,
		grantId: string,
		verb: "pause" | "resume" | "revoke",
	): Promise<HttpResult> {
		if (!GRANT_RE.test(grantId)) return { status: 404, body: { error: "grant-not-found" } };
		try {
			return await this.deps.store.critical(projectId, async (tx): Promise<HttpResult> => {
				const g = tx.state.grants.get(grantId);
				if (!g) return { status: 404, body: { error: "grant-not-found" } };
				const answer = (): HttpResult => ({
					status: 200,
					body: { grantId, state: g.state, ...(g.reason ? { reason: g.reason } : {}) },
				});
				// The first check that finds the time passed writes the end (§7.5).
				if (g.state !== "ended" && !grantAlive(g, this.now())) {
					await tx.append(
						endEvents(tx.state, g, { event: "ended", reason: "expired", by: "system" }),
						{ allowMargin: true },
					);
				}
				if (verb === "revoke") {
					if (g.state !== "ended") {
						await tx.append(endEvents(tx.state, g, { event: "revoked", by: ownerId }), {
							allowMargin: true,
						});
					}
					return answer();
				}
				if (g.state === "ended") {
					return { status: 409, body: { error: "grant-ended", detail: g.reason } };
				}
				if (verb === "pause" && mayPause(g, "owner")) {
					// Also over a standing system pause: the person's Pause must not
					// be liftable by the Composer's evidence (grantRules.ts).
					await tx.append([pauseEvent(g, "owner", ownerId)], { allowMargin: true });
				} else if (verb === "resume" && g.state === "paused") {
					await tx.append(
						[
							{ ev: "grant", grant_id: grantId, event: "resumed", by: ownerId },
							// Nothing left to exchange: resuming is the end (§7.2).
							...(budgetSpent(tx.state, g)
								? endEvents(tx.state, g, { event: "ended", reason: "budget", by: "system" })
								: []),
						],
						{ allowMargin: true },
					);
				}
				return answer();
			});
		} catch (e) {
			const h = logErrorToHttp(e);
			if (h) return h;
			throw e;
		}
	}

	async get(projectId: string, grantId: string): Promise<HttpResult> {
		if (!GRANT_RE.test(grantId)) return { status: 404, body: { error: "grant-not-found" } };
		const { state, lines } = await this.deps.store.view(projectId);
		const g = state.grants.get(grantId);
		if (!g) return { status: 404, body: { error: "grant-not-found" } };
		return {
			status: 200,
			body: {
				grant: {
					grantId,
					state: g.state,
					...(g.reason ? { reason: g.reason } : {}),
					alive: grantAlive(g, this.now()),
					taskMsgId: g.taskMsgId,
					by: g.by,
					initiator: g.initiator,
					with: g.with,
					participants: g.participants,
					maxMessages: g.maxMessages,
					used: g.used,
					maxWaitMin: g.maxWaitMin,
					expiresAt: g.expiresAt,
					rejected: g.rejected,
				},
				events: lines.filter(
					(l) => (l.ev === "grant" || l.ev === "outbox") && l.grant_id === grantId,
				),
			},
		};
	}
}
