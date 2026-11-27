// recentsView.ts — the surfaces of recentTopics.ts (revisión 2 §7): «Seguir
// en «Tema» · Proyecto ›» on top of a phone's home (above Proyectos) and as
// a wide screen's empty area, and the selector's «Recientes». Shown only
// once the projects list is read: before that an archived project's entry
// could flash (revisión 2 §4: no wrong data while loading).

import { watchAcpEvents } from "./acpLive.js";
import { projectName, projectsLoaded } from "./projectDirectory.js";
import {
	forgetRecent,
	forgetTopic,
	onRecents,
	type Recent,
	recentPlace,
	recents,
	renameTopic,
	samePlace,
} from "./recentTopics.js";
import { navigateProject, parseProjectRoute, readProjectRoute } from "./router.js";
import { el } from "./ui.js";

/** The entries a surface may offer, newest first: a known project, not the place on screen. */
export function offered(): Recent[] {
	if (!projectsLoaded()) return [];
	const here = readProjectRoute();
	return recents().filter((e) => {
		const r = parseProjectRoute(e.hash);
		return r && projectName(r.projectId) !== null && !samePlace(e, here);
	});
}

/** «Tema · Proyecto» (the selector's rows), or the place alone. */
export function recentLabel(e: Recent): string {
	const r = parseProjectRoute(e.hash);
	const project = r ? projectName(r.projectId) : null;
	return project ? `${recentPlace(e)} · ${project}` : recentPlace(e);
}

/** Open an entry: a new history entry (Back returns). A gone project's is dropped instead. */
export function openRecent(e: Recent): void {
	const r = parseProjectRoute(e.hash);
	if (!r || projectName(r.projectId) === null) {
		forgetRecent(e.hash);
		return;
	}
	navigateProject(r);
}

const resumeRow = el("button", "resume-row");
resumeRow.type = "button";
resumeRow.id = "resume-row";
resumeRow.hidden = true;
let resumeTarget: Recent | null = null;
resumeRow.addEventListener("click", () => {
	if (resumeTarget) openRecent(resumeTarget);
});

let emptyText: string | null = null;

function resumeContent(e: Recent): Node[] {
	const r = parseProjectRoute(e.hash);
	const project = r ? projectName(r.projectId) : null;
	return [
		el("span", "resume-text", `Seguir en ${recentPlace(e)}`),
		...(project ? [el("span", "resume-project", ` · ${project}`)] : []),
		el("span", "resume-go", "›"),
	];
}

/** Paint the phone's row and the wide empty area from what is remembered now. */
export function renderRecents(): void {
	const first = offered()[0] ?? null;
	resumeTarget = first;
	resumeRow.hidden = first === null;
	if (first) resumeRow.replaceChildren(...resumeContent(first));
	const empty = document.getElementById("empty-state");
	if (!empty) return;
	emptyText ??= empty.textContent;
	if (!first) {
		if (empty.querySelector(".resume-card")) empty.textContent = emptyText;
		return;
	}
	const card = el("button", "resume-card");
	card.type = "button";
	card.append(...resumeContent(first));
	card.addEventListener("click", () => openRecent(first));
	empty.replaceChildren(card);
}

// A topic archived or renamed elsewhere (a live `conversation` frame, which
// the socket already carries): out of the list, or named anew. Watched
// without holding the socket.
watchAcpEvents((ev) => {
	if (ev.type !== "conversation") return;
	const c = ev.conversation;
	if (c.archivedAt) forgetTopic(c.projectId, c.id);
	else renameTopic(c.projectId, c.id, c.title);
});

let mounted = false;
/** Puts the phone's row above the sidebar's tree (once) and follows the remembered list. */
export function mountRecents(): void {
	if (!mounted) {
		mounted = true;
		document.getElementById("session-list")?.before(resumeRow);
		onRecents(renderRecents);
	}
	renderRecents();
}
