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
	answerText,
	authFromActivity,
	groupThread,
	questionForm,
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
	type AcpQuestion,
	acpAnswer,
	acpFeed,
	acpListAgents,
	acpProjectFeed,
	acpRequeue,
	acpSend,
	uploadSessionFiles,
} from "./api.js";
import { markdownBlock } from "./chatMarkdown.js";
import { el, syncChildren } from "./ui.js";

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
	/**
	 * Per chat (sourceKey), the last send that did not reach every recipient:
	 * its text, why, and — for a retry — its client id AND the exact body each
	 * recipient was sent (a long message's attachment path). The server replays
	 * a retry only when sender, body and scope are identical, so retrying the
	 * same text, even after leaving the chat and coming back, never duplicates
	 * a message an ambiguous failure may already have stored. The text goes back
	 * into the field only when the field is empty (`restored`); over another
	 * draft it is offered with a button instead of overwriting it.
	 */
	private readonly unsent = new Map<
		string,
		{
			text: string;
			clientId: string;
			bodies: Map<string, string>;
			error: string;
			restored: boolean;
		}
	>();
	private readonly recoverBtn = el(
		"button",
		"files-btn acp-recover",
		"Recuperar el texto no enviado",
	);
	private unsubscribe: (() => void) | null = null;
	private poll: ReturnType<typeof setInterval> | null = null;
	private statusTimer: ReturnType<typeof setInterval> | null = null;
	private agentsTimer: ReturnType<typeof setTimeout> | null = null;
	private renderQueued = false;
	private questions = new Map<number, AcpQuestion>();
	/** Question cards kept across renders (keyed by id + state): typed answers and focus survive. */
	private readonly cards = new Map<number, { state: string; el: HTMLElement }>();
	/**
	 * Thread items kept across renders, keyed by message and rebuilt only when
	 * what they show changed. A live event (activity, a status poll) must not
	 * replace the rest of the thread: that cleared the reader's text selection
	 * and closed nothing but cost a full rebuild on every activity batch.
	 */
	private readonly items = new Map<string, { sig: string; el: HTMLElement }>();
	private readonly errorEl = el("div", "acp-chat-error");
	private readonly emptyEl = el("div", "acp-chat-empty");
	private readonly moreBtn = el("button", "files-btn acp-more", "Cargar anteriores");
	/** Unsent text per chat (agent or project): a draft never follows the person into another chat. */
	private readonly drafts = new Map<string, string>();
	/** The person just sent: show the bottom of the thread whatever the scroll position. */
	private toBottom = false;
	/**
	 * Rows and questions learned AFTER a page request left (live frames, the
	 * answers to a send / requeue / answer), stamped with a counter. A page is
	 * a snapshot taken when the server read it: whatever arrived after the
	 * request was sent is at least as new, so it is laid back over the page —
	 * a late REST answer never brings an older state back.
	 */
	private liveTick = 0;
	private readonly liveRows = new Map<number, { tick: number; row: AcpMessage }>();
	private readonly liveQuestions = new Map<number, { tick: number; q: AcpQuestion }>();

	/** Called after every change of agents / auth / project / error (headers use it). */
	onState: (s: ThreadState) => void = () => {};

	constructor() {
		this.input.rows = 4;
		this.input.setAttribute("aria-label", "Mensaje");
		this.sendBtn.type = "submit";
		const actions = el("div", "acp-chat-actions");
		this.recoverBtn.type = "button";
		this.recoverBtn.hidden = true;
		this.recoverBtn.addEventListener("click", () => {
			const u = this.source && this.unsent.get(sourceKey(this.source));
			if (!u) return;
			// Added after what is in the field, never instead of it.
			this.input.value = this.input.value.trim() ? `${this.input.value}\n\n${u.text}` : u.text;
			u.restored = true;
			this.input.focus();
			this.changed();
		});
		actions.append(this.hint, this.recoverBtn, this.sendBtn);
		// Errors sit by the field, not at the top of the thread: a refused send
		// must be seen where the person is looking, however long the thread.
		this.errorEl.setAttribute("role", "alert");
		this.errorEl.hidden = true;
		this.composer.append(this.errorEl, this.mentionsEl, this.input, actions);
		this.moreBtn.type = "button";
		this.moreBtn.addEventListener("click", () => {
			this.moreBtn.disabled = true;
			void this.loadEarlier();
		});
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
			if (this.source) this.saveDraft(this.source, this.input.value);
			this.source = source;
			this.input.value = this.drafts.get(sourceKey(source)) ?? "";
			this.items.clear();
			this.liveRows.clear();
			this.liveQuestions.clear();
			this.messages = [];
			this.hasEarlier = false;
			this.activity.clear();
			this.liveText.clear();
			this.openDetails.clear();
			this.questions.clear();
			this.cards.clear();
			this.agents.clear();
			this.auth.clear();
			this.project = null;
			this.error = "";
			this.offerUnsent();
			this.threadEl.replaceChildren(el("div", "acp-chat-empty", "Cargando…"));
			this.input.placeholder =
				source.kind === "agent"
					? `Escribile a @${source.name}. Ctrl+Enter envía. Podés seguir enviando mientras trabaja.`
					: "Empezá con el agente (@nombre) al que va dirigido. Ctrl+Enter envía. Los mensajes se encolan si está ocupado.";
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

	/** An agent's row as a write just answered it (e.g. its project changed here). */
	updateAgent(info: AcpAgentInfo): void {
		const prev = this.agents.get(info.name);
		if (!prev) return;
		this.agents.set(info.name, { ...prev, ...info });
		this.changed();
	}

	/** Stops following (the DOM and state stay for a quick return). */
	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.stopPoll();
		if (this.statusTimer) clearInterval(this.statusTimer);
		this.statusTimer = null;
	}

	private saveDraft(src: ThreadSource, text: string): void {
		if (text.trim() === "") this.drafts.delete(sourceKey(src));
		else this.drafts.set(sourceKey(src), text);
	}

	// ── Data ─────────────────────────────────────────────────────────────

	private async reload(): Promise<void> {
		const src = this.source;
		const gen = this.gen;
		if (!src) return;
		const mark = this.liveTick;
		try {
			const feed =
				src.kind === "agent" ? await acpFeed(src.name) : await acpProjectFeed(src.projectId);
			if (gen !== this.gen) return;
			this.applyFeed(feed, false);
			this.replayLive(mark);
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
		for (const q of feed.questions ?? []) this.questions.set(q.id, q);
	}

	private async loadEarlier(): Promise<void> {
		const src = this.source;
		const gen = this.gen;
		const first = this.messages[0]?.id;
		if (!src || !first) return;
		const mark = this.liveTick;
		try {
			const feed =
				src.kind === "agent"
					? await acpFeed(src.name, first)
					: await acpProjectFeed(src.projectId, first);
			if (gen !== this.gen) return;
			this.applyFeed(feed, true);
			this.replayLive(mark);
		} catch (err) {
			if (gen !== this.gen) return;
			this.error = `No se pudieron cargar los anteriores: ${(err as Error).message}`;
		}
		this.changed();
	}

	/** Notes a row or question that is newer than any page requested before now. */
	private noteLive(x: { row?: AcpMessage; q?: AcpQuestion }): void {
		const tick = ++this.liveTick;
		if (x.row) this.liveRows.set(x.row.id, { tick, row: x.row });
		if (x.q) this.liveQuestions.set(x.q.id, { tick, q: x.q });
		// Only the recent past matters (pages in flight): keep the maps small.
		for (const m of [this.liveRows, this.liveQuestions] as Map<number, { tick: number }>[])
			if (m.size > 300) for (const k of [...m.keys()].slice(0, m.size - 300)) m.delete(k);
	}

	/** Lays what arrived after `mark` back over a page that was requested at `mark`. */
	private replayLive(mark: number): void {
		const shownFrom = this.messages[0]?.id ?? Number.POSITIVE_INFINITY;
		for (const { tick, row } of this.liveRows.values())
			if (tick > mark && this.relevant(row) && (row.id >= shownFrom || !this.hasEarlier))
				this.messages = upsert(this.messages, row);
		for (const { tick, q } of this.liveQuestions.values())
			if (tick > mark) this.questions.set(q.id, q);
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
				this.noteLive({ row: ev.message });
				if (this.messages.length && ev.message.id < this.messages[0]!.id && this.hasEarlier) return;
				this.messages = upsert(this.messages, ev.message);
				this.refreshAgentsSoon();
				this.changed();
				return;
			case "question": {
				const q = ev.question;
				const src = this.source;
				const inScope =
					(q.message_id !== null && this.messages.some((m) => m.id === q.message_id)) ||
					(src?.kind === "agent" && q.agent === src.name);
				if (!inScope) return;
				this.noteLive({ q });
				this.questions.set(q.id, q);
				this.refreshAgentsSoon(0);
				this.changed();
				return;
			}
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
		const focused = document.activeElement as HTMLElement | null;
		const keepFocus =
			focused && t.contains(focused) && focused.closest(".acp-question") ? focused : null;
		const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 60;
		const prevHeight = t.scrollHeight;
		const prevTop = t.scrollTop;
		const nodes: HTMLElement[] = [];
		if (this.hasEarlier) {
			this.moreBtn.disabled = false;
			nodes.push(this.moreBtn);
		}
		if (this.messages.length === 0) {
			this.emptyEl.textContent =
				this.source?.kind === "project"
					? "Sin mensajes en este proyecto todavía. Mencioná a un agente para empezar; cada agente procesa sus mensajes de a uno, en orden."
					: "Sin mensajes todavía. El agente procesa uno por vez, en orden.";
			nodes.push(this.emptyEl);
		}
		const used = new Set<string>();
		for (const item of groupThread(this.messages)) {
			const first = item.kind === "post" ? item.messages[0]! : item.message;
			const key = `${item.kind}:${first.id}`;
			const sig = this.itemSig(item);
			let cached = this.items.get(key);
			if (cached?.sig !== sig) {
				cached = { sig, el: this.itemEl(item) };
				this.items.set(key, cached);
			}
			used.add(key);
			nodes.push(cached.el);
		}
		for (const key of [...this.items.keys()]) if (!used.has(key)) this.items.delete(key);
		// Questions whose message is not on this page (an older page, or none).
		const shown = new Set(this.messages.map((m) => m.id));
		for (const q of this.questions.values())
			if ((q.message_id === null || !shown.has(q.message_id)) && q.state === "open")
				nodes.push(this.questionEl(q));
		syncChildren(t, nodes);
		if (keepFocus?.isConnected) keepFocus.focus({ preventScroll: true });
		if (atBottom || this.toBottom) t.scrollTop = t.scrollHeight;
		else if (prevTop < 5 && t.scrollHeight > prevHeight) t.scrollTop = t.scrollHeight - prevHeight;
		else t.scrollTop = prevTop;
		this.toBottom = false;
		this.renderComposer();
	}

	/** Everything an item shows: equal ⇒ the element on screen is still right. */
	private itemSig(item: ThreadItem): string {
		const ms = item.kind === "post" ? item.messages : [item.message];
		return JSON.stringify([
			item.kind === "post" ? item.body : null,
			ms.map((m) => [
				m.id,
				m.state,
				m.kind,
				m.from_id,
				m.to_id,
				m.reply_to,
				m.project_id ?? null,
				m.body,
				m.result_text,
				m.note,
				this.auth.get(m.to_id) === true,
				[...this.questions.values()]
					.filter((q) => q.message_id === m.id)
					.map((q) => `${q.id}:${q.state}`),
				m.state === "running" || m.state === "pending"
					? activityRows(this.activity.get(m.id) ?? [])
					: null,
				m.state === "running" ? (this.liveText.get(m.id) ?? "") : null,
				m.finished_at,
				m.kind === "reply" && this.messages.some((x) => x.id === m.reply_to),
			]),
			this.source?.kind ?? null,
		]);
	}

	private openQuestionOf(id: number): boolean {
		for (const q of this.questions.values())
			if (q.message_id === id && q.state === "open") return true;
		return false;
	}

	private badge(m: AcpMessage): HTMLElement {
		if (m.state === "running" && this.openQuestionOf(m.id))
			return el("span", "acp-badge acp-badge-waiting", "esperando tu respuesta");
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

	private collapsible(key: string, summary: string, content: HTMLElement): HTMLElement {
		const d = el("details", "acp-details");
		d.open = this.openDetails.has(key);
		d.addEventListener("toggle", () => {
			if (d.open) this.openDetails.add(key);
			else this.openDetails.delete(key);
		});
		d.append(el("summary", undefined, summary), content);
		return d;
	}

	// A thread item is one TURN of the conversation (`article.acp-msg`, the keyed
	// element): what was said (the person's text on the right, an agent's consult
	// or a Shared Terminal note on the left), then one answer bubble per
	// recipient (`.acp-sub`) on the left, under the agent's name. The answer is
	// the message's own outcome (result, questions, live text), so the
	// correlation is structural: an answer always sits right under what it
	// answers, whatever arrives later in the thread.
	private itemEl(item: ThreadItem): HTMLElement {
		const ms = item.kind === "post" ? item.messages : [item.message];
		const first = ms[0]!;
		if (first.kind === "reply") return this.handoffEl(first);
		const mine = first.from_id === "owner";
		const sys = first.from_id === "system";
		const art = el(
			"article",
			`acp-msg acp-turn ${mine ? "acp-mine" : sys ? "acp-system" : "acp-consult"}`,
		);
		art.dataset.state = first.state;
		const said = el("div", `acp-bubble ${mine ? "acp-out" : "acp-in"}`);
		const head = el("div", "acp-msg-head");
		const to = ms.map((m) => who(m.to_id)).join(", ");
		if (mine || sys) {
			// In an agent's own chat its name on the person's bubble is noise; in
			// a project, or for a note, it says who was addressed.
			const showTo = !mine || this.source?.kind === "project" || ms.length > 1;
			head.append(
				el("span", "acp-msg-who", mine ? (showTo ? `Para ${to}` : "") : `Shared Terminal → ${to}`),
			);
		} else {
			// One agent writing to another speaks with its own face, like an
			// answer does: the author's identity, the addressee discreet.
			agentVoice(said, first.from_id);
			head.append(agentId(first.from_id), el("span", "acp-msg-to", `→ ${to}`));
		}
		head.append(el("span", "acp-msg-time", `${time(first.created_at)}${this.scopeTag(first)}`));
		said.append(head);
		said.append(mine ? el("pre", "acp-msg-body", first.body) : agentText(first.body));
		art.append(said);
		for (const m of ms) art.append(this.answerEl(m));
		return art;
	}

	/** The recipient's side of a message: its name, a discreet state, what it said. */
	private answerEl(m: AcpMessage): HTMLElement {
		const sub = el("div", `acp-sub acp-bubble acp-in acp-${m.state}`);
		agentVoice(sub, m.to_id);
		const head = el("div", "acp-msg-head");
		const name = agentId(m.to_id);
		const meta = el("span", "acp-msg-time", `#${m.id}`);
		meta.title = `Mensaje #${m.id}${m.finished_at ? ` · terminó ${time(m.finished_at)}` : ""}`;
		head.append(name, this.badge(m), meta);
		sub.append(head, ...this.outcome(m));
		return sub;
	}

	// The reply an agent RECEIVES to its consult repeats, word for word, the
	// answer already shown under the consult. When that consult is in the
	// thread, the delivery is one discreet line (the text one click away);
	// otherwise (an older page, another scope) it is the only place to read
	// it, so it is a bubble in the voice of the agent that answered.
	private handoffEl(m: AcpMessage): HTMLElement {
		const shown = m.reply_to !== null && this.messages.some((x) => x.id === m.reply_to);
		const art = el("article", "acp-msg acp-reply");
		art.dataset.state = m.state;
		if (shown) {
			const line = el("div", "acp-handoff");
			line.append(
				el(
					"div",
					"acp-msg-head",
					`↳ ${who(m.to_id)} recibe la respuesta de ${who(m.from_id)} a #${m.reply_to}`,
				),
				this.collapsible(`b${m.id}`, "Ver el texto entregado", agentText(m.body)),
			);
			art.append(line);
		} else {
			const said = el("div", "acp-bubble acp-in");
			agentVoice(said, m.from_id);
			const head = el("div", "acp-msg-head");
			head.append(
				agentId(m.from_id),
				el("span", "acp-msg-to", `→ ${who(m.to_id)} · respuesta a #${m.reply_to}`),
			);
			said.append(head, agentText(m.body));
			art.append(said);
		}
		// What the recipient makes of the reply is its own voice (m.to_id), in
		// its own answer bubble — never inside the folded line or the bubble of
		// the agent that answered.
		art.append(this.answerEl(m));
		return art;
	}

	/** Live activity while running, the result, the note, the requeue decision. */
	private outcome(m: AcpMessage): HTMLElement[] {
		const out: HTMLElement[] = [];
		for (const q of this.questions.values())
			if (q.message_id === m.id) out.push(this.questionEl(q));
		if (m.state === "running" || m.state === "pending") {
			const rows = activityRows(this.activity.get(m.id) ?? []);
			if (rows.length) {
				// Technical activity is folded: one line says what is going on now;
				// the list opens on demand (and stays open across live updates).
				const ul = el("ul", "acp-activity");
				for (const r of rows)
					ul.append(
						el(
							"li",
							`acp-act acp-act-${r.state || "pending"}`,
							`${r.label || "herramienta"}${r.detail ? ` · ${r.detail}` : ""} — ${ACTIVITY_STATE[r.state] ?? r.state ?? "…"}`,
						),
					);
				const last = rows[rows.length - 1]!;
				out.push(
					this.collapsible(
						`a${m.id}`,
						`Actividad (${rows.length}) · ${last.label || "herramienta"}`,
						ul,
					),
				);
			}
			const live = this.liveText.get(m.id);
			if (live && m.state === "running") out.push(el("pre", "acp-msg-result acp-live", live));
			else if (!rows.length && !m.result_text && !this.openQuestionOf(m.id))
				out.push(
					el(
						"div",
						"acp-typing",
						m.state === "pending" ? "En cola: lo toma cuando termine lo anterior." : "Trabajando…",
					),
				);
		}
		if (m.result_text) {
			const res = el("div", "acp-msg-result");
			res.append(markdownBlock(m.result_text));
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
				// The answer may land after the person moved to another chat: it
				// belongs to the chat it was asked from, never to the one on screen then.
				const gen = this.gen;
				void acpRequeue(m.id)
					.then((row) => {
						if (gen !== this.gen || !this.relevant(row)) return;
						this.noteLive({ row });
						this.messages = upsert(this.messages, row);
						this.changed();
					})
					.catch((err) => {
						if (gen !== this.gen) return;
						again.disabled = false;
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

	private questionEl(q: AcpQuestion): HTMLElement {
		const cached = this.cards.get(q.id);
		if (cached && cached.state === q.state) return cached.el;
		const form = questionForm(q.request);
		const card = el("section", `acp-question acp-question-${q.state}`);
		card.setAttribute("aria-label", `Pregunta de @${q.agent}`);
		card.append(el("div", "acp-question-head", `@${q.agent} pregunta`));
		if (form.message) card.append(el("p", "acp-question-text", form.message));
		if (q.state === "open") card.append(this.questionForm(q, form));
		else {
			const said = answerText(form, q.answer);
			const line =
				q.state === "answered"
					? `Tu respuesta: ${said} · entregándola al agente…`
					: q.state === "delivered"
						? `Tu respuesta: ${said}`
						: q.state === "withdrawn"
							? "El agente retiró la pregunta (ya no la necesita)."
							: `Sin entregar: ${q.note ?? "el agente se reinició"}.${said ? ` Tu respuesta (${said}) no se usó.` : ""}`;
			card.append(el("div", "acp-question-state", line));
			if (q.state === "orphaned") {
				// Continue safely: the person decides whether the agent gets the decision
				// again, as an ordinary message in its queue.
				const again = el("button", "files-btn", "Enviar la decisión como mensaje");
				again.type = "button";
				again.addEventListener("click", () => {
					const prefix = this.source?.kind === "project" ? `@${q.agent} ` : "";
					this.input.value = `${prefix}Sobre tu pregunta «${form.message}»: ${said && !said.startsWith("(") ? said : ""}`;
					this.input.focus();
				});
				card.append(again);
			}
		}
		this.cards.set(q.id, { state: q.state, el: card });
		return card;
	}

	private questionForm(q: AcpQuestion, form: ReturnType<typeof questionForm>): HTMLElement {
		const f = el("form", "acp-question-form");
		const read: Array<() => [string, unknown] | null> = [];
		form.fields.forEach((field, i) => {
			const box = el("fieldset", "acp-question-field");
			if (field.label) box.append(el("legend", undefined, field.label));
			const name = `q${q.id}-${i}`;
			if (field.kind === "single" || field.kind === "multi") {
				const inputs: HTMLInputElement[] = [];
				for (const o of field.options) {
					const lab = el("label", "acp-option");
					const inp = el("input");
					inp.type = field.kind === "single" ? "radio" : "checkbox";
					inp.name = name;
					inp.value = o.value;
					inputs.push(inp);
					lab.append(inp, el("span", undefined, o.label));
					if (o.description) lab.append(el("small", undefined, ` — ${o.description}`));
					box.append(lab);
				}
				read.push(() => {
					const picked = inputs.filter((x) => x.checked).map((x) => x.value);
					if (field.kind === "multi") return picked.length ? [field.key, picked] : null;
					return picked[0] !== undefined ? [field.key, picked[0]] : null;
				});
			} else if (field.kind === "boolean") {
				const lab = el("label", "acp-option");
				const inp = el("input");
				inp.type = "checkbox";
				lab.append(inp, el("span", undefined, "Sí"));
				box.append(lab);
				read.push(() => [field.key, inp.checked]);
			} else {
				const inp = el("textarea", "acp-question-input");
				inp.rows = 2;
				inp.setAttribute("aria-label", field.label || form.message || "Respuesta");
				box.append(inp);
				read.push(() => {
					const v = inp.value.trim();
					if (!v) return null;
					return [field.key, field.kind === "number" ? Number(v) : v];
				});
			}
			if (field.custom) {
				const other = el("input", "acp-question-other");
				other.type = "text";
				other.placeholder = "Otra respuesta o nota (opcional)";
				other.setAttribute("aria-label", "Otra respuesta");
				box.append(other);
				const key = field.custom;
				read.push(() => (other.value.trim() ? [key, other.value.trim()] : null));
			}
			f.append(box);
		});
		const actions = el("div", "acp-question-actions");
		const send = el("button", "files-btn acp-question-send", "Responder");
		send.type = "submit";
		const skip = el("button", "files-btn", "Omitir");
		skip.type = "button";
		const status = el("span", "acp-chat-hint");
		actions.append(send, skip, status);
		f.append(actions);
		const submit = (body: { action: "accept" | "decline"; content?: Record<string, unknown> }) => {
			send.disabled = skip.disabled = true;
			status.textContent = "Enviando…";
			const gen = this.gen;
			void acpAnswer(q.id, body)
				.then((row) => {
					if (gen !== this.gen) return;
					this.noteLive({ q: row });
					this.questions.set(row.id, row);
					this.changed();
				})
				.catch((err: Error & { status?: number }) => {
					// 409: someone (another tab) answered first, or the agent restarted.
					status.textContent =
						err.status === 409
							? "Ya no está abierta; se actualiza sola."
							: `No se envió: ${err.message}`;
					send.disabled = skip.disabled = err.status === 409;
				});
		};
		f.addEventListener("submit", (e) => {
			e.preventDefault();
			const content = Object.fromEntries(
				read.map((g) => g()).filter((x): x is [string, unknown] => x !== null),
			);
			submit({ action: "accept", content });
		});
		skip.addEventListener("click", () => submit({ action: "decline" }));
		return f;
	}

	/** This chat's unsent text goes back into the field, if the field is empty. */
	private offerUnsent(): void {
		const u = this.source && this.unsent.get(sourceKey(this.source));
		if (!u || u.restored || this.input.value.trim() !== "") return;
		this.input.value = u.text;
		u.restored = true;
	}

	private renderComposer(): void {
		const u = this.source ? this.unsent.get(sourceKey(this.source)) : undefined;
		const shown = [this.error, u?.error ?? ""].filter(Boolean).join(" ");
		this.errorEl.textContent = shown;
		this.errorEl.hidden = shown === "";
		this.recoverBtn.hidden = !u || u.restored;
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
		// Reserve this send BEFORE any await: the text leaves the field and gets
		// its client id now, so a second click (or Ctrl+Enter) on the same draft
		// finds an empty field and sends nothing. A new message typed meanwhile is
		// a new send, as always. Same text again after a failure ⇒ same id:
		// recipients that already got it are not sent twice.
		const key = sourceKey(src);
		const prev = this.unsent.get(key);
		const retry = prev?.text === text ? prev : null;
		const clientId = retry?.clientId ?? crypto.randomUUID();
		const bodies = retry?.bodies ?? new Map<string, string>();
		this.input.value = "";
		this.drafts.delete(sourceKey(src));
		// A send that did not go out gives its text back to ITS chat: into the
		// field if that chat is on screen and the field is empty; otherwise it
		// waits (with its error) for the person to come back, and over another
		// draft it is offered, never written over it.
		const giveBack = (error: string) => {
			this.unsent.set(key, { text, clientId, bodies, error, restored: false });
			if (sameChat(this.source, src)) this.offerUnsent();
		};
		// Sent before the page arrived (slow link, a phone): who is in the project
		// is not known yet — load it instead of refusing the message.
		if (this.agents.size === 0) await this.reload();
		if (!sameChat(this.source, src)) {
			giveBack("No se envió: cambiaste de conversación antes de que cargara.");
			return;
		}
		const names = [...this.agents.keys()];
		const to = src.kind === "agent" ? { to: [src.name], error: null } : recipientsOf(text, names);
		if (to.error) {
			giveBack(to.error);
			this.changed();
			return;
		}
		this.toBottom = true;
		this.sending++;
		this.sendBtn.textContent = this.sending > 1 ? `Enviando (${this.sending})…` : "Enviando…";
		const failed: string[] = [];
		try {
			const tooBig = new TextEncoder().encode(text).length > this.maxBytes;
			for (const name of to.to) {
				try {
					let body = bodies.get(name) ?? text;
					if (tooBig && !bodies.has(name)) {
						const agent = this.agents.get(name);
						if (!agent) throw new Error(`@${name} desconocido`);
						const file = new File([text], `mensaje-${Date.now()}.md`, { type: "text/markdown" });
						const { paths } = await uploadSessionFiles(agent.sessionId, [file]);
						body = `Te envío un mensaje largo como adjunto (${file.size} bytes): ${paths[0]}\nLeelo completo y tratalo como el contenido de este mensaje.`;
						bodies.set(name, body);
					}
					const row = await acpSend(name, body, {
						...(src.kind === "project" ? { projectId: src.projectId } : {}),
						clientId,
					});
					if (sameChat(this.source, src) && this.relevant(row)) {
						this.noteLive({ row });
						this.messages = upsert(this.messages, row);
					}
				} catch (err) {
					failed.push(`@${name}: ${(err as Error).message}`);
				}
			}
			// The person may have moved to another chat meanwhile: nothing of this
			// send is shown there; it is kept for THIS chat (giveBack).
			if (failed.length)
				giveBack(
					`No se envió a ${failed.join("; ")}. Enviar el mismo texto de nuevo no duplica a quienes ya lo recibieron.`,
				);
			else {
				// Sent: its failure record (if this was its retry, or it was taken
				// back into the field) is done; an unsent text not yet taken back stays offered.
				const u = this.unsent.get(key);
				if (u && (u.clientId === clientId || u.restored)) this.unsent.delete(key);
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

/** A stable hue per agent name, so each agent keeps its colour across chats. */
function hue(name: string): number {
	let h = 0;
	for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
	return h;
}

/** An agent's name with its avatar, in its colour: the same face wherever it speaks. */
function agentId(name: string): HTMLElement {
	const id = el("span", "acp-msg-who acp-agent-id");
	id.append(el("span", "acp-avatar", name.slice(0, 1).toUpperCase()), `@${name}`);
	id.style.setProperty("--acp-hue", String(hue(name)));
	return id;
}

/** Marks a bubble as said by that agent (its colour accent, see .acp-voice). */
function agentVoice(bubble: HTMLElement, name: string): void {
	bubble.classList.add("acp-voice");
	bubble.style.setProperty("--acp-hue", String(hue(name)));
}

function sourceKey(src: ThreadSource): string {
	return src.kind === "agent" ? `a:${src.name}` : `p:${src.projectId}`;
}

/** An agent's text (its answer, a consult, a system note): Markdown, like the capture Chat. */
function agentText(text: string): HTMLElement {
	const box = el("div", "acp-msg-body acp-md");
	box.append(markdownBlock(text));
	return box;
}

/** Same chat, whatever object `open()` was given (a return to it creates a new one). */
function sameChat(a: ThreadSource | null, b: ThreadSource): boolean {
	return a !== null && sourceKey(a) === sourceKey(b);
}
