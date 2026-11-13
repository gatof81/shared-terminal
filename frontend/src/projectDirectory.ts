/**
 * projectDirectory.ts — the client's copy of the caller's project list
 * (P3a), shared by the sidebar sections (projectsView.ts) and the session
 * rows (sessionCore.ts), which only need a project's NAME. A leaf: no app
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
// sidebar tree marks that project's heading as the current page.
let currentId: string | null = null;

export function setCurrentProject(projectId: string | null): void {
	currentId = projectId;
}

export function currentProject(): string | null {
	return currentId;
}

export function clearProjects(): void {
	byId = new Map();
	order = [];
	loaded = false;
	currentId = null;
}
