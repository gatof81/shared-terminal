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
	abortHttpCode,
	BG_CLIENT_ARGV,
	type InspectResult,
	inspectFault,
	inspectStdin,
	parseInspectOutput,
	parseReplyOutput,
	type ReplyOutcome,
	replyStdin,
	SHORT_RE,
} from "./bgTransport.js";
import {
	exeInodeArgv,
	exeLinkArgv,
	type LiveVersion,
	LiveVersionCache,
	parseInode,
	parseStarttime,
	parseUids,
	readLiveCliVersion,
	statArgv,
	statusArgv,
} from "./cliIdentity.js";

/** Host-side bound per live-version exec (in-container: `timeout -k 1 3` / `-k 2 5`). */
const LIVE_EXEC_DEADLINE_MS = 10_000;
function withDeadline<T>(p: Promise<T>, ms: number, onExpire?: () => void): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			onExpire?.();
			reject(new Error("live-version exec deadline"));
		}, ms);
		timer.unref?.();
	});
	// The losing promise is left to settle on its own (never aborted).
	p.catch(() => undefined);
	return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

import {
	type CliPolicy,
	decide,
	describePolicy,
	exactPolicy,
	parseExact,
	ruleText,
} from "./cliPolicy.js";
import {
	BG_ACK_POLL_MS,
	BG_EVENT_SCAN,
	BG_JOB_CHECK_MS,
	type BgCandidate,
	DEFAULT_BG_CONFIG_DIR,
	duplicateAfter,
	hookCandidates,
	ourEnqueueLatencyMs,
	parseTranscript,
	pendingSameContent,
	T_ACK_BG_MS,
	TRANSCRIPT_TAIL_BYTES,
	type TranscriptPort,
	transcriptConfirms,
	transcriptPathOf,
	unacknowledgedUnconfirmed,
} from "./composerBg.js";
import {
	CONSUME_MAX_POLLS,
	CONSUME_POLL_MS,
	captureArgv,
	DEFAULT_CLI_VERSIONS,
	foregroundFault,
	IDEMPOTENCY_WINDOW,
	inputRegion,
	inputRegionPlain,
	isClaudeExe,
	normalizeText,
	paneFactsArgv,
	parsePaneFacts,
	pasteConsumed,
	segment,
	stepArgv,
	T_ACK_MS,
	T_HTTP_MS,
	textHash,
	UUID_V4_RE,
	validateBody,
} from "./composerText.js";
import {
	type ExecStep,
	type JobTarget,
	jobKey,
	type OperationResult,
	type OperationState,
	type PaneRecord,
	type PaneRecordStore,
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
		/** `user`: run as that uid (the live-version query, never root). Default: the image's USER. */
		opts?: { user?: string },
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
	/** `COMPOSER_CLI_VERSIONS` alone (§8.1.9); ignored when `cliPolicy` is given. */
	cliVersions?: ReadonlySet<string>;
	/** Exact list + optional open minimum + deny list (§8.1.9, v1.8.3). */
	cliPolicy?: CliPolicy;
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
	/** Host-side bound per live-version exec (§8.1.9); tests shorten it. */
	liveExecDeadlineMs?: number;
	/**
	 * v1.9 §8.1.12 (EXPERIMENTAL): the background-session transport. Absent
	 * or `enabled: false` ⇒ a pane-less conversation is refused exactly as
	 * before (`not-interactive`) and nothing below runs.
	 */
	bg?: BgDeps;
}

export interface BgDeps {
	enabled: boolean;
	/** `COMPOSER_BG_CLI_VERSIONS`: exact, no minimum, default empty. */
	versions: ReadonlySet<string>;
	transcripts: TranscriptPort;
	/**
	 * `COMPOSER_BG_SESSIONS` (round 2, canary): the st session ids the
	 * transport applies to. Empty ⇒ none (fail closed): the global flag alone
	 * never opens it for every session.
	 */
	sessions: ReadonlySet<string>;
	/**
	 * The only CLI config dir supported (D3): the container's default
	 * `~/.claude` (`/home/developer/.claude`). A worker running with another
	 * CLAUDE_CONFIG_DIR is refused (`unsupported-config-dir`); nothing is
	 * inferred. The sandbox smoke passes its own.
	 */
	configDir?: string;
	/** Test seams. */
	tAckBgMs?: number;
	pollMs?: number;
	jobCheckMs?: number;
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
	/**
	 * v1.9 §8.1.12.8: present (only with the background transport on) for a
	 * pane-less conversation, where a send goes through the CLI daemon if the
	 * fresh probe confirms a background session. Orientative, like the rest.
	 */
	transport?: "background";
	composer: {
		blocked: boolean;
		reason?: "in-progress" | "effects-pending" | "unverifiable";
		clientMessageId?: string;
		result?: OperationResult;
		since?: string;
	};
}

/** `COMPOSER_CLI_VERSIONS`: comma-separated; empty/unset ⇒ the validated default. */
/** `CONVERSATION_COMPOSER_ENABLED`: only `true` / `1` turn the composer on; unset or empty (compose's `:-` default) keeps it off. */
export function composerFlagEnabled(raw: string | undefined): boolean {
	return raw === "true" || raw === "1";
}

/** `COMPOSER_CLI_VERSIONS` alone (the exact list); see cliPolicy.ts for the whole policy. */
export function parseCliVersions(raw: string | undefined): Set<string> {
	return parseExact(raw);
}

/** Events read per conversation (newest) when an ack is re-evaluated after the fact. */
const DEFERRED_ACK_SCAN = 4096;

/**
 * The bare `X.Y.Z` of a conversation's `claudeVersion`, which is the
 * SessionStart hook's raw `claude --version` output ("2.1.314 (Claude Code)")
 * — the string COMPOSER_CLI_VERSIONS is compared with. Null when absent or
 * not starting with a version (the 3.2 pilot on VM100 found the composer
 * refusing every conversation with `cli-unvalidated` for this mismatch).
 */
export function cliVersionOf(raw: string | null | undefined): string | null {
	const m = raw?.match(/^\s*(\d+\.\d+\.\d+)/);
	return m ? m[1]! : null;
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
	/**
	 * This operation's record writes still in flight (temp file, fsync,
	 * rename, directory fsyncs). A release, a cancellation or a settlement
	 * drains them first: a write that landed late must never replace the
	 * successor's record, and the record on disk must never end up older
	 * than the state that was written after it (§8.1.4.1). Filesystem only —
	 * never a Docker answer.
	 */
	writes: Set<Promise<void>>;
	/** Resolves when the executor leaves the active phase (entered / failed / cancelled). */
	activeDone: Promise<void>;
	markActiveDone: () => void;
	/** v1.9 §8.1.12: the background transport's ack watch (job records only). */
	bg?: BgWatch;
	/** A reply exec that answered after the executor was cancelled (evidence, this process only). */
	bgLate?: ReplyOutcome;
}

type BgVerdict =
	| { kind: "delivered"; promptId: string; seq: number; enqueueMs?: number | null }
	| { kind: "misdelivered"; conversation: string }
	| { kind: "unconfirmed"; detail: string }
	| { kind: "none"; pending: boolean; transcriptMissing?: boolean };

interface BgWatch {
	t0Ms: number;
	/** `accepted` with no ack by then ⇒ `unconfirmed`. null = no expiry (uncertain). */
	deadlineMs: number | null;
	timers: Array<ReturnType<typeof setTimeout>>;
	evaluating: boolean;
	again: boolean;
	stopped: boolean;
	lastJobCheckMs: number;
	/** The last evaluation found a hook candidate but could not read its transcript (D2). */
	transcriptMissing?: boolean;
}

function newLiveOp(
	base: Omit<
		LiveOp,
		"http" | "resolveHttp" | "httpDecided" | "activeDone" | "markActiveDone" | "writes"
	>,
): LiveOp {
	let resolveHttp!: (r: HttpResult) => void;
	const http = new Promise<HttpResult>((r) => {
		resolveHttp = r;
	});
	let markActiveDone!: () => void;
	const activeDone = new Promise<void>((r) => {
		markActiveDone = r;
	});
	return {
		...base,
		writes: new Set<Promise<void>>(),
		http,
		resolveHttp,
		httpDecided: false,
		activeDone,
		markActiveDone,
	};
}

/** D1: the unconfirmed send a new background send acknowledges (`acknowledgeUnconfirmed`, a UUID). */
function ackOf(body: unknown): string | null {
	const v = (body as { acknowledgeUnconfirmed?: unknown } | null)?.acknowledgeUnconfirmed;
	return typeof v === "string" && UUID_V4_RE.test(v) ? v.toLowerCase() : null;
}

const effectsOf = (r: PaneRecord): "settled" | "pending" =>
	r.execs.every((e) => e.settled !== null) ? "settled" : "pending";

const isFinalResult = (r: OperationResult): boolean => r !== "pending";

export class ComposerService {
	private readonly lock = new SessionLifecycleLock();
	private readonly live = new Map<string, LiveOp>();
	/** Graceful shutdown began: no new operation is admitted (503 `shutting-down`). */
	private stopping = false;
	/** Finals of this process, consulted before the index (which lags a flush). */
	private readonly recentFinals = new Map<string, HttpResult>();
	private readonly recovered = new Set<string>();
	private readonly userSends = new Map<string, number[]>();
	private readonly cliPolicy: CliPolicy;
	private readonly liveVersions = new LiveVersionCache();
	/** Live-version execs past their deadline and not yet settled, per container. */
	private readonly liveHung = new Map<string, number>();
	private readonly now: () => number;
	private readonly after: (ms: number) => Promise<void>;
	private readonly tHttp: number;
	private readonly tAck: number;
	private readonly rate: number;
	readonly stats = {
		sendsByState: {} as Record<string, number>,
		rejectedByCode: {} as Record<string, number>,
		/** State events the store did not take (L6/open); the records stay authoritative. */
		persistFailures: 0,
	};

	constructor(private readonly deps: ComposerDeps) {
		this.cliPolicy = deps.cliPolicy ?? exactPolicy(deps.cliVersions ?? DEFAULT_CLI_VERSIONS);
		this.now = deps.now ?? (() => Date.now());
		this.after = deps.after ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.tHttp = deps.tHttpMs ?? T_HTTP_MS;
		this.tAck = deps.tAckMs ?? T_ACK_MS;
		this.rate = deps.userRatePerMinute ?? 30;
	}

	get enabled(): boolean {
		return this.deps.enabled;
	}

	/** v1.9 §8.1.12 (EXPERIMENTAL): the background transport is on. */
	get bgEnabled(): boolean {
		return this.deps.enabled && this.deps.bg?.enabled === true;
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
		indexes: Array<
			Pick<ConversationIndex, "cid" | "kind" | "paneId"> & { endedAt?: string | null }
		>,
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
		const bgOn = this.deps.bg?.enabled === true && this.deps.bg.sessions.has(stSessionId);
		for (const i of indexes) {
			// v1.9 §8.1.12: a pane-less conversation can only be blocked by a job
			// record naming it (the job's short is known only to a probe).
			const bgCandidate =
				bgOn && !i.paneId && (i.kind === "interactive" || i.kind === "unknown") && !i.endedAt;
			const rec = i.paneId
				? byPane.get(i.paneId)
				: bgCandidate
					? records.find((r) => r.job && r.cid === i.cid)
					: undefined;
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
			if (bgCandidate) {
				out.set(i.cid, {
					canSendInput:
						opts.captureEffective === true && !composer.blocked && opts.callerMayOperate,
					transport: "background",
					composer,
				});
				continue;
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
		if (this.stopping) return this.reject("shutting-down", 503);
		const startedAt = this.now();
		const { stSessionId: sid, cid, callerId, meta } = input;
		const v = validateBody(input.body);
		if (!v.ok) return this.reject(v.code, 400);
		const clientMessageId = v.clientMessageId as string;
		if (!this.takeRate(callerId)) return this.reject("rate-limited", 429);

		const index = await this.deps.store.peekIndex(sid, cid).catch(() => null);
		if (!index) return { status: 404, body: { error: "Conversation not found" } };

		// Recovery first (§8.1.4 regla 8): never admit a send before the
		// exclusion is rebuilt from the records.
		try {
			await this.recover(sid);
		} catch (err) {
			logger.warn(`[composer] recovery failed for ${sid}: ${(err as Error).message}`);
			return this.reject("send-in-progress", 409, { detail: "unverifiable" });
		}
		const { records, unreadable } = await this.deps.records.list(sid);
		if (unreadable.length > 0) {
			return this.reject("send-in-progress", 409, { detail: "unverifiable" });
		}
		// The same id pending anywhere in the session: its own state, no effect.
		const pendingSame = records.find((r) => r.client_message_id === clientMessageId);
		if (pendingSame) return this.uncertainAnswer(pendingSame);
		// A released id in the window: the recorded answer. The window is read
		// from the store, never from the snapshot alone: a snapshot whose write
		// failed (#546) misses `released` lines the events file holds, and an
		// id treated as new there would be a second delivery.
		let replay: { status: number; body: unknown } | null | undefined = this.recentFinals.get(
			`${cid}/${clientMessageId}`,
		);
		if (!replay) {
			try {
				replay = await this.deps.store.releasedComposerSend(sid, cid, clientMessageId);
			} catch (err) {
				logger.warn(
					`[composer] idempotency window unreadable for ${cid}: ${(err as Error).message}`,
				);
				return this.reject("send-in-progress", 409, { detail: "unverifiable" });
			}
		}
		if (replay) return { status: replay.status, body: replay.body as Record<string, unknown> };

		// v1.9 §8.1.12 (EXPERIMENTAL, flag-gated): a pane-less conversation may
		// be a CLI background session; only the fresh probe can say so. With
		// the flag off this branch does not exist and the refusal below is
		// today's, byte for byte.
		if (
			this.deps.bg?.enabled &&
			this.deps.bg.sessions.has(sid) &&
			!index.paneId &&
			(index.kind === "interactive" || index.kind === "unknown")
		) {
			return this.sendBackground({
				sid,
				cid,
				callerId,
				meta,
				index,
				records,
				clientMessageId,
				normalized: v.normalized,
				bytes: v.bytes,
				segments: v.segments,
				audit: input.audit,
				startedAt,
				acknowledge: ackOf(input.body),
			});
		}
		if (index.kind !== "interactive" || !index.paneId) return this.reject("not-interactive", 409);
		const paneId = index.paneId;
		let blocker = records.find((r) => r.pane_id === paneId);
		if (blocker) {
			// A final, settled operation whose record removal failed earlier is
			// still ours: it is re-evaluated UNDER the pane lock, in the active
			// phase (§8.1.4.1), never here — a release outside the exclusion
			// could run late and take a successor's record with it.
			const live = this.live.get(this.key(sid, paneId));
			if (
				live &&
				live.record.client_message_id === blocker.client_message_id &&
				live.record.phase !== "active" &&
				isFinalResult(live.record.result) &&
				effectsOf(live.record) === "settled"
			)
				blocker = undefined;
		}
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
		// T_http bounds the WHOLE request (§8.1.4 regla 4), preconditions
		// included: a Docker query that hangs there answers 202 `uncertain`
		// too, and the active phase then refuses to start (nothing written).
		const ctl = { expired: false };
		const deadline = this.after(this.tHttp).then(() => ({ kind: "deadline" as const }));
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
						startedAt,
						ctl,
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
			deadline,
		]);
		if (first.kind === "deadline") {
			ctl.expired = true;
			this.stats.sendsByState.uncertain = (this.stats.sendsByState.uncertain ?? 0) + 1;
			run.catch((err) => logger.error(`[composer] active phase failed: ${(err as Error).message}`));
			return { status: 202, body: { result: "uncertain", clientMessageId } };
		}
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
		// v1.9 §8.1.12.6: a job record handed to the worker is `accepted` — the
		// same id asked again learns exactly that, never `uncertain`. Pane
		// records never reach this state.
		if (r.job && r.state === "accepted") {
			return {
				status: 202,
				body: {
					result: "accepted",
					clientMessageId: r.client_message_id,
					effects: effectsOf(r),
					state: r.state,
				},
			};
		}
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
		/** When the request began: T_http is measured from here, not from `prepared`. */
		startedAt: number;
		/** The request's deadline passed (answered 202 `uncertain`): start nothing. */
		ctl: { expired: boolean };
	}): Promise<HttpResult | LiveOp> {
		const { sid, cid, paneId, clientMessageId } = a;
		// Under the lock: the record must still be absent — or be ours, final
		// and settled with a removal that failed earlier, in which case the
		// release is retried HERE, under the same exclusion that will write
		// the next `prepared` (§8.1.4.1; a release outside it could run late).
		let again = await this.deps.records.read(sid, paneId);
		if (again.kind === "ok") {
			const live = this.live.get(this.key(sid, paneId));
			if (live && live.record.client_message_id === again.record.client_message_id) {
				if (await this.tryRelease(live, true)) again = await this.deps.records.read(sid, paneId);
			}
		}
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
		// v1.7.2 §8.1.3: the entry must be the INTERACTIVE process reading the
		// pane's prompt. A background job (e.g. a parked session continued as a
		// daemon job) can descend from the pane's pid and pass the ancestry
		// check below, while the text would land in the parked prompt of the
		// process that no longer runs this conversation.
		if (entry.kind !== "interactive") {
			return this.reject("binding-stale", 409, { detail: `kind:${entry.kind}` });
		}
		if (typeof entry.pid !== "number") return this.reject("binding-stale", 409);
		// One read of the pane and of the probed process (§8.1.3): nothing
		// readable, or the pid not under the pane ⇒ the binding is stale.
		const facts = await this.readPaneFacts(containerId, paneId, entry.pid);
		if (!facts?.ancestry) return this.reject("binding-stale", 409);
		const paneState = facts.pane;
		if (entry.status === "busy") return this.reject("busy", 409);
		if (entry.waitingFor !== undefined && entry.waitingFor !== "input needed") {
			return this.reject("needs-terminal", 409, { detail: entry.waitingFor });
		}
		// v1.7.4 §8.1.3 (#510): the probe must CONFIRM the CLI is at its
		// prompt — `idle`, or `waiting` for "input needed". A missing or
		// unreadable status (parseAgentsJson leaves it undefined) and a
		// `waiting` with no `waitingFor` prove nothing: §8.2 never observed a
		// `waiting` without one, so its absence is not taken as "input
		// needed". Without this the visible-prompt check below was the only
		// evidence of an interactive state. Refused here, before any effect.
		const atPrompt =
			entry.status === "idle" ||
			(entry.status === "waiting" && entry.waitingFor === "input needed");
		if (!atPrompt) {
			return this.reject("needs-terminal", 409, {
				detail: entry.status === "waiting" ? "waiting-unspecified" : "status-unknown",
			});
		}
		if (paneState.inMode) return this.reject("needs-terminal", 409, { detail: "copy-mode" });
		if (paneState.dead) return this.reject("needs-terminal", 409, { detail: "pane-dead" });
		// Claude must own the terminal: identity, session, tty and foreground
		// process group — never the pane command's NAME (the native install
		// runs a binary named after its version, `2.1.316`).
		const fault = foregroundFault(facts, entry.pid);
		if (fault) {
			logger.info(
				`[composer] ${sid} ${paneId}: not sending, Claude pid ${entry.pid} is not in the foreground (${fault}; pane command ${paneState.command})`,
			);
			return this.reject("needs-terminal", 409, { detail: `foreground:${paneState.command}` });
		}
		// pid + starttime + exe: an execve keeps the first two, so the binary
		// the version was established for is part of the identity too.
		const identity = { pid: entry.pid, start: facts.proc.start, exe: facts.exe };
		const region = await this.readInputRegion(containerId, paneId);
		if (region.kind !== "empty") {
			return this.reject("composer-not-empty", 409, {
				detail: region.kind === "unknown" ? region.reason : "text",
			});
		}
		// §8.1.9 v1.8.2: the version of the PROCESS that will receive the text,
		// asked of its own binary — never the hook's `claude_version`, which
		// came from PATH (Educación HZ: process 2.1.316, hook 2.1.317). The
		// cache only saves the query for the process the checks above just
		// verified (its key is that pid's starttime and exe).
		const hookVersion = cliVersionOf(a.index.claudeVersion);
		const live = await this.liveVersion(containerId, entry.pid, facts.proc.start, facts.exe);
		if (!live.ok) {
			logger.info(
				`[composer] ${sid} ${paneId}: not sending, the CLI version of pid ${entry.pid} cannot be verified (${live.why}; hook reported ${JSON.stringify(a.index.claudeVersion ?? null)})`,
			);
			return this.reject("cli-unvalidated", 409, {
				version: null,
				reportedVersion: a.index.claudeVersion ?? null,
				detail: `unverifiable:${live.why}`,
			});
		}
		if (hookVersion !== live.version) {
			logger.info(
				`[composer] ${sid} ${paneId}: pid ${entry.pid} runs CLI ${live.version}; its session_start reported ${JSON.stringify(a.index.claudeVersion ?? null)} (metadata only, not used)`,
			);
		}
		// §8.1.9 v1.8.3: deny → exact list → open minimum, on the LIVE version.
		const cli = decide(this.cliPolicy, live.version);
		if (!cli.ok) {
			logger.info(
				`[composer] ${sid} ${paneId}: not sending, CLI ${live.version} of pid ${entry.pid} ${cli.why} (${describePolicy(this.cliPolicy)})`,
			);
			return this.reject("cli-unvalidated", 409, {
				version: live.version,
				reportedVersion: a.index.claudeVersion ?? null,
				detail: cli.why,
			});
		}
		logger.info(
			`[composer] ${sid} ${paneId} ${clientMessageId}: CLI ${live.version} of pid ${entry.pid} authorized by ${ruleText(this.cliPolicy, cli)}`,
		);

		// ── Audit before any effect (§8.1.1), fail-closed ──
		// A shutdown that began during the preconditions is decided before the
		// audit row too: a refused request leaves no row.
		if (this.stopping) return this.reject("shutting-down", 503);
		const actor: "owner" | "admin" = a.meta.userId === a.callerId ? "owner" : "admin";
		if (actor === "admin") {
			try {
				await a.audit();
			} catch (err) {
				logger.error(`[composer] operate audit failed, nothing sent: ${(err as Error).message}`);
				return this.reject("audit-failed", 500);
			}
		}

		// The request already answered `uncertain` at T_http: no effect, no
		// record, no audit row — the id was never an operation (a retry is new).
		if (a.ctl.expired) return this.reject("timeout", 409);
		// Shutdown began while the preconditions were in flight (they await
		// Docker): decided HERE, synchronously with the record's creation, not
		// on a flag read before those awaits. Nothing is written.
		if (this.stopping) return this.reject("shutting-down", 503);

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
		// Live BEFORE the durable record: from here on a shutdown cancels this
		// op like any other (its scan runs until no active op is left), so the
		// window between `prepared` and the executor's first `mayAct` is covered.
		this.live.set(op.key, op);
		const withdraw = async () => {
			op.unlisten?.();
			op.unlisten = null;
			if (this.live.get(op.key) === op) this.live.delete(op.key);
			await this.deps.records.remove(sid, paneId, clientMessageId).catch(() => undefined);
		};
		try {
			await this.deps.records.write(record);
		} catch (err) {
			// Not durable (a failed fsync may still have left the file): never
			// let a half-written record block the pane.
			logger.error(`[composer] pane record write failed: ${(err as Error).message}`);
			await withdraw();
			return this.reject("persist-failed", 503);
		}
		// The ack observation starts here, before any effect (§8.1.7).
		this.armAck(op);
		try {
			await this.persist(op, "prepared", {}, { confirmed: true });
		} catch (err) {
			logger.error(`[composer] prepared event persist failed: ${(err as Error).message}`);
			await withdraw();
			return this.reject("persist-failed", 503);
		}
		a.announce(op);
		// Shutdown landed during those two writes: the record exists and is
		// cancelled durably (by shutdown's scan, or here if it has not reached
		// this op yet); the executor never starts. Both writes happened after
		// `stopping` was set, so the record on disk may say `active` — the
		// cancelled state is rewritten on top.
		if (this.stopping || op.cancelled) {
			if (!op.cancelled) await this.cancelActive(op, "shutdown");
			else
				await this.writeRecord(op).catch((err) =>
					logger.error(`[composer] record write failed: ${(err as Error).message}`),
				);
			return op;
		}

		// ── Effects ──
		// The HTTP answer: what remains of the request's T_http races the
		// operation's own decision; at the deadline the cancellation is
		// COMPLETED by the timer (record + exclusion), not merely requested.
		void this.after(Math.max(0, this.tHttp - (this.now() - a.startedAt))).then(() =>
			this.onTHttp(op).catch((err) =>
				logger.error(`[composer] T_http handling failed: ${(err as Error).message}`),
			),
		);
		void this.runEffects(op, a.normalized, paneState.panePid, identity).catch((err) => {
			logger.error(`[composer] effects loop failed: ${(err as Error).message}`);
		});
		// `runEffects` ends the active phase; the lock is held exactly until then.
		await op.activeDone;
		return op;
	}

	/**
	 * T_http (§8.1.4 regla 4): the request is answered `uncertain` and, if the
	 * executor is still active, the cancellation is applied here and now —
	 * record `phase: cancelled`, state `uncertain`, the exclusion released —
	 * because the executor may be stuck in an effect whose promise never
	 * answers. The durable record keeps the pane blocked by its pending
	 * effects, which `reconcile` can now settle by evidence (the lock is no
	 * longer held forever). A late answer of the effect records its evidence
	 * (`afterCancelled`) and starts nothing.
	 */
	private async onTHttp(op: LiveOp): Promise<void> {
		const r = op.record;
		this.decideHttp(op, {
			status: 202,
			body: { result: "uncertain", clientMessageId: r.client_message_id },
		});
		if (r.phase !== "active" || op.cancelled) return;
		await this.cancelActive(op, "t-http");
	}

	/** Apply a cancellation to an ACTIVE op from outside the executor (T_http, shutdown). */
	private async cancelActive(op: LiveOp, reason: string): Promise<void> {
		const r = op.record;
		// A request still waiting on this operation learns the outcome is unknown.
		this.decideHttp(op, {
			status: 202,
			body: { result: "uncertain", clientMessageId: r.client_message_id },
		});
		op.cancelled = true;
		op.cancelRequested = reason;
		r.phase = "cancelled";
		r.cancelled_at = r.cancelled_at ?? this.isoNow();
		r.cancel_reason = reason;
		if (r.state === "prepared") r.state = "uncertain";
		// An older write of this op (the exec id before start) may still be in
		// flight: let it land first so the cancelled state is what stays on disk.
		await this.drainWrites(op);
		await this.writeRecord(op).catch((err) =>
			logger.error(`[composer] record write failed: ${(err as Error).message}`),
		);
		op.unlisten?.();
		op.unlisten = null;
		await this.persistSafe(op, "uncertain", {
			stage: r.execs.at(-1)?.step ?? "precheck",
			pending: r.execs.filter((e) => !e.settled).map((e) => ({ id: e.id, step: e.step })),
			reason,
		});
		// The executor's exclusion ends here; the pane stays blocked by the record.
		op.markActiveDone();
	}

	/**
	 * The executor learns, after an effect answered, that its operation was
	 * cancelled meanwhile (T_http or shutdown completed the transition): the
	 * answer is evidence — the exec entry is already settled or still
	 * pending — and nothing further starts. Written under the pane lock,
	 * since `reconcile` may be settling the same record.
	 */
	private async afterCancelled(op: LiveOp): Promise<void> {
		try {
			await this.lock.run(
				op.key,
				"composer-admin",
				async () => {
					// Ownership under the exclusion: a late continuation of a
					// released op (its successor may own the pane) writes nothing.
					if (this.live.get(op.key) !== op) return;
					await this.drainWrites(op);
					await this.writeRecord(op).catch((err) =>
						logger.error(`[composer] record write failed: ${(err as Error).message}`),
					);
					await this.settleAndConclude(op);
				},
				{ mode: "wait" },
			);
		} catch (err) {
			if (err instanceof SessionBusyError) {
				logger.warn(`[composer] late evidence for ${op.key} not applied: pane busy`);
				return;
			}
			throw err;
		}
	}

	/**
	 * Graceful shutdown: no new operation is admitted, and every active
	 * executor is cancelled durably (record `phase: cancelled`, reason
	 * `shutdown`, state `uncertain`) so the next process finds the block and
	 * never resumes a delivery. In-flight execs are not waited for: a late
	 * answer in this process records evidence and starts nothing; one that
	 * never comes is settled by the next process from Docker's inspect.
	 */
	async shutdown(): Promise<void> {
		this.stopping = true;
		// Re-scan after each pass: an op that became live while a cancellation
		// was being written (the `prepared` window) is caught by the next pass;
		// `cancelled` is set synchronously, so each op is handled once and the
		// active phase admits nothing new once `stopping` is set.
		for (;;) {
			const active = [...this.live.values()].filter(
				(op) => op.record.phase === "active" && !op.cancelled,
			);
			if (active.length === 0) break;
			for (const op of active) await this.cancelActive(op, "shutdown");
		}
		for (const op of this.live.values()) {
			op.unlisten?.();
			op.unlisten = null;
			if (op.bg) this.stopBgWatch(op);
		}
		for (const w of this.dupWatches) w.stop();
		this.dupWatches.clear();
	}

	// ── Effects (§8.1.5, §8.1.6) ────────────────────────────────────────────

	private async runEffects(
		op: LiveOp,
		normalized: string,
		panePid: number,
		identity: { pid: number; start: string; exe: string },
	): Promise<void> {
		const r = op.record;
		const plan = segment(normalized);
		const bufferBase = `st-${r.cid.slice(0, 8)}`;
		let segmentsSent = 0;
		let stage: ExecStep = "precheck";
		const finishActive = () => op.markActiveDone();
		try {
			// Precheck, the last read before the first keystroke: the pane must
			// still be the one the precondition saw, with the SAME Claude process
			// (pid and start time: a restarted CLI or a reused pid is a different
			// process) still in the terminal's foreground.
			const pre = await this.effect(op, "precheck", paneFactsArgv(r.pane_id, identity.pid), null);
			if (r.phase !== "active") return this.afterCancelled(op);
			if (pre.kind !== "settled") return this.toUncertain(op, "precheck", finishActive);
			const f = pre.exitCode === 0 ? parsePaneFacts(pre.stdout) : null;
			const stale =
				!f ||
				f.pane.panePid !== panePid ||
				!f.ancestry ||
				f.proc.start !== identity.start ||
				// v1.8.2: the same binary the version was established for (an
				// execve keeps pid and starttime).
				f.exe !== identity.exe;
			if (stale || f.pane.inMode || f.pane.dead || foregroundFault(f, identity.pid) !== null) {
				await this.toFailed(op, "precheck", 0, finishActive, {
					status: 409,
					body: { error: stale ? "binding-stale" : "needs-terminal" },
				});
				return;
			}
			// The input region as last seen: the consumption check is count-based
			// (a line identical to the previous one waits for its own echo), and
			// the region observed after a paste is the "before" of the next one —
			// the newline in between adds only whitespace, which the comparison
			// ignores — so one read per paste is enough.
			let region = await this.readRegion(r);
			for (const step of plan.steps) {
				stage = step.kind;
				const argv = stepArgv(step, r.pane_id, `${bufferBase}-${segmentsSent}`);
				const stdin = step.kind === "paste" ? Buffer.from(step.text, "utf8") : null;
				const res = await this.effect(op, stage, argv, stdin);
				// Cancelled meanwhile by T_http or shutdown (the transition is
				// already written): the answer is evidence, nothing else starts.
				if (r.phase !== "active") return this.afterCancelled(op);
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
					const after = await this.awaitConsumed(op, r, region, step.text);
					if (after === null) {
						if (r.phase !== "active") return this.afterCancelled(op);
						if (op.cancelRequested) return this.toCancelled(op, stage, segmentsSent, finishActive);
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
					region = after;
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
			// Only `effect()` throws here (an exec that could not be CREATED: no
			// process exists ⇒ a known failure, §8.1.6); every transition helper
			// catches its own persist/record errors so an op that already
			// reached `entered` can never be flipped to `failed` by a dropped
			// event. `stage` is the step whose creation failed.
			logger.warn(`[composer] exec creation failed at ${stage}: ${(err as Error).message}`);
			await this.toFailed(op, stage, segmentsSent, finishActive, {
				status: 502,
				body: {
					error: "delivery-failed",
					stage,
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

	/**
	 * Polls the input region until `chunk` shows up as consumed (bounded).
	 * Returns the region that proved it (the next paste's "before"), or null
	 * when there is no evidence.
	 */
	private async awaitConsumed(
		op: LiveOp,
		r: PaneRecord,
		before: string | null,
		chunk: string,
	): Promise<string | null> {
		for (let i = 0; i < CONSUME_MAX_POLLS; i++) {
			if (op.cancelled) return null;
			const after = await this.readRegion(r);
			if (after !== null && pasteConsumed(before, after, chunk)) return after;
			await this.after(CONSUME_POLL_MS);
		}
		return null;
	}

	/** A state event that must not fail the operation: logged, counted, never thrown. */
	private async persistSafe(
		op: LiveOp,
		state: OperationState | "duplicated",
		extra: Record<string, unknown>,
	): Promise<void> {
		try {
			await this.persist(op, state, extra);
		} catch (err) {
			this.stats.persistFailures++;
			logger.error(`[composer] ${state} event not persisted: ${(err as Error).message}`);
		}
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
		opts?: { user?: string },
	): Promise<
		| { kind: "settled"; exitCode: number; stdout: string }
		| { kind: "pending" }
		| { kind: "refused" }
	> {
		const r = op.record;
		let refused = false;
		let recordedId: string | null = null;
		const mayAct = () => !op.cancelled && !op.cancelRequested && !this.stopping;
		const res = await this.deps.docker.exec(
			r.container_id,
			argv,
			stdin,
			async (execId) => {
				// mayAct: our lock, no cancellation — then the id is durable BEFORE start.
				if (!mayAct()) {
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
				// The authorization is re-validated AFTER the write: a cancellation
				// (T_http, shutdown) that landed during it — `cancelled` is set
				// synchronously before any of its own awaits — means this exec must
				// never start. It was created but never run, and we hold its only
				// start path, so the id is withdrawn from the record (nothing to
				// reconcile) and the cancelled state is rewritten on top.
				if (!mayAct()) {
					// Withdrawn in memory only: this continuation may be running
					// after the operation lost the pane (released, successor live),
					// so it writes nothing here. The state reaches the disk through
					// `afterCancelled` / `toCancelled`, which write under the lock
					// after proving the op still owns the record — or not at all.
					const i = r.execs.findIndex((e) => e.id === execId);
					if (i >= 0) r.execs.splice(i, 1);
					recordedId = null;
					refused = true;
					return false;
				}
				return true;
			},
			opts,
		);
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
		// The ack listener has no op to serve any more (no Enter will settle
		// through this executor); recovery/reconcile re-arm their own.
		op.unlisten?.();
		op.unlisten = null;
		await this.persistSafe(op, "uncertain", {
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
		await this.persistSafe(op, "failed", { stage, segments_sent: segmentsSent, http });
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
		await this.persistSafe(op, "entered", {});
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

	/**
	 * The live ack's conclusion, under the pane lock (§8.1.4 regla 7: the
	 * result and the release are written under the exclusion). The executor
	 * released the lock when its active phase ended, so an admin resolution
	 * may have run meanwhile: a result that is already final is left alone
	 * (its HTTP answer is replayed to the waiting request), and an op that
	 * is no longer the pane's live one writes nothing.
	 */
	private async concludeAck(op: LiveOp): Promise<void> {
		op.unlisten?.();
		op.unlisten = null;
		const r = op.record;
		try {
			await this.lock.run(
				op.key,
				"composer-send",
				async () => {
					if (this.live.get(op.key) !== op) {
						this.decideHttp(op, r.http ?? this.uncertainAnswer(r));
						return;
					}
					if (isFinalResult(r.result)) {
						this.decideHttp(op, r.http ?? this.uncertainAnswer(r));
						await this.tryRelease(op, true);
						return;
					}
					const d = this.decideResult(op);
					r.result = d.result;
					r.state = d.result;
					r.http = d.http;
					await this.writeRecord(op).catch((err) =>
						logger.error(`[composer] record write failed: ${(err as Error).message}`),
					);
					await this.persistSafe(op, d.result, { ...d.data, http: d.http });
					this.decideHttp(op, d.http);
					await this.tryRelease(op, true);
				},
				{ mode: "wait" },
			);
		} catch (err) {
			if (err instanceof SessionBusyError) {
				logger.warn(`[composer] ack conclusion deferred: pane ${op.key} busy`);
				this.decideHttp(op, this.uncertainAnswer(r));
				return;
			}
			throw err;
		}
	}

	// ── Release (§8.1.4 regla 7) ────────────────────────────────────────────

	/**
	 * `released` only with phase ≠ active, a final result and settled effects
	 * (§8.1.4 regla 7), always under the pane lock: callers that hold it pass
	 * `held`; the others take it (wait mode). Order: the `released` event is
	 * confirmed on disk FIRST — it carries the HTTP answer a replay needs and
	 * feeds the 256-id window — and only then the record is removed, by
	 * identity (a late release never takes a successor's record). A failure
	 * at either step keeps the record and the live op, so the next send on the
	 * pane re-evaluates instead of a restart treating the id as new.
	 */
	private async tryRelease(op: LiveOp, held = false): Promise<boolean> {
		if (!held) {
			try {
				return await this.lock.run(op.key, "composer-admin", () => this.tryRelease(op, true), {
					mode: "wait",
				});
			} catch (err) {
				if (err instanceof SessionBusyError) {
					logger.warn(`[composer] release of ${op.key} deferred: pane busy`);
					return false;
				}
				throw err;
			}
		}
		const r = op.record;
		if (r.phase === "active" || !isFinalResult(r.result) || effectsOf(r) !== "settled")
			return false;
		// Invariant: no release while this op still has record writes in flight —
		// a rename landing after the successor's `prepared` would replace it.
		await this.drainWrites(op);
		const cur = await this.deps.records.read(r.sid, r.pane_id).catch(() => null);
		if (cur === null || cur.kind === "unreadable") return false;
		if (cur.kind === "ok" && cur.record.client_message_id !== r.client_message_id) {
			// A successor owns the pane: our record is already gone.
			if (this.live.get(op.key) === op) this.live.delete(op.key);
			return true;
		}
		const evidence = r.evidence ?? (r.execs.length === 0 ? "none-created" : "inspected");
		r.evidence = evidence;
		if (r.state !== "released") {
			try {
				await this.persist(op, "released", { evidence, http: r.http ?? null }, { confirmed: true });
			} catch (err) {
				logger.error(
					`[composer] released event not persisted, record kept: ${(err as Error).message}`,
				);
				this.live.set(op.key, op);
				return false;
			}
			r.state = "released";
			if (r.http) this.recentFinals.set(`${r.cid}/${r.client_message_id}`, r.http);
			this.capRecentFinals();
			// A crash from here on lands at `released`: recovery only removes.
			if (cur.kind === "ok") await this.writeRecord(op).catch(() => undefined);
		}
		if (cur.kind === "ok") {
			try {
				await this.deps.records.remove(r.sid, r.pane_id, r.client_message_id);
			} catch (err) {
				logger.error(`[composer] pane record remove failed: ${(err as Error).message}`);
				this.live.set(op.key, op);
				return false;
			}
		}
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

	/** A tracked record write: its promise is in `op.writes` until it settles (success or failure). */
	private writeRecord(op: LiveOp): Promise<void> {
		op.record.updated_at = this.isoNow();
		const tracked: Promise<void> = this.deps.records.write(op.record).finally(() => {
			op.writes.delete(tracked);
		});
		op.writes.add(tracked);
		return tracked;
	}

	/**
	 * Wait for every record write of `op` still in flight (outcome ignored:
	 * a failed write is settled too). The waits are on the filesystem only;
	 * nothing here depends on the pane lock or on Docker, so a caller holding
	 * the lock cannot deadlock on it.
	 */
	private async drainWrites(op: LiveOp): Promise<void> {
		while (op.writes.size > 0) await Promise.allSettled([...op.writes]);
	}

	private async persist(
		op: LiveOp,
		state: OperationState | "duplicated" | "possible-duplicate",
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
			// v1.9 §8.1.12: a job record says so; its `pane_id` is the job key.
			...(r.job ? { transport: "background", job: r.job.short } : {}),
			...extra,
		};
		const pending = {
			ev: "composer_send" as const,
			prompt_id: null,
			turn_id: null,
			agent_id: null,
			// A job has no tmux pane: nothing may read `job:<short>` as one.
			pane: r.job ? null : r.pane_id,
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

	private async readPaneFacts(containerId: string, paneId: string, pid: number) {
		try {
			const res = await this.deps.docker.exec(
				containerId,
				paneFactsArgv(paneId, pid),
				null,
				async () => true,
			);
			return res.exitCode === 0 ? parsePaneFacts(res.stdout) : null;
		} catch {
			return null;
		}
	}

	/** §8.1.9 v1.8.2 — the live process's version (cliIdentity.ts), cached per verified process. */
	private async liveVersion(
		containerId: string,
		pid: number,
		start: string,
		exe: string,
	): Promise<LiveVersion> {
		// Bounded host-side too (2nd review of #523): `timeout` kills the
		// binary's process group, but a child that escaped it with the stream
		// open would keep the exec — and this pane's lock — forever. Past the
		// deadline we stop waiting (nothing is aborted) and refuse.
		// One hung query per container is enough: while an exec of an earlier
		// query is still unsettled PAST its deadline, refuse instead of leaving
		// another stream behind (2nd review of #523). Execs merely in flight
		// (a concurrent send on another pane) do not count (final review).
		if ((this.liveHung.get(containerId) ?? 0) > 0) return { ok: false, why: "exec-error" };
		const exec = (cmd: string[], user?: string) => {
			const p = this.deps.docker.exec(
				containerId,
				cmd,
				null,
				async () => true,
				user ? { user } : undefined,
			);
			return withDeadline(p, this.deps.liveExecDeadlineMs ?? LIVE_EXEC_DEADLINE_MS, () => {
				// Expired: hung until it settles (it is never aborted).
				this.liveHung.set(containerId, (this.liveHung.get(containerId) ?? 0) + 1);
				const settled = () => {
					const n = (this.liveHung.get(containerId) ?? 1) - 1;
					if (n <= 0) this.liveHung.delete(containerId);
					else this.liveHung.set(containerId, n);
				};
				p.then(settled, settled);
			});
		};
		const hit = this.liveVersions.get(containerId, pid, start, exe);
		if (hit) {
			// A hit counts only for the same FILE (an execve or a reinstall at
			// the same path keeps pid, starttime and path).
			try {
				const r = await exec(exeInodeArgv(pid));
				if (r.exitCode === 0 && parseInode(r.stdout) === hit.inode)
					return { ok: true, version: hit.version, inode: hit.inode };
			} catch {
				// fall through to a full query
			}
		}
		const r = await readLiveCliVersion(exec, pid, { start, exe });
		if (r.ok)
			this.liveVersions.set(containerId, pid, start, exe, { version: r.version, inode: r.inode });
		return r;
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
	/**
	 * Rebuild the exclusion from the records (§8.1.4 regla 8), once per
	 * session per process — marked done only when the listing succeeded, so
	 * a transient read error is retried by the next caller. Throws when the
	 * records cannot be listed (the caller fails closed).
	 */
	async recover(sid: string, opts: { force?: boolean } = {}): Promise<void> {
		if (this.recovered.has(sid) && !opts.force) return;
		const { records } = await this.deps.records.list(sid);
		this.recovered.add(sid);
		// v1.9 §8.1.12.5 (audit round 1, S4): the `duplicated` watch of a
		// background send delivered before this process started.
		if (this.deps.bg?.enabled && this.deps.bg.sessions.has(sid))
			await this.rearmDupWatches(sid).catch((err) =>
				logger.warn(
					`[composer-bg] duplicate watch re-arm failed for ${sid}: ${(err as Error).message}`,
				),
			);
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
		if (op.record.job) return this.settleAndConcludeBg(op);
		const r = op.record;
		await this.drainWrites(op);
		const changed = await this.settleEffects(r);
		if (changed) await this.writeRecord(op).catch(() => undefined);
		// Once: a reconcile after the late Enter already moved the op to
		// `entered` must not persist that state again.
		if (
			r.phase === "cancelled" &&
			!isFinalResult(r.result) &&
			r.state !== "entered" &&
			effectsOf(r) === "settled"
		) {
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
		await this.tryRelease(op, true);
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
			// that landed just before a rotation is still evidence. Bounded to
			// the last DEFERRED_ACK_SCAN events per conversation: a candidate is
			// at most T_ack-and-downtime old, and an older one is `unconfirmed`,
			// never a wrong attribution.
			const idx = await this.deps.store.peekIndex(r.sid, cid).catch(() => null);
			const after = Math.max(0, (idx?.lastSeq ?? 0) - DEFERRED_ACK_SCAN);
			const events = await this.deps.store
				.readEvents(r.sid, cid, after, DEFERRED_ACK_SCAN, { archive: true })
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
			// Another live op owns the pane's ack, or this one is already waiting
			// (its own executor's window, or an earlier background wait).
			const live = this.live.get(op.key);
			if ((live && live !== op) || op.ackWaiting || op.resolveAck) return;
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

	// ── Background sessions (v1.9 §8.1.12, EXPERIMENTAL) ─────────────────────

	/**
	 * A send to a pane-less conversation with the background transport on.
	 * The job's `short` (its exclusion key) is known only from the fresh
	 * probe, so the probe runs before the job lock is taken — it is the ONE
	 * probe of this request and every later check uses it (§8.1.12.4 step 1).
	 * Same T_http race as a pane send (§8.1.4), measured from the request.
	 */
	private async sendBackground(a: {
		sid: string;
		cid: string;
		callerId: string;
		meta: SessionMeta;
		index: ConversationIndex;
		records: PaneRecord[];
		clientMessageId: string;
		normalized: string;
		bytes: number;
		segments: number;
		audit: () => Promise<void>;
		startedAt: number;
		/** The unconfirmed send the person confirmed they checked in the Terminal (D1). */
		acknowledge: string | null;
	}): Promise<HttpResult> {
		const { sid, cid, meta, clientMessageId } = a;
		if (meta.status !== "running" || !meta.containerId)
			return this.reject("session-not-running", 409);
		if (!(await this.deps.conversation.captureEffective(sid)))
			return this.reject("capture-inactive", 409);
		const probe = await this.deps.conversation.probeSession(sid);
		const entry = probe?.find((e) => e.sessionId === cid);
		if (!probe || !entry) return this.reject("probe-failed", 409);
		// Two processes claiming the same conversation: which one would read
		// the text is not provable (audit round 1, NIT).
		if (probe.filter((e) => e.sessionId === cid).length > 1)
			return this.reject("binding-stale", 409, { detail: "ambiguous" });
		// Only a CLI background session goes this way: an interactive process
		// without a bound pane is refused as it always was (§8.1.3), never
		// "found" through the daemon.
		if (entry.kind !== "background")
			return this.reject("not-interactive", 409, { detail: `kind:${entry.kind}` });
		if (typeof entry.id !== "string" || !SHORT_RE.test(entry.id))
			return this.reject("binding-stale", 409, { detail: "job-id" });
		if (typeof entry.pid !== "number" || !Number.isInteger(entry.pid) || entry.pid < 2)
			return this.reject("binding-stale", 409, { detail: "pid" });
		const short = entry.id;
		const jk = jobKey(short);
		const key = this.key(sid, jk);
		let blocker = a.records.find((r) => r.pane_id === jk);
		if (blocker) {
			const live = this.live.get(key);
			if (
				live &&
				live.record.client_message_id === blocker.client_message_id &&
				live.record.phase !== "active" &&
				isFinalResult(live.record.result) &&
				effectsOf(live.record) === "settled"
			)
				blocker = undefined;
		}
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
		let announce!: (op: LiveOp) => void;
		const opReady = new Promise<LiveOp>((r) => {
			announce = r;
		});
		const ctl = { expired: false };
		const deadline = this.after(Math.max(0, this.tHttp - (this.now() - a.startedAt))).then(() => ({
			kind: "deadline" as const,
		}));
		const run: Promise<HttpResult | LiveOp> = this.lock
			.run(
				key,
				"composer-send",
				() => this.activePhaseBg({ ...a, entry, short, jk, announce, ctl }),
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
			deadline,
		]);
		if (first.kind === "deadline") {
			ctl.expired = true;
			this.stats.sendsByState.uncertain = (this.stats.sendsByState.uncertain ?? 0) + 1;
			run.catch((err) =>
				logger.error(`[composer-bg] active phase failed: ${(err as Error).message}`),
			);
			return { status: 202, body: { result: "uncertain", clientMessageId } };
		}
		if (first.kind === "op") {
			run.catch((err) =>
				logger.error(`[composer-bg] active phase failed: ${(err as Error).message}`),
			);
			return first.op.http;
		}
		return "http" in first.r ? first.r.http : first.r;
	}

	/** §8.1.12.3 + §8.1.12.4 under the job lock, then `prepared` and the one effect. */
	private async activePhaseBg(a: {
		sid: string;
		cid: string;
		callerId: string;
		meta: SessionMeta;
		index: ConversationIndex;
		clientMessageId: string;
		normalized: string;
		bytes: number;
		segments: number;
		audit: () => Promise<void>;
		startedAt: number;
		acknowledge: string | null;
		entry: ProbeEntry;
		short: string;
		jk: string;
		announce: (op: LiveOp) => void;
		ctl: { expired: boolean };
	}): Promise<HttpResult | LiveOp> {
		const { sid, cid, clientMessageId, entry, short, jk } = a;
		const bg = this.deps.bg as BgDeps;
		let again = await this.deps.records.read(sid, jk);
		if (again.kind === "ok") {
			const live = this.live.get(this.key(sid, jk));
			if (live && live.record.client_message_id === again.record.client_message_id) {
				if (await this.tryRelease(live, true)) again = await this.deps.records.read(sid, jk);
			}
		}
		if (again.kind === "unreadable")
			return this.reject("send-in-progress", 409, { detail: "unverifiable" });
		if (again.kind === "ok") {
			return this.reject("send-in-progress", 409, {
				detail: "in-progress",
				clientMessageId: again.record.client_message_id,
			});
		}
		const containerId = a.meta.containerId as string;
		const pid = entry.pid as number;

		// §8.1.12.3: v1 never queues on purpose. The fresh probe must say idle
		// with no waitingFor; the in-exec re-read repeats it before the reply.
		if (entry.status === "busy") return this.reject("busy", 409);
		if (entry.status === "waiting" || entry.waitingFor !== undefined)
			return this.reject("needs-terminal", 409, {
				detail: entry.waitingFor ?? "waiting-unspecified",
			});
		if (entry.status !== "idle")
			return this.reject("needs-terminal", 409, { detail: "status-unknown" });

		// §8.1.12.4 step 2: the job's process, by /proc.
		const proc = await this.readProc(containerId, pid);
		if (!proc) return this.reject("binding-stale", 409, { detail: "process" });
		if (!isClaudeExe(proc.exe)) return this.reject("binding-stale", 409, { detail: "process-exe" });
		// Steps 3–4 and the job's own session file, read INSIDE the container
		// as the worker's uid (the roster holds tokens: only pids leave it).
		const ins = await this.bgInspect(containerId, proc.uid, { pid, short });
		// D3: only the container's default config dir (where the transcript the
		// ack needs is known to live). No inferred path, no fallback.
		if (ins && ins.configDir !== (bg.configDir ?? DEFAULT_BG_CONFIG_DIR)) {
			logger.info(
				`[composer-bg] ${sid} ${jk}: not sending, the job runs with CLAUDE_CONFIG_DIR=${JSON.stringify(ins.configDir)} (only ${bg.configDir ?? DEFAULT_BG_CONFIG_DIR} is supported)`,
			);
			return this.reject("unsupported-config-dir", 409);
		}
		const fault = ins
			? inspectFault(ins, { cid, short, start: proc.start, exe: proc.exe })
			: { error: "binding-stale", detail: "inspect" };
		if (fault || !ins) {
			const f = fault ?? { error: "binding-stale", detail: "inspect" };
			logger.info(`[composer-bg] ${sid} ${jk}: not sending (${f.error}: ${f.detail})`);
			return this.reject(f.error, 409, { detail: f.detail });
		}
		const daemon = ins.daemon as {
			statusPid: number;
			start: string;
			exe: string;
		};
		const job = ins.job as { nonce: string; pid: number; cliVersion: string | null };

		// §8.1.9 pattern, twice: the worker's version and the daemon's, asked of
		// their own binaries; equal, and both in the exact list.
		const jobV = await this.liveVersion(containerId, pid, proc.start, proc.exe);
		if (!jobV.ok)
			return this.reject("cli-unvalidated", 409, {
				version: null,
				detail: `unverifiable:${jobV.why}`,
			});
		const daemonV = await this.liveVersion(containerId, daemon.statusPid, daemon.start, daemon.exe);
		if (!daemonV.ok)
			return this.reject("cli-unvalidated", 409, {
				version: jobV.version,
				detail: `unverifiable:daemon:${daemonV.why}`,
			});
		if (
			daemonV.version !== jobV.version ||
			(job.cliVersion !== null && job.cliVersion !== jobV.version)
		) {
			return this.reject("cli-unvalidated", 409, {
				version: jobV.version,
				daemonVersion: daemonV.version,
				detail: "daemon-skew",
			});
		}
		if (!bg.versions.has(jobV.version)) {
			logger.info(
				`[composer-bg] ${sid} ${jk}: not sending, CLI ${jobV.version} is not in COMPOSER_BG_CLI_VERSIONS (${[...bg.versions].join(", ") || "empty"})`,
			);
			return this.reject("cli-unvalidated", 409, {
				version: jobV.version,
				detail: "not-allowed",
			});
		}

		// §8.1.12.5 cond. 3 (owner decision D1): refuse an identical text only
		// while something makes it AMBIGUOUS — never because it was once sent.
		// (The earlier "same-hash human prompt in the last 10 min" rule is
		// gone: a prompt before t0 can never be taken for ours, since the ack
		// needs a new prompt_id after t0 paired with OUR enqueue.)
		const hash = textHash(a.normalized);
		// (a) one of OUR sends of the same text to this conversation is still
		// unresolved (a job record — accepted, uncertain, in flight).
		const own = (await this.deps.records.list(sid)).records.find(
			(r) => r.job && r.cid === cid && r.text_hash === hash,
		);
		if (own)
			return this.reject("duplicate-pending", 409, {
				detail: "own-pending",
				clientMessageId: own.client_message_id,
			});
		// (b) one ended `unconfirmed` and the person has not said they checked
		// the Terminal: it may still be queued or have run.
		const events = await this.readCidEvents(sid, cid);
		const unack = unacknowledgedUnconfirmed(events, hash);
		if (unack && unack !== a.acknowledge)
			return this.reject("duplicate-pending", 409, {
				detail: "unconfirmed-unacknowledged",
				clientMessageId: unack,
			});
		// Without the transcript there is no ack at all: nothing is sent (D2).
		const tp = transcriptPathOf(events) ?? (await this.transcriptPathFromHead(sid, cid));
		const tail = tp ? await bg.transcripts.readTail(sid, tp, TRANSCRIPT_TAIL_BYTES) : null;
		if (tail === null) return this.reject("transcript-unavailable", 409);
		// (c) the same content is waiting in the CLI's queue, or taken and not
		// yet run: a new identical text could not be told apart from it.
		if (pendingSameContent(parseTranscript(tail), { cid, hash }))
			return this.reject("duplicate-pending", 409, { detail: "queue-pending" });
		if (unack) {
			try {
				await this.persistAcknowledged(sid, cid, unack, a.callerId);
			} catch (err) {
				logger.error(`[composer-bg] acknowledgement not persisted: ${(err as Error).message}`);
				return this.reject("persist-failed", 503);
			}
		}
		logger.info(
			`[composer-bg] ${sid} ${jk} ${clientMessageId}: CLI ${jobV.version} (job pid ${pid}, daemon pid ${daemon.statusPid}) authorized by COMPOSER_BG_CLI_VERSIONS`,
		);

		if (this.stopping) return this.reject("shutting-down", 503);
		const actor: "owner" | "admin" = a.meta.userId === a.callerId ? "owner" : "admin";
		if (actor === "admin") {
			try {
				await a.audit();
			} catch (err) {
				logger.error(`[composer-bg] operate audit failed, nothing sent: ${(err as Error).message}`);
				return this.reject("audit-failed", 500);
			}
		}
		if (a.ctl.expired) return this.reject("timeout", 409);
		if (this.stopping) return this.reject("shutting-down", 503);

		// ── prepared: the job record, then the confirmed event (§8.1.12.6) ──
		const at = this.isoNow();
		const target: JobTarget = {
			short,
			pid,
			start: proc.start,
			exe: proc.exe,
			nonce: job.nonce,
			pty_host_pid: job.pid,
			daemon_pid: daemon.statusPid,
			daemon_start: daemon.start,
			daemon_exe: daemon.exe,
			version: jobV.version,
			uid: proc.uid,
			config_dir: ins.configDir,
		};
		const record: PaneRecord = {
			v: 1,
			sid,
			pane_id: jk,
			pane_pid: pid,
			container_id: containerId,
			cid,
			client_message_id: clientMessageId,
			text_hash: hash,
			prepared_at: at,
			state: "prepared",
			result: "pending",
			phase: "active",
			execs: [],
			job: target,
			updated_at: at,
		};
		const op = newLiveOp({
			key: this.key(sid, jk),
			record,
			bytes: a.bytes,
			segments: a.segments,
			actor,
			cancelled: false,
			candidates: new Map(),
			resolveAck: null,
			unlisten: null,
		});
		this.live.set(op.key, op);
		const withdraw = async () => {
			if (this.live.get(op.key) === op) this.live.delete(op.key);
			await this.deps.records.remove(sid, jk, clientMessageId).catch(() => undefined);
		};
		try {
			await this.deps.records.write(record);
		} catch (err) {
			logger.error(`[composer-bg] job record write failed: ${(err as Error).message}`);
			await withdraw();
			return this.reject("persist-failed", 503);
		}
		try {
			await this.persist(op, "prepared", {}, { confirmed: true });
		} catch (err) {
			logger.error(`[composer-bg] prepared event persist failed: ${(err as Error).message}`);
			await withdraw();
			return this.reject("persist-failed", 503);
		}
		a.announce(op);
		if (this.stopping || op.cancelled) {
			if (!op.cancelled) await this.cancelActive(op, "shutdown");
			else
				await this.writeRecord(op).catch((err) =>
					logger.error(`[composer-bg] record write failed: ${(err as Error).message}`),
				);
			return op;
		}
		void this.after(Math.max(0, this.tHttp - (this.now() - a.startedAt))).then(() =>
			this.onTHttp(op).catch((err) =>
				logger.error(`[composer-bg] T_http handling failed: ${(err as Error).message}`),
			),
		);
		void this.runReply(op, a.normalized, a.startedAt).catch((err) => {
			logger.error(`[composer-bg] reply failed: ${(err as Error).message}`);
		});
		await op.activeDone;
		return op;
	}

	/**
	 * The one effect: the reply exec. Its id is in the job record before it
	 * starts (`effect()`, same critical section as `mayAct`), its end is
	 * known only from its own inspect, and NOTHING is retried — not on a
	 * daemon error, not on an unknown, not after a restart (§8.1.12.6).
	 */
	private async runReply(op: LiveOp, text: string, startedAt: number): Promise<void> {
		const r = op.record;
		const j = r.job as JobTarget;
		const finish = () => op.markActiveDone();
		try {
			const res = await this.effect(
				op,
				"reply",
				[...BG_CLIENT_ARGV],
				replyStdin({
					pid: j.pid,
					short: j.short,
					start: j.start,
					exe: j.exe,
					cid: r.cid,
					nonce: j.nonce,
					ptyHostPid: j.pty_host_pid,
					daemonPid: j.daemon_pid,
					daemonStart: j.daemon_start,
					daemonExe: j.daemon_exe,
					text,
				}),
				{ user: String(j.uid) },
			);
			if (r.phase !== "active") {
				// T_http or shutdown completed the cancellation meanwhile: the
				// answer is still evidence (recorded under the lock), nothing starts.
				if (res.kind === "settled") op.bgLate = parseReplyOutput(res.exitCode, res.stdout);
				return this.afterCancelled(op);
			}
			if (res.kind === "refused") return this.toCancelled(op, "reply", 0, finish);
			if (res.kind === "pending") return this.toUncertain(op, "reply", finish);
			const outcome = parseReplyOutput(res.exitCode, res.stdout);
			logger.info(
				`[composer-bg] ${r.sid} ${r.pane_id} ${r.client_message_id}: reply exec ${outcome.kind}${"code" in outcome ? ` ${outcome.code}` : ""}${"why" in outcome ? ` ${outcome.why}` : ""}`,
			);
			switch (outcome.kind) {
				case "accepted":
					return this.toAccepted(op, finish, startedAt);
				case "rejected":
					return this.toFailed(op, "reply", 0, finish, {
						status: 502,
						body: {
							error: "delivery-failed",
							stage: "reply",
							segmentsSent: 0,
							segments: op.segments,
							detail: outcome.code,
						},
					});
				case "aborted": {
					const h = abortHttpCode(outcome.code);
					return this.toFailed(op, "precheck", 0, finish, {
						status: h.status,
						body: {
							error: h.error,
							...(h.detail ? { detail: h.detail } : {}),
							...(h.status === 502
								? { stage: "reply", segmentsSent: 0, segments: op.segments }
								: {}),
						},
					});
				}
				case "unknown":
					return this.toBgUncertainSettled(op, outcome.why, finish);
			}
		} catch (err) {
			// The exec could not be CREATED: no process exists, nothing was sent.
			logger.warn(`[composer-bg] reply exec creation failed: ${(err as Error).message}`);
			await this.toFailed(op, "reply", 0, finish, {
				status: 502,
				body: {
					error: "delivery-failed",
					stage: "reply",
					segmentsSent: 0,
					segments: op.segments,
					detail: "exec-rejected",
				},
			});
		}
	}

	/**
	 * `accepted`: the daemon handed the text to the worker — NOT delivered
	 * (§8.1.12.2). The record keeps the job blocked; the ack watch runs until
	 * T_ack_bg. The HTTP waits a little for a complete ack (an idle job
	 * answers in ~60 ms) and otherwise says `accepted`.
	 */
	private async toAccepted(op: LiveOp, finish: () => void, startedAt: number): Promise<void> {
		const r = op.record;
		r.phase = "completed";
		r.state = "accepted";
		await this.writeRecord(op).catch((err) =>
			logger.error(`[composer-bg] record write failed: ${(err as Error).message}`),
		);
		finish();
		await this.persistSafe(op, "accepted", {});
		this.startBgWatch(op, Date.parse(r.prepared_at) + this.tAckBg);
		const wait = Math.min(this.tAck, Math.max(0, this.tHttp - (this.now() - startedAt) - 250));
		void this.after(wait).then(() =>
			this.decideHttp(op, {
				status: 202,
				body: { result: "accepted", clientMessageId: r.client_message_id },
			}),
		);
	}

	/**
	 * The exec ended (numeric exit) but whether the daemon took the text is
	 * unknown — the line may have been written (a lost connection after the
	 * write, unparseable output). `uncertain`, never resent: only a complete
	 * ack (→ delivered/misdelivered) or an admin resolution ends it.
	 */
	private async toBgUncertainSettled(op: LiveOp, why: string, finish: () => void): Promise<void> {
		const r = op.record;
		r.phase = "completed";
		r.state = "uncertain";
		await this.writeRecord(op).catch((err) =>
			logger.error(`[composer-bg] record write failed: ${(err as Error).message}`),
		);
		finish();
		await this.persistSafe(op, "uncertain", { stage: "reply", detail: why, pending: [] });
		this.decideHttp(op, {
			status: 202,
			body: { result: "uncertain", clientMessageId: r.client_message_id, effects: "settled" },
		});
		this.startBgWatch(op, null);
	}

	private get tAckBg(): number {
		return this.deps.bg?.tAckBgMs ?? T_ACK_BG_MS;
	}

	/**
	 * Watch for the ack (§8.1.12.5) while `accepted` or `uncertain`: on every
	 * persisted user_prompt / session_start of the session and every poll
	 * (the transcript may trail the hook). `deadlineMs` (accepted) ⇒
	 * `unconfirmed` when it passes; null (uncertain) ⇒ the watch just ends
	 * at t0 + T_ack_bg and the record waits for an admin resolution.
	 */
	private startBgWatch(op: LiveOp, deadlineMs: number | null): void {
		if (op.bg && !op.bg.stopped) return;
		const r = op.record;
		const t0Ms = Date.parse(r.prepared_at);
		const w: BgWatch = {
			t0Ms,
			deadlineMs,
			timers: [],
			evaluating: false,
			again: false,
			stopped: false,
			lastJobCheckMs: this.now(),
		};
		op.bg = w;
		op.unlisten?.();
		op.unlisten = this.deps.conversation.onPersistedEvent((st, _cid, ev) => {
			if (st !== r.sid) return;
			if (ev.ev === "user_prompt" || ev.ev === "session_start") this.kickBg(op);
		});
		const poll = this.deps.bg?.pollMs ?? BG_ACK_POLL_MS;
		const until = deadlineMs ?? t0Ms + this.tAckBg;
		const tick = () => {
			if (w.stopped) return;
			if (this.now() >= until) {
				void this.bgDeadline(op);
				return;
			}
			this.kickBg(op);
			void this.after(poll).then(tick);
		};
		void this.after(poll).then(tick);
		this.kickBg(op);
	}

	private stopBgWatch(op: LiveOp): void {
		if (!op.bg) return;
		op.bg.stopped = true;
		op.unlisten?.();
		op.unlisten = null;
	}

	private kickBg(op: LiveOp): void {
		const w = op.bg;
		if (!w || w.stopped) return;
		if (w.evaluating) {
			w.again = true;
			return;
		}
		w.evaluating = true;
		void (async () => {
			try {
				do {
					w.again = false;
					await this.evaluateBg(op);
				} while (w.again && !w.stopped);
			} catch (err) {
				logger.warn(`[composer-bg] ack evaluation failed: ${(err as Error).message}`);
			} finally {
				w.evaluating = false;
			}
		})();
	}

	private async evaluateBg(op: LiveOp): Promise<void> {
		const r = op.record;
		const w = op.bg as BgWatch;
		if (w.stopped) return;
		// Concluded elsewhere (an admin resolution, a recovery pass) or no
		// longer the job's live op: the watch ends here, listener included.
		if (isFinalResult(r.result) || this.live.get(op.key) !== op) {
			this.stopBgWatch(op);
			return;
		}
		const v = await this.bgVerdict(r);
		if (v.kind !== "none") return this.concludeBg(op, v);
		w.transcriptMissing = v.transcriptMissing === true;
		// The transcript may trail the hook by a few ms: look again soon.
		if (v.pending) void this.after(500).then(() => this.kickBg(op));
		if (r.state !== "accepted") return;
		const every = this.deps.bg?.jobCheckMs ?? BG_JOB_CHECK_MS;
		if (this.now() - w.lastJobCheckMs < every) return;
		w.lastJobCheckMs = this.now();
		const gone = await this.bgJobGone(r);
		if (gone) return this.concludeBg(op, { kind: "unconfirmed", detail: gone });
	}

	private async bgDeadline(op: LiveOp): Promise<void> {
		const w = op.bg;
		if (!w || w.stopped) return;
		await this.evaluateBg(op).catch(() => undefined);
		if (w.stopped) return;
		if (isFinalResult(op.record.result) || this.live.get(op.key) !== op) {
			this.stopBgWatch(op);
			return;
		}
		if (op.record.state === "accepted" && w.deadlineMs !== null) {
			// D2: delivery could not be proven. If the transcript was unreadable
			// the detail says so; it is never `failed` and never retried.
			await this.concludeBg(op, {
				kind: "unconfirmed",
				detail: w.transcriptMissing ? "transcript-unavailable" : "t-ack-bg",
			});
			return;
		}
		// `uncertain`: the watch ends; the record stays for an admin resolution.
		this.stopBgWatch(op);
	}

	/**
	 * §8.1.12.5 over every conversation of the session with events after t0:
	 * a hook candidate (new prompt_id, same hash, after t0) that the
	 * conversation's own transcript confirms (enqueue ≤ 2 s after t0 and a
	 * `queued` entry with that promptId). One confirmed in `cid` ⇒ delivered;
	 * one in another conversation OF THE SAME JOB (a probe names the job's
	 * short with the recorded pid on that conversation) ⇒ misdelivered; more
	 * than one ⇒ no unequivocal attribution ⇒ unconfirmed.
	 */
	private async bgVerdict(r: PaneRecord): Promise<BgVerdict> {
		const t0Ms = Date.parse(r.prepared_at);
		const confirmed = new Map<string, BgCandidate>();
		let pending = false;
		let transcriptMissing = false;
		const enqueueMs = new Map<string, number | null>();
		const cids = await this.deps.store.listConversationIds(r.sid).catch(() => [] as string[]);
		for (const cid of cids) {
			const idx = await this.deps.store.peekIndex(r.sid, cid).catch(() => null);
			if (!idx || idx.lastEventAt < r.prepared_at) continue;
			const events = await this.readCidEvents(r.sid, cid);
			const cands = hookCandidates(events, { cid, t0: r.prepared_at, hash: r.text_hash });
			if (cands.length === 0) continue;
			const tp = transcriptPathOf(events) ?? (await this.transcriptPathFromHead(r.sid, cid));
			const tail = tp
				? // No transcript port (flag off, a leftover record being drained):
					// no ack evidence, never a guess.
					((await this.deps.bg?.transcripts.readTail(r.sid, tp, TRANSCRIPT_TAIL_BYTES)) ?? null)
				: null;
			if (tail === null) transcriptMissing = true;
			const entries = tail ? parseTranscript(tail) : [];
			const c = cands.find((x) =>
				transcriptConfirms(entries, { cid, t0Ms, hash: r.text_hash, promptId: x.promptId }),
			);
			if (c) {
				confirmed.set(cid, c);
				enqueueMs.set(cid, ourEnqueueLatencyMs(entries, { cid, t0Ms, hash: r.text_hash }));
			} else pending = true;
		}
		if (confirmed.size === 0) return { kind: "none", pending, transcriptMissing };
		if (confirmed.size > 1) return { kind: "unconfirmed", detail: "ambiguous" };
		const [cid, c] = [...confirmed.entries()][0] as [string, BgCandidate];
		if (cid === r.cid)
			return {
				kind: "delivered",
				promptId: c.promptId,
				seq: c.seq,
				enqueueMs: enqueueMs.get(cid) ?? null,
			};
		const j = r.job as JobTarget;
		const probe = await this.deps.conversation.probeSession(r.sid).catch(() => null);
		const sameJob = probe?.some((e) => e.id === j.short && e.pid === j.pid && e.sessionId === cid);
		// Not provably this job's next conversation: not ours to claim.
		if (!sameJob) return { kind: "none", pending };
		return { kind: "misdelivered", conversation: cid };
	}

	/** The final result from a verdict (caller holds the job lock). */
	private async applyBgVerdict(
		op: LiveOp,
		v: Exclude<BgVerdict, { kind: "none" }>,
		extra: Record<string, unknown> = {},
	): Promise<void> {
		const r = op.record;
		const id = r.client_message_id;
		let data: Record<string, unknown>;
		let http: HttpResult;
		if (v.kind === "delivered") {
			http = {
				status: 202,
				body: { result: "delivered", clientMessageId: id, promptId: v.promptId, seq: v.seq },
			};
			// enqueue − t0 (t0 = the ingest of our own `prepared`, §8.1.7):
			// evidence of how much of the 2 s window the delivery used.
			data = { prompt_id: v.promptId, seq: v.seq, enqueue_ms: v.enqueueMs ?? null };
			logger.info(
				`[composer-bg] ${r.sid} ${r.pane_id} ${id}: delivered (prompt ${v.promptId}; enqueue − t0 = ${v.enqueueMs ?? "?"} ms)`,
			);
		} else if (v.kind === "misdelivered") {
			http = {
				status: 202,
				body: { result: "misdelivered", clientMessageId: id, conversation: v.conversation },
			};
			data = { misdelivered_to: v.conversation };
		} else {
			http = {
				status: 202,
				body: { result: "unconfirmed", clientMessageId: id, detail: v.detail },
			};
			data = { detail: v.detail };
		}
		r.result = v.kind;
		r.state = v.kind;
		r.http = http;
		await this.writeRecord(op).catch((err) =>
			logger.error(`[composer-bg] record write failed: ${(err as Error).message}`),
		);
		await this.persistSafe(op, v.kind, { ...data, ...extra, http });
		this.decideHttp(op, http);
		this.stopBgWatch(op);
		if (v.kind === "delivered") this.startDupWatch({ ...r }, { promptId: v.promptId, seq: v.seq });
	}

	private async concludeBg(op: LiveOp, v: Exclude<BgVerdict, { kind: "none" }>): Promise<void> {
		const r = op.record;
		try {
			await this.lock.run(
				op.key,
				"composer-send",
				async () => {
					if (this.live.get(op.key) !== op) {
						this.stopBgWatch(op);
						this.decideHttp(op, r.http ?? this.uncertainAnswer(r));
						return;
					}
					if (isFinalResult(r.result)) {
						this.stopBgWatch(op);
						this.decideHttp(op, r.http ?? this.uncertainAnswer(r));
						await this.tryRelease(op, true);
						return;
					}
					// `unconfirmed` is a verdict on an `accepted` text; an
					// `uncertain` one never expires into it (§8.1.12.6).
					if (v.kind === "unconfirmed" && v.detail !== "ambiguous" && r.state !== "accepted")
						return;
					await this.applyBgVerdict(op, v);
					await this.tryRelease(op, true);
				},
				{ mode: "wait" },
			);
		} catch (err) {
			if (err instanceof SessionBusyError) {
				logger.warn(`[composer-bg] conclusion deferred: ${op.key} busy`);
				return;
			}
			throw err;
		}
	}

	/** Has the job gone (`unconfirmed` early, §8.1.12.6)? null = no evidence either way. */
	private async bgJobGone(r: PaneRecord): Promise<string | null> {
		const j = r.job as JobTarget;
		const cs = await this.deps.docker.containerState(r.container_id).catch(() => null);
		if (cs === "stopped" || cs === "gone") return "container-down";
		if (cs !== "running") return null;
		const ins = await this.bgInspect(r.container_id, j.uid, {
			pid: j.pid,
			short: j.short,
			configDir: j.config_dir,
		});
		if (!ins) return null;
		if (ins.job && ins.job.absent === true) return "job-gone";
		if (ins.job && ins.job.absent !== true && ins.job.nonce !== j.nonce) return "job-relaunched";
		// No daemon answers and the worker we handed the text to is gone: the
		// daemon's shutdown reaps its workers, and nothing persists a queue.
		if (ins.job === null && ins.worker.start !== j.start) return "daemon-gone";
		return null;
	}

	/**
	 * Recovery / late evidence / admin pass for a job record (§8.1.12.6):
	 * effects by evidence, the ack by events + transcript, nothing resent.
	 */
	private async settleAndConcludeBg(op: LiveOp): Promise<void> {
		const r = op.record;
		await this.drainWrites(op);
		const changed = await this.settleEffects(r);
		if (changed) await this.writeRecord(op).catch(() => undefined);
		// The reply answered after T_http / shutdown cancelled the executor:
		// in THIS process its output is evidence.
		const late = op.bgLate;
		op.bgLate = undefined;
		if (late && !isFinalResult(r.result) && r.state !== "accepted") {
			if (late.kind === "accepted") {
				r.state = "accepted";
				await this.writeRecord(op).catch(() => undefined);
				await this.persistSafe(op, "accepted", { late: true });
			} else if (late.kind === "rejected" || late.kind === "aborted") {
				const http: HttpResult = {
					status: late.kind === "aborted" ? abortHttpCode(late.code).status : 502,
					body: {
						error: late.kind === "aborted" ? abortHttpCode(late.code).error : "delivery-failed",
						stage: "reply",
						detail: late.code,
					},
				};
				r.state = "failed";
				r.result = "failed";
				r.http = http;
				await this.writeRecord(op).catch(() => undefined);
				await this.persistSafe(op, "failed", { stage: "reply", http, late: true });
			}
		}
		// Nothing was ever created: nothing was sent.
		if (
			r.phase === "cancelled" &&
			!isFinalResult(r.result) &&
			r.state !== "accepted" &&
			r.execs.length === 0
		) {
			const http: HttpResult = {
				status: 502,
				body: { error: "delivery-failed", stage: "reply", segmentsSent: 0, detail: "cancelled" },
			};
			r.state = "failed";
			r.result = "failed";
			r.http = http;
			await this.writeRecord(op).catch(() => undefined);
			await this.persistSafe(op, "failed", { stage: "reply", http });
		}
		if (!isFinalResult(r.result) && (r.state === "accepted" || r.state === "uncertain")) {
			const live = this.live.get(op.key);
			if (live && live !== op) return; // the live executor owns its ack
			const v = await this.bgVerdict(r);
			const t0Ms = Date.parse(r.prepared_at);
			const gone =
				v.kind === "none" && r.state === "accepted" && this.now() < t0Ms + this.tAckBg
					? await this.bgJobGone(r)
					: null;
			if (v.kind !== "none") {
				if (v.kind !== "unconfirmed" || r.state === "accepted" || v.detail === "ambiguous")
					await this.applyBgVerdict(op, v, { deferred: true });
			} else if (r.state === "accepted" && this.now() >= t0Ms + this.tAckBg) {
				await this.applyBgVerdict(
					op,
					{
						kind: "unconfirmed",
						detail: v.transcriptMissing ? "transcript-unavailable" : "t-ack-bg",
					},
					{ deferred: true },
				);
			} else if (gone) {
				await this.applyBgVerdict(op, { kind: "unconfirmed", detail: gone }, { deferred: true });
			} else if (this.now() < t0Ms + this.tAckBg && !(op.bg && !op.bg.stopped)) {
				this.live.set(op.key, op);
				op.bg = undefined;
				this.startBgWatch(op, r.state === "accepted" ? t0Ms + this.tAckBg : null);
			}
		}
		await this.tryRelease(op, true);
	}

	/**
	 * §8.1.12.5 "duplicado por re-lanzamiento", after `delivered` (the record
	 * is already released): until t0 + T_ack_bg, a `session_start resume`
	 * then a second same-hash human prompt with a new prompt_id, and a probe
	 * naming the job with ANOTHER pid ⇒ one `composer_send{state:
	 * duplicated}` event — a visible marker, never a new ack. In-process
	 * only: a restart ends the watch (declared in the PR).
	 */
	private readonly dupWatches = new Set<{ stop(): void }>();
	/** client_message_ids with a live duplicate watch in this process. */
	private readonly dupWatched = new Set<string>();

	/**
	 * After a restart (audit round 1, S4): every background send `delivered`
	 * less than T_ack_bg ago (its `prepared` event's ts), with no
	 * `duplicated` marker yet, gets its watch back — rebuilt from its own
	 * `composer_send` events, which carry the job short, the worker pid
	 * (`pane_pid`), the hash and the ack's prompt_id/seq. The watch first
	 * checks the events persisted while no process was watching.
	 */
	private async rearmDupWatches(sid: string): Promise<void> {
		const cids = await this.deps.store.listConversationIds(sid).catch(() => [] as string[]);
		// Only conversations with events in the last day are scanned (cost);
		// the window itself is judged on the evidence's timestamps below.
		const horizon = new Date(this.now() - 24 * 60 * 60_000).toISOString();
		for (const cid of cids) {
			const idx = await this.deps.store.peekIndex(sid, cid).catch(() => null);
			if (!idx || idx.lastEventAt < horizon) continue;
			const events = await this.readCidEvents(sid, cid);
			const byId = new Map<
				string,
				{ prepared?: PersistedEvent; delivered?: PersistedEvent; dup?: boolean }
			>();
			for (const ev of events) {
				if (ev.ev !== "composer_send" || ev.data.transport !== "background") continue;
				const id = ev.data.client_message_id;
				if (typeof id !== "string") continue;
				const e = byId.get(id) ?? {};
				if (ev.data.state === "prepared") e.prepared = ev;
				if (ev.data.state === "delivered") e.delivered = ev;
				if (ev.data.state === "duplicated") e.dup = true;
				byId.set(id, e);
			}
			for (const [id, e] of byId) {
				if (!e.prepared || !e.delivered || e.dup || this.dupWatched.has(id)) continue;
				const d = e.delivered.data;
				const short = d.job;
				const pid = d.pane_pid;
				const promptId = d.prompt_id;
				const ackSeq = d.seq;
				if (
					typeof short !== "string" ||
					typeof pid !== "number" ||
					typeof promptId !== "string" ||
					typeof ackSeq !== "number" ||
					typeof d.text_hash !== "string"
				)
					continue;
				// In-memory only (never written): the fields the watch and the
				// marker event read.
				const r: PaneRecord = {
					v: 1,
					sid,
					pane_id: jobKey(short),
					pane_pid: pid,
					container_id: typeof d.container_id === "string" ? d.container_id : "",
					cid,
					client_message_id: id,
					text_hash: d.text_hash,
					prepared_at: e.prepared.ts,
					state: "released",
					result: "delivered",
					phase: "completed",
					execs: [],
					job: {
						short,
						pid,
						start: "",
						exe: "",
						nonce: "",
						pty_host_pid: 1,
						daemon_pid: 1,
						daemon_start: "",
						daemon_exe: "",
						version: "",
						uid: 1,
						config_dir: "",
					},
					updated_at: e.delivered.ts,
				};
				this.startDupWatch(r, { promptId, seq: ackSeq });
			}
		}
	}

	private startDupWatch(r: PaneRecord, ack: { promptId: string; seq: number }): void {
		const j = r.job as JobTarget;
		// The window is t0 + T_ack_bg on the EVIDENCE's clock (the resume's ts),
		// not "now": a backend that was down during it still judges what
		// happened inside it (one catch-up check, no listener).
		const until = Date.parse(r.prepared_at) + this.tAckBg;
		const live = this.now() < until;
		if (this.dupWatched.has(r.client_message_id)) return;
		this.dupWatched.add(r.client_message_id);
		let stopped = false;
		let busy = false;
		const check = async (retry: boolean): Promise<void> => {
			if (stopped || busy) return;
			busy = true;
			try {
				const events = await this.readCidEvents(r.sid, r.cid);
				const d = duplicateAfter(events, {
					hash: r.text_hash,
					ackSeq: ack.seq,
					ackPromptId: ack.promptId,
				});
				if (!d || Date.parse(d.resumeTs) > until) return;
				const ids = { prompt_id: d.promptId, seq: d.seq, first_prompt_id: ack.promptId };
				// Round 3.1 (SF-1): anything between the ack and the repeat that a
				// manual repeat could explain (a gap, a turn end — whatever its
				// prompt_id —, another human prompt) means it is never "proven",
				// at most possible, with the reasons.
				if (d.blockers.length > 0) {
					watch.stop();
					await this.emitDupMarker(r, "possible-duplicate", {
						...ids,
						reason: d.blockers.join(","),
					});
					return;
				}
				const probe = await this.deps.conversation.probeSession(r.sid).catch(() => null);
				const e = probe?.find((x) => x.id === j.short);
				if (e && typeof e.pid === "number" && e.pid !== j.pid) {
					// STRONG EVIDENCE (D4), never certainty: a resume of the job with
					// another process, and the same text again under a new prompt_id —
					// both ids recorded. A voluntary stop mid-turn + resume + the same
					// words retyped next looks identical (declared, §8.1.12.5).
					watch.stop();
					await this.emitDupMarker(r, "duplicated", { ...ids, job_pid: e.pid });
					logger.warn(
						`[composer-bg] ${r.sid} ${r.pane_id} ${r.client_message_id}: the job was relaunched (pid ${j.pid} → ${e.pid}) and the same text was submitted again — marked duplicated (strong evidence, not certainty)`,
					);
				} else if (e && e.pid === j.pid) {
					// The same process resumed and got the same words: not a relaunch
					// of ours (e.g. the person typed them again). No marker.
				} else if (retry) void this.after(3_000).then(() => check(false));
				else {
					// D4: the same text ran again after a resume, but no probe can
					// show the relaunch: a POSSIBLE repetition, said as such.
					await this.emitDupMarker(r, "possible-duplicate", {
						...ids,
						reason: probe ? "job-not-listed" : "probe-failed",
					});
				}
			} finally {
				busy = false;
			}
		};
		const unlisten = this.deps.conversation.onPersistedEvent((st, cid, ev) => {
			if (st === r.sid && cid === r.cid && ev.ev === "user_prompt") void check(true);
		});
		const watch = {
			stop: () => {
				stopped = true;
				unlisten();
				this.dupWatches.delete(watch);
				this.dupWatched.delete(r.client_message_id);
			},
		};
		this.dupWatches.add(watch);
		// Events persisted before the watch existed (a restart in between).
		void check(live);
		if (!live) {
			// Past the window: only the catch-up above; nothing new is watched.
			unlisten();
			return;
		}
		void this.after(until - this.now()).then(() => watch.stop());
	}

	/** Markers already written by this process: `<client_message_id>/<kind>`. */
	private readonly dupMarkers = new Set<string>();

	/**
	 * D4: one `composer_send{state: duplicated | possible-duplicate}` per send
	 * and kind, ever — idempotent across restarts: the conversation's own
	 * events are read before writing, and the marker is confirmed in the file
	 * (it is what a reload and the next process see).
	 */
	private async emitDupMarker(
		r: PaneRecord,
		kind: "duplicated" | "possible-duplicate",
		extra: Record<string, unknown>,
	): Promise<void> {
		const key = `${r.client_message_id}/${kind}`;
		if (this.dupMarkers.has(key)) return;
		this.dupMarkers.add(key);
		const events = await this.readCidEvents(r.sid, r.cid);
		if (
			events.some(
				(ev) =>
					ev.ev === "composer_send" &&
					ev.data.client_message_id === r.client_message_id &&
					ev.data.state === kind,
			)
		)
			return;
		const op = this.adoptRecord({ ...r, execs: [...r.execs] });
		try {
			await this.persist(op, kind, extra, { confirmed: true });
		} catch (err) {
			// Not on disk: a later check (or the next process) may try again.
			this.dupMarkers.delete(key);
			logger.error(`[composer-bg] ${kind} marker not persisted: ${(err as Error).message}`);
		}
	}

	/**
	 * D1: the person confirmed they checked the Terminal for an `unconfirmed`
	 * send (and are sending the same text again). A durable marker on THAT
	 * send, so the acknowledgement survives restarts and reloads. Confirmed in
	 * the file before the new send goes on: if it cannot be written, the new
	 * send would be refused again next time, never the reverse.
	 */
	private async persistAcknowledged(
		sid: string,
		cid: string,
		id: string,
		by: string,
	): Promise<void> {
		await this.deps.store.open(sid, cid);
		const outcome = this.deps.store.enqueue(sid, cid, {
			ev: "composer_send",
			prompt_id: null,
			turn_id: null,
			agent_id: null,
			pane: null,
			data: { client_message_id: id, state: "acknowledged", transport: "background", by },
		});
		if (outcome !== "queued") throw new Error(`acknowledged not queued (${outcome})`);
		// "Confirmed" as persist({confirmed}) means it: the store reports a failed
		// append as a drop, so the proof is the failure counter not moving.
		const failuresBefore = this.deps.store.stats.appendFailures;
		await this.deps.store.flush(sid, cid);
		if (this.deps.store.stats.appendFailures !== failuresBefore)
			throw new Error("append failed while confirming the acknowledgement");
	}

	private async readCidEvents(sid: string, cid: string): Promise<PersistedEvent[]> {
		const idx = await this.deps.store.peekIndex(sid, cid).catch(() => null);
		const after = Math.max(0, (idx?.lastSeq ?? 0) - BG_EVENT_SCAN);
		return this.deps.store
			.readEvents(sid, cid, after, BG_EVENT_SCAN, { archive: true })
			.catch(() => [] as PersistedEvent[]);
	}

	/** A long conversation's SessionStart may be older than the scanned tail. */
	private async transcriptPathFromHead(sid: string, cid: string): Promise<string | null> {
		const head = await this.deps.store
			.readEvents(sid, cid, 0, 256, { archive: true })
			.catch(() => [] as PersistedEvent[]);
		return transcriptPathOf(head);
	}

	/** uid (real = effective, not root), starttime and exe of `pid`, by /proc. */
	private async readProc(
		containerId: string,
		pid: number,
	): Promise<{ uid: number; start: string; exe: string } | null> {
		const run = (argv: string[]) =>
			withDeadline(
				this.deps.docker.exec(containerId, argv, null, async () => true),
				this.deps.liveExecDeadlineMs ?? LIVE_EXEC_DEADLINE_MS,
			);
		try {
			const st = await run(statusArgv(pid));
			const uids = st.exitCode === 0 ? parseUids(st.stdout) : null;
			if (!uids || uids.real !== uids.effective || uids.real === 0) return null;
			const stat = await run(statArgv(pid));
			const start = stat.exitCode === 0 ? parseStarttime(stat.stdout) : null;
			const link = await run(exeLinkArgv(pid));
			const exe = link.exitCode === 0 ? link.stdout.replace(/\n$/, "") : "";
			if (!start || !exe) return null;
			return { uid: uids.real, start, exe };
		} catch {
			return null;
		}
	}

	/** The in-container inspect (no effect), as the worker's uid. */
	private async bgInspect(
		containerId: string,
		uid: number,
		input: { pid: number; short: string; configDir?: string },
	): Promise<InspectResult | null> {
		try {
			const res = await withDeadline(
				this.deps.docker.exec(
					containerId,
					[...BG_CLIENT_ARGV],
					inspectStdin(input),
					async () => true,
					{ user: String(uid) },
				),
				this.deps.liveExecDeadlineMs ?? LIVE_EXEC_DEADLINE_MS,
			);
			return parseInspectOutput(res.exitCode, res.stdout);
		} catch {
			return null;
		}
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
		if (this.stopping) return this.reject("shutting-down", 503);
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
			persistFailuresSinceBoot: this.stats.persistFailures,
			...(this.bgEnabled ? { background: { enabled: true } } : {}),
		};
	}
}
