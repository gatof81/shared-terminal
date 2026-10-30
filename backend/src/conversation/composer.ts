/**
 * conversation/composer.ts — the 3.2 composer (docs/CONVERSATION.md §8).
 *
 * Delivers text to the interactive CLI living in a conversation's bound tmux
 * pane exactly as the person would have pasted it and pressed Enter, and
 * confirms it only through the CLI's own `UserPromptSubmit`. Nothing here
 * talks to the CLI over any channel of its own (§1.1).
 *
 * The load-bearing shape (§8.1.4):
 *
 *   - ONE operation per pane at a time, and the pane stays blocked until no
 *     effect capable of acting remains — not until the HTTP answered, not
 *     until the message got a result, never by time. Each operation has an
 *     independent `result` (what is known about the message), `effects`
 *     (what is known about the execs it created) and `phase` (whether its
 *     executor may still start an effect).
 *   - The executor holds the pane lock (`SessionLifecycleLock`, mode `fail`,
 *     keyed by session + pane) for its whole ACTIVE phase. `mayAct` — the lock
 *     is ours and the record has no `cancelled_at` — is checked in the same
 *     critical section that writes the exec id to the durable pane record
 *     BEFORE the exec starts, so no other actor can slip a cancellation
 *     between the check and the start, and an exec whose id is recorded
 *     exists for everyone even if its `start` never answered.
 *   - Every effect's end is known only from its own inspect (`exitCode`
 *     numeric). Anything else leaves the exec `pending`: the operation is
 *     cancelled logically (no further segment, no Enter), goes `uncertain`,
 *     and only evidence settles it — a later inspect with a numeric exit, or
 *     the container that hosted it no longer running. Not time, not quiet,
 *     not an ack, not an operator's word.
 *   - The pane record (paneRecord.ts) is the durable blocker, written before
 *     `prepared` and retired only on `released`; the `composer_send` events
 *     in the conversation log are the history and the idempotency window.
 *
 * Admin resolution and reconciliation (§8.1.11) take the SAME pane lock, so an
 * active executor answers them 409 without a race, and they never settle
 * effects by declaration.
 */

import { logger } from "../logger.js";
import { SessionBusyError, SessionLifecycleLock } from "../sessionLifecycleLock.js";
import type { SessionMeta } from "../types.js";
import {
	ancestryArgv,
	CONSUME_MAX_POLLS,
	CONSUME_POLL_MS,
	captureArgv,
	DEFAULT_CLI_VERSIONS,
	IDEMPOTENCY_WINDOW,
	inputRegion,
	inputRegionPlain,
	normalizeText,
	paneStateArgv,
	parsePaneState,
	pasteConsumed,
	segment,
	stepArgv,
	T_ACK_MS,
	T_HTTP_MS,
	textHash,
	validateBody,
} from "./composerText.js";
import type {
	ExecStep,
	OperationResult,
	OperationState,
	PaneRecord,
	PaneRecordStore,
} from "./paneRecord.js";
import type { ProbeEntry } from "./probe.js";
import type { ConversationIndex, ConversationStore, PersistedEvent } from "./store.js";

// ── Ports ───────────────────────────────────────────────────────────────────

export interface ComposerExecResult {
	/** Null only when creation failed before an id existed (then `exec` throws instead). */
	execId: string;
	/** Numeric when the exec's own inspect reported it; null = unknown. */
	exitCode: number | null;
	stdout: string;
}

/**
 * The Docker side (dockerManager.composerPort). No request is aborted or
 * cut on this side; a creation failure throws (no process exists); after
 * creation `onCreated` runs BEFORE `start` and may refuse it (then the exec
 * exists but runs nothing).
 */
export interface ComposerDockerPort {
	exec(
		containerId: string,
		cmd: string[],
		stdin: Buffer | null,
		onCreated: (execId: string) => Promise<boolean>,
	): Promise<ComposerExecResult>;
	execState(execId: string): Promise<{ running: boolean; exitCode: number | null } | null>;
	containerState(containerId: string): Promise<"running" | "stopped" | "gone">;
}

export interface ComposerConversationPort {
	probeSession(stSessionId: string): Promise<ProbeEntry[] | null>;
	onPersistedEvent(listener: (st: string, cid: string, event: PersistedEvent) => void): () => void;
	captureEffective(stSessionId: string): Promise<boolean>;
}

export interface ComposerDeps {
	enabled: boolean;
	/** `COMPOSER_CLI_VERSIONS` (§8.1.9). */
	cliVersions?: ReadonlySet<string>;
	store: ConversationStore;
	conversation: ComposerConversationPort;
	sessions: { getOrThrow(sessionId: string): Promise<SessionMeta> };
	docker: ComposerDockerPort;
	records: PaneRecordStore;
	now?: () => number;
	/** Timer seam: resolves after `ms`. Tests drive it. */
	after?: (ms: number) => Promise<void>;
	tHttpMs?: number;
	tAckMs?: number;
	/** Per-user sends per minute (`composerUser`). */
	userRatePerMinute?: number;
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface HttpResult {
	status: number;
	body: Record<string, unknown>;
}

export interface SendInput {
	stSessionId: string;
	cid: string;
	callerId: string;
	/** The session, already authorized (`assertCanOperate`). */
	meta: SessionMeta;
	body: unknown;
	/** Writes the cross-user `operate` row; throws ⇒ nothing is sent (§8.1.1). */
	audit: () => Promise<void>;
}

export interface ResolveInput {
	stSessionId: string;
	paneId: string;
	clientMessageId: string;
	outcome: "discarded" | "sent-manually" | "reconcile";
	by: string;
	/** Writes the `operate` row for a declaration; throws ⇒ nothing is written. Not called for `reconcile`. */
	audit: () => Promise<void>;
}

export interface PaneView {
	paneId: string;
	clientMessageId: string;
	cid: string;
	phase: PaneRecord["phase"];
	result: OperationResult;
	effects: "settled" | "pending";
	pending: Array<{ id: string; step: ExecStep }>;
	since: string;
}

export interface ComposerAvailability {
	canSendInput: boolean;
	composer: {
		blocked: boolean;
		reason?: "in-progress" | "effects-pending" | "unverifiable";
		clientMessageId?: string;
		result?: OperationResult;
		since?: string;
	};
}

/** `COMPOSER_CLI_VERSIONS`: comma-separated; empty/unset ⇒ the validated default. */
export function parseCliVersions(raw: string | undefined): Set<string> {
	const list = (raw ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
	return new Set(list.length > 0 ? list : DEFAULT_CLI_VERSIONS);
}

export class ComposerDisabledError extends Error {
	constructor() {
		super("composer disabled");
		this.name = "ComposerDisabledError";
	}
}

// ── Live operation ──────────────────────────────────────────────────────────

interface LiveOp {
	key: string;
	record: PaneRecord;
	/** The operation's own id for the ack listener, so one op never consumes another's candidate. */
	bytes: number;
	segments: number;
	actor: "owner" | "admin";
	/** Set with the record's `cancelled_at`; read by mayAct under the lock. */
	cancelled: boolean;
	/**
	 * T_http passed while active (§8.1.4 regla 4): the executor applies the
	 * cancellation itself, in the critical section that would start the next
	 * effect — so the record is written by its lock holder, never by a timer.
	 */
	cancelRequested?: string;
	/** A deferred ack wait is already running for this operation. */
	ackWaiting?: boolean;
	/** Resolves when the HTTP answer is decided (final result, uncertain, or T_http). */
	http: Promise<HttpResult>;
	resolveHttp: (r: HttpResult) => void;
	httpDecided: boolean;
	/** Candidate acks seen (§8.1.7), keyed by conversation. */
	candidates: Map<string, { promptId: string | null; seq: number }>;
	resolveAck: (() => void) | null;
	unlisten: (() => void) | null;
	/** Resolves when the executor leaves the active phase (entered / failed / cancelled). */
	activeDone: Promise<void>;
	markActiveDone: () => void;
}

function newLiveOp(
	base: Omit<LiveOp, "http" | "resolveHttp" | "httpDecided" | "activeDone" | "markActiveDone">,
): LiveOp {
	let resolveHttp!: (r: HttpResult) => void;
	const http = new Promise<HttpResult>((r) => {
		resolveHttp = r;
	});
	let markActiveDone!: () => void;
	const activeDone = new Promise<void>((r) => {
		markActiveDone = r;
	});
	return { ...base, http, resolveHttp, httpDecided: false, activeDone, markActiveDone };
}

const effectsOf = (r: PaneRecord): "settled" | "pending" =>
	r.execs.every((e) => e.settled !== null) ? "settled" : "pending";

const isFinalResult = (r: OperationResult): boolean => r !== "pending";

export class ComposerService {
	private readonly lock = new SessionLifecycleLock();
	private readonly live = new Map<string, LiveOp>();
	/** Finals of this process, consulted before the index (which lags a flush). */
	private readonly recentFinals = new Map<string, HttpResult>();
	private readonly recovered = new Set<string>();
	private readonly userSends = new Map<string, number[]>();
	private readonly cliVersions: ReadonlySet<string>;
	private readonly now: () => number;
	private readonly after: (ms: number) => Promise<void>;
	private readonly tHttp: number;
	private readonly tAck: number;
	private readonly rate: number;
	readonly stats = {
		sendsByState: {} as Record<string, number>,
		rejectedByCode: {} as Record<string, number>,
	};

	constructor(private readonly deps: ComposerDeps) {
		this.cliVersions = deps.cliVersions ?? new Set(DEFAULT_CLI_VERSIONS);
		this.now = deps.now ?? (() => Date.now());
		this.after = deps.after ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.tHttp = deps.tHttpMs ?? T_HTTP_MS;
		this.tAck = deps.tAckMs ?? T_ACK_MS;
		this.rate = deps.userRatePerMinute ?? 30;
	}

	get enabled(): boolean {
		return this.deps.enabled;
	}

	private key(sid: string, paneId: string): string {
		return `${sid}\u0000${paneId}`;
	}

	private reject(code: string, status: number, extra: Record<string, unknown> = {}): HttpResult {
		this.stats.rejectedByCode[code] = (this.stats.rejectedByCode[code] ?? 0) + 1;
		return { status, body: { error: code, ...extra } };
	}

	private isoNow(): string {
		return new Date(this.now()).toISOString();
	}

	// ── Availability (§6, orientative) ──────────────────────────────────────

	/** Per conversation: `canSendInput` and the `composer` block. No probe, no exec. */
	async availability(
		stSessionId: string,
		indexes: Array<Pick<ConversationIndex, "cid" | "kind" | "paneId">>,
		opts: { captureEffective: boolean | null; callerMayOperate: boolean },
	): Promise<Map<string, ComposerAvailability>> {
		const out = new Map<string, ComposerAvailability>();
		if (!this.deps.enabled) {
			for (const i of indexes)
				out.set(i.cid, { canSendInput: false, composer: { blocked: false } });
			return out;
		}
		await this.recover(stSessionId).catch(() => undefined);
		const { records, unreadable } = await this.deps.records.list(stSessionId);
		const byPane = new Map(records.map((r) => [r.pane_id, r]));
		for (const i of indexes) {
			const rec = i.paneId ? byPane.get(i.paneId) : undefined;
			let composer: ComposerAvailability["composer"] = { blocked: false };
			if (unreadable.length > 0) composer = { blocked: true, reason: "unverifiable" };
			else if (rec) {
				composer = {
					blocked: true,
					reason:
						rec.phase === "active"
							? "in-progress"
							: effectsOf(rec) === "pending"
								? "effects-pending"
								: "in-progress",
					clientMessageId: rec.client_message_id,
					result: rec.result,
					since: rec.prepared_at,
				};
			}
			const canSendInput =
				i.kind === "interactive" &&
				!!i.paneId &&
				opts.captureEffective === true &&
				!composer.blocked &&
				opts.callerMayOperate;
			out.set(i.cid, { canSendInput, composer });
		}
		return out;
	}

	// ── Send (§8.1) ─────────────────────────────────────────────────────────

	async send(input: SendInput): Promise<HttpResult> {
		if (!this.deps.enabled) throw new ComposerDisabledError();
		const { stSessionId: sid, cid, callerId, meta } = input;
		const v = validateBody(input.body);
		if (!v.ok) return this.reject(v.code, 400);
		const clientMessageId = v.clientMessageId as string;
		if (!this.takeRate(callerId)) return this.reject("rate-limited", 429);

		const index = await this.deps.store.peekIndex(sid, cid).catch(() => null);
		if (!index) return { status: 404, body: { error: "Conversation not found" } };

		// Recovery first (§8.1.4 regla 8): never admit a send before the
		// exclusion is rebuilt from the records.
		await this.recover(sid);
		const { records, unreadable } = await this.deps.records.list(sid);
		if (unreadable.length > 0) {
			return this.reject("send-in-progress", 409, { detail: "unverifiable" });
		}
		// The same id pending anywhere in the session: its own state, no effect.
		const pendingSame = records.find((r) => r.client_message_id === clientMessageId);
		if (pendingSame) return this.uncertainAnswer(pendingSame);
		// A released id in the window: the recorded answer.
		const replay =
			this.recentFinals.get(`${cid}/${clientMessageId}`) ?? index.composerSends?.[clientMessageId];
		if (replay) return { status: replay.status, body: replay.body as Record<string, unknown> };

		if (index.kind !== "interactive" || !index.paneId) return this.reject("not-interactive", 409);
		const paneId = index.paneId;
		const blocker = records.find((r) => r.pane_id === paneId);
		if (blocker) {
			return this.reject("send-in-progress", 409, {
				detail:
					blocker.phase === "active"
						? "in-progress"
						: effectsOf(blocker) === "pending"
							? "effects-pending"
							: "in-progress",
				clientMessageId: blocker.client_message_id,
			});
		}

		const key = this.key(sid, paneId);
		// The lock is held for the ACTIVE phase only (§8.1.4 regla 1), and the
		// HTTP answer is decided independently of it: T_http, an unknown
		// effect or a final result answer the request while the executor may
		// still hold the pane. So the request waits for whichever comes first —
		// a refusal before `prepared` (the lock run returns an HttpResult), or
		// the operation existing (then its own `http` promise).
		let announce!: (op: LiveOp) => void;
		const opReady = new Promise<LiveOp>((r) => {
			announce = r;
		});
		const run: Promise<HttpResult | LiveOp> = this.lock
			.run(
				key,
				"composer-send",
				() =>
					this.activePhase({
						sid,
						cid,
						callerId,
						meta,
						index,
						paneId,
						clientMessageId,
						normalized: v.normalized,
						bytes: v.bytes,
						segments: v.segments,
						audit: input.audit,
						announce,
					}),
				{ mode: "fail" },
			)
			.catch((err) => {
				if (err instanceof SessionBusyError) {
					return this.reject("send-in-progress", 409, { detail: "in-progress" });
				}
				throw err;
			});
		const first = await Promise.race([
			run.then((r) => ({ kind: "run" as const, r })),
			opReady.then((op) => ({ kind: "op" as const, op })),
		]);
		if (first.kind === "op") {
			// The active phase goes on under the lock; its failures are logged there.
			run.catch((err) => logger.error(`[composer] active phase failed: ${(err as Error).message}`));
			return first.op.http;
		}
		return "http" in first.r ? first.r.http : first.r;
	}

	private takeRate(userId: string): boolean {
		const now = this.now();
		const arr = (this.userSends.get(userId) ?? []).filter((t) => now - t < 60_000);
		if (arr.length >= this.rate) {
			this.userSends.set(userId, arr);
			return false;
		}
		arr.push(now);
		this.userSends.set(userId, arr);
		return true;
	}

	private uncertainAnswer(r: PaneRecord): HttpResult {
		return {
			status: 202,
			body: {
				result: "uncertain",
				clientMessageId: r.client_message_id,
				effects: effectsOf(r),
				state: r.state,
			},
		};
	}

	/**
	 * Everything that happens while the executor holds the pane lock: the
	 * preconditions (409, no effect), `prepared` (record + confirmed event),
	 * the effects, and the transition out of the active phase. Returns the
	 * HTTP answer (which may be `uncertain` while the operation lives on).
	 */
	private async activePhase(a: {
		sid: string;
		cid: string;
		callerId: string;
		meta: SessionMeta;
		index: ConversationIndex;
		paneId: string;
		clientMessageId: string;
		normalized: string;
		bytes: number;
		segments: number;
		audit: () => Promise<void>;
		/** Called once the operation exists (after `prepared`), so the request can wait on its `http`. */
		announce: (op: LiveOp) => void;
	}): Promise<HttpResult | LiveOp> {
		const { sid, cid, paneId, clientMessageId } = a;
		// Under the lock: the record must still be absent.
		const again = await this.deps.records.read(sid, paneId);
		if (again.kind === "unreadable")
			return this.reject("send-in-progress", 409, { detail: "unverifiable" });
		if (again.kind === "ok") {
			return this.reject("send-in-progress", 409, {
				detail: "in-progress",
				clientMessageId: again.record.client_message_id,
			});
		}

		// ── Preconditions, contract order (§8.1.3) ──
		if (a.meta.status !== "running" || !a.meta.containerId)
			return this.reject("session-not-running", 409);
		const containerId = a.meta.containerId;
		if (!(await this.deps.conversation.captureEffective(sid)))
			return this.reject("capture-inactive", 409);
		const probe = await this.deps.conversation.probeSession(sid);
		const entry = probe?.find((e) => e.sessionId === cid);
		if (!probe || !entry) return this.reject("probe-failed", 409);
		const paneState = await this.readPaneState(containerId, paneId);
		if (!paneState) return this.reject("binding-stale", 409);
		if (
			typeof entry.pid !== "number" ||
			!(await this.isDescendant(containerId, entry.pid, paneState.panePid))
		) {
			return this.reject("binding-stale", 409);
		}
		if (entry.status === "busy") return this.reject("busy", 409);
		if (entry.waitingFor !== undefined && entry.waitingFor !== "input needed") {
			return this.reject("needs-terminal", 409, { detail: entry.waitingFor });
		}
		if (paneState.inMode) return this.reject("needs-terminal", 409, { detail: "copy-mode" });
		if (paneState.dead) return this.reject("needs-terminal", 409, { detail: "pane-dead" });
		if (paneState.command !== "claude" && paneState.command !== "node") {
			return this.reject("needs-terminal", 409, { detail: `foreground:${paneState.command}` });
		}
		const region = await this.readInputRegion(containerId, paneId);
		if (region.kind !== "empty") {
			return this.reject("composer-not-empty", 409, {
				detail: region.kind === "unknown" ? region.reason : "text",
			});
		}
		if (!a.index.claudeVersion || !this.cliVersions.has(a.index.claudeVersion)) {
			return this.reject("cli-unvalidated", 409, { version: a.index.claudeVersion });
		}

		// ── Audit before any effect (§8.1.1), fail-closed ──
		const actor: "owner" | "admin" = a.meta.userId === a.callerId ? "owner" : "admin";
		if (actor === "admin") {
			try {
				await a.audit();
			} catch (err) {
				logger.error(`[composer] operate audit failed, nothing sent: ${(err as Error).message}`);
				return this.reject("audit-failed", 500);
			}
		}

		// ── prepared: record, then the confirmed event (§8.1.4) ──
		const hash = textHash(a.normalized);
		const at = this.isoNow();
		const record: PaneRecord = {
			v: 1,
			sid,
			pane_id: paneId,
			pane_pid: paneState.panePid,
			container_id: containerId,
			cid,
			client_message_id: clientMessageId,
			text_hash: hash,
			prepared_at: at,
			state: "prepared",
			result: "pending",
			phase: "active",
			execs: [],
			updated_at: at,
		};
		const op = newLiveOp({
			key: this.key(sid, paneId),
			record,
			bytes: a.bytes,
			segments: a.segments,
			actor,
			cancelled: false,
			candidates: new Map(),
			resolveAck: null,
			unlisten: null,
		});
		try {
			await this.deps.records.write(record);
		} catch (err) {
			logger.error(`[composer] pane record write failed: ${(err as Error).message}`);
			return this.reject("persist-failed", 503);
		}
		// The ack observation starts here, before any effect (§8.1.7).
		this.armAck(op);
		try {
			await this.persist(op, "prepared", {}, { confirmed: true });
		} catch (err) {
			logger.error(`[composer] prepared event persist failed: ${(err as Error).message}`);
			op.unlisten?.();
			await this.deps.records.remove(sid, paneId).catch(() => undefined);
			return this.reject("persist-failed", 503);
		}
		this.live.set(op.key, op);
		a.announce(op);

		// ── Effects ──
		// The HTTP answer: T_http races the operation's own decision.
		void this.after(this.tHttp).then(() => {
			this.decideHttp(op, { status: 202, body: { result: "uncertain", clientMessageId } });
			// Past T_http without a settled Enter the operation is cancelled
			// (regla 4). The record is the executor's to write — it applies the
			// cancellation at its next step, in the critical section that would
			// have started the following effect — but the history records now
			// that the outcome was unknown at this point.
			if (op.record.phase === "active" && !op.cancelled) {
				op.cancelRequested = "t-http";
				void this.persist(op, "uncertain", {
					stage: op.record.execs.at(-1)?.step ?? "precheck",
					pending: op.record.execs
						.filter((e) => !e.settled)
						.map((e) => ({ id: e.id, step: e.step })),
					reason: "t-http",
				}).catch((err) =>
					logger.warn(`[composer] uncertain event persist failed: ${(err as Error).message}`),
				);
			}
		});
		void this.runEffects(op, a.normalized, paneState.panePid).catch((err) => {
			logger.error(`[composer] effects loop failed: ${(err as Error).message}`);
		});
		// `runEffects` ends the active phase; the lock is held exactly until then.
		await op.activeDone;
		return op;
	}

	// ── Effects (§8.1.5, §8.1.6) ────────────────────────────────────────────

	private async runEffects(op: LiveOp, normalized: string, panePid: number): Promise<void> {
		const r = op.record;
		const plan = segment(normalized);
		const bufferBase = `st-${r.cid.slice(0, 8)}`;
		let segmentsSent = 0;
		const finishActive = () => op.markActiveDone();
		try {
			// Precheck: the pane must still be the one the precondition saw.
			const pre = await this.effect(op, "precheck", paneStateArgv(r.pane_id), null);
			if (pre.kind !== "settled") return this.toUncertain(op, "precheck", finishActive);
			const state = pre.exitCode === 0 ? parsePaneState(pre.stdout) : null;
			if (
				!state ||
				state.panePid !== panePid ||
				state.inMode ||
				state.dead ||
				(state.command !== "claude" && state.command !== "node")
			) {
				await this.toFailed(op, "precheck", 0, finishActive, {
					status: 409,
					body: { error: !state || state.panePid !== panePid ? "binding-stale" : "needs-terminal" },
				});
				return;
			}
			for (const step of plan.steps) {
				const stage: ExecStep = step.kind;
				const argv = stepArgv(step, r.pane_id, `${bufferBase}-${segmentsSent}`);
				const stdin = step.kind === "paste" ? Buffer.from(step.text, "utf8") : null;
				// The input region BEFORE a paste: the consumption check below is
				// count-based, so a line identical to the previous one still waits
				// for its own echo.
				const before = step.kind === "paste" ? await this.readRegion(r) : null;
				const res = await this.effect(op, stage, argv, stdin);
				if (res.kind === "refused") return this.toCancelled(op, stage, segmentsSent, finishActive);
				if (res.kind === "pending") return this.toUncertain(op, stage, finishActive);
				if (res.exitCode !== 0) {
					await this.toFailed(op, stage, segmentsSent, finishActive, {
						status: 502,
						body: { error: "delivery-failed", stage, segmentsSent, segments: op.segments },
					});
					return;
				}
				if (step.kind === "paste") {
					segmentsSent++;
					// §8.1.5 paso 2b: no byte follows a paste until the CLI has
					// visibly consumed it. A newline or Enter arriving in the same
					// read as the paste is applied as a plain Enter (the segment
					// gets SUBMITTED) — seen with CLI 2.1.314 in the smoke. Without
					// evidence the delivery fails closed: the text may sit in the
					// input, so the result is `failed` and the person checks.
					if (!(await this.awaitConsumed(op, r, before, step.text))) {
						await this.toFailed(op, stage, segmentsSent, finishActive, {
							status: 502,
							body: {
								error: "delivery-failed",
								stage,
								segmentsSent,
								segments: op.segments,
								detail: "not-consumed",
							},
						});
						return;
					}
				}
				if (step.kind === "enter") {
					await this.toEntered(op, finishActive);
					return;
				}
				// A cancellation requested while this effect ran (T_http): the
				// effect itself settled, nothing further starts (regla 4).
				if (op.cancelRequested) return this.toCancelled(op, stage, segmentsSent, finishActive);
			}
		} catch (err) {
			// A creation failure: no process exists ⇒ a known failure (§8.1.6).
			logger.warn(`[composer] exec creation failed: ${(err as Error).message}`);
			await this.toFailed(op, "paste", segmentsSent, finishActive, {
				status: 502,
				body: {
					error: "delivery-failed",
					stage: "paste",
					segmentsSent,
					segments: op.segments,
					detail: "exec-rejected",
				},
			});
		}
	}

	/**
	 * A read of the pane's input region (no effect, not recorded): null when
	 * the capture failed or the region could not be located.
	 */
	private async readRegion(r: PaneRecord): Promise<string | null> {
		try {
			const res = await this.deps.docker.exec(
				r.container_id,
				captureArgv(r.pane_id),
				null,
				async () => true,
			);
			if (res.exitCode !== 0) return null;
			return inputRegionPlain(res.stdout);
		} catch {
			return null;
		}
	}

	/** Polls the input region until `chunk` shows up as consumed (bounded; false = no evidence). */
	private async awaitConsumed(
		op: LiveOp,
		r: PaneRecord,
		before: string | null,
		chunk: string,
	): Promise<boolean> {
		for (let i = 0; i < CONSUME_MAX_POLLS; i++) {
			if (op.cancelled) return false;
			const after = await this.readRegion(r);
			if (after !== null && pasteConsumed(before, after, chunk)) return true;
			await this.after(CONSUME_POLL_MS);
		}
		return false;
	}

	/**
	 * One effect under the lock: the exec id lands in the record before the
	 * start, in the same critical section as `mayAct`. `refused` means the
	 * operation was already cancelled (the exec was created but never
	 * started) — it is recorded and left `pending` like any unknown.
	 */
	private async effect(
		op: LiveOp,
		step: ExecStep,
		argv: string[],
		stdin: Buffer | null,
	): Promise<
		| { kind: "settled"; exitCode: number; stdout: string }
		| { kind: "pending" }
		| { kind: "refused" }
	> {
		const r = op.record;
		let refused = false;
		let recordedId: string | null = null;
		const res = await this.deps.docker.exec(r.container_id, argv, stdin, async (execId) => {
			// mayAct: our lock, no cancellation — then the id is durable BEFORE start.
			if (op.cancelled || op.cancelRequested) {
				refused = true;
				return false;
			}
			r.execs.push({ id: execId, step, created_at: this.isoNow(), settled: null });
			recordedId = execId;
			try {
				await this.writeRecord(op);
			} catch (err) {
				// The id may not be durable: do not start, and fail closed.
				logger.error(`[composer] record write before start failed: ${(err as Error).message}`);
				refused = true;
				return false;
			}
			return true;
		});
		if (refused) return { kind: "refused" };
		const entry = r.execs.find((e) => e.id === (recordedId ?? res.execId));
		if (res.exitCode === null) return { kind: "pending" };
		if (entry) entry.settled = { exit_code: res.exitCode, at: this.isoNow() };
		return { kind: "settled", exitCode: res.exitCode, stdout: res.stdout };
	}

	private async toUncertain(op: LiveOp, stage: ExecStep, finishActive: () => void): Promise<void> {
		const r = op.record;
		op.cancelled = true;
		r.phase = "cancelled";
		r.cancelled_at = r.cancelled_at ?? this.isoNow();
		r.cancel_reason = op.cancelRequested ?? `effect-pending:${stage}`;
		r.state = "uncertain";
		await this.writeRecord(op).catch((err) =>
			logger.error(`[composer] record write failed: ${(err as Error).message}`),
		);
		finishActive();
		await this.persist(op, "uncertain", {
			stage,
			pending: r.execs.filter((e) => !e.settled).map((e) => ({ id: e.id, step: e.step })),
		});
		this.decideHttp(op, {
			status: 202,
			body: { result: "uncertain", clientMessageId: r.client_message_id, effects: "pending" },
		});
	}

	/**
	 * Cancelled (T_http or a refused start) with every created effect
	 * settled: the Enter was never sent, so the message failed (§8.1.6), and
	 * with nothing pending the pane is released at once.
	 */
	private async toCancelled(
		op: LiveOp,
		stage: ExecStep,
		segmentsSent: number,
		finishActive: () => void,
	): Promise<void> {
		const r = op.record;
		op.cancelled = true;
		r.cancelled_at = this.isoNow();
		r.cancel_reason = op.cancelRequested ?? "refused";
		if (effectsOf(r) !== "settled") return this.toUncertain(op, stage, finishActive);
		await this.toFailed(op, stage, segmentsSent, finishActive, {
			status: 502,
			body: {
				error: "delivery-failed",
				stage,
				segmentsSent,
				segments: op.segments,
				detail: "cancelled",
			},
		});
	}

	private async toFailed(
		op: LiveOp,
		stage: ExecStep,
		segmentsSent: number,
		finishActive: () => void,
		http: HttpResult,
	): Promise<void> {
		const r = op.record;
		r.phase = "completed";
		r.state = "failed";
		r.result = "failed";
		r.http = http;
		await this.writeRecord(op).catch((err) =>
			logger.error(`[composer] record write failed: ${(err as Error).message}`),
		);
		finishActive();
		await this.persist(op, "failed", { stage, segments_sent: segmentsSent, http });
		this.decideHttp(op, http);
		op.unlisten?.();
		op.unlisten = null;
		await this.tryRelease(op);
	}

	private async toEntered(op: LiveOp, finishActive: () => void): Promise<void> {
		const r = op.record;
		r.phase = "completed";
		r.state = "entered";
		await this.writeRecord(op).catch((err) =>
			logger.error(`[composer] record write failed: ${(err as Error).message}`),
		);
		finishActive();
		await this.persist(op, "entered", {});
		// Ack window (§8.1.7): the listener has been armed since `prepared`, so
		// a candidate may already be in; otherwise wait for one or for T_ack.
		if (op.candidates.size === 0) {
			await Promise.race([
				new Promise<void>((res) => {
					op.resolveAck = res;
				}),
				this.after(this.tAck),
			]);
		}
		await this.concludeAck(op);
	}

	// ── Ack (§8.1.7) ────────────────────────────────────────────────────────

	private armAck(op: LiveOp): void {
		const r = op.record;
		op.unlisten = this.deps.conversation.onPersistedEvent((st, cid, event) => {
			if (st !== r.sid || !this.isCandidate(event, r)) return;
			if (!op.candidates.has(cid))
				op.candidates.set(cid, { promptId: event.prompt_id, seq: event.seq });
			op.resolveAck?.();
		});
	}

	private isCandidate(event: PersistedEvent, r: PaneRecord): boolean {
		if (event.ev !== "user_prompt") return false;
		if (event.pane !== r.pane_id) return false;
		if (event.ts < r.prepared_at) return false;
		const d = event.data;
		if (d.source !== undefined && d.source !== "user") return false;
		if (d.origin === "unverified") return false;
		if (typeof d.prompt !== "string") return false;
		return textHash(normalizeText(d.prompt)) === r.text_hash;
	}

	/** Decide `result` from the candidates seen (live window or recovery scan). */
	private decideResult(op: LiveOp): {
		result: "delivered" | "misdelivered" | "unconfirmed";
		data: Record<string, unknown>;
		http: HttpResult;
	} {
		const r = op.record;
		const id = r.client_message_id;
		if (op.candidates.size === 1) {
			const [cid, c] = [...op.candidates.entries()][0]!;
			if (cid === r.cid) {
				const body = { result: "delivered", clientMessageId: id, promptId: c.promptId, seq: c.seq };
				return {
					result: "delivered",
					data: { prompt_id: c.promptId, seq: c.seq },
					http: { status: 202, body },
				};
			}
			const body = { result: "misdelivered", clientMessageId: id, conversation: cid };
			return {
				result: "misdelivered",
				data: { misdelivered_to: cid },
				http: { status: 202, body },
			};
		}
		// None, or more than one conversation: no unequivocal attribution.
		return {
			result: "unconfirmed",
			data: op.candidates.size > 1 ? { ambiguous: op.candidates.size } : {},
			http: { status: 202, body: { result: "unconfirmed", clientMessageId: id } },
		};
	}

	private async concludeAck(op: LiveOp): Promise<void> {
		op.unlisten?.();
		op.unlisten = null;
		const r = op.record;
		const d = this.decideResult(op);
		r.result = d.result;
		r.state = d.result;
		r.http = d.http;
		await this.writeRecord(op).catch((err) =>
			logger.error(`[composer] record write failed: ${(err as Error).message}`),
		);
		await this.persist(op, d.result, { ...d.data, http: d.http });
		this.decideHttp(op, d.http);
		await this.tryRelease(op);
	}

	// ── Release (§8.1.4 regla 7) ────────────────────────────────────────────

	/** `released` only with phase ≠ active, a final result and settled effects. */
	private async tryRelease(op: LiveOp): Promise<boolean> {
		const r = op.record;
		if (r.phase === "active" || !isFinalResult(r.result) || effectsOf(r) !== "settled")
			return false;
		const evidence = r.evidence ?? (r.execs.length === 0 ? "none-created" : "inspected");
		r.evidence = evidence;
		r.state = "released";
		if (r.http) this.recentFinals.set(`${r.cid}/${r.client_message_id}`, r.http);
		this.capRecentFinals();
		await this.persist(
			op,
			"released",
			{ evidence, http: r.http ?? null },
			{ confirmed: true },
		).catch((err) =>
			logger.error(`[composer] released event persist failed: ${(err as Error).message}`),
		);
		await this.deps.records
			.remove(r.sid, r.pane_id)
			.catch((err) =>
				logger.error(`[composer] pane record remove failed: ${(err as Error).message}`),
			);
		this.live.delete(op.key);
		return true;
	}

	private capRecentFinals(): void {
		while (this.recentFinals.size > IDEMPOTENCY_WINDOW * 4) {
			const k = this.recentFinals.keys().next().value;
			if (k === undefined) break;
			this.recentFinals.delete(k);
		}
	}

	private decideHttp(op: LiveOp, r: HttpResult): void {
		if (op.httpDecided) return;
		op.httpDecided = true;
		op.resolveHttp(r);
	}

	// ── Persistence helpers ─────────────────────────────────────────────────

	private async writeRecord(op: LiveOp): Promise<void> {
		op.record.updated_at = this.isoNow();
		await this.deps.records.write(op.record);
	}

	private async persist(
		op: LiveOp,
		state: OperationState,
		extra: Record<string, unknown>,
		opts: { confirmed?: boolean } = {},
	): Promise<void> {
		const r = op.record;
		this.stats.sendsByState[state] = (this.stats.sendsByState[state] ?? 0) + 1;
		const data: Record<string, unknown> = {
			client_message_id: r.client_message_id,
			state,
			result: r.result,
			effects: effectsOf(r),
			pane_id: r.pane_id,
			pane_pid: r.pane_pid,
			container_id: r.container_id,
			text_hash: r.text_hash,
			bytes: op.bytes,
			segments: op.segments,
			actor: op.actor,
			...extra,
		};
		const pending = {
			ev: "composer_send" as const,
			prompt_id: null,
			turn_id: null,
			agent_id: null,
			pane: r.pane_id,
			data,
		};
		await this.deps.store.open(r.sid, r.cid);
		let outcome = this.deps.store.enqueue(r.sid, r.cid, pending);
		if (outcome === "not_open") {
			await this.deps.store.open(r.sid, r.cid);
			outcome = this.deps.store.enqueue(r.sid, r.cid, pending);
		}
		if (outcome !== "queued") throw new Error(`composer_send ${state} not queued (${outcome})`);
		if (opts.confirmed) {
			// "Confirmed" = the line is in the file (§4.1). The store reports a
			// failed append as a drop, never as a thrown error, so the proof is
			// the failure counter not having moved across the flush.
			const failuresBefore = this.deps.store.stats.appendFailures;
			await this.deps.store.flush(r.sid, r.cid);
			if (this.deps.store.stats.appendFailures !== failuresBefore) {
				throw new Error("append failed while confirming the event");
			}
		}
	}

	// ── Container reads (preconditions) ─────────────────────────────────────

	private async readPaneState(containerId: string, paneId: string) {
		try {
			const res = await this.deps.docker.exec(
				containerId,
				paneStateArgv(paneId),
				null,
				async () => true,
			);
			if (res.exitCode !== 0) return null;
			return parsePaneState(res.stdout);
		} catch {
			return null;
		}
	}

	private async isDescendant(containerId: string, pid: number, panePid: number): Promise<boolean> {
		try {
			const res = await this.deps.docker.exec(
				containerId,
				ancestryArgv(pid, panePid),
				null,
				async () => true,
			);
			return res.exitCode === 0 && res.stdout.trim() === "yes";
		} catch {
			return false;
		}
	}

	private async readInputRegion(containerId: string, paneId: string) {
		try {
			const res = await this.deps.docker.exec(
				containerId,
				captureArgv(paneId),
				null,
				async () => true,
			);
			if (res.exitCode !== 0) return { kind: "unknown" as const, reason: "capture-failed" };
			return inputRegion(res.stdout);
		} catch {
			return { kind: "unknown" as const, reason: "capture-failed" };
		}
	}

	// ── Recovery (§8.1.4 regla 8) ───────────────────────────────────────────

	/**
	 * Rebuild the exclusion from the pane records before admitting a send:
	 * an `active` record belongs to a dead process and is cancelled; pending
	 * execs are settled by evidence where possible; `entered` operations get
	 * their deferred ack from the persisted events. Once per session per
	 * process; the admin surface runs it again on demand.
	 */
	async recover(sid: string, opts: { force?: boolean } = {}): Promise<void> {
		if (this.recovered.has(sid) && !opts.force) return;
		this.recovered.add(sid);
		const { records } = await this.deps.records.list(sid);
		for (const record of records) {
			if (this.live.has(this.key(sid, record.pane_id))) continue; // ours, live
			const key = this.key(sid, record.pane_id);
			await this.lock
				.run(key, "composer-admin", async () => this.recoverOne(record), { mode: "fail" })
				.catch((err) => {
					if (!(err instanceof SessionBusyError))
						logger.warn(
							`[composer] recovery failed for ${sid} ${record.pane_id}: ${(err as Error).message}`,
						);
				});
		}
	}

	private adoptRecord(record: PaneRecord): LiveOp {
		const op = newLiveOp({
			key: this.key(record.sid, record.pane_id),
			record,
			bytes: 0,
			segments: 0,
			actor: "owner",
			cancelled: record.phase === "cancelled",
			candidates: new Map(),
			resolveAck: null,
			unlisten: null,
		});
		op.httpDecided = true;
		op.markActiveDone();
		return op;
	}

	private async recoverOne(record: PaneRecord): Promise<void> {
		const op = this.adoptRecord(record);
		const r = op.record;
		if (r.phase === "active") {
			// Its executor died with the previous process: cancelled, never resumed.
			op.cancelled = true;
			r.phase = "cancelled";
			r.cancelled_at = this.isoNow();
			r.cancel_reason = "orphaned";
			if (r.state === "prepared") r.state = "uncertain";
			await this.writeRecord(op);
			await this.persist(op, "uncertain", {
				orphaned: true,
				pending: r.execs.filter((e) => !e.settled).map((e) => ({ id: e.id, step: e.step })),
			}).catch(() => undefined);
		}
		await this.settleAndConclude(op);
	}

	/**
	 * Settle pending execs by evidence (§8.1.4 regla 5), derive the result an
	 * `uncertain` operation now admits, run the deferred ack for an
	 * `entered` one, and release when everything allows it.
	 */
	private async settleAndConclude(op: LiveOp): Promise<void> {
		const r = op.record;
		const changed = await this.settleEffects(r);
		if (changed) await this.writeRecord(op).catch(() => undefined);
		if (r.phase === "cancelled" && !isFinalResult(r.result) && effectsOf(r) === "settled") {
			const enter = r.execs.find((e) => e.step === "enter");
			if (enter?.settled && enter.settled.exit_code === 0) {
				r.state = "entered";
				await this.writeRecord(op).catch(() => undefined);
				await this.persist(op, "entered", { deferred: true }).catch(() => undefined);
			} else {
				const last = r.execs[r.execs.length - 1];
				const http: HttpResult = {
					status: 502,
					body: {
						error: "delivery-failed",
						stage: last?.step ?? "paste",
						segmentsSent: r.execs.filter((e) => e.step === "paste" && e.settled?.exit_code === 0)
							.length,
					},
				};
				r.state = "failed";
				r.result = "failed";
				r.http = http;
				await this.writeRecord(op).catch(() => undefined);
				await this.persist(op, "failed", { stage: last?.step ?? "paste", http }).catch(
					() => undefined,
				);
			}
		}
		if (r.state === "entered" && !isFinalResult(r.result)) {
			if (this.live.has(op.key) && this.live.get(op.key) !== op) return; // the live executor owns its ack
			await this.deferredAck(op);
		}
		await this.tryRelease(op);
	}

	private async settleEffects(r: PaneRecord): Promise<boolean> {
		let changed = false;
		for (const e of r.execs) {
			if (e.settled) continue;
			const st = await this.deps.docker.execState(e.id).catch(() => null);
			if (st && !st.running && st.exitCode !== null) {
				e.settled = { exit_code: st.exitCode, at: this.isoNow() };
				changed = true;
			}
		}
		if (r.execs.some((e) => !e.settled)) {
			const cs = await this.deps.docker
				.containerState(r.container_id)
				.catch(() => "running" as const);
			let gone = cs !== "running";
			if (!gone) {
				const meta = await this.deps.sessions.getOrThrow(r.sid).catch(() => null);
				if (meta && meta.containerId !== r.container_id) gone = true;
			}
			if (gone) {
				for (const e of r.execs) if (!e.settled) e.settled = { exit_code: -1, at: this.isoNow() };
				r.evidence = "container-gone";
				changed = true;
			}
		}
		return changed;
	}

	/** The ack over persisted events (§8.1.7): candidates with ts > prepared_at and the same pane. */
	private async deferredAck(op: LiveOp): Promise<void> {
		const r = op.record;
		const cids = await this.deps.store.listConversationIds(r.sid).catch(() => [] as string[]);
		for (const cid of cids) {
			// The current file and its rotated predecessor (§4.4 L7): a candidate
			// that landed just before a rotation is still evidence.
			const events = await this.deps.store
				.readEvents(r.sid, cid, 0, Number.MAX_SAFE_INTEGER, { archive: true })
				.catch(() => []);
			for (const ev of events) {
				if (this.isCandidate(ev, r) && !op.candidates.has(cid))
					op.candidates.set(cid, { promptId: ev.prompt_id, seq: ev.seq });
			}
		}
		const enteredAt = r.updated_at;
		if (op.candidates.size === 0 && this.now() - Date.parse(enteredAt) < this.tAck) {
			// Still inside the window and nothing persisted yet: a live op is
			// already waiting in its own ack path; a recovered one gets one
			// background wait that concludes later. Never block the caller.
			if (this.live.has(op.key) || op.ackWaiting) return;
			op.ackWaiting = true;
			this.live.set(op.key, op);
			this.armAck(op);
			void (async () => {
				if (op.candidates.size === 0) {
					await Promise.race([
						new Promise<void>((res) => {
							op.resolveAck = res;
						}),
						this.after(this.tAck),
					]);
				}
				op.unlisten?.();
				op.unlisten = null;
				await this.concludeAck(op).catch((err) =>
					logger.error(`[composer] deferred ack failed: ${(err as Error).message}`),
				);
			})();
			return;
		}
		const d = this.decideResult(op);
		r.result = d.result;
		r.state = d.result;
		r.http = d.http;
		await this.writeRecord(op).catch(() => undefined);
		await this.persist(op, d.result, { ...d.data, http: d.http, deferred: true }).catch(
			() => undefined,
		);
	}

	// ── Admin (§8.1.11) ─────────────────────────────────────────────────────

	async panes(sid: string): Promise<{ panes: PaneView[]; unreadable: string[] }> {
		const { records, unreadable } = await this.deps.records.list(sid);
		return {
			panes: records.map((r) => ({
				paneId: r.pane_id,
				clientMessageId: r.client_message_id,
				cid: r.cid,
				phase: r.phase,
				result: r.result,
				effects: effectsOf(r),
				pending: r.execs.filter((e) => !e.settled).map((e) => ({ id: e.id, step: e.step })),
				since: r.prepared_at,
			})),
			unreadable,
		};
	}

	async resolve(input: ResolveInput): Promise<HttpResult> {
		if (!this.deps.enabled) throw new ComposerDisabledError();
		const { stSessionId: sid, paneId } = input;
		const key = this.key(sid, paneId);
		try {
			return await this.lock.run(
				key,
				"composer-admin",
				async () => {
					const read = await this.deps.records.read(sid, paneId);
					if (read.kind === "unreadable")
						return this.reject("unverifiable", 409, { detail: read.error });
					if (read.kind === "none") return { status: 404, body: { error: "no-operation" } };
					const record = read.record;
					if (record.client_message_id !== input.clientMessageId) {
						return this.reject("no-operation", 404, { clientMessageId: record.client_message_id });
					}
					// A live active executor holds the lock, so an `active` record
					// here is an orphan of a dead process: cancel it (regla 8).
					const op = this.live.get(key) ?? this.adoptRecord(record);
					if (op.record.phase === "active") {
						op.cancelled = true;
						op.record.phase = "cancelled";
						op.record.cancelled_at = this.isoNow();
						op.record.cancel_reason = "orphaned";
						if (op.record.state === "prepared") op.record.state = "uncertain";
						await this.writeRecord(op);
					}
					if (input.outcome !== "reconcile") {
						if (isFinalResult(op.record.result))
							return this.reject("not-pending", 409, this.view(op.record));
						try {
							await input.audit();
						} catch (err) {
							logger.error(
								`[composer] resolve audit failed, nothing written: ${(err as Error).message}`,
							);
							return this.reject("audit-failed", 500);
						}
						op.record.result = "resolved";
						op.record.state = "resolved";
						op.record.http = {
							status: 202,
							body: {
								result: "resolved",
								clientMessageId: op.record.client_message_id,
								outcome: input.outcome,
							},
						};
						await this.writeRecord(op);
						await this.persist(op, "resolved", {
							outcome: input.outcome,
							by: input.by,
							http: op.record.http,
						}).catch(() => undefined);
					}
					await this.settleAndConclude(op);
					const released = !(await this.deps.records
						.read(sid, paneId)
						.then((x) => x.kind === "ok"));
					return { status: 200, body: { ...this.view(op.record), released } };
				},
				{ mode: "fail" },
			);
		} catch (err) {
			if (err instanceof SessionBusyError) return this.reject("operation-active", 409);
			throw err;
		}
	}

	private view(r: PaneRecord): Record<string, unknown> {
		return {
			phase: r.phase,
			result: r.result,
			effects: effectsOf(r),
			pending: r.execs.filter((e) => !e.settled).map((e) => ({ id: e.id, step: e.step })),
		};
	}

	/** The last `capture.effective` the list route computed for a session (orientative `canSendInput`). */
	private readonly lastCapture = new Map<string, boolean>();
	noteCapture(sid: string, effective: boolean): void {
		this.lastCapture.set(sid, effective);
	}
	lastCaptureEffective(sid: string): boolean | null {
		return this.lastCapture.get(sid) ?? null;
	}

	/**
	 * Process shutdown: stop observing. Live operations keep their records on
	 * disk; the next process cancels and recovers them (§8.1.4 regla 8).
	 */
	shutdown(): void {
		for (const op of this.live.values()) {
			op.unlisten?.();
			op.unlisten = null;
		}
	}

	/** Stats for `GET /api/admin/stats → conversation.composer` (no titles, no ids). */
	async adminStats(): Promise<Record<string, unknown>> {
		let blocked = 0;
		let pending = 0;
		let unverifiable = 0;
		const sids = await this.deps.records.sessionsWithRecords().catch(() => [] as string[]);
		for (const sid of sids) {
			const { records, unreadable } = await this.deps.records
				.list(sid)
				.catch(() => ({ records: [], unreadable: ["?"] }));
			if (unreadable.length > 0) unverifiable++;
			blocked += records.length;
			pending += records.filter((r) => effectsOf(r) === "pending").length;
		}
		return {
			sendsSinceBoot: { byState: this.stats.sendsByState },
			rejectedSinceBoot: { byCode: this.stats.rejectedByCode },
			blockedPanesNow: blocked,
			effectsPendingNow: pending,
			unverifiableSessionsNow: unverifiable,
		};
	}
}
