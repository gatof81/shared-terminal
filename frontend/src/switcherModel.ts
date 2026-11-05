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

import type { ConversationSummary } from "./api.js";
import { displayTitle, isArchived } from "./chatMeta.js";
import { lastEvidenceAt, presentStatus, type StatusPresentation } from "./conversationModel.js";

// ── Ranking ─────────────────────────────────────────────────────────────────

/** Section order, top to bottom. */
export type Bucket = "attention" | "working" | "recent" | "quiet";

export const BUCKET_LABEL: Record<Bucket, string> = {
	attention: "Needs you",
	working: "Working",
	recent: "Recent",
	quiet: "Unknown or no recent activity",
};

const BUCKET_ORDER: Bucket[] = ["attention", "working", "recent", "quiet"];

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
 * The bucket follows the presentation:
 * - attention: a FRESH live claim that waits on the person (permission, input);
 * - working: a fresh live claim of activity (running, background tasks);
 * - quiet: `unknown`, or a live claim gone stale (nothing proves Claude is there);
 * - recent: everything else (ended, error, disconnected…), by last evidence.
 */
export function bucketOf(
	c: ConversationSummary,
	now: number,
): {
	bucket: Bucket;
	status: StatusPresentation;
} {
	const status = presentStatus(c.status, lastEvidenceAt(c), now);
	if (status.active) {
		if (c.status === "waiting_permission" || c.status === "waiting_input")
			return { bucket: "attention", status };
		return { bucket: "working", status };
	}
	if (status.stale || c.status === "unknown") return { bucket: "quiet", status };
	return { bucket: "recent", status };
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
		evidenceAt: Date.parse(lastEvidenceAt(c)),
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

/** Every whitespace-separated term must appear in the title or the project name. */
export function matches(item: SwitcherItem, query: string): boolean {
	const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const hay = `${item.title}\n${item.projectName}`.toLocaleLowerCase();
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
 * Loads project lists for one switcher: at most `concurrency` requests in
 * flight across EVERY `load` call (the first load and each Retry share the
 * slots, so retrying a burst of 429s cannot exceed the bound). A request's
 * `timeoutMs` starts when it gets its slot, not while it waits for one (the
 * abort only stops waiting for a read-only GET). `onUpdate` sees each project
 * settle in exactly one state; after `isCancelled` nothing new starts and
 * nothing more is reported.
 */
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
	): Promise<{ value?: T; error?: unknown; timedOut: boolean }> {
		await this.acquire();
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
