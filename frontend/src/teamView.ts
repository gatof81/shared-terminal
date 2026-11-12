/**
 * teamView.ts — the Projects v3 workspace (approved UX v3, 2026-11-11):
 * Now (agents · For you · Threads), a thread, and New task, on the project
 * page. Exists only with `features.projectConversation` (api.ts
 * projectConversationEnabled); projectsView mounts it in place of the P3a
 * directory, which stays one link away (`#/projects/<pid>/agents`).
 *
 * The workspace element of a project is created once and kept across the
 * project page's polls, like the pilot panel: the composers (drafts,
 * recipients, focus) live in it and are never rebuilt by a re-render.
 *
 * Layout follows the space the page actually has (container queries in
 * styles/team.css), never the window: three columns when wide, For you
 * folded into the left column when narrower, one pane at a time on a
 * phone — no horizontal scroll at any width.
 *
 * What it never does: decide anything from local state that the log
 * decides (For you, delivery states, which reply answers what), read
 * meaning into agent text, retry a send, or offer "Done" without the
 * owner event that would make it true on every device (#587).
 */

import {
	type AgentListEntry,
	fetchProjectArtifactText,
	listWorkspaceDir,
	type ProjectMessageBody,
	postProjectAck,
	postProjectMessage,
	projectArtifactsEnabled,
	registerProjectArtifact,
	type WorkspaceEntry,
	WorkspaceFsError,
} from "./api.js";
import { explainCode, validateText } from "./composerText.js";
import { clock as clockText } from "./conversationModel.js";
import { type DiffRow, parseUnifiedDiff } from "./diff.js";
import { appendDiffRows } from "./diffTable.js";
import { relativeDate } from "./format.js";
import {
	POLL_ACTIVE_MS,
	type PresenceView,
	presentPresence,
	type ServerClock,
} from "./projectModel.js";
import { navigateProject, type ProjectPanel, projectRouteHash, routeHash } from "./router.js";
import { logStore, type ProjectLogStore, resetLogStores } from "./teamLog.js";
import {
	ARTIFACT_MAX_BYTES,
	type ArtifactRef,
	ackTargetOf,
	answerStates,
	buildThreads,
	type DeliveryState,
	type DeliveryView,
	deliveryText,
	deliveryTone,
	type ForYouItem,
	forYou,
	type LogReplyRef,
	type LogReplySettling,
	looksLikeDiff,
	MAX_ARTIFACTS,
	MAX_RECIPIENTS,
	type MessageView,
	mentionAt,
	type ProjectLog,
	partialDeliveryText,
	postErrorText,
	type QuoteRef,
	recipientsToSend,
	registerErrorText,
	sizeText,
	type ThreadSummary,
	threadRootOf,
	unrootedMessages,
} from "./teamModel.js";
import { button, el } from "./ui.js";

/** While the project socket is live, the log is still re-read this often (a missed frame can't linger). */
const LIVE_SAFETY_POLL_MS = 30_000;

// ── Context from the project page ───────────────────────────────────────────

export interface WorkspaceContext {
	projectId: string;
	panel: ProjectPanel | null;
	/** The project's agents from the directory poll; null until it answered. */
	agents: AgentListEntry[] | null;
	clock: ServerClock | null;
	/** The project page's header (title, close) — kept from P3a. */
	header: HTMLElement;
}

interface Agents {
	byId: Map<string, AgentListEntry>;
	list: AgentListEntry[];
	presence: Map<string, PresenceView>;
}

function agentsOf(ctx: WorkspaceContext): Agents {
	const list = ctx.agents ?? [];
	const now = Date.now();
	const presence = new Map<string, PresenceView>();
	for (const a of list) presence.set(a.agentId, presentPresence(a.presence, ctx.clock, now));
	return { byId: new Map(list.map((a) => [a.agentId, a])), list, presence };
}

function handleOf(agents: Agents, id: string): string {
	const a = agents.byId.get(id);
	return a ? `@${a.handle}` : "a removed agent";
}

/** Two letters for the avatar, from the handle ("dev-pilot" → "DP"). */
function initials(handle: string): string {
	const parts = handle.split("-").filter(Boolean);
	const s = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : handle.slice(0, 2);
	return s.toUpperCase();
}

/** A stable hue per agent id, so an agent keeps its colour everywhere. */
function hueOf(id: string): number {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
	return h;
}

/**
 * `dot`: the live presence dot. Left off the avatars inside a thread's
 * replies: presence changes on its own (evidence ages), and a dot in a row
 * would make that row — and the timeline — differ without any reply
 * changing, which would reset the person's text selection there.
 */
function avatar(agents: Agents, id: string, small = false, dot = true): HTMLElement {
	const a = agents.byId.get(id);
	const av = el("span", small ? "tw-av tw-av-s" : "tw-av", a ? initials(a.handle) : "?");
	av.setAttribute("aria-hidden", "true");
	av.style.setProperty("--tw-hue", String(hueOf(id)));
	const p = agents.presence.get(id);
	if (p && dot) av.appendChild(el("span", `tw-dot tw-dot-${p.tone}`));
	return av;
}

function link(
	text: string,
	className: string,
	href: string,
	onClick: () => void,
): HTMLAnchorElement {
	const a = el("a", className, text);
	a.href = href;
	a.addEventListener("click", (e) => {
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		onClick();
	});
	return a;
}

function go(projectId: string, panel: ProjectPanel | null): void {
	navigateProject(panel ? { projectId, agentId: null, panel } : { projectId, agentId: null });
}

function panelHref(projectId: string, panel: ProjectPanel | null): string {
	return projectRouteHash(
		panel ? { projectId, agentId: null, panel } : { projectId, agentId: null },
	);
}

// ── Composer ────────────────────────────────────────────────────────────────

type SendPhase =
	| { kind: "idle" }
	| { kind: "sending"; body: ProjectMessageBody }
	/**
	 * No answer (network), an unreadable one, or — after a Check — ANY
	 * error: the outcome is NOT known (the first POST may have delivered).
	 */
	| { kind: "unknown"; body: ProjectMessageBody; reason?: string }
	| { kind: "refused"; message: string }
	/** Accepted (202): the answer's per-recipient results, until the next send. */
	| {
			kind: "sent";
			msgId: string;
			results: SendResult[];
	  };

interface SendResult {
	agentId: string;
	state: DeliveryState | undefined;
	reason?: string;
	filesPossiblyPlaced?: boolean;
	artifactError?: string | null;
}

interface ReplyTarget {
	agentId: string;
	quoteRef: QuoteRef;
	inReplyTo: string;
}

/**
 * One composer: chosen recipients as chips, the text, and the send. Kept
 * as one element per thread (or per New task) so a poll never touches the
 * draft. Typing "@" opens the picker at the caret; choosing an agent adds
 * the chip AND leaves "@handle" as plain text — only chips are sent.
 */
class Composer {
	readonly root = el("form", "tw-composer");
	private chips = el("div", "tw-to");
	private text = el("textarea", "tw-text");
	private picker = el("div", "tw-picker");
	private hint = el("p", "tw-hint");
	private status = el("div", "tw-send-status");
	private send = el("button", "tw-btn tw-btn-pri", "Send");
	private quote = el("div", "tw-quote");
	/** D2: the attached files (registered already), and the picker that adds them. */
	private filesRow = el("div", "tw-files");
	private attach: AttachPicker | null = null;
	private files: ArtifactRef[] = [];
	/** Bumped when a send starts: a file answered for an earlier draft never joins a later one. */
	private draftGen = 0;
	private chosen: string[] = [];
	private agents: Agents = { byId: new Map(), list: [], presence: new Map() };
	private phase: SendPhase = { kind: "idle" };
	private replyTarget: ReplyTarget | null = null;
	private pickerOpen = false;
	private pickerIndex = 0;

	constructor(
		private projectId: string,
		private mode: "task" | "thread",
		/** Thread composers answer their thread's root unless replying to a reply. */
		private rootId: string | null,
		private onSent: (msgId: string) => void,
	) {
		this.root.setAttribute("aria-label", mode === "task" ? "New task" : "Reply in this thread");
		this.root.noValidate = true;
		this.text.rows = mode === "task" ? 6 : 2;
		this.text.placeholder =
			mode === "task"
				? "Describe the task… (type @ to choose who receives it)"
				: "Reply in this thread… (@ to choose)";
		this.text.setAttribute("aria-label", "Message");
		this.send.type = "submit";
		this.picker.setAttribute("role", "listbox");
		this.picker.setAttribute("aria-label", "Choose a recipient");
		this.picker.hidden = true;
		this.quote.hidden = true;
		this.status.setAttribute("role", "status");
		const row = el("div", "tw-compose-row");
		row.append(this.text, this.send);
		this.filesRow.hidden = true;
		this.root.append(this.chips, this.quote, this.picker);
		// Attachments exist only with features.projectArtifacts: without it no
		// control is shown and no request to …/artifacts is ever made (A.2).
		if (projectArtifactsEnabled()) {
			this.attach = new AttachPicker(
				projectId,
				(f, draft) => this.addFile(f, draft),
				() => this.draftGen,
			);
			this.root.append(this.filesRow, this.attach.root);
			this.renderFiles();
		}
		this.root.append(row, this.hint, this.status);
		this.text.addEventListener("input", () => this.onInput());
		this.text.addEventListener("keydown", (e) => this.onKey(e));
		this.text.addEventListener("click", () => this.onInput());
		this.root.addEventListener("submit", (e) => {
			e.preventDefault();
			void this.submit();
		});
	}

	/**
	 * Once the sent message is in the log, its per-recipient results come
	 * from there (a delivery still `sending` at the 202 ends later, §3.3);
	 * the 202's snapshot is only what is shown before that.
	 */
	syncResults(log: ProjectLog): void {
		if (this.phase.kind !== "sent") return;
		const m = log.messages.get(this.phase.msgId);
		if (!m) return;
		const results: SendResult[] = m.message.to.map((agentId) => {
			const d = m.deliveries.get(agentId);
			return {
				agentId,
				state: d?.state,
				reason: d?.reason ?? undefined,
				filesPossiblyPlaced: d?.filesPossiblyPlaced ?? false,
				artifactError: d?.artifactError ?? null,
			};
		});
		const prev = this.phase.results;
		const same = results.every(
			(r, i) =>
				r.state === prev[i]?.state &&
				r.filesPossiblyPlaced === (prev[i]?.filesPossiblyPlaced ?? false) &&
				r.artifactError === (prev[i]?.artifactError ?? null),
		);
		if (!same) this.setPhase({ kind: "sent", msgId: this.phase.msgId, results });
	}

	setAgents(agents: Agents): void {
		this.agents = agents;
		this.attach?.setAgents(agents);
		this.renderChips();
		if (this.pickerOpen) this.renderPicker();
	}

	/** Prefill a reply to one agent's reply (quote_ref names exactly it). */
	replyTo(t: ReplyTarget): void {
		this.replyTarget = t;
		if (!this.chosen.includes(t.agentId)) this.chosen = [t.agentId];
		this.renderChips();
		this.quote.replaceChildren(
			el("span", undefined, `Replying to ${handleOf(this.agents, t.agentId)}'s reply`),
			button("×", "tw-x", () => this.clearReply(), "Don't quote this reply"),
		);
		this.quote.hidden = false;
		this.text.focus();
	}

	private clearReply(): void {
		this.replyTarget = null;
		this.quote.hidden = true;
		this.quote.replaceChildren();
	}

	focus(): void {
		this.text.focus();
	}

	private canReceive(a: AgentListEntry): string | null {
		if (a.binding === null || a.binding.state !== "active") return "no session bound";
		const p = this.agents.presence.get(a.agentId);
		if (p?.tone === "attention") return "waiting for a permission in its Terminal";
		if (p?.tone === "off") return p.reason ?? "not running";
		return null;
	}

	private renderChips(): void {
		const nodes: HTMLElement[] = [el("span", "tw-to-label", "To")];
		for (const id of this.chosen) {
			const chip = el("span", "tw-chip");
			chip.style.setProperty("--tw-hue", String(hueOf(id)));
			chip.append(el("span", undefined, handleOf(this.agents, id)));
			chip.append(
				button("×", "tw-x", () => this.remove(id), `Remove ${handleOf(this.agents, id)}`),
			);
			nodes.push(chip);
		}
		if (this.chosen.length < MAX_RECIPIENTS)
			nodes.push(
				button("+ add", "tw-chip tw-chip-add", () => this.openPicker(null), "Add a recipient"),
			);
		replaceIfChanged(this.chips, nodes);
		this.hint.textContent =
			this.chosen.length === 0
				? "Nobody receives it until you choose agents. An @name in the text is just text."
				: `Only ${this.chosen.map((id) => handleOf(this.agents, id)).join(", ")} will receive this.`;
	}

	private remove(id: string): void {
		this.chosen = this.chosen.filter((x) => x !== id);
		if (this.replyTarget?.agentId === id) this.clearReply();
		this.renderChips();
	}

	private add(id: string): void {
		if (!this.chosen.includes(id) && this.chosen.length < MAX_RECIPIENTS) this.chosen.push(id);
		this.renderChips();
	}

	private addFile(f: ArtifactRef, draft: number): string | null {
		if (draft !== this.draftGen) return "Not attached: the draft changed meanwhile.";
		if (this.phase.kind === "sending" || this.phase.kind === "unknown")
			return "Wait until this message's outcome is known.";
		if (this.files.some((x) => x.sha256 === f.sha256)) return "That file is already attached.";
		if (this.files.length >= MAX_ARTIFACTS)
			return `A message carries at most ${MAX_ARTIFACTS} files.`;
		this.files.push(f);
		this.renderFiles();
		return null;
	}

	private renderFiles(): void {
		const locked = this.phase.kind === "sending" || this.phase.kind === "unknown";
		const nodes: HTMLElement[] = [];
		for (const f of this.files) {
			const chip = el("span", "tw-file-chip");
			chip.append(el("span", "tw-file-name", f.name), el("span", "tw-muted", sizeText(f.bytes)));
			if (!locked)
				chip.append(
					button(
						"×",
						"tw-x",
						() => {
							this.files = this.files.filter((x) => x.sha256 !== f.sha256);
							this.renderFiles();
						},
						`Remove ${f.name}`,
					),
				);
			nodes.push(chip);
		}
		this.filesRow.hidden = nodes.length === 0;
		replaceIfChanged(this.filesRow, nodes);
		this.attach?.setFull(this.files.length >= MAX_ARTIFACTS || locked);
	}

	private mentionQuery: { start: number; query: string } | null = null;

	private onInput(): void {
		const m = mentionAt(this.text.value, this.text.selectionStart ?? this.text.value.length);
		this.mentionQuery = m;
		if (m) this.openPicker(m.query);
		else this.closePicker();
	}

	private filtered(): AgentListEntry[] {
		const q = this.mentionQuery?.query ?? "";
		return this.agents.list.filter(
			(a) => a.handle.startsWith(q) && !this.chosen.includes(a.agentId),
		);
	}

	private openPicker(_q: string | null): void {
		this.pickerOpen = true;
		this.pickerIndex = 0;
		this.renderPicker();
	}

	private closePicker(): void {
		this.pickerOpen = false;
		this.picker.hidden = true;
		this.mentionQuery = null;
	}

	private renderPicker(): void {
		const list = this.filtered();
		const nodes: HTMLElement[] = [el("p", "tw-picker-title", "ADD TO RECIPIENTS")];
		if (list.length === 0) nodes.push(el("p", "tw-picker-empty", "No other agent matches."));
		list.forEach((a, i) => {
			const why = this.canReceive(a);
			const opt = el("button", "tw-option");
			opt.type = "button";
			opt.setAttribute("role", "option");
			opt.setAttribute("aria-selected", String(i === this.pickerIndex));
			opt.disabled = why !== null;
			opt.append(avatar(this.agents, a.agentId, true));
			const t = el("span", "tw-option-text");
			t.append(el("b", undefined, `@${a.handle}`));
			t.append(
				el(
					"span",
					"tw-muted",
					why ?? `${a.role ?? "agent"} · ${this.agents.presence.get(a.agentId)?.label ?? ""}`,
				),
			);
			opt.append(t);
			opt.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret in the text
			opt.addEventListener("click", () => this.pick(a));
			nodes.push(opt);
		});
		this.picker.replaceChildren(...nodes);
		this.picker.hidden = false;
	}

	private pick(a: AgentListEntry): void {
		const m = this.mentionQuery;
		if (m) {
			// "@par" → "@handle " as plain text; the chip is what is sent.
			const v = this.text.value;
			const caret = this.text.selectionStart ?? v.length;
			const insert = `@${a.handle} `;
			this.text.value = v.slice(0, m.start) + insert + v.slice(caret);
			const pos = m.start + insert.length;
			this.text.setSelectionRange(pos, pos);
		}
		this.add(a.agentId);
		this.closePicker();
		this.text.focus();
	}

	private onKey(e: KeyboardEvent): void {
		if (this.pickerOpen) {
			const list = this.filtered().filter((a) => this.canReceive(a) === null);
			if (e.key === "Escape") {
				e.preventDefault();
				this.closePicker();
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && list.length > 0 && this.mentionQuery) {
				e.preventDefault();
				this.pick(list[Math.min(this.pickerIndex, list.length - 1)]!);
				return;
			}
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const n = this.filtered().length;
				if (n > 0) this.pickerIndex = (this.pickerIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
				this.renderPicker();
				return;
			}
		}
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void this.submit();
		}
	}

	private setPhase(p: SendPhase): void {
		this.phase = p;
		const busy = p.kind === "sending";
		this.send.disabled = busy;
		this.text.readOnly = busy || p.kind === "unknown";
		if (this.attach) this.renderFiles();
		this.status.replaceChildren();
		this.status.className = `tw-send-status tw-send-${p.kind}`;
		if (p.kind === "sending") {
			const names = p.body.to.map((id) => handleOf(this.agents, id)).join(", ");
			this.status.append(
				el("span", undefined, `Sending to ${names}… (it can take up to half a minute)`),
			);
		} else if (p.kind === "unknown") {
			this.status.append(
				el(
					"span",
					undefined,
					"No answer from the server: it may or may not have been sent. Checking asks the server about this same message — it never sends it twice.",
				),
				...(p.reason ? [el("span", "tw-muted", p.reason)] : []),
				button("Check", "tw-btn", () => void this.post(p.body, true)),
				button("Discard", "tw-btn tw-btn-ghost", () => this.setPhase({ kind: "idle" })),
			);
		} else if (p.kind === "refused") {
			this.status.append(el("span", undefined, p.message));
		} else if (p.kind === "sent") {
			// A 202 is the server's acceptance, not every agent's receipt:
			// each recipient's result, in words (§3.3 step 4).
			const partial = partialDeliveryText(p.results.map((r) => r.state));
			if (partial) this.status.append(el("b", "tw-partial", partial));
			const ul = el("ul", "tw-results");
			for (const r of p.results) {
				const who = handleOf(this.agents, r.agentId);
				const tone = r.state === undefined ? "pending" : deliveryTone(r.state);
				const words =
					r.state === undefined
						? "Sending…"
						: tone === "ok"
							? "Delivered ✓"
							: deliveryText({
									state: r.state,
									reason: r.reason ?? null,
									filesPossiblyPlaced: r.filesPossiblyPlaced ?? false,
									artifactError: r.artifactError ?? null,
								});
				ul.append(el("li", `tw-del tw-del-${tone}`, `${who} · ${words}`));
			}
			this.status.append(ul);
		}
	}

	private async submit(): Promise<void> {
		if (this.phase.kind === "sending" || this.phase.kind === "unknown") return;
		if (this.phase.kind === "sent") this.setPhase({ kind: "idle" });
		const r = recipientsToSend(this.chosen);
		if ("error" in r) {
			this.setPhase({ kind: "refused", message: r.error });
			return;
		}
		const v = validateText(this.text.value);
		if (!v.ok) {
			this.setPhase({ kind: "refused", message: explainCode(v.code) });
			return;
		}
		const body: ProjectMessageBody = {
			clientMessageId: crypto.randomUUID(),
			text: this.text.value,
			to: r.to,
		};
		if (this.files.length > 0) body.artifacts = this.files.map((f) => f.sha256);
		const inReplyTo = this.replyTarget?.inReplyTo ?? this.rootId;
		if (inReplyTo) body.inReplyTo = inReplyTo;
		if (this.replyTarget && r.to.includes(this.replyTarget.agentId))
			body.quoteRef = this.replyTarget.quoteRef;
		await this.post(body);
	}

	/**
	 * `check`: this is the SAME message again (same clientMessageId) after a
	 * lost answer. The server answers what it stored (§3.4 rule 2); an error
	 * here only means it couldn't answer the check — never "nothing was
	 * sent" — so the outcome stays unknown and the draft stays locked.
	 */
	private async post(body: ProjectMessageBody, check = false): Promise<void> {
		// Whatever is being attached now belongs to the draft being sent away.
		this.draftGen++;
		this.setPhase({ kind: "sending", body });
		const a = await postProjectMessage(this.projectId, body);
		if (a.ok) {
			this.text.value = "";
			this.text.readOnly = false;
			this.clearReply();
			if (this.mode === "task") this.chosen = [];
			this.files = [];
			this.renderChips();
			const results: SendResult[] = answerStates(body.to, a.body.deliveries).map((r) => {
				const d = a.body.deliveries.find((x) => x.agentId === r.agentId);
				return { ...r, reason: d?.reason, filesPossiblyPlaced: d?.filesPossiblyPlaced === true };
			});
			this.setPhase({ kind: "sent", msgId: a.body.msgId, results });
			this.onSent(a.body.msgId);
			return;
		}
		if (a.code === "stale") return;
		if (a.code === "network" || a.code === "bad-answer" || (a.status >= 500 && a.code === "")) {
			this.setPhase({ kind: "unknown", body });
			return;
		}
		if (check) {
			this.setPhase({
				kind: "unknown",
				body,
				reason: `The server couldn't answer the check (${a.code || a.status}). Try Check again later; don't send it again until you know.`,
			});
			return;
		}
		// The server refused before any effect: nothing was sent; the draft stays.
		this.setPhase({ kind: "refused", message: postErrorText(a.code, a.status) });
	}
}

// ── Attach a file (D2, §6.1) ────────────────────────────────────────────────

type Listing =
	| { kind: "loading" }
	| { kind: "ok"; entries: WorkspaceEntry[]; truncated: boolean }
	| { kind: "error"; message: string };

/**
 * Choose a file of an agent's bound session and register it (§6.1.1). The
 * browsing is the Files view's own read-only listing (owner-only, host
 * bind mount); registering is the server's decision every time — what the
 * listing marks protected or too big is only explained here, not enforced.
 * Nothing is attached until the server answered 200/201 with its sha256.
 */
class AttachPicker {
	readonly root = el("div", "tw-attach");
	private toggle = el("button", "tw-btn tw-btn-ghost tw-attach-btn", "Attach file");
	private panel = el("div", "tw-attach-panel");
	private note = el("p", "tw-attach-note");
	private agents: Agents = { byId: new Map(), list: [], presence: new Map() };
	private open = false;
	private full = false;
	private agentId: string | null = null;
	private sessionId: string | null = null;
	private path = "";
	private listing: Listing = { kind: "loading" };
	private gen = 0;
	/**
	 * The person's current choice (open panel, agent, session). Every change
	 * of it — choosing another agent, the binding moving, closing the panel,
	 * a send locking or emptying the draft — bumps it, so an answer to a
	 * registration started under an earlier choice never edits the draft.
	 */
	private choice = 0;
	private registering: { choice: number; name: string } | null = null;

	constructor(
		private projectId: string,
		/** Returns why the file couldn't be added to the draft, or null. */
		private onAttached: (f: ArtifactRef, draft: number) => string | null,
		/** The composer's draft generation (a new one after every send). */
		private draft: () => number,
	) {
		this.toggle.type = "button";
		this.toggle.setAttribute("aria-expanded", "false");
		this.toggle.addEventListener("click", () => this.setOpen(!this.open));
		this.panel.hidden = true;
		this.panel.setAttribute("role", "group");
		this.panel.setAttribute("aria-label", "Attach a file");
		this.note.setAttribute("role", "status");
		this.root.append(this.toggle, this.panel, this.note);
	}

	setAgents(agents: Agents): void {
		this.agents = agents;
		if (!this.open) return;
		// The agent's binding moved: what was being browsed is another session's.
		const sid = this.boundSession(this.agentId);
		if (this.agentId !== null && sid !== this.sessionId) this.choose(null);
		else this.render();
	}

	setFull(full: boolean): void {
		this.full = full;
		this.toggle.disabled = full;
		if (full && this.open) this.setOpen(false);
	}

	private boundSession(agentId: string | null): string | null {
		if (agentId === null) return null;
		const b = this.agents.byId.get(agentId)?.binding;
		return b && b.state === "active" ? b.sessionId : null;
	}

	/** A new choice: whatever registration is in flight no longer edits the draft. */
	private newChoice(): void {
		this.choice++;
		this.registering = null;
	}

	private setOpen(open: boolean): void {
		this.newChoice();
		this.open = open && !this.full;
		this.toggle.setAttribute("aria-expanded", String(this.open));
		this.panel.hidden = !this.open;
		if (this.open) {
			this.note.textContent = "";
			const bound = this.agents.list.filter((a) => this.boundSession(a.agentId) !== null);
			this.choose(bound.length === 1 ? bound[0]!.agentId : null);
		}
	}

	private choose(agentId: string | null): void {
		this.newChoice();
		this.agentId = agentId;
		this.sessionId = this.boundSession(agentId);
		this.path = "";
		if (this.sessionId) void this.load();
		else this.render();
	}

	private async load(): Promise<void> {
		const gen = ++this.gen;
		const sid = this.sessionId;
		if (!sid) return;
		this.listing = { kind: "loading" };
		this.render();
		let next: Listing;
		try {
			const l = await listWorkspaceDir(sid, this.path);
			next = { kind: "ok", entries: l.entries, truncated: l.truncated };
		} catch (err) {
			next = {
				kind: "error",
				message:
					err instanceof WorkspaceFsError && err.status === 404
						? "That folder isn't there any more."
						: "Couldn't list this folder.",
			};
		}
		if (gen !== this.gen) return; // another folder or agent was chosen meanwhile
		this.listing = next;
		this.render();
	}

	private go(path: string): void {
		this.path = path;
		void this.load();
	}

	private async register(name: string): Promise<void> {
		const agentId = this.agentId;
		const sid = this.sessionId;
		if (!agentId || !sid || this.registering) return;
		const path = this.path ? `${this.path}/${name}` : name;
		const choice = this.choice;
		const draft = this.draft();
		this.registering = { choice, name };
		this.note.textContent = `Attaching ${name}…`;
		this.render();
		const a = await registerProjectArtifact(this.projectId, { agentId, path });
		if (a.ok === false && a.code === "stale") return;
		// A late answer: the person moved on (another agent or session, closed
		// the panel, or sent / is sending the draft). The file may be
		// registered in the project, but it is NOT put in the current draft.
		if (choice !== this.choice || draft !== this.draft()) {
			// …and its note never covers a newer registration's "Attaching…".
			if (this.registering === null)
				this.note.textContent = `${name} was not attached: the choice changed while it was being registered.`;
			return;
		}
		this.registering = null;
		if (a.ok) {
			const why = this.onAttached(
				{ sha256: a.body.sha256, name: a.body.name, bytes: a.body.bytes },
				draft,
			);
			this.note.textContent = why ?? `Attached ${a.body.name}.`;
			if (!why) this.setOpen(false);
			else this.render();
			return;
		}
		this.note.textContent = registerErrorText(a.code, a.status);
		this.render();
	}

	private render(): void {
		if (!this.open) return;
		const nodes: HTMLElement[] = [];
		const head = el("div", "tw-attach-agents");
		head.append(el("span", "tw-to-label", "From"));
		for (const a of this.agents.list) {
			const sid = this.boundSession(a.agentId);
			const b = el("button", "tw-chip tw-attach-agent", `@${a.handle}`);
			b.type = "button";
			b.disabled = sid === null;
			if (sid === null) b.title = "No session bound";
			b.setAttribute("aria-pressed", String(a.agentId === this.agentId));
			b.dataset.key = `attach-agent:${a.agentId}:${sid ?? ""}`;
			b.addEventListener("click", () => this.choose(a.agentId));
			head.append(b);
		}
		nodes.push(head);
		if (!this.agentId) {
			nodes.push(el("p", "tw-muted", "Choose whose workspace the file comes from."));
			replaceIfChanged(this.panel, nodes);
			return;
		}
		const crumbs = el("div", "tw-attach-path");
		crumbs.append(el("span", "tw-muted", `~/workspace/${this.path}`));
		nodes.push(crumbs);
		const list = el("ul", "tw-attach-list");
		if (this.path !== "") {
			const up = this.path.split("/").slice(0, -1).join("/");
			list.append(this.entryRow(`${up}/..`, "..", "Up one folder", false, () => this.go(up)));
		}
		if (this.listing.kind === "loading") nodes.push(el("p", "tw-muted", "Loading…"));
		else if (this.listing.kind === "error") nodes.push(el("p", "tw-muted", this.listing.message));
		else {
			for (const e of this.listing.entries) {
				const child = this.path ? `${this.path}/${e.name}` : e.name;
				if (e.type === "dir") {
					list.append(
						this.entryRow(child, `${e.name}/`, "Folder", e.restricted, () => this.go(child)),
					);
					continue;
				}
				const why = e.restricted
					? "protected"
					: e.type !== "file"
						? "not a regular file"
						: e.size !== null && e.size > ARTIFACT_MAX_BYTES
							? "bigger than 1 MiB"
							: e.size === 0
								? "empty"
								: null;
				list.append(
					this.entryRow(
						child,
						e.name,
						why ?? (e.size === null ? "" : sizeText(e.size)),
						why !== null || this.registering !== null,
						() => void this.register(e.name),
					),
				);
			}
			if (this.listing.entries.length === 0)
				nodes.push(el("p", "tw-muted", "This folder is empty."));
			if (this.listing.truncated)
				nodes.push(el("p", "tw-muted", "Only part of this folder is listed."));
		}
		nodes.splice(2, 0, list);
		// The workspace re-renders on every log event and poll (setAgents):
		// nodes that didn't change stay, so focus and a click in progress
		// survive. A kept node keeps its OLD listener, which is why each
		// button carries what its listener acts on (data-key = its path).
		replaceIfChanged(this.panel, nodes);
	}

	private entryRow(
		/** What the listener acts on: part of the node, so an equal node is the same action. */
		target: string,
		label: string,
		detail: string,
		disabled: boolean,
		onClick: () => void,
	): HTMLElement {
		const li = el("li");
		const b = el("button", "tw-attach-entry");
		b.type = "button";
		b.disabled = disabled;
		b.dataset.key = `attach:${this.sessionId}:${target}`;
		b.append(el("span", "tw-file-name", label), el("span", "tw-muted", detail));
		b.addEventListener("click", onClick);
		li.append(b);
		return li;
	}
}

// ── Thread scroll ───────────────────────────────────────────────────────────

/** Within this many px of the end, the reader is "at the end" and is followed. */
const FOLLOW_PX = 64;

/**
 * Where the reader is in a thread's timeline (the one scroll area of the
 * main column), per thread:
 *  - a thread opens at its newest messages, or where the reader left it;
 *  - new rows are followed only while the reader is at the end — a reader
 *    of earlier messages keeps their place (by the row they are looking at,
 *    not by a distance: rows are also inserted above, e.g. a reply landing
 *    between two messages) and is told how many arrived below;
 *  - a height change with no scroll (the phone keyboard opening, the
 *    composer growing a line) keeps the end in view for a reader who was
 *    there — `atEnd` still holds the truth from before the shrink, which
 *    fires no scroll event.
 * Every position write is instant: a smooth scroll would animate a restore.
 */
class ThreadScroll {
	private root: string | null = null;
	private atEnd = true;
	private saved = new Map<string, { top: number; atEnd: boolean }>();
	/** Rows (by seq) the reader has had at the end; anything newer below is "new". */
	private seenSeq = -1;
	readonly pill = el("button", "tw-newer");

	constructor(private readonly box: HTMLElement) {
		this.pill.type = "button";
		this.pill.hidden = true;
		this.pill.addEventListener("click", () => this.toEnd());
		box.addEventListener(
			"scroll",
			() => {
				this.atEnd = this.isAtEnd();
				if (this.root !== null)
					this.saved.set(this.root, { top: box.scrollTop, atEnd: this.atEnd });
				if (this.atEnd) this.clearNew();
			},
			{ passive: true },
		);
		if (typeof ResizeObserver !== "undefined")
			new ResizeObserver(() => {
				if (this.atEnd && box.isConnected) this.set(box.scrollHeight);
			}).observe(box);
	}

	private isAtEnd(): boolean {
		return this.box.scrollHeight - this.box.scrollTop - this.box.clientHeight < FOLLOW_PX;
	}

	private set(top: number): void {
		const prev = this.box.style.scrollBehavior;
		this.box.style.scrollBehavior = "auto";
		this.box.scrollTop = top;
		this.box.style.scrollBehavior = prev;
	}

	private toEnd(): void {
		this.set(this.box.scrollHeight);
		this.atEnd = true;
		this.clearNew();
	}

	private clearNew(): void {
		this.seenSeq = this.lastSeq();
		this.pill.hidden = true;
	}

	private lastSeq(): number {
		let max = -1;
		for (const c of this.box.children) {
			const n = Number((c as HTMLElement).dataset.seq);
			if (Number.isFinite(n) && n !== Number.MAX_SAFE_INTEGER && n > max) max = n;
		}
		return max;
	}

	/** The first row at least partly in view, and where its top edge sits. */
	private anchor(): { seq: string; offset: number } | null {
		const top = this.box.getBoundingClientRect().top;
		for (const c of this.box.children) {
			const r = c.getBoundingClientRect();
			const seq = (c as HTMLElement).dataset.seq;
			if (seq !== undefined && r.bottom > top) return { seq, offset: r.top - top };
		}
		return null;
	}

	/**
	 * Run `update` (which replaces the rows and puts the timeline in place),
	 * keeping the reader where they should be. `rootId` is the open thread.
	 */
	render(rootId: string, update: () => boolean): void {
		const wasShown = this.box.isConnected && this.box.clientHeight > 0;
		const switched = this.root !== rootId || !wasShown;
		const anchor = !switched && !this.atEnd ? this.anchor() : null;
		const changed = update();
		if (switched) {
			this.root = rootId;
			const s = this.saved.get(rootId);
			if (s && !s.atEnd) {
				this.set(s.top);
				this.atEnd = this.isAtEnd();
			} else this.toEnd();
			// What a thread shows when it is (re)opened is not "new".
			this.clearNew();
			return;
		}
		if (!changed) return;
		if (this.atEnd) {
			this.toEnd();
			return;
		}
		if (anchor) {
			const node = [...this.box.children].find(
				(c) => (c as HTMLElement).dataset.seq === anchor.seq,
			) as HTMLElement | undefined;
			if (node) {
				const now = node.getBoundingClientRect().top - this.box.getBoundingClientRect().top;
				this.set(this.box.scrollTop + (now - anchor.offset));
			}
		}
		const last = this.lastSeq();
		if (this.seenSeq < 0) this.seenSeq = last;
		const fresh = [...this.box.children].filter((c) => {
			const n = Number((c as HTMLElement).dataset.seq);
			return n > this.seenSeq && n !== Number.MAX_SAFE_INTEGER;
		}).length;
		if (fresh > 0) {
			this.pill.textContent = `↓ ${fresh} new`;
			this.pill.setAttribute("aria-label", `${fresh} new below — go to the latest`);
			this.pill.hidden = false;
		}
	}
}

// ── Workspace ───────────────────────────────────────────────────────────────

class Workspace {
	readonly root = el("div", "tw");
	private nowCol = el("section", "tw-now");
	private mainCol = el("section", "tw-main");
	private sideCol = el("aside", "tw-side");
	private store: ProjectLogStore;
	private composers = new Map<string, Composer>();
	private ctx: WorkspaceContext | null = null;
	private agents: Agents = { byId: new Map(), list: [], presence: new Map() };
	private timer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribe: (() => void) | null = null;
	private lastPanelKey = "";

	constructor(readonly projectId: string) {
		this.store = logStore(projectId);
		this.nowCol.setAttribute("aria-label", "Now");
		this.mainCol.setAttribute("aria-live", "off");
		this.sideCol.setAttribute("aria-label", "For you");
		this.root.append(this.nowCol, this.mainCol, this.sideCol);
	}

	update(ctx: WorkspaceContext): void {
		this.ctx = ctx;
		this.agents = agentsOf(ctx);
		if (!this.unsubscribe) {
			// First show, or back on screen after a suspend: read the newest page
			// now, then follow the log live (the poll stays as the safety net).
			let wasLive = this.store.live;
			this.unsubscribe = this.store.onChange(() => {
				// The socket just dropped (or came back): re-arm the poll at the
				// cadence that now applies, instead of waiting out a 30 s timer.
				if (this.store.live !== wasLive) {
					wasLive = this.store.live;
					if (this.timer) clearTimeout(this.timer);
					this.timer = null;
					this.schedule();
				}
				this.render();
			});
			void this.store.refresh().then(() => this.unsubscribe && this.store.startLive());
		}
		this.schedule();
		this.render();
	}

	/**
	 * Put these nodes in the main column, moving none that is already in
	 * place: re-inserting the composer would blur its textarea on every
	 * poll while the person types.
	 */
	private setMain(...nodes: HTMLElement[]): void {
		const cur = Array.from(this.mainCol.children);
		if (cur.length === nodes.length && cur.every((n, i) => n === nodes[i])) return;
		// Remove what isn't wanted, then insert the rest in order around what stays.
		for (const n of cur) if (!nodes.includes(n as HTMLElement)) n.remove();
		let ref: ChildNode | null = this.mainCol.firstChild;
		for (const n of nodes) {
			if (n === ref) {
				ref = ref.nextSibling;
				continue;
			}
			this.mainCol.insertBefore(n, ref);
		}
	}

	private mainHead = el("div", "tw-main-head");
	private timeline = el("ol", "tw-timeline");
	private scroll = new ThreadScroll(this.timeline);

	/** Off screen: stop polling (the log stays, a return renders at once). */
	suspend(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.store.stopLive();
	}

	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(
			() => {
				this.timer = null;
				if (!this.unsubscribe) return;
				// A first load that failed never started the socket: each poll tries
				// again (startLive is idempotent and needs a loaded log).
				if (document.visibilityState === "visible")
					void this.store.refresh().then(() => this.unsubscribe && this.store.startLive());
				this.schedule();
				// Live over the socket: the poll is only a safety net. Otherwise the
				// usual 5 s.
			},
			this.store.live ? LIVE_SAFETY_POLL_MS : POLL_ACTIVE_MS,
		);
	}

	private composer(key: string, mode: "task" | "thread", rootId: string | null): Composer {
		let c = this.composers.get(key);
		if (!c) {
			c = new Composer(this.projectId, mode, rootId, (msgId) => {
				void this.store.refreshAfterWrite();
				if (mode === "task") go(this.projectId, { kind: "thread", msgId });
			});
			this.composers.set(key, c);
		}
		c.setAgents(this.agents);
		c.syncResults(this.store.log);
		return c;
	}

	/**
	 * Re-render, keeping the keyboard user's place: the focused control is
	 * found again by its `data-key` (a For you card exists twice — inline
	 * and in the side column — so the visible one wins).
	 */
	private render(): void {
		const focused = document.activeElement;
		const key =
			focused instanceof HTMLElement && this.root.contains(focused)
				? focused.dataset.key
				: undefined;
		this.renderNow2();
		if (key === undefined || this.root.contains(document.activeElement)) return;
		// Compared as a property, not interpolated into a selector (keys carry server ids).
		const all = [...this.root.querySelectorAll<HTMLElement>("[data-key]")].filter(
			(n) => n.dataset.key === key,
		);
		const target = all.find((n) => n.getClientRects().length > 0) ?? all[0];
		target?.focus({ preventScroll: true });
	}

	private renderNow2(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const panel = ctx.panel;
		const panelKey = panel ? (panel.kind === "thread" ? `t:${panel.msgId}` : panel.kind) : "";
		this.root.classList.toggle("tw-has-panel", panel !== null);
		const items = this.forYouItems();
		this.renderNow(ctx, items);
		this.renderSide(items);
		if (panel?.kind === "thread") this.renderThread(panel.msgId);
		else if (panel?.kind === "new") this.renderNew();
		else this.renderEmptyMain();
		if (panelKey !== this.lastPanelKey) {
			this.lastPanelKey = panelKey;
			if (panel?.kind === "new") this.composers.get("new")?.focus();
		}
	}

	// ── For you ──

	private forYouItems(): Array<
		ForYouItem | { kind: "permission"; agent: AgentListEntry; view: PresenceView }
	> {
		const out: Array<
			ForYouItem | { kind: "permission"; agent: AgentListEntry; view: PresenceView }
		> = [];
		// Presence first: an agent stopped at a prompt blocks work right now.
		// Only presentPresence's "attention" (fresh hook evidence of a
		// permission prompt) counts — never a probe, never stale evidence.
		for (const a of this.agents.list) {
			const v = this.agents.presence.get(a.agentId);
			if (v?.tone === "attention") out.push({ kind: "permission", agent: a, view: v });
		}
		const logItems = forYou(this.store.log);
		// A "Done" whose ack the log now shows: its item is gone, so is its state.
		const live = new Set(logItems.map((i) => i.key));
		for (const k of [...this.acks.keys()]) if (!live.has(k)) this.acks.delete(k);
		out.push(...logItems);
		return out;
	}

	private forYouList(items: ReturnType<Workspace["forYouItems"]>): HTMLElement {
		const box = el("div", "tw-foryou");
		const head = el("h3", "tw-h3", "For you");
		head.append(el("span", "tw-count", String(items.length)));
		box.append(head);
		if (!this.store.loaded && this.store.error === null) {
			box.append(el("p", "tw-muted", "Loading…"));
			return box;
		}
		if (items.length === 0) {
			box.append(el("p", "tw-muted tw-empty", "Nothing needs you right now."));
			return box;
		}
		const ul = el("ul", "tw-cards");
		for (const it of items) {
			const li = el("li");
			li.append(this.card(it));
			ul.append(li);
		}
		box.append(ul);
		return box;
	}

	private card(it: ReturnType<Workspace["forYouItems"]>[number]): HTMLElement {
		if (it.kind === "permission") {
			const sid = it.agent.binding?.sessionId;
			const c = el("div", "tw-card tw-card-permission");
			c.append(el("b", undefined, `@${it.agent.handle} is asking for permission`));
			c.append(el("span", "tw-card-sub", `Waiting for you in its Terminal · ${it.view.evidence}`));
			if (sid) {
				const a = el("a", "tw-card-act", "Open Terminal ›");
				a.href = routeHash({ sessionId: sid, view: "terminal", detail: null });
				c.append(a);
			}
			return c;
		}
		const threadTitle = this.threadTitleOf(it.rootId);
		const href = panelHref(this.projectId, { kind: "thread", msgId: it.rootId });
		const open = () => go(this.projectId, { kind: "thread", msgId: it.rootId });
		const who = handleOf(this.agents, it.agentId);
		// The card is a box holding a link and its own actions (a button can't
		// sit inside a link).
		const c = el("div", `tw-card tw-card-${it.kind}`);
		const main = link("", "tw-card-link", href, open);
		main.dataset.key = `card:${it.key}`;
		if (it.kind === "replied" && it.reply) {
			const r = it.reply;
			main.append(
				el(
					"b",
					undefined,
					r.attribution === "failed" ? `${who}'s turn failed` : `${who} replied to you`,
				),
			);
			if (r.attribution === "exact") {
				const t = this.store.replyText(r);
				main.append(
					el(
						"span",
						"tw-card-quote",
						t.kind === "ok" ? firstLine(t.text) : replyStateWords(t.kind),
					),
				);
			} else if (r.attribution === "ambiguous") {
				main.append(
					el("span", "tw-card-sub", "A reply that couldn't be tied exactly to your message"),
				);
			}
		} else if (it.delivery) {
			main.append(
				el(
					"b",
					undefined,
					it.kind === "not-delivered" ? `Not delivered to ${who}` : `Not sure it arrived · ${who}`,
				),
			);
			main.append(el("span", "tw-card-sub", deliveryText(it.delivery)));
		}
		main.append(el("span", "tw-card-meta", `${threadTitle} · ${relativeDate(it.ts)}`));
		c.append(main, this.doneControl(it));
		return c;
	}

	// ── Done (owner_ack, §4.3) ──

	/** In-flight / unanswered "Done" per item key: one click, one clientAckId. */
	private acks = new Map<
		string,
		{ clientAckId: string; phase: "sending" | "unknown" | "refused"; message?: string }
	>();

	private doneControl(it: ForYouItem): HTMLElement {
		const box = el("div", "tw-card-actions");
		const st = this.acks.get(it.key);
		const send = (clientAckId: string) => void this.ack(it, clientAckId);
		if (!st) {
			box.append(
				(() => {
					// A tooltip only: the accessible name stays the visible "Done".
					const b = button("Done", "tw-btn tw-btn-ghost tw-done", () => send(crypto.randomUUID()));
					b.title = "Mark as done — on every device";
					return b;
				})(),
			);
		} else if (st.phase === "sending") {
			const b = button("Marking…", "tw-btn tw-btn-ghost tw-done", () => {});
			b.disabled = true;
			box.append(b);
		} else if (st.phase === "unknown") {
			box.append(
				el("span", "tw-card-sub", "No answer: it may or may not be marked."),
				// The same id again: the server answers from the log, never writes twice.
				button("Check", "tw-btn tw-btn-ghost tw-done", () => send(st.clientAckId)),
			);
		} else {
			box.append(
				el("span", "tw-card-sub", st.message ?? "Couldn't mark it as done."),
				button("Done", "tw-btn tw-btn-ghost tw-done", () => send(crypto.randomUUID())),
			);
		}
		// One key for the control whatever its phase: focus follows Done → Marking… → Check.
		for (const b of box.querySelectorAll<HTMLElement>("button")) b.dataset.key = `done:${it.key}`;
		return box;
	}

	private async ack(it: ForYouItem, clientAckId: string): Promise<void> {
		this.acks.set(it.key, { clientAckId, phase: "sending" });
		this.render();
		const a = await postProjectAck(this.projectId, { clientAckId, target: ackTargetOf(it) });
		if (a.ok) {
			// The card goes when the log shows the ack (on every device); until
			// then it stays "Marking…" (pruned in render once the item is gone).
			await this.store.refreshAfterWrite();
		} else if (a.code === "stale") {
			this.acks.delete(it.key);
		} else if (
			a.code === "network" ||
			a.code === "bad-answer" ||
			(a.status >= 500 && a.code === "")
		) {
			this.acks.set(it.key, { clientAckId, phase: "unknown" });
		} else {
			this.acks.set(it.key, {
				clientAckId,
				phase: "refused",
				message:
					a.status === 404
						? "That message no longer exists."
						: `Couldn't mark it as done (${a.code || a.status}).`,
			});
		}
		this.render();
	}

	private threadTitleOf(rootId: string): string {
		const r = this.store.log.messages.get(rootId);
		return r ? firstLine(r.message.text) : "Thread";
	}

	// ── Now ──

	private renderNow(ctx: WorkspaceContext, items: ReturnType<Workspace["forYouItems"]>): void {
		const nodes: HTMLElement[] = [ctx.header];
		// Agents
		const strip = el("nav", "tw-agents");
		strip.setAttribute("aria-label", "Agents");
		if (ctx.agents === null) strip.append(el("p", "tw-muted", "Loading agents…"));
		for (const a of this.agents.list) {
			const v = this.agents.presence.get(a.agentId);
			const href = projectRouteHash({ projectId: this.projectId, agentId: a.agentId });
			const card = link("", `tw-agent tw-tone-${v?.tone ?? "unknown"}`, href, () =>
				navigateProject({ projectId: this.projectId, agentId: a.agentId }),
			);
			card.dataset.key = `agent:${a.agentId}`;
			card.append(avatar(this.agents, a.agentId));
			card.append(el("b", "tw-agent-name", a.handle));
			card.append(el("span", "tw-agent-state", v?.label ?? "State unknown"));
			card.title = v ? `${v.label} — ${v.evidence}` : "";
			strip.append(card);
		}
		const manage = link(
			"Manage agents",
			"tw-link",
			panelHref(this.projectId, { kind: "agents" }),
			() => go(this.projectId, { kind: "agents" }),
		);
		nodes.push(strip, manage);
		// For you (narrow layouts; the wide layout shows it on the right)
		const fy = this.forYouList(items);
		fy.classList.add("tw-foryou-inline");
		nodes.push(fy);
		// Threads
		nodes.push(this.threadsList());
		const newBtn = link(
			"+ New task",
			"tw-btn tw-btn-pri tw-new",
			panelHref(this.projectId, { kind: "new" }),
			() => go(this.projectId, { kind: "new" }),
		);
		nodes.push(newBtn);
		replaceIfChanged(this.nowCol, nodes);
	}

	private threadsList(): HTMLElement {
		const box = el("div", "tw-threads");
		box.append(el("h3", "tw-h3", "Threads"));
		if (this.store.error && !this.store.loaded) {
			box.append(
				el("p", "tw-error", "The project conversation couldn't be loaded."),
				button("Try again", "tw-btn", () => void this.store.refresh()),
			);
			return box;
		}
		if (this.store.gapBefore !== null)
			box.append(
				el("p", "tw-muted", "Some recent activity isn't loaded yet."),
				button("Load it", "tw-btn", () => void this.store.loadGap()),
			);
		const threads = buildThreads(this.store.log);
		if (this.store.loaded && threads.length === 0)
			box.append(el("p", "tw-muted tw-empty", "No threads yet. Start one with New task."));
		const current = this.ctx?.panel?.kind === "thread" ? this.ctx.panel.msgId : null;
		const ul = el("ul", "tw-thread-list");
		for (const t of threads) {
			const li = el("li");
			const a = link(
				"",
				"tw-thread-row",
				panelHref(this.projectId, { kind: "thread", msgId: t.rootId }),
				() => go(this.projectId, { kind: "thread", msgId: t.rootId }),
			);
			a.dataset.key = `thread:${t.rootId}`;
			if (t.rootId === current) a.setAttribute("aria-current", "page");
			const avs = el("span", "tw-avs");
			for (const id of t.agents.slice(0, 3)) avs.append(avatar(this.agents, id, true));
			const txt = el("span", "tw-thread-text");
			txt.append(el("b", undefined, t.title), el("span", "tw-muted", this.threadStatus(t)));
			a.append(avs, txt, el("span", "tw-time", relativeDate(t.lastTs)));
			li.append(a);
			ul.append(li);
		}
		box.append(ul);
		const waiting = unrootedMessages(this.store.log).length;
		if (waiting > 0)
			box.append(
				el(
					"p",
					"tw-muted",
					`${waiting} newer message${waiting === 1 ? "" : "s"} belong to older threads being loaded…`,
				),
			);
		if (this.store.hasOlder)
			box.append(
				button(
					this.store.busyOlder ? "Loading…" : "Earlier threads",
					"tw-btn tw-btn-ghost",
					() => void this.store.loadOlder(),
				),
			);
		return box;
	}

	/** The thread's latest fact, in words — from the log and presence only. */
	private threadStatus(t: ThreadSummary): string {
		const msgs = t.messageIds.map((id) => this.store.log.messages.get(id)!).filter(Boolean);
		const last = msgs[msgs.length - 1];
		if (!last) return "";
		for (const id of last.message.to) {
			const d = last.deliveries.get(id);
			const who = handleOf(this.agents, id);
			if (!d) return "Sending…";
			const tone = deliveryTone(d.state);
			if (tone === "pending") return `Sending to ${who}…`;
			if (tone === "not-delivered") return `Not delivered to ${who}`;
			if (tone === "unsure") return `Not sure it arrived · ${who}`;
			if ((last.replies.get(id)?.length ?? 0) > 0) continue;
			if (last.settling.has(id)) return `${who} replied · confirming…`;
			if (this.agents.presence.get(id)?.tone === "working") return `${who} is working`;
			return `Waiting for ${who}`;
		}
		const replied = last.message.to.filter((id) => (last.replies.get(id)?.length ?? 0) > 0);
		return replied.length
			? `${replied.map((id) => handleOf(this.agents, id)).join(", ")} replied`
			: "";
	}

	private renderSide(items: ReturnType<Workspace["forYouItems"]>): void {
		replaceIfChanged(this.sideCol, [this.forYouList(items)]);
	}

	private renderEmptyMain(): void {
		const box = el("div", "tw-empty-main");
		box.append(el("p", "tw-muted", "Pick a thread, or start a new task."));
		this.setMain(box);
	}

	private back(): HTMLElement {
		const b = link("‹ Now", "tw-back", panelHref(this.projectId, null), () =>
			go(this.projectId, null),
		);
		b.setAttribute("aria-label", "Back to Now");
		return b;
	}

	// ── New task ──

	private renderNew(): void {
		const c = this.composer("new", "task", null);
		replaceIfChanged(this.mainHead, [this.back(), el("h3", "tw-main-title", "New task")]);
		this.setMain(this.mainHead, c.root);
	}

	// ── Thread ──

	private renderThread(msgId: string): void {
		const log = this.store.log;
		// Built apart, then synced into the kept header only if it changed.
		const head = el("div");
		head.append(this.back());
		const syncHead = (): HTMLElement => {
			replaceIfChanged(this.mainHead, [...head.childNodes]);
			return this.mainHead;
		};
		if (!log.has(msgId)) {
			if (this.store.unreachable.has(msgId)) {
				head.append(el("h3", "tw-main-title", "Thread not found"));
				this.setMain(syncHead(), el("p", "tw-muted", "This thread doesn't exist in this project."));
			} else {
				head.append(el("h3", "tw-main-title", "Loading thread…"));
				this.setMain(syncHead());
				if (this.store.loaded) void this.fetchThreadRoot(msgId);
			}
			return;
		}
		const rootId = threadRootOf(log, msgId) ?? msgId;
		const thread = buildThreads(log).find((t) => t.rootId === rootId);
		head.append(el("h3", "tw-main-title", thread?.title ?? "Thread"));
		const participants = thread
			? thread.agents.map((id) => handleOf(this.agents, id)).join(", ")
			: "";
		head.append(el("span", "tw-muted tw-main-sub", participants ? `you, ${participants}` : ""));
		const timeline = this.timeline;
		const ids = thread?.messageIds ?? [msgId];
		type Row = { seq: number; node: HTMLElement };
		const rows: Row[] = [];
		const composer = this.composer(`t:${rootId}`, "thread", rootId);
		for (const id of ids) {
			const m = log.messages.get(id);
			if (!m) continue;
			rows.push({ seq: m.message.seq, node: this.messageRow(m) });
			for (const [agentId, list] of m.replies)
				for (const r of list)
					rows.push({
						seq: r.ref.seq,
						node: this.replyRow(m, agentId, r.ref, r.lateClose, composer),
					});
			for (const [agentId, st] of m.settling)
				rows.push({ seq: st.seq, node: this.settlingRow(agentId, st) });
			for (const agentId of m.message.to) {
				const d = m.deliveries.get(agentId);
				if (
					d?.state === "delivered" &&
					!m.settling.has(agentId) &&
					!(m.replies.get(agentId)?.length ?? 0) &&
					m === log.messages.get(ids[ids.length - 1]!)
				)
					rows.push({ seq: Number.MAX_SAFE_INTEGER, node: this.waitingRow(agentId) });
			}
		}
		rows.sort((a, b) => a.seq - b.seq);
		// The row's place in the log: what the reader's place is kept by.
		for (const r of rows) r.node.dataset.seq = String(r.seq);
		this.scroll.render(rootId, () => {
			const changed = replaceIfChanged(
				timeline,
				rows.map((r) => r.node),
			);
			this.setMain(syncHead(), timeline, this.scroll.pill, composer.root);
			return changed;
		});
	}

	private async fetchThreadRoot(msgId: string): Promise<void> {
		// A thread opened by its address before the window holds it.
		await this.store.resolveMissingIds([msgId]);
	}

	private messageRow(m: MessageView): HTMLElement {
		const li = el("li", "tw-row tw-row-me");
		const meta = el("div", "tw-meta");
		if (m.message.kind === "relay") {
			li.className = "tw-row tw-row-relay";
			meta.append(
				el("span", "tw-data-tag", "DATA"),
				el(
					"span",
					undefined,
					`Passed to ${m.message.to.map((id) => handleOf(this.agents, id)).join(", ")} as information`,
				),
			);
			li.append(meta);
			return li;
		}
		meta.append(el("b", undefined, "You"), el("span", "tw-muted", ` · ${clockText(m.message.ts)}`));
		li.append(meta);
		if (m.message.quoteRef)
			li.append(
				el(
					"span",
					"tw-quoted",
					`Replying to ${handleOf(this.agents, m.message.quoteRef.agentId)}'s reply`,
				),
			);
		li.append(el("div", "tw-bubble tw-bubble-me", m.message.text));
		if (m.message.artifacts.length > 0) li.append(this.messageFiles(m));
		const partial = partialDeliveryText(m.message.to.map((id) => m.deliveries.get(id)?.state));
		if (partial) li.append(el("p", "tw-partial", partial));
		const chips = el("div", "tw-deliveries");
		for (const id of m.message.to)
			chips.append(this.deliveryChip(id, m.deliveries.get(id) ?? null));
		li.append(chips);
		return li;
	}

	/** sha256 → the file's text as last fetched (shared by every message naming it). */
	private artifactText = new Map<
		string,
		| { kind: "loading" }
		/** `rows`: the diff, parsed once (a 1 MiB diff must not be re-parsed on every render). */
		| { kind: "ok"; text: string; rows?: DiffRow[] | null }
		| { kind: "error"; message: string }
	>();
	/** `${msgId}\n${sha256}` of each file shown open — kept here so a re-render keeps it open. */
	private openArtifacts = new Set<string>();

	/**
	 * The files a message carried (§6.3). Their content is another agent's
	 * data: fetched as text and shown through textContent only (a .diff /
	 * .patch through the diff renderer), never navigated to. Without
	 * features.projectArtifacts only the names are listed and nothing is
	 * requested (A.2).
	 */
	private messageFiles(m: MessageView): HTMLElement {
		const box = el("div", "tw-msg-files");
		const enabled = projectArtifactsEnabled();
		for (const f of m.message.artifacts) {
			const key = `${m.message.msgId}\n${f.sha256}`;
			const open = this.openArtifacts.has(key);
			const item = el("div", "tw-msg-file");
			const label = `${f.name} · ${sizeText(f.bytes)}`;
			if (!enabled) {
				item.append(el("span", "tw-file-chip", label));
				box.append(item);
				continue;
			}
			const b = el("button", "tw-file-chip tw-file-open", label);
			b.type = "button";
			b.dataset.key = `file:${key}`;
			b.setAttribute("aria-expanded", String(open));
			b.title = `sha256 ${f.sha256}`;
			b.addEventListener("click", () => this.toggleArtifact(key, f.sha256));
			item.append(b);
			if (open) item.append(this.artifactBody(f));
			box.append(item);
		}
		return box;
	}

	private toggleArtifact(key: string, sha256: string): void {
		if (this.openArtifacts.has(key)) this.openArtifacts.delete(key);
		else {
			this.openArtifacts.add(key);
			const cur = this.artifactText.get(sha256);
			if (!cur || cur.kind === "error") void this.loadArtifact(sha256);
		}
		this.render();
	}

	private async loadArtifact(sha256: string): Promise<void> {
		this.artifactText.set(sha256, { kind: "loading" });
		const r = await fetchProjectArtifactText(this.projectId, sha256);
		if (!r.ok && r.code === "stale") {
			this.artifactText.delete(sha256);
			return;
		}
		this.artifactText.set(
			sha256,
			r.ok
				? { kind: "ok", text: r.text }
				: {
						kind: "error",
						message:
							r.code === "hash-mismatch" || r.code === "artifact-corrupt"
								? "The stored file doesn't match its hash; it isn't shown."
								: r.status === 404
									? "This file isn't registered in this project."
									: "Couldn't load this file. Open it again to retry.",
					},
		);
		this.render();
	}

	private artifactBody(f: ArtifactRef): HTMLElement {
		const body = el("div", "tw-file-body");
		const st = this.artifactText.get(f.sha256);
		if (!st || st.kind === "loading") {
			body.append(el("p", "tw-muted", "Loading…"));
			return body;
		}
		if (st.kind === "error") {
			body.append(el("p", "tw-muted", st.message));
			return body;
		}
		body.append(
			el(
				"p",
				"tw-muted tw-file-warn",
				"Another agent's data: review it before applying or running anything from it.",
			),
		);
		if (st.rows === undefined) {
			const parsed = looksLikeDiff(f.name) ? parseUnifiedDiff(st.text) : null;
			st.rows = parsed?.hasHunks ? parsed.rows : null;
		}
		if (st.rows) appendDiffRows(body, st.rows);
		else body.append(el("pre", "tw-file-text", st.text));
		return body;
	}

	private deliveryChip(agentId: string, d: DeliveryView | null): HTMLElement {
		const who = handleOf(this.agents, agentId);
		if (!d) return el("span", "tw-del tw-del-pending", `${who} · Sending…`);
		const tone = deliveryTone(d.state);
		const chip = el(
			"span",
			`tw-del tw-del-${tone}`,
			`${who} · ${tone === "ok" ? "Delivered ✓" : deliveryText(d)}`,
		);
		if (d.settled) chip.title = "Confirmed later by the agent's capture";
		return chip;
	}

	private replyRow(
		m: MessageView,
		agentId: string,
		r: LogReplyRef,
		lateClose: boolean,
		composer: Composer,
	): HTMLElement {
		const li = el("li", "tw-row tw-row-agent");
		li.style.setProperty("--tw-hue", String(hueOf(agentId)));
		const meta = el("div", "tw-meta");
		meta.append(
			avatar(this.agents, agentId, true, false),
			el("b", undefined, handleOf(this.agents, agentId)),
			el("span", "tw-muted", ` · ${clockText(r.ts)}`),
		);
		li.append(meta);
		if (r.attribution === "failed") {
			li.append(el("div", "tw-bubble tw-bubble-note", "Its turn failed before it could answer."));
			return li;
		}
		if (r.attribution === "ambiguous")
			li.append(
				el(
					"p",
					"tw-note",
					`This reply couldn't be tied exactly to your message${r.attributionReason ? ` (${r.attributionReason})` : ""}. Check its Chat if it matters.`,
				),
			);
		const t = this.store.replyText(r);
		if (t.kind === "ok") {
			li.append(el("div", "tw-bubble tw-bubble-agent", t.text));
			if (t.truncated)
				li.append(
					el("p", "tw-note", "The reply was longer than the capture keeps; this is its beginning."),
				);
		} else if (t.kind === "error") {
			li.append(
				el("p", "tw-note", "The reply's text couldn't be read."),
				button("Try again", "tw-btn", () => this.store.retryReply(r)),
			);
		} else {
			li.append(el("div", "tw-bubble tw-bubble-note", replyStateWords(t.kind, r.reportSha256)));
		}
		if (lateClose)
			li.append(el("p", "tw-note", "The agent kept writing after this reply was recorded."));
		if (r.reportSha256) {
			const actions = el("div", "tw-actions");
			actions.append(
				button("Reply…", "tw-btn tw-btn-ghost", () =>
					composer.replyTo({
						agentId,
						inReplyTo: m.message.msgId,
						quoteRef: {
							msgId: m.message.msgId,
							agentId,
							promptId: r.promptId,
							reportSha256: r.reportSha256!,
						},
					}),
				),
			);
			for (const b of actions.querySelectorAll<HTMLElement>("button"))
				b.dataset.key = `reply:${m.message.msgId}:${agentId}:${r.promptId}`;
			li.append(actions);
		}
		return li;
	}

	/**
	 * §4.1: the reply arrived and is being confirmed (≤ 10 s). Its text is
	 * shown, verified like a reply's, but it isn't "the reply" yet: no
	 * Reply…, nothing in For you, nothing derived from it.
	 */
	private settlingRow(agentId: string, st: LogReplySettling): HTMLElement {
		const li = el("li", "tw-row tw-row-agent tw-row-settling");
		li.style.setProperty("--tw-hue", String(hueOf(agentId)));
		const meta = el("div", "tw-meta");
		meta.append(
			avatar(this.agents, agentId, true, false),
			el("b", undefined, handleOf(this.agents, agentId)),
			el("span", "tw-muted", " · reply received, confirming…"),
		);
		li.append(meta);
		const t = this.store.replyText(st);
		li.append(
			t.kind === "ok"
				? el("div", "tw-bubble tw-bubble-agent tw-bubble-settling", t.text)
				: el("div", "tw-bubble tw-bubble-note", replyStateWords(t.kind, st.reportSha256)),
		);
		return li;
	}

	private waitingRow(agentId: string): HTMLElement {
		const li = el("li", "tw-row tw-row-waiting");
		const working = this.agents.presence.get(agentId)?.tone === "working";
		li.append(
			avatar(this.agents, agentId, true),
			el(
				"span",
				undefined,
				working
					? `${handleOf(this.agents, agentId)} is working · its reply appears here when the turn ends`
					: `Waiting for ${handleOf(this.agents, agentId)}'s reply`,
			),
		);
		return li;
	}
}

/**
 * Put `nodes` in `container` only if they differ from what is there
 * (`isEqualNode`: same structure, attributes and text). A poll that
 * changes nothing — the log's or the agent directory's — then touches no
 * DOM at all, so the person's text selection, focus and screen-reader
 * place survive it (independent review of #589). Returns true if replaced.
 */
function replaceIfChanged(container: Element, nodes: readonly Node[]): boolean {
	const cur = [...container.childNodes];
	if (cur.length === nodes.length && nodes.every((n, i) => cur[i]!.isEqualNode(n))) return false;
	if (cur.length === nodes.length) {
		// Same shape: swap only the children that differ, so a change in one
		// row keeps the others (and a selection inside them) in place.
		nodes.forEach((n, i) => {
			if (!cur[i]!.isEqualNode(n)) container.replaceChild(n, cur[i]!);
		});
		return true;
	}
	container.replaceChildren(...nodes);
	return true;
}

function firstLine(text: string): string {
	const l =
		text
			.split("\n")
			.find((x) => x.trim() !== "")
			?.trim() ?? "";
	return l.length > 140 ? `${l.slice(0, 139)}…` : l;
}

function replyStateWords(kind: string, sha?: string | null): string {
	switch (kind) {
		case "loading":
			return "Loading the reply…";
		case "gone":
			return `Reply no longer retained${sha ? ` (sha256 ${sha.slice(0, 12)}…)` : ""}`;
		case "mismatch":
			return "The reply's text doesn't match what was recorded, so it isn't shown.";
		default:
			return "";
	}
}

// ── Module surface ──────────────────────────────────────────────────────────

const workspaces = new Map<string, Workspace>();

/** The project's workspace element, updated for this render (created once per project). */
export function teamWorkspace(ctx: WorkspaceContext): HTMLElement {
	let w = workspaces.get(ctx.projectId);
	if (!w) {
		w = new Workspace(ctx.projectId);
		workspaces.set(ctx.projectId, w);
	}
	for (const [pid, other] of workspaces) if (pid !== ctx.projectId) other.suspend();
	w.update(ctx);
	return w.root;
}

/** The project page left the screen: no workspace polls. */
export function suspendWorkspaces(): void {
	for (const w of workspaces.values()) w.suspend();
}

/** Logout: drafts, composers and logs of this account are dropped. */
export function resetWorkspaces(): void {
	suspendWorkspaces();
	workspaces.clear();
	resetLogStores();
}
