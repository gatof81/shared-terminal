// ACP agent chat (experimental, `features.acpAgents`). When the open session is
// an ACP agent, this module owns #chat-view: the thread is the agent's messages
// from the backend's single message store (D1) plus the live activity the runner
// reports. chatView.ts (the capture-based Chat) stands down for such a session.
//
// Sending never waits for the agent: a message is persisted by the backend (201)
// and shows its own state — pending, running, done, uncertain — while the agent
// works through them in order. No steering, no interruption of the current turn.
// Text goes as typed (multi-line, code, any length up to the backend's
// provider-neutral limit); above it, as an attachment in the agent's session.
// DOM is built with textContent only.

import {
	type AcpActivity,
	type AcpAgentInfo,
	type AcpFeed,
	type AcpMessage,
	acpAgentsEnabled,
	acpFeed,
	acpListAgents,
	acpRequeue,
	acpSend,
	uploadSessionFiles,
} from "./api.js";
import { activeSessionId } from "./main.js";
import { el } from "./ui.js";
import { getView, onSessionSync, onViewChange } from "./viewSwitch.js";

const POLL_MS = 1_500;
const STATE_LABEL: Record<string, string> = {
	pending: "pendiente",
	running: "en curso",
	done: "hecho",
	failed: "falló",
	uncertain: "incierto",
};

let agentsBySession = new Map<string, AcpAgentInfo>();
let agentsLoaded: Promise<void> | null = null;
let owned: AcpAgentInfo | null = null;
let feed: AcpFeed | null = null;
let seq = 0;
const activityByMessage = new Map<number, AcpActivity[]>();
const liveText = new Map<number, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastSignature = "";
let sending = 0;
let errorText = "";
let authRequired = false;

const root = el("div", "acp-chat");
root.id = "acp-chat";
root.hidden = true;
// Mounted on first use (the module is imported by chatView.ts, also in tests
// whose DOM has no #chat-view).
function mount(): void {
	if (!root.isConnected) document.getElementById("chat-view")?.appendChild(root);
}

/** True when the session's Chat belongs to this module (chatView.ts checks it). */
export function acpOwns(sessionId: string | null): boolean {
	return sessionId !== null && agentsBySession.has(sessionId);
}

async function loadAgents(): Promise<void> {
	if (!acpAgentsEnabled()) return;
	try {
		agentsBySession = new Map((await acpListAgents()).map((a) => [a.sessionId, a]));
	} catch {
		/* keep what we had */
	}
}

function sync(): void {
	if (!acpAgentsEnabled()) return;
	agentsLoaded = loadAgents();
	void agentsLoaded.then(apply);
}

function apply(): void {
	const sid = activeSessionId;
	const agent = sid ? (agentsBySession.get(sid) ?? null) : null;
	const active = getView() === "chat" && agent !== null;
	if (agent?.name !== owned?.name) {
		feed = null;
		seq = 0;
		activityByMessage.clear();
		liveText.clear();
		lastSignature = "";
		errorText = "";
		authRequired = false;
		threadEl.textContent = "";
	}
	owned = agent;
	if (agent) mount();
	root.hidden = !active;
	// The capture Chat's own children (header, list/thread body, announcer…) are
	// styled with `display: flex/grid`, which beats the `hidden` attribute: a class
	// on #chat-view hides every child but this one (acp-chat.css).
	document.getElementById("chat-view")?.classList.toggle("acp-owned", agent !== null);
	if (active) {
		header();
		start();
	} else stop();
}

onViewChange(() => apply());
onSessionSync(() => sync());

// ── Polling ───────────────────────────────────────────────────────────────

function start(): void {
	if (timer) return;
	void poll();
	timer = setInterval(() => {
		if (!document.hidden) void poll();
	}, POLL_MS);
}

function stop(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

async function poll(): Promise<void> {
	const agent = owned;
	if (!agent) return;
	try {
		const next = await acpFeed(agent.name, seq);
		if (owned?.name !== agent.name) return;
		for (const e of next.activity) {
			// The runner reports a refused login; any later turn means it got past it.
			if (e.kind === "auth") authRequired = e.state === "required";
			if (e.kind === "turn" && e.phase === "answered") authRequired = false;
			if (e.messageId === null) continue;
			if (e.kind === "text") liveText.set(e.messageId, String(e.text ?? ""));
			else {
				const list = activityByMessage.get(e.messageId) ?? [];
				list.push(e);
				activityByMessage.set(e.messageId, list.slice(-200));
			}
		}
		seq = next.seq;
		feed = next;
		errorText = "";
	} catch (err) {
		errorText = `No se pudo actualizar: ${(err as Error).message}`;
	}
	render();
}

// ── Rendering ─────────────────────────────────────────────────────────────

const headerEl = el("div", "acp-chat-header");
const threadEl = el("div", "acp-chat-thread");
const composerEl = el("form", "acp-chat-composer");
const input = el("textarea", "acp-chat-input");
const sendBtn = el("button", "files-btn acp-chat-send", "Enviar");
const hint = el("div", "acp-chat-hint");
input.rows = 4;
input.placeholder =
	"Escribile al agente. Ctrl+Enter envía. Podés enviar más mensajes mientras trabaja.";
input.setAttribute("aria-label", "Mensaje para el agente");
sendBtn.type = "submit";
composerEl.append(input, el("div", "acp-chat-actions"));
(composerEl.lastChild as HTMLElement).append(hint, sendBtn);
root.append(headerEl, threadEl, composerEl);

function header(): void {
	headerEl.textContent = "";
	if (!owned) return;
	const seen = feed?.agent.runnerSeenAt ?? owned.runnerSeenAt;
	const age = seen ? Math.round((Date.now() - Date.parse(seen)) / 1000) : null;
	headerEl.append(
		el("strong", undefined, `@${owned.name}`),
		el("span", "acp-chat-meta", ` · ${owned.model ?? "modelo por defecto"} · ${owned.runtime}`),
		el(
			"span",
			age !== null && age < 15 ? "acp-chat-runner ok" : "acp-chat-runner",
			age === null
				? " · runner sin conectar"
				: age < 15
					? " · runner activo"
					: ` · runner visto hace ${age}s`,
		),
	);
}

function who(id: string): string {
	return id === "owner" ? "Vos" : id === "system" ? "Shared Terminal" : `@${id}`;
}

function render(): void {
	header();
	if (!feed) return;
	const sig = JSON.stringify([
		feed.messages.map((m) => [m.id, m.state, m.result_text?.length, m.note]),
		seq,
		errorText,
		authRequired,
	]);
	if (sig === lastSignature) return;
	lastSignature = sig;
	const atBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 40;
	threadEl.textContent = "";
	if (errorText) threadEl.append(el("div", "acp-chat-error", errorText));
	if (authRequired)
		threadEl.append(
			el(
				"div",
				"acp-chat-error",
				"El agente no está autenticado. Abrí la pestaña Terminal de esta sesión, ejecutá `claude` e iniciá sesión con /login (una sola vez: queda guardado en la sesión). Tus mensajes quedan pendientes y se procesan solos después.",
			),
		);
	if (feed.messages.length === 0)
		threadEl.append(
			el("div", "acp-chat-empty", "Sin mensajes todavía. El agente procesa uno por vez, en orden."),
		);
	for (const m of feed.messages) threadEl.append(messageEl(m));
	if (atBottom) threadEl.scrollTop = threadEl.scrollHeight;
	const queued = feed.messages.filter(
		(m) => m.to_id === owned?.name && m.state === "pending",
	).length;
	hint.textContent = `${queued ? `${queued} en espera · ` : ""}límite ${Math.round(feed.maxMessageBytes / 1024)} KiB por mensaje (más grande ⇒ adjunto)`;
}

function messageEl(m: AcpMessage): HTMLElement {
	const item = el("article", `acp-msg acp-${m.state}${m.from_id === "owner" ? " acp-mine" : ""}`);
	const head = el("div", "acp-msg-head");
	head.append(
		el(
			"span",
			"acp-msg-who",
			`#${m.id} ${who(m.from_id)} → ${who(m.to_id)}${m.reply_to ? ` (respuesta a #${m.reply_to})` : ""}`,
		),
		el(
			"span",
			`acp-badge acp-badge-${m.state}`,
			// While the runner reports a missing login, a message to this agent that
			// is not finished is waiting for that login (each retry claims it for a
			// moment and gives it back): say so instead of flickering pending/running.
			authRequired && m.to_id === owned?.name && (m.state === "pending" || m.state === "running")
				? "esperando login"
				: (STATE_LABEL[m.state] ?? m.state),
		),
	);
	item.append(head);
	const body = el("pre", "acp-msg-body");
	body.textContent = m.body;
	item.append(body);
	if (m.state === "running") {
		const acts = activityByMessage.get(m.id) ?? [];
		// One row per tool call / task, with its latest state (events are deltas).
		const rows = new Map<string, { label: string; state: string; detail: string }>();
		for (const a of acts) {
			if (a.kind !== "tool" && a.kind !== "task") continue;
			const key = `${a.kind}:${String(a.kind === "task" ? a.taskId : a.toolCallId)}`;
			const row = rows.get(key) ?? { label: "", state: "", detail: "" };
			if (a.kind === "task")
				row.label ||= `tarea ${String(a.taskType ?? "")} ${String(a.name ?? a.taskId)}`;
			else if (a.title) row.label = String(a.title);
			if (a.kind === "tool" && typeof a.detail === "string") row.detail = a.detail;
			const st = a.kind === "task" ? a.state : a.status;
			if (st) row.state = String(st);
			rows.set(key, row);
		}
		if (rows.size) {
			const ul = el("ul", "acp-activity");
			for (const r of [...rows.values()].slice(-12))
				ul.append(
					el(
						"li",
						undefined,
						`${r.label || "herramienta"}${r.detail ? ` · ${r.detail}` : ""}: ${r.state || "…"}`,
					),
				);
			item.append(ul);
		}
		const live = liveText.get(m.id);
		if (live) item.append(el("pre", "acp-msg-result acp-live", live));
	}
	if (m.result_text) {
		const res = el("pre", "acp-msg-result");
		res.textContent = m.result_text;
		item.append(res);
	}
	if (m.note) item.append(el("div", "acp-msg-note", m.note));
	if (m.state === "uncertain" && m.to_id === owned?.name) {
		const again = el("button", "files-btn", "Volver a encolar");
		again.type = "button";
		again.title = "Puede repetir efectos de la ejecución interrumpida: decisión tuya.";
		again.addEventListener("click", () => {
			again.disabled = true;
			void acpRequeue(m.id)
				.then(() => poll())
				.catch((err) => {
					errorText = (err as Error).message;
					render();
				});
		});
		item.append(again);
	}
	return item;
}

// ── Sending ───────────────────────────────────────────────────────────────

async function send(): Promise<void> {
	const agent = owned;
	const text = input.value;
	if (!agent || text.trim() === "") return;
	const max = feed?.maxMessageBytes ?? 256 * 1024;
	// The input is free again at once (the next message can be typed while
	// this one is in flight); on a failure the text comes back if the field
	// is still empty, so nothing typed is lost.
	input.value = "";
	sending++;
	sendBtn.textContent = sending > 1 ? `Enviando (${sending})…` : "Enviando…";
	try {
		if (new TextEncoder().encode(text).length > max) {
			const file = new File([text], `mensaje-${Date.now()}.md`, { type: "text/markdown" });
			const { paths } = await uploadSessionFiles(agent.sessionId, [file]);
			await acpSend(
				agent.name,
				`Te envío un mensaje largo como adjunto (${file.size} bytes): ${paths[0]}\nLeelo completo y tratalo como el contenido de este mensaje.`,
			);
		} else await acpSend(agent.name, text);
		errorText = "";
	} catch (err) {
		if (input.value === "") input.value = text;
		errorText = `No se envió (el texto volvió al campo): ${(err as Error).message}`;
	} finally {
		sending--;
		sendBtn.textContent = "Enviar";
		lastSignature = "";
		await poll();
	}
}

composerEl.addEventListener("submit", (e) => {
	e.preventDefault();
	void send();
});
input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		void send();
	}
});
