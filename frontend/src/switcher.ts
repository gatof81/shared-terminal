/**
 * switcher.ts — "Go to a conversation": every conversation of the person's
 * running projects in one list, the ones that need them first, so several
 * agents can be supervised without opening project after project.
 *
 * Opened from the header button or Ctrl/⌘+K (never while typing: the
 * terminal, the composer and every field keep the key). Loads on open only
 * (switcherModel.loadProjects: `?capture=0`, a few projects at a time, each
 * bounded); a failed project says so and can be retried, the rest stay
 * navigable. Choosing a conversation only navigates — the address becomes
 * #/sessions/<id>/chat/<cid> and the app's own route resolver opens it in
 * Chat; nothing is sent to any session.
 */

import { type AgentsAtAGlance, agentName, agentsLine, atAGlance } from "./agentsSummary.js";
import {
	type ConversationSummary,
	fetchConversationAgents,
	fetchConversationSummaries,
} from "./api.js";
import { focusAgentWhenOpen } from "./chatView.js";
import { createDialog, isAnyDialogOpen } from "./components/dialog.js";
import { relativeDate } from "./format.js";
import { isMobile, sessions } from "./main.js";
import { routeHash } from "./router.js";
import {
	BUCKET_LABEL,
	explainProjectError,
	matches,
	type Project,
	ProjectLoader,
	parallelSummary,
	parallelSummaryText,
	Slots,
	SWITCHER_CONCURRENCY,
	SWITCHER_TIMEOUT_MS,
	type SwitcherItem,
	sectionize,
	toItem,
	visibleInSwitcher,
} from "./switcherModel.js";

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

let openNow = false;
// Closes the open switcher (logout / session expiry): another account's
// titles must not stay on screen, nor keep loading into it.
let closeCurrent: (() => void) | null = null;

export function closeSwitcher(): void {
	closeCurrent?.();
}

/** The person's running projects, in sidebar order. */
function runningProjects(): Array<{ sessionId: string; name: string }> {
	return sessions
		.filter((s) => s.status === "running")
		.map((s) => ({ sessionId: s.sessionId, name: s.name }));
}

export function openSwitcher(opener?: Element | null): void {
	if (openNow) return;
	openNow = true;
	let closed = false;
	const now = Date.now();
	const projects = new Map<string, Project>();
	for (const p of runningProjects())
		projects.set(p.sessionId, { ...p, state: { kind: "loading" } });

	const root = el("div", "modal");
	root.setAttribute("aria-hidden", "true");
	const backdrop = el("div", "modal-backdrop");
	backdrop.setAttribute("data-close-modal", "");
	root.appendChild(backdrop);
	const card = el("div", "modal-card switcher-card");
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-modal", "true");
	card.setAttribute("aria-labelledby", "switcher-title");
	const header = el("div", "modal-header");
	const h2 = el("h2", undefined, "Go to a conversation");
	h2.id = "switcher-title";
	header.appendChild(h2);
	const x = el("button", "modal-close", "×");
	x.type = "button";
	x.setAttribute("aria-label", "Close");
	x.setAttribute("data-close-modal", "");
	header.appendChild(x);
	card.appendChild(header);

	const input = el("input", "switcher-input");
	input.id = "switcher-input";
	input.type = "search";
	input.placeholder = "Search conversations or projects";
	input.autocomplete = "off";
	input.spellcheck = false;
	input.setAttribute("role", "combobox");
	input.setAttribute("aria-controls", "switcher-list");
	input.setAttribute("aria-expanded", "true");
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-label", "Search conversations or projects");
	card.appendChild(input);

	// Parallel work across the loaded projects, above the list it summarises.
	const summaryEl = el("p", "switcher-summary");
	summaryEl.hidden = true;
	card.appendChild(summaryEl);

	const listEl = el("div", "switcher-list");
	listEl.id = "switcher-list";
	listEl.setAttribute("role", "listbox");
	listEl.setAttribute("aria-label", "Conversations");
	card.appendChild(listEl);

	const statusEl = el("div", "switcher-status");
	statusEl.setAttribute("role", "status");
	card.appendChild(statusEl);

	if (!isMobile())
		card.appendChild(el("div", "switcher-hint", "↑ ↓ to move · Enter to open · Esc to close"));

	root.appendChild(card);
	document.body.appendChild(root);

	// A row is a conversation, or one of its working agents under it.
	type Row = { item: SwitcherItem; agentId?: string };
	let shown: Row[] = [];
	let active = 0;
	// The highlight follows the row's identity, not its index: a project
	// answering later can insert rows above it.
	let activeKey: string | null = null;
	const keyOf = (r: Row) => `${r.item.sessionId}/${r.item.cid}${r.agentId ? `#${r.agentId}` : ""}`;

	// Subagents, only of conversations whose FRESH evidence says work is going
	// on (running, background tasks, a permission prompt). Not of a stale one,
	// and not of `waiting_input`: its turn_end with no background tasks says
	// nothing is still running, so an unended agent there would contradict it.
	const AGENT_STATUSES = new Set(["running", "waiting_background", "waiting_permission"]);
	const gapsOf = new Map<string, number>();
	const agents = new Map<
		string,
		{ kind: "loading" } | { kind: "ok"; g: AgentsAtAGlance } | { kind: "error" }
	>();
	const conversationKey = (i: SwitcherItem) => `${i.sessionId}/${i.cid}`;
	const MAX_AGENT_ROWS = 3;

	const allItems = (): SwitcherItem[] => {
		const out: SwitcherItem[] = [];
		for (const p of projects.values()) {
			if (p.state.kind !== "ok") continue;
			for (const c of p.state.conversations as ConversationSummary[])
				if (visibleInSwitcher(c, now)) out.push(toItem(c, p, now));
		}
		return out;
	};

	const go = (row: Row) => {
		const item = row.item;
		dialog.close();
		// Navigation only: the conversation opens in Chat with the Agents panel
		// on that agent's card. No control over the agent is offered.
		if (row.agentId) focusAgentWhenOpen(item.cid, row.agentId);
		// The app's own resolver (hashchange → applyRoute) opens the project,
		// Chat and the conversation: the same path as a pasted link.
		const hash = routeHash({ sessionId: item.sessionId, view: "chat", detail: item.cid });
		if (window.location.hash !== hash) window.location.hash = hash;
	};

	const setActive = (i: number) => {
		const opts = [...listEl.querySelectorAll<HTMLElement>("[role=option]")];
		if (opts.length === 0) {
			input.removeAttribute("aria-activedescendant");
			return;
		}
		active = (i + opts.length) % opts.length;
		const it = shown[active];
		activeKey = it ? keyOf(it) : null;
		for (const [n, o] of opts.entries()) o.setAttribute("aria-selected", String(n === active));
		const cur = opts[active] as HTMLElement;
		input.setAttribute("aria-activedescendant", cur.id);
		cur.scrollIntoView({ block: "nearest" });
	};

	const render = () => {
		if (closed) return;
		const q = input.value;
		shown = [];
		listEl.replaceChildren();
		const agentNames = (i: SwitcherItem) => {
			const a = agents.get(conversationKey(i));
			return a?.kind === "ok" ? a.g.working.map(agentName) : [];
		};
		const sections = sectionize(allItems().filter((i) => matches(i, q, agentNames(i))));
		let n = 0;
		for (const s of sections) {
			const group = el("div", "switcher-group");
			group.setAttribute("role", "group");
			const gh = el("div", "switcher-group-title", BUCKET_LABEL[s.bucket]);
			gh.id = `switcher-g-${s.bucket}`;
			group.setAttribute("aria-labelledby", gh.id);
			group.appendChild(gh);
			for (const item of s.items) {
				const o = el("div", "switcher-option");
				o.id = `switcher-opt-${n++}`;
				o.setAttribute("role", "option");
				o.setAttribute("aria-selected", "false");
				o.dataset.cid = item.cid;
				o.dataset.sessionId = item.sessionId;
				const main = el("div", "switcher-option-main");
				main.appendChild(el("span", "switcher-option-title", item.title));
				main.appendChild(el("span", "switcher-option-project", item.projectName));
				const ag = agents.get(conversationKey(item));
				if (ag?.kind === "ok" && ag.g.total > 0) {
					let line = agentsLine(ag.g);
					// Lost events: an agent's end may be among them.
					if (ag.g.working.length > 0 && (gapsOf.get(conversationKey(item)) ?? 0) > 0)
						line += " · some events were lost, ends may be missing";
					main.appendChild(el("span", "switcher-option-agents", line));
				}
				o.appendChild(main);
				const side = el("div", "switcher-option-side");
				const chip = el("span", `chat-status tone-${item.status.tone}`);
				chip.appendChild(el("span", "chat-dot"));
				chip.appendChild(el("span", "chat-status-label", item.status.label));
				side.appendChild(chip);
				if (!Number.isNaN(item.evidenceAt))
					side.appendChild(
						el(
							"span",
							"switcher-option-time",
							relativeDate(new Date(item.evidenceAt).toISOString()),
						),
					);
				o.appendChild(side);
				const row: Row = { item };
				const idx = shown.length;
				o.addEventListener("click", () => go(row));
				o.addEventListener("mousemove", () => {
					if (active !== idx) setActive(idx);
				});
				shown.push(row);
				group.appendChild(o);
				// Its working agents, each a row of its own (keyboard-reachable).
				if (ag?.kind === "ok") {
					for (const w of ag.g.working.slice(0, MAX_AGENT_ROWS)) {
						const so = el("div", "switcher-option switcher-agent");
						so.id = `switcher-opt-${n++}`;
						so.setAttribute("role", "option");
						so.setAttribute("aria-selected", "false");
						so.setAttribute("aria-label", `${agentName(w)}, started, no end yet, in ${item.title}`);
						so.dataset.agentId = w.agentId;
						so.appendChild(el("span", "switcher-agent-name", `↳ ${agentName(w)}`));
						so.appendChild(el("span", "switcher-agent-state", "started, no end yet"));
						const arow: Row = { item, agentId: w.agentId };
						const aidx = shown.length;
						so.addEventListener("click", () => go(arow));
						so.addEventListener("mousemove", () => {
							if (active !== aidx) setActive(aidx);
						});
						shown.push(arow);
						group.appendChild(so);
					}
					const more = ag.g.working.length - MAX_AGENT_ROWS;
					if (more > 0) {
						// Visual only: the count is already in the conversation option's
						// own text (agentsLine), which is what a screen reader reads.
						const m = el(
							"div",
							"switcher-agent-more",
							`+${more} more — open the conversation to see them`,
						);
						m.setAttribute("aria-hidden", "true");
						group.appendChild(m);
					}
				}
			}
			listEl.appendChild(group);
		}
		renderStatus(q);
		const keep = activeKey === null ? -1 : shown.findIndex((i) => keyOf(i) === activeKey);
		setActive(keep >= 0 ? keep : 0);
	};

	const renderStatus = (q: string) => {
		statusEl.replaceChildren();
		const all = [...projects.values()];
		const loading = all.filter((p) => p.state.kind === "loading").length;
		const failed = all.filter((p) => p.state.kind === "error");
		if (all.length === 0) {
			statusEl.appendChild(
				el(
					"p",
					"switcher-empty",
					"No running projects. Conversations are listed for projects that are running.",
				),
			);
			return;
		}
		if (shown.length === 0 && loading === 0) {
			const msg =
				q.trim() !== ""
					? `No conversation matches “${q.trim()}”.`
					: failed.length === all.length
						? "No project could be loaded."
						: failed.length > 0
							? "No conversations in the projects that loaded."
							: "No conversations yet in your running projects.";
			statusEl.appendChild(el("p", "switcher-empty", msg));
		}
		// Parallel work at a glance (fresh evidence only; never the query's subset).
		const summary = all.length > 0 ? parallelSummaryText(parallelSummary(allItems(), all)) : null;
		summaryEl.textContent = summary ?? "";
		summaryEl.hidden = summary === null;
		if (loading > 0)
			statusEl.appendChild(
				el(
					"p",
					"switcher-loading",
					`Loading ${loading} of ${all.length} project${all.length === 1 ? "" : "s"}…`,
				),
			);
		// §6.2: with the names/archive state unreadable, the titles are the
		// automatic ones and archived conversations are listed too — say so.
		for (const p of all) {
			if (p.state.kind !== "ok" || !p.state.metaUnavailable) continue;
			const row = el("p", "switcher-note");
			row.appendChild(el("strong", undefined, p.name));
			row.appendChild(
				el(
					"span",
					undefined,
					" — names and archive state unavailable: showing automatic titles, archived ones included.",
				),
			);
			statusEl.appendChild(row);
		}
		for (const p of failed) {
			if (p.state.kind !== "error") continue;
			const row = el("p", "switcher-error");
			row.appendChild(el("strong", undefined, p.name));
			row.appendChild(el("span", undefined, ` — ${explainProjectError(p.state)}. `));
			const retry = el("button", "chat-link", "Retry");
			retry.type = "button";
			retry.addEventListener("click", () => {
				projects.set(p.sessionId, { ...p, state: { kind: "loading" } });
				render();
				void load([{ sessionId: p.sessionId, name: p.name }]);
			});
			row.appendChild(retry);
			statusEl.appendChild(row);
		}
	};

	// One bound per switcher: project lists, every Retry and the agent lists
	// share the same slots.
	const slots = new Slots(SWITCHER_CONCURRENCY);
	const loadAgents = (p: Project) => {
		if (p.state.kind !== "ok") return;
		for (const c of p.state.conversations as ConversationSummary[]) {
			if (!visibleInSwitcher(c, now)) continue;
			const item = toItem(c, p, now);
			if (item.bucket !== "attention" && item.bucket !== "working") continue;
			if (!AGENT_STATUSES.has(c.status)) continue;
			const key = conversationKey(item);
			gapsOf.set(key, c.gapsCount ?? 0);
			if (agents.has(key)) continue;
			agents.set(key, { kind: "loading" });
			void slots
				.run(
					(signal) => fetchConversationAgents(item.sessionId, item.cid, signal),
					SWITCHER_TIMEOUT_MS,
					() => closed,
				)
				.then((r) => {
					if (closed) return;
					// A failed agent list just shows no agents line (the
					// conversation row itself is unaffected); no retry of its own.
					agents.set(
						key,
						r.value?.ok ? { kind: "ok", g: atAGlance(r.value.agents) } : { kind: "error" },
					);
					render();
				});
		}
	};
	const loader = new ProjectLoader(
		fetchConversationSummaries,
		(p) => {
			projects.set(p.sessionId, p);
			render();
			loadAgents(p);
		},
		{ isCancelled: () => closed, slots },
	);
	const load = (list: Array<{ sessionId: string; name: string }>) => loader.load(list);

	input.addEventListener("input", () => {
		activeKey = null;
		render();
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown") {
			setActive(active + 1);
			e.preventDefault();
		} else if (e.key === "ArrowUp") {
			setActive(active - 1);
			e.preventDefault();
		} else if (e.key === "Enter") {
			const row = shown[active];
			if (row) go(row);
			e.preventDefault();
		}
	});

	const dialog = createDialog(root, {
		initialFocus: () => input,
		onClose: () => {
			closed = true;
			openNow = false;
			closeCurrent = null;
			root.remove();
		},
	});
	closeCurrent = () => dialog.close();
	dialog.open(opener ?? document.activeElement);
	render();
	void load(runningProjects());
}

/** Ctrl/⌘+K, but never where a key is someone's text: the terminal, the composer, any field. */
function isTypingTarget(t: EventTarget | null): boolean {
	if (!(t instanceof HTMLElement)) return false;
	if (t.isContentEditable) return true;
	if (t.closest(".xterm")) return true;
	const tag = t.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Dispatched on `document` to open the switcher from another module. */
export const OPEN_SWITCHER_EVENT = "st:open-switcher";

let wired = false;
export function initSwitcher(isLoggedIn: () => boolean): void {
	if (wired) return;
	wired = true;
	const btn = document.getElementById("switcher-btn");
	btn?.addEventListener("click", () => openSwitcher(btn));
	// Other views ask through an event (chatView would otherwise import this
	// module, which already imports chatView). The opener gets focus back.
	document.addEventListener(OPEN_SWITCHER_EVENT, (e) => {
		if (!isLoggedIn()) return;
		const opener = (e as CustomEvent<{ opener?: Element | null }>).detail?.opener ?? null;
		openSwitcher(opener);
	});
	// The hint says the key this keyboard has.
	const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	const kbd = btn?.querySelector("kbd");
	if (mac && kbd) kbd.textContent = "⌘K";
	document.addEventListener("keydown", (e) => {
		// The key labelled K; the physical K position (e.code) only when the
		// layout types no Latin letter there (Cyrillic, Greek…) — on Colemak
		// or Dvorak that key is another letter's shortcut (Ctrl+E, Ctrl+T).
		const k = e.key.length === 1 ? e.key.toLowerCase() : "";
		if (k !== "k" && !(e.code === "KeyK" && !/^[a-z]$/.test(k))) return;
		if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
		if (!isLoggedIn() || isAnyDialogOpen() || isTypingTarget(e.target)) return;
		e.preventDefault();
		openSwitcher(btn);
	});
}
