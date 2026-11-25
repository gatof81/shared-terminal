// acpThread.ts — the thread + composer of a project's topic
// (acpConversation.ts), also the read-only thread of the Archive
// (acpArchive.ts): what was written before topics, read where it is — the
// previous Project Chat (`project_id` = the project, no conversation) or an
// agent's previous direct messages (no project, no conversation). Same
// timeline either way; an Archive chat has no composer and no action that
// writes (an interruption or a question there is resolved in Pendientes).
//
// Data: one page over REST, then live rows and activity from /ws/acp
// (acpLive.ts), applied by id; a (re)connect reloads the page; while the
// socket is down, a slow poll. Sending never waits for an agent: each message
// is persisted (201) and shows its own state while the agent works through
// its queue in order. DOM is built with textContent only.

import { acpLiveUp, subscribeAcp } from "./acpLive.js";
import {
	activityRows,
	agentHue,
	authFromActivity,
	busyElsewhere,
	type Chips,
	chipsOf,
	eventTime,
	isTeamPost,
	isUnread,
	itemMessages,
	mentionQuery,
	messagePlace,
	recipientState,
	recipientsOf,
	type TopicItem,
	teamState,
	topicTimeline,
	upsert,
} from "./acpModel.js";
import { questionCard } from "./acpQuestionCard.js";
import { acpReadTicket, setAcpAgents } from "./acpRegistry.js";
import { openReview } from "./acpReview.js";
import {
	type AcpActivity,
	type AcpAgentInfo,
	type AcpConversation,
	type AcpFeed,
	type AcpMessage,
	type AcpQuestion,
	acpConversationFeed,
	acpFeed,
	acpListAgents,
	acpPost,
	acpProjectFeed,
	acpReadConversation,
	acpSend,
	uploadSessionFiles,
} from "./api.js";
import { markdownBlock } from "./chatMarkdown.js";
import { ChatEndButton, END_SLACK, firstRowInView } from "./chatScroll.js";
import { el, syncChildren } from "./ui.js";

/**
 * What a thread shows: a topic, or an Archive chat of project `projectId` —
 * its previous Project Chat (`agent` null) or the previous direct messages
 * of `agent`, one of its agents.
 */
export type ThreadSource =
	| { kind: "conversation"; conversationId: string; projectId: string }
	| { kind: "archive"; projectId: string; agent: string | null };

const PAGE = 100;
const FALLBACK_POLL_MS = 10_000;
const STATUS_MS = 15_000;

export interface ThreadState {
	agents: AcpAgentInfo[];
	auth: Map<string, boolean>;
	project: { id: string; name: string } | null;
	/** A topic's own row (title, archived, read mark) as its feed and live frames say. */
	conversation: AcpConversation | null;
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
	/** «Para:»'s "+": the recipients menu. */
	private readonly pickBtn = el("button", "acp-pick-btn acp-cbtn");
	/**
	 * One line above the surface, only when it has something to say: the
	 * notices (sending, the size). Never two rows.
	 */
	private readonly toLine = el("div", "acp-chat-hint");
	/** The menu's box (positioned over the thread): a note, then the menu itself. */
	private readonly pickMenu = el("div", "acp-pick-menu");
	private readonly pickList = el("div", "acp-pick-list");
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
		// The fixed words: «↓ N nuevos».
		count: (n) => `${n} nuevos`,
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
	/**
	 * Where the thread was last pinned to its end. A render may run between
	 * a scroll and its event (the event comes with the next frame): a thread
	 * well above this, in a box of the same height, was scrolled up by the
	 * reader, whatever `atBottom` still says.
	 */
	private pinnedTop = 0;
	/**
	 * What a reader further up is reading (its row and that row's offset) and
	 * the scrollTop it was seen at. The thread keeps that row in place by
	 * itself when rows change height (`keepHeld`): the browser's scroll
	 * anchoring is off on it (`overflow-anchor: none`) — Safari has none at
	 * all, so one way for every engine.
	 */
	private held: { place: ReadingPlace; top: number } | null = null;

	private source: ThreadSource | null = null;
	/**
	 * A chat was (re)opened: once its feed is read it shows its reading
	 * place (PROPUESTA §3: only a reader who was at the end comes back to
	 * the end), else — a topic — its news, else its end.
	 */
	private placePending = false;
	private gen = 0;
	private messages: AcpMessage[] = [];
	private hasEarlier = false;
	/**
	 * The oldest id of any page read: the next "Cargar anteriores" starts
	 * there. Not `messages[0]`: an agent's Archive keeps only its direct
	 * rows of a page, and a page with none of them must not be asked again.
	 */
	private cursor: number | null = null;
	private maxBytes = 256 * 1024;
	private readonly activity = new Map<number, AcpActivity[]>();
	private readonly openDetails = new Set<string>();
	private agents = new Map<string, AcpAgentInfo>();
	private readonly auth = new Map<string, boolean>();
	private project: { id: string; name: string } | null = null;
	private conversation: AcpConversation | null = null;
	/**
	 * A topic's read mark as it was when the topic was opened: the divider
	 * «Nuevos desde tu última visita» goes before the first row newer than
	 * it, and stays there while the topic is on screen (what the reader's own
	 * reading posts is `readSent`).
	 */
	private dividerAt: string | null | undefined = undefined;
	/** The newest event time already posted as read (or being posted). */
	private readSent = "";
	private readTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly divider = dividerEl();
	private error = "";
	/** A one-off notice in the composer's line (a message looked for and not found). */
	private notice = "";
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
	private readonly recoverBtn = el("button", "btn sm acp-recover", "Recuperar el texto");
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
	/** Watches the thread's box and every row in it (see the constructor). */
	private resizeObs: ResizeObserver | null = null;
	private readonly observedRows = new Set<Element>();
	private readonly errorEl = el("div", "acp-chat-error");
	private readonly emptyEl = el("div", "acp-chat-empty");
	private readonly moreBtn = el("button", "btn sm acp-more", "Cargar anteriores");
	/** Unsent text per topic: a draft never follows the person into another topic. */
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

	// ── A topic's recipients (3B F2) ────────────────────────────────────
	/**
	 * A topic's recipients as edited here and not sent yet, by conversation
	 * id. Without an entry the composer shows the topic's own (the server's
	 * `recipients`: what its last post went to — the same on every device);
	 * a new topic has none and starts empty.
	 */
	private readonly chips = new Map<string, Chips>();
	/** «Para:» — the chips and "+" (a topic's composer only). */
	private readonly toRow = el("div", "acp-to-row");
	private readonly chipBox = el("div", "acp-to-chips");
	/** Under the field: «Llega a …, a cada uno por separado.» and who will queue it. */
	private readonly toNotes = el("div", "acp-to-notes");
	/** The `@` menu over the field: the team and its agents, filtered by what is typed. */
	private readonly mentionList = el("div", "acp-mention-menu");
	private mention: { start: number; query: string; active: number } | null = null;
	/** A topic's title by id, for «ocupado en «X»» (the rail knows the project's). */
	titleOf: (id: string) => string | null = () => null;
	/** «Revisar interrupción» on an interrupted message (acpReview.ts). */
	onReview: (m: AcpMessage) => void = (m) =>
		openReview(m, {
			where: this.conversation?.title ?? null,
			activity: this.lastActivity(m.id),
			report: this.messages.find((x) => x.recovery_of === m.id) ?? null,
			onChanged: (row) => this.applyRow(row),
		});
	/**
	 * Where `⎇ <work>` leads (Herramientas, 3B F4). Until something is
	 * plugged in here the chip only says which work a message runs in.
	 */
	onOpenWork: ((agent: string, work: string) => void) | null = null;

	constructor() {
		// One line at rest; CSS (field-sizing) grows it with the text up to a cap.
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
		// "+" is «Para:»'s (buildToRow): the surface has no "+" column.
		this.surface.classList.add("no-plus");
		this.surface.append(this.input, this.sendBtn, this.pickMenu, this.mentionList);
		// Errors sit by the field, not at the top of the thread: a refused send
		// must be seen where the person is looking, however long the thread.
		// Under the surface, with "Recuperar el texto" next to the words.
		this.errorEl.setAttribute("role", "alert");
		this.errorEl.hidden = true;
		const errorLine = el("div", "acp-chat-actions");
		errorLine.append(this.errorEl, this.recoverBtn);
		this.sendStatus.setAttribute("role", "status");
		this.sendStatus.setAttribute("aria-live", "polite");
		this.buildToRow();
		this.composer.append(
			this.toLine,
			this.toRow,
			this.surface,
			this.toNotes,
			errorLine,
			this.sendStatus,
		);
		// A tap on Enviar, a mention or "↓ N nuevos" must not take the focus from the field:
		// on a phone that blur closes the keyboard, the layout grows back (the
		// bottom bar returns) and the button moves away under the finger before
		// the tap lands. Keyboard activation does not go through these events.
		for (const b of [this.sendBtn, this.pickBtn, this.pickMenu, this.mentionList, this.endBtn.el])
			for (const type of ["pointerdown", "mousedown"] as const)
				b.addEventListener(type, (e) => {
					if (document.activeElement === this.input) e.preventDefault();
				});
		this.input.addEventListener("input", () => {
			this.syncMention();
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
					if (this.atBottom && !this.readerLeftEnd()) {
						t.scrollTop = t.scrollHeight;
						this.pinnedTop = t.scrollTop;
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
				if (this.atBottom) {
					// The reader's own place at the end: what the rules above and
					// `readerLeftEnd` compare with is never older than this scroll.
					this.pinnedTop = t.scrollTop;
					this.clearNew();
				} else this.renderPill();
				// At once, not on the next frame: a link followed right after the
				// scroll hides the thread before that frame, and Back would find no
				// place to return to (a one-row binary search: cheap per event).
				this.noteAnchor();
				this.noteSeenSoon();
			},
			{ passive: true },
		);
		// The thread's box changes without a scroll event too: a reader at the
		// end stays at the end; one reading further up keeps scrollTop, i.e.
		// the same text in view. Its rows are watched as well: a row can grow
		// after the render that placed it (a font that finishes loading
		// re-wraps its text) with no scroll and no box change, and a reader
		// pinned to the end was left that many pixels short of it, for good.
		if (typeof ResizeObserver !== "undefined") {
			this.resizeObs = new ResizeObserver(() => {
				const t = this.threadEl;
				const wasHidden = this.box === 0;
				this.box = t.clientHeight;
				if (t.clientHeight === 0) return;
				// Shown again: the box was rebuilt, its scroll offset is not to be
				// trusted: the reading place goes back (none: the end).
				if (wasHidden && !this.placePending) this.restorePlace();
				else if (this.atBottom && this.readerLeftEnd() && !this.endBtn.jumping) {
					// The reader scrolled up before its event came: theirs, not re-pinned.
					this.atBottom = false;
					this.noteAnchor();
				} else if (this.atBottom) {
					t.scrollTop = t.scrollHeight;
					this.pinnedTop = t.scrollTop;
				} else this.keepHeld();
				this.renderPill();
			});
			this.resizeObs.observe(this.threadEl);
		}
		this.moreBtn.type = "button";
		this.moreBtn.addEventListener("click", () => {
			this.moreBtn.disabled = true;
			void this.loadEarlier();
		});
		this.root.append(wrap, this.composer);
		this.composer.addEventListener("submit", (e) => {
			e.preventDefault();
			void this.send();
		});
		this.input.addEventListener("keydown", (e) => {
			if (this.mentionKey(e)) return;
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
			conversation: this.conversation,
			error: this.error,
			feed: this.feed,
		};
	}

	/** An Archive chat: read only, nothing on it writes. */
	private get readOnly(): boolean {
		return this.source?.kind === "archive";
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
	/** Says `text` in the composer's notice line until the next send or chat. */
	showNotice(text: string): void {
		this.notice = text;
		this.renderComposer();
	}

	/** Where message `id` stands in this chat: shown, on an earlier page, or not here. */
	placeOf(id: number): "shown" | "earlier" | "elsewhere" {
		return messagePlace(
			id,
			this.messages.map((m) => m.id),
			this.hasEarlier,
		);
	}

	/**
	 * Puts message `id` with its top at a quarter of the thread's height,
	 * flashes it and gives it the focus. On an earlier page not loaded yet,
	 * loads back with "Cargar anteriores" (`aria-busy` on the thread
	 * meanwhile) — at most 3 pages per call, so one tap never loads an
	 * unbounded history. "shown": in view; "earlier": still further back
	 * after those pages; "missing": not in this chat, or the load stopped.
	 */
	async revealMessage(
		id: number,
		opts: { result?: boolean } = {},
	): Promise<"shown" | "earlier" | "missing"> {
		const gen = this.gen;
		try {
			for (let pages = 0; ; pages++) {
				if (gen !== this.gen) return "missing";
				this.render();
				// A result has a row of its own in a topic; else the message's row.
				const row =
					(opts.result
						? this.threadEl.querySelector<HTMLElement>(`:scope > [data-result="${id}"]`)
						: null) ?? this.threadEl.querySelector<HTMLElement>(`[data-ids~="${id}"]`);
				if (row) {
					this.goToRow(row);
					return "shown";
				}
				if (this.placeOf(id) !== "earlier") return "missing";
				if (pages >= 3) return "earlier";
				this.threadEl.setAttribute("aria-busy", "true");
				await this.loadEarlier();
			}
		} finally {
			this.threadEl.removeAttribute("aria-busy");
		}
	}

	private goToRow(row: HTMLElement, inner?: HTMLElement): void {
		const t = this.threadEl;
		const anchor = row.dataset.anchor;
		if (!anchor) return;
		// "esperando tu respuesta": the destination is the open question's card.
		const card = inner ? null : row.querySelector<HTMLElement>(".acp-question-open");
		const target = inner ?? card ?? row;
		const lead = target.getBoundingClientRect().top - row.getBoundingClientRect().top;
		this.putRow({ anchor, offset: Math.round(t.clientHeight * 0.25) - lead });
		this.box = t.clientHeight;
		this.atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < END_SLACK;
		this.noteAnchor();
		this.renderPill();
		const ids = row.dataset.ids ?? "";
		this.newAnnounce.textContent = card ? "Pregunta" : `Mensaje #${ids.split(" ")[0]}`;
		if (card)
			card
				.querySelector<HTMLElement>("input, textarea, select, button")
				?.focus({ preventScroll: true });
		else {
			row.tabIndex = -1;
			row.focus({ preventScroll: true });
		}
		flash(target, card !== null);
	}

	retry(): void {
		void this.reload();
	}

	/** Shows `source` (resets everything when it changes) and follows it live. */
	open(source: ThreadSource): void {
		const same = sameChat(this.source, source);
		if (!same) {
			// The topic being left: its place and what was in view count before
			// anything resets.
			this.notePlaceAtLeave();
			this.flushSeen();
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
			this.openDetails.clear();
			this.questions.clear();
			this.cards.clear();
			this.agents.clear();
			this.auth.clear();
			this.project = null;
			this.conversation = null;
			this.dividerAt = undefined;
			this.readSent = "";
			if (this.readTimer) clearTimeout(this.readTimer);
			this.readTimer = null;
			this.cursor = null;
			this.error = "";
			this.notice = "";
			this.feed = "loading";
			this.readOnce = false;
			this.atBottom = true;
			// Where it was being read (else its news or its end), once its feed is in.
			this.placePending = true;
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

	/** A message row as a write just answered it (a review, a requeue): shown at once. */
	applyRow(row: AcpMessage): void {
		if (!this.relevant(row)) return;
		this.noteLive({ row });
		this.messages = upsert(this.messages, row);
		this.changed();
	}

	/** The latest activity this page saw for message `id` (tool and detail), if any. */
	lastActivity(id: number): string | null {
		const last = activityRows(this.activity.get(id) ?? []).at(-1);
		return last ? `${last.label || "herramienta"}${last.detail ? ` ${last.detail}` : ""}` : null;
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
		this.notePlaceAtLeave();
		this.closePicker(false);
		this.flushSeen();
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.stopPoll();
		if (this.statusTimer) clearInterval(this.statusTimer);
		this.statusTimer = null;
	}

	/**
	 * The place being read, from the geometry as it is now (the last scroll
	 * event may not have been dispatched yet), while the thread still shows
	 * it: what Back returns to. Every way out takes it — a close, and a switch
	 * to another topic in the same thread (a link from one topic to another).
	 */
	private notePlaceAtLeave(): void {
		const t = this.threadEl;
		if (t.clientHeight > 0 && !this.placePending && !this.endBtn.jumping) {
			this.atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < END_SLACK;
			this.noteAnchor();
		}
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
			const feed = await feedOf(src);
			if (gen !== this.gen) return;
			this.applyFeed(feed, false);
			this.replayLive(mark);
			this.error = "";
			this.feed = "ok";
			this.readOnce = true;
			if (this.placePending) {
				this.placePending = false;
				// The rows first: the render `applyFeed` asked for waits for the
				// next frame, and the anchor's row must be on the page now (a
				// return from ANOTHER chat left this one with only "Cargando…").
				// Placed in that same task: no frame shows the thread elsewhere.
				this.render();
				if (this.hasPlace()) this.restorePlace();
				else if (!this.toDivider()) this.scrollToEnd();
				this.noteSeen();
			}
		} catch (err) {
			if (gen !== this.gen) return;
			this.placePending = false;
			const e = err as Error & { status?: number };
			// A re-read that fails (a reconnect, the fallback poll, a flaky
			// link) must not take away a history already read: `stale`.
			this.feed = e.status === 404 ? "not-found" : this.readOnce ? "stale" : "error";
			this.error =
				e.status === 404
					? src.kind === "conversation"
						? "Conversación no encontrada."
						: src.agent
							? "Este agente ya no existe."
							: "Proyecto no encontrado."
					: // Fixed text: the server's message is a code ("internal"), not words for a person.
						"No se pudo actualizar el chat.";
		}
		this.changed();
	}

	private applyFeed(feed: AcpFeed, earlier: boolean): void {
		this.maxBytes = feed.maxMessageBytes;
		// An agent's feed is everything it got outside topics, in any scope:
		// its Archive is the direct part (the project's is the other chat).
		const rows = feed.messages.filter((m) => this.relevant(m));
		const first = feed.messages[0]?.id;
		if (first !== undefined) this.cursor = Math.min(this.cursor ?? first, first);
		if (earlier) {
			const ids = new Set(this.messages.map((m) => m.id));
			this.messages = [...rows.filter((m) => !ids.has(m.id)), ...this.messages];
		} else {
			// A reload keeps older pages already shown.
			const older = this.messages.filter((m) => m.id < (first ?? Number.POSITIVE_INFINITY));
			this.messages = [...older, ...rows];
			if (!older.length) this.hasEarlier = feed.messages.length >= PAGE;
		}
		if (earlier) this.hasEarlier = feed.messages.length >= PAGE;
		const list = feed.agents ?? (feed.agent ? [feed.agent] : []);
		if (!earlier) {
			this.agents = new Map(list.map((a) => [a.name, a]));
			for (const a of list) this.auth.set(a.name, a.authRequired === true);
			this.activity.clear();
			for (const [name, evs] of Object.entries(feed.activity ?? {})) this.addActivity(name, evs);
		}
		if (feed.project) this.project = feed.project;
		if (feed.conversation) {
			this.conversation = feed.conversation;
			// The mark as it was when the topic was opened (once per opening).
			if (this.dividerAt === undefined) this.dividerAt = feed.conversation.readAt;
		}
		for (const q of feed.questions ?? []) this.questions.set(q.id, q);
	}

	private async loadEarlier(): Promise<void> {
		const src = this.source;
		const gen = this.gen;
		const first = this.cursor;
		if (!src || !first) return;
		const mark = this.liveTick;
		try {
			const feed = await feedOf(src, first);
			if (gen !== this.gen) return;
			this.applyFeed(feed, true);
			this.replayLive(mark);
		} catch {
			if (gen !== this.gen) return;
			this.error = "No se pudieron cargar los anteriores.";
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
		if (src.kind === "conversation") return m.conversation_id === src.conversationId;
		// The Archive is what has no topic (docs/ACP_AGENTS.md §4b).
		if (m.conversation_id) return false;
		return src.agent
			? !m.project_id && (m.to_id === src.agent || m.from_id === src.agent)
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
				if (q.message_id === null || !this.messages.some((m) => m.id === q.message_id)) return;
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
			case "conversation": {
				const c = ev.conversation;
				if (this.source?.kind !== "conversation" || c.id !== this.source.conversationId) return;
				// A frame may lack the counts the feed computed: keep what it does not say.
				this.conversation = { ...this.conversation, ...c } as AcpConversation;
				this.changed();
				return;
			}
		}
	}

	private addActivity(agent: string, events: AcpActivity[]): void {
		for (const e of events) {
			const a = this.agents.get(agent);
			if (a) a.runnerSeenAt = e.at;
			if (e.messageId === null) continue;
			// The partial text of an answer is not shown: its result is.
			if (e.kind === "text") continue;
			const list = this.activity.get(e.messageId) ?? [];
			list.push(e);
			this.activity.set(e.messageId, list.slice(-200));
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
						src.kind === "archive" && src.agent
							? all.filter((a) => a.name === src.agent)
							: all.filter((a) => a.projectId === src.projectId);
					this.agents = new Map(mine.map((a) => [a.name, a]));
					for (const a of mine)
						if (a.authRequired !== undefined) this.auth.set(a.name, a.authRequired);
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
		if (
			this.atBottom &&
			// "Ir al final" scrolling smoothly is on its way down, not the reader up.
			!this.endBtn.jumping &&
			this.readerLeftEnd()
		)
			this.atBottom = false;
		const atBottom = this.atBottom;
		const prevTop = t.scrollTop;
		// A reader further up keeps the row they are looking at where it is,
		// whatever changes above or below it (an earlier page, an answer, a
		// question card): by that row, never by scrollTop or the distance to the end.
		// The row held since the reader last scrolled, not the one in view now:
		// rows can have changed height since (a font that arrived) with the
		// ResizeObserver's report still pending — this frame's render runs
		// first, and the geometry it reads is already shifted.
		const held = this.held && Math.abs(t.scrollTop - this.held.top) < 1 ? this.held : null;
		const keep = atBottom || this.toBottom ? null : (held?.place ?? this.rowInView());
		const nodes: HTMLElement[] = [];
		if (this.hasEarlier) {
			this.moreBtn.disabled = false;
			nodes.push(this.moreBtn);
		}
		if (this.messages.length === 0) {
			this.emptyEl.textContent =
				this.source?.kind === "archive"
					? "Sin mensajes en este archivo."
					: "Sin mensajes en esta conversación todavía. Mencioná a un agente con @ para empezar.";
			nodes.push(this.emptyEl);
		}
		const used = new Set<string>();
		// «Nuevos desde tu última visita»: before the first item with news
		// since the mark this topic had when it was opened.
		let dividerPlaced = this.dividerAt === undefined;
		const rows = topicTimeline(this.messages).map((it) => ({
			key: it.key,
			ms: itemMessages(it),
			sig: () => this.topicSig(it),
			build: () => this.topicItemEl(it),
			// The person's post is never news by itself: its answers are, where they land.
			news: it.kind !== "post" && isUnread(it.message, this.dividerAt ?? null),
			result: it.kind === "result" ? it.message.id : null,
		}));
		for (const row of rows) {
			const { key, ms } = row;
			const sig = row.sig();
			let cached = this.items.get(key);
			if (cached?.sig !== sig) {
				cached = { sig, el: row.build() };
				this.items.set(key, cached);
			}
			used.add(key);
			// The reading anchor's handle (noteAnchor / restorePlace), and the
			// messages the row shows (revealMessage finds a message's row by them).
			cached.el.dataset.anchor = key;
			cached.el.dataset.ids = ms.map((m) => m.id).join(" ");
			if (row.result !== null) cached.el.dataset.result = String(row.result);
			if (!dividerPlaced && row.news) {
				dividerPlaced = true;
				nodes.push(this.divider);
			}
			nodes.push(cached.el);
		}
		for (const key of [...this.items.keys()]) if (!used.has(key)) this.items.delete(key);
		// Questions whose message is not on this page (an older page, or none).
		const shown = new Set(this.messages.map((m) => m.id));
		for (const q of this.questions.values())
			if ((q.message_id === null || !shown.has(q.message_id)) && q.state === "open")
				nodes.push(this.questionEl(q));
		syncChildren(t, nodes);
		this.observeRows(nodes);
		if (keepFocus?.isConnected) keepFocus.focus({ preventScroll: true });
		const end = atBottom || this.toBottom;
		const placed = !end && keep !== null && this.putRow(keep);
		if (end) {
			t.scrollTop = t.scrollHeight;
			this.pinnedTop = t.scrollTop;
		} else if (!placed) t.scrollTop = prevTop;
		// The held row is still the reader's (it was put back): only where
		// scrollTop now is changes. Anything else is taken afresh.
		if (placed && held && keep === held.place) held.top = t.scrollTop;
		else this.holdPlace(!end);
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
		this.noteSeenSoon();
	}

	// ── Read mark (topics) ──────────────────────────────────────────────
	//
	// What the reader really saw: a row counts once its top edge is above the
	// thread's bottom edge (in view, or scrolled past) while the thread is
	// shown and the page visible — a person's message counts by its answer's
	// edge, since what is news there is the result. The mark is the newest
	// event time among those (a time: older rows are covered by it), posted
	// debounced and only forward. Nothing else marks a topic read.

	private noteSeenSoon(): void {
		if (this.source?.kind !== "conversation" || this.readTimer) return;
		this.readTimer = setTimeout(() => {
			this.readTimer = null;
			this.noteSeen();
		}, 400);
	}

	private noteSeen(): void {
		const src = this.source;
		const t = this.threadEl;
		if (src?.kind !== "conversation" || this.placePending || t.clientHeight === 0) return;
		if (document.visibilityState === "hidden") return;
		const bottom = t.getBoundingClientRect().bottom;
		const byId = new Map(this.messages.map((m) => [m.id, m]));
		let newest = "";
		for (const row of t.querySelectorAll<HTMLElement>(":scope > [data-ids]")) {
			if (row.getBoundingClientRect().top >= bottom) break;
			for (const id of (row.dataset.ids ?? "").split(" ")) {
				const m = byId.get(Number(id));
				if (!m || !isUnread(m, null)) continue;
				// A person's message is news by its answer: that bubble must be in
				// view (in a topic, the answer is an item of its own).
				if (m.from_id === "owner") {
					if (row.dataset.result === undefined && row.dataset.anchor?.startsWith("post:")) continue;
					const sub = row.querySelector<HTMLElement>(`[data-mid="${m.id}"]`);
					if (sub && sub.getBoundingClientRect().top >= bottom) continue;
				}
				const at = eventTime(m);
				if (at > newest) newest = at;
			}
		}
		const mark = this.conversation?.readAt ?? null;
		if (!newest || newest <= this.readSent) return;
		if (mark !== null && Date.parse(newest) <= Date.parse(mark)) return;
		this.readSent = newest;
		const gen = this.gen;
		void acpReadConversation(src.conversationId, newest)
			.then((c) => {
				if (gen !== this.gen) return;
				this.conversation = { ...this.conversation, ...c } as AcpConversation;
				this.onState(this.state);
			})
			.catch(() => {
				// Not marked: the next look tries again.
				if (gen === this.gen && this.readSent === newest) this.readSent = "";
			});
	}

	/** Leaving the topic: what was in view when it was left counts. */
	private flushSeen(): void {
		if (this.readTimer) clearTimeout(this.readTimer);
		this.readTimer = null;
		this.noteSeen();
	}

	/** A saved reading place for this chat (a reader who left at the end has none). */
	private hasPlace(): boolean {
		return this.source !== null && readingPlaces.has(sourceKey(this.source));
	}

	/**
	 * A topic opened with news and no reading place: the divider near the top
	 * of the view (what is new reads downward from it), the news still below
	 * counted on the pill. False when there is no divider on screen.
	 */
	private toDivider(): boolean {
		const t = this.threadEl;
		if (!this.divider.isConnected || t.clientHeight === 0) return false;
		t.scrollTop += this.divider.getBoundingClientRect().top - t.getBoundingClientRect().top - 12;
		this.box = t.clientHeight;
		this.atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < END_SLACK;
		this.pinnedTop = this.atBottom ? t.scrollTop : this.pinnedTop;
		if (!this.atBottom) {
			const bottom = t.getBoundingClientRect().bottom;
			const byId = new Map(this.messages.map((m) => [m.id, m]));
			for (const row of t.querySelectorAll<HTMLElement>(":scope > [data-ids]"))
				if (row.getBoundingClientRect().top >= bottom)
					for (const id of (row.dataset.ids ?? "").split(" ")) {
						const m = byId.get(Number(id));
						if (m && isUnread(m, this.dividerAt ?? null)) this.newIds.add(m.id);
					}
		}
		this.noteAnchor();
		this.renderPill();
		return true;
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
	 * change. A reader at the end has no anchor: they come back to the end.
	 */
	private noteAnchor(): void {
		const t = this.threadEl;
		if (!this.source || this.placePending || this.feed === "loading" || t.clientHeight === 0)
			return;
		const key = sourceKey(this.source);
		if (this.atBottom) {
			readingPlaces.delete(key);
			this.holdPlace(false);
			return;
		}
		const place = this.rowInView();
		if (place) readingPlaces.set(key, place);
		this.holdPlace(true);
	}

	/**
	 * The row held is the first one that STARTS in view, not the reading
	 * anchor (the first one partly in view): a row cut at the top that grows
	 * inside would push everything under it — the text being read, the
	 * «Nuevos» divider — while its own top stayed put.
	 */
	private holdPlace(on: boolean): void {
		const t = this.threadEl;
		this.held = null;
		if (!on || t.clientHeight === 0) return;
		const hit = firstRowInView(t, (c) => c.dataset.anchor !== undefined);
		if (!hit) return;
		let row: Element | null = hit.row;
		if (hit.offset < 0)
			for (let n = row.nextElementSibling; n; n = n.nextElementSibling)
				if ((n as HTMLElement).dataset.anchor !== undefined) {
					row = n;
					break;
				}
		const offset = row.getBoundingClientRect().top - t.getBoundingClientRect().top;
		this.held = {
			place: { anchor: (row as HTMLElement).dataset.anchor!, offset },
			top: t.scrollTop,
		};
	}

	/**
	 * Rows changed height around a reader further up (a font, a re-wrap, a
	 * card): their row goes back to where it was on screen. Not when
	 * scrollTop moved since the place was taken — that is the reader's own
	 * scroll whose event has not come yet, and it is theirs.
	 */
	private keepHeld(): void {
		const t = this.threadEl;
		const h = this.held;
		if (!h || Math.abs(t.scrollTop - h.top) >= 1) return;
		if (this.putRow(h.place)) h.top = t.scrollTop;
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

	/**
	 * Only the rows not watched yet: observe() on a watched element starts it
	 * over, and its first report would come again on every render.
	 */
	private observeRows(nodes: readonly Element[]): void {
		const obs = this.resizeObs;
		if (!obs) return;
		const now = new Set(nodes);
		for (const n of this.observedRows)
			if (!now.has(n)) {
				obs.unobserve(n);
				this.observedRows.delete(n);
			}
		for (const n of nodes)
			if (!this.observedRows.has(n)) {
				obs.observe(n);
				this.observedRows.add(n);
			}
	}

	/**
	 * The thread was pinned to its end and is now well above it by the
	 * reader's own scroll, whose event has not come yet (it comes with the
	 * next frame; a render, a ResizeObserver or a box change can run first).
	 * The layout never does that: a box or content that shrinks clamps
	 * scrollTop to the new end (nothing below it), one that grows leaves
	 * scrollTop where it was or — scroll anchoring — moves it down.
	 */
	private readerLeftEnd(): boolean {
		const t = this.threadEl;
		if (t.clientHeight === 0) return false;
		const away = t.scrollHeight - t.scrollTop - t.clientHeight;
		return away > 1 && t.scrollTop < this.pinnedTop - END_SLACK;
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
		this.pinnedTop = t.scrollTop;
		// The box it was placed in, now: the scroll handler takes a scroll in a
		// box of another height for the layout's and pins the end. Left to the
		// ResizeObserver's first frame, a reader scrolling at once was pulled back.
		if (t.clientHeight > 0) this.box = t.clientHeight;
		this.clearNew();
	}

	// ── A topic's items (3B F2) ─────────────────────────────────────────

	/** Recipient `m.to_id`'s row under a message, from the backend's facts only. */
	private rowState(m: AcpMessage) {
		return recipientState(m, {
			agent: this.agents.get(m.to_id),
			titleOf: this.titleOf,
			asking: this.openQuestionOf(m.id),
			login: this.auth.get(m.to_id) === true,
			activity: this.lastActivity(m.id),
		});
	}

	private topicSig(it: TopicItem): string {
		return JSON.stringify([
			it.kind,
			itemMessages(it).map((m) => [
				m.id,
				m.state,
				m.from_id,
				m.to_id,
				m.body,
				m.result_text,
				m.note,
				m.reviewed_at ?? null,
				m.context ?? null,
				m.team ?? null,
				m.created_at,
				m.finished_at,
				m.recovery_of ?? null,
				this.rowState(m).label,
				this.messages.find((x) => x.recovery_of === m.id)?.result_text ? "r" : "",
				[...this.questions.values()]
					.filter((q) => q.message_id === m.id)
					.map((q) => `${q.id}:${q.state}`),
			]),
			it.kind === "reply" ? (it.consult?.id ?? null) : null,
			this.onOpenWork !== null,
		]);
	}

	private topicItemEl(it: TopicItem): HTMLElement {
		switch (it.kind) {
			case "post":
				return this.postEl(it.messages);
			case "consult":
				return this.consultEl(it.message);
			case "system":
				return this.noteEl(it.message);
			case "reply":
				return this.replyEl(it.message, it.consult);
			case "result":
				return this.resultEl(it.message);
		}
	}

	/** The person's message: «Vos → …», what was said, one state row per recipient. */
	private postEl(ms: AcpMessage[]): HTMLElement {
		const first = ms[0]!;
		const art = el("article", "acp-msg acp-turn acp-mine acp-post");
		art.dataset.state = first.state;
		const said = el("div", "acp-bubble acp-out");
		const head = el("div", "acp-msg-head");
		const who = el("span", "acp-msg-who");
		const names = ms.map((m) => `@${m.to_id}`).join(", ");
		who.append("Vos ");
		if (isTeamPost(ms)) {
			const team = el("span", "acp-team-to", `→ Todo el equipo (${ms.length})`);
			team.title = names;
			team.setAttribute("aria-label", `→ Todo el equipo: ${names}`);
			who.append(team);
		} else who.append(`→ ${names}`);
		head.append(who);
		for (const m of ms) {
			const w = this.workChip(m);
			if (w) head.append(w);
		}
		head.append(el("span", "acp-msg-time", time(first.created_at)));
		said.append(head, el("pre", "acp-msg-body", first.body), this.statusEl(ms));
		art.append(said);
		for (const m of ms)
			for (const q of this.questions.values())
				if (q.message_id === m.id) art.append(this.questionEl(q));
		return art;
	}

	/**
	 * One row per recipient — trabajando · en cola (why) · respondió · interrumpida;
	 * no aggregate progress. Everyone answered: «✓ @a ✓ @b», each to its answer.
	 */
	private statusEl(ms: AcpMessage[]): HTMLElement {
		const states = ms.map((m) => ({ m, st: this.rowState(m) }));
		if (states.every(({ st }) => st.kind === "done")) {
			const line = el("div", "acp-rs-all");
			line.setAttribute("aria-label", "Respondieron todos");
			for (const { m } of states) {
				const mark = el(m.result_text ? "button" : "span", "acp-rs-check", `✓ @${m.to_id}`);
				if (mark instanceof HTMLButtonElement) {
					mark.type = "button";
					mark.title = `Ir a la respuesta de @${m.to_id}`;
					mark.addEventListener("click", () => this.goToResult(m.id));
				}
				line.append(mark);
			}
			return line;
		}
		const ul = el("ul", "acp-rs-list");
		ul.setAttribute("aria-label", "Estado por destinatario");
		for (const { m, st } of states) {
			const li = el("li", `acp-rs acp-rs-${st.kind}`);
			li.dataset.agent = m.to_id;
			li.style.setProperty("--acp-hue", String(agentHue(m.to_id)));
			const state = el("span", "acp-rs-state");
			state.append(el("span", "acp-rs-dot"), el("span", "acp-rs-label", st.label));
			li.append(avatarOf(m.to_id), el("span", "acp-rs-name", `@${m.to_id}`), state);
			if (st.kind === "done" && m.result_text) {
				const ver = el("button", "acp-link", "ver");
				ver.type = "button";
				ver.setAttribute("aria-label", `Ver la respuesta de @${m.to_id}`);
				ver.addEventListener("click", () => this.goToResult(m.id));
				state.append(" · ", ver);
			}
			if (st.kind === "interrupted" || st.kind === "reviewed") {
				const report = this.messages.find((x) => x.recovery_of === m.id);
				if (report && !report.result_text)
					state.append(" · ", el("span", "acp-rs-muted", "informe pedido"));
			}
			// The Archive writes nothing: its interruptions are reviewed in Pendientes.
			if (st.kind === "interrupted" && this.readOnly) state.append(" · revisala en Pendientes");
			else if (st.kind === "interrupted") {
				const review = el("button", "btn sm acp-review-btn", "Revisar interrupción");
				review.type = "button";
				review.addEventListener("click", () => this.onReview(m));
				state.append(" · ", review);
			}
			if (st.kind === "failed" && m.note) li.append(el("span", "acp-rs-note", m.note));
			ul.append(li);
		}
		return ul;
	}

	/** «@a consulta a @b», its answer nested in it (`reply_to`). */
	private consultEl(m: AcpMessage): HTMLElement {
		const art = el("article", "acp-msg acp-consult acp-topic-consult");
		art.dataset.state = m.state;
		const said = el("div", "acp-bubble acp-in");
		agentVoice(said, m.from_id);
		const head = el("div", "acp-msg-head");
		head.append(agentId(m.from_id), el("span", "acp-msg-to", `consulta a @${m.to_id}`));
		const w = this.workChip(m);
		if (w) head.append(w);
		head.append(el("span", "acp-msg-time", time(m.created_at)));
		said.append(head, agentText(m.body));
		if (m.result_text) {
			const nested = el("div", "acp-nested acp-voice");
			nested.style.setProperty("--acp-hue", String(agentHue(m.to_id)));
			nested.dataset.answer = String(m.id);
			const h = el("div", "acp-msg-head");
			h.append(
				el("span", "acp-nested-mark", "↳"),
				agentId(m.to_id),
				el("span", "acp-msg-to", "respondió"),
				el("span", "acp-msg-time", time(m.finished_at ?? m.created_at)),
			);
			nested.append(h, agentText(m.result_text));
			said.append(nested);
		} else said.append(this.statusEl([m]));
		art.append(said);
		for (const q of this.questions.values())
			if (q.message_id === m.id) art.append(this.questionEl(q));
		return art;
	}

	/** A Shared Terminal note to an agent (its recovery report request, a check): one quiet line. */
	private noteEl(m: AcpMessage): HTMLElement {
		const art = el("article", "acp-msg acp-system acp-topic-note");
		art.dataset.state = m.state;
		const line = el("div", "acp-note-line");
		line.append(
			el(
				"span",
				undefined,
				m.recovery_of
					? `Shared Terminal pidió a @${m.to_id} un informe de solo lectura de la ejecución interrumpida #${m.recovery_of}`
					: `Shared Terminal → @${m.to_id}`,
			),
			el("span", "acp-msg-time", time(m.created_at)),
		);
		art.append(line, this.collapsible(`b${m.id}`, "Ver el texto", agentText(m.body)));
		if (!(m.state === "done" && m.result_text)) art.append(this.statusEl([m]));
		return art;
	}

	/**
	 * A consult's answer delivered to the agent that asked. Its consult in
	 * the thread: only «↳ @x respondió la consulta de @y (hh:mm) · Ir a la
	 * respuesta», never the text again. Without it (an earlier page): the
	 * only place to read it.
	 */
	private replyEl(m: AcpMessage, consult: AcpMessage | null): HTMLElement {
		const art = el("article", "acp-msg acp-reply");
		art.dataset.state = m.state;
		if (consult) {
			const line = el("div", "acp-late");
			const go = el("button", "acp-link", "Ir a la respuesta");
			go.type = "button";
			go.addEventListener("click", () => this.goToAnswer(consult.id));
			line.append(
				`↳ @${m.from_id} respondió la consulta de @${m.to_id} (${time(consult.created_at)}) · `,
				go,
			);
			art.append(line);
			return art;
		}
		const said = el("div", "acp-bubble acp-in");
		agentVoice(said, m.from_id);
		const head = el("div", "acp-msg-head");
		head.append(
			agentId(m.from_id),
			el("span", "acp-msg-to", `→ @${m.to_id} · respuesta a #${m.reply_to}`),
			el("span", "acp-msg-time", time(m.created_at)),
		);
		said.append(head, agentText(m.body));
		art.append(said);
		return art;
	}

	/** What an agent answered, where it landed in time. */
	private resultEl(m: AcpMessage): HTMLElement {
		const art = el("article", "acp-msg acp-result");
		art.dataset.state = m.state;
		const said = el("div", "acp-bubble acp-in");
		agentVoice(said, m.to_id);
		said.dataset.mid = String(m.id);
		const head = el("div", "acp-msg-head");
		head.append(agentId(m.to_id));
		if (m.recovery_of) head.append(el("span", "acp-tag", "informe de interrupción"));
		const w = this.workChip(m);
		if (w) head.append(w);
		head.append(el("span", "acp-msg-time", time(m.finished_at ?? m.created_at)));
		const res = el("div", "acp-msg-result");
		res.append(markdownBlock(m.result_text ?? ""));
		said.append(head, res);
		art.append(said);
		return art;
	}

	/** `⎇ <work>`: the work a message runs in (its Herramientas: onOpenWork, 3B F4). */
	private workChip(m: AcpMessage): HTMLElement | null {
		const work = m.context;
		if (!work) return null;
		const open = this.onOpenWork;
		const chip = el(open ? "button" : "span", "acp-work-chip", `⎇ ${work}`);
		chip.title = `Trabajo ${work} de @${m.to_id}`;
		if (open && chip instanceof HTMLButtonElement) {
			chip.type = "button";
			chip.addEventListener("click", () => open(m.to_id, work));
		}
		return chip;
	}

	/** «ver» / «✓ @a»: the answer's own item, in view and highlighted. */
	private goToResult(id: number): void {
		const row = this.threadEl.querySelector<HTMLElement>(`:scope > [data-result="${id}"]`);
		if (row) this.goToRow(row);
		else void this.revealMessage(id, { result: true });
	}

	/** «Ir a la respuesta»: the consult's nested answer, in view and highlighted. */
	private goToAnswer(consultId: number): void {
		const row = this.threadEl.querySelector<HTMLElement>(
			`:scope > [data-anchor="consult:${consultId}"]`,
		);
		const inner = row?.querySelector<HTMLElement>(`[data-answer="${consultId}"]`) ?? undefined;
		if (row) this.goToRow(row, inner);
	}

	private openQuestionOf(id: number): boolean {
		for (const q of this.questions.values())
			if (q.message_id === id && q.state === "open") return true;
		return false;
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

	private questionEl(q: AcpQuestion): HTMLElement {
		const cached = this.cards.get(q.id);
		if (cached && cached.state === q.state) return cached.el;
		const gen = this.gen;
		// The Archive writes nothing: an open question there is answered in
		// Pendientes, and an orphaned one is not offered to the message box.
		const card = questionCard(q, {
			stillHere: () => gen === this.gen,
			readOnly: this.readOnly,
			onAnswered: (row) => {
				this.noteLive({ q: row });
				this.questions.set(row.id, row);
				this.changed();
			},
			onResend: this.readOnly
				? undefined
				: (text) => {
						this.addChip(q.agent);
						this.input.value = text;
						this.input.focus();
						this.changed();
					},
		});
		this.cards.set(q.id, { state: q.state, el: card });
		return card;
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
		const shown = [this.error, u?.error ?? "", this.notice].filter(Boolean).join(" ");
		this.errorEl.textContent = shown;
		this.errorEl.hidden = shown === "";
		this.recoverBtn.hidden = !u || u.restored || this.composerMode !== "on";
		const writable = this.composerMode === "on";
		this.input.disabled = !writable;
		this.syncSendBtn();
		this.composer.classList.toggle("acp-composer-off", this.composerMode === "off");
		const topic = this.source?.kind === "conversation";
		this.toRow.hidden = !topic || this.composerMode === "off";
		if (topic) this.renderChips();
		else this.toNotes.hidden = true;
		if (!topic || !writable) this.closeMention();
		const picks = topic && writable && this.agents.size > 0;
		this.pickBtn.hidden = !picks;
		// The surface's states (acp-chat.css): a refused send, locked.
		this.surface.classList.toggle("is-error", Boolean(u?.error));
		this.surface.classList.toggle("is-disabled", !writable);
		if (!picks) this.closePicker(false);
		else if (this.pickOpen) this.renderPicker();
		this.renderHint();
		this.setPlaceholder();
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
		this.pickMenu.append(this.pickList);
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
		this.pickBtn.setAttribute("aria-label", "Agregar destinatario");
		this.pickBtn.title = "Agregar destinatario";
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
		const focused = (document.activeElement as HTMLElement | null)?.dataset?.agent;
		const rows = this.topicPickRows();
		this.pickList.replaceChildren(...rows);
		if (focused) rows.find((r) => r.dataset.agent === focused)?.focus();
	}

	/** One line at rest: what does not fit is cut (CSS ellipsis). */
	private setPlaceholder(): void {
		const text =
			this.composerMode === "disabled"
				? "Cargando la conversación…"
				: "Escribí un mensaje · @ para mencionar";
		if (this.input.placeholder !== text) this.input.placeholder = text;
	}

	/**
	 * The line above the surface, only when there is something to say:
	 * sending, and the size limit once the text gets near it (past it, it
	 * goes as an attachment). A topic says the rest per recipient, under each message.
	 */
	private renderHint(): void {
		const parts: string[] = [];
		if (this.sending) parts.push(this.sending > 1 ? `Enviando (${this.sending})…` : "Enviando…");
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
		this.toLine.textContent = parts.join(" · ");
		this.toLine.hidden = parts.length === 0;
		this.surface.classList.toggle("is-sending", this.sending > 0);
	}

	/**
	 * Who a text goes to. A topic never routes invisibly (PROPUESTA §3): the
	 * leading mentions, or the one agent mentioned in the text — never "the
	 * project's only agent" — and with nobody, «Elegí a quién con + o @».
	 */
	private recipients(text: string): { to: string[]; team: boolean; error: string | null } {
		const names = [...this.agents.keys()];
		// The chips, plus the agents named at the start of the text
		// (typed without the menu) — never one named inside the instruction.
		const c = this.currentChips();
		if (c.team) return { to: names, team: true, error: null };
		const lead = /^\s*@[A-Za-z0-9_-]/.test(text) ? recipientsOf(text, names) : null;
		if (lead?.error) return { to: [], team: false, error: lead.error };
		const to = [...new Set([...c.agents, ...(lead?.to ?? [])])];
		return to.length
			? { to, team: false, error: null }
			: { to: [], team: false, error: "Elegí a quién con + o @" };
	}

	// ── A topic's recipients: chips, "+", the `@` menu (3B F2) ───────────
	//
	// In a topic the recipients are explicit (PROPUESTA §3, §11.2): the
	// chips of «Para:», added with "+" or `@`, never guessed from the text
	// alone. «Todo el equipo» is a chip of its own, resolved by the server
	// when the message is sent (who joins later does not get it).

	private topicId(): string | null {
		return this.source?.kind === "conversation" ? this.source.conversationId : null;
	}

	/** The topic's chips now: edited here, else the topic's own. */
	private currentChips(): Chips {
		const cid = this.topicId();
		if (!cid) return { team: false, agents: [] };
		return this.chips.get(cid) ?? chipsOf(this.conversation?.recipients);
	}

	private setChips(c: Chips): void {
		const cid = this.topicId();
		if (!cid) return;
		this.chips.set(cid, { team: c.team, agents: [...new Set(c.agents)] });
		this.renderComposer();
		if (this.pickOpen) this.renderPicker();
	}

	private addChip(name: string): void {
		const c = this.currentChips();
		if (name === "*") this.setChips({ team: true, agents: [] });
		else if (!c.team && !c.agents.includes(name))
			this.setChips({ team: false, agents: [...c.agents, name] });
	}

	/**
	 * «Escribirle un mensaje nuevo» (a reviewed interruption): topic `cid`
	 * opens with `agent` as its only recipient.
	 */
	presetRecipients(cid: string, agents: string[]): void {
		this.chips.set(cid, { team: false, agents: [...agents] });
		if (this.topicId() === cid) this.renderComposer();
	}

	private teamNames(): string[] {
		return [...this.agents.keys()];
	}

	private buildToRow(): void {
		this.toRow.hidden = true;
		const label = el("span", "acp-to-label", "Para");
		label.setAttribute("aria-hidden", "true");
		this.toRow.append(label, this.chipBox, this.pickBtn);
		this.toNotes.hidden = true;
		this.toNotes.setAttribute("aria-live", "polite");
		this.mentionList.hidden = true;
		this.mentionList.id = `acp-mention-${++pickerSeq}`;
		this.mentionList.setAttribute("role", "listbox");
		this.mentionList.setAttribute("aria-label", "Mencionar");
		this.input.addEventListener("click", () => this.syncMention());
		this.input.addEventListener("blur", () => this.closeMention());
	}

	/** The chips, the "+" next to them and the notes under the field. */
	private renderChips(): void {
		const c = this.currentChips();
		const names = this.teamNames();
		const nodes: HTMLElement[] = [];
		if (c.team) {
			const chip = el("span", "acp-chip acp-chip-team");
			chip.setAttribute("role", "listitem");
			chip.title = "Los agentes del proyecto al enviar; quien se sume después no lo recibe";
			const stack = el("span", "acp-chip-stack");
			for (const n of names.slice(0, 4)) stack.append(avatarOf(n));
			chip.append(stack, el("span", "acp-chip-name", `Todo el equipo · ${names.length}`));
			chip.append(
				this.chipX("Quitar a todo el equipo", () => this.setChips({ team: false, agents: [] })),
			);
			nodes.push(chip);
		} else
			for (const n of c.agents) {
				const chip = el("span", "acp-chip");
				chip.setAttribute("role", "listitem");
				chip.style.setProperty("--acp-hue", String(agentHue(n)));
				const busy = busyElsewhere(this.agents.get(n), this.topicId(), this.titleOf);
				chip.append(avatarOf(n), el("span", "acp-chip-name", `@${n}`));
				if (busy) {
					const b = el("span", "acp-chip-busy", busy.startsWith("ocupado") ? "ocupado" : "espera");
					b.title = busy;
					chip.append(b);
				}
				chip.append(
					this.chipX(`Quitar a @${n}`, () =>
						this.setChips({ team: false, agents: c.agents.filter((x) => x !== n) }),
					),
				);
				nodes.push(chip);
			}
		// A list only when there are chips: the empty line is not an item.
		if (nodes.length) {
			this.chipBox.setAttribute("role", "list");
			this.chipBox.setAttribute("aria-label", "Destinatarios");
		} else {
			this.chipBox.removeAttribute("role");
			this.chipBox.removeAttribute("aria-label");
			nodes.push(el("span", "acp-to-empty", "Elegí a quién con + o @"));
		}
		this.chipBox.replaceChildren(...nodes);
		// Under the field: who it reaches, and who will queue it (dato real: /agents).
		// At most two lines (one each; CSS cuts the end — a topic's title — on a phone).
		// With a phone's keyboard up (`html[data-kb=open]`, acp-topic.css) only a
		// short queue line shows — names, no topic — and the reach line goes: both
		// variants are in the DOM and CSS picks one, so the keyboard opening or
		// closing renders nothing (the thread's box change alone moves nothing).
		const lines: HTMLElement[] = [];
		const to = c.team ? names : c.agents;
		if (c.team && names.length)
			lines.push(
				el(
					"div",
					"acp-to-note acp-to-reach",
					`Llega a ${names.map((n) => `@${n}`).join(", ")}, a cada uno por separado.`,
				),
			);
		const queued = to.flatMap((n) => {
			const busy = busyElsewhere(this.agents.get(n), this.topicId(), this.titleOf);
			return busy ? [{ n: `@${n}`, full: `@${n} (${busy})` }] : [];
		});
		if (queued.length) {
			const lead = queued.length > 1 ? "Les" : "Le";
			const full = queued.map((q) => q.full);
			lines.push(
				el(
					"div",
					"acp-to-note acp-to-queue",
					`${lead} queda en cola a ${
						full.length > 1 ? `${full.slice(0, -1).join(", ")} y ${full.at(-1)}` : full[0]
					}.`,
				),
				el(
					"div",
					"acp-to-note acp-to-queue-short",
					`${lead} queda en cola a ${queueShort(queued.map((q) => q.n))}.`,
				),
			);
		}
		this.toNotes.replaceChildren(...lines);
		this.toNotes.hidden = lines.length === 0;
	}

	private chipX(label: string, onClick: () => void): HTMLElement {
		const x = el("button", "acp-chip-x", "×");
		x.type = "button";
		x.setAttribute("aria-label", label);
		x.title = label;
		// Removing a chip while typing keeps the keyboard up (no blur).
		x.addEventListener("pointerdown", (e) => {
			if (document.activeElement === this.input) e.preventDefault();
		});
		x.addEventListener("click", onClick);
		return x;
	}

	/** The `@` menu follows the caret: open while an `@query` is being typed. */
	private syncMention(): void {
		if (this.source?.kind !== "conversation" || this.composerMode !== "on") {
			this.closeMention();
			return;
		}
		const q = mentionQuery(this.input.value, this.input.selectionStart ?? 0);
		if (!q) {
			this.closeMention();
			return;
		}
		const sameQuery = this.mention?.query === q.query;
		this.mention = { start: q.start, query: q.query, active: sameQuery ? this.mention!.active : 0 };
		this.renderMention();
	}

	private mentionOptions(): Array<{ key: string; label: string; sub: string }> {
		const q = this.mention?.query.toLowerCase() ?? "";
		const names = this.teamNames();
		const here = this.topicId();
		const out: Array<{ key: string; label: string; sub: string }> = [];
		if (
			names.length > 1 &&
			("todo el equipo".includes(q) || "equipo".startsWith(q) || "todos".startsWith(q))
		)
			out.push({ key: "*", label: "Todo el equipo", sub: `${names.length} agentes` });
		for (const n of names)
			if (n.toLowerCase().includes(q)) {
				const a = this.agents.get(n)!;
				const st = teamState(a, { here, titleOf: this.titleOf, interrupted: false });
				out.push({ key: n, label: `@${n}`, sub: st.label });
			}
		return out;
	}

	private renderMention(): void {
		const opts = this.mentionOptions();
		if (!this.mention || opts.length === 0) {
			this.closeMention();
			return;
		}
		const active = Math.min(this.mention.active, opts.length - 1);
		this.mention.active = active;
		const rows = opts.map((o, i) => {
			const r = el("div", "acp-mention-row");
			r.id = `${this.mentionList.id}-${i}`;
			r.setAttribute("role", "option");
			r.setAttribute("aria-selected", String(i === active));
			r.dataset.pick = o.key;
			const face = o.key === "*" ? el("span", "acp-avatar acp-avatar-team", "∗") : avatarOf(o.key);
			if (o.key !== "*") r.style.setProperty("--acp-hue", String(agentHue(o.key)));
			const text = el("span", "acp-mention-text");
			text.append(el("span", "acp-mention-name", o.label), el("span", "acp-mention-sub", o.sub));
			r.append(face, text);
			r.addEventListener("pointerdown", (e) => e.preventDefault());
			r.addEventListener("click", () => this.pickMention(o.key));
			return r;
		});
		this.mentionList.replaceChildren(...rows);
		this.mentionList.hidden = false;
		this.closePicker(false);
		this.input.setAttribute("aria-controls", this.mentionList.id);
		this.input.setAttribute("aria-expanded", "true");
		this.input.setAttribute("aria-activedescendant", rows[active]!.id);
	}

	private closeMention(): void {
		if (!this.mention && this.mentionList.hidden) return;
		this.mention = null;
		this.mentionList.hidden = true;
		this.mentionList.replaceChildren();
		this.input.removeAttribute("aria-activedescendant");
		this.input.removeAttribute("aria-expanded");
	}

	/** The `@query` typed leaves the text and becomes a chip. */
	private pickMention(key: string): void {
		const m = this.mention;
		if (!m) return;
		const i = this.input;
		const end = m.start + 1 + m.query.length;
		const rest = i.value.slice(end).replace(/^ /, "");
		i.value = i.value.slice(0, m.start) + rest;
		i.setSelectionRange(m.start, m.start);
		this.closeMention();
		this.addChip(key);
		this.renderHint();
		this.syncSendBtn();
	}

	/** The `@` menu's keys while it is open; true when the key was its. */
	private mentionKey(e: KeyboardEvent): boolean {
		if (!this.mention || this.mentionList.hidden) return false;
		const n = this.mentionList.childElementCount;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			this.mention.active = (this.mention.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
			this.renderMention();
			return true;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			const row = this.mentionList.children[this.mention.active] as HTMLElement | undefined;
			if (row?.dataset.pick) this.pickMention(row.dataset.pick);
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			this.closeMention();
			return true;
		}
		return false;
	}

	/** "+" in a topic: Todo el equipo and each agent, checked as the chips say. */
	private topicPickRows(): HTMLElement[] {
		const c = this.currentChips();
		const names = this.teamNames();
		const here = this.topicId();
		const row = (
			key: string,
			checked: boolean,
			face: HTMLElement,
			name: string,
			sub: string,
			locked = false,
		) => {
			const b = el("button", `acp-pick-row${checked ? " checked" : ""}`);
			b.type = "button";
			b.tabIndex = -1;
			b.dataset.agent = key;
			b.setAttribute("role", "menuitemcheckbox");
			b.setAttribute("aria-checked", String(checked));
			const mark = el("span", "acp-pick-mark", checked ? "✓" : "");
			mark.setAttribute("aria-hidden", "true");
			const info = el("span", "acp-pick-info");
			info.append(face, el("span", "acp-pick-name", name), el("span", "acp-pick-state", sub));
			if (locked) b.setAttribute("aria-disabled", "true");
			b.append(mark, info);
			b.addEventListener("click", () => {
				if (locked) return;
				if (key === "*") this.setChips({ team: !c.team, agents: [] });
				else if (checked) this.setChips({ team: false, agents: c.agents.filter((x) => x !== key) });
				else this.addChip(key);
			});
			return b;
		};
		const out: HTMLElement[] = [];
		if (names.length > 1)
			out.push(
				row(
					"*",
					c.team,
					el("span", "acp-avatar acp-avatar-team", "∗"),
					`Todo el equipo · ${names.length}`,
					"a cada uno por separado",
				),
			);
		for (const n of names) {
			const st = teamState(this.agents.get(n)!, {
				here,
				titleOf: this.titleOf,
				interrupted: false,
			});
			const face = avatarOf(n);
			face.style.setProperty("--acp-hue", String(agentHue(n)));
			out.push(
				row(
					n,
					c.team || c.agents.includes(n),
					face,
					`@${n}`,
					c.team ? "en Todo el equipo" : st.label,
					c.team,
				),
			);
		}
		return out;
	}

	// ── Sending ─────────────────────────────────────────────────────────

	private async send(): Promise<void> {
		const src = this.source;
		const text = this.input.value;
		// Checked before the reservation below: a locked box keeps its draft.
		// Only a topic is written to (an Archive chat has no message box).
		if (this.composerMode !== "on" || src?.kind !== "conversation" || text.trim() === "") return;
		this.notice = "";
		// A topic without recipients sends nothing — and keeps the text where it is.
		if (this.agents.size > 0) {
			const r = this.recipients(text);
			if (r.error) {
				this.notice = r.error;
				this.renderComposer();
				if (!this.pickBtn.hidden) flash(this.toRow, false);
				return;
			}
		}
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
		const to = this.recipients(text);
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
			// A topic: one post, one row per recipient under one client id (the
			// topic keeps who it went to). An attachment is per recipient (each
			// agent reads it from its own session): those go one by one.
			const asPost = !tooBig;
			if (asPost) {
				try {
					const r = await acpPost(src.conversationId, to.team ? "team" : to.to, text, clientId);
					// What the topic keeps now (the server stored the same): the
					// chips go back to being the topic's own.
					if (this.topicId() === src.conversationId && this.conversation) {
						this.conversation = {
							...this.conversation,
							recipients: to.team ? { team: true } : { agents: to.to },
						};
						this.chips.delete(src.conversationId);
					}
					if (sameChat(this.source, src))
						for (const row of r.messages)
							if (this.relevant(row)) {
								this.noteLive({ row });
								this.messages = upsert(this.messages, row);
							}
				} catch (err) {
					const why = SEND_REFUSED.get((err as { code?: string }).code ?? "");
					failed.push(...to.to.map((n) => (why ? `@${n} (${why})` : `@${n}`)));
				}
			}
			for (const name of asPost ? [] : to.to) {
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
						conversationId: src.conversationId,
						clientId,
					});
					if (sameChat(this.source, src) && this.relevant(row)) {
						this.noteLive({ row });
						this.messages = upsert(this.messages, row);
					}
				} catch (err) {
					const why = SEND_REFUSED.get((err as { code?: string }).code ?? "");
					failed.push(why ? `@${name} (${why})` : `@${name}`);
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

/**
 * The refusals a person can act on, in fixed words (never the server's own
 * text): retrying the same send would fail the same way, so they say why.
 * Any other failure is just "No se envió a @x." — a retry may well work.
 */
const SEND_REFUSED = new Map([
	["not-in-project", "ya no está en este proyecto"],
	["unknown-recipient", "ese agente ya no existe"],
	["project-not-found", "el proyecto ya no existe"],
	["conversation-archived", "la conversación está archivada"],
	["conversation-not-found", "la conversación ya no existe"],
]);

/**
 * A brief highlight on what was gone to: a 2-px ring and a tint, held
 * 1200 ms then faded in 600 ms (acp-chat.css); with reduced motion, no
 * transition: held 1500 ms and removed at once. Never moves the layout.
 */
function flash(target: HTMLElement, question: boolean): void {
	const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
	target.classList.remove("acp-msg-flash", "acp-msg-flash-out", "acp-msg-flash-warn");
	target.classList.add("acp-msg-flash");
	if (question) target.classList.add("acp-msg-flash-warn");
	const clear = () =>
		target.classList.remove("acp-msg-flash", "acp-msg-flash-out", "acp-msg-flash-warn");
	if (still) {
		setTimeout(clear, 1500);
		return;
	}
	setTimeout(() => {
		target.classList.add("acp-msg-flash-out");
		setTimeout(clear, 600);
	}, 1200);
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
		: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function agentId(name: string): HTMLElement {
	const id = el("span", "acp-msg-who acp-agent-id");
	// The hook of an agent's menu in a topic (acpConversation.ts).
	id.dataset.agent = name;
	id.append(el("span", "acp-avatar", name.slice(0, 1).toUpperCase()), `@${name}`);
	id.style.setProperty("--acp-hue", String(agentHue(name)));
	return id;
}

/** An agent's round initial in its colour (decorative: its @name is next to it). */
function avatarOf(name: string): HTMLElement {
	const a = el("span", "acp-avatar", name.slice(0, 1).toUpperCase());
	a.style.setProperty("--acp-hue", String(agentHue(name)));
	a.setAttribute("aria-hidden", "true");
	return a;
}

/** Marks a bubble as said by that agent (its colour accent, see .acp-voice). */
function agentVoice(bubble: HTMLElement, name: string): void {
	bubble.classList.add("acp-voice");
	bubble.style.setProperty("--acp-hue", String(agentHue(name)));
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
/** «@dev», «@dev y @qa», «@dev, @qa y 1 más»: the keyboard-up queue line's names. */
function queueShort(names: readonly string[]): string {
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} y ${names[1]}`;
	return `${names[0]}, ${names[1]} y ${names.length - 2} más`;
}

function newText(n: number): string {
	return `${n} ${n === 1 ? "mensaje nuevo" : "mensajes nuevos"}`;
}

function sourceKey(src: ThreadSource): string {
	return src.kind === "conversation"
		? `c:${src.conversationId}`
		: src.agent
			? `a:${src.projectId}:${src.agent}`
			: `p:${src.projectId}`;
}

function feedOf(src: ThreadSource, before?: number) {
	return src.kind === "conversation"
		? acpConversationFeed(src.conversationId, before)
		: src.agent
			? acpFeed(src.agent, before)
			: acpProjectFeed(src.projectId, before);
}

/** «Nuevos desde tu última visita»: a line across the thread, not a row (no anchor). */
function dividerEl(): HTMLElement {
	const d = el("div", "acp-divider");
	d.setAttribute("role", "separator");
	d.append(el("span", "acp-divider-text", "Nuevos desde tu última visita"));
	return d;
}

/** An agent's text (its answer, a consult, a system note): Markdown. */
function agentText(text: string): HTMLElement {
	const box = el("div", "acp-msg-body acp-md");
	box.append(markdownBlock(text));
	return box;
}

/** Same chat, whatever object `open()` was given (a return to it creates a new one). */
function sameChat(a: ThreadSource | null, b: ThreadSource): boolean {
	return a !== null && sourceKey(a) === sourceKey(b);
}
