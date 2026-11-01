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
	isLead,
	type LeadGroup,
	type ObservableSession,
} from "./api.js";
import { createDialog } from "./components/dialog.js";
import { sessions, sessionsLoadedOnce, showToast } from "./main.js";
import { closeObserveModal, openObserveModalFor } from "./observeModal.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const myGroupsBtn = document.getElementById("my-groups-btn") as HTMLButtonElement;
const sidebarMyGroupsBtn = document.getElementById("sidebar-my-groups-btn") as HTMLButtonElement;
const myGroupsModal = document.getElementById("my-groups-modal")!;
const myGroupsListEl = document.getElementById("my-groups-list")!;
const myGroupsRefreshBtn = document.getElementById("my-groups-refresh-btn") as HTMLButtonElement;
const observableSection = document.getElementById("observable-section")!;
const observableListEl = document.getElementById("observable-list")!;

// ── My groups (#201e — lead-side observe surface) ──────────────────────────
//
// Visible only to users who lead at least one group via
// `applyAdminVisibility()` (which also gates the lead button). Pulls
// `/api/groups/mine` + `/api/groups/mine/sessions` on open + refresh —
// no auto-polling, same rationale as the admin dashboard. The observe
// modal itself lives in `observeModal.ts` (shared with the admin
// dashboard, #admin-operate 4/4); this module only builds the
// lead-flavoured `ObserveTarget` and opens it read-only (no
// `canOperate` — a lead never gets the Take control button).

// Closing My groups cascades to the observe dialog opened on top of it
// (components/dialog.ts), so a backdrop click on the parent can't leave
// an observe WebSocket running with no UI to close it — the audit row's
// ended_at depends on that close.
const myGroupsDialog = createDialog(myGroupsModal, { initialFocus: () => myGroupsRefreshBtn });

/** Open the shared observe modal for one of a lead's observable
 *  sessions — always read-only (no `canOperate`). The reconnect probe
 *  re-derives "still running?" from the lead-side observable list
 *  because getSession is owner-scoped (404 for a lead), and every
 *  observe attach writes an audit row, so a doomed retry against a
 *  stopped session would also pollute the log with phantom cycles. */
function openObserveForLead(s: ObservableSession): void {
	void openObserveModalFor({
		sessionId: s.sessionId,
		name: s.name,
		ownerUsername: s.ownerUsername,
		canReconnect: async () =>
			(await fetchMyObservableSessions()).some(
				(x) => x.sessionId === s.sessionId && x.status === "running",
			),
	});
}

function openMyGroupsModal(opener: HTMLButtonElement) {
	myGroupsDialog.open(opener);
	void refreshMyGroups();
}

function closeMyGroupsModal() {
	myGroupsDialog.close();
}

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
		// Feed the sidebar section (#394) from the same fetch — a lead
		// who just acted on the modal shouldn't see the sidebar lag
		// behind until its slower poll cycle catches up.
		cachedObservables = observableSessions;
		renderSidebarObservables();
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
					// Fire-and-forget — openObserveForLead delegates to the
					// shared modal, which surfaces its own errors via showToast,
					// so there's no caller-side rejection to handle.
					openObserveForLead(s);
				});
				actions.appendChild(btn);
			}
			memberRow.appendChild(actions);
			card.appendChild(memberRow);
		}
		myGroupsListEl.appendChild(card);
	}
}

// (Auto-refresh moved to `autoPollTick` higher in this file — the 5 s
//  cadence subsumes the older 15 s timer that used to live here.)

// ── Sidebar observables (#394) ──────────────────────────────────────────────
//
// The same lead-side observable list, surfaced as a sidebar section
// below the user's own sessions so a lead doesn't have to open the
// My groups modal for every observe. Fetch and render are split:
// `refreshSidebarObservables` does the D1-backed round-trip and is
// called on lead-status hydration, on the manual sidebar refresh, and
// on a slow multiple of the auto-poll; `renderSidebarObservables`
// re-renders from the cached fetch and runs on every 5 s tick — the
// dedupe against the user's own `sessions` list depends on state that
// refreshes faster than the observables themselves.

let cachedObservables: ObservableSession[] = [];

export async function refreshSidebarObservables(): Promise<void> {
	if (!isLead()) {
		cachedObservables = [];
		renderSidebarObservables();
		return;
	}
	try {
		cachedObservables = await fetchMyObservableSessions();
	} catch {
		// Silent: the sidebar is a secondary surface polled in the
		// background — a transient fetch failure here would otherwise
		// toast every lead on every network blip. The My groups modal
		// (user-initiated) keeps its loud error path.
		return;
	}
	renderSidebarObservables();
}

export function renderSidebarObservables(): void {
	// Hold the section back until the own-session list has loaded once:
	// on a fresh page load the observables fetch can win the race and a
	// render here would flash the user's own sessions as "read-only"
	// rows (dedupe against a not-yet-loaded list filters nothing).
	// renderSessionList() re-invokes this after every list render, so
	// the section appears as soon as both datasets exist — no polling
	// cycle to wait out. A user with genuinely zero sessions still
	// renders fine: setSessions([]) flips the flag.
	if (!sessionsLoadedOnce) return;
	// Own sessions already render in the list above — showing them
	// again as "observable" would read as a duplicate-row bug. The
	// modal deliberately keeps them (observing your own session in
	// read-only is a legitimate niche); the sidebar is for the
	// cross-user case.
	const own = new Set(sessions.map((s) => s.sessionId));
	const rows = cachedObservables.filter((s) => s.status === "running" && !own.has(s.sessionId));
	observableListEl.textContent = "";
	if (rows.length === 0) {
		observableSection.classList.add("hidden");
		return;
	}
	observableSection.classList.remove("hidden");
	for (const s of rows) {
		const item = document.createElement("div");
		item.className = "session-item";
		item.dataset.sessionId = s.sessionId;

		// A real button: reachable by keyboard, announced with its owner.
		const select = document.createElement("button");
		select.type = "button";
		select.className = "session-select";
		select.setAttribute("aria-label", `Observe ${s.name} (${s.ownerUsername}, read-only)`);

		const dot = document.createElement("span");
		dot.className = `session-dot ${s.status}`;
		dot.setAttribute("aria-hidden", "true");
		select.appendChild(dot);

		const nameCol = document.createElement("span");
		nameCol.className = "session-name-col";
		const name = document.createElement("span");
		name.className = "session-name";
		name.textContent = s.name;
		nameCol.appendChild(name);
		const owner = document.createElement("span");
		owner.className = "observable-owner";
		owner.textContent = `${s.ownerUsername} — read-only`;
		nameCol.appendChild(owner);
		select.appendChild(nameCol);

		select.addEventListener("click", () => {
			openObserveForLead(s);
		});
		item.appendChild(select);
		observableListEl.appendChild(item);
	}
}

/** Logout: drop the cached cross-user list and its rows. */
export function clearSidebarObservables(): void {
	cachedObservables = [];
	observableListEl.textContent = "";
	observableSection.classList.add("hidden");
}

export { closeMyGroupsModal, closeObserveModal };
