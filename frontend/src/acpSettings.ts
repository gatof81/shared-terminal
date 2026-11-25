// acpSettings.ts — «Ajustes del agente»: an ACP agent's settings, as a
// dialog (3B F5: they lived in the individual chat, now gone). Opened from
// the ⋯ of the agent's session (sessionCore's menu extras) and from the
// agent's menu in a project (toolsView.openAgentMenu). What needs the
// person — a model or effort pending or refused, a login missing, no
// project — is flagged on the session's ⋯ itself.
//
//   - runtime; model and effort — «Esfuerzo» — (stored at once, applied by its runner while
//     idle); its project — the only way in for an agent without one: a
//     conversation always belongs to a project;
//   - «Conectar cuenta»: the adapter's own login methods, each in a new
//     terminal tab of the agent's session.
//
// It is a dialog (components/dialog.ts): over everything, `inert`
// underneath, so the terminal keeps its box — opening it sends no resize.

import { ACP_MODELS, effortLabel, effortState, modelLabel, modelState } from "./acpModel.js";
import { acpReadTicket, setAcpAgents } from "./acpRegistry.js";
import {
	type AcpAgentInfo,
	acpListAgents,
	acpLogin,
	acpSetEffort,
	acpSetModel,
	acpSetProject,
	isLoggedIn,
} from "./api.js";
import { createDialog, type Dialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import { activeSessionId } from "./main.js";
import { projects } from "./projectDirectory.js";
import { setSessionMenuExtras } from "./sessionCore.js";
import { el } from "./ui.js";
import { onSessionSync } from "./viewSwitch.js";

let agentsBySession = new Map<string, AcpAgentInfo>();

async function loadAgents(): Promise<void> {
	if (!isLoggedIn()) return;
	try {
		const ticket = acpReadTicket();
		const list = await acpListAgents();
		agentsBySession = new Map(list.map((a) => [a.sessionId, a]));
		setAcpAgents(list, ticket);
	} catch {
		/* keep what we had */
	}
}

function byName(name: string): AcpAgentInfo | null {
	for (const a of agentsBySession.values()) if (a.name === name) return a;
	return null;
}

/** A write answered: the copy here (and the registry, by the next read) follows it. */
function patched(info: AcpAgentInfo): void {
	const prev = agentsBySession.get(info.sessionId);
	agentsBySession.set(info.sessionId, { ...prev, ...info } as AcpAgentInfo);
	paintMenuFlag();
	if (shown === info.name) render();
}

// ── The session's ⋯ ────────────────────────────────────────────────────────

onSessionSync(() => {
	if (!isLoggedIn()) return;
	void loadAgents().then(() => {
		registerMenuExtras();
		paintMenuFlag();
	});
});
window.addEventListener("st:projects-changed", () => {
	if (shown) render();
});

let extrasRegistered = false;
function registerMenuExtras(): void {
	if (extrasRegistered) return;
	extrasRegistered = true;
	setSessionMenuExtras((s) => {
		const a = agentsBySession.get(s.sessionId);
		if (!a) return { items: [], onPick: () => false };
		return {
			items: [{ id: "acp-settings", label: "Ajustes del agente", hint: flagWhy(a) ?? undefined }],
			onPick: (id) => {
				if (id !== "acp-settings") return false;
				openAgentSettings(a.name, document.getElementById("session-menu-btn"));
				return true;
			},
		};
	});
}

/** What the agent's settings need from the person, in words (null: nothing). */
function flagWhy(a: AcpAgentInfo): string | null {
	const ms = modelState(a);
	const es = effortState(a);
	if (ms === "failed") return "el modelo no se aplicó";
	if (es === "failed") return "el esfuerzo no se aplicó";
	if (a.authRequired) return "falta conectar una cuenta";
	if (!a.projectId) return "Sin proyecto · Asignale uno para conversar";
	if (ms === "pending") return "cambio de modelo pendiente";
	if (es === "pending") return "cambio de esfuerzo pendiente";
	return null;
}

function paintMenuFlag(): void {
	const btn = document.getElementById("session-menu-btn");
	if (!btn) return;
	const a = activeSessionId ? agentsBySession.get(activeSessionId) : undefined;
	const why = a ? flagWhy(a) : null;
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

// ── The dialog ──────────────────────────────────────────────────────────────

let dialog: Dialog | null = null;
let titleEl: HTMLElement | null = null;
let body: HTMLElement | null = null;
/** The agent whose settings are open. */
let shown: string | null = null;
let openGen = 0;

/** «Ajustes del agente» of agent `name`; focus returns to `opener` on close. */
export function openAgentSettings(name: string, opener?: Element | null): void {
	build();
	shown = name;
	const g = ++openGen;
	render();
	dialog!.open(opener ?? document.activeElement);
	// Its state as of now (a model applied meanwhile, a login done).
	void loadAgents().then(() => {
		if (g === openGen && dialog?.isOpen()) {
			render();
			paintMenuFlag();
		}
	});
}

function build(): void {
	if (dialog) return;
	const root = el("div", "modal acp-settings-dialog");
	root.setAttribute("aria-hidden", "true");
	const backdrop = el("div", "modal-backdrop");
	backdrop.setAttribute("data-close-modal", "");
	const card = el("div", "modal-card acp-settings-card");
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-modal", "true");
	card.setAttribute("aria-labelledby", "acp-settings-title");
	const header = el("div", "modal-header");
	titleEl = el("h2", undefined, "Ajustes del agente");
	titleEl.id = "acp-settings-title";
	const close = el("button", "modal-close", "×");
	close.type = "button";
	close.setAttribute("aria-label", "Cerrar ajustes");
	close.setAttribute("data-close-modal", "");
	header.append(titleEl, close);
	body = el("div", "acp-settings");
	card.append(header, body);
	root.append(backdrop, card);
	document.body.append(root);
	dialog = createDialog(root, {
		initialFocus: () => body?.querySelector<HTMLElement>("select, button") ?? close,
		onClose: () => {
			shown = null;
			openGen++;
		},
	});
}

function render(): void {
	if (!body || !titleEl || !shown) return;
	const a = byName(shown);
	titleEl.textContent = `Ajustes de @${shown}`;
	if (!a) {
		body.replaceChildren(el("p", "acp-chat-meta", "Cargando…"));
		return;
	}
	// The focus survives a re-render: it goes back to the same control.
	const focused = document.activeElement as HTMLElement | null;
	const which = focused && body.contains(focused) ? focused.dataset.ctl : undefined;
	const parts: HTMLElement[] = [
		settingRow("acp-chat-runtime", "Runtime", el("span", "acp-chat-meta", a.runtime)),
	];
	parts.push(modelRow(a), effortRow(a), projectRow(a));
	if (a.authRequired) parts.push(loginBox(a));
	body.replaceChildren(...parts);
	if (which) body.querySelector<HTMLElement>(`[data-ctl="${which}"]`)?.focus();
}

/**
 * «Conectar cuenta»: the adapter's own login methods; each opens a terminal
 * tab of the agent's session running the official `claude auth login`.
 */
function loginBox(a: AcpAgentInfo): HTMLElement {
	const box = el("div", "acp-chat-notice");
	box.append(
		el(
			"div",
			undefined,
			"El agente necesita conectar una cuenta de Claude (una sola vez por sesión; queda guardada en la sesión). Sus mensajes quedan pendientes y se procesan solos al conectar.",
		),
	);
	const actions = el("div", "acp-login-actions");
	for (const m of a.loginMethods ?? []) {
		const b = el("button", "btn sm primary", `Conectar cuenta · ${m.name}`);
		b.type = "button";
		b.dataset.ctl = `login:${m.id}`;
		b.title = m.description || m.name;
		b.addEventListener("click", () => {
			b.disabled = true;
			void acpLogin(a.name, m.id)
				.then(({ sessionId, tabId }) => {
					dialog?.close();
					window.dispatchEvent(
						new CustomEvent("st:open-terminal-tab", { detail: { sessionId, tabId } }),
					);
				})
				.catch((err: Error) => showToast(`No se pudo abrir el login: ${err.message}`, true))
				.finally(() => (b.disabled = false));
		});
		actions.append(b);
	}
	const hint = el("div", "acp-chat-meta");
	hint.append(
		"También podés ejecutar ",
		el("code", undefined, "claude auth login"),
		" (o ",
		el("code", undefined, "claude"),
		" y ",
		el("code", undefined, "/login"),
		") en la Terminal de su sesión.",
	);
	box.append(actions, hint);
	return box;
}

/** A select saved by an explicit button, never on `change` alone (keyboard type-ahead fires it). */
function savedSelect(
	ctl: string,
	label: string,
	options: Array<[string, string]>,
	value: string,
	saveLabel: string,
	save: (v: string) => Promise<AcpAgentInfo>,
	what: string,
): { select: HTMLSelectElement; button: HTMLButtonElement } {
	const select = el("select", `acp-${ctl}-select`);
	select.dataset.ctl = ctl;
	select.setAttribute("aria-label", label);
	for (const [v, text] of options) select.append(new Option(text, v));
	select.value = value;
	const button = el("button", "btn sm", saveLabel);
	button.type = "button";
	button.dataset.ctl = `${ctl}-save`;
	button.hidden = true;
	select.addEventListener("change", () => (button.hidden = select.value === value));
	button.addEventListener("click", () => {
		select.disabled = button.disabled = true;
		void save(select.value)
			.then((info) => {
				patched(info);
				// The registry too: the sidebar files the agent under its project.
				void loadAgents();
			})
			.catch((err: Error) => {
				select.value = value;
				button.hidden = true;
				showToast(`No se pudo cambiar ${what}: ${err.message}`, true);
			})
			.finally(() => {
				select.disabled = button.disabled = false;
			});
	});
	return { select, button };
}

/**
 * The agent's model. A change is stored at once and its runner switches the
 * live ACP session while idle (a message in progress finishes on the model
 * it started with): context, history and queue stay.
 */
function modelRow(a: AcpAgentInfo): HTMLElement {
	const options: Array<[string, string]> = ACP_MODELS.map((m) => [m.id, m.label]);
	if (a.model && !ACP_MODELS.some((m) => m.id === a.model)) options.push([a.model, a.model]);
	if (!a.model) options.push(["", "Por defecto"]);
	const { select, button } = savedSelect(
		"model",
		"Modelo del agente",
		options,
		a.model ?? "",
		"Cambiar modelo",
		(v) => acpSetModel(a.name, v),
		"el modelo",
	);
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
	return settingRow("acp-chat-model", "Modelo", select, button, status);
}

/**
 * The agent's reasoning effort, applied like the model (by its runner, while
 * idle). The levels are only the ones its adapter reported for the model in
 * use: nothing here knows which levels exist.
 */
function effortRow(a: AcpAgentInfo): HTMLElement {
	const stored = a.effort ?? "default";
	const levels = a.effortApplied?.levels ?? [];
	const values = levels.length > 0 ? [...levels] : ["default"];
	// A stored level the adapter does not offer stays visible, so its error reads against it.
	if (!values.includes(stored)) values.push(stored);
	const { select, button } = savedSelect(
		"effort",
		"Esfuerzo del agente",
		values.map((v) => [v, v === "default" ? "Por defecto" : effortLabel(v)]),
		stored,
		"Cambiar esfuerzo",
		(v) => acpSetEffort(a.name, v === "default" ? null : v),
		"el esfuerzo",
	);
	const es = effortState(a);
	const note =
		es === "pending"
			? `Se aplica cuando @${a.name} esté libre (el mensaje en curso termina con el esfuerzo anterior).`
			: es === "failed"
				? `El adaptador rechazó ${effortLabel(a.effort)}: ${a.effortApplied?.error ?? ""}`
				: es === "applied"
					? "Aplicado."
					: "";
	const status = el("span", `acp-effort-state acp-effort-${es}`, note);
	status.setAttribute("role", "status");
	const parts: HTMLElement[] = [select, button, status];
	if (levels.length === 0)
		parts.push(
			el(
				"span",
				"acp-effort-note",
				a.effortApplied
					? "El modelo actual no ofrece niveles de esfuerzo"
					: "Los niveles se conocen cuando el agente atienda su próximo mensaje",
			),
		);
	return settingRow("acp-chat-effort", "Esfuerzo", ...parts);
}

/** Its project: where its conversations happen (without one it has none). */
function projectRow(a: AcpAgentInfo): HTMLElement {
	const options: Array<[string, string]> = [["", "Sin proyecto"]];
	for (const p of projects()) options.push([p.projectId, p.name]);
	if (a.projectId && !projects().some((p) => p.projectId === a.projectId))
		options.push([a.projectId, "(proyecto)"]);
	const { select, button } = savedSelect(
		"project",
		"Proyecto del agente",
		options,
		a.projectId ?? "",
		"Guardar",
		(v) => acpSetProject(a.name, v || null),
		"el proyecto",
	);
	const parts: HTMLElement[] = [select, button];
	if (!a.projectId)
		parts.push(
			el(
				"span",
				"acp-effort-note acp-project-note",
				"Sin proyecto no tiene conversaciones ni Archivo. Asignale un proyecto para hablarle en sus temas; sus mensajes anteriores pasan al Archivo de ese proyecto.",
			),
		);
	return settingRow("acp-chat-project", "Proyecto", ...parts);
}

/** One setting: its label in the first column, its controls and notes in the second. */
function settingRow(cls: string, label: string, ...controls: HTMLElement[]): HTMLElement {
	const row = el("div", `acp-set-row ${cls}`);
	const ctl = el("div", "acp-set-ctl");
	ctl.append(...controls);
	row.append(el("span", "acp-set-label", label), ctl);
	return row;
}
