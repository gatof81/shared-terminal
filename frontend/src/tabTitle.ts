/**
 * tabTitle.ts — the browser tab says which project (and which view) it shows,
 * so several tabs supervising several projects can be told apart.
 *
 * Project name and view only. A conversation title is content: browsers keep
 * page titles in their history, which outlives a logout on a shared machine,
 * so it never goes into the tab title.
 */

export const APP_TITLE = "Shared Terminal";

// A Map, never an object literal indexed by a string (`obj["constructor"]`).
const VIEW_LABEL: ReadonlyMap<string, string> = new Map([
	["files", "Files"],
	["git", "Git"],
	["chat", "Chat"],
]);

export interface TitleParts {
	project: string | null;
	view: string | null;
}

/** "my-project · Chat — Shared Terminal"; the terminal view needs no label. */
export function composeTabTitle(p: TitleParts): string {
	const project = p.project?.trim();
	if (!project) return APP_TITLE;
	const label = p.view ? VIEW_LABEL.get(p.view) : undefined;
	return `${project}${label ? ` · ${label}` : ""} — ${APP_TITLE}`;
}

const parts: TitleParts = { project: null, view: null };
// A project directory page (P3a) shown over the session: its title wins
// while it is up — the project's and agent's NAMES only, same rule.
let page: string | null = null;

function apply(): void {
	const p = page?.trim();
	document.title = p ? `${p} — ${APP_TITLE}` : composeTabTitle(parts);
}

export function setTitleParts(next: Partial<TitleParts>): void {
	if ("project" in next) parts.project = next.project ?? null;
	if ("view" in next) parts.view = next.view ?? null;
	apply();
}

/** A project/agent page's title (names only), or null when none is shown. */
export function setTitlePage(next: string | null): void {
	page = next;
	apply();
}

/** Logout: back to the plain app title. */
export function resetTabTitle(): void {
	parts.project = null;
	parts.view = null;
	page = null;
	document.title = APP_TITLE;
}
