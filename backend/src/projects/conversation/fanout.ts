/**
 * projects/conversation/fanout.ts — `POST …/conversation/messages`
 * (docs/PROJECT_CONVERSATION.md §3).
 *
 * One owner message, one ordinary Composer send per recipient, each
 * independent. The order of §3.3 is the whole point and is kept literally:
 *
 *   resolve (D1 + conversation list, no lock)
 *   S1  idempotency decided under the lock; message + one planned|not-sent per recipient
 *   per recipient:
 *     a   D1 read (no lock)        → S2  compare with the fixed binding
 *     c0  D1 read (no lock)        → S3  compare again; write `sending` (the intent)
 *     d   Composer send (no lock)
 *     S4  write the result
 *
 * No lock is held across a D1 call or an effect; every log write is inside
 * a critical section. A delivery calls the Composer at most once in its
 * life: nothing here retries, and nothing after a restart sends (recovery.ts).
 * The binding guarantee is exactly the one §3.3 states: at c0 D1 said the
 * binding fixed in `planned` was live; a change D1 commits later cannot stop
 * that send, and the text still goes only to the fixed session.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { HttpResult } from "../../conversation/composer.js";
import { normalizeText, validateText } from "../../conversation/composerText.js";
import { logErrorToHttp } from "./api.js";
import {
	ARTIFACTS_PER_MESSAGE,
	type ArtifactRef,
	ArtifactStoreCorrupt,
	composeText,
} from "./artifacts.js";
import { taskFooter } from "./collabText.js";
import { type DeliveryState, deliveryKey, type Folded, grantAlive } from "./fold.js";
import type { LogLine } from "./log.js";
import type { PlacementResult } from "./placement.js";
import type { ProjectConversationStore } from "./store.js";

export const T_HTTP_MS = 30_000;
/** §3.3: a binding read that has not answered in this long is `binding-unverified`. */
export const BINDING_READ_MS = 5_000;
export const MAX_RECIPIENTS = 8;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;

export type ProjectBindings = Map<
	string,
	{ removed: boolean; binding: { bindingId: string; epoch: number; sessionId: string } | null }
>;

export type TargetResult =
	| { kind: "ok"; cid: string }
	| { kind: "none" }
	| { kind: "ambiguous"; count: number };

/**
 * The receiving conversation of an agent's session, by the Pilot 1 rule
 * (PROJECTS.md §9): exactly one live interactive conversation bound to a
 * pane and not blocked by a send in progress. More than one is ambiguous —
 * never a guess. Capture effectiveness is NOT decided here: the Composer
 * re-checks it in the send itself and refuses (`capture-inactive`).
 */
export function pickTarget(
	convs: ReadonlyArray<{
		cid: string;
		kind: string;
		paneId: string | null;
		endedAt?: string | null;
		blocked: boolean;
	}>,
): TargetResult {
	const live = convs.filter((c) => c.kind === "interactive" && c.paneId !== null && !c.endedAt);
	const ready = live.filter((c) => !c.blocked);
	if (ready.length === 1) return { kind: "ok", cid: (ready[0] as { cid: string }).cid };
	if (ready.length > 1) return { kind: "ambiguous", count: ready.length };
	return { kind: "none" };
}

export interface FanoutDeps {
	store: ProjectConversationStore;
	/** One uncached D1 read; `null` ⇔ not this owner's project. */
	bindings(ownerId: string, projectId: string): Promise<ProjectBindings | null>;
	/** The single interactive conversation that would receive (PROJECTS.md §9 rule). */
	target(sessionId: string): Promise<TargetResult>;
	/** The session's meta for the Composer; throws if the owner may not operate it. */
	sessionMeta(sessionId: string, ownerId: string): Promise<{ userId: string }>;
	composerSend(input: {
		stSessionId: string;
		cid: string;
		callerId: string;
		meta: { userId: string };
		body: { text: string; clientMessageId: string };
	}): Promise<HttpResult>;
	/** A delivery became `delivered` with a prompt id: follow its reply (replies.ts). */
	onDelivered(d: DeliveredRef): void;
	/** A delivery became `uncertain` after its call: follow the Composer's own evidence (§3.1). */
	onUncertain(d: {
		projectId: string;
		msgId: string;
		agentId: string;
		sid: string;
		cid: string;
		ccmid: string;
	}): void;
	/** Is this error an authorization refusal (foreign or missing session)? */
	isForbidden?(err: unknown): boolean;
	/**
	 * D2 (§6), present only with PROJECT_ARTIFACTS_ENABLED effective. Absent ⇒
	 * a non-empty `artifacts[]` is 409 `artifacts-off` and no file is touched.
	 */
	artifacts?: {
		lookup(
			projectId: string,
			shas: readonly string[],
		): Promise<{ ok: true; refs: ArtifactRef[] } | { ok: false; unknown: string }>;
		readContent(projectId: string, sha: string): Promise<Buffer | null>;
		/** §6.4 into the fixed session's `.st-inbox/` (placement.ts). */
		place(
			sessionId: string,
			artifacts: ReadonlyArray<ArtifactRef & { content: Buffer }>,
		): Promise<PlacementResult>;
	};
	/**
	 * D3 (§7), true only with PROJECT_RELAY_ENABLED effective. False/absent ⇒
	 * a `collab` in the body is 409 `relay-off` and no grant is ever written.
	 */
	relay?: boolean;
	now?: () => number;
	tHttpMs?: number;
}

/** §7.2 limits of a consult grant. */
export const COLLAB_LIMITS = {
	maxMessages: { min: 2, max: 6, def: 2 },
	expiresInMin: { min: 5, max: 1440, def: 120 },
	maxWaitMin: { min: 1, max: 240, def: 60 },
} as const;

export interface CollabRequest {
	with: string;
	maxMessages: number;
	expiresInMin: number;
	maxWaitMin: number;
}

export interface DeliveredRef {
	projectId: string;
	msgId: string;
	agentId: string;
	sid: string;
	cid: string;
	promptId: string;
	ackSeq: number;
}

interface Body {
	clientMessageId: string;
	text: string;
	normalized: string;
	to: string[];
	quoteRef: { msg_id: string; agent_id: string; prompt_id: string; report_sha256: string } | null;
	inReplyTo: string | null;
	/** sha256s, lowercase, in the order sent (§3.4 rule 2). */
	artifacts: string[];
	/** D3: the consult this task authorizes (§7.2), or null. */
	collab: CollabRequest | null;
}

export interface DeliveryAnswer {
	agentId: string;
	state: DeliveryState;
	reason?: string;
	http?: Record<string, unknown>;
	/** Not sent after a `placing`: some files may be in the target's inbox (§3.1). */
	filesPossiblyPlaced?: true;
}

const err = (status: number, code: string, detail?: string): HttpResult => ({
	status,
	body: detail ? { error: code, detail } : { error: code },
});

function parseCollab(raw: unknown, to: readonly string[]): CollabRequest | HttpResult {
	const bad = (d: string) => err(400, "invalid-body", `collab.${d}`);
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return err(400, "invalid-body", "collab");
	const c = raw as Record<string, unknown>;
	if (c.mode !== "ask") return bad("mode");
	if (typeof c.with !== "string" || !ID_RE.test(c.with)) return bad("with");
	const withAgent = c.with.toLowerCase();
	// §7.2: the task goes to exactly one agent, the initiator, and never to `with`.
	if (to.length !== 1 || to[0] === withAgent) return bad("with");
	const num = (k: keyof typeof COLLAB_LIMITS): number | null => {
		const lim = COLLAB_LIMITS[k];
		const v = c[k] === undefined ? lim.def : c[k];
		return typeof v === "number" && Number.isInteger(v) && v >= lim.min && v <= lim.max ? v : null;
	};
	const maxMessages = num("maxMessages");
	const expiresInMin = num("expiresInMin");
	const maxWaitMin = num("maxWaitMin");
	if (maxMessages === null) return bad("maxMessages");
	if (expiresInMin === null) return bad("expiresInMin");
	if (maxWaitMin === null) return bad("maxWaitMin");
	return { with: withAgent, maxMessages, expiresInMin, maxWaitMin };
}

export function parseBody(raw: unknown, artifactsOn = false, relayOn = false): Body | HttpResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return err(400, "invalid-body");
	const b = raw as Record<string, unknown>;
	if (typeof b.clientMessageId !== "string" || !UUID_V4_RE.test(b.clientMessageId)) {
		return err(400, "invalid-body", "clientMessageId");
	}
	if (typeof b.text !== "string") return err(400, "invalid-body", "text");
	let artifacts: string[] = [];
	if (b.artifacts !== undefined && !(Array.isArray(b.artifacts) && b.artifacts.length === 0)) {
		// D2 off: an attachment is refused, never dropped silently.
		if (!artifactsOn) return err(409, "artifacts-off");
		if (!Array.isArray(b.artifacts)) return err(400, "invalid-body", "artifacts");
		if (b.artifacts.length > ARTIFACTS_PER_MESSAGE) return err(400, "too-many-artifacts");
		artifacts = b.artifacts.map((x) => (typeof x === "string" ? x.toLowerCase() : ""));
		if (artifacts.some((x) => !SHA_RE.test(x)) || new Set(artifacts).size !== artifacts.length)
			return err(400, "invalid-body", "artifacts");
	}
	if (!Array.isArray(b.to) || b.to.length < 1 || b.to.length > MAX_RECIPIENTS) {
		return err(400, "invalid-body", "to");
	}
	const to = b.to.map((x) => (typeof x === "string" ? x.toLowerCase() : ""));
	if (to.some((x) => !ID_RE.test(x)) || new Set(to).size !== to.length)
		return err(400, "invalid-body", "to");
	let quoteRef: Body["quoteRef"] = null;
	if (b.quoteRef !== undefined && b.quoteRef !== null) {
		const q = b.quoteRef as Record<string, unknown>;
		if (
			typeof q !== "object" ||
			typeof q.msgId !== "string" ||
			!ID_RE.test(q.msgId) ||
			typeof q.agentId !== "string" ||
			!ID_RE.test(q.agentId) ||
			typeof q.promptId !== "string" ||
			q.promptId.length === 0 ||
			q.promptId.length > 128 ||
			typeof q.reportSha256 !== "string" ||
			!SHA_RE.test(q.reportSha256)
		) {
			return err(400, "invalid-body", "quoteRef");
		}
		quoteRef = {
			msg_id: q.msgId.toLowerCase(),
			agent_id: q.agentId.toLowerCase(),
			prompt_id: q.promptId,
			report_sha256: q.reportSha256,
		};
	}
	let inReplyTo: string | null = null;
	if (b.inReplyTo !== undefined && b.inReplyTo !== null) {
		if (typeof b.inReplyTo !== "string" || !ID_RE.test(b.inReplyTo))
			return err(400, "invalid-body", "inReplyTo");
		inReplyTo = b.inReplyTo.toLowerCase();
	}
	let collab: CollabRequest | null = null;
	if (b.collab !== undefined && b.collab !== null) {
		// D3 off: a consult request is refused, never sent as a plain task.
		if (!relayOn) return err(409, "relay-off");
		const c = parseCollab(b.collab, to);
		if ("status" in c) return c;
		collab = c;
	}
	const v = validateText(b.text);
	if (!v.ok) return err(400, v.code);
	return {
		collab,
		clientMessageId: b.clientMessageId.toLowerCase(),
		text: b.text,
		normalized: normalizeText(b.text),
		to,
		quoteRef,
		inReplyTo,
		artifacts,
	};
}

/**
 * §3.4 rule 2: the sha256 of the CANONICAL normalized body — not the bytes
 * received. Keys sorted, no whitespace; `to[]` sorted; artifacts by sha256
 * in the order sent; absent references are null.
 */
export function requestSha256(b: Body): string {
	const canon = {
		artifacts: b.artifacts,
		// Only when present (§7.2): a body without `collab` keeps its v0.3 hash.
		...(b.collab
			? {
					collab: {
						expires_in_min: b.collab.expiresInMin,
						max_messages: b.collab.maxMessages,
						max_wait_min: b.collab.maxWaitMin,
						mode: "ask",
						with: b.collab.with,
					},
				}
			: {}),
		in_reply_to: b.inReplyTo,
		quote_ref: b.quoteRef
			? {
					agent_id: b.quoteRef.agent_id,
					msg_id: b.quoteRef.msg_id,
					prompt_id: b.quoteRef.prompt_id,
					report_sha256: b.quoteRef.report_sha256,
				}
			: null,
		text: b.normalized,
		to: [...b.to].sort(),
	};
	return createHash("sha256").update(JSON.stringify(canon), "utf8").digest("hex");
}

const KNOWN_RESULTS: ReadonlySet<string> = new Set([
	"delivered",
	"unconfirmed",
	"misdelivered",
	"failed",
	"uncertain",
]);

/** §3.1: the Composer's answer as a delivery state. A throw never reads as "no effect". */
export function mapComposer(r: HttpResult | Error): {
	state: DeliveryState;
	reason?: string;
	http: Record<string, unknown>;
} {
	if (r instanceof Error)
		return { state: "uncertain", reason: "composer-error", http: { status: 0 } };
	const body = r.body as Record<string, unknown>;
	const code = typeof body.error === "string" ? body.error : undefined;
	if (r.status === 202) {
		const result = typeof body.result === "string" ? body.result : "";
		const http: Record<string, unknown> = { status: 202, result };
		if (typeof body.promptId === "string") http.promptId = body.promptId;
		if (typeof body.seq === "number") http.seq = body.seq;
		if (KNOWN_RESULTS.has(result)) return { state: result as DeliveryState, http };
		return { state: "uncertain", reason: "composer-error", http };
	}
	if ([400, 404, 409, 429, 503].includes(r.status)) {
		return {
			state: "refused",
			reason: code ?? (r.status === 404 ? "not-found" : String(r.status)),
			http: { status: r.status },
		};
	}
	if (r.status === 502)
		return { state: "failed", reason: code ?? "delivery-failed", http: { status: 502 } };
	return { state: "uncertain", reason: "composer-error", http: { status: r.status } };
}

/** The answer for an existing message (replay): its deliveries as they stand now. */
function answerFor(
	state: { deliveries: Map<string, { state: DeliveryState; reason?: string; placed?: boolean }> },
	msg: { msgId: string; to: string[] },
): DeliveryAnswer[] {
	return msg.to.map((agentId) => {
		const d = state.deliveries.get(deliveryKey(msg.msgId, agentId));
		const a: DeliveryAnswer = d?.reason
			? { agentId, state: d.state, reason: d.reason }
			: { agentId, state: d?.state ?? "planned" };
		// A replay is the same answer (§3.4): the inbox warning included.
		if (d?.placed && d.state === "not-sent") a.filesPossiblyPlaced = true;
		return a;
	});
}

export class ProjectFanout {
	constructor(private readonly deps: FanoutDeps) {}

	async send(ownerId: string, projectId: string, raw: unknown): Promise<HttpResult> {
		const started = (this.deps.now ?? Date.now)();
		const parsed = parseBody(raw, this.deps.artifacts !== undefined, this.deps.relay === true);
		if ("status" in parsed) return parsed;
		const body = parsed;
		const reqSha = requestSha256(body);

		// Cheap replay without the lock; the decision is retaken in S1.
		const early = await this.replayIfKnown(projectId, body.clientMessageId, reqSha);
		if (early) return early;

		// §6.3: the artifact lines are part of what the agent receives, so
		// they count in the text validation — before anything is resolved.
		let refs: ArtifactRef[] = [];
		if (body.artifacts.length > 0 && this.deps.artifacts) {
			let found: Awaited<ReturnType<NonNullable<FanoutDeps["artifacts"]>["lookup"]>>;
			try {
				found = await this.deps.artifacts.lookup(projectId, body.artifacts);
			} catch (e) {
				const h = logErrorToHttp(e);
				if (h) return h;
				throw e;
			}
			if (!found.ok) return err(400, "artifact-unknown", found.unknown);
			refs = found.refs;
			const v = validateText(composeText(body.normalized, refs));
			if (!v.ok) return err(400, v.code);
		}
		// §7.2: the grant's id and deadline exist before S1 because the protocol
		// footer names them, and the footer is part of what must pass the text
		// rules. Nothing is authorized until `grant{created}` is on disk.
		const grantId = `c-${randomBytes(6).toString("hex")}`;
		const expiresAt = body.collab
			? new Date(started + body.collab.expiresInMin * 60_000).toISOString()
			: "";
		let sent = composeText(body.normalized, refs);
		if (body.collab) {
			sent += taskFooter({
				grantId,
				withAgentId: body.collab.with,
				maxMessages: body.collab.maxMessages,
				expiresAt,
			});
			const v = validateText(sent);
			if (!v.ok) return err(400, v.code);
		}

		// ── resolve (§3.2), no lock ──
		const bindings = await this.deps.bindings(ownerId, projectId).catch(() => undefined);
		if (bindings === null) return err(404, "project-not-found");
		if (bindings === undefined) return err(503, "binding-unverified");
		const plans: Array<
			| { agentId: string; notSent: string }
			| {
					agentId: string;
					binding: { binding_id: string; epoch: number; sid: string; cid: string };
			  }
		> = [];
		for (const agentId of body.to) {
			const a = bindings.get(agentId);
			if (!a) return err(400, "invalid-body", "to: not an agent of this project");
			if (a.removed) {
				plans.push({ agentId, notSent: "agent-removed" });
				continue;
			}
			if (!a.binding) {
				plans.push({ agentId, notSent: "no-target" });
				continue;
			}
			let meta: { userId: string };
			try {
				meta = await this.deps.sessionMeta(a.binding.sessionId, ownerId);
			} catch (e) {
				// Only an authorization refusal is "foreign"; a D1 hiccup is retryable.
				if (this.deps.isForbidden?.(e)) return err(409, "foreign-session");
				return err(503, "binding-unverified");
			}
			if (meta.userId !== ownerId) return err(409, "foreign-session");
			const t = await this.deps
				.target(a.binding.sessionId)
				.catch(() => ({ kind: "none" }) as const);
			if (t.kind !== "ok") {
				plans.push({ agentId, notSent: t.kind === "ambiguous" ? "ambiguous-target" : "no-target" });
				continue;
			}
			plans.push({
				agentId,
				binding: {
					binding_id: a.binding.bindingId,
					epoch: a.binding.epoch,
					sid: a.binding.sessionId,
					cid: t.cid,
				},
			});
		}

		// §7.2: both participants live, in two different sessions of the owner,
		// read from the same D1 answer the task's own plan came from.
		let participants: Array<{
			agent_id: string;
			binding_id: string;
			epoch: number;
			sid: string;
		}> | null = null;
		const bindingsReadAt = new Date((this.deps.now ?? Date.now)()).toISOString();
		if (body.collab) {
			const w = bindings.get(body.collab.with);
			if (!w) return err(400, "invalid-body", "collab.with: not an agent of this project");
			if (w.removed) return err(409, "collab-unavailable", "agent-removed");
			if (!w.binding) return err(409, "collab-unavailable", "no-binding");
			try {
				const meta = await this.deps.sessionMeta(w.binding.sessionId, ownerId);
				if (meta.userId !== ownerId) return err(409, "foreign-session");
			} catch (e) {
				if (this.deps.isForbidden?.(e)) return err(409, "foreign-session");
				return err(503, "binding-unverified");
			}
			const first = plans[0];
			// A task that cannot even be planned creates no grant: the answer is the send's.
			if (first && "binding" in first) {
				if (first.binding.sid === w.binding.sessionId)
					return err(409, "collab-unavailable", "same-session");
				participants = [
					{
						agent_id: first.agentId,
						binding_id: first.binding.binding_id,
						epoch: first.binding.epoch,
						sid: first.binding.sid,
					},
					{
						agent_id: body.collab.with,
						binding_id: w.binding.bindingId,
						epoch: w.binding.epoch,
						sid: w.binding.sessionId,
					},
				];
			}
		}
		const collab = body.collab && participants ? { ...body.collab, participants } : null;

		// ── S1 ──
		const msgId = randomUUID();
		let s1: { replay: HttpResult } | { planned: Array<{ agentId: string; line: LogLine }> };
		try {
			s1 = await this.deps.store.critical(projectId, async (tx) => {
				const known = tx.state.byClientMessageId.get(body.clientMessageId);
				if (known) {
					const m = tx.state.messages.get(known);
					if (!m || m.requestSha256 !== reqSha) return { replay: err(409, "idempotency-conflict") };
					return {
						replay: {
							status: 202,
							body: {
								msgId: known,
								replayed: true,
								deliveries: answerFor(tx.state, m),
								...(m.grantId ? { grantId: m.grantId } : {}),
							},
						},
					};
				}
				if (collab) {
					// §7.2: one live grant per agent, decided under the same lock
					// that writes this one — two simultaneous creations make one.
					const now = (this.deps.now ?? Date.now)();
					const ids = new Set(collab.participants.map((p) => p.agent_id));
					for (const g of tx.state.grants.values()) {
						if (grantAlive(g, now) && g.participants.some((p) => ids.has(p.agent_id)))
							return { replay: err(409, "agent-in-collab", g.grantId) };
					}
				}
				for (const ref of [body.inReplyTo, body.quoteRef?.msg_id]) {
					if (ref && !tx.state.messages.has(ref))
						return { replay: err(400, "invalid-body", "unknown msgId reference") };
				}
				const lines = await tx.append([
					{
						ev: "message",
						msg_id: msgId,
						client_message_id: body.clientMessageId,
						by: ownerId,
						kind: "owner",
						to: body.to,
						text: body.normalized,
						text_sha256: createHash("sha256").update(body.normalized, "utf8").digest("hex"),
						request_sha256: reqSha,
						quote_ref: body.quoteRef,
						in_reply_to: body.inReplyTo,
						artifacts: refs,
						relay: null,
						...(collab ? { collab: { grant_id: grantId } } : {}),
					},
					...plans.map((p) =>
						"notSent" in p
							? {
									ev: "delivery",
									msg_id: msgId,
									agent_id: p.agentId,
									state: "not-sent",
									reason: p.notSent,
									authorized_by: "owner",
								}
							: {
									ev: "delivery",
									msg_id: msgId,
									agent_id: p.agentId,
									state: "planned",
									binding: p.binding,
									composer_client_message_id: randomUUID(),
									authorized_by: "owner",
								},
					),
					...(collab
						? [
								{
									ev: "grant",
									grant_id: grantId,
									event: "created",
									mode: "ask",
									task_msg_id: msgId,
									initiator: body.to[0] as string,
									with: collab.with,
									participants: collab.participants,
									bindings_read_at: bindingsReadAt,
									max_messages: collab.maxMessages,
									max_wait_min: collab.maxWaitMin,
									expires_at: expiresAt,
									by: ownerId,
								},
							]
						: []),
				]);
				return {
					planned: lines
						.filter((l) => l.ev === "delivery" && l.state === "planned")
						.map((l) => ({ agentId: l.agent_id as string, line: l })),
				};
			});
		} catch (e) {
			const h = logErrorToHttp(e);
			if (h) return h;
			throw e;
		}
		if ("replay" in s1) return s1.replay;

		// ── per recipient, independent ──
		const answers = new Map<string, DeliveryAnswer>();
		for (const p of plans)
			if ("notSent" in p)
				answers.set(p.agentId, { agentId: p.agentId, state: "not-sent", reason: p.notSent });
		const runs = s1.planned.map(({ agentId, line }) => {
			answers.set(agentId, { agentId, state: "planned" });
			return this.deliver(ownerId, projectId, msgId, agentId, line, sent, refs, answers, {
				authorizedBy: "owner",
			}).catch(() => {
				// deliver() records its own outcome; an escape here is a log error
				// already reported in `answers`.
			});
		});
		const budget = Math.max(
			0,
			(this.deps.tHttpMs ?? T_HTTP_MS) - ((this.deps.now ?? Date.now)() - started),
		);
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.all(runs),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, budget);
			}),
		]);
		clearTimeout(timer);
		return {
			status: 202,
			body: {
				msgId,
				replayed: false,
				deliveries: body.to.map((a) => answers.get(a) ?? { agentId: a, state: "planned" }),
				...(collab ? { grantId } : {}),
			},
		};
	}

	private async replayIfKnown(
		projectId: string,
		cmid: string,
		reqSha: string,
	): Promise<HttpResult | null> {
		try {
			return await this.deps.store.critical(projectId, async (tx) => {
				const known = tx.state.byClientMessageId.get(cmid);
				if (!known) return null;
				const m = tx.state.messages.get(known);
				if (!m || m.requestSha256 !== reqSha) return err(409, "idempotency-conflict");
				return {
					status: 202,
					body: {
						msgId: known,
						replayed: true,
						deliveries: answerFor(tx.state, m),
						...(m.grantId ? { grantId: m.grantId } : {}),
					},
				};
			});
		} catch (e) {
			const h = logErrorToHttp(e);
			if (h) return h;
			throw e;
		}
	}

	/**
	 * One planned delivery from S2 to S4 (§3.3). Also the path of a D3 relay
	 * (collab.ts), which passes its own `authorizedBy` and a `gate` that is
	 * evaluated INSIDE the critical section that writes `sending`: a pause or
	 * a revocation written before S3 wins and the Composer is never called.
	 */
	async deliver(
		ownerId: string,
		projectId: string,
		msgId: string,
		agentId: string,
		planned: LogLine,
		text: string,
		refs: readonly ArtifactRef[],
		answers: Map<string, DeliveryAnswer>,
		opts: { authorizedBy: string; gate?: (state: Folded) => string | null },
	): Promise<void> {
		const fixed = planned.binding as {
			binding_id: string;
			epoch: number;
			sid: string;
			cid: string;
		};
		const ccmid = planned.composer_client_message_id as string;
		const set = (a: Omit<DeliveryAnswer, "agentId">) => answers.set(agentId, { agentId, ...a });
		const matches = async (): Promise<"ok" | "binding-changed" | "binding-unverified"> => {
			let timer: NodeJS.Timeout | undefined;
			const b = await Promise.race([
				this.deps.bindings(ownerId, projectId).catch(() => undefined),
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), BINDING_READ_MS);
				}),
			]);
			clearTimeout(timer);
			if (!b) return "binding-unverified";
			const a = b.get(agentId);
			if (!a || a.removed || !a.binding) return "binding-changed";
			return a.binding.bindingId === fixed.binding_id &&
				a.binding.epoch === fixed.epoch &&
				a.binding.sessionId === fixed.sid
				? "ok"
				: "binding-changed";
		};
		// After a `placing`, every not-sent says files may be in the inbox (§3.1).
		let placing = false;
		const notSent = async (reason: string, extra: Record<string, unknown> = {}) => {
			try {
				await this.deps.store.critical(projectId, (tx) =>
					tx.append(
						[
							{
								ev: "delivery",
								msg_id: msgId,
								agent_id: agentId,
								state: "not-sent",
								reason,
								...extra,
								...(placing ? { files_possibly_placed: true } : {}),
								authorized_by: opts.authorizedBy,
							},
						],
						{
							allowMargin: true,
						},
					),
				);
				set({ state: "not-sent", reason, ...(placing ? { filesPossiblyPlaced: true } : {}) });
			} catch {
				// Poisoned: the planned line stays; recovery closes it not-sent{persist-failed}.
				set({
					state: "not-sent",
					reason: "persist-failed",
					...(placing ? { filesPossiblyPlaced: true } : {}),
				});
			}
		};

		// a → S2
		const a = await matches();
		if (a !== "ok") return notSent(a);

		// S2 → b' → S2b (§3.3, §6.4): the intent to touch the target's files
		// is durable BEFORE the first file is touched; the placement itself
		// runs without the lock; its failure is written in S2b and ends this
		// delivery — never retried.
		let placed: Array<{ sha256: string; path: string }> | undefined;
		if (refs.length > 0) {
			const art = this.deps.artifacts;
			if (!art) return notSent("artifact-failed", { artifact_error: "artifacts-off" });
			try {
				await this.deps.store.critical(projectId, (tx) =>
					tx.append(
						[
							{
								ev: "delivery",
								msg_id: msgId,
								agent_id: agentId,
								state: "placing",
								artifacts: refs,
								authorized_by: opts.authorizedBy,
							},
						],
						{ allowMargin: true },
					),
				);
			} catch {
				// No `placing` on disk ⇒ nothing was touched; recovery closes the planned.
				set({ state: "not-sent", reason: "persist-failed" });
				return;
			}
			placing = true;
			set({ state: "placing" });
			// A loss already known stops this effect too (§2.1 point 3): the
			// placement is an effect on the target, like the Composer call at d0.
			if (!this.deps.store.mayEffect(projectId)) return notSent("persist-failed");
			let r: PlacementResult;
			try {
				const contents = [];
				for (const ref of refs) {
					const content = await art.readContent(projectId, ref.sha256);
					if (!content) throw new ArtifactStoreCorrupt(`${ref.sha256}: content missing`);
					contents.push({ ...ref, content });
				}
				r = await art.place(fixed.sid, contents);
			} catch (e) {
				// The project's own copy failed its hash (or vanished): never placed (T13).
				r = {
					ok: false,
					error: e instanceof ArtifactStoreCorrupt ? "hash-mismatch" : "io",
					detail: (e as Error).message,
				};
			}
			if (!r.ok) return notSent("artifact-failed", { artifact_error: r.error });
			placed = r.placed;
		}

		// The session meta the Composer needs, read BEFORE the intent: a failure
		// here must leave the delivery not-sent, never an `uncertain` that no
		// call ever made.
		let meta: { userId: string };
		try {
			meta = await this.deps.sessionMeta(fixed.sid, ownerId);
		} catch {
			return notSent("binding-unverified");
		}
		// c0 → S3: the guaranteed checkpoint (t_c = when D1's answer arrived), then the intent.
		const c = await matches();
		const tC = new Date((this.deps.now ?? Date.now)()).toISOString();
		if (c !== "ok") return notSent(c);
		let gated: string | null = null;
		try {
			await this.deps.store.critical(projectId, async (tx) => {
				gated = opts.gate?.(tx.state) ?? null;
				await tx.append(
					[
						gated
							? {
									ev: "delivery",
									msg_id: msgId,
									agent_id: agentId,
									state: "not-sent",
									reason: gated,
									...(placing ? { files_possibly_placed: true } : {}),
									authorized_by: opts.authorizedBy,
								}
							: {
									ev: "delivery",
									msg_id: msgId,
									agent_id: agentId,
									state: "sending",
									binding_verified_at: tC,
									...(placed ? { artifacts_placed: placed } : {}),
									authorized_by: opts.authorizedBy,
								},
					],
					{ allowMargin: true },
				);
			});
		} catch {
			// No intent on disk ⇒ never sent (§3.3 3c).
			set({
				state: "not-sent",
				reason: "persist-failed",
				...(placing ? { filesPossiblyPlaced: true } : {}),
			});
			return;
		}
		if (gated) {
			set({ state: "not-sent", reason: gated });
			return;
		}
		set({ state: "sending" });

		// d0 — the point of no return (§3.3). A writer lock lost (or a log
		// poisoned) after the intent became durable stops the effect here: the
		// subsystem sends nothing more once a loss is known (§2.1 point 3). The
		// check and the call are in the same synchronous run, so nothing can be
		// detected in between that this check did not see; the residual (the
		// helper dying unseen) is the one §2.1 point 4 already names. The
		// `sending` stays on disk — nothing can be written without the lock —
		// and recovery makes it uncertain{orphaned}: fail closed, never resent.
		if (!this.deps.store.mayEffect(projectId)) {
			set({ state: "uncertain", reason: "persist-failed" });
			return;
		}
		// d — the effect, exactly once.
		let r: HttpResult | Error;
		try {
			r = await this.deps.composerSend({
				stSessionId: fixed.sid,
				cid: fixed.cid,
				callerId: ownerId,
				meta,
				body: { text, clientMessageId: ccmid },
			});
		} catch (e) {
			r = e as Error;
		}
		const m = mapComposer(r);

		// S4 — a failure here leaves `sending`; recovery makes it uncertain{orphaned}.
		try {
			await this.deps.store.critical(projectId, (tx) =>
				tx.append(
					[
						{
							ev: "delivery",
							msg_id: msgId,
							agent_id: agentId,
							state: m.state,
							...(m.reason ? { reason: m.reason } : {}),
							http: m.http,
							authorized_by: opts.authorizedBy,
						},
					],
					{ allowMargin: true },
				),
			);
		} catch {
			set({ state: "uncertain", reason: "persist-failed", http: m.http });
			return;
		}
		set({ state: m.state, ...(m.reason ? { reason: m.reason } : {}), http: m.http });
		if (m.state === "uncertain") {
			this.deps.onUncertain({ projectId, msgId, agentId, sid: fixed.sid, cid: fixed.cid, ccmid });
		}
		if (
			m.state === "delivered" &&
			typeof m.http.promptId === "string" &&
			typeof m.http.seq === "number"
		) {
			this.deps.onDelivered({
				projectId,
				msgId,
				agentId,
				sid: fixed.sid,
				cid: fixed.cid,
				promptId: m.http.promptId,
				ackSeq: m.http.seq,
			});
		}
	}
}
