/**
 * sessionCore.ts — the session-list + tab lifecycle, the heart of the SPA
 * (#312). Owns refreshSessions/renderSessionList/openSession/updateToolbar
 * and renderTabBar/openTab/addTab/closeTab. Extracted from main.ts.
 *
 * The cross-cutting session/tab state stays declared in main.ts; this
 * module reads the live bindings directly and writes via the setters
 * (ESM forbids reassigning imported bindings). All main.ts imports are
 * used only inside functions, so the circular import is TDZ-safe.
 */

import {
	createTab,
	deleteSession,
	deleteTab,
	getSession,
	listSessions,
	listTabs,
	startSession,
	stopSession,
	TabNotFoundError,
} from "./api.js";
import { formatBytes, formatCpuCores, formatCpuPercent } from "./format.js";
import { transformKeyInput } from "./keyBar.js";
import {
	activeSessionId,
	closingTabs,
	currentActiveTabId,
	currentTabs,
	currentTerminals,
	disposeAllCurrentTerminals,
	isMobile,
	maybeInjectSelectionHint,
	sessions,
	setActiveSessionId,
	setChromeOpen,
	setCurrentActiveTabId,
	setCurrentTabs,
	setSessions,
	showCopySuccessToast,
	showToast,
	updateChromeToggle,
} from "./main.js";
import { renderSidebarObservables } from "./myGroups.js";
import { openBootstrapLogModal } from "./newSession.js";
import { badgeFor, clearBadge, recordOutput } from "./tabActivity.js";
import { openTerminalSession, type SessionStatus } from "./terminal.js";

// ── DOM (re-queried locally) ─────────────────────────────────────────────
const sessionList = document.getElementById("session-list")!;
const showTerminatedToggle = document.getElementById("show-terminated-toggle") as HTMLInputElement;
const terminalToolbar = document.getElementById("terminal-toolbar")!;
const terminalSessionName = document.getElementById("terminal-session-name")!;
const terminalStatusBadge = document.getElementById("terminal-status-badge")!;
const terminalTabs = document.getElementById("terminal-tabs")!;
const terminalContainer = document.getElementById("terminal-container")!;
const emptyState = document.getElementById("empty-state")!;

// ── Session management ──────────────────────────────────────────────────────

export async function refreshSessions() {
	// Read the checkbox state fresh every time so there's no stale
	// module-variable to get out of sync with the DOM.
	const includeTerminated = showTerminatedToggle.checked;
	try {
		setSessions(await listSessions(includeTerminated));
		console.debug(
			`[sessions] fetched ${sessions.length} session(s) (includeTerminated=${includeTerminated})`,
			sessions.map((s) => ({ id: s.sessionId.slice(0, 8), name: s.name, status: s.status })),
		);
		renderSessionList();
	} catch (err) {
		showToast((err as Error).message, true);
	}
}

export function renderSessionList() {
	sessionList.innerHTML = "";
	for (const s of sessions) {
		const item = document.createElement("div");
		// Status class on the wrapper mirrors the session-dot rules so
		// future CSS can target failed/terminated items uniformly (dim
		// them, cross them out, etc.) without re-deriving the status
		// from a child element. Today only `terminated` has a wrapper
		// rule (.session-item.terminated dims the row); failed shows
		// up via the dot only — adding the class now means a follow-up
		// styling tweak doesn't have to touch this line.
		const statusCls = s.status === "terminated" || s.status === "failed" ? ` ${s.status}` : "";
		item.className = `session-item${s.sessionId === activeSessionId ? " active" : ""}${statusCls}`;

		const dot = document.createElement("span");
		dot.className = `session-dot ${s.status}`;
		item.appendChild(dot);

		// #271 — wrap the name (and the optional usage line) in a
		// vertical column so the live-usage subtitle sits under the
		// name without breaking the parent flex row's dot/name/actions
		// alignment. Pre-#271 this was a single `.session-name` span
		// appended directly to `item`; the column container preserves
		// the same `.session-name` styling underneath.
		const nameCol = document.createElement("span");
		nameCol.className = "session-name-col";

		const name = document.createElement("span");
		name.className = "session-name";
		name.textContent = s.name;
		nameCol.appendChild(name);

		// Live usage lines (#272: stacked CPU + mem on separate rows so
		// each metric is its own visual line). Render only for running
		// sessions whose stats fetch succeeded — stopped/terminated/
		// failed rows have no live data and a "—" placeholder would be
		// noise on what's usually most of an inactive list.
		// Truthy check (not `!== null`) so a SessionInfo with `usage`
		// undefined — e.g. a POST /sessions response immediately after
		// create, before the next auto-poll has refilled the list —
		// doesn't slip past the guard. Pre-fix this crashed with
		// "Cannot read properties of undefined (reading 'cpuPercent')"
		// on the line below.
		if (s.status === "running" && s.usage) {
			const cpuCores = s.usage.cpuPercent / 100;
			const cpuLine = document.createElement("span");
			cpuLine.className = "session-usage";
			cpuLine.textContent = `CPU ${formatCpuCores(cpuCores)} cores (${formatCpuPercent(s.usage.cpuPercent)})`;
			nameCol.appendChild(cpuLine);

			const memLine = document.createElement("span");
			memLine.className = "session-usage";
			memLine.textContent = `Mem ${formatBytes(s.usage.memBytes)} (${s.usage.memPercent.toFixed(0)}%)`;
			nameCol.appendChild(memLine);
		}

		item.appendChild(nameCol);

		// Action buttons
		const actions = document.createElement("span");
		actions.className = "session-actions";

		if (s.status === "stopped") {
			const playBtn = document.createElement("button");
			playBtn.className = "session-action-btn start";
			playBtn.textContent = "▶";
			playBtn.title = "Start";
			playBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				try {
					await startSession(s.sessionId);
					await refreshSessions();
				} catch (err) {
					showToast((err as Error).message, true);
				}
			});
			actions.appendChild(playBtn);
		} else if (s.status === "running") {
			const stopBtn = document.createElement("button");
			stopBtn.className = "session-action-btn stop";
			stopBtn.textContent = "⏸";
			stopBtn.title = "Stop";
			stopBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				try {
					await stopSession(s.sessionId);
					await refreshSessions();
				} catch (err) {
					showToast((err as Error).message, true);
				}
			});
			actions.appendChild(stopBtn);
		} else if (s.status === "terminated") {
			// Restore — spawns a fresh container reusing the original
			// container name + workspace bind mount. Files are preserved.
			const restoreBtn = document.createElement("button");
			restoreBtn.className = "session-action-btn start";
			restoreBtn.textContent = "↻";
			restoreBtn.title = "Restore (respawn container with existing workspace files)";
			restoreBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				try {
					showToast(`Restoring "${s.name}"…`);
					await startSession(s.sessionId);
					await refreshSessions();
					showToast(`Session "${s.name}" restored`);
				} catch (err) {
					showToast((err as Error).message, true);
				}
			});
			actions.appendChild(restoreBtn);
		}

		const killBtn = document.createElement("button");
		killBtn.className = "session-kill";
		killBtn.textContent = "✕";
		// Shift-click enables hard delete — also wipes workspace files and
		// removes the session record entirely. Plain click is a soft delete,
		// which keeps the workspace files so the session can be restored.
		killBtn.title =
			s.status === "terminated"
				? "Delete permanently (wipes workspace files)"
				: "Terminate (Shift-click to also wipe workspace files)";
		killBtn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const mouseEvent = e as MouseEvent;
			// If the session is already terminated, the only meaningful action
			// is hard delete — otherwise there's nothing to do.
			const hard = s.status === "terminated" || mouseEvent.shiftKey;

			const prompt = hard
				? `Permanently delete "${s.name}"?\n\nThis stops and removes the container, wipes workspace files from disk, and removes the session record. This cannot be undone.`
				: `Terminate "${s.name}"?\n\nContainer will be stopped and removed. Workspace files are preserved — you can restore the session later.`;
			if (!confirm(prompt)) return;

			try {
				await deleteSession(s.sessionId, hard);
				if (activeSessionId === s.sessionId) {
					disposeAllCurrentTerminals();
					setActiveSessionId(null);
					updateToolbar();
				}
				await refreshSessions();
			} catch (err) {
				showToast((err as Error).message, true);
			}
		});
		actions.appendChild(killBtn);
		item.appendChild(actions);

		// Click to open session
		item.addEventListener("click", () => {
			if (s.status === "running") {
				void openSession(s.sessionId);
			} else if (s.status === "stopped") {
				showToast("Start the session first", true);
			} else if (s.status === "failed") {
				// Failed sessions are unrecoverable via /start (the server
				// 409s). #274 lets the user inspect the captured bootstrap
				// output (clone / postCreate stderr) so they can fix the
				// config before recreating — pre-#274 the toast told them
				// to recreate but offered no way to see WHY it failed.
				void openBootstrapLogModal(s);
			}
		});

		sessionList.appendChild(item);
	}
	// Sidebar observables (#394) dedupe against THIS list, so re-render
	// them whenever it changes. Without this, the initial-load race —
	// observables fetch resolving before the first listSessions() — shows
	// the user's own sessions as "read-only" rows for up to one poll
	// cycle. Hooking here (not just the 5 s tick) makes the dedupe
	// deterministic: whichever fetch lands last re-renders with both
	// datasets present.
	renderSidebarObservables();
}

export async function openSession(sessionId: string) {
	if (activeSessionId === sessionId) return;

	// Tabs stay alive across tab-switch, but are torn down on session-switch.
	disposeAllCurrentTerminals();

	setActiveSessionId(sessionId);
	renderSessionList();
	updateToolbar();

	// Capturing `sessionId` guards against a rapid second openSession call
	// clobbering this one — each `await` re-checks identity.
	try {
		const tabs = await listTabs(sessionId);
		if (activeSessionId !== sessionId) return;
		// Sort by creation order so +-added tabs stay on the right
		// (listTabs returns alphabetical from tmux list-sessions).
		setCurrentTabs(tabs.sort((a, b) => a.createdAt - b.createdAt));
	} catch (err) {
		// Drop back to empty state so the toolbar/container don't linger
		// visible with no tabs.
		if (activeSessionId === sessionId) {
			setActiveSessionId(null);
			setCurrentTabs([]);
			renderSessionList();
			updateToolbar();
		}
		showToast((err as Error).message, true);
		return;
	}

	// Freshly-spawned session legitimately has zero tabs — the container no
	// longer creates one at boot. Render just the + so the user can open
	// their first tab, and keep the terminal pane hidden.
	if (currentTabs.length === 0) {
		renderTabBar();
		// On mobile the chrome drawer (where the + button lives) is
		// collapsed by default — auto-expand it for the empty session
		// so the user can actually find the + without hunting for it.
		if (isMobile()) setChromeOpen(true);
		return;
	}

	// Tapping a session in the sidebar drawer is the user's "go to that
	// tmux" gesture; collapse the chrome drawer too so the freshly-attached
	// terminal gets the full viewport. Mirrors the chip-click and addTab
	// success paths — without this, switching session-to-session on mobile
	// leaves whichever drawer state was last set by the previous session
	// covering the top of the viewport.
	if (isMobile()) setChromeOpen(false);

	// Render the tab bar BEFORE calling openTab — disposeAllCurrentTerminals()
	// at the top of openSession set #terminal-tabs to display:none, and
	// openTab's own renderTabBar() runs at its tail (after the new pane has
	// been mounted and openTerminalSession's synchronous fitAddon.fit() has
	// already read pane dimensions). Without this pre-render the first auto-
	// opened tab fits at the too-tall geometry of a tab-bar-less layout, the
	// WS opens at that wrong cols/rows (geometry is baked into the upgrade
	// URL — see terminal.ts buildWsUrl), and the backend's attach() / tmux
	// resize-window runs at the wrong size. ResizeObserver corrects xterm
	// locally on the next frame but the backend resize is debounced 100 ms,
	// so the snapshot replay and the first ~100 ms of tmux output land at
	// the wrong row count — visible as a one-row drift where typed input
	// renders below where the prompt actually is, only fixable by a
	// subsequent layout-changing event (sidebar toggle) that bumps tmux
	// into a full repaint at the correct geometry. Subsequent openTab
	// calls (chip clicks, +-add) don't hit this because the tabs row is
	// already laid out by then. openTab's own renderTabBar() at its tail
	// re-runs to mark the active chip — this pre-render just ensures the
	// height is settled.
	renderTabBar();

	// openTab can throw synchronously (openTerminalSession init failure) —
	// openSession is called with `void`, so an unhandled throw here would
	// become an unhandled rejection with no toast and the UI left mid-switch.
	try {
		openTab(currentTabs[0]!.tabId);
	} catch (err) {
		if (activeSessionId === sessionId) {
			setActiveSessionId(null);
			setCurrentTabs([]);
			renderSessionList();
			updateToolbar();
		}
		showToast((err as Error).message, true);
	}
}

export function updateToolbar() {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) {
		terminalToolbar.style.display = "none";
		terminalTabs.style.display = "none";
		terminalContainer.style.display = "none";
		emptyState.style.display = "flex";
		updateChromeToggle();
		return;
	}
	terminalToolbar.style.display = "flex";
	// #terminal-tabs and #terminal-container are flipped to visible only
	// by renderTabBar/openTab — avoids an empty-bar flash before listTabs
	// resolves.
	emptyState.style.display = "none";
	terminalSessionName.textContent = s.name;
	terminalStatusBadge.textContent = s.status;
	terminalStatusBadge.className = s.status;
	// Refresh the mobile header context pill — its label tracks the
	// active session/tab, and visibility flips on/off here.
	updateChromeToggle();
}

// ── Tabs within the active session ──────────────────────────────────────────

export function renderTabBar() {
	terminalTabs.innerHTML = "";
	if (!activeSessionId) {
		terminalTabs.style.display = "none";
		return;
	}
	// Render even at currentTabs.length === 0 so the + button is reachable
	// — a brand-new session starts with no tabs and the user opens the
	// first one from here.
	terminalTabs.style.display = "flex";

	for (const tab of currentTabs) {
		const chip = document.createElement("div");
		const badge = badgeFor(tab.tabId);
		chip.className = `tab-chip${tab.tabId === currentActiveTabId ? " active" : ""}${badge ? ` activity-${badge}` : ""}`;
		chip.dataset.tabId = tab.tabId;
		chip.title = tab.label;

		const label = document.createElement("span");
		label.className = "tab-chip-label";
		label.textContent = tab.label;
		chip.appendChild(label);

		const close = document.createElement("button");
		close.className = "tab-close";
		close.textContent = "×";
		close.title = "Close tab";
		close.disabled = closingTabs.has(tab.tabId);
		close.addEventListener("click", (e) => {
			e.stopPropagation();
			void closeTab(tab.tabId, close);
		});
		chip.appendChild(close);

		chip.addEventListener("click", () => {
			// Click handlers eat synchronous throws — surface them as
			// a toast instead of letting the UI silently revert.
			try {
				openTab(tab.tabId);
			} catch (err) {
				showToast((err as Error).message, true);
			}
		});
		terminalTabs.appendChild(chip);
	}

	const addBtn = document.createElement("button");
	addBtn.id = "tab-add";
	addBtn.type = "button";
	addBtn.textContent = "+";
	addBtn.title = "Open a new tab (runs services independently; close to SIGHUP them)";
	addBtn.addEventListener("click", () => void addTab(addBtn));
	terminalTabs.appendChild(addBtn);
	// The chrome-toggle label tracks whichever tab is active — refresh
	// every time the bar is rebuilt so renames/closes/switches stay in
	// sync without having to thread updateChromeToggle() through every
	// caller of openTab/addTab/closeTab.
	updateChromeToggle();
}

// Targeted repaint of one chip's activity badge (#359) — output streams
// per-chunk, so rebuilding the whole bar on every state flip would churn
// DOM for nothing when only a class pair changes.
function updateChipBadge(tabId: string) {
	const chip = terminalTabs.querySelector(`.tab-chip[data-tab-id="${CSS.escape(tabId)}"]`);
	if (!chip) return;
	const badge = badgeFor(tabId);
	chip.classList.toggle("activity-output", badge === "output");
	chip.classList.toggle("activity-bell", badge === "bell");
}

function openTab(tabId: string) {
	if (!activeSessionId) return;
	if (tabId === currentActiveTabId) return;
	if (!currentTabs.some((t) => t.tabId === tabId)) return;

	// Only spin up a terminal for a running session — matches the sidebar.
	// Treat a missing sessions[] entry as not-running too; if the list is
	// stale or the session was deleted externally, attaching would just
	// fail via the WS and leave a blank pane mounted as the active tab.
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s || s.status !== "running") {
		showToast("Session isn't running — start it first", true);
		return;
	}

	// Capture the previously-active tab before stripping .active so we can
	// restore the UI if openTerminalSession throws below — otherwise the
	// prev pane stays invisible AND the `tabId === currentActiveTabId`
	// guard above prevents the user from re-clicking its chip.
	const prevActiveTabId = currentActiveTabId;
	if (currentActiveTabId) {
		currentTerminals.get(currentActiveTabId)?.pane.classList.remove("active");
	}

	// Lazily spin up the xterm+WS; re-opens of the same tab just toggle
	// .active without reconnecting.
	let entry = currentTerminals.get(tabId);
	if (!entry) {
		const pane = document.createElement("div");
		// `active` from creation, and the parent flipped to display:block
		// BEFORE openTerminalSession runs. xterm's fit() inside that call
		// is synchronous and reads container.clientWidth/Height — if the
		// pane is still inside a display:none subtree it sees 0, falls
		// back to the 80x24 default, and the WS opens at that bogus
		// geometry. tmux then attaches/resumes at 80x24 and the visible
		// terminal shows mis-columned output until the next resize event
		// (sidebar toggle, viewport change) bumps it to real cols/rows.
		pane.className = "tab-pane active";
		pane.dataset.tabId = tabId;
		terminalContainer.appendChild(pane);
		terminalContainer.style.display = "block";

		// Capture the sessionId for this terminal — if the user switches
		// sessions while this WS is closing, `onStatus("disconnected")`
		// mustn't write to whatever session happens to be active *now*.
		const ownSessionId = activeSessionId;
		try {
			const term = openTerminalSession({
				container: pane,
				sessionId: ownSessionId,
				tabId,
				// Sticky-Ctrl from the mobile key bar. One shared transform
				// across every tab — the armed state lives in keyBar.ts (the
				// bar is a global widget), so whichever tab receives the next
				// keystroke consumes the same state the button displays.
				transformInput: transformKeyInput,
				// Auto-reconnect probe (#356): consulted before each retry so
				// a session stopped from another device doesn't get hammered
				// with doomed attach attempts (the backend has no "stopped"
				// close code — the exec stream just ends). A thrown probe is
				// treated as inconclusive by terminal.ts (keep retrying) —
				// during a Tunnel blip REST is as dead as the WS, and only a
				// definitive "not running" should abort the loop.
				canReconnect: async () => (await getSession(ownSessionId)).status === "running",
				onOutput: (data: string) => {
					// Session guard mirrors onStatus/onError: a chunk draining
					// from a torn-down tab after a session switch must not
					// badge whatever chip happens to hold this tabId now.
					if (activeSessionId !== ownSessionId) return;
					if (recordOutput(tabId, data, tabId === currentActiveTabId)) {
						updateChipBadge(tabId);
					}
				},
				onStatus: (status: SessionStatus) => {
					if (activeSessionId !== ownSessionId) return;

					if (status === "disconnected") {
						// "disconnected" is a frontend-only synthetic state
						// fired by ws.onclose — the backend never sends it.
						// Writing it into s.status casts an out-of-type value
						// into SessionInfo.status (typed only as
						// "running"|"stopped"|"terminated") and used to brick
						// the session on any transient WS drop (Cloudflare
						// Tunnel idle timeout ≈100 s, JWT refresh, network
						// blip):
						//   - the sidebar click handler matches neither
						//     "running" nor "stopped" → clicking the session
						//     became a silent no-op. Users reported this as
						//     "my tab went invalid when I came back to the
						//     session" — it's the session, not the tab.
						//   - openTab's `status !== "running"` guard refused
						//     to attach on a perfectly healthy backend.
						//
						// Leave s.status alone; pull the authoritative status
						// with refreshSessions() so the sidebar reflects
						// whatever the backend actually says. Also tear down
						// the dead terminal for this tab so a later click on
						// its chip recreates a fresh WebSocket instead of
						// re-activating a frozen pane. The tab itself stays
						// in currentTabs (still a valid tmux session on the
						// backend) so it remains reachable from the tab bar.
						const entry = currentTerminals.get(tabId);
						if (entry) {
							// queueMicrotask so we don't dispose xterm
							// synchronously inside its own ws.onclose
							// callback chain.
							queueMicrotask(() => {
								const latest = currentTerminals.get(tabId);
								if (!latest || latest !== entry) return;
								latest.term.dispose();
								latest.pane.remove();
								currentTerminals.delete(tabId);
								if (currentActiveTabId === tabId) {
									setCurrentActiveTabId(null);
									terminalContainer.style.display = "none";
									// refreshSessions() below will eventually round-trip
									// and call updateToolbar(), but until that resolves
									// the toolbar still shows the session name + status
									// badge with no terminal beneath it. Match the rest
									// of the codebase (closeTab, openSession's error
									// paths) by syncing the toolbar to the new state
									// synchronously — if the session was meanwhile
									// dropped from sessions[] (rare, but possible if
									// refreshSessions raced ahead), the empty-state
									// panel takes over instead of an orphan toolbar.
									updateToolbar();
								}
								renderTabBar();
							});
						}
						void refreshSessions();
						return;
					}

					if (status === "reconnecting") {
						// Synthetic frontend-only state like "disconnected"
						// above: fired while terminal.ts retries a dropped WS
						// with backoff (#356). Badge-only — it must never land
						// in s.status (same out-of-type footgun documented on
						// the disconnected branch), and the terminal for this
						// tab is deliberately NOT torn down: the retry loop
						// owns the socket, and a successful re-attach repaints
						// in place. Only the active tab may repaint the shared
						// badge (same rule as the backend-status path below).
						if (tabId !== currentActiveTabId) return;
						terminalStatusBadge.textContent = "reconnecting";
						terminalStatusBadge.className = "reconnecting";
						return;
					}

					// Backend-sourced status ("running" on attach). Only the
					// active tab drives the shared session badge — a background
					// tab's signal must not override the foreground view.
					if (tabId !== currentActiveTabId) return;
					const s = sessions.find((x) => x.sessionId === ownSessionId);
					if (s) s.status = status;
					updateToolbar();
					renderSessionList();
				},
				onError: (msg: string) => {
					// Same identity guard as onStatus: background tabs
					// and post-session-switch WS errors must not surface
					// toasts attributed to whatever session is current now.
					if (activeSessionId !== ownSessionId) return;
					showToast(msg, true);
				},
				onRendererFallback: (msg: string) => {
					// Show even for non-active tabs — a backgrounded tab
					// that loses its WebGL context will surface the
					// notice when it next becomes active or, in this
					// flow, immediately. Toast is once per renderer tier
					// (webgl→canvas, canvas→dom; gated inside
					// terminal.ts) so a flapping driver can't spam it —
					// worst case two toasts per tab. Surfaced as a
					// non-error toast because the terminal still works,
					// just slower.
					// Suffix is tier-agnostic on purpose: for the webgl→canvas
					// notice a reload genuinely retries GPU rendering, but for
					// the canvas→dom notice (both tiers failing on this
					// hardware) promising "GPU rendering" back would be
					// over-selling what a reload can do.
					showToast(`${msg} Reload the tab to try again.`);
				},
				onCopy: (ok: boolean) => {
					// Identity guards mirror onStatus / onError above:
					// session match prevents stale toasts from a
					// torn-down tab in a different session, and active-tab
					// match prevents a background tab in the SAME session
					// from toasting against whatever pane the user is
					// currently looking at.
					if (activeSessionId !== ownSessionId) return;
					if (tabId !== currentActiveTabId) return;
					if (ok) {
						// Success chip is intentionally brief (1.2s vs the
						// 4s error toast) — auto-copy fires on every
						// selection-finalise, and originally the design
						// rationale for failure-only was "matches native
						// Cmd-C feel". Field reports showed users with no
						// signal that the copy happened didn't trust the
						// mechanism — the short chip is the smallest
						// addition that confirms without spamming. The
						// chip is unconditional rather than first-time-
						// only because the auto-copy path is genuinely
						// invisible (no Cmd-C kinaesthetic feedback,
						// selection stays highlighted as terminals do)
						// and a one-time confirmation would leave power
						// users wondering "did that one copy too?".
						showCopySuccessToast();
					} else {
						showToast("Copy failed — clipboard permission denied?", true);
					}
				},
				isActive: () => activeSessionId === ownSessionId && tabId === currentActiveTabId,
			});
			entry = { pane, term };
			currentTerminals.set(tabId, entry);
			maybeInjectSelectionHint(pane);
		} catch (err) {
			pane.remove();
			if (prevActiveTabId) {
				currentTerminals.get(prevActiveTabId)?.pane.classList.add("active");
			} else {
				// We just flipped terminalContainer to display:block to host
				// the new pane; with no prev pane to swap back to and our
				// pane removed, leaving display:block would render an empty
				// dark box. Revert.
				terminalContainer.style.display = "none";
			}
			throw err;
		}
	}

	entry.pane.classList.add("active");
	terminalContainer.style.display = "block";
	setCurrentActiveTabId(tabId);
	// Activation acknowledges the pending activity — the user is now
	// looking at whatever rang/streamed. renderTabBar() below repaints
	// the chip from the cleared state.
	clearBadge(tabId);
	renderTabBar();
}

async function addTab(triggeredBy?: HTMLButtonElement) {
	if (!activeSessionId) return;
	const sessionId = activeSessionId;
	const sessionName =
		sessions.find((x) => x.sessionId === sessionId)?.name ?? sessionId.slice(0, 8);
	// Pre-check: don't create a backend tab we can't attach to. Matches
	// openTab's own guard so this short-circuits before the POST. Treat
	// "session missing from local list" as not-running too, matching both
	// openTab and the post-check below.
	const statusBefore = sessions.find((x) => x.sessionId === sessionId)?.status;
	if (!statusBefore || statusBefore !== "running") {
		showToast("Session isn't running — start it first", true);
		return;
	}
	if (triggeredBy) triggeredBy.disabled = true;
	try {
		// Default label: smallest "Tab N" not already in use. Using
		// `currentTabs.length + 1` would collide after a middle tab
		// was closed (e.g. [Tab 1, Tab 3] + add → another "Tab 3").
		const tab = await createTab(sessionId, nextDefaultLabel());
		if (activeSessionId !== sessionId) {
			// User switched away before the POST resolved. The backend tab
			// exists but was never shown; clean it up so it doesn't resurface
			// on the next listTabs for that session. Fire-and-forget, but if
			// the cleanup fails surface a toast — include the owning session
			// name so the user knows WHICH session has the orphan, not just
			// whichever session happens to be active now.
			void deleteTab(sessionId, tab.tabId).catch((err) => {
				console.warn(`[tabs] orphan cleanup failed for ${tab.tabId}:`, err);
				showToast(`Orphan tab left on "${sessionName}": ${(err as Error).message}`, true);
			});
			return;
		}
		// Post-check: session may have stopped during the POST round-trip.
		// openTab returns early (silent toast + return) on non-running
		// sessions, which would otherwise leave us with currentTabs and
		// a backend tab both pointing at an unattachable tmux session.
		const statusAfter = sessions.find((x) => x.sessionId === sessionId)?.status;
		if (!statusAfter || statusAfter !== "running") {
			void deleteTab(sessionId, tab.tabId).catch((err) => {
				console.warn(`[tabs] post-stop cleanup failed for ${tab.tabId}:`, err);
				showToast(`Orphan tab left on "${sessionName}": ${(err as Error).message}`, true);
			});
			showToast("Session stopped — tab discarded", true);
			return;
		}
		currentTabs.push(tab);
		try {
			openTab(tab.tabId);
			// The tab-bar click listener auto-closes the chrome drawer
			// on chip clicks, but the + button is filtered out of that
			// path (it's not a chip yet at click time). Mirror the
			// behaviour here so adding a tab on mobile drops the user
			// straight into the new tmux pane instead of leaving the
			// drawer covering the top of the viewport.
			if (isMobile()) setChromeOpen(false);
		} catch (err) {
			// Roll back the push so the chip doesn't linger pointing at a
			// tab with no currentTerminals entry, and clean up the backend
			// tab fire-and-forget since it was never actually shown.
			setCurrentTabs(currentTabs.filter((t) => t.tabId !== tab.tabId));
			void deleteTab(sessionId, tab.tabId).catch((cleanupErr) => {
				console.warn(`[tabs] rollback cleanup failed for ${tab.tabId}:`, cleanupErr);
				showToast(`Orphan tab left on "${sessionName}": ${(cleanupErr as Error).message}`, true);
			});
			renderTabBar();
			throw err;
		}
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		// The inner-catch renderTabBar() rebuilds the + button, so the
		// original triggeredBy may be detached by the time we get here.
		if (triggeredBy?.isConnected) triggeredBy.disabled = false;
	}
}

function nextDefaultLabel(): string {
	const used = new Set(currentTabs.map((t) => t.label));
	let n = 1;
	while (used.has(`Tab ${n}`)) n++;
	return `Tab ${n}`;
}

async function closeTab(tabId: string, triggeredBy?: HTMLButtonElement) {
	if (!activeSessionId) return;
	const sessionId = activeSessionId;
	if (closingTabs.has(tabId)) return; // duplicate invocation for same tab
	const tabLabel = currentTabs.find((t) => t.tabId === tabId)?.label ?? tabId;
	if (
		!confirm(
			`Close tab "${tabLabel}"?\n\nAny processes running in this tab will be terminated (SIGHUP).`,
		)
	) {
		return;
	}
	closingTabs.add(tabId);
	// Re-render so sibling chips' × reflects the in-flight close (their
	// disabled state mirrors the same guard).
	renderTabBar();
	if (triggeredBy) triggeredBy.disabled = true;

	try {
		await deleteTab(sessionId, tabId);
	} catch (err) {
		// 404 means the backend already lost the tab (e.g. tmux server died).
		// Drop the stale chip from the UI rather than leaving the user stuck
		// with an unremovable phantom tab.
		if (err instanceof TabNotFoundError) {
			// fall through to the success path below
		} else {
			closingTabs.delete(tabId);
			renderTabBar();
			showToast((err as Error).message, true);
			if (triggeredBy?.isConnected) triggeredBy.disabled = false;
			return;
		}
	}
	closingTabs.delete(tabId);
	// Stale-session guard: renderTabBar() below rebuilds chips anyway, so
	// the old `triggeredBy` becomes detached — no need to re-enable it.
	if (activeSessionId !== sessionId) return;

	const closedIndex = currentTabs.findIndex((t) => t.tabId === tabId);
	const entry = currentTerminals.get(tabId);
	if (entry) {
		entry.term.dispose();
		entry.pane.remove();
		currentTerminals.delete(tabId);
	}
	setCurrentTabs(currentTabs.filter((t) => t.tabId !== tabId));
	clearBadge(tabId);

	// Closing the last tab on mobile leaves the chrome drawer collapsed
	// (default state), and the CSS hides #terminal-tabs entirely while
	// collapsed — so the + button rebuilt by renderTabBar() below isn't
	// reachable until the user discovers the header pill. Mirror the
	// openSession empty-tabs branch and auto-expand here too, so the
	// first new tab is always one tap away.
	if (isMobile() && currentTabs.length === 0) setChromeOpen(true);

	if (currentActiveTabId === tabId) {
		setCurrentActiveTabId(null);
		// Nearest surviving neighbour: what was at the same index is now
		// the next sibling; clamp to the new last tab when we closed the
		// rightmost one. If the tab wasn't in currentTabs at findIndex
		// time (state drifted from under us), fall back to index 0.
		const s = sessions.find((x) => x.sessionId === activeSessionId);
		if (currentTabs.length > 0 && s?.status === "running") {
			const idx = closedIndex < 0 ? 0 : Math.min(closedIndex, currentTabs.length - 1);
			const next = currentTabs[idx];
			if (next) {
				// closeTab runs as `void`, so a sync throw from openTab
				// (openTerminalSession init failure) would be swallowed.
				// openTab's own prevActiveTabId restore is a no-op here
				// since the prev tab was just removed — recover directly.
				try {
					openTab(next.tabId);
					return;
				} catch (err) {
					// Spell out the connection — the user sees a blank
					// panel otherwise with no hint why.
					showToast(`Couldn't switch to "${next.label}": ${(err as Error).message}`, true);
					terminalContainer.style.display = "none";
					renderTabBar();
					return;
				}
			}
		}
		// No running sibling to switch to — hide the container so we
		// don't leave an empty block sitting where the terminal was.
		terminalContainer.style.display = "none";
	}
	renderTabBar();
}
