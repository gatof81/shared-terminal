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

import { type ConversationSummary, fetchConversationSummaries } from "./api.js";
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

	let shown: SwitcherItem[] = [];
	let active = 0;
	// The highlight follows the conversation, not the row index: a project
	// answering later can insert rows above it.
	let activeKey: string | null = null;
	const keyOf = (i: SwitcherItem) => `${i.sessionId}/${i.cid}`;

	const allItems = (): SwitcherItem[] => {
		const out: SwitcherItem[] = [];
		for (const p of projects.values()) {
			if (p.state.kind !== "ok") continue;
			for (const c of p.state.conversations as ConversationSummary[])
				if (visibleInSwitcher(c, now)) out.push(toItem(c, p, now));
		}
		return out;
	};

	const go = (item: SwitcherItem) => {
		dialog.close();
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
		const sections = sectionize(allItems().filter((i) => matches(i, q)));
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
				const idx = shown.length;
				o.addEventListener("click", () => go(item));
				o.addEventListener("mousemove", () => {
					if (active !== idx) setActive(idx);
				});
				shown.push(item);
				group.appendChild(o);
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

	// One loader per switcher: the first load and every Retry share its slots.
	const loader = new ProjectLoader(
		fetchConversationSummaries,
		(p) => {
			projects.set(p.sessionId, p);
			render();
		},
		{ isCancelled: () => closed },
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
			const item = shown[active];
			if (item) go(item);
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

let wired = false;
export function initSwitcher(isLoggedIn: () => boolean): void {
	if (wired) return;
	wired = true;
	const btn = document.getElementById("switcher-btn");
	btn?.addEventListener("click", () => openSwitcher(btn));
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
