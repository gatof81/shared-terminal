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
	agentStatus,
	answerText,
	applyEdits,
	authFromActivity,
	groupThread,
	mapThroughEdits,
	questionForm,
	recipientRow,
	recipientsOf,
	STATE_LABEL,
	setRecipient,
	type ThreadItem,
	upsert,
	who,
} from "./acpModel.js";
import { acpReadTicket, setAcpAgents } from "./acpRegistry.js";
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
import { ChatEndButton, END_SLACK, firstRowInView } from "./chatScroll.js";
import { fromHistory } from "./router.js";
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
	/**
	 * This chat's first-page reads: none answered yet, answered, 404, failed
	 * before any good read (`error`) or failed after one (`stale`: what is
	 * shown is still that chat's history, just not refreshed).
	 */
	feed: FeedStatus;
}

export type FeedStatus = "loading" | "ok" | "not-found" | "error" | "stale";

/** What the message box allows: write, shown but locked, or not shown at all. */
export type ComposerMode = "on" | "disabled" | "off";

export class AcpThread {
	readonly root = el("div", "acp-thread");
	private readonly threadEl = el("div", "acp-chat-thread");
	private readonly composer = el("form", "acp-chat-composer");
	/**
	 * The message box: ONE surface (border, radius, the focus ring) laid out
	 * as a grid `[+] [field] [arrow]`, aligned at the bottom — the buttons
	 * stay by the last line, where the caret is, at any height (acp-chat.css).
	 */
	private readonly surface = el("div", "acp-chat-field");
	readonly input = el("textarea", "acp-chat-input");
	/** The arrow, the surface's last cell; a spinner while a send is out and the field is empty. */
	private readonly sendBtn = el("button", "acp-chat-send acp-cbtn");
	/** Project Chat with more than one agent: "+" opens the recipients menu. */
	private readonly pickBtn = el("button", "acp-pick-btn acp-cbtn");
	/**
	 * One line above the surface, only when it has something to say: who a
	 * Project Chat message goes to ("Para @a · @b": what recipientsOf will
	 * send — the leading mentions may be out of view in a long text) and the
	 * notices (sending, the queue, the size). Never two rows.
	 */
	private readonly toLine = el("div", "acp-chat-hint");
	/** The menu's box (positioned over the thread): a note, then the menu itself. */
	private readonly pickMenu = el("div", "acp-pick-menu");
	private readonly pickList = el("div", "acp-pick-list");
	/** Why nobody is checked: an unknown leading mention (recipientsOf's error). */
	private readonly pickNote = el("p", "acp-pick-note");
	/** Read by a screen reader: "Enviando…", then "Enviado a @a, @b" (not the queue line). */
	private readonly sendStatus = el("div", "visually-hidden");
	/**
	 * "Ir al final" (chatScroll.ts), with the count of `newIds`: rows that
	 * arrived, or got their answer, below a reader who is further up. Each
	 * row counts once (a Set of ids).
	 */
	private readonly endBtn = new ChatEndButton({
		scroller: () => this.threadEl,
		name: (n) => (n === 0 ? "Ir al final" : `Ir al final, ${newText(n)}`),
		onJumped: () => {
			this.atBottom = true;
			this.newIds.clear();
		},
		// A question's options are the person's to tap: never under the button.
		avoid: () => this.threadEl.querySelectorAll(".acp-question-open"),
	});
	/** Says it to a screen reader too (the button itself appears and goes). */
	private readonly newAnnounce = el("div", "visually-hidden");
	private readonly newIds = new Set<number>();
	/** Highest message id the last render showed (new ones are above it). */
	private shownMax = 0;
	/**
	 * Per row shown, its outcome as last rendered: a final state and whether
	 * it has an answer. A change there is news; live activity and the partial
	 * text of a running message are not (they would make the pill blink).
	 */
	private readonly shownOutcome = new Map<number, string>();
	/**
	 * Whether the reader is at the end of the thread, kept by scroll events.
	 * The thread's height also changes WITHOUT a scroll event (the keyboard,
	 * the field growing, a rotation): the last scroll's answer is the truth
	 * then, a geometry read after the shrink would not be.
	 */
	private atBottom = true;
	/** The thread's clientHeight when last seen by a scroll / resize observation. */
	private box = 0;

	private source: ThreadSource | null = null;
	/**
	 * A chat was (re)opened: once its feed is read it shows its end, or — when
	 * the opening was Back / Forward (`placeFromHistory`) — its reading place.
	 */
	private placePending = false;
	private placeFromHistory = false;
	private anchorFrame = 0;
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
	/**
	 * `error` is the feed's own read failure (not an earlier page or a send).
	 * Project Chat's page header already says it, with Reintentar
	 * (projectsView statusNote): the message box does not repeat it there.
	 */
	private errorIsFeed = false;
	private feed: FeedStatus = "loading";
	/** A first page of the current chat was read at least once. */
	private readOnce = false;
	private composerMode: ComposerMode = "on";
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
	private readonly recoverBtn = el("button", "files-btn acp-recover", "Recuperar el texto");
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
		// One line at rest (CSS); fitInput() grows it with the text up to a cap.
		this.input.rows = 1;
		this.input.setAttribute("aria-label", "Mensaje");
		this.sendBtn.type = "submit";
		this.sendBtn.setAttribute("aria-label", "Enviar");
		this.sendBtn.title = "Enviar (Ctrl+Enter)";
		// Each button is its 44-px cell; what is seen is a 30-px circle inside.
		this.sendBtn.append(el("span", "acp-cbtn-face"));
		this.sendBtn.firstElementChild!.append(sendIcon(), el("span", "acp-send-spin"));
		this.pickBtn.append(el("span", "acp-cbtn-face", "+"));
		this.buildPicker();
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
		this.toLine.hidden = true;
		// The menu opens upward from the surface (positioned on it, out of the grid).
		this.surface.append(this.pickBtn, this.input, this.sendBtn, this.pickMenu);
		// Errors sit by the field, not at the top of the thread: a refused send
		// must be seen where the person is looking, however long the thread.
		// Under the surface, with "Recuperar el texto" next to the words.
		this.errorEl.setAttribute("role", "alert");
		this.errorEl.hidden = true;
		const errorLine = el("div", "acp-chat-actions");
		errorLine.append(this.errorEl, this.recoverBtn);
		this.sendStatus.setAttribute("role", "status");
		this.sendStatus.setAttribute("aria-live", "polite");
		this.composer.append(this.toLine, this.surface, errorLine, this.sendStatus);
		// A tap on Enviar, a mention or "↓ N nuevos" must not take the focus from the field:
		// on a phone that blur closes the keyboard, the layout grows back (the
		// bottom bar returns) and the button moves away under the finger before
		// the tap lands. Keyboard activation does not go through these events.
		for (const b of [this.sendBtn, this.pickBtn, this.pickMenu, this.endBtn.el])
			for (const type of ["pointerdown", "mousedown"] as const)
				b.addEventListener(type, (e) => {
					if (document.activeElement === this.input) e.preventDefault();
				});
		this.input.addEventListener("input", () => {
			this.fitInput();
			this.renderHint();
			this.syncSendBtn();
			// What is written by hand shows in the menu as it is typed.
			if (this.pickOpen) this.renderPicker();
		});
		this.newAnnounce.setAttribute("role", "status");
		this.newAnnounce.setAttribute("aria-live", "polite");
		const wrap = el("div", "acp-thread-wrap");
		wrap.append(this.threadEl, this.endBtn.el, this.newAnnounce);
		this.threadEl.addEventListener(
			"scroll",
			() => {
				const t = this.threadEl;
				// Hidden (the chat's overlay closed: a link followed, another
				// view): a scroll of a box with no height says nothing about the reader.
				if (t.clientHeight === 0) return;
				// The box changed since the last look (keyboard, the field growing,
				// a rotation): this scroll is the layout's, not the reader's — a
				// reader at the end is pinned there, not reclassified as "above".
				if (t.clientHeight !== this.box) {
					this.box = t.clientHeight;
					if (this.atBottom) {
						t.scrollTop = t.scrollHeight;
						return;
					}
				}
				const away = t.scrollHeight - t.scrollTop - t.clientHeight;
				// "Ir al final" scrolling smoothly: its own steps are not the reader moving up.
				if (this.endBtn.jumping) {
					this.atBottom = true;
					if (away < END_SLACK) this.renderPill();
					return;
				}
				this.atBottom = away < END_SLACK;
				if (this.atBottom) this.clearNew();
				else this.renderPill();
				if (!this.anchorFrame)
					this.anchorFrame = requestAnimationFrame(() => {
						this.anchorFrame = 0;
						this.noteAnchor();
					});
			},
			{ passive: true },
		);
		// The thread's box changes without a scroll event too: a reader at the
		// end stays at the end; one reading further up keeps scrollTop, i.e.
		// the same text in view.
		if (typeof ResizeObserver !== "undefined")
			new ResizeObserver(() => {
				const t = this.threadEl;
				const wasHidden = this.box === 0;
				this.box = t.clientHeight;
				if (t.clientHeight === 0) return;
				// Shown again: the box was rebuilt, its scroll offset is not to be
				// trusted. Back / Forward (from a followed link to the same chat)
				// puts the reading place back; any other way in shows the end.
				if (wasHidden && !this.placePending) {
					if (fromHistory()) this.restorePlace();
					else this.scrollToEnd();
				} else if (this.atBottom) t.scrollTop = t.scrollHeight;
				this.renderPill();
			}).observe(this.threadEl);
		// The field's cap depends on the visible height (keyboard, rotation).
		window.visualViewport?.addEventListener("resize", () => this.fitInput());
		window.addEventListener("resize", () => this.fitInput());
		this.moreBtn.type = "button";
		this.moreBtn.addEventListener("click", () => {
			this.moreBtn.disabled = true;
			void this.loadEarlier();
		});
		this.root.append(wrap, this.composer);
		// send() empties the field before its first await; the field goes back
		// to its resting height now, not when the network answers.
		this.composer.addEventListener("submit", (e) => {
			e.preventDefault();
			void this.send();
			this.fitInput();
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				void this.send();
				this.fitInput();
			}
		});
	}

	get state(): ThreadState {
		return {
			agents: [...this.agents.values()],
			auth: this.auth,
			project: this.project,
			error: this.error,
			feed: this.feed,
		};
	}

	/**
	 * Lock or hide the message box (the project page keeps it locked until the
	 * project is confirmed live). Nothing leaves while it is not "on" — not by
	 * the button, Ctrl+Enter or a restored draft — and the draft stays in the
	 * field. Errors (e.g. "Cargar anteriores") stay visible either way.
	 */
	setComposer(mode: ComposerMode): void {
		if (mode === this.composerMode) return;
		this.composerMode = mode;
		this.renderComposer();
	}

	/** Read the current chat again (a "Reintentar"). */
	retry(): void {
		void this.reload();
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
			this.closePicker(false);
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
			this.errorIsFeed = false;
			this.feed = "loading";
			this.readOnce = false;
			this.atBottom = true;
			// Its end, or (Back / Forward) where it was being read, once its feed is in.
			this.placePending = true;
			this.placeFromHistory = fromHistory();
			this.shownMax = 0;
			this.shownOutcome.clear();
			this.newIds.clear();
			this.endBtn.reset();
			this.offerUnsent();
			this.threadEl.replaceChildren(el("div", "acp-chat-empty", "Cargando…"));
			this.setPlaceholder();
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
		this.closePicker(false);
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
			this.errorIsFeed = false;
			this.feed = "ok";
			this.readOnce = true;
			if (this.placePending) {
				this.placePending = false;
				// The rows first: the render `applyFeed` asked for waits for the
				// next frame, and the anchor's row must be on the page now (a
				// return from ANOTHER chat left this one with only "Cargando…").
				// Placed in that same task: no frame shows the thread elsewhere.
				this.render();
				if (this.placeFromHistory) this.restorePlace();
				else this.scrollToEnd();
			}
		} catch (err) {
			if (gen !== this.gen) return;
			this.placePending = false;
			const e = err as Error & { status?: number };
			// A re-read that fails (a reconnect, the fallback poll, a flaky
			// link) must not take away a history already read: `stale`.
			this.feed = e.status === 404 ? "not-found" : this.readOnce ? "stale" : "error";
			this.errorIsFeed = true;
			this.error =
				e.status === 404
					? src.kind === "agent"
						? "Este agente ya no existe."
						: "Proyecto no encontrado."
					: // Fixed text: the server's message is a code ("internal"), not words for a person.
						"No se pudo actualizar el chat.";
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
		} catch {
			if (gen !== this.gen) return;
			this.error = "No se pudieron cargar los anteriores.";
			this.errorIsFeed = false;
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
			const ticket = acpReadTicket();
			void acpListAgents()
				.then((all) => {
					// Every read of the list keeps the one registry current (sidebar).
					setAcpAgents(all, ticket);
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
		const atBottom = this.atBottom;
		const prevTop = t.scrollTop;
		// A reader further up keeps the row they are looking at where it is,
		// whatever changes above or below it (an earlier page, an answer, a
		// question card): by that row, never by scrollTop or the distance to the end.
		const keep = atBottom || this.toBottom ? null : this.rowInView();
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
			// The reading anchor's handle (noteAnchor / restorePlace).
			cached.el.dataset.anchor = key;
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
		const end = atBottom || this.toBottom;
		if (end) t.scrollTop = t.scrollHeight;
		else if (!keep || !this.putRow(keep)) t.scrollTop = prevTop;
		this.toBottom = false;
		// News below a reader who is further up: a new row (an id above what
		// was shown — an earlier page has lower ids), or a row already shown
		// that got its answer or finished.
		const before = this.newIds.size;
		for (const m of this.messages) {
			const outcome = `${FINAL.has(m.state) ? m.state : ""}|${m.result_text ? "r" : ""}`;
			const prev = this.shownOutcome.get(m.id);
			if (!end && this.shownMax > 0) {
				if (prev === undefined ? m.id > this.shownMax : prev !== outcome && outcome !== "|")
					this.newIds.add(m.id);
			}
			this.shownOutcome.set(m.id, outcome);
		}
		if (end) {
			this.atBottom = true;
			this.clearNew();
		}
		this.shownMax = Math.max(this.shownMax, this.messages.at(-1)?.id ?? 0);
		this.renderPill();
		if (this.newIds.size > before) this.newAnnounce.textContent = `${this.pillText()} más abajo`;
		this.renderComposer();
	}

	private pillText(): string {
		return newText(this.newIds.size);
	}

	private renderPill(): void {
		this.endBtn.sync(this.newIds.size, this.atBottom);
	}

	private clearNew(): void {
		this.newIds.clear();
		this.renderPill();
	}

	/**
	 * Remembers where this chat is being read, by its first row in view and
	 * that row's offset — never by distance to the end, which new rows below
	 * change (the capture Chat's read anchor, chatView.ts). A reader at the
	 * end has no anchor: they come back to the end.
	 */
	private noteAnchor(): void {
		const t = this.threadEl;
		if (!this.source || this.placePending || this.feed === "loading" || t.clientHeight === 0)
			return;
		const key = sourceKey(this.source);
		if (this.atBottom) {
			readingPlaces.delete(key);
			return;
		}
		const place = this.rowInView();
		if (place) readingPlaces.set(key, place);
	}

	/** The first row at least partly in view, and its top edge's offset from the thread's. */
	private rowInView(): ReadingPlace | null {
		const t = this.threadEl;
		if (t.clientHeight === 0) return null;
		const hit = firstRowInView(t, (c) => c.dataset.anchor !== undefined);
		return hit ? { anchor: hit.row.dataset.anchor!, offset: hit.offset } : null;
	}

	/** Puts `place`'s row back at its offset; false when that row is not shown. */
	private putRow(place: ReadingPlace): boolean {
		const t = this.threadEl;
		const row = [...t.children].find((c) => (c as HTMLElement).dataset?.anchor === place.anchor);
		if (!row) return false;
		t.scrollTop += row.getBoundingClientRect().top - t.getBoundingClientRect().top - place.offset;
		return true;
	}

	/** Back to this chat's anchor; with none (or its row no longer shown), the end. */
	private restorePlace(): void {
		const t = this.threadEl;
		const place = this.source ? readingPlaces.get(sourceKey(this.source)) : undefined;
		if (!place || !this.putRow(place)) {
			this.scrollToEnd();
			return;
		}
		this.box = t.clientHeight;
		this.atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < END_SLACK;
		this.renderPill();
	}

	private scrollToEnd(): void {
		const t = this.threadEl;
		this.atBottom = true;
		t.scrollTop = t.scrollHeight;
		// The box it was placed in, now: the scroll handler takes a scroll in a
		// box of another height for the layout's and pins the end. Left to the
		// ResizeObserver's first frame, a reader scrolling at once was pulled back.
		if (t.clientHeight > 0) this.box = t.clientHeight;
		this.clearNew();
	}

	/**
	 * The field grows with its text — up to 8 lines on a desktop, up to 30 %
	 * of the visible height on a phone (the keyboard shrinks it) — then
	 * scrolls inside; emptied, it is back to its resting line. Only the field
	 * grows: the buttons sit at the bottom of the surface's grid.
	 */
	private fitInput(): void {
		const i = this.input;
		if (!i.isConnected) return;
		this.setPlaceholder();
		// Empty: the resting height. Chromium counts a placeholder's wrapped
		// lines in scrollHeight, so measuring would grow the field for it.
		if (i.value === "") {
			i.style.height = "";
			i.style.overflowY = "";
			return;
		}
		const cs = getComputedStyle(i);
		const line = Number.parseFloat(cs.lineHeight) || 20;
		const border = Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
		const frame = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom) + border;
		const visible = window.visualViewport?.height ?? window.innerHeight;
		const phone = window.matchMedia?.("(max-width: 640px)").matches === true;
		const lines = 8 * line + frame;
		const cap = Math.max(line + frame, phone ? Math.min(lines, visible * 0.3) : lines);
		i.style.height = "auto";
		const want = i.scrollHeight + border;
		i.style.height = `${Math.min(want, cap)}px`;
		i.style.overflowY = want > cap + 1 ? "auto" : "hidden";
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
						this.errorIsFeed = false;
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
					this.fitInput();
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
		const own = this.errorIsFeed && this.source?.kind === "project" ? "" : this.error;
		const shown = [own, u?.error ?? ""].filter(Boolean).join(" ");
		this.errorEl.textContent = shown;
		this.errorEl.hidden = shown === "";
		this.recoverBtn.hidden = !u || u.restored || this.composerMode !== "on";
		const writable = this.composerMode === "on";
		this.input.disabled = !writable;
		this.syncSendBtn();
		this.composer.classList.toggle("acp-composer-off", this.composerMode === "off");
		const picks = writable && this.source?.kind === "project" && this.agents.size > 1;
		this.pickBtn.hidden = !picks;
		// The surface's states (acp-chat.css): no "+" column, a refused send, locked.
		this.surface.classList.toggle("no-plus", !picks);
		this.surface.classList.toggle("is-error", Boolean(u?.error));
		this.surface.classList.toggle("is-disabled", !writable);
		if (!picks) this.closePicker(false);
		else if (this.pickOpen) this.renderPicker();
		this.renderHint();
		this.fitInput();
	}

	/** The arrow: off when nothing can be sent (still on while another send is out). */
	private syncSendBtn(): void {
		const empty = this.input.value.trim() === "";
		this.sendBtn.disabled = this.composerMode !== "on" || empty;
		this.surface.classList.toggle("has-text", !empty);
	}

	// ── Recipients menu ("+") ───────────────────────────────────────────
	//
	// Edits ONLY the leading @mentions of the text (acpModel.setRecipient):
	// what it shows checked is always recipientsOf(text).to. A small menu of
	// its own, not openActionMenu (a modal that takes the focus): opened by a
	// tap while typing, it must leave the focus — and a phone's keyboard —
	// in the field.

	private pickOpen = false;
	/** "+" activated from the keyboard (Enter / Space on it): the focus goes into the menu. */
	private pickByKey = false;

	private buildPicker(): void {
		const id = `acp-pick-${++pickerSeq}`;
		this.pickList.id = id;
		this.pickList.setAttribute("role", "menu");
		this.pickList.setAttribute("aria-label", "Destinatarios");
		this.pickNote.id = `${id}-note`;
		this.pickNote.hidden = true;
		this.pickMenu.append(this.pickNote, this.pickList);
		this.pickMenu.hidden = true;
		// Not from the click's `detail`: a real touch tap arrives with detail 0
		// too, and moving the focus off the field closes a phone's keyboard.
		this.pickBtn.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") this.pickByKey = true;
		});
		this.pickBtn.addEventListener("pointerdown", () => {
			this.pickByKey = false;
		});
		this.pickBtn.type = "button";
		this.pickBtn.hidden = true;
		this.pickBtn.setAttribute("aria-label", "Elegir destinatarios");
		this.pickBtn.title = "Elegir destinatarios";
		this.pickBtn.setAttribute("aria-haspopup", "menu");
		this.pickBtn.setAttribute("aria-expanded", "false");
		this.pickBtn.setAttribute("aria-controls", id);
		this.pickBtn.addEventListener("click", () => {
			const byKey = this.pickByKey;
			this.pickByKey = false;
			if (this.pickOpen) {
				this.closePicker(false);
				return;
			}
			this.pickOpen = true;
			this.pickMenu.hidden = false;
			this.pickBtn.setAttribute("aria-expanded", "true");
			this.renderPicker();
			// From the keyboard the focus goes into the menu; a tap or a click
			// leaves it where it was (the field, with its keyboard).
			if (byKey) this.pickRows()[0]?.focus();
		});
		this.pickMenu.addEventListener("keydown", (e) => {
			const rows = this.pickRows();
			const i = rows.indexOf(document.activeElement as HTMLElement);
			let next = -1;
			if (e.key === "ArrowDown") next = (i + 1) % rows.length;
			else if (e.key === "ArrowUp") next = (i - 1 + rows.length) % rows.length;
			else if (e.key === "Home") next = 0;
			else if (e.key === "End") next = rows.length - 1;
			else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.closePicker(true);
				return;
			} else if (e.key === "Tab") {
				this.closePicker(false);
				return;
			}
			if (next < 0 || rows.length === 0) return;
			e.preventDefault();
			rows[next]!.focus();
		});
		// Escape while typing with the menu open closes the menu (only).
		this.input.addEventListener("keydown", (e) => {
			if (e.key !== "Escape" || !this.pickOpen) return;
			e.preventDefault();
			e.stopPropagation();
			this.closePicker(true);
		});
		// A tap or click anywhere else closes it.
		document.addEventListener(
			"pointerdown",
			(e) => {
				if (!this.pickOpen) return;
				const t = e.target as Node;
				if (this.pickMenu.contains(t) || this.pickBtn.contains(t)) return;
				this.closePicker(false);
			},
			true,
		);
	}

	private pickRows(): HTMLElement[] {
		return [...this.pickList.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];
	}

	private closePicker(focusField: boolean): void {
		if (!this.pickOpen) return;
		this.pickOpen = false;
		this.pickMenu.hidden = true;
		this.pickBtn.setAttribute("aria-expanded", "false");
		if (focusField) this.input.focus();
	}

	private renderPicker(): void {
		const names = [...this.agents.keys()];
		const text = this.input.value;
		const focused = (document.activeElement as HTMLElement | null)?.dataset?.agent;
		const now = Date.now();
		const rows = names.map((n) => {
			const { checked, implicit } = recipientRow(text, names, n);
			const a = this.agents.get(n)!;
			const st = agentStatus(a, now, this.auth.get(n) === true);
			const b = el("button", `acp-pick-row${checked ? " checked" : ""}`);
			b.type = "button";
			b.tabIndex = -1;
			b.dataset.agent = n;
			b.setAttribute("role", "menuitemcheckbox");
			b.setAttribute("aria-checked", String(checked));
			const mark = el("span", "acp-pick-mark", checked ? "✓" : "");
			mark.setAttribute("aria-hidden", "true");
			const info = el("span", "acp-pick-info");
			info.append(agentAvatar(n), el("span", `acp-pick-state acp-status-${st.tone}`, st.label));
			if (implicit) {
				// Checked by a mention inside the message: only editing the text unchecks it.
				info.append(el("span", "acp-pick-why", "mencionado en el mensaje"));
				b.setAttribute("aria-disabled", "true");
			}
			b.append(mark, info);
			b.addEventListener("click", () => this.toggleRecipient(n));
			return b;
		});
		this.pickList.replaceChildren(...rows);
		// A leading mention that is no agent: nobody is checked and nothing
		// would be sent — said here, not only when sending.
		const r = recipientsOf(text, names);
		const unknownLead = r.error !== null && /^\s*@[A-Za-z0-9_-]/.test(text);
		this.pickNote.hidden = !unknownLead;
		this.pickNote.textContent = unknownLead ? (r.error ?? "") : "";
		if (unknownLead) this.pickList.setAttribute("aria-describedby", this.pickNote.id);
		else this.pickList.removeAttribute("aria-describedby");
		if (focused) rows.find((r) => r.dataset.agent === focused)?.focus();
	}

	/** Checks / unchecks `name` by editing the leading mentions; the caret keeps its place. */
	private toggleRecipient(name: string): void {
		const names = [...this.agents.keys()];
		const i = this.input;
		const text = i.value;
		const row = recipientRow(text, names, name);
		const edits = setRecipient(text, names, name, !row.checked);
		if (edits.length === 0) return;
		const [a, b, dir] = [i.selectionStart, i.selectionEnd, i.selectionDirection];
		i.value = applyEdits(text, edits);
		i.setSelectionRange(mapThroughEdits(a, edits), mapThroughEdits(b, edits), dir ?? "none");
		this.fitInput();
		this.renderHint();
		this.syncSendBtn();
		this.renderPicker();
	}

	/**
	 * Who reads what is written here (a direct message is private; in a
	 * project, start with the agent): the headers no longer say it. The full
	 * text where the field rests on two wide lines; on a phone the field is
	 * one line, so only what fits in it — the privacy first, since a long
	 * name cuts the end off.
	 */
	private setPlaceholder(): void {
		const src = this.source;
		if (!src) return;
		const narrow = window.matchMedia?.("(max-width: 640px)").matches === true;
		// 320–360 px: "+" and the arrow leave the field ~180 px of text.
		const tiny = window.matchMedia?.("(max-width: 360px)").matches === true;
		// One line at rest everywhere: what does not fit is cut (CSS ellipsis).
		const text =
			this.composerMode === "disabled"
				? "Cargando el proyecto…"
				: src.kind === "agent"
					? narrow
						? `Privado · a @${src.name}`
						: `Mensaje privado a @${src.name} · Ctrl+Enter envía`
					: tiny
						? "Con @agente…"
						: narrow
							? "Empezá con @agente…"
							: "Empezá con @agente (uno o varios) · Ctrl+Enter envía";
		if (this.input.placeholder !== text) this.input.placeholder = text;
	}

	/**
	 * The line above the surface, only when there is something to say: in
	 * Project Chat who the text goes to (recipientsOf: exactly what a send
	 * would do), then the notices: sending,
	 * this chat's queue, and the size limit once the text gets near it (past
	 * it, it goes as an attachment). Read-only: the text stays the source.
	 */
	private renderHint(): void {
		const queued = this.messages.filter((m) => m.state === "pending").length;
		const running = this.messages.filter((m) => m.state === "running").length;
		const line: Array<string | HTMLElement> = [];
		if (this.source?.kind === "project" && this.composerMode === "on") {
			const to = recipientsOf(this.input.value, [...this.agents.keys()]).to;
			if (to.length) {
				line.push("Para ");
				for (const [i, n] of to.entries()) {
					if (i) line.push(" · ");
					line.push(el("b", "", `@${n}`));
				}
			}
		}
		const parts: string[] = [];
		if (this.sending) parts.push(this.sending > 1 ? `Enviando (${this.sending})…` : "Enviando…");
		if (running) parts.push(`${running} en curso`);
		if (queued) parts.push(`${queued} en espera`);
		// UTF-8 takes at most 3 bytes per UTF-16 unit: below that bound nothing
		// can be near the limit, and typing does not encode the text each key.
		const text = this.input.value;
		if (text.length * 3 >= this.maxBytes * 0.8) {
			const bytes = new TextEncoder().encode(text).length;
			const kib = (n: number) => `${Math.ceil(n / 1024)} KiB`;
			if (bytes > this.maxBytes)
				parts.push(`${kib(bytes)}: supera ${kib(this.maxBytes)}, se envía como adjunto`);
			else if (bytes >= this.maxBytes * 0.8) parts.push(`${kib(bytes)} de ${kib(this.maxBytes)}`);
		}
		if (parts.length) line.push(line.length ? ` — ${parts.join(" · ")}` : parts.join(" · "));
		this.toLine.replaceChildren(...line);
		this.toLine.hidden = line.length === 0;
		this.surface.classList.toggle("is-sending", this.sending > 0);
	}

	// ── Sending ─────────────────────────────────────────────────────────

	private async send(): Promise<void> {
		const src = this.source;
		const text = this.input.value;
		// Checked before the reservation below: a locked box keeps its draft.
		if (this.composerMode !== "on" || !src || text.trim() === "") return;
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
		this.syncSendBtn();
		this.closePicker(false);
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
		if (this.composerMode !== "on") {
			giveBack("No se envió: este chat no admite mensajes ahora.");
			this.changed();
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
		this.renderHint();
		this.sendStatus.textContent = this.sending > 1 ? `Enviando (${this.sending})…` : "Enviando…";
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
				} catch {
					failed.push(`@${name}`);
				}
			}
			// The person may have moved to another chat meanwhile: nothing of this
			// send is shown there; it is kept for THIS chat (giveBack).
			if (failed.length) {
				// The error (role=alert, next to the field) says it.
				this.sendStatus.textContent = "";
				// Fixed words, never the server's code; sending the same text again
				// keeps its client id, so whoever already got it does not get it twice.
				giveBack(`No se envió a ${failed.join(", ")}.`);
			} else {
				// Sent: its failure record (if this was its retry, or it was taken
				// back into the field) is done; an unsent text not yet taken back stays offered.
				const u = this.unsent.get(key);
				if (u && (u.clientId === clientId || u.restored)) this.unsent.delete(key);
				this.sendStatus.textContent = `Enviado a ${to.to.map((n) => `@${n}`).join(", ")}`;
			}
		} finally {
			this.sending--;
			this.renderHint();
			this.refreshAgentsSoon(0);
			this.changed();
		}
	}
}

/** States in which a message is over: reaching one is news for the pill. */
const FINAL = new Set(["done", "failed", "uncertain"]);

let pickerSeq = 0;

/** The send arrow (decorative: the button carries aria-label "Enviar"). */
function sendIcon(): SVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", "M5 12h12M12 6l6 6-6 6");
	svg.append(path);
	return svg;
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
/** An agent's avatar + @name, in its colour (also the Project Chat header's). */
export function agentAvatar(name: string): HTMLElement {
	return agentId(name);
}

/** The hue of an agent's colour (avatars elsewhere: the header's group). */
export function agentHue(name: string): number {
	return hue(name);
}

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

/**
 * Where each chat was being read (by sourceKey), kept while the page lives:
 * the first row in view and its offset from the thread's top.
 */
const readingPlaces = new Map<string, ReadingPlace>();

interface ReadingPlace {
	anchor: string;
	offset: number;
}

/** "3 mensajes nuevos": the count of the end button and its announcement. */
function newText(n: number): string {
	return `${n} ${n === 1 ? "mensaje nuevo" : "mensajes nuevos"}`;
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
