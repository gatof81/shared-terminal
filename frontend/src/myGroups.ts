/**
 * myGroups.ts — lead-side observe surface (#201e): the 'My groups' modal
 * (groups the user leads + their members' observable sessions) and the
 * read-only observe terminal modal. Extracted from main.ts (#312).
 *
 * Same circular-import-safe pattern as admin.ts: DOM elements re-queried
 * locally (singletons by id), so no module-top dependency on main.ts; the
 * main.ts imports are used only inside functions.
 */

import {
	fetchMyGroups,
	fetchMyObservableSessions,
	type LeadGroup,
	listTabs,
	type ObservableSession,
	type Tab,
} from "./api.js";
import { currentFontSize, showToast } from "./main.js";
import { openTerminalSession, type TerminalSession } from "./terminal.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const myGroupsBtn = document.getElementById("my-groups-btn") as HTMLButtonElement;
const sidebarMyGroupsBtn = document.getElementById("sidebar-my-groups-btn") as HTMLButtonElement;
const myGroupsModal = document.getElementById("my-groups-modal")!;
const myGroupsListEl = document.getElementById("my-groups-list")!;
const myGroupsRefreshBtn = document.getElementById("my-groups-refresh-btn") as HTMLButtonElement;
const observeModal = document.getElementById("observe-modal")!;
const observeModalTitle = document.getElementById("observe-modal-title")!;
const observeModalHint = document.getElementById("observe-modal-hint")!;
const observeTerminalHost = document.getElementById("observe-terminal-host")!;

// ── My groups (#201e — lead-side observe surface) ──────────────────────────
//
// Visible only to users who lead at least one group via
// `applyAdminVisibility()` (which also gates the lead button). Pulls
// `/api/groups/mine` + `/api/groups/mine/sessions` on open + refresh —
// no auto-polling, same rationale as the admin dashboard. The
// observe modal opens read-only via `openTerminalSession({observe:
// true})`; closing the modal disposes the WS attach and triggers the
// server-side `recordObserveEnd()` UPDATE.

let myGroupsOpener: HTMLButtonElement | null = null;
// At most one observe-mode terminal at a time. Opening a second
// observe (via clicking another row's Observe before closing the
// current modal) tears down the prior one — same shape as the
// existing single-terminal-per-modal pattern (paste, file-attach).
let activeObserveTerm: TerminalSession | null = null;

function resolveMyGroupsOpener(): HTMLButtonElement {
	return myGroupsBtn.offsetParent !== null ? myGroupsBtn : sidebarMyGroupsBtn;
}

function openMyGroupsModal(opener: HTMLButtonElement) {
	myGroupsOpener = opener;
	myGroupsModal.classList.add("open");
	myGroupsModal.setAttribute("aria-hidden", "false");
	myGroupsRefreshBtn.focus();
	void refreshMyGroups();
}

function closeMyGroupsModal() {
	// Tear down any active observe attach before dismissing the
	// parent modal (#201e review round 4 SHOULD-FIX). The observe
	// modal opens on top of My groups without closing it; if the
	// lead backdrop-clicks the My groups modal while observe is
	// still visible, the parent dismisses but the observe WS
	// keeps running with no UI affordance to close it. The
	// audit row's `ended_at` would only land when the backend
	// heartbeat eventually killed the socket — a gap the
	// audit-trail invariant explicitly forbids. closeObserveModal
	// is idempotent when no observe is active, same shape as the
	// `handleLogout` call site.
	closeObserveModal();
	myGroupsModal.classList.remove("open");
	myGroupsModal.setAttribute("aria-hidden", "true");
	(myGroupsOpener ?? resolveMyGroupsOpener()).focus();
	myGroupsOpener = null;
}

myGroupsModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeMyGroupsModal();
});

myGroupsBtn.addEventListener("click", () => openMyGroupsModal(myGroupsBtn));
sidebarMyGroupsBtn.addEventListener("click", () => openMyGroupsModal(sidebarMyGroupsBtn));

myGroupsRefreshBtn.addEventListener("click", () => {
	void refreshMyGroups();
});

async function refreshMyGroups(): Promise<void> {
	myGroupsRefreshBtn.disabled = true;
	try {
		// Fetch both endpoints in parallel — independent reads, both
		// requireAuth-only. Sequentially awaiting would double the
		// modal latency without a safety upside (same shape as
		// `refreshAdmin`).
		const [groups, observableSessions] = await Promise.all([
			fetchMyGroups(),
			fetchMyObservableSessions(),
		]);
		renderMyGroups(groups, observableSessions);
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		myGroupsRefreshBtn.disabled = false;
	}
}

function renderMyGroups(groups: LeadGroup[], sessions: ObservableSession[]): void {
	myGroupsListEl.textContent = "";
	if (groups.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "You don't lead any groups yet.";
		myGroupsListEl.appendChild(empty);
		return;
	}
	// Bucket sessions by ownerUserId so each member-row can render its
	// owner's running sessions inline. The cross-user list is already
	// scoped to "members of any group I lead" by the SQL, so a single
	// pass covers every group below.
	const sessionsByOwner = new Map<string, ObservableSession[]>();
	for (const s of sessions) {
		const bucket = sessionsByOwner.get(s.ownerUserId);
		if (bucket) bucket.push(s);
		else sessionsByOwner.set(s.ownerUserId, [s]);
	}
	for (const g of groups) {
		const card = document.createElement("section");
		card.className = "admin-stat-card";
		const h = document.createElement("h4");
		h.textContent = g.description ? `${g.name} — ${g.description}` : g.name;
		card.appendChild(h);
		if (g.members.length === 0) {
			const empty = document.createElement("p");
			empty.className = "modal-hint";
			empty.textContent = "No members yet.";
			card.appendChild(empty);
			myGroupsListEl.appendChild(card);
			continue;
		}
		for (const m of g.members) {
			const memberRow = document.createElement("div");
			memberRow.className = "admin-session-row";
			const meta = document.createElement("div");
			meta.className = "admin-session-meta";
			const name = document.createElement("strong");
			name.textContent = m.username;
			meta.appendChild(name);
			const memberSessions = sessionsByOwner.get(m.userId) ?? [];
			const sub = document.createElement("span");
			sub.className = "admin-session-sub";
			sub.textContent =
				memberSessions.length === 0
					? "no active sessions"
					: `${memberSessions.length} session${memberSessions.length === 1 ? "" : "s"}`;
			meta.appendChild(sub);
			memberRow.appendChild(meta);

			// Observe buttons — one per running session. Stopped/failed
			// sessions surface in the count above but don't get an
			// Observe button: the WS attach would 1008-close because
			// `wsHandler` rejects non-running statuses, and a button
			// that always errors is worse UX than no button.
			const actions = document.createElement("div");
			actions.className = "admin-session-actions";
			for (const s of memberSessions) {
				if (s.status !== "running") continue;
				const btn = document.createElement("button");
				btn.type = "button";
				btn.textContent = `Observe "${s.name}"`;
				btn.addEventListener("click", () => {
					// openObserveModal is async (it fetches the tab list
					// before opening the WS). Fire-and-forget — it
					// surfaces its own errors via showToast, so there's
					// no caller-side rejection to handle.
					void openObserveModal(s);
				});
				actions.appendChild(btn);
			}
			memberRow.appendChild(actions);
			card.appendChild(memberRow);
		}
		myGroupsListEl.appendChild(card);
	}
}

async function openObserveModal(s: ObservableSession): Promise<void> {
	// Tear down any prior observe attach before opening a new one —
	// keeps the audit log honest (each Observe click maps to one
	// open + one close UPDATE) and avoids stacking xterm DOM nodes
	// in the modal host.
	closeObserveModal();
	// Fetch the session's tab list FIRST. The WS handler hard-rejects
	// any attach without a `?tab=...` query (returns 1008 "Missing
	// tab"), so we must pick a real tab id before opening the socket
	// — the backend has no implicit "default tab." A first slice
	// initially tried to pass no tabId and let the server "default to
	// main"; the WS close fired immediately every time. Pinning the
	// tab here is what makes observe-mode actually work end-to-end.
	//
	// `listTabs` was relaxed to `assertCanObserve` in the same review
	// fix, so a lead can read the tab list of a session they don't
	// own. Tab CREATE / DELETE stays owner-only.
	let tabs: Tab[];
	try {
		tabs = await listTabs(s.sessionId);
	} catch (err) {
		showToast(`Couldn't load tabs for "${s.name}": ${(err as Error).message}`, true);
		return;
	}
	if (tabs.length === 0) {
		// The session has no open tmux tabs — no surface to observe.
		// Owner needs to create one from their UI before the lead can
		// attach. Surface a clear toast rather than opening an empty
		// modal that would just disconnect immediately.
		showToast(`"${s.name}" has no open tabs to observe`, true);
		return;
	}
	// v1 picks the first tab — a session typically has one. A future
	// slice can add a tab picker if multi-tab observability becomes a
	// common need; for now, surfacing a count in the modal hint keeps
	// the lead aware the session may have more.
	const tab = tabs[0]!;
	observeModalTitle.textContent = `Observing "${s.name}" (${s.ownerUsername})`;
	observeModalHint.textContent =
		tabs.length === 1
			? `Read-only view of "${tab.label ?? tab.tabId}". Input is disabled — every observe-attach is logged.`
			: `Read-only view of "${tab.label ?? tab.tabId}" (1 of ${tabs.length} tabs — first shown). Input is disabled — every observe-attach is logged.`;
	observeModal.classList.add("open");
	observeModal.setAttribute("aria-hidden", "false");
	observeTerminalHost.textContent = "";
	const term = openTerminalSession({
		container: observeTerminalHost,
		sessionId: s.sessionId,
		tabId: tab.tabId,
		fontSize: currentFontSize,
		observe: true,
		onStatus: (status) => {
			// A status flip to "disconnected" means the underlying
			// session terminated or the owner stopped it. The audit
			// log row's `ended_at` is set by ws.on("close") on the
			// server. Surface a toast so the lead knows why their
			// view went dark.
			if (status === "disconnected") {
				showToast(`Observe attach to "${s.name}" disconnected`);
			}
		},
		onError: (msg) => showToast(`Observe error: ${msg}`, true),
	});
	activeObserveTerm = term;
}

function closeObserveModal(): void {
	if (activeObserveTerm) {
		// dispose() closes the WS — the server's ws.on("close") then
		// fires `recordObserveEnd()` which UPDATEs ended_at. The
		// idempotency guard (WHERE ended_at IS NULL) makes this safe
		// even if a duplicate close path also runs.
		activeObserveTerm.dispose();
		activeObserveTerm = null;
	}
	observeTerminalHost.textContent = "";
	observeModal.classList.remove("open");
	observeModal.setAttribute("aria-hidden", "true");
}

observeModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeObserveModal();
});

// (Auto-refresh moved to `autoPollTick` higher in this file — the 5 s
//  cadence subsumes the older 15 s timer that used to live here.)

export { closeMyGroupsModal, closeObserveModal };
