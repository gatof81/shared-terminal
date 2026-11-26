/**
 * projectDirectory.ts — the client's copy of the caller's project list
 * (P3a), shared by the project pages (projectsView.ts) and the sidebar's
 * Proyectos (sessionCore.ts). A leaf: no app
 * imports, so neither of those modules has to import the other for it.
 *
 * Owner-only data: `clear()` runs on logout, and every answer is applied
 * only for the auth generation it was requested under (projectsView.ts).
 */

import type { ProjectSummary } from "./api.js";

// Keyed by projectId in a Map (ids are server strings: never `obj[id]`).
let byId = new Map<string, ProjectSummary>();
let order: ProjectSummary[] = [];
let loaded = false;

/**
 * Replace the list. True when a project NAME the session rows show changed
 * (or the first list arrived): the caller re-renders those rows then,
 * instead of leaving "@handle" without its project until the next poll.
 */
export function setProjects(list: ProjectSummary[]): boolean {
	const next = new Map(list.map((p) => [p.projectId, p]));
	let changed = !loaded || next.size !== byId.size;
	if (!changed) {
		for (const [id, p] of next) {
			if (byId.get(id)?.name !== p.name) {
				changed = true;
				break;
			}
		}
	}
	order = list.slice();
	byId = next;
	loaded = true;
	return changed;
}

export function projects(): readonly ProjectSummary[] {
	return order;
}

export function projectsLoaded(): boolean {
	return loaded;
}

export function projectName(projectId: string): string | null {
	return byId.get(projectId)?.name ?? null;
}

// The project whose page is on screen (projectsView.ts sets it): the
// sidebar tree marks that project's row as the current page.
let currentId: string | null = null;

export function setCurrentProject(projectId: string | null): void {
	currentId = projectId;
}

export function currentProject(): string | null {
	return currentId;
}

// What the sidebar's Proyectos says beside the list (projectsView.ts sets it):
// whether "+" may create one, and whether the last read failed.
let canCreate = true;
let loadFailed = false;

/** True when either changed (the sidebar re-renders then). */
export function setProjectsStatus(s: { canCreate?: boolean; loadFailed?: boolean }): boolean {
	const before = `${canCreate}${loadFailed}`;
	if (s.canCreate !== undefined) canCreate = s.canCreate;
	if (s.loadFailed !== undefined) loadFailed = s.loadFailed;
	return before !== `${canCreate}${loadFailed}`;
}

export function canCreateProject(): boolean {
	return canCreate;
}

export function projectsLoadFailed(): boolean {
	return loadFailed;
}

/**
 * What the list says of project `projectId`: in it (`active` — kept on a
 * failed re-read after a good one), absent from a list that was read
 * (`gone`: archived or never there — the list cannot tell which), or not
 * known yet (`loading`, `error` when the read failed). Only `active` lets a
 * page write into the project (#695).
 */
export type ProjectState = "active" | "gone" | "loading" | "error";
export function projectState(projectId: string): ProjectState {
	if (byId.has(projectId)) return "active";
	if (loaded) return "gone";
	return loadFailed ? "error" : "loading";
}

export function clearProjects(): void {
	byId = new Map();
	order = [];
	loaded = false;
	currentId = null;
	canCreate = true;
	loadFailed = false;
}
