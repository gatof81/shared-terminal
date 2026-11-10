/**
 * switcherModel.ts — the cross-project conversation switcher's model (pure,
 * unit-tested; the DOM is switcher.ts).
 *
 * States come from conversationModel's presentation, never from age alone or
 * from whether the composer could send: a live claim whose evidence is older
 * than STALE_EVIDENCE_MS is "No recent activity", never "needs you".
 *
 * Loading is per project, on open only (no polling), through the light list
 * form (`?capture=0`, CONVERSATION.md §6 — the form a polling client must
 * use), a few projects at a time; every project ends in exactly one state,
 * and a failed project is shown as failed — never as an empty list.
 */

import type { ConversationSummary, SessionBinding } from "./api.js";
import { attentionKind } from "./attentionRule.js";
import { displayTitle, isArchived } from "./chatMeta.js";
import {
	lastEvidenceAt,
	presentClaim,
	presentStatus,
	type StatusPresentation,
} from "./conversationModel.js";

// ── Ranking ─────────────────────────────────────────────────────────────────

/** Section order, top to bottom. */
export type Bucket = "attention" | "working" | "ready" | "recent" | "quiet";

export const BUCKET_LABEL: Record<Bucket, string> = {
	attention: "Needs you",
	working: "Working",
	ready: "Ready",
	recent: "Recent",
	quiet: "Unknown or no recent activity",
};

const BUCKET_ORDER: Bucket[] = ["attention", "working", "ready", "recent", "quiet"];

export interface SwitcherItem {
	sessionId: string;
	projectName: string;
	cid: string;
	title: string;
	status: StatusPresentation;
	bucket: Bucket;
	/** Last sign of life (ms since epoch; NaN if unknown). */
	evidenceAt: number;
	archived: boolean;
}

/**
 * The bucket is attentionRule.ts's verdict (owner option A, 2026-11-06) — the
 * same rule the per-project attention signal uses:
 * - attention ("Needs you"): a FRESH permission prompt from the CLI's hook;
 * - working: a fresh claim of activity (running, background tasks);
 * - ready: Claude fresh at its prompt — secondary, after the work in progress;
 * - quiet: `unknown`, a live claim gone stale (nothing proves Claude is there),
 *   or a permission prompt only a probe saw (shown as "State unknown");
 * - recent: everything else (ended, error, disconnected…), by last evidence.
 */
export function bucketOf(
	c: ConversationSummary,
	now: number,
): {
	bucket: Bucket;
	status: StatusPresentation;
} {
	const status = presentClaim(
		{ status: c.status, at: lastEvidenceAt(c), evidence: c.statusEvidence },
		now,
	);
	switch (attentionKind(c, now)) {
		case "attention":
			return { bucket: "attention", status };
		case "working":
			return { bucket: "working", status };
		case "ready":
			return { bucket: "ready", status };
		case "stale":
		case "unknown":
			return { bucket: "quiet", status };
		default:
			return { bucket: "recent", status };
	}
}

/**
 * ms since epoch, NaN when unknown. The epoch itself is the backend's "no
 * time" (a state without one, a last activity it could not recover —
 * CONVERSATION.md §4.1), so it is unknown too, never a 1970 date.
 */
function knownTime(iso: string): number {
	const t = Date.parse(iso);
	return t > 0 ? t : Number.NaN;
}

/** `c.sessionId` is the CONVERSATION id (the API's name for it); the project is passed in. */
export function toItem(
	c: ConversationSummary,
	project: { sessionId: string; name: string },
	now: number,
): SwitcherItem {
	const { bucket, status } = bucketOf(c, now);
	return {
		sessionId: project.sessionId,
		projectName: project.name,
		cid: c.sessionId,
		title: displayTitle(c),
		status,
		bucket,
		evidenceAt: knownTime(lastEvidenceAt(c)),
		archived: isArchived(c),
	};
}

/**
 * Which conversations a project contributes: the Chat list's "Active" set —
 * not archived, plus an archived one that is live again (it is presented as
 * active, so it may need the person).
 */
export function visibleInSwitcher(c: ConversationSummary, now: number): boolean {
	if (!isArchived(c)) return true;
	return presentStatus(c.status, lastEvidenceAt(c), now).active;
}

/** Sections in order, each sorted by last evidence (newest first); empty ones dropped. */
export function sectionize(
	items: SwitcherItem[],
): Array<{ bucket: Bucket; items: SwitcherItem[] }> {
	const out: Array<{ bucket: Bucket; items: SwitcherItem[] }> = [];
	for (const bucket of BUCKET_ORDER) {
		const inB = items
			.filter((i) => i.bucket === bucket)
			.sort(
				(a, b) =>
					(Number.isNaN(b.evidenceAt) ? -1 : b.evidenceAt) -
					(Number.isNaN(a.evidenceAt) ? -1 : a.evidenceAt),
			);
		if (inB.length > 0) out.push({ bucket, items: inB });
	}
	return out;
}

/**
 * Every whitespace-separated term must appear in the title, the project name
 * or one of `extra` (e.g. its agents' names) — one rule for all of them.
 */
export function matches(item: SwitcherItem, query: string, extra: readonly string[] = []): boolean {
	const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const hay = [item.title, item.projectName, ...extra].join("\n").toLocaleLowerCase();
	return terms.every((t) => hay.includes(t));
}

// ── Loading ─────────────────────────────────────────────────────────────────

export type ProjectState =
	| { kind: "loading" }
	| {
			kind: "ok";
			conversations: ConversationSummary[];
			/** §6.2: names/archive could not be read — titles shown are the automatic ones. */
			metaUnavailable: boolean;
	  }
	| { kind: "error"; reason: "rate-limited" | "timeout" | "failed"; detail: string };

export interface Project {
	sessionId: string;
	name: string;
	state: ProjectState;
}

/** One project's list request, as the switcher needs it: a status, never a refusal thrown. */
export type FetchList = (
	sessionId: string,
	signal: AbortSignal,
) => Promise<
	| { ok: true; conversations: ConversationSummary[]; meta?: "ok" | "unavailable" }
	| { ok: false; status: number; error: string }
>;

export const SWITCHER_CONCURRENCY = 3;
export const SWITCHER_TIMEOUT_MS = 8000;

/** Human words for a failed project (no retry happens on its own). */
export function explainProjectError(s: Extract<ProjectState, { kind: "error" }>): string {
	if (s.reason === "rate-limited") return "Too many requests — try again in a moment";
	if (s.reason === "timeout") return "No answer in time";
	return s.detail || "Could not load";
}

/**
 * A counting semaphore: at most `size` holders. Shared by everything one
 * switcher loads (project lists, agent lists), so the whole switcher stays
 * within one bound.
 */
export class Slots {
	private active = 0;
	private readonly waiting: Array<() => void> = [];
	constructor(private readonly size: number) {}
	async acquire(): Promise<void> {
		if (this.active >= this.size) await new Promise<void>((r) => this.waiting.push(r));
		this.active++;
	}
	release(): void {
		this.active--;
		this.waiting.shift()?.();
	}
	/** Run `fn` holding a slot, bounded by `timeoutMs` (the abort only stops waiting). */
	async run<T>(
		fn: (signal: AbortSignal) => Promise<T>,
		timeoutMs: number,
		isCancelled?: () => boolean,
	): Promise<{ value?: T; error?: unknown; timedOut: boolean; cancelled?: boolean }> {
		await this.acquire();
		// Closed while waiting for a slot: start nothing (the slot goes on).
		if (isCancelled?.()) {
			this.release();
			return { timedOut: false, cancelled: true };
		}
		const ctrl = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			ctrl.abort();
		}, timeoutMs);
		try {
			return { value: await fn(ctrl.signal), timedOut: false };
		} catch (error) {
			return { error, timedOut };
		} finally {
			clearTimeout(timer);
			this.release();
		}
	}
}

/**
 * Loads project lists for one switcher: at most `concurrency` requests in
 * flight across EVERY `load` call (the first load and each Retry share the
 * slots, so retrying a burst of 429s cannot exceed the bound). A request's
 * `timeoutMs` starts when it gets its slot, not while it waits for one (the
 * abort only stops waiting for a read-only GET). `onUpdate` sees each project
 * settle in exactly one state; after `isCancelled` nothing new starts and
 * nothing more is reported.
 */
export class ProjectLoader {
	private readonly slots: Slots;
	private readonly timeoutMs: number;

	constructor(
		private readonly fetchList: FetchList,
		private readonly onUpdate: (p: Project) => void,
		private readonly opts: {
			concurrency?: number;
			timeoutMs?: number;
			isCancelled?: () => boolean;
			/** Share the bound with other loads of the same switcher (agents). */
			slots?: Slots;
		} = {},
	) {
		this.slots = opts.slots ?? new Slots(Math.max(1, opts.concurrency ?? SWITCHER_CONCURRENCY));
		this.timeoutMs = opts.timeoutMs ?? SWITCHER_TIMEOUT_MS;
	}

	load(projects: Array<{ sessionId: string; name: string }>): Promise<void> {
		return Promise.all(projects.map((p) => this.one(p))).then(() => undefined);
	}

	private async acquire(): Promise<void> {
		await this.slots.acquire();
	}

	private release(): void {
		this.slots.release();
	}

	private async one(p: { sessionId: string; name: string }): Promise<void> {
		await this.acquire();
		let state: ProjectState;
		try {
			if (this.opts.isCancelled?.()) return;
			const ctrl = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				ctrl.abort();
			}, this.timeoutMs);
			try {
				const r = await this.fetchList(p.sessionId, ctrl.signal);
				if (r.ok)
					state = {
						kind: "ok",
						conversations: r.conversations,
						metaUnavailable: r.meta === "unavailable",
					};
				else if (r.status === 429)
					state = { kind: "error", reason: "rate-limited", detail: r.error };
				else state = { kind: "error", reason: "failed", detail: r.error };
			} catch (err) {
				state = timedOut
					? { kind: "error", reason: "timeout", detail: "" }
					: { kind: "error", reason: "failed", detail: (err as Error).message };
			} finally {
				clearTimeout(timer);
			}
		} finally {
			this.release();
		}
		if (this.opts.isCancelled?.()) return;
		this.onUpdate({ sessionId: p.sessionId, name: p.name, state });
	}
}

/** One-shot form of ProjectLoader (a single load with its own slots). */
export function loadProjects(
	projects: Array<{ sessionId: string; name: string }>,
	fetchList: FetchList,
	onUpdate: (p: Project) => void,
	opts: { concurrency?: number; timeoutMs?: number; isCancelled?: () => boolean } = {},
): Promise<void> {
	return new ProjectLoader(fetchList, onUpdate, opts).load(projects);
}

// ── Parallel work at a glance ────────────────────────────────────────────

export interface ParallelSummary {
	attention: number;
	/** Names of the projects with a conversation that needs the person. */
	attentionProjects: string[];
	working: number;
	workingProjects: number;
	/** Claude at its prompt (fresh): secondary, never "needs you". */
	ready: number;
	/** Projects whose list is still loading or failed: the counts may be short. */
	incomplete: number;
}

/**
 * What runs in parallel across the loaded projects, from the same buckets the
 * list shows: only FRESH live claims count (bucketOf already sends a stale
 * claim to "quiet"), so an estimate is never presented as activity.
 */
export function parallelSummary(
	items: readonly SwitcherItem[],
	projects: readonly Project[],
): ParallelSummary {
	const att = new Set<string>();
	const work = new Set<string>();
	let attention = 0;
	let working = 0;
	let ready = 0;
	for (const i of items) {
		if (i.bucket === "attention") {
			attention++;
			att.add(i.projectName);
		} else if (i.bucket === "working") {
			working++;
			work.add(i.sessionId);
		} else if (i.bucket === "ready") {
			ready++;
		}
	}
	return {
		attention,
		attentionProjects: [...att].sort(),
		working,
		workingProjects: work.size,
		ready,
		incomplete: projects.filter((p) => p.state.kind !== "ok").length,
	};
}

// ── Words ────────────────────────────────────────────────────────────────

/**
 * What a session is called in the switcher and the Chat list. With the
 * Projects feature on (features.projectChat), "project" means ONLY a P3a
 * Project, so these surfaces — which list sessions — say "session"; with it
 * off, every string stays exactly as it was (screenshot baselines).
 */
export type SessionNoun = "project" | "session";

export function sessionNoun(projectsOn: boolean): SessionNoun {
	return projectsOn ? "session" : "project";
}

function plural(n: number, noun: SessionNoun): string {
	return `${noun}${n === 1 ? "" : "s"}`;
}

export interface SwitcherWords {
	search: string;
	noneRunning: string;
	noneLoaded: string;
	noneInLoaded: string;
	noneYet: string;
	loading: (loading: number, total: number) => string;
	/** The Chat list's mobile entry to the switcher. */
	otherConversations: string;
}

export function switcherWords(noun: SessionNoun): SwitcherWords {
	return {
		search: `Search conversations or ${noun}s`,
		noneRunning: `No running ${noun}s. Conversations are listed for ${noun}s that are running.`,
		noneLoaded: `No ${noun} could be loaded.`,
		noneInLoaded: `No conversations in the ${noun}s that loaded.`,
		noneYet: `No conversations yet in your running ${noun}s.`,
		loading: (loading, total) => `Loading ${loading} of ${total} ${plural(total, noun)}…`,
		otherConversations: `Other ${noun === "project" ? "projects'" : "sessions'"} conversations…`,
	};
}

/**
 * The agent a session is bound to, as "@handle" (PROJECTS.md §4.6): an
 * object = bound; null = unassigned and an absent key = unknown, both shown
 * as nothing.
 */
export function boundHandle(s: { binding?: SessionBinding | null }): string | null {
	const b = s.binding;
	if (b === null || b === undefined || typeof b !== "object") return null;
	return typeof b.handle === "string" && b.handle !== "" ? `@${b.handle}` : null;
}

/** A row's session line: its name, then "· @handle" when bound. */
export function sessionLabel(name: string, handle: string | null | undefined): string {
	return handle ? `${name} · ${handle}` : name;
}

/** The summary line, or null when there is nothing worth saying. */
export function parallelSummaryText(
	s: ParallelSummary,
	noun: SessionNoun = "project",
): string | null {
	const parts: string[] = [];
	if (s.attention > 0)
		parts.push(
			`${s.attention} need${s.attention === 1 ? "s" : ""} you (${s.attentionProjects.join(", ")})`,
		);
	if (s.working > 0)
		parts.push(`${s.working} working in ${s.workingProjects} ${plural(s.workingProjects, noun)}`);
	// Secondary and discreet: a count, no project names.
	if (s.ready > 0) parts.push(`${s.ready} ready`);
	if (parts.length === 0) return null;
	const tail =
		s.incomplete > 0
			? ` — ${s.incomplete} ${plural(s.incomplete, noun)} not loaded, so this may be incomplete`
			: "";
	return `Now: ${parts.join(" · ")}${tail}.`;
}
