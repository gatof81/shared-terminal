// acpThread.ts — the thread + composer of an ACP chat, shared by the
// individual chat of an agent (acpChat.ts) and Project Chat
// (acpProjectChat.ts). Same API, same store, same delivery; what differs is
// the SOURCE: an agent's whole inbox, or only what was posted in a project.
//
// Data: one page over REST, then live rows and activity from /ws/acp
// (acpLive.ts), applied by id; a (re)connect reloads the page; while the
// socket is down, a slow poll. Sending never waits for an agent: each message
// is persisted (201) and shows its own state while the agent works through
// its queue in order. DOM is built with textContent only.

import { acpLiveUp, subscribeAcp } from "./acpLive.js";
import {
	ACTIVITY_STATE,
	activityRows,
	authFromActivity,
	groupThread,
	recipientsOf,
	STATE_LABEL,
	type ThreadItem,
	upsert,
	who,
} from "./acpModel.js";
import {
	type AcpActivity,
	type AcpAgentInfo,
	type AcpFeed,
	type AcpMessage,
	acpFeed,
	acpListAgents,
	acpProjectFeed,
	acpRequeue,
	acpSend,
	uploadSessionFiles,
} from "./api.js";
import { el } from "./ui.js";

export type ThreadSource = { kind: "agent"; name: string } | { kind: "project"; projectId: string };

const PAGE = 100;
const FALLBACK_POLL_MS = 10_000;
const STATUS_MS = 15_000;

export interface ThreadState {
	agents: AcpAgentInfo[];
	auth: Map<string, boolean>;
	project: { id: string; name: string } | null;
	error: string;
}

export class AcpThread {
	readonly root = el("div", "acp-thread");
	private readonly threadEl = el("div", "acp-chat-thread");
	private readonly composer = el("form", "acp-chat-composer");
	private readonly mentionsEl = el("div", "acp-mentions");
	readonly input = el("textarea", "acp-chat-input");
	private readonly sendBtn = el("button", "files-btn acp-chat-send", "Enviar");
	private readonly hint = el("div", "acp-chat-hint");

	private source: ThreadSource | null = null;
	private gen = 0;
	private messages: AcpMessage[] = [];
	private hasEarlier = false;
	private maxBytes = 256 * 1024;
	private readonly activity = new Map<number, AcpActivity[]>();
	private readonly liveText = new Map<number, string>();
	private readonly openDetails = new Set<string>();
	private agents = new Map<string, AcpAgentInfo>();
	private readonly auth = new Map<string, boolean>();
	private project: { id: string; name: string } | null = null;
	private error = "";
	private sending = 0;
	private lastFailed: { text: string; clientId: string } | null = null;
	private unsubscribe: (() => void) | null = null;
	private poll: ReturnType<typeof setInterval> | null = null;
	private statusTimer: ReturnType<typeof setInterval> | null = null;
	private agentsTimer: ReturnType<typeof setTimeout> | null = null;
	private renderQueued = false;

	/** Called after every change of agents / auth / project / error (headers use it). */
	onState: (s: ThreadState) => void = () => {};

	constructor() {
		this.input.rows = 4;
		this.input.setAttribute("aria-label", "Mensaje");
		this.sendBtn.type = "submit";
		const actions = el("div", "acp-chat-actions");
		actions.append(this.hint, this.sendBtn);
		this.composer.append(this.mentionsEl, this.input, actions);
		this.root.append(this.threadEl, this.composer);
		this.composer.addEventListener("submit", (e) => {
			e.preventDefault();
			void this.send();
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				void this.send();
			}
		});
	}

	get state(): ThreadState {
		return {
			agents: [...this.agents.values()],
			auth: this.auth,
			project: this.project,
			error: this.error,
		};
	}

	/** Shows `source` (resets everything when it changes) and follows it live. */
	open(source: ThreadSource): void {
		const same =
			this.source !== null &&
			source.kind === this.source.kind &&
			(source.kind === "agent"
				? source.name === (this.source as { name: string }).name
				: source.projectId === (this.source as { projectId: string }).projectId);
		if (!same) {
			this.gen++;
			this.source = source;
			this.messages = [];
			this.hasEarlier = false;
			this.activity.clear();
			this.liveText.clear();
			this.openDetails.clear();
			this.agents.clear();
			this.auth.clear();
			this.project = null;
			this.error = "";
			this.lastFailed = null;
			this.threadEl.replaceChildren(el("div", "acp-chat-empty", "Cargando…"));
			this.input.placeholder =
				source.kind === "agent"
					? `Escribile a @${source.name}. Ctrl+Enter envía. Podés seguir enviando mientras trabaja.`
					: "Escribí al proyecto mencionando agentes (@nombre). Ctrl+Enter envía. Los mensajes se encolan si están ocupados.";
		}
		if (!this.unsubscribe) this.unsubscribe = subscribeAcp((ev) => this.onLive(ev));
		// Runner liveness and queue sizes are not pushed: re-read every 15 s while shown.
		if (!this.statusTimer)
			this.statusTimer = setInterval(() => {
				if (!document.hidden) this.refreshAgentsSoon(0);
			}, STATUS_MS);
		if (same) return;
		void this.reload();
	}

	/** Stops following (the DOM and state stay for a quick return). */
	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.stopPoll();
		if (this.statusTimer) clearInterval(this.statusTimer);
		this.statusTimer = null;
	}

	// ── Data ─────────────────────────────────────────────────────────────

	private async reload(): Promise<void> {
		const src = this.source;
		const gen = this.gen;
		if (!src) return;
		try {
			const feed =
				src.kind === "agent" ? await acpFeed(src.name) : await acpProjectFeed(src.projectId);
			if (gen !== this.gen) return;
			this.applyFeed(feed, false);
			this.error = "";
		} catch (err) {
			if (gen !== this.gen) return;
			const e = err as Error & { status?: number };
			this.error =
				e.status === 404
					? src.kind === "agent"
						? "Este agente ya no existe."
						: "Proyecto no encontrado."
					: `No se pudo actualizar: ${e.message}`;
		}
		this.changed();
	}

	private applyFeed(feed: AcpFeed, earlier: boolean): void {
		this.maxBytes = feed.maxMessageBytes;
		if (earlier) {
			const ids = new Set(this.messages.map((m) => m.id));
			this.messages = [...feed.messages.filter((m) => !ids.has(m.id)), ...this.messages];
		} else {
			// A reload keeps older pages already shown.
			const first = feed.messages[0]?.id ?? Number.POSITIVE_INFINITY;
			const older = this.messages.filter((m) => m.id < first);
			this.messages = [...older, ...feed.messages];
			if (!older.length) this.hasEarlier = feed.messages.length >= PAGE;
		}
		if (earlier) this.hasEarlier = feed.messages.length >= PAGE;
		const list = feed.agents ?? (feed.agent ? [feed.agent] : []);
		if (!earlier) {
			this.agents = new Map(list.map((a) => [a.name, a]));
			for (const a of list) this.auth.set(a.name, a.authRequired === true);
			this.activity.clear();
			this.liveText.clear();
			for (const [name, evs] of Object.entries(feed.activity ?? {})) this.addActivity(name, evs);
		}
		if (feed.project) this.project = feed.project;
	}

	private async loadEarlier(): Promise<void> {
		const src = this.source;
		const gen = this.gen;
		const first = this.messages[0]?.id;
		if (!src || !first) return;
		try {
			const feed =
				src.kind === "agent"
					? await acpFeed(src.name, first)
					: await acpProjectFeed(src.projectId, first);
			if (gen !== this.gen) return;
			this.applyFeed(feed, true);
		} catch (err) {
			this.error = `No se pudieron cargar los anteriores: ${(err as Error).message}`;
		}
		this.changed();
	}

	private relevant(m: AcpMessage): boolean {
		const src = this.source;
		if (!src) return false;
		return src.kind === "agent"
			? m.to_id === src.name || m.from_id === src.name
			: m.project_id === src.projectId;
	}

	private onLive(ev: Parameters<Parameters<typeof subscribeAcp>[0]>[0]): void {
		switch (ev.type) {
			case "open":
				this.stopPoll();
				void this.reload();
				return;
			case "down":
				this.startPoll();
				return;
			case "message":
				if (!this.relevant(ev.message)) return;
				if (this.messages.length && ev.message.id < this.messages[0]!.id && this.hasEarlier) return;
				this.messages = upsert(this.messages, ev.message);
				this.refreshAgentsSoon();
				this.changed();
				return;
			case "activity":
				if (!this.agents.has(ev.agent)) return;
				this.addActivity(ev.agent, ev.events);
				this.changed();
				return;
			case "agents":
				this.refreshAgentsSoon(0);
				return;
		}
	}

	private addActivity(agent: string, events: AcpActivity[]): void {
		for (const e of events) {
			const a = this.agents.get(agent);
			if (a) a.runnerSeenAt = e.at;
			if (e.messageId === null) continue;
			if (e.kind === "text") this.liveText.set(e.messageId, String(e.text ?? ""));
			else {
				const list = this.activity.get(e.messageId) ?? [];
				list.push(e);
				this.activity.set(e.messageId, list.slice(-200));
			}
		}
		this.auth.set(agent, authFromActivity(events, this.auth.get(agent) ?? false));
	}

	/** Agent status (running / queue / project membership): one list read, debounced. */
	private refreshAgentsSoon(delay = 800): void {
		if (this.agentsTimer) return;
		this.agentsTimer = setTimeout(() => {
			this.agentsTimer = null;
			const gen = this.gen;
			const src = this.source;
			void acpListAgents()
				.then((all) => {
					if (gen !== this.gen || !src) return;
					const mine =
						src.kind === "agent"
							? all.filter((a) => a.name === src.name)
							: all.filter((a) => a.projectId === src.projectId);
					const before = [...this.agents.keys()].join(" ");
					this.agents = new Map(mine.map((a) => [a.name, a]));
					for (const a of mine)
						if (a.authRequired !== undefined) this.auth.set(a.name, a.authRequired);
					// Someone joined or left Project Chat: its page changes too.
					if (src.kind === "project" && before !== mine.map((a) => a.name).join(" "))
						void this.reload();
					this.changed();
				})
				.catch(() => {});
		}, delay);
	}

	private startPoll(): void {
		if (this.poll) return;
		this.poll = setInterval(() => {
			if (!document.hidden && !acpLiveUp()) void this.reload();
		}, FALLBACK_POLL_MS);
	}

	private stopPoll(): void {
		if (this.poll) clearInterval(this.poll);
		this.poll = null;
	}

	// ── Rendering ───────────────────────────────────────────────────────

	private changed(): void {
		this.onState(this.state);
		if (this.renderQueued) return;
		this.renderQueued = true;
		requestAnimationFrame(() => {
			this.renderQueued = false;
			this.render();
		});
	}

	render(): void {
		const t = this.threadEl;
		const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 60;
		const prevHeight = t.scrollHeight;
		const prevTop = t.scrollTop;
		const nodes: HTMLElement[] = [];
		if (this.error) nodes.push(el("div", "acp-chat-error", this.error));
		if (this.hasEarlier) {
			const more = el("button", "files-btn acp-more", "Cargar anteriores");
			more.type = "button";
			more.addEventListener("click", () => {
				more.disabled = true;
				void this.loadEarlier();
			});
			nodes.push(more);
		}
		if (this.messages.length === 0)
			nodes.push(
				el(
					"div",
					"acp-chat-empty",
					this.source?.kind === "project"
						? "Sin mensajes en este proyecto todavía. Mencioná a un agente para empezar; cada agente procesa sus mensajes de a uno, en orden."
						: "Sin mensajes todavía. El agente procesa uno por vez, en orden.",
				),
			);
		for (const item of groupThread(this.messages)) nodes.push(this.itemEl(item));
		t.replaceChildren(...nodes);
		if (atBottom) t.scrollTop = t.scrollHeight;
		else if (prevTop < 5 && t.scrollHeight > prevHeight) t.scrollTop = t.scrollHeight - prevHeight;
		else t.scrollTop = prevTop;
		this.renderComposer();
	}

	private badge(m: AcpMessage): HTMLElement {
		const waitingLogin =
			this.auth.get(m.to_id) === true && (m.state === "pending" || m.state === "running");
		return el(
			"span",
			`acp-badge acp-badge-${waitingLogin ? "uncertain" : m.state}`,
			waitingLogin ? "esperando login" : (STATE_LABEL[m.state] ?? m.state),
		);
	}

	private scopeTag(m: AcpMessage): string {
		if (this.source?.kind !== "agent") return "";
		return m.project_id ? " · en el proyecto" : " · directo";
	}

	private collapsible(key: string, summary: string, text: string, cls: string): HTMLElement {
		const d = el("details", "acp-details");
		d.open = this.openDetails.has(key);
		d.addEventListener("toggle", () => {
			if (d.open) this.openDetails.add(key);
			else this.openDetails.delete(key);
		});
		d.append(el("summary", undefined, summary), el("pre", cls, text));
		return d;
	}

	private itemEl(item: ThreadItem): HTMLElement {
		if (item.kind === "post") {
			const first = item.messages[0]!;
			const art = el("article", "acp-msg acp-mine");
			const head = el("div", "acp-msg-head");
			head.append(
				el("span", "acp-msg-who", `Vos → ${item.messages.map((m) => `@${m.to_id}`).join(", ")}`),
				el("span", "acp-msg-time", time(first.created_at)),
			);
			art.append(head, el("pre", "acp-msg-body", item.body));
			for (const m of item.messages) {
				const sub = el("div", "acp-sub");
				const sh = el("div", "acp-msg-head");
				sh.append(el("span", "acp-msg-who", `#${m.id} @${m.to_id}`), this.badge(m));
				sub.append(sh, ...this.outcome(m));
				art.append(sub);
			}
			return art;
		}
		const m = item.message;
		const mine = m.from_id === "owner";
		const art = el(
			"article",
			`acp-msg acp-${m.state}${mine ? " acp-mine" : ""}${m.kind === "reply" ? " acp-reply" : ""}`,
		);
		const head = el("div", "acp-msg-head");
		const label =
			m.kind === "reply"
				? `#${m.id} ${who(m.to_id)} recibe la respuesta de ${who(m.from_id)} a #${m.reply_to}`
				: `#${m.id} ${who(m.from_id)} → ${who(m.to_id)}${m.from_id !== "owner" && m.from_id !== "system" ? " (consulta)" : ""}`;
		head.append(el("span", "acp-msg-who", `${label}${this.scopeTag(m)}`), this.badge(m));
		art.append(head);
		// A reply repeats the answer already shown under its request: kept folded.
		if (m.kind === "reply")
			art.append(
				this.collapsible(`b${m.id}`, "Ver la respuesta entregada", m.body, "acp-msg-body"),
			);
		else art.append(el("pre", "acp-msg-body", m.body));
		art.append(...this.outcome(m));
		return art;
	}

	/** Live activity while running, the result, the note, the requeue decision. */
	private outcome(m: AcpMessage): HTMLElement[] {
		const out: HTMLElement[] = [];
		if (m.state === "running" || m.state === "pending") {
			const rows = activityRows(this.activity.get(m.id) ?? []);
			if (rows.length) {
				const ul = el("ul", "acp-activity");
				for (const r of rows)
					ul.append(
						el(
							"li",
							`acp-act acp-act-${r.state || "pending"}`,
							`${r.label || "herramienta"}${r.detail ? ` · ${r.detail}` : ""} — ${ACTIVITY_STATE[r.state] ?? r.state ?? "…"}`,
						),
					);
				out.push(ul);
			}
			const live = this.liveText.get(m.id);
			if (live && m.state === "running") out.push(el("pre", "acp-msg-result acp-live", live));
		}
		if (m.result_text) {
			const res = el("pre", "acp-msg-result");
			res.textContent = m.result_text;
			out.push(res);
		}
		if (m.note && (m.state === "uncertain" || m.state === "failed"))
			out.push(el("div", "acp-msg-note", m.note));
		if (m.state === "uncertain") {
			const again = el("button", "files-btn", "Volver a encolar");
			again.type = "button";
			again.title =
				"La ejecución se interrumpió y no se repite sola: puede haber tenido efectos. Reencolar es decisión tuya.";
			again.addEventListener("click", () => {
				again.disabled = true;
				void acpRequeue(m.id)
					.then((row) => {
						this.messages = upsert(this.messages, row);
						this.changed();
					})
					.catch((err) => {
						this.error = (err as Error).message;
						this.changed();
					});
			});
			out.push(
				el(
					"div",
					"acp-msg-note",
					"Incierto: la ejecución se interrumpió. No se repite automáticamente.",
				),
				again,
			);
		}
		return out;
	}

	private renderComposer(): void {
		const src = this.source;
		const names = [...this.agents.keys()];
		this.mentionsEl.replaceChildren();
		if (src?.kind === "project" && names.length > 1) {
			for (const n of names) {
				const b = el("button", "acp-mention", `@${n}`);
				b.type = "button";
				b.title = `Mencionar a @${n}`;
				b.addEventListener("click", () => insertMention(this.input, n));
				this.mentionsEl.append(b);
			}
		}
		this.mentionsEl.hidden = this.mentionsEl.childElementCount === 0;
		const queued = this.messages.filter((m) => m.state === "pending").length;
		const running = this.messages.filter((m) => m.state === "running").length;
		this.hint.textContent = `${running ? `${running} en curso · ` : ""}${queued ? `${queued} en espera · ` : ""}límite ${Math.round(this.maxBytes / 1024)} KiB (más grande: adjunto)`;
	}

	// ── Sending ─────────────────────────────────────────────────────────

	private async send(): Promise<void> {
		const src = this.source;
		const text = this.input.value;
		if (!src || text.trim() === "") return;
		const names = [...this.agents.keys()];
		const to = src.kind === "agent" ? { to: [src.name], error: null } : recipientsOf(text, names);
		if (to.error) {
			this.error = to.error;
			this.changed();
			return;
		}
		// Same text again after a failure ⇒ same id: recipients that already got it are not sent twice.
		const clientId =
			this.lastFailed?.text === text ? this.lastFailed.clientId : crypto.randomUUID();
		// The field is free again at once; on a failure the text comes back if
		// it is still empty, so nothing typed is lost.
		this.input.value = "";
		this.sending++;
		this.sendBtn.textContent = this.sending > 1 ? `Enviando (${this.sending})…` : "Enviando…";
		const failed: string[] = [];
		try {
			const tooBig = new TextEncoder().encode(text).length > this.maxBytes;
			for (const name of to.to) {
				try {
					let body = text;
					if (tooBig) {
						const agent = this.agents.get(name);
						if (!agent) throw new Error(`@${name} desconocido`);
						const file = new File([text], `mensaje-${Date.now()}.md`, { type: "text/markdown" });
						const { paths } = await uploadSessionFiles(agent.sessionId, [file]);
						body = `Te envío un mensaje largo como adjunto (${file.size} bytes): ${paths[0]}\nLeelo completo y tratalo como el contenido de este mensaje.`;
					}
					const row = await acpSend(name, body, {
						...(src.kind === "project" ? { projectId: src.projectId } : {}),
						clientId,
					});
					if (this.source === src && this.relevant(row)) this.messages = upsert(this.messages, row);
				} catch (err) {
					failed.push(`@${name}: ${(err as Error).message}`);
				}
			}
			if (failed.length) {
				if (this.input.value === "") this.input.value = text;
				this.lastFailed = { text, clientId };
				this.error = `No se envió a ${failed.join("; ")}. El texto volvió al campo: enviarlo de nuevo no duplica a quienes ya lo recibieron.`;
			} else {
				this.lastFailed = null;
				this.error = "";
			}
		} finally {
			this.sending--;
			this.sendBtn.textContent = this.sending > 0 ? `Enviando (${this.sending})…` : "Enviar";
			this.refreshAgentsSoon(0);
			this.changed();
		}
	}
}

function insertMention(input: HTMLTextAreaElement, name: string): void {
	const start = input.selectionStart ?? input.value.length;
	const end = input.selectionEnd ?? start;
	const before = input.value.slice(0, start);
	const pad = before === "" || /\s$/.test(before) ? "" : " ";
	const ins = `${pad}@${name} `;
	input.value = before + ins + input.value.slice(end);
	const at = start + ins.length;
	input.setSelectionRange(at, at);
	input.focus();
}

function time(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
