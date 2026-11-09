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

export function setProjects(list: ProjectSummary[]): void {
	order = list.slice();
	byId = new Map(list.map((p) => [p.projectId, p]));
	loaded = true;
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

export function clearProjects(): void {
	byId = new Map();
	order = [];
	loaded = false;
}
