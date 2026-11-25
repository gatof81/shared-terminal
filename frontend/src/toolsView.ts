/**
 * toolsView.ts — Herramientas (3B F4, PROPUESTA §5, §6, §8): an agent's
 * Files, Git or Terminal, chosen as «Agente ▾ · Workspace ▾ · Files | Git |
 * Terminal», with a strip that always says what is being looked at.
 *
 *   #/projects/<pid>[/c/<cid>]/tools/<agent>/<ws>/<tool>[/<detail>]
 *
 * It is not a viewer of its own: it is the agent's SESSION workbench — the
 * terminal, the Files and Git overlays and the view switch (viewSwitch.ts),
 * shown with the project page lifted off it. The page is not taken down: the
 * topic stays mounted under it (`visibility: hidden`, `inert`), so «‹ Tema»
 * and Back find the reader where they were, and nothing in the terminal's
 * box changes on the way:
 *   - the tools bar goes INTO the session bar (#terminal-toolbar) in the
 *     place of the session's name, as tall as the view tabs it sits beside —
 *     the bar's height is part of the terminal's box;
 *   - the strip goes inside the Files / Git overlay, never above the terminal;
 *     with Terminal it is a note in the tab row («Sesión completa»), which
 *     never changes that row's height;
 *   - on a phone the bar is the header's row (where the session bar lives),
 *     and the workspace select is the strip's first line, full width.
 * So topic ⇄ Herramientas sends no `resize` and opens no socket; only picking
 * ANOTHER agent attaches another session (a new terminal, not a resize).
 *
 * The workspace: the principal one or a work, named by its id only
 * (toolsContext.ts → `work=<id>` on every Files / Git request); a work the
 * backend no longer serves is a state of the views, never a retry by path.
 * Terminal is the session's (the container's tmux), shared by every
 * workspace: with it the workspace select reads «Sesión completa», disabled.
 */

import { openAgentSettings } from "./acpSettings.js";
import type { AcpAgentInfo, AcpWork } from "./api.js";
import { openActionMenu } from "./components/actionMenu.js";
import { gitBranch, onGitStatus, requestGitStatus } from "./gitView.js";
import { isMobile, sessions } from "./main.js";
import { projectName } from "./projectDirectory.js";
import { agentState, onRailChange, railAgents, railWorks, topicTitle } from "./projectRail.js";
import {
	currentRoute,
	depth,
	mapSessionAddress,
	navigateProject,
	type ProjectRoute,
	projectRouteHash,
	readProjectRoute,
	sameRoute,
	type ToolName,
	type ToolsTarget,
} from "./router.js";
import { applyRoute } from "./sessionCore.js";
import { isWorkGone, onWorkGone, setInTools, setWork } from "./toolsContext.js";
import { button, el, stateBox } from "./ui.js";
import { getView, onSessionSync, onViewChange } from "./viewSwitch.js";

const toolbar = document.getElementById("terminal-toolbar");
const tabTools = document.getElementById("tab-tools");
const overlays: Partial<Record<ToolName, HTMLElement | null>> = {
	files: document.getElementById("files-view"),
	git: document.getElementById("git-view"),
};

const WORKSPACE = "~/workspace";
const PRINCIPAL_VALUE = "";

// ── State ───────────────────────────────────────────────────────────────────

let pid: string | null = null;
/** The topic Herramientas was opened from (its «‹»), if any. */
let cid: string | null = null;
let target: ToolsTarget | null = null;
/** The agent's session, once the agents list named it. */
let sessionId: string | null = null;
/** The tools address last applied or written: a write coming back is not re-applied. */
let applied: string | null = null;
/**
 * The history depth of the first tools entry pushed from a topic (or the
 * project): «‹» goes back past every entry pushed since, to that page.
 */
let entryDepth: number | null = null;
let on = false;

// ── Elements ────────────────────────────────────────────────────────────────

const bar = el("div", "tools-bar");
const backBtn = el("button", "tools-back");
backBtn.type = "button";
const backLabel = el("span", "tools-back-label");
backBtn.append(el("span", "tools-back-caret", "‹"), backLabel);
backBtn.addEventListener("click", () => goBack());

const agentSel = el("select", "tools-select tools-agent");
agentSel.setAttribute("aria-label", "Agente");
agentSel.addEventListener("change", () => {
	if (!target || agentSel.value === target.agent) return;
	// Another agent: its session (a new attach), its principal workspace.
	openTools({ agent: agentSel.value, work: null, tool: target.tool });
});
const agentField = field("Agente", agentSel, "tools-field-agent");

const wsSel = el("select", "tools-select tools-ws");
wsSel.setAttribute("aria-label", "Workspace");
wsSel.addEventListener("change", () => {
	if (!target || target.tool === "terminal") return;
	const work = wsSel.value === PRINCIPAL_VALUE ? null : wsSel.value;
	if (work === target.work) return;
	openTools({ agent: target.agent, work, tool: target.tool });
});
const wsField = field("Workspace", wsSel, "tools-field-ws");
bar.append(backBtn, agentField, wsField);

const strip = el("div", "tools-strip");
strip.id = "tools-strip";
const stripText = el("div", "tools-strip-text");
stripText.setAttribute("aria-live", "polite");
strip.append(stripText);

const termNote = el("span", "tools-term-note");

// A work the backend no longer serves (404/403): one state over the whole
// Files / Git view — no tree, no preview, no ↻ — with the way to the
// principal workspace. Never a retry: the client has no other way into it.
const goneBox = stateBox(
	"info",
	"Este trabajo ya no está disponible.",
	button("Ver workspace principal", "files-btn primary is-accent", () => {
		if (target) openTools({ agent: target.agent, work: null, tool: target.tool });
	}),
);
goneBox.classList.add("tools-gone-state");

function field(label: string, control: HTMLElement, cls: string): HTMLElement {
	const f = el("label", `tools-field ${cls}`);
	f.append(el("span", "tools-field-label", label), control);
	return f;
}

// ── Opening ─────────────────────────────────────────────────────────────────

/**
 * Open Herramientas on `t` from the project page on screen (a new history
 * entry: Back returns). Anywhere else — no project page up — it does nothing.
 */
export function openTools(t: { agent: string; work: string | null; tool: ToolName }): boolean {
	const r = readProjectRoute();
	if (!r) return false;
	const from =
		r.page === "tools"
			? (r.conversationId ?? null)
			: r.page === "conversation"
				? (r.conversationId ?? null)
				: null;
	navigateProject({
		projectId: r.projectId,
		page: "tools",
		...(from ? { conversationId: from } : {}),
		tools: { agent: t.agent, work: t.work, tool: t.tool, detail: null },
	});
	if (r.page !== "tools") entryDepth = depth();
	return true;
}

/**
 * The agent's menu (its avatar in a thread, the topic's header, Equipo):
 * Files · Git · Terminal of its session, and its works.
 */
export function openAgentMenu(name: string, opener: HTMLElement): void {
	if (!readProjectRoute()) return;
	const info = railAgents().find((a) => a.name === name);
	const works = worksOf(name).filter((w) => w.state !== "cleaned");
	openActionMenu({
		title: info ? `@${name} · ${agentState(info).label}` : `@${name}`,
		opener,
		items: [
			{ id: "files", label: "Files · principal" },
			{ id: "git", label: "Git · principal" },
			{ id: "terminal", label: "Terminal de la sesión" },
			...works.map((w) => ({
				id: `w:${w.id}`,
				label: `⎇ ${w.id}`,
				hint: `trabajo · ${workWords(w)}`,
			})),
			{ id: "settings", label: "Ajustes del agente", hint: "modelo · effort · cuenta" },
		],
		onPick: (id) => {
			if (id === "settings") openAgentSettings(name, opener);
			else if (id.startsWith("w:")) openTools({ agent: name, work: id.slice(2), tool: "git" });
			else openTools({ agent: name, work: null, tool: id as ToolName });
		},
	});
}

// ── The page (projectsView.ts) ──────────────────────────────────────────────

/** Herramientas is the page on screen: `route.page === "tools"`. */
export function showTools(route: ProjectRoute): void {
	if (!route.tools) return;
	pid = route.projectId;
	cid = route.conversationId ?? null;
	target = route.tools;
	if (!on) {
		on = true;
		setInTools(true);
		document.body.classList.add("tools-on");
		mapSessionAddress(mapAddress);
	}
	apply();
}

/**
 * Another page of the project is up (a topic, the rail): Herramientas gives
 * way; the session under the page stays as it is (with its workspace), so
 * coming back sends nothing to it.
 */
export function hideTools(opts: { fromHistory: boolean }): void {
	// A new page opened by the person: the tools entries before it are no
	// longer «‹»'s way back.
	if (!opts.fromHistory) entryDepth = null;
	if (!on) return;
	on = false;
	setInTools(false);
	document.body.classList.remove("tools-on");
	mapSessionAddress(null);
	applied = null;
	strip.remove();
	termNote.remove();
	goneBox.remove();
	for (const o of Object.values(overlays)) o?.classList.remove("tools-gone");
	bar.remove();
}

/** No project page any more (a plain session, logout): its views read the principal workspace again. */
export function leaveTools(): void {
	hideTools({ fromHistory: false });
	pid = null;
	cid = null;
	target = null;
	sessionId = null;
	setWork(null, null);
}

function apply(): void {
	const t = target;
	if (!t || !on) return;
	const agent = railAgents().find((a) => a.name === t.agent) ?? null;
	sessionId = agent?.sessionId ?? null;
	// Bound to the agent's session: until that session is the one on screen,
	// the one there keeps reading its own principal workspace.
	setWork(sessionId, t.work);
	const hash = currentHash();
	// Not known yet (the agents or the sessions still loading): applied when they land.
	if (sessionId !== null && sessions.some((s) => s.sessionId === sessionId) && applied !== hash) {
		applied = hash;
		const route = { sessionId, view: t.tool, detail: t.detail };
		// Back on the session as it was left (a return from the topic): nothing
		// to apply — re-opening the same file or diff would only re-read it.
		if (!sameRoute(currentRoute(), route)) void applyRoute(route);
	}
	paint();
}

function currentHash(): string {
	if (!pid || !target) return "";
	return projectRouteHash({
		projectId: pid,
		page: "tools",
		...(cid ? { conversationId: cid } : {}),
		tools: target,
	});
}

/** A session route of the tools' session, as the tools address (router.navigate). */
function mapAddress(r: {
	sessionId: string;
	view: string | null;
	detail: string | null;
}): string | null {
	if (!on || !pid || !target || r.sessionId !== sessionId) return null;
	const tool = r.view === null ? target.tool : r.view;
	if (tool !== "terminal" && tool !== "files" && tool !== "git") return null;
	const next: ToolsTarget = { ...target, tool, detail: r.detail };
	const hash = projectRouteHash({
		projectId: pid,
		page: "tools",
		...(cid ? { conversationId: cid } : {}),
		tools: next,
	});
	target = next;
	applied = hash;
	return hash;
}

/** «‹ Tema»: back to the page Herramientas was opened from, where it was being read. */
function goBack(): void {
	if (!pid) return;
	const origin: ProjectRoute = cid
		? { projectId: pid, page: "conversation", conversationId: cid }
		: { projectId: pid };
	const d = depth();
	if (entryDepth !== null && entryDepth > 0 && d >= entryDepth) history.go(entryDepth - 1 - d);
	else navigateProject(origin, { replace: true });
}

// ── Painting ────────────────────────────────────────────────────────────────

function worksOf(agent: string): AcpWork[] {
	return railWorks().filter((w) => w.agent === agent);
}

function workWords(w: AcpWork): string {
	if (w.state === "creating") return "creándose";
	if (w.state === "cleaned") return "limpiado";
	if (w.state !== "active") return "cerrado";
	return runsIn(w.agent, w.id) ? "en curso" : "activo";
}

function runsIn(agent: string, work: string | null): boolean {
	return (
		railAgents()
			.find((a) => a.name === agent)
			?.runningIn?.some((r) => (r.work ?? null) === work) === true
	);
}

function paint(): void {
	const t = target;
	if (!on || !t || !pid) return;
	place();
	// «‹ Tema»: the topic's title, else the project's.
	const back = cid ? (topicTitle(cid) ?? "Tema") : (projectName(pid) ?? "Proyecto");
	backLabel.textContent = back;
	backBtn.title = `Volver a «${back}»`;
	backBtn.setAttribute("aria-label", `Volver a «${back}»`);

	// Agente: the project's team (and the agent asked for, whoever it is).
	const team = railAgents().filter((a) => a.projectId === pid);
	const names = team.map((a) => a.name);
	if (!names.includes(t.agent)) names.unshift(t.agent);
	syncOptions(
		agentSel,
		names.map((n) => ({ value: n, label: `@${n}` })),
		t.agent,
	);

	// Workspace: «Principal» + the agent's works not cleaned; Terminal is the session's.
	if (t.tool === "terminal") {
		syncOptions(wsSel, [{ value: PRINCIPAL_VALUE, label: "Sesión completa" }], PRINCIPAL_VALUE);
		wsSel.disabled = true;
		wsSel.title = "La terminal es de la sesión: un contenedor, compartido por todos sus workspaces";
	} else {
		const works = worksOf(t.agent).filter((w) => w.state !== "cleaned" || w.id === t.work);
		const opts = [{ value: PRINCIPAL_VALUE, label: "Principal" }];
		for (const w of works) opts.push({ value: w.id, label: `⎇ ${w.id} · ${workWords(w)}` });
		if (t.work !== null && !works.some((w) => w.id === t.work))
			opts.push({ value: t.work, label: `⎇ ${t.work}` });
		syncOptions(wsSel, opts, t.work ?? PRINCIPAL_VALUE);
		wsSel.disabled = false;
		wsSel.title = "";
	}
	wsField.classList.toggle("is-session", t.tool === "terminal");

	paintStrip(t);
	// Wide, the disabled workspace select already says «Sesión completa».
	termNote.textContent = isMobile() ? "Sesión completa" : `se abre en ${WORKSPACE}`;
	termNote.title =
		"La terminal es de la sesión (tmux en su contenedor), compartida por todos sus workspaces";
}

function paintStrip(t: ToolsTarget): void {
	const parts: HTMLElement[] = [];
	const agent = railAgents().find((a) => a.name === t.agent) ?? null;
	const known = agent !== null;
	const session = sessions.find((s) => s.sessionId === sessionId);
	if (!known) {
		parts.push(kind(railAgents().length ? `@${t.agent} no está entre tus agentes` : "Cargando…"));
	} else if (!session) {
		parts.push(kind(`La sesión de @${t.agent} no está en tu lista`));
	} else if (t.work === null) {
		const b = gitBranch();
		if (!b.known && t.tool !== "terminal") requestGitStatus();
		parts.push(
			kind("Workspace principal"),
			fact("rama", b.known ? (b.branch ?? (b.detached ? "HEAD separado" : "—")) : "…"),
			fact("dir", WORKSPACE),
			plain(`sesión ${session.name} · ${session.status === "running" ? "en marcha" : "detenida"}`),
		);
	} else {
		const w = worksOf(t.agent).find((x) => x.id === t.work) ?? null;
		parts.push(kind(`Trabajo ${t.work}`));
		parts.push(fact("rama", w?.branch ?? `work/${t.work}`));
		parts.push(fact("dir", `${WORKSPACE}/.st/ctx/${t.work}`));
		if (w?.baseSha) parts.push(fact("base", w.baseSha.slice(0, 7)));
		// A cleaned work's ports are free again (another work may hold them).
		if (!w || w.state === "cleaned") parts.push(fact("puertos", "—"));
		else if (typeof w.portBase === "number")
			parts.push(fact("puertos", `${w.portBase}–${w.portBase + 99}`));
		if (!w || w.state === "cleaned") parts.push(warn("ya no está disponible"));
		else if (w.state !== "active" && w.state !== "creating") parts.push(warn("cerrado"));
		else if (runsIn(t.agent, t.work)) parts.push(here(`● @${t.agent} trabajando aquí`));
		if (w?.conversationId && pid) {
			const title = topicTitle(w.conversationId);
			const a = el("a", "tools-strip-topic", `tema «${title ?? "…"}»`);
			a.href = projectRouteHash({
				projectId: pid,
				page: "conversation",
				conversationId: w.conversationId,
			});
			parts.push(a);
		}
	}
	stripText.replaceChildren(...parts);
}

function kind(text: string): HTMLElement {
	return el("span", "tools-strip-kind", text);
}

function fact(label: string, value: string): HTMLElement {
	const s = el("span", "tools-strip-fact");
	s.append(`${label} `, el("b", "tools-mono", value));
	return s;
}

function plain(text: string): HTMLElement {
	return el("span", "tools-strip-fact", text);
}

function warn(text: string): HTMLElement {
	return el("span", "tools-strip-fact tools-strip-warn", text);
}

function here(text: string): HTMLElement {
	return el("span", "tools-strip-fact tools-strip-here", text);
}

function syncOptions(
	sel: HTMLSelectElement,
	opts: Array<{ value: string; label: string }>,
	value: string,
): void {
	const same =
		sel.options.length === opts.length &&
		opts.every((o, i) => sel.options[i]?.value === o.value && sel.options[i]?.text === o.label);
	if (!same) {
		sel.replaceChildren(
			...opts.map((o) => {
				const opt = el("option", undefined, o.label);
				opt.value = o.value;
				return opt;
			}),
		);
	}
	if (sel.value !== value) sel.value = value;
}

/**
 * Where each part goes: the bar first in the session bar; the workspace
 * select in the bar (wide) or as the strip's first line (phone); the strip
 * inside the overlay on screen, or — with Terminal — the note in the tab row.
 */
function place(): void {
	if (!toolbar) return;
	if (toolbar.firstChild !== bar) toolbar.prepend(bar);
	if (isMobile()) {
		if (wsField.parentElement !== strip) strip.prepend(wsField);
	} else if (wsField.parentElement !== bar) bar.append(wsField);
	const view = getView();
	const overlay = view === "files" || view === "git" ? overlays[view] : null;
	if (overlay) {
		if (overlay.firstChild !== strip) overlay.prepend(strip);
	} else strip.remove();
	const gone = overlay !== null && overlay !== undefined && isWorkGone(sessionId);
	for (const o of Object.values(overlays)) o?.classList.toggle("tools-gone", gone && o === overlay);
	if (gone && overlay) {
		if (goneBox.parentElement !== overlay) overlay.append(goneBox);
	} else goneBox.remove();
	if (view === "terminal" && tabTools) {
		if (tabTools.firstChild !== termNote) tabTools.prepend(termNote);
	} else termNote.remove();
}

// ── Following ───────────────────────────────────────────────────────────────

// Until the route is applied (the agents or the session list were still
// loading), every change may be the one that lets it apply; after, only a
// repaint — a failed open is never retried by itself.
onRailChange(() => {
	if (!on) return;
	if (applied === null) apply();
	else paint();
});
onViewChange(() => paint());
onSessionSync(() => {
	if (!on) return;
	if (applied === null) apply();
	else paint();
});
onGitStatus(() => paint());
onWorkGone(() => paint());
if (typeof window !== "undefined")
	window.matchMedia?.("(max-width: 768px)")?.addEventListener?.("change", () => paint());

/** Test seam / logout. */
export function resetTools(): void {
	leaveTools();
	entryDepth = null;
}

export type { AcpAgentInfo };
