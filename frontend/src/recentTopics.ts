// recentTopics.ts — «Seguir donde estabas» and «Recientes» (revisión 2 §7):
// the last 5 topic or Herramientas addresses the person was on, kept in this
// browser's localStorage. Nothing is asked of the backend: a project's name
// comes from the projects list already read, a topic's title from the rail
// (kept with its address, as last seen there, so the row can name it before
// that project's rail is read again). Never the text of a message.
//
// An entry whose project is gone from the list, or whose topic is missing
// from its project's live topics once the rail has read them (archived,
// deleted), is dropped without a word. Nothing opens by itself: the
// surfaces only offer the way back — a row on top of a phone's home, a card
// in a wide screen's empty area, a group in the project selector.

import { type ProjectRoute, parseProjectRoute, projectRouteHash } from "./router.js";

const KEY = "st.recent";
const MAX = 5;

export interface Recent {
	/** The address (canonical `#/projects/…`): a topic, or Herramientas. */
	hash: string;
	/** The topic's title as the rail last said it; null when not known. */
	title: string | null;
}

// ── Pure ────────────────────────────────────────────────────────────────────

/** What makes two addresses the same place: the topic, or (none) the tools' agent and workspace. */
export function recentKey(r: ProjectRoute): string | null {
	if (r.page !== "conversation" && r.page !== "tools") return null;
	if (r.conversationId) return `${r.projectId}/c/${r.conversationId}`;
	if (r.tools) return `${r.projectId}/t/${r.tools.agent}/${r.tools.work ?? "~"}`;
	return null;
}

/** `list` after a visit of `hash`: first, its earlier address dropped, at most 5. */
export function withVisit(list: readonly Recent[], hash: string, title: string | null): Recent[] {
	const r = parseProjectRoute(hash);
	const key = r && recentKey(r);
	if (!r || !key) return [...list];
	const earlier = list.find((e) => keyOf(e) === key);
	const rest = list.filter((e) => keyOf(e) !== key);
	return [{ hash: projectRouteHash(r), title: title ?? earlier?.title ?? null }, ...rest].slice(
		0,
		MAX,
	);
}

/**
 * `list` with what the loaded data says: entries of a project not in
 * `projects` (when given) dropped; for project `pid` with its live topics
 * `live` read, entries of a topic not among them dropped (except `keep`, the
 * topic on screen — a topic just created may not be listed yet) and the
 * others' titles refreshed.
 */
export function pruned(
	list: readonly Recent[],
	opts: {
		projects?: ReadonlySet<string>;
		pid?: string;
		live?: ReadonlyArray<{ id: string; title: string }>;
		keep?: string | null;
	},
): Recent[] {
	const titles = opts.live ? new Map(opts.live.map((c) => [c.id, c.title])) : null;
	const out: Recent[] = [];
	for (const e of list) {
		const r = parseProjectRoute(e.hash);
		if (!r) continue;
		if (opts.projects && !opts.projects.has(r.projectId)) continue;
		if (titles && r.projectId === opts.pid && r.conversationId) {
			const t = titles.get(r.conversationId);
			if (t === undefined) {
				if (r.conversationId !== opts.keep) continue;
			} else if (t !== e.title) {
				out.push({ ...e, title: t });
				continue;
			}
		}
		out.push(e);
	}
	return out;
}

function keyOf(e: Recent): string | null {
	const r = parseProjectRoute(e.hash);
	return r ? recentKey(r) : null;
}

/** Same place as the address on screen (none: null). */
export function samePlace(e: Recent, current: ProjectRoute | null): boolean {
	const k = current ? recentKey(current) : null;
	return k !== null && keyOf(e) === k;
}

// ── Storage ─────────────────────────────────────────────────────────────────

function read(): Recent[] {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		if (!Array.isArray(v)) return [];
		return v
			.filter(
				(e): e is Recent =>
					typeof e?.hash === "string" &&
					parseProjectRoute(e.hash) !== null &&
					(e.title === null || typeof e.title === "string"),
			)
			.slice(0, MAX);
	} catch {
		return [];
	}
}

const listeners: Array<() => void> = [];

function write(list: Recent[]): void {
	const before = JSON.stringify(read());
	const after = JSON.stringify(list);
	if (before === after) return;
	try {
		localStorage.setItem(KEY, after);
	} catch {
		/* storage off: nothing is remembered */
	}
	for (const l of listeners) l();
}

export function recents(): Recent[] {
	return read();
}

export function onRecents(fn: () => void): void {
	listeners.push(fn);
}

export function rememberVisit(hash: string, title: string | null): void {
	write(withVisit(read(), hash, title));
}

export function pruneRecents(opts: Parameters<typeof pruned>[1]): void {
	write(pruned(read(), opts));
}

export function forgetRecent(hash: string): void {
	write(read().filter((e) => e.hash !== hash));
}

const TOOL_LABEL = { terminal: "Terminal", files: "Files", git: "Git" } as const;

/** The place as a row names it: «Tema», or «Git de @dev» for Herramientas. */
export function recentPlace(e: Recent): string {
	const r = parseProjectRoute(e.hash);
	if (r?.page === "tools" && r.tools) return `${TOOL_LABEL[r.tools.tool]} de @${r.tools.agent}`;
	return e.title ? `«${e.title}»` : "un tema";
}

/** A topic's entries (its Herramientas included) leave the list. */
export function forgetTopic(pid: string, cid: string): void {
	write(
		read().filter((e) => {
			const r = parseProjectRoute(e.hash);
			return !(r?.projectId === pid && r.conversationId === cid);
		}),
	);
}

/** A topic's entries take its new title. */
export function renameTopic(pid: string, cid: string, title: string): void {
	write(
		read().map((e) => {
			const r = parseProjectRoute(e.hash);
			return r?.projectId === pid && r.conversationId === cid ? { ...e, title } : e;
		}),
	);
}
