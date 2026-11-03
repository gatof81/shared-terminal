/**
 * chatMeta.ts — the owner's metadata in the Chat list (CONVERSATION.md §6.2,
 * v1.8): which title is shown, the Active / Archived / All filters, the
 * remembered filter, and the words for a refused change. Pure (no DOM),
 * unit-tested; chatView.ts only wires it.
 */

import type { ConversationSummary } from "./api.js";
import { normalizeTitle, TITLE_MAX_CODE_POINTS } from "./conversationTitle.js";

export type ChatFilter = "active" | "archived" | "all";
export const CHAT_FILTERS: ReadonlyArray<{ id: ChatFilter; label: string }> = [
	{ id: "active", label: "Active" },
	{ id: "archived", label: "Archived" },
	{ id: "all", label: "All" },
];

/** The CLI's (automatic) title, or null. */
export function automaticTitle(c: ConversationSummary): string | null {
	return c.title?.trim() || null;
}

/** §6.2: the owner's name prevails over the automatic title, always. */
export function displayTitle(c: ConversationSummary): string {
	return (
		c.customTitle?.trim() ||
		automaticTitle(c) ||
		(c.kind === "headless" ? "Headless run" : "Untitled conversation")
	);
}

export function isArchived(c: ConversationSummary): boolean {
	return typeof c.archivedAt === "string" && c.archivedAt.length > 0;
}

/**
 * Active = not archived, PLUS archived ones with a live claim (§6.2: an
 * archived conversation that is active again must be easy to find — there
 * is no automatic unarchive, so it surfaces here, marked).
 */
export function inFilter(c: ConversationSummary, filter: ChatFilter, live: boolean): boolean {
	if (filter === "all") return true;
	if (filter === "archived") return isArchived(c);
	return !isArchived(c) || live;
}

export function filterCounts(
	items: ConversationSummary[],
	live: (c: ConversationSummary) => boolean,
): Record<ChatFilter, number> & { archivedLive: number } {
	let archived = 0;
	let archivedLive = 0;
	let active = 0;
	for (const c of items) {
		const l = live(c);
		if (isArchived(c)) {
			archived++;
			if (l) archivedLive++;
		}
		if (inFilter(c, "active", l)) active++;
	}
	return { active, archived, all: items.length, archivedLive };
}

// ── The remembered filter (per browser; a viewer convenience, never state) ──

const FILTER_KEY = "st.chat.filter";

export function readFilter(): ChatFilter {
	try {
		const v = localStorage.getItem(FILTER_KEY);
		if (v === "active" || v === "archived" || v === "all") return v;
	} catch {
		/* storage blocked: default */
	}
	return "active";
}

export function writeFilter(f: ChatFilter): void {
	try {
		localStorage.setItem(FILTER_KEY, f);
	} catch {
		/* storage blocked: the choice lasts for this page only */
	}
}

// ── Answers newer than a list response ─────────────────────────────────────

/**
 * A PATCH answer is the truth for its conversation; a list request that left
 * BEFORE that answer arrived can still land after it and would put the old
 * name/archive state back for a poll interval. Each answer is stamped with
 * the list-request counter at the moment it arrived; a list response from a
 * request numbered ≤ that stamp gets the answer laid over it, and one from a
 * later request (which the server answered after the write) retires it.
 */
export class MetaOverlay {
	private readonly entries = new Map<
		string,
		{ customTitle: string | null; archivedAt: string | null; stamp: number }
	>();

	record(summary: ConversationSummary, stamp: number): void {
		this.entries.set(summary.sessionId, {
			customTitle: summary.customTitle ?? null,
			archivedAt: summary.archivedAt ?? null,
			stamp,
		});
	}

	/** Lay the newer answers over a list response from request `req`. */
	apply(conversations: ConversationSummary[], req: number): void {
		for (const c of conversations) {
			const e = this.entries.get(c.sessionId);
			if (!e) continue;
			if (req > e.stamp) {
				this.entries.delete(c.sessionId);
				continue;
			}
			c.customTitle = e.customTitle;
			c.archivedAt = e.archivedAt;
		}
	}

	clear(): void {
		this.entries.clear();
	}
}

// ── Words ───────────────────────────────────────────────────────────────────

/** Local check before the request leaves (the server decides; same rules). */
export function titleProblem(value: string): string | null {
	const r = normalizeTitle(value);
	if (r.ok) return null;
	return r.code === "title-too-long"
		? `Too long: at most ${TITLE_MAX_CODE_POINTS} characters.`
		: "The name contains control or text-direction characters. Use plain text.";
}

/** A refused rename/archive, in words (`status` 0 = the request never got an answer). */
export function explainMetaError(status: number, code: string): string {
	switch (code) {
		case "title-too-long":
			return `Too long: at most ${TITLE_MAX_CODE_POINTS} characters.`;
		case "invalid-title":
			return "The name contains control or text-direction characters. Use plain text.";
		case "conversation-not-found":
			return "This conversation is no longer available. Refresh the list.";
		case "meta-unavailable":
			return "The change could not be saved right now (storage unavailable). Nothing changed — try again.";
		case "network":
			return "No answer from the server. Nothing was confirmed — check your connection and try again.";
	}
	if (status === 429) return "Too many changes in a short time. Wait a moment and try again.";
	if (status === 404) return "This conversation is no longer available. Refresh the list.";
	return `The change was refused (HTTP ${status}). Nothing changed.`;
}
