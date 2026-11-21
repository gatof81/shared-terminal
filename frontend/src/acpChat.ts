// ACP agent chat (experimental, `features.acpAgents`): the individual chat.
// When the open session is an ACP agent, this module owns #chat-view: the
// agent's whole inbox (direct messages and what it got in Project Chat, each
// tagged) through the shared thread component (acpThread.ts), plus a header
// with its state, its project and the login notice. chatView.ts (the
// capture-based Chat) stands down for such a session.
//
// Messages typed here are DIRECT: private to the person and this agent.

import { ACP_MODELS, modelLabel, modelState } from "./acpModel.js";
import { acpReadTicket, setAcpAgents } from "./acpRegistry.js";
import { AcpThread, type ThreadState } from "./acpThread.js";
import {
	type AcpAgentInfo,
	acpAgentsEnabled,
	acpListAgents,
	acpLogin,
	acpSetModel,
	acpSetProject,
	fetchProjects,
	projectChatEnabled,
} from "./api.js";
import { showToast } from "./components/toast.js";
import { activeSessionId } from "./main.js";
import { setSessionMenuExtras } from "./sessionCore.js";
import { el, syncChildren } from "./ui.js";
import { getView, onSessionSync, onViewChange, setView } from "./viewSwitch.js";

let agentsBySession = new Map<string, AcpAgentInfo>();
let owned: AcpAgentInfo | null = null;
let projectNames = new Map<string, string>();
let projectRowEl: HTMLElement | null = null;
let shownProjectKey = "";
let modelRowEl: HTMLElement | null = null;
let shownModelKey = "";
let shownNoticeKey = "";

const root = el("div", "acp-chat");
root.id = "acp-chat";
root.hidden = true;
// The agent's settings — runtime, model, project choice — in a panel that
// is closed by default and opened from the bar's ⋯ ("Ajustes del agente").
// Every element here is kept across renders (only `hidden` and texts
// change): an unsaved choice and the focus survive live updates, and a
// closed-then-reopened panel shows them again.
const settingsPanel = el("div", "acp-settings");
settingsPanel.id = "acp-settings";
settingsPanel.hidden = true;
settingsPanel.setAttribute("role", "group");
settingsPanel.setAttribute("aria-label", "Ajustes del agente");
const privacyEl = el("div", "acp-chat-meta acp-chat-privacy");
const runtimeEl = el("div", "acp-chat-meta");
// The agent whose panel is shown: another agent's chat starts with it closed.
let shownAgentName: string | null = null;
// Escape closes the panel and gives the focus back to the bar's ⋯.
settingsPanel.addEventListener("keydown", (e) => {
	if (e.key !== "Escape" || settingsPanel.hidden) return;
	e.preventDefault();
	e.stopPropagation();
	setSettings(false);
	document.getElementById("session-menu-btn")?.focus();
});

function setSettings(open: boolean): void {
	settingsPanel.hidden = !open;
}
const noticeEl = el("div", "acp-chat-notice");
const thread = new AcpThread();
// On a short screen the panel is the part that gives way (shrinks, scrolls
// inside) to the thread's minimum (acp-chat.css).
root.append(settingsPanel, noticeEl, thread.root);
thread.onState = (s) => renderHeader(s);

// Mounted on first use (the module is imported by chatView.ts, also in tests
// whose DOM has no #chat-view).
function mount(): void {
	if (!root.isConnected) document.getElementById("chat-view")?.appendChild(root);
}

/** True when the session's Chat belongs to this module (chatView.ts checks it). */
export function acpOwns(sessionId: string | null): boolean {
	return sessionId !== null && agentsBySession.has(sessionId);
}

/** The agent of a session, when it is one (sidebar, project page). */
export function acpAgentOfSession(sessionId: string): AcpAgentInfo | null {
	return agentsBySession.get(sessionId) ?? null;
}

async function loadAgents(): Promise<void> {
	if (!acpAgentsEnabled()) return;
	try {
		const ticket = acpReadTicket();
		const list = await acpListAgents();
		agentsBySession = new Map(list.map((a) => [a.sessionId, a]));
		setAcpAgents(list, ticket);
	} catch {
		/* keep what we had */
	}
}

async function loadProjectNames(): Promise<void> {
	if (!projectChatEnabled()) return;
	const r = await fetchProjects().catch(() => null);
	if (r?.ok) projectNames = new Map(r.body.projects.map((p) => [p.projectId, p.name]));
}

function sync(): void {
	if (!acpAgentsEnabled()) return;
	void loadAgents().then(apply);
}

function apply(): void {
	const sid = activeSessionId;
	const agent = sid ? (agentsBySession.get(sid) ?? null) : null;
	if (agent) registerMenuExtras();
	const active = getView() === "chat" && agent !== null;
	owned = agent;
	paintMenuFlag(agent, agent ? thread.state.auth.get(agent.name) === true : false);
	if (agent) mount();
	root.hidden = !active;
	// The capture Chat's own children (header, list/thread body, announcer…) are
	// styled with `display: flex/grid`, which beats the `hidden` attribute: a class
	// on #chat-view hides every child but this one (acp-chat.css).
	document.getElementById("chat-view")?.classList.toggle("acp-owned", agent !== null);
	if (active && agent) {
		// Another agent's chat starts with its panel closed.
		if (shownAgentName !== agent.name) setSettings(false);
		shownAgentName = agent.name;
		thread.open({ kind: "agent", name: agent.name });
		void loadProjectNames().then(() => renderHeader(thread.state));
		renderHeader(thread.state);
	} else thread.close();
}

onViewChange(() => apply());
onSessionSync(() => sync());
window.addEventListener("st:projects-changed", () => void loadProjectNames());

// ── The bar is the agent's header (UX iter3 E) ──────────────────────────
//
// On an agent's session the session bar shows the agent (sessionCore
// paintBarIdentity). "Ajustes" is the bar's ⋯ first entry, and what needs
// the person — a model pending or refused, a login missing — is flagged on
// the ⋯ itself.

let extrasRegistered = false;
function registerMenuExtras(): void {
	if (extrasRegistered) return;
	extrasRegistered = true;
	setSessionMenuExtras((s) => {
		const a = agentsBySession.get(s.sessionId);
		if (!a) return { items: [], onPick: () => false };
		const why = flagWhy(a, thread.state.auth.get(a.name) === true);
		return {
			items: [{ id: "acp-settings", label: "Ajustes del agente", hint: why ?? undefined }],
			onPick: (id) => {
				if (id !== "acp-settings") return false;
				openSettings();
				return true;
			},
		};
	});
}

/** "Ajustes del agente" from the ⋯: the agent's Chat with the panel open, the focus in it. */
function openSettings(): void {
	if (getView() !== "chat") setView("chat");
	setSettings(true);
	settingsPanel.querySelector<HTMLElement>("select, button, input")?.focus();
}

/** What the agent's settings need from the person, in words (null: nothing). */
function flagWhy(a: AcpAgentInfo, auth: boolean): string | null {
	const ms = modelState(a);
	if (ms === "failed") return "el modelo no se aplicó";
	if (auth || a.authRequired) return "falta conectar una cuenta";
	if (ms === "pending") return "cambio de modelo pendiente";
	return null;
}

function paintMenuFlag(a: AcpAgentInfo | null, auth: boolean): void {
	const btn = document.getElementById("session-menu-btn");
	if (!btn) return;
	const why = a ? flagWhy(a, auth) : null;
	let mark = btn.querySelector<HTMLElement>(".bar-menu-flag");
	if (!why) {
		mark?.remove();
		btn.setAttribute("aria-label", "Session actions");
		return;
	}
	if (!mark) {
		mark = el("span", "bar-menu-flag");
		mark.setAttribute("aria-hidden", "true");
		btn.append(mark);
	}
	mark.textContent = why.startsWith("cambio") ? "…" : "!";
	btn.setAttribute("aria-label", `Session actions (${why})`);
}

// ── Header ──────────────────────────────────────────────────────────────

function renderHeader(s: ThreadState): void {
	if (!owned) return;
	const live = s.agents.find((a) => a.name === owned?.name) ?? owned;
	if (live !== owned && owned) {
		owned = { ...owned, ...live };
		agentsBySession.set(owned.sessionId, owned);
	}
	const a = owned;
	const auth = s.auth.get(a.name) === true;
	// Called on every thread change (each activity batch, the 15 s status
	// poll). Each part is rebuilt only when what it shows changed: a rebuilt
	// project <select> lost the choice the person had not saved yet.
	// The placeholder says it too, but it goes away while typing: here it stays.
	privacyEl.textContent = `Mensajes directos: privados entre vos y @${a.name}`;
	runtimeEl.textContent = `Runtime: ${a.runtime}`;
	const projectKey = projectChatEnabled()
		? JSON.stringify([a.name, a.projectId ?? null, [...projectNames]])
		: "";
	if (projectKey !== shownProjectKey || !projectRowEl) {
		shownProjectKey = projectKey;
		projectRowEl = projectKey ? projectRow(a) : null;
	}
	const ms = modelState(a);
	const modelKey = JSON.stringify([
		a.name,
		a.model,
		ms,
		a.modelApplied?.error ?? null,
		a.modelApplied?.current ?? null,
	]);
	if (modelKey !== shownModelKey || !modelRowEl) {
		shownModelKey = modelKey;
		modelRowEl = modelRow(a);
	}
	paintMenuFlag(a, auth);
	const parts: HTMLElement[] = [privacyEl, runtimeEl, modelRowEl];
	if (projectRowEl) parts.push(projectRowEl);
	syncChildren(settingsPanel, parts);
	const noticeKey = JSON.stringify([a.name, auth, a.loginMethods ?? []]);
	if (noticeKey === shownNoticeKey) return;
	shownNoticeKey = noticeKey;
	noticeEl.replaceChildren();
	noticeEl.hidden = !auth;
	if (auth) {
		// Outside the panel, always visible while it applies; a phone gets
		// the short text (CSS shows one of the two).
		const text = el("div");
		text.append(
			el(
				"span",
				"acp-notice-long",
				"El agente necesita conectar una cuenta de Claude (una sola vez por sesión; queda guardada en la sesión). Tus mensajes quedan pendientes y se procesan solos al conectar.",
			),
			el(
				"span",
				"acp-notice-short",
				"Conectá una cuenta de Claude: tus mensajes esperan y salen solos al conectar.",
			),
		);
		noticeEl.append(text);
		const actions = el("div", "acp-login-actions");
		// The adapter's own login methods: each opens a terminal tab of this
		// session running the official `claude auth login` flow.
		for (const m of a.loginMethods ?? []) {
			const b = el("button", "btn sm primary", `Conectar cuenta · ${m.name}`);
			b.type = "button";
			b.title = m.description || m.name;
			b.addEventListener("click", () => {
				b.disabled = true;
				void acpLogin(a.name, m.id)
					.then(({ sessionId, tabId }) =>
						window.dispatchEvent(
							new CustomEvent("st:open-terminal-tab", { detail: { sessionId, tabId } }),
						),
					)
					.catch((err: Error) => showToast(`No se pudo abrir el login: ${err.message}`, true))
					.finally(() => (b.disabled = false));
			});
			actions.append(b);
		}
		const open = el("button", "btn sm", "Abrir Terminal");
		open.type = "button";
		open.title =
			"También podés ejecutar `claude auth login` (o `claude` y /login) en la Terminal de esta sesión.";
		open.addEventListener("click", () => setView("terminal"));
		actions.append(open);
		noticeEl.append(actions);
	}
}

/**
 * The agent's model and how to change it. A change is stored at once and its
 * runner switches the live ACP session while idle (a message in progress
 * finishes on the model it started with): context, history and queue stay.
 */
function modelRow(a: AcpAgentInfo): HTMLElement {
	const row = el("div", "acp-chat-project acp-chat-model");
	const select = el("select", "acp-model-select");
	select.setAttribute("aria-label", "Modelo del agente");
	for (const m of ACP_MODELS) select.append(new Option(m.label, m.id));
	if (a.model && !ACP_MODELS.some((m) => m.id === a.model))
		select.append(new Option(a.model, a.model));
	if (!a.model) select.append(new Option("Por defecto", ""));
	select.value = a.model ?? "";
	// Saved by an explicit button, never on `change` alone (keyboard type-ahead fires it).
	const save = el("button", "btn sm", "Cambiar modelo");
	save.type = "button";
	save.hidden = true;
	select.addEventListener(
		"change",
		() => (save.hidden = select.value === (a.model ?? "") || select.value === ""),
	);
	save.addEventListener("click", () => {
		select.disabled = save.disabled = true;
		void acpSetModel(a.name, select.value)
			.then((info) => {
				if (owned?.name === info.name) owned = { ...owned, ...info };
				agentsBySession.set(info.sessionId, { ...a, ...info });
				thread.updateAgent(info);
			})
			.catch((err: Error) => {
				select.value = a.model ?? "";
				save.hidden = true;
				showToast(`No se pudo cambiar el modelo: ${err.message}`, true);
			})
			.finally(() => {
				select.disabled = save.disabled = false;
				renderHeader(thread.state);
			});
	});
	const ms = modelState(a);
	const note =
		ms === "pending"
			? `Se aplica cuando @${a.name} esté libre (el mensaje en curso termina con el modelo anterior).`
			: ms === "failed"
				? `El adaptador rechazó ${modelLabel(a.model)}: ${a.modelApplied?.error ?? ""}`
				: ms === "applied"
					? `Aplicado${a.modelApplied?.current ? ` (el adaptador usa ${a.modelApplied.current})` : ""}.`
					: "";
	const status = el("span", `acp-model-state acp-model-${ms}`, note);
	status.setAttribute("role", "status");
	row.append(el("span", undefined, "Modelo:"), select, save, status);
	return row;
}

function projectRow(a: AcpAgentInfo): HTMLElement {
	const row = el("div", "acp-chat-project");
	const select = el("select", "acp-project-select");
	select.setAttribute("aria-label", "Proyecto del agente");
	select.append(new Option("Sin proyecto", ""));
	for (const [id, name] of projectNames) select.append(new Option(name, id));
	if (a.projectId && !projectNames.has(a.projectId))
		select.append(new Option("(proyecto)", a.projectId));
	select.value = a.projectId ?? "";
	// Saved by an explicit button, never on `change` alone (keyboard type-ahead fires it).
	const save = el("button", "btn sm", "Guardar");
	save.type = "button";
	save.hidden = true;
	select.addEventListener("change", () => (save.hidden = select.value === (a.projectId ?? "")));
	save.addEventListener("click", () => {
		select.disabled = save.disabled = true;
		const pid = select.value || null;
		void acpSetProject(a.name, pid)
			.then((info) => {
				if (owned?.name === info.name) owned = { ...owned, ...info };
				agentsBySession.set(info.sessionId, { ...a, ...info });
				// The thread's copy too: its next state must not bring the old project back.
				thread.updateAgent(info);
				// And the registry's (one read): the sidebar files the agent under its
				// new project and the bar's "proyecto ↗" follows.
				void loadAgents();
			})
			.catch((err: Error) => {
				select.value = a.projectId ?? "";
				save.hidden = true;
				showToast(`No se pudo cambiar el proyecto: ${err.message}`, true);
			})
			.finally(() => {
				select.disabled = save.disabled = false;
				renderHeader(thread.state);
			});
	});
	row.append(el("span", undefined, "Proyecto:"), select, save);
	return row;
}
