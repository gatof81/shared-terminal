/**
 * searchBar.ts — toolbar search box for terminal history (#357).
 *
 * Drives tmux copy-mode search server-side: the 50k-line history lives
 * in tmux, and xterm's local scrollback is effectively empty with
 * tmux-managed panes (see the #171–#181 saga in terminal.ts), so an
 * @xterm/addon-search would find nothing. The backend sends
 * `copy-mode` + `send-keys -X search-*` and the visual result — tmux's
 * own copy-mode UI — streams back through the normal pane fanout to
 * every attached client.
 *
 * Same circular-import-safe pattern as ports.ts: DOM re-queried
 * locally; main.ts imports used only inside functions. The pure
 * Enter/Shift+Enter decision lives in search.ts (unit-tested there).
 */

import { searchTabHistory } from "./api.js";
import { activeSessionId, currentActiveTabId, getActiveTerminal, showToast } from "./main.js";
import { decideSearchAction, type SubmittedSearch } from "./search.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const searchBtn = document.getElementById("terminal-search-btn") as HTMLButtonElement;
const searchInput = document.getElementById("terminal-search-input") as HTMLInputElement;

// The last SUBMITTED search (not the input's live value) — feeds the
// search-vs-next decision and remembers which pane is sitting in
// copy-mode so close can cancel it even after a tab switch.
let lastSubmitted: SubmittedSearch | null = null;

function openSearchBox(): void {
	// The toolbar (and thus the button) is only visible with an active
	// session, but the Ctrl+Shift+F path can fire any time — and a fresh
	// session legitimately has zero tabs, so the tab guard matters too.
	if (!activeSessionId || !currentActiveTabId) return;
	searchInput.hidden = false;
	searchInput.focus();
	// Pre-select so typing a new query replaces the old one, while Enter
	// still means "step to the next match of what's shown".
	searchInput.select();
}

function closeSearchBox(): void {
	// Cancel copy-mode on the pane the last search actually ran against —
	// NOT the currently-active tab, which may be a different pane if the
	// user switched tabs while the box was open. Fire-and-forget: the
	// terminal is usable either way, but a failure still deserves a toast
	// (the pane would be left stuck in copy-mode).
	if (lastSubmitted) {
		const { sessionId, tabId } = lastSubmitted;
		lastSubmitted = null;
		searchTabHistory(sessionId, tabId, { action: "exit" }).catch((err) => {
			showToast((err as Error).message, true);
		});
	}
	searchInput.hidden = true;
	getActiveTerminal()?.focus();
}

async function submit(shift: boolean): Promise<void> {
	if (!activeSessionId || !currentActiveTabId) return;
	const query = searchInput.value;
	if (query.length === 0) return;
	const target = { sessionId: activeSessionId, tabId: currentActiveTabId };
	const action = decideSearchAction(lastSubmitted, target, query, shift);
	try {
		// `query` only rides the "search" action — next/prev repeat the
		// pattern tmux already holds (backend ignores a stale query there).
		await searchTabHistory(target.sessionId, target.tabId, {
			action,
			...(action === "search" ? { query } : {}),
		});
		lastSubmitted = { ...target, query };
	} catch (err) {
		showToast((err as Error).message, true);
	}
}

export function initTerminalSearch(): void {
	searchBtn.addEventListener("click", () => {
		if (searchInput.hidden) openSearchBox();
		else closeSearchBox();
	});

	searchInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			void submit(e.shiftKey);
		} else if (e.key === "Escape") {
			e.preventDefault();
			// Keep the app-level Escape handlers (modal / mobile-sidebar
			// close in main.ts) from also reacting to a keypress that was
			// meant for the search box.
			e.stopPropagation();
			closeSearchBox();
		}
	});

	// Ctrl+Shift+F opens (or refocuses) the box. The combo reaches this
	// document-level listener even while xterm has focus: xterm leaves
	// Ctrl+Shift chords to the browser (no sequence, no cancelEvent), so
	// the keydown bubbles up from its textarea. Ctrl+F alone is left
	// untouched — it's both the browser's find and a real terminal
	// keystroke (^F, cursor-forward in readline).
	document.addEventListener("keydown", (e) => {
		if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
		if (e.key.toLowerCase() !== "f") return;
		if (!activeSessionId || !currentActiveTabId) return;
		e.preventDefault();
		openSearchBox();
	});
}
