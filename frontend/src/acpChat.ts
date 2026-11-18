// ACP agent chat (experimental, `features.acpAgents`): the individual chat.
// When the open session is an ACP agent, this module owns #chat-view: the
// agent's whole inbox (direct messages and what it got in Project Chat, each
// tagged) through the shared thread component (acpThread.ts), plus a header
// with its state, its project and the login notice. chatView.ts (the
// capture-based Chat) stands down for such a session.
//
// Messages typed here are DIRECT: private to the person and this agent.

import { agentStatus } from "./acpModel.js";
import { setAcpAgents } from "./acpRegistry.js";
import { AcpThread, type ThreadState } from "./acpThread.js";
import {
	type AcpAgentInfo,
	acpAgentsEnabled,
	acpListAgents,
	acpLogin,
	acpSetProject,
	fetchProjects,
	projectChatEnabled,
} from "./api.js";
import { showToast } from "./components/toast.js";
import { activeSessionId } from "./main.js";
import { navigateProject } from "./router.js";
import { el, syncChildren } from "./ui.js";
import { getView, onSessionSync, onViewChange, setView } from "./viewSwitch.js";

let agentsBySession = new Map<string, AcpAgentInfo>();
let owned: AcpAgentInfo | null = null;
let projectNames = new Map<string, string>();
let projectRowEl: HTMLElement | null = null;
let shownProjectKey = "";
let shownNoticeKey = "";

const root = el("div", "acp-chat");
root.id = "acp-chat";
root.hidden = true;
const headerEl = el("div", "acp-chat-header");
const noticeEl = el("div", "acp-chat-notice");
const thread = new AcpThread();
root.append(headerEl, noticeEl, thread.root);
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
		const list = await acpListAgents();
		agentsBySession = new Map(list.map((a) => [a.sessionId, a]));
		setAcpAgents(list);
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
	const active = getView() === "chat" && agent !== null;
	owned = agent;
	if (agent) mount();
	root.hidden = !active;
	// The capture Chat's own children (header, list/thread body, announcer…) are
	// styled with `display: flex/grid`, which beats the `hidden` attribute: a class
	// on #chat-view hides every child but this one (acp-chat.css).
	document.getElementById("chat-view")?.classList.toggle("acp-owned", agent !== null);
	if (active && agent) {
		thread.open({ kind: "agent", name: agent.name });
		void loadProjectNames().then(() => renderHeader(thread.state));
		renderHeader(thread.state);
	} else thread.close();
}

onViewChange(() => apply());
onSessionSync(() => sync());
window.addEventListener("st:projects-changed", () => void loadProjectNames());

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
	const st = agentStatus(a, Date.now(), auth);
	// Called on every thread change (each activity batch, the 15 s status
	// poll). Each part is rebuilt only when what it shows changed: a rebuilt
	// project <select> lost the choice the person had not saved yet.
	const line = el("div", "acp-chat-title");
	line.append(
		el("strong", undefined, `@${a.name}`),
		el("span", `acp-status acp-status-${st.tone}`, st.label),
	);
	const meta = el(
		"div",
		"acp-chat-meta",
		`${a.model ?? "modelo por defecto"} · ${a.runtime} · mensajes directos: privados entre vos y @${a.name}`,
	);
	const projectKey = projectChatEnabled()
		? JSON.stringify([a.name, a.projectId ?? null, [...projectNames]])
		: "";
	if (projectKey !== shownProjectKey || !projectRowEl) {
		shownProjectKey = projectKey;
		projectRowEl = projectKey ? projectRow(a) : null;
	}
	const parts: HTMLElement[] = [line, meta];
	if (projectRowEl) parts.push(projectRowEl);
	syncChildren(headerEl, parts);
	const noticeKey = JSON.stringify([a.name, auth, a.loginMethods ?? []]);
	if (noticeKey === shownNoticeKey) return;
	shownNoticeKey = noticeKey;
	noticeEl.replaceChildren();
	noticeEl.hidden = !auth;
	if (auth) {
		noticeEl.append(
			el(
				"div",
				undefined,
				"El agente necesita conectar una cuenta de Claude (una sola vez por sesión; queda guardada en la sesión). Tus mensajes quedan pendientes y se procesan solos al conectar.",
			),
		);
		const actions = el("div", "acp-login-actions");
		// The adapter's own login methods: each opens a terminal tab of this
		// session running the official `claude auth login` flow.
		for (const m of a.loginMethods ?? []) {
			const b = el("button", "files-btn primary", `Conectar cuenta · ${m.name}`);
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
		const open = el("button", "files-btn", "Abrir Terminal");
		open.type = "button";
		open.title =
			"También podés ejecutar `claude auth login` (o `claude` y /login) en la Terminal de esta sesión.";
		open.addEventListener("click", () => setView("terminal"));
		actions.append(open);
		noticeEl.append(actions);
	}
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
	const save = el("button", "files-btn", "Guardar");
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
	if (a.projectId) {
		const link = el("a", "acp-link", "Abrir Project Chat");
		link.href = `#/projects/${encodeURIComponent(a.projectId)}`;
		const pid = a.projectId;
		link.addEventListener("click", (e) => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
			e.preventDefault();
			navigateProject({ projectId: pid });
		});
		row.append(link);
	}
	return row;
}
