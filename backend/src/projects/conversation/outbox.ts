/**
 * projects/conversation/outbox.ts — D3: from a capture event to an admitted
 * agent message (docs/PROJECT_CONVERSATION.md §7.3 rules 1–5, §7.3.1), the
 * write detection and the unverified sweep (§7.5).
 *
 * An agent "sends" by writing `~/workspace/.st-outbox/<name>.md` with the
 * Write tool. That is the trigger; it is NOT the authorization. This module
 * turns the trigger into a call to `ProjectCollab.admit` only when every one
 * of these holds, in this order, and the first failure decides:
 *
 *   1 event     a `tool_start` and a `tool_end{ok}` of the capture, both
 *               RECEIVED LIVE by this process, same session, conversation
 *               and `tool_use_id`, tool `Write`, main thread (no subagent),
 *               and the literal outbox path;
 *   2 origin    BOTH carry the network-origin verdict `match` — the request
 *               came from the session's current container. Anything else
 *               (a cause, `unchecked`, no verdict at all) is not a message.
 *               This is what lets the global flag stay in `observe`: the
 *               capture keeps a non-matching event, D3 ignores it;
 *   3 identity  the session is a participant of a live grant, D1 still has
 *               that agent on the binding the person saw, and the event's
 *               conversation is the session's only interactive one;
 *   4 file      opened through the Files opener (contained, no link, not
 *               restricted, regular, O_NOFOLLOW|O_NONBLOCK), ≤ 64 KiB;
 *   5 one read  the bytes read through that descriptor ARE the message:
 *               hashed, parsed and handed on. The file is never reopened,
 *               so whatever replaces it afterwards changes nothing.
 *
 * Failures of 1–3 write nothing: there is no message and nobody to charge
 * it to. A failure of 4 (and of the parser) is the agent's own and is
 * recorded through `admit` as `outbox{rejected}`.
 *
 * What an admission proves is "a process in the authorized session's
 * current container produced it", not "the CLI did": the hook relay accepts
 * any loopback POST. That is the agent's own trust domain (§7.8).
 */

import { createHash } from "node:crypto";
import type { EventMeta, PersistedEvent } from "../../conversation/store.js";
import type { OpenedWorkspaceFile, WorkspaceListing } from "../../workspaceFiles.js";
import type { AdmitInput, AdmitResult, ProjectCollab, RecipientState } from "./collab.js";
import { OUTBOX_ABS_RE, OUTBOX_DIR, OUTBOX_MAX_BYTES, parseOutbox } from "./collabText.js";
import { BINDING_READ_MS, type ProjectBindings } from "./fanout.js";

/** `tool_start`s waiting for their `tool_end`, per process. */
export const PENDING_MAX = 256;
export const PENDING_TTL_MS = 10 * 60_000;
/** §7.5: the sweep's period and how long a file must have been quiet. */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
export const SWEEP_QUIET_MS = 2 * 60_000;
const SWEEP_MAX_ENTRIES = 64;
/** Tools whose `tool_start` names a file the agent is about to change. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

type FsError = { ok: false; status: number; error: string };

export interface OutboxDeps {
	collab: Pick<
		ProjectCollab,
		"grantOfSession" | "describe" | "admit" | "writeObserved" | "noteUnverified" | "liveSessions"
	>;
	/** Persisted capture events with what this process knows about them (store.ts `EventMeta`). */
	onCaptureEvent(
		listener: (sid: string, cid: string, ev: PersistedEvent, meta?: EventMeta) => void,
	): () => void;
	bindings(ownerId: string, projectId: string): Promise<ProjectBindings | null>;
	/** The session's single interactive conversation (collab.ts `recipient`). */
	conversation(sid: string): Promise<RecipientState>;
	/** workspaceFiles.ts `openWorkspaceFile`. */
	openFile(
		sid: string,
		rel: string,
		opts: { maxBytes: number },
	): Promise<OpenedWorkspaceFile | FsError>;
	/** workspaceFiles.ts `listWorkspaceDir`. */
	listDir(
		sid: string,
		rel: string,
		opts: { maxEntries: number },
	): Promise<WorkspaceListing | FsError>;
	now?: () => number;
	sweepIntervalMs?: number;
	log?: { info(m: string): void; warn(m: string): void };
}

export interface OutboxStats {
	/** Outbox writes seen whose two events did not both carry `match`. */
	originNotMatched: number;
	/** Reached `admit`, by outcome. */
	admitted: Record<string, number>;
	/** Dropped before `admit`, by rule (`identity`, `conversation`, …). */
	notAMessage: Record<string, number>;
}

/** Reads an opened file once, bounded, and closes it. `null` ⇔ longer than the cap. */
async function readOnce(f: OpenedWorkspaceFile): Promise<Buffer | null> {
	try {
		// One byte past the cap: a file that grew after the fstat is still refused.
		const buf = Buffer.alloc(OUTBOX_MAX_BYTES + 1);
		let filled = 0;
		while (filled < buf.length) {
			const { bytesRead } = await f.handle.read(buf, filled, buf.length - filled, filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		return filled > OUTBOX_MAX_BYTES ? null : buf.subarray(0, filled);
	} finally {
		await f.handle.close().catch(() => {});
	}
}

const fileReason = (e: FsError): `file-${string}` =>
	e.status === 413
		? "file-too-large"
		: e.status === 403
			? "file-restricted"
			: e.status === 404
				? "file-not-found"
				: "file-not-regular";

export class OutboxWatcher {
	private readonly pending = new Map<string, { name: string; origin: string; at: number }>();
	/** Per session: admissions run one after another, in the order their events arrived. */
	private readonly chains = new Map<string, Promise<void>>();
	private unlisten: (() => void) | undefined;
	private interval: NodeJS.Timeout | undefined;
	private stopped = false;
	readonly stats: OutboxStats = { originNotMatched: 0, admitted: {}, notAMessage: {} };

	constructor(private readonly deps: OutboxDeps) {}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	start(): void {
		this.unlisten = this.deps.onCaptureEvent((sid, cid, ev, meta) => {
			try {
				this.onEvent(sid, cid, ev, meta);
			} catch (err) {
				this.deps.log?.warn(`[outbox] event: ${(err as Error).message}`);
			}
		});
		this.interval = setInterval(
			() => void this.sweep(),
			this.deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
		);
		this.interval.unref?.();
		void this.sweep();
	}

	stop(): void {
		this.stopped = true;
		this.unlisten?.();
		clearInterval(this.interval);
	}

	/** Resolves when every admission started so far has finished (tests, shutdown). */
	async idle(): Promise<void> {
		await Promise.all([...this.chains.values()]);
	}

	// ── Rules 1–2: the two live events and their origin ───────────────────

	private onEvent(sid: string, cid: string, ev: PersistedEvent, meta: EventMeta | undefined): void {
		if (this.stopped || (ev.ev !== "tool_start" && ev.ev !== "tool_end")) return;
		// Cheap and synchronous: sessions outside a live grant cost nothing.
		if (!this.deps.collab.grantOfSession(sid)) return;
		const d = ev.data ?? {};
		const tool = typeof d.tool_name === "string" ? d.tool_name : "";
		const toolUseId = typeof d.tool_use_id === "string" ? d.tool_use_id : "";
		const key = `${sid}\u0000${cid}\u0000${toolUseId}`;

		if (ev.ev === "tool_start") {
			if (!WRITE_TOOLS.has(tool)) return;
			const fp = (d.summary as { file_path?: unknown } | undefined)?.file_path;
			const m = typeof fp === "string" ? OUTBOX_ABS_RE.exec(fp) : null;
			// A subagent's Write, another tool, or any other path is never a
			// message — and, for the consulted agent, is a write to report.
			if (!m || tool !== "Write" || ev.agent_id !== null || !toolUseId) {
				if (!m) void this.deps.collab.writeObserved(sid, { tool, cid });
				return;
			}
			this.prune();
			this.pending.set(key, {
				name: m[1] as string,
				origin: meta?.origin ?? "none",
				at: this.now(),
			});
			return;
		}

		const p = this.pending.get(key);
		if (!p) return;
		this.pending.delete(key);
		if (tool !== "Write" || ev.agent_id !== null || d.ok !== true) return;
		if (this.now() - p.at > PENDING_TTL_MS) return;
		// Rule 2, fail closed: both events, exactly `match`.
		if (p.origin !== "match" || meta?.origin !== "match") {
			this.stats.originNotMatched++;
			this.deps.log?.warn(
				`[outbox] ${sid}: outbox write without a verified origin (${p.origin}/${meta?.origin ?? "none"}) — not a message`,
			);
			return;
		}
		const prev = this.chains.get(sid) ?? Promise.resolve();
		const run = prev
			.then(() => this.process(sid, cid, toolUseId, p.name))
			.catch((err) => this.deps.log?.warn(`[outbox] ${sid}: ${(err as Error).message}`));
		this.chains.set(sid, run);
		void run.then(() => {
			if (this.chains.get(sid) === run) this.chains.delete(sid);
		});
	}

	private prune(): void {
		const now = this.now();
		for (const [k, v] of this.pending) {
			if (now - v.at > PENDING_TTL_MS) this.pending.delete(k);
		}
		// Insertion order: the oldest goes first. A start whose end never
		// comes is simply forgotten — it was never a message.
		while (this.pending.size >= PENDING_MAX) {
			this.pending.delete(this.pending.keys().next().value as string);
		}
	}

	private drop(rule: string): void {
		this.stats.notAMessage[rule] = (this.stats.notAMessage[rule] ?? 0) + 1;
	}

	// ── Rules 3–5, then admit ─────────────────────────────────────────────

	private async process(sid: string, cid: string, toolUseId: string, name: string): Promise<void> {
		const who = await this.identify(sid, cid);
		if (!who) return;
		const rel = `${OUTBOX_DIR}/${name}`;
		const base = {
			projectId: who.projectId,
			grantId: who.grantId,
			from: { ...who.participant, cid },
			toolUseId,
			path: rel,
		};
		let input: AdmitInput;
		const opened = await this.deps.openFile(sid, rel, { maxBytes: OUTBOX_MAX_BYTES });
		if (!opened.ok) {
			input = { ...base, sha256: "", bytes: 0, parsed: { ok: false, reason: fileReason(opened) } };
		} else {
			const bytes = await readOnce(opened);
			input = bytes
				? {
						...base,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						bytes: bytes.length,
						parsed: parseOutbox(bytes),
					}
				: { ...base, sha256: "", bytes: 0, parsed: { ok: false, reason: "file-too-large" } };
		}
		const r: AdmitResult = await this.deps.collab.admit(input);
		const k = r.outcome === "rejected" ? `rejected:${r.reason}` : r.outcome;
		this.stats.admitted[k] = (this.stats.admitted[k] ?? 0) + 1;
	}

	/** Rule 3. `null` ⇔ not a message (counted by rule). */
	private async identify(
		sid: string,
		cid: string,
	): Promise<{
		projectId: string;
		grantId: string;
		participant: { agent_id: string; binding_id: string; epoch: number; sid: string };
	} | null> {
		const e = this.deps.collab.grantOfSession(sid);
		if (!e) return this.none("no-grant");
		const g = await this.deps.collab.describe(e.projectId, e.grantId);
		const me = g?.participants.find((p) => p.sid === sid && p.agent_id === e.agentId);
		if (!g || !me) return this.none("no-grant");
		// D1 now, not the grant's memory of it: the agent may have been
		// removed or re-bound since the person authorized.
		let timer: NodeJS.Timeout | undefined;
		const b = await Promise.race([
			this.deps.bindings(g.by, e.projectId).catch(() => undefined),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), BINDING_READ_MS);
			}),
		]);
		clearTimeout(timer);
		const cur = b?.get(me.agent_id);
		if (
			!cur ||
			cur.removed ||
			!cur.binding ||
			cur.binding.bindingId !== me.binding_id ||
			cur.binding.epoch !== me.epoch ||
			cur.binding.sessionId !== sid
		) {
			return this.none("identity");
		}
		const conv = await this.deps.conversation(sid).catch(() => ({ kind: "none" }) as const);
		if ((conv.kind !== "ready" && conv.kind !== "busy") || conv.cid !== cid) {
			return this.none("conversation");
		}
		return { projectId: e.projectId, grantId: e.grantId, participant: me };
	}

	private none(rule: string): null {
		this.drop(rule);
		return null;
	}

	// ── §7.5: files the log knows nothing about ───────────────────────────

	/**
	 * Looks at each live participant's outbox directory. A file that names
	 * the session's grant, has been quiet for two minutes and has no outbox
	 * line is recorded `unverified` — once, visible, NEVER sent: there is no
	 * verified event behind it. Reading it is the same bounded single read
	 * as an admission.
	 */
	async sweep(): Promise<void> {
		if (this.stopped) return;
		for (const s of this.deps.collab.liveSessions()) {
			try {
				await this.sweepSession(s);
			} catch (err) {
				this.deps.log?.warn(`[outbox] sweep ${s.sid}: ${(err as Error).message}`);
			}
		}
	}

	private async sweepSession(s: {
		sid: string;
		projectId: string;
		grantId: string;
		agentId: string;
	}): Promise<void> {
		const g = await this.deps.collab.describe(s.projectId, s.grantId);
		const me = g?.participants.find((p) => p.sid === s.sid && p.agent_id === s.agentId);
		if (!me) return;
		const listing = await this.deps.listDir(s.sid, OUTBOX_DIR, { maxEntries: SWEEP_MAX_ENTRIES });
		if (!listing.ok) return;
		const cutoff = this.now() - SWEEP_QUIET_MS;
		for (const entry of listing.entries) {
			if (entry.type !== "file" || entry.restricted) continue;
			if (!OUTBOX_ABS_RE.test(`/home/developer/workspace/${OUTBOX_DIR}/${entry.name}`)) continue;
			if (entry.size === null || entry.size > OUTBOX_MAX_BYTES) continue;
			if (!entry.mtime || Date.parse(entry.mtime) > cutoff) continue;
			const rel = `${OUTBOX_DIR}/${entry.name}`;
			const opened = await this.deps.openFile(s.sid, rel, { maxBytes: OUTBOX_MAX_BYTES });
			if (!opened.ok) continue;
			const bytes = await readOnce(opened);
			if (!bytes) continue;
			const parsed = parseOutbox(bytes);
			if (!parsed.ok || parsed.header.collab !== s.grantId) continue;
			await this.deps.collab.noteUnverified({
				projectId: s.projectId,
				grantId: s.grantId,
				from: me,
				path: rel,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				bytes: bytes.length,
				kind: parsed.header.kind,
			});
		}
	}
}
