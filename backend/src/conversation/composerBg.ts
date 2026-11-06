/**
 * conversation/composerBg.ts — the pure half of the composer's background
 * transport (docs/CONVERSATION.md §8.1.12, v1.9 proposal, EXPERIMENTAL,
 * behind `CONVERSATION_COMPOSER_BG_ENABLED`): configuration, the ack
 * attribution of §8.1.12.5 over persisted events plus the conversation's
 * transcript, the duplicate exclusion, and the transcript reader.
 *
 * Why the ack needs the transcript (§8.1.12.5): the CLI propagates no id of
 * a `reply`. Its UserPromptSubmit carries the same keys as a typed prompt
 * and the reply sets `origin: human`, so a hook alone cannot tell our text
 * from the person typing the same words. The transcript can: a reply is a
 * `queue-operation: enqueue` followed by a user entry with
 * `promptSource: "queued"` and the hook's `promptId`; text typed while idle
 * is `promptSource: "typed"` with no enqueue. Text typed while busy fires
 * the hook at ENQUEUE time with the RUNNING turn's prompt_id, which is why
 * a candidate's prompt_id must be new.
 *
 * Residual false positive (contract §8.1.12.5, revision 3): it needs ANOTHER
 * daemon client (another backend, the agents view) to enqueue exactly the
 * same text inside our 2 s window AND ours to be lost without any queue
 * operation, AND the foreign item to take our item's FIFO slot. A person
 * typing the same words does not produce it: their busy-typed hook carries
 * the running turn's prompt_id (cond. 1) and two identical enqueues in the
 * window are ambiguous (cond. 2). It never produces a double send.
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import { logger } from "../logger.js";
import { openWorkspaceFile } from "../workspaceFiles.js";
import { parseVersion } from "./cliPolicy.js";
import { normalizeText, textHash } from "./composerText.js";
import type { PersistedEvent } from "./store.js";

// ── Constants (§8.1.12) ─────────────────────────────────────────────────────

/** `accepted` with no complete ack for this long ⇒ `unconfirmed` (§8.1.12.6). */
export const T_ACK_BG_MS = 10 * 60_000;
/** The transcript enqueue must land ≤ 2 s after t0 (§8.1.12.5 cond. 2). */
export const ENQUEUE_WINDOW_MS = 2_000;
/** While `accepted`: re-evaluate the ack (the transcript may trail the hook). */
export const BG_ACK_POLL_MS = 5_000;
/** While `accepted`: ask the daemon whether the job is still there (`list`). */
export const BG_JOB_CHECK_MS = 30_000;
/** How much of a transcript's tail is read (the entries we need are recent). */
export const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
/** Events of one conversation scanned for an ack / the recent-hash rule. */
export const BG_EVENT_SCAN = 4096;

/** `CONVERSATION_COMPOSER_BG_ENABLED`: only `true` / `1`; unset or empty = off. */
export function bgFlagEnabled(raw: string | undefined): boolean {
	return raw === "true" || raw === "1";
}

/**
 * `COMPOSER_BG_CLI_VERSIONS`: an EXACT list, no open minimum, default EMPTY
 * (nothing validated ⇒ every send is `cli-unvalidated`). A malformed entry
 * throws: configured but unusable must not silently become something else.
 */
export function parseBgVersions(raw: string | undefined): Set<string> {
	const entries = (raw ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
	const bad = entries.filter((v) => !parseVersion(v));
	if (bad.length > 0)
		throw new Error(`COMPOSER_BG_CLI_VERSIONS: not a version: ${bad.join(", ")} (expected X.Y.Z)`);
	return new Set(entries);
}

// ── Transcript ──────────────────────────────────────────────────────────────

export interface TranscriptEntry {
	type: string;
	operation?: string;
	/** Present on `queue-operation` enqueue / popAll. */
	contentHash?: string;
	/** Parsed `timestamp`, ms since epoch; NaN when absent. */
	at: number;
	sessionId?: string;
	promptSource?: string;
	promptId?: string;
}

/**
 * Only what the ack needs leaves this function: hashes, never content.
 * Lines that do not parse are skipped (the first line of a tail read may be
 * cut in half).
 */
export function parseTranscript(text: string): TranscriptEntry[] {
	const out: TranscriptEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		let j: Record<string, unknown>;
		try {
			j = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (!j || typeof j !== "object" || typeof j.type !== "string") continue;
		const e: TranscriptEntry = {
			type: j.type,
			at: typeof j.timestamp === "string" ? Date.parse(j.timestamp) : Number.NaN,
		};
		if (typeof j.sessionId === "string") e.sessionId = j.sessionId;
		if (j.type === "queue-operation") {
			if (typeof j.operation === "string") e.operation = j.operation;
			if (typeof j.content === "string") e.contentHash = textHash(normalizeText(j.content));
		} else if (j.type === "user") {
			if (typeof j.promptSource === "string") e.promptSource = j.promptSource;
			if (typeof j.promptId === "string") e.promptId = j.promptId;
		} else continue;
		out.push(e);
	}
	return out;
}

/**
 * §8.1.12.5 cond. 2, paired (audit round 1, S2): OUR enqueue — the one
 * same-content enqueue in [t0, t0 + 2 s] — must be the very item the
 * `queued` user entry with the hook's promptId took off the queue.
 *
 * Two independent "some()" checks would let a LATER identical text from
 * another reply client confirm ours after ours was enqueued and lost (a
 * popAll by the person, a teardown), widening the false positive from 2 s
 * to T_ack_bg. So the queue is replayed in transcript order from t0 (the
 * job was idle at t0 — double idle read — so its queue was empty):
 * enqueue pushes, dequeue moves the head to "taken", a `queued` user entry
 * consumes the oldest taken item, popAll (or any other queue op) empties
 * the queue. Ours is confirmed only if ITS item is consumed by the entry
 * with that promptId, with no popAll and no other same-content enqueue
 * between our enqueue and that entry. A second same-content enqueue inside
 * the window is ambiguous ⇒ not confirmed.
 */
export function transcriptConfirms(
	entries: TranscriptEntry[],
	q: { cid: string; t0Ms: number; hash: string; promptId: string },
): boolean {
	const inWindow = (e: TranscriptEntry) =>
		e.type === "queue-operation" &&
		e.operation === "enqueue" &&
		e.sessionId === q.cid &&
		e.contentHash === q.hash &&
		e.at >= q.t0Ms - CLOCK_SLACK_MS &&
		e.at <= q.t0Ms + ENQUEUE_WINDOW_MS;
	if (entries.filter(inWindow).length !== 1) return false;
	interface Item {
		ours: boolean;
	}
	let queue: Item[] = [];
	const taken: Item[] = [];
	let oursSeen = false;
	for (const e of entries) {
		if (e.sessionId !== undefined && e.sessionId !== q.cid) continue;
		if (!(e.at >= q.t0Ms - CLOCK_SLACK_MS)) continue;
		if (e.type === "queue-operation") {
			if (e.operation === "enqueue") {
				const ours = !oursSeen && inWindow(e);
				// Another identical text after ours, before ours was consumed.
				if (oursSeen && !ours && e.contentHash === q.hash) return false;
				if (ours) oursSeen = true;
				queue.push({ ours });
			} else if (e.operation === "dequeue") {
				const head = queue.shift();
				if (head) taken.push(head);
			} else {
				// popAll (the person took the queue back with ↑) or any other
				// queue op: whatever was queued is gone; ours never ran from it.
				if (queue.some((x) => x.ours) || taken.some((x) => x.ours)) return false;
				queue = [];
			}
		} else if (e.type === "user" && e.promptSource === "queued") {
			const item = taken.shift();
			if (item?.ours) return e.promptId === q.promptId;
		}
	}
	return false;
}

/**
 * When OUR enqueue (the single same-content enqueue in the window) landed,
 * ms since t0 — evidence for the delivered event and the canary (round 3).
 * null when there is not exactly one.
 */
export function ourEnqueueLatencyMs(
	entries: TranscriptEntry[],
	q: { cid: string; t0Ms: number; hash: string },
): number | null {
	const hits = entries.filter(
		(e) =>
			e.type === "queue-operation" &&
			e.operation === "enqueue" &&
			e.sessionId === q.cid &&
			e.contentHash === q.hash &&
			e.at >= q.t0Ms - CLOCK_SLACK_MS &&
			e.at <= q.t0Ms + ENQUEUE_WINDOW_MS,
	);
	return hits.length === 1 ? (hits[0] as TranscriptEntry).at - q.t0Ms : null;
}

/**
 * t0 is the backend's clock and the transcript the container's: both read
 * the host kernel's clock, but the ISO millisecond of the CLI may round. A
 * few ms of slack BEFORE t0 only (an enqueue cannot precede the reply that
 * caused it by more than that), never after the 2 s window.
 */
const CLOCK_SLACK_MS = 5;

/**
 * §8.1.12.5 cond. 3 (owner decision D1, round 2): refuse only on AMBIGUOUS
 * queue state, never because a text was once sent. The CLI's queue is
 * replayed in transcript order (enqueue pushes, dequeue moves the head to
 * "taken", a `queued` user entry consumes the oldest taken item, popAll or
 * any other queue op empties the queue): a same-content item still waiting
 * in the queue, or taken but not yet run as a prompt, would make a new
 * identical text indistinguishable from it ⇒ `duplicate-pending`. A text
 * that ran (its `queued` entry exists) or was taken back with ↑ (popAll)
 * leaves nothing pending, so repeating it is allowed.
 *
 * Limit: the replay starts at the tail read (TRANSCRIPT_TAIL_BYTES); an item
 * enqueued before the tail and still pending is not seen. The double idle
 * read makes that improbable (an idle job runs its queue).
 */
export function pendingSameContent(
	entries: TranscriptEntry[],
	q: { cid: string; hash: string },
): boolean {
	let queue: Array<string | undefined> = [];
	const taken: Array<string | undefined> = [];
	for (const e of entries) {
		if (e.sessionId !== undefined && e.sessionId !== q.cid) continue;
		if (e.type === "queue-operation") {
			if (e.operation === "enqueue") queue.push(e.contentHash);
			else if (e.operation === "dequeue") {
				if (queue.length > 0) taken.push(queue.shift());
			} else queue = [];
		} else if (e.type === "user" && e.promptSource === "queued") taken.shift();
	}
	return queue.includes(q.hash) || taken.includes(q.hash);
}

/** Port: the tail of a conversation's transcript, read host-side without following links. */
export interface TranscriptPort {
	/** `transcriptPath` is the container path the SessionStart hook reported. null = unreadable. */
	readTail(stSessionId: string, transcriptPath: string, maxBytes: number): Promise<string | null>;
}

/** The container HOME's `~/.claude` lives at `<workspace>/.st/claude-state` (entrypoint.sh, #377). */
const CONTAINER_STATE = "/home/developer/.claude/";
const WORKSPACE_STATE = ".st/claude-state/";

/**
 * Map the hook's container path to the workspace-relative host path, or
 * null when it is not a transcript under the container's `~/.claude/projects`
 * (a CLAUDE_CONFIG_DIR elsewhere, a `..`, anything odd ⇒ no evidence).
 */
export function transcriptRel(transcriptPath: string): string | null {
	if (!transcriptPath.startsWith(`${CONTAINER_STATE}projects/`)) return null;
	const rest = transcriptPath.slice(CONTAINER_STATE.length);
	const parts = rest.split("/");
	if (parts.length !== 3) return null;
	if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\0"))) return null;
	if (!/^[0-9a-f-]{36}\.jsonl$/.test(parts[2] as string)) return null;
	return `${WORKSPACE_STATE}${rest}`;
}

/**
 * Production reader: `openWorkspaceFile` (lexical containment, realpath of
 * the parent, O_NOFOLLOW on the leaf, the /proc proof of what was opened)
 * with `allowRestricted` — `.st/` is refused to every request path, and
 * this is a backend-internal read whose content never leaves the process:
 * only hashes and ids are kept (parseTranscript).
 */
export const workspaceTranscripts: TranscriptPort = {
	async readTail(sid, transcriptPath, maxBytes) {
		const rel = transcriptRel(transcriptPath);
		if (!rel) return null;
		const opened = await openWorkspaceFile(sid, rel, { allowRestricted: true }).catch((err) => {
			logger.warn(`[composer-bg] transcript open failed: ${(err as Error).message}`);
			return null;
		});
		if (!opened?.ok) return null;
		try {
			const size = opened.size;
			const from = Math.max(0, size - maxBytes);
			const buf = Buffer.alloc(size - from);
			let filled = 0;
			while (filled < buf.length) {
				const { bytesRead } = await opened.handle.read(
					buf,
					filled,
					buf.length - filled,
					from + filled,
				);
				if (bytesRead === 0) break;
				filled += bytesRead;
			}
			return buf.subarray(0, filled).toString("utf8");
		} catch {
			return null;
		} finally {
			await opened.handle.close().catch(() => undefined);
		}
	},
};

/** Local reader for the sandbox smoke: a path on this host, leaf opened with O_NOFOLLOW (a link ⇒ ELOOP ⇒ null). */
export function localTranscripts(mapPath: (p: string) => string | null): TranscriptPort {
	return {
		async readTail(_sid, transcriptPath, maxBytes) {
			const p = mapPath(transcriptPath);
			if (!p) return null;
			let fh: fs.FileHandle | null = null;
			try {
				fh = await fs.open(
					p,
					fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
				);
				const st = await fh.stat();
				if (!st.isFile()) return null;
				const from = Math.max(0, st.size - maxBytes);
				const buf = Buffer.alloc(st.size - from);
				const { bytesRead } = await fh.read(buf, 0, buf.length, from);
				return buf.subarray(0, bytesRead).toString("utf8");
			} catch {
				return null;
			} finally {
				await fh?.close().catch(() => undefined);
			}
		},
	};
}

// ── Ack attribution over events (§8.1.12.5 cond. 1) ─────────────────────────

/** A human prompt with our hash (no `/`/`!` prefix ever reaches here: validateText refused it). */
export function isHumanSameHash(ev: PersistedEvent, hash: string): boolean {
	if (ev.ev !== "user_prompt") return false;
	const d = ev.data;
	if (d.source !== undefined && d.source !== "user") return false;
	if (d.origin === "unverified") return false;
	if (typeof d.prompt !== "string") return false;
	return textHash(normalizeText(d.prompt)) === hash;
}

export interface BgCandidate {
	cid: string;
	promptId: string;
	seq: number;
	ts: string;
}

/**
 * The first hook candidate in one conversation's events (seq order): a human
 * `user_prompt` with our hash, persisted after t0, whose prompt_id is NEW —
 * it appeared on no earlier event of that conversation. A text typed while
 * busy fires the hook with the running turn's prompt_id, which some earlier
 * event (that turn's own prompt) already carried: it is never a candidate.
 * `after` excludes candidates already consumed (the first one is the ack,
 * a second one is the duplicate check's business).
 */
export function hookCandidates(
	events: PersistedEvent[],
	q: { cid: string; t0: string; hash: string },
): BgCandidate[] {
	const seen = new Set<string>();
	const out: BgCandidate[] = [];
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	for (const ev of sorted) {
		const pid = ev.prompt_id;
		if (
			ev.ts >= q.t0 &&
			pid !== null &&
			typeof pid === "string" &&
			!seen.has(pid) &&
			isHumanSameHash(ev, q.hash)
		) {
			out.push({ cid: q.cid, promptId: pid, seq: ev.seq, ts: ev.ts });
		}
		if (typeof pid === "string") seen.add(pid);
	}
	return out;
}

/** The transcript path the conversation's newest SessionStart reported, if any. */
export function transcriptPathOf(events: PersistedEvent[]): string | null {
	let best: PersistedEvent | null = null;
	for (const ev of events) {
		if (ev.ev !== "session_start" || typeof ev.data.transcript_path !== "string") continue;
		if (!best || ev.seq > best.seq) best = ev;
	}
	return best ? (best.data.transcript_path as string) : null;
}

/** A person's prompt (the shape `isHumanSameHash` checks, any text). */
function isHumanPrompt(ev: PersistedEvent): boolean {
	if (ev.ev !== "user_prompt") return false;
	const d = ev.data;
	if (d.source !== undefined && d.source !== "user") return false;
	if (d.origin === "unverified") return false;
	return typeof d.prompt === "string";
}

/**
 * §8.1.12.5 "duplicado por re-lanzamiento": after the ack at `ackSeq`, a
 * `session_start` with `source: resume` and then a human same-hash prompt
 * with a new prompt_id — the repetition. The caller adds the probe (another
 * pid) and decides proven vs possible from `blockers`.
 *
 * Round 3.1 (SF-1): a repetition is PROVEN only when nothing between the
 * ack and it allows a manual repeat to explain it. Each of these is a
 * blocker (⇒ at most `possible-duplicate`, with the reasons):
 * - `gap`: events were lost between the ack and the repeat — a lost
 *   turn_end is indistinguishable from "the turn never finished";
 * - `turn-finished-before-resume`: a turn_end/turn_failed of the ack's own
 *   prompt_id before the resume (RESUME_INTERRUPTED_TURN only re-runs an
 *   unfinished turn);
 * - `turn-end-before-resume`: ANY other turn end between the ack and the
 *   resume, whatever its prompt_id (or none): §8.2.1 saw Stops whose
 *   prompt_id nobody announced, for queued turns, so the ack's turn may have
 *   ended under another id;
 * - `turn-end-before-repeat`: a turn end after the resume and before the
 *   repeat (incl. one with the ack's prompt_id): a turn ran in between;
 * - `prompt-before-repeat`: another human prompt between the ack and the
 *   repeat (before or after the resume): the repeat is not the first prompt
 *   the relaunched job took.
 */
export function duplicateAfter(
	events: PersistedEvent[],
	q: { hash: string; ackSeq: number; ackPromptId: string },
): {
	seq: number;
	promptId: string;
	/** ts of the `session_start resume` the repetition follows (evidence time, not "now"). */
	resumeTs: string;
	/** Empty ⇒ the sequence is compatible with a relaunch re-run only. */
	blockers: string[];
} | null {
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	let resumeTs: string | null = null;
	const blockers = new Set<string>();
	const seen = new Set<string>([q.ackPromptId]);
	for (const ev of sorted) {
		if (ev.seq <= q.ackSeq) {
			if (typeof ev.prompt_id === "string") seen.add(ev.prompt_id);
			continue;
		}
		if (ev.ev === "gap") blockers.add("gap");
		if (ev.ev === "turn_end" || ev.ev === "turn_failed") {
			if (resumeTs === null)
				blockers.add(
					ev.prompt_id === q.ackPromptId ? "turn-finished-before-resume" : "turn-end-before-resume",
				);
			else blockers.add("turn-end-before-repeat");
		}
		if (ev.ev === "session_start" && ev.data.source === "resume" && resumeTs === null)
			resumeTs = ev.ts;
		const pid = ev.prompt_id;
		if (isHumanPrompt(ev)) {
			if (
				resumeTs !== null &&
				typeof pid === "string" &&
				!seen.has(pid) &&
				isHumanSameHash(ev, q.hash)
			)
				return { seq: ev.seq, promptId: pid, resumeTs, blockers: [...blockers].sort() };
			blockers.add("prompt-before-repeat");
		}
		if (typeof pid === "string") seen.add(pid);
	}
	return null;
}

/**
 * D1 (round 2): the newest background send of the same text to this
 * conversation that ended `unconfirmed` — it may still be queued or have
 * run — and that the person has not acknowledged (`composer_send{state:
 * acknowledged}`, written when they confirm they checked the Terminal and
 * send again). null when there is none. A send confirmed or resolved later
 * (delivered, misdelivered, resolved) never blocks.
 */
export function unacknowledgedUnconfirmed(events: PersistedEvent[], hash: string): string | null {
	const last = new Map<string, { state: string; hash: unknown; seq: number }>();
	const acked = new Set<string>();
	for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
		if (ev.ev !== "composer_send" || ev.data.transport !== "background") continue;
		const id = ev.data.client_message_id;
		const state = ev.data.state;
		if (typeof id !== "string" || typeof state !== "string") continue;
		if (state === "acknowledged") {
			acked.add(id);
			continue;
		}
		if (["unconfirmed", "delivered", "misdelivered", "resolved", "failed"].includes(state))
			last.set(id, { state, hash: ev.data.text_hash, seq: ev.seq });
	}
	let best: { id: string; seq: number } | null = null;
	for (const [id, v] of last) {
		if (v.state !== "unconfirmed" || v.hash !== hash || acked.has(id)) continue;
		if (!best || v.seq > best.seq) best = { id, seq: v.seq };
	}
	return best?.id ?? null;
}

/** The container's default CLI config dir: the only one the MVP supports (D3). */
export const DEFAULT_BG_CONFIG_DIR = "/home/developer/.claude";

export interface BgBootConfig {
	enabled: boolean;
	versions: Set<string>;
	sessions: Set<string>;
	/** Lines for the boot log; none at all with the flag unset and valid variables. */
	warnings: string[];
}

const ST_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The background transport's configuration at boot (round 2).
 *
 * Flag off (unset/empty/anything but true|1): NOTHING else is read strictly
 * and nothing is logged — a malformed `COMPOSER_BG_CLI_VERSIONS` or
 * `COMPOSER_BG_SESSIONS` only warns, so an experimental variable left in
 * an `.env` can never stop a backend that does not use it.
 *
 * Flag on: both lists are validated and a malformed one throws (the
 * backend refuses to start: configured but unusable must not become
 * something else). `COMPOSER_BG_SESSIONS` is the per-session allowlist the
 * canary needs; empty ⇒ no session at all (fail closed, warned).
 */
export function bgConfigFromEnv(
	env: Record<string, string | undefined>,
	composerEnabled: boolean,
): BgBootConfig {
	const out: BgBootConfig = {
		enabled: false,
		versions: new Set(),
		sessions: new Set(),
		warnings: [],
	};
	const parseSessions = (raw: string | undefined) => {
		const ids = (raw ?? "")
			.split(",")
			.map((v) => v.trim().toLowerCase())
			.filter((v) => v.length > 0);
		const bad = ids.filter((v) => !ST_SESSION_RE.test(v));
		if (bad.length > 0)
			throw new Error(`COMPOSER_BG_SESSIONS: not a session id: ${bad.join(", ")}`);
		return new Set(ids);
	};
	if (!bgFlagEnabled(env.CONVERSATION_COMPOSER_BG_ENABLED)) {
		for (const [name, parse] of [
			["COMPOSER_BG_CLI_VERSIONS", () => parseBgVersions(env.COMPOSER_BG_CLI_VERSIONS)],
			["COMPOSER_BG_SESSIONS", () => parseSessions(env.COMPOSER_BG_SESSIONS)],
		] as const) {
			try {
				parse();
			} catch (err) {
				out.warnings.push(
					`${name} is malformed but ignored: the background transport is off (${(err as Error).message})`,
				);
			}
		}
		return out;
	}
	out.versions = parseBgVersions(env.COMPOSER_BG_CLI_VERSIONS);
	out.sessions = parseSessions(env.COMPOSER_BG_SESSIONS);
	if (!composerEnabled) {
		out.warnings.push(
			"CONVERSATION_COMPOSER_BG_ENABLED is set but the composer is disabled: the background transport stays off",
		);
		return out;
	}
	out.enabled = true;
	out.warnings.push(
		`composer background transport ENABLED (EXPERIMENTAL, §8.1.12; CLI versions: ${[...out.versions].join(", ") || "none — every send is cli-unvalidated"}; sessions: ${[...out.sessions].join(", ") || "none — COMPOSER_BG_SESSIONS is empty, no session uses it"})`,
	);
	return out;
}
