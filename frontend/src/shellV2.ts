/**
 * shellV2.ts — the unified shell (docs/design/ui-unificada.md §5.2, §5.3),
 * behind the runtime flag (uiShell.ts). Preview stage: everything the v1
 * markup already has is reused; this module only does what the
 * stylesheet (styles/shell-v2.css, keyed on html[data-shell="v2"]) can't:
 *
 *   - the terminal-only controls (font size, history search) move from
 *     the session bar into the tab strip's tool slot, so the bar holds
 *     only what belongs to the SESSION (name, status, view tabs, ⋯);
 *   - the ⋯ button opens the active session's action menu (the same
 *     registry as the sidebar rows);
 *   - the header's button cluster becomes one user menu.
 *
 * Nothing here touches the terminal: moving two buttons between
 * containers changes no pane, socket or geometry; the mobile drawers are
 * simply not used (CSS keeps the bar and the tabs visible), which is what
 * brings the drawer's resize cost to zero.
 */

import { openActionMenu } from "./components/actionMenu.js";
import { openActiveSessionMenu } from "./sessionCore.js";

let inited = false;

export function initShellV2(): void {
	if (inited) return;
	inited = true;

	// The merged bar (uiShell.ts `bar`, the default): on narrow screens the
	// session bar shares the header's line. The element is MOVED, not
	// cloned, so every module keeps its references; on a wide screen it
	// goes back under the header. viewSwitch.positionOverlays knows the
	// overlays then start at the top of #terminal-area.
	if (document.documentElement.dataset.bar === "merged") {
		const toolbar = document.getElementById("terminal-toolbar");
		const header = document.querySelector("header");
		const area = document.getElementById("terminal-area");
		const tabs = document.getElementById("terminal-tabs");
		const toggle = document.getElementById("sidebar-toggle");
		if (toolbar && header && area && tabs && toggle) {
			const mql = window.matchMedia("(max-width: 768px)");
			const place = () => {
				if (mql.matches) {
					if (toolbar.parentElement !== header) toggle.insertAdjacentElement("afterend", toolbar);
				} else if (toolbar.parentElement !== area) {
					area.insertBefore(toolbar, tabs);
				}
			};
			place();
			mql.addEventListener("change", place);
		}
	}

	// Terminal-only controls → the tab strip's tool slot. The Insert (+)
	// menu writes into the terminal, so it belongs with them, not in the
	// header: that is what keeps the session name legible on a 390-px
	// merged bar. It stays reachable on the Terminal view (the strip is
	// always visible there) and is hidden under an overlay as before.
	const tools = document.getElementById("tab-tools");
	for (const id of [
		"terminal-search-input",
		"terminal-search-btn",
		"font-size-btn",
		"actions-btn",
	]) {
		const el = document.getElementById(id);
		if (el && tools) tools.appendChild(el);
	}

	// Session actions as one menu in the bar.
	const sessionMenuBtn = document.getElementById("session-menu-btn");
	if (sessionMenuBtn) {
		sessionMenuBtn.hidden = false;
		sessionMenuBtn.addEventListener("click", () => openActiveSessionMenu(sessionMenuBtn));
	}

	// The header cluster as one user menu. Items are the cluster's own
	// buttons (their visibility and labels already follow role and push
	// state), so picking one is exactly the click it replaces.
	const userMenuBtn = document.getElementById("user-menu-btn");
	if (userMenuBtn) {
		userMenuBtn.hidden = false;
		userMenuBtn.addEventListener("click", () => {
			const cluster = [
				"templates-btn",
				"invites-btn",
				"my-groups-btn",
				"admin-btn",
				"notifications-btn",
				"logout-btn",
			]
				.map((id) => document.getElementById(id))
				.filter((b): b is HTMLButtonElement => b instanceof HTMLButtonElement)
				.filter((b) => !b.hidden && !b.classList.contains("hidden"));
			openActionMenu({
				title: "Account",
				opener: userMenuBtn,
				items: cluster.map((b) => ({
					id: b.id,
					label: b.textContent?.trim() ?? b.id,
					hint: b.title || undefined,
					kind: b.id === "logout-btn" ? "danger" : "normal",
					enabled: !b.disabled,
					reason: b.disabled ? b.title || undefined : undefined,
				})),
				onPick: (id) => document.getElementById(id)?.click(),
			});
		});
	}
}
