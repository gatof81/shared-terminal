/**
 * draftStore.ts — the Chat composer's unsent text, kept on this browser so a
 * reload, a closed tab or a trip to another project never loses it.
 *
 * Storage only (no DOM, no requests). The composer's own state stays the
 * truth while the page lives; this is the copy it starts from. Nothing here
 * sends anything: a restored draft waits in the textarea like any other.
 *
 * Bounded so it can't grow without limit on a shared browser: one entry per
 * conversation, at most MAX_ENTRIES (oldest dropped), MAX_CHARS each (a
 * longer draft stays in memory only), entries older than TTL_MS ignored and
 * removed. Logout drops every entry — a draft is the person's words and the
 * next account on this browser must not see it.
 *
 * Every access is wrapped: a private window or blocked storage just means
 * drafts live as long as the page, as before.
 */

const PREFIX = "st.draft.";
export const MAX_ENTRIES = 50;
export const MAX_CHARS = 64 * 1024;
export const TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface Entry {
	t: string;
	at: number;
}

function keyOf(sessionId: string, cid: string): string {
	return `${PREFIX}${sessionId}.${cid}`;
}

function parse(raw: string | null): Entry | null {
	if (raw === null) return null;
	try {
		const v = JSON.parse(raw) as Partial<Entry>;
		return typeof v?.t === "string" && typeof v.at === "number" ? { t: v.t, at: v.at } : null;
	} catch {
		return null;
	}
}

function ownKeys(): string[] {
	const keys: string[] = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k?.startsWith(PREFIX)) keys.push(k);
	}
	return keys;
}

/** The stored draft for this conversation, or "" (none, unreadable, expired). */
export function readDraft(sessionId: string, cid: string, now = Date.now()): string {
	try {
		const k = keyOf(sessionId, cid);
		const e = parse(localStorage.getItem(k));
		if (e === null) return "";
		if (now - e.at > TTL_MS) {
			localStorage.removeItem(k);
			return "";
		}
		return e.t;
	} catch {
		return "";
	}
}

/**
 * Store (or, for an empty text, remove) this conversation's draft. A text
 * over MAX_CHARS removes the stored copy rather than keeping a stale one.
 */
export function writeDraft(sessionId: string, cid: string, text: string, now = Date.now()): void {
	try {
		const k = keyOf(sessionId, cid);
		if (text === "" || text.length > MAX_CHARS) {
			localStorage.removeItem(k);
			return;
		}
		const isNew = localStorage.getItem(k) === null;
		localStorage.setItem(k, JSON.stringify({ t: text, at: now }));
		if (isNew) prune(now, k);
	} catch {
		// Quota or blocked storage: the draft still lives in memory.
	}
}

/** Drop expired entries, then the oldest ones past MAX_ENTRIES (never `keep`). */
function prune(now: number, keep: string): void {
	const live: { k: string; at: number }[] = [];
	for (const k of ownKeys()) {
		const e = parse(localStorage.getItem(k));
		if (e === null || now - e.at > TTL_MS) localStorage.removeItem(k);
		else live.push({ k, at: e.at });
	}
	if (live.length <= MAX_ENTRIES) return;
	live.sort((a, b) => a.at - b.at);
	for (const x of live.slice(0, live.length - MAX_ENTRIES)) {
		if (x.k !== keep) localStorage.removeItem(x.k);
	}
}

/** Logout: no draft survives for the next person on this browser. */
export function forgetAllDrafts(): void {
	try {
		for (const k of ownKeys()) localStorage.removeItem(k);
	} catch {
		// Storage unavailable: nothing was stored either.
	}
}
