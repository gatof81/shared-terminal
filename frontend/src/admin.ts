/**
 * admin.ts — admin dashboard (#241e): stats, cross-user sessions, force
 * stop/delete, edit caps; admin Groups CRUD (#201e-2); admin observe-log;
 * per-session Observers modal. Extracted from main.ts (#312).
 *
 * DOM elements are re-queried locally via getElementById (elements are
 * singletons by id) so this module has NO module-top dependency on
 * main.ts — that avoids the circular-import TDZ trap. The only main.ts
 * imports (showToast, applyAdminVisibility) are used inside functions, so
 * they resolve at call time after both modules have finished loading.
 */

import {
	type AdminGroupDetail,
	type AdminGroupSummary,
	type AdminObserveLogEntry,
	type AdminSession,
	type AdminStats,
	addAdminGroupMember,
	adminForceDelete,
	adminForceStop,
	adminUpdateResources,
	createAdminGroup,
	deleteAdminGroup,
	fetchAdminGroup,
	fetchAdminGroups,
	fetchAdminObserveLog,
	fetchAdminSessions,
	fetchAdminStats,
	fetchSessionObserveLog,
	type ObserveLogEntry,
	removeAdminGroupMember,
	updateAdminGroup,
} from "./api.js";
import { formatBytes, formatCpuCores, formatCpuPercent } from "./format.js";
import { activeSessionId, showToast } from "./main.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const sidebarAdminBtn = document.getElementById("sidebar-admin-btn") as HTMLButtonElement;
const adminBtn = document.getElementById("admin-btn") as HTMLButtonElement;
const adminModal = document.getElementById("admin-modal")!;
const adminStatsEl = document.getElementById("admin-stats")!;
const adminSessionsListEl = document.getElementById("admin-sessions-list")!;
const adminRefreshBtn = document.getElementById("admin-refresh-btn") as HTMLButtonElement;
const adminUptimeEl = document.getElementById("admin-uptime")!;
// #201e-2 — admin Groups CRUD (in admin dashboard) + admin observe-log
// + per-session Observers button. Visibility for the Groups + observe-log
// sections is the parent admin modal (admin-only). Observers button is
// shown for everyone; the backend returns 403 if the caller can't
// observe the session.
const adminGroupsListEl = document.getElementById("admin-groups-list")!;
const adminGroupCreateBtn = document.getElementById("admin-group-create-btn") as HTMLButtonElement;
const adminObserveLogEl = document.getElementById("admin-observe-log")!;
const adminGroupModal = document.getElementById("admin-group-modal")!;
const adminGroupModalTitle = document.getElementById("admin-group-modal-title")!;
const adminGroupForm = document.getElementById("admin-group-form") as HTMLFormElement;
const adminGroupNameInput = document.getElementById("admin-group-name") as HTMLInputElement;
const adminGroupDescriptionInput = document.getElementById(
	"admin-group-description",
) as HTMLInputElement;
const adminGroupLeadUserIdInput = document.getElementById(
	"admin-group-lead-user-id",
) as HTMLInputElement;
const adminGroupSubmitBtn = document.getElementById("admin-group-submit-btn") as HTMLButtonElement;
const adminGroupMembersModal = document.getElementById("admin-group-members-modal")!;
const adminGroupMembersModalTitle = document.getElementById("admin-group-members-modal-title")!;
const adminGroupMembersModalHint = document.getElementById("admin-group-members-modal-hint")!;
const adminGroupAddMemberForm = document.getElementById(
	"admin-group-add-member-form",
) as HTMLFormElement;
const adminGroupAddMemberInput = document.getElementById(
	"admin-group-add-member-input",
) as HTMLInputElement;
const adminGroupMembersListEl = document.getElementById("admin-group-members-list")!;
const observersBtn = document.getElementById("observers-btn") as HTMLButtonElement;
const observersModal = document.getElementById("observers-modal")!;
const observersModalListEl = document.getElementById("observers-modal-list")!;

// ── Admin dashboard (#241e) ─────────────────────────────────────────────────
//
// Visible only to is_admin=1 users via `applyAdminVisibility()`. Pulls
// `/api/admin/stats` and `/api/admin/sessions` on open + on refresh.
// No auto-polling — keeps the shared `adminStatsIp` (240/h) bucket
// available for operator-initiated refreshes and pairs naturally with
// the dashboard's "did my force-action take effect" mental model
// (refresh, see new state, act, refresh).

let adminOpener: HTMLButtonElement | null = null;

/** Symmetric with `resolveTemplatesOpener` — see that helper for the
 *  rationale. Admin is opened from a single click site per surface,
 *  so the resolver is currently only consumed by the close fallback,
 *  but keeping it parallel to Templates makes the pattern uniform if
 *  a future caller opens the admin modal from a third place. */
function resolveAdminOpener(): HTMLButtonElement {
	return adminBtn.offsetParent !== null ? adminBtn : sidebarAdminBtn;
}

function openAdminModal(opener: HTMLButtonElement) {
	adminOpener = opener;
	adminModal.classList.add("open");
	adminModal.setAttribute("aria-hidden", "false");
	adminRefreshBtn.focus();
	void refreshAdmin();
}

function closeAdminModal() {
	adminModal.classList.remove("open");
	adminModal.setAttribute("aria-hidden", "true");
	// Fall back to the viewport-rendered button if the opener is
	// missing — same rationale as closeTemplatesModal.
	(adminOpener ?? resolveAdminOpener()).focus();
	adminOpener = null;
}

adminModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeAdminModal();
});

adminBtn.addEventListener("click", () => openAdminModal(adminBtn));
sidebarAdminBtn.addEventListener("click", () => openAdminModal(sidebarAdminBtn));

adminRefreshBtn.addEventListener("click", () => {
	void refreshAdmin();
});

async function refreshAdmin(): Promise<void> {
	// Fetch all four endpoints in parallel — independent reads gated
	// by the same admin token. Sequential awaits would multiply the
	// dashboard latency without any safety upside. `Promise.allSettled`
	// rather than `all` so a transient on one endpoint doesn't wipe
	// the other three panels — each section renders or shows its own
	// per-section error.
	adminRefreshBtn.disabled = true;
	try {
		const [statsR, sessionsR, groupsR, observeLogR] = await Promise.allSettled([
			fetchAdminStats(),
			fetchAdminSessions(),
			fetchAdminGroups(),
			fetchAdminObserveLog(),
		]);
		if (statsR.status === "fulfilled") renderAdminStats(statsR.value);
		else showToast(`Stats: ${statsR.reason.message}`, true);
		if (sessionsR.status === "fulfilled") renderAdminSessions(sessionsR.value);
		else showToast(`Sessions: ${sessionsR.reason.message}`, true);
		if (groupsR.status === "fulfilled") renderAdminGroups(groupsR.value);
		else showToast(`Groups: ${groupsR.reason.message}`, true);
		if (observeLogR.status === "fulfilled") renderAdminObserveLog(observeLogR.value);
		else showToast(`Observe log: ${observeLogR.reason.message}`, true);
	} finally {
		adminRefreshBtn.disabled = false;
	}
}

function formatRelativeTime(ts: number | null): string {
	if (ts === null) return "never";
	const ageSec = Math.round((Date.now() - ts) / 1000);
	if (ageSec < 60) return `${ageSec}s ago`;
	if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
	return `${Math.round(ageSec / 3600)}h ago`;
}

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86_400)}d`;
}

// #270 — caching the limits block from the last `/admin/stats` so the
// per-row "Edit caps" form has the live max/default/min to validate
// against without a second round trip. `renderAdminStats` is always
// called before `renderAdminSessions` inside `refreshAdmin` (the
// Promise.allSettled fan-in below resolves stats first), so by the time
// a row's edit button can be clicked the limits are populated. Falls
// back to null when stats failed to load — the form disables itself.
let adminResourceLimits: AdminStats["resources"]["limits"] | null = null;

function renderAdminStats(stats: AdminStats): void {
	adminUptimeEl.textContent = `Uptime ${formatUptime(stats.uptimeSeconds)} · booted ${new Date(stats.bootedAt).toLocaleString()}`;
	adminResourceLimits = stats.resources.limits;
	adminStatsEl.textContent = "";

	const panel = (title: string, rows: Array<[string, string]>) => {
		const card = document.createElement("div");
		card.className = "admin-stat-card";
		const h = document.createElement("h4");
		h.textContent = title;
		card.appendChild(h);
		for (const [k, v] of rows) {
			const row = document.createElement("div");
			row.className = "admin-stat-row";
			const ks = document.createElement("span");
			ks.className = "admin-stat-key";
			ks.textContent = k;
			const vs = document.createElement("span");
			vs.className = "admin-stat-value";
			vs.textContent = v;
			row.appendChild(ks);
			row.appendChild(vs);
			card.appendChild(row);
		}
		adminStatsEl.appendChild(card);
	};

	const s = stats.sessions.byStatus;
	panel("Sessions", [
		["Running", String(s.running)],
		["Stopped", String(s.stopped)],
		["Terminated", String(s.terminated)],
		["Failed", String(s.failed)],
	]);

	const sw = stats.idleSweeper;
	panel("Idle sweeper", [
		["Last sweep", formatRelativeTime(sw?.lastSweepAt ?? null)],
		["Reaped since boot", String(sw?.sweptSinceBoot ?? 0)],
		["Tracked sessions", String(sw?.currentMapSize ?? 0)],
	]);

	const r = stats.reconcile;
	panel("Reconcile", [
		["Last run", formatRelativeTime(r.lastRunAt)],
		["Sessions checked", String(r.sessionsCheckedSinceBoot)],
		["Errors", String(r.errorsSinceBoot)],
	]);

	const d = stats.dispatcher;
	panel("Dispatcher", [
		["Requests", String(d.requestsSinceBoot)],
		["2xx", String(d.responses2xxSinceBoot)],
		["3xx", String(d.responses3xxSinceBoot)],
		["4xx", String(d.responses4xxSinceBoot)],
		["5xx", String(d.responses5xxSinceBoot)],
	]);

	panel("D1", [["Calls since boot", String(stats.d1.callsSinceBoot)]]);

	// #270 — host resource saturation card. Renders against running
	// sessions only; if there are none, the row collapses to "no live
	// sessions" so the dashboard doesn't show six zeros that look like
	// stuck counters.
	const r270 = stats.resources;
	const totalCpuLimitCores = r270.totalCpuLimitNanos / 1_000_000_000;
	const cpuUsePctOfAlloc =
		r270.totalCpuLimitNanos > 0 ? (r270.totalCpuPercent / (totalCpuLimitCores * 100)) * 100 : 0;
	const memUsePctOfAlloc =
		r270.totalMemLimitBytes > 0 ? (r270.totalMemBytes / r270.totalMemLimitBytes) * 100 : 0;
	panel("Resources (running)", [
		[
			"Sessions",
			r270.runningCount === 0
				? "0 (no live sessions)"
				: `${r270.runningCount} (stats: ${r270.statsAvailable}/${r270.runningCount})`,
		],
		[
			"CPU in use",
			r270.runningCount === 0
				? "—"
				: `${formatCpuPercent(r270.totalCpuPercent)} / ${formatCpuCores(totalCpuLimitCores)} cores (${cpuUsePctOfAlloc.toFixed(0)}%)`,
		],
		[
			"Memory in use",
			r270.runningCount === 0
				? "—"
				: `${formatBytes(r270.totalMemBytes)} / ${formatBytes(r270.totalMemLimitBytes)} (${memUsePctOfAlloc.toFixed(0)}%)`,
		],
	]);
}

// #270 — formatters shared by the stats card and the per-row display.
// `cpuPercent` is a Docker-style percentage where 100 = 1 fully busy
// core; a 4-core saturated container reports ~400. The bare-number
// shape would be confusing in a UI ("200%? Of what?"), so we hand
// users "cores" as the human unit and translate at display time.

function renderAdminSessions(sessions: AdminSession[]): void {
	adminSessionsListEl.textContent = "";
	if (sessions.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No sessions.";
		adminSessionsListEl.appendChild(empty);
		return;
	}
	for (const s of sessions) {
		// #270 — each row is now a wrapper that may contain the inline
		// edit form below the header. The header keeps the original
		// flex layout; the form appears underneath when the admin
		// clicks "Edit caps".
		const row = document.createElement("div");
		row.className = "admin-session-row admin-session-row--stacked";

		const header = document.createElement("div");
		header.className = "admin-session-header";

		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = s.name;
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		sub.textContent = `${s.ownerUsername} · ${s.status} · ${new Date(s.createdAt).toLocaleString()}`;
		meta.appendChild(name);
		meta.appendChild(sub);

		// #270 — per-row caps + live usage. Always render the caps
		// (so admin can audit a stopped session's allocation); render
		// usage only when running AND the stats fetch succeeded.
		// Rendering an "—" placeholder on running-without-stats is the
		// signal that a container is alive but its stats sample failed
		// — different state from "stopped" (which has no usage line).
		const resourcesLine = document.createElement("span");
		resourcesLine.className = "admin-session-sub admin-session-resources";
		resourcesLine.textContent = formatRowResources(s);
		meta.appendChild(resourcesLine);

		const actions = document.createElement("div");
		actions.className = "admin-session-actions";

		// Force-stop only enabled for running sessions — the backend
		// returns 204 on a no-op stop, but the button label would be
		// misleading on a stopped/terminated session.
		const stopBtn = document.createElement("button");
		stopBtn.type = "button";
		stopBtn.textContent = "Stop";
		stopBtn.disabled = s.status !== "running";
		stopBtn.addEventListener("click", () =>
			confirmAndAct(`Force-stop "${s.name}" (${s.ownerUsername})?`, stopBtn, async () => {
				await adminForceStop(s.sessionId);
				showToast(`Stopped ${s.name}`);
			}),
		);

		// #270 — Edit caps. Disabled when the limits haven't loaded
		// (stats fetch failure) because we need them for input bounds.
		// Toggles the inline edit form below the header.
		const editBtn = document.createElement("button");
		editBtn.type = "button";
		editBtn.textContent = "Edit caps";
		editBtn.disabled = adminResourceLimits === null;

		const deleteBtn = document.createElement("button");
		deleteBtn.type = "button";
		deleteBtn.textContent = "Delete";
		deleteBtn.className = "admin-session-delete";
		deleteBtn.addEventListener("click", () =>
			confirmAndAct(
				`Soft-delete "${s.name}" (${s.ownerUsername})?\n\nContainer will be stopped and the row terminated; workspace is preserved.`,
				deleteBtn,
				async () => {
					await adminForceDelete(s.sessionId, false);
					showToast(`Soft-deleted ${s.name}`);
				},
			),
		);

		const hardBtn = document.createElement("button");
		hardBtn.type = "button";
		hardBtn.textContent = "Hard-delete";
		hardBtn.className = "admin-session-delete";
		hardBtn.addEventListener("click", () =>
			confirmAndAct(
				`HARD-DELETE "${s.name}" (${s.ownerUsername})?\n\nThis purges the workspace directory AND drops the D1 row. Unrecoverable.`,
				hardBtn,
				async () => {
					await adminForceDelete(s.sessionId, true);
					showToast(`Hard-deleted ${s.name}`);
				},
			),
		);

		actions.appendChild(stopBtn);
		actions.appendChild(editBtn);
		actions.appendChild(deleteBtn);
		actions.appendChild(hardBtn);
		header.appendChild(meta);
		header.appendChild(actions);
		row.appendChild(header);

		// Build the inline edit form lazily — only the first time the
		// admin clicks Edit. Then toggle its visibility on subsequent
		// clicks. This keeps the initial render cheap for a 500-row
		// list where most rows will never have their caps edited.
		let editForm: HTMLElement | null = null;
		editBtn.addEventListener("click", () => {
			if (adminResourceLimits === null) return;
			if (editForm === null) {
				editForm = buildEditCapsForm(s, adminResourceLimits);
				row.appendChild(editForm);
			} else {
				editForm.hidden = !editForm.hidden;
			}
		});

		adminSessionsListEl.appendChild(row);
	}
}

/** Per-row resources line. Always shows the configured caps (or
 *  "default" when null); appends live usage when the session is
 *  running AND the stats fetch succeeded; renders "—" on running-
 *  without-stats to signal "alive but sample missing" rather than
 *  "stopped". */
function formatRowResources(s: AdminSession): string {
	const limits = adminResourceLimits;
	// Effective cap shown to the user: configured value wins, else
	// fall back to the spawn default (which we got from `limits`).
	// Without `limits` (stats fetch failed), render "—" for the cap
	// so the row doesn't pretend it knows the default.
	const cpuNanos = s.cpuLimit ?? limits?.defaultCpuNanos ?? null;
	const memBytes = s.memLimit ?? limits?.defaultMemBytes ?? null;
	const cpuLabel =
		cpuNanos === null
			? "?"
			: `${formatCpuCores(cpuNanos / 1_000_000_000)} cores${s.cpuLimit === null ? " (default)" : ""}`;
	const memLabel =
		memBytes === null ? "?" : `${formatBytes(memBytes)}${s.memLimit === null ? " (default)" : ""}`;
	if (s.status !== "running") {
		return `cap: ${cpuLabel} · ${memLabel}`;
	}
	// Truthy check covers both null (intentional "no stats") and
	// undefined (a SessionInfo that came back from a non-list endpoint
	// before #271's serializeMeta defaults landed); without this the
	// `.cpuPercent` access on the next line throws on undefined.
	if (!s.usage) {
		return `cap: ${cpuLabel} · ${memLabel} · usage: —`;
	}
	const cpuUsedCores = s.usage.cpuPercent / 100;
	return (
		`cap: ${cpuLabel} · ${memLabel}` +
		` · cpu: ${formatCpuCores(cpuUsedCores)} cores (${formatCpuPercent(s.usage.cpuPercent)})` +
		` · mem: ${formatBytes(s.usage.memBytes)} (${s.usage.memPercent.toFixed(0)}%)`
	);
}

/** Build the inline "Edit caps" form for one row. Two inputs (CPU
 *  cores + memory MiB) with min/max wired from the server-supplied
 *  limits. Save → PATCH → on 409, the cgroup-rejected branch surfaces
 *  the backend's "free memory first" message. */
function buildEditCapsForm(
	s: AdminSession,
	limits: AdminStats["resources"]["limits"],
): HTMLElement {
	const form = document.createElement("form");
	form.className = "admin-session-edit-caps";

	// Default the inputs to the CURRENT effective cap so a single-
	// field edit is intuitive. If the field is null on the row (uses
	// spawn default), prefill with that default so the admin sees
	// what the form would submit if they just press Save.
	const cpuCoresInitial = (s.cpuLimit ?? limits.defaultCpuNanos) / 1_000_000_000;
	const memMibInitial = (s.memLimit ?? limits.defaultMemBytes) / (1024 * 1024);

	const cpuLabel = document.createElement("label");
	cpuLabel.textContent = "CPU (cores)";
	const cpuInput = document.createElement("input");
	cpuInput.type = "number";
	cpuInput.step = "0.25";
	cpuInput.min = String(limits.minCpuNanos / 1_000_000_000);
	cpuInput.max = String(limits.maxCpuNanos / 1_000_000_000);
	cpuInput.value = String(cpuCoresInitial);
	cpuLabel.appendChild(cpuInput);

	const memLabel = document.createElement("label");
	memLabel.textContent = "Memory (MiB)";
	const memInput = document.createElement("input");
	memInput.type = "number";
	memInput.step = "256";
	memInput.min = String(limits.minMemBytes / (1024 * 1024));
	memInput.max = String(limits.maxMemBytes / (1024 * 1024));
	memInput.value = String(memMibInitial);
	memLabel.appendChild(memInput);

	const saveBtn = document.createElement("button");
	saveBtn.type = "submit";
	saveBtn.textContent = "Save";

	const cancelBtn = document.createElement("button");
	cancelBtn.type = "button";
	cancelBtn.textContent = "Cancel";
	cancelBtn.addEventListener("click", () => {
		form.hidden = true;
	});

	form.appendChild(cpuLabel);
	form.appendChild(memLabel);
	form.appendChild(saveBtn);
	form.appendChild(cancelBtn);

	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const cores = Number(cpuInput.value);
		const mib = Number(memInput.value);
		if (!Number.isFinite(cores) || !Number.isFinite(mib)) {
			showToast("Enter valid CPU / memory values", true);
			return;
		}
		saveBtn.disabled = true;
		cancelBtn.disabled = true;
		try {
			await adminUpdateResources(s.sessionId, {
				// Send BOTH fields. The backend ignores no-op equality, so
				// re-sending the current value of the unchanged field is
				// cheap and matches the "Save submits everything in the
				// form" mental model. Math.round on cores → integer
				// nano-CPUs (zod will reject a float).
				cpuLimit: Math.round(cores * 1_000_000_000),
				memLimit: Math.round(mib) * 1024 * 1024,
			});
			showToast(`Updated caps for ${s.name}`);
			await refreshAdmin();
		} catch (err) {
			// 409 from the cgroup-rejection branch surfaces a clear
			// "free memory first" message verbatim from the backend; let
			// the admin see it instead of "Update failed".
			const message = (err as Error).message;
			showToast(message, true);
		} finally {
			saveBtn.disabled = false;
			cancelBtn.disabled = false;
		}
	});

	return form;
}

/** Confirm + run an admin action. Disables the trigger button across
 *  the in-flight window so a double-click can't fire two destructive
 *  requests; refreshes the dashboard on success so the row reflects
 *  the new state without the operator clicking Refresh. */
async function confirmAndAct(
	prompt: string,
	btn: HTMLButtonElement,
	action: () => Promise<void>,
): Promise<void> {
	if (!confirm(prompt)) return;
	btn.disabled = true;
	try {
		await action();
		await refreshAdmin();
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		// `refreshAdmin` swallows its own errors and toasts, so this
		// `catch` only fires on `action()` itself throwing. If the
		// action succeeded but refresh failed AFTER, the DOM hasn't
		// been rebuilt and the original `btn` is still mounted —
		// re-enable it unconditionally here so the operator isn't
		// stuck with a permanently-disabled button until the next
		// manual Refresh. (When refresh DID rebuild the rows, this
		// runs on an orphaned button object — a harmless no-op.)
		btn.disabled = false;
	}
}

// ── Admin Groups CRUD (#201e-2) ────────────────────────────────────────────
//
// New section in the admin dashboard. List + create + edit + delete
// + add/remove members. Backend routes are gated by `requireAdmin`;
// these handlers run only inside the admin modal which is itself
// admin-gated. The create/edit dialog (`adminGroupModal`) and the
// members-management dialog (`adminGroupMembersModal`) open ON TOP
// of the admin dashboard — same nested-dialog pattern the
// save-template dialog uses on top of the new-session modal.

let editingGroupId: string | null = null;
let membersGroupId: string | null = null;

function renderAdminGroups(groups: AdminGroupSummary[]): void {
	adminGroupsListEl.textContent = "";
	if (groups.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No groups yet — create one with + New group.";
		adminGroupsListEl.appendChild(empty);
		return;
	}
	for (const g of groups) {
		const row = document.createElement("div");
		row.className = "admin-session-row";

		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = g.description ? `${g.name} — ${g.description}` : g.name;
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		sub.textContent = `lead: ${g.leadUsername} · ${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`;
		meta.appendChild(name);
		meta.appendChild(sub);

		const actions = document.createElement("div");
		actions.className = "admin-session-actions";

		const editBtn = document.createElement("button");
		editBtn.type = "button";
		editBtn.textContent = "Edit";
		editBtn.addEventListener("click", () => {
			void openAdminGroupModalForEdit(g);
		});

		const membersBtn = document.createElement("button");
		membersBtn.type = "button";
		membersBtn.textContent = "Members";
		membersBtn.addEventListener("click", () => {
			void openAdminGroupMembersModal(g);
		});

		const deleteBtn = document.createElement("button");
		deleteBtn.type = "button";
		deleteBtn.textContent = "Delete";
		deleteBtn.className = "admin-session-delete";
		deleteBtn.addEventListener("click", () =>
			confirmAndAct(
				`Delete group "${g.name}"?\n\nMembership rows cascade automatically. The lead user is NOT deleted.`,
				deleteBtn,
				async () => {
					await deleteAdminGroup(g.id);
					showToast(`Deleted ${g.name}`);
				},
			),
		);

		actions.appendChild(editBtn);
		actions.appendChild(membersBtn);
		actions.appendChild(deleteBtn);
		row.appendChild(meta);
		row.appendChild(actions);
		adminGroupsListEl.appendChild(row);
	}
}

function openAdminGroupModalForCreate(): void {
	editingGroupId = null;
	adminGroupModalTitle.textContent = "New group";
	adminGroupNameInput.value = "";
	adminGroupDescriptionInput.value = "";
	adminGroupLeadUserIdInput.value = "";
	adminGroupSubmitBtn.textContent = "Create";
	adminGroupModal.classList.add("open");
	adminGroupModal.setAttribute("aria-hidden", "false");
	adminGroupNameInput.focus();
}

function openAdminGroupModalForEdit(g: AdminGroupSummary): void {
	editingGroupId = g.id;
	adminGroupModalTitle.textContent = `Edit group "${g.name}"`;
	adminGroupNameInput.value = g.name;
	adminGroupDescriptionInput.value = g.description ?? "";
	adminGroupLeadUserIdInput.value = g.leadUserId;
	adminGroupSubmitBtn.textContent = "Save";
	adminGroupModal.classList.add("open");
	adminGroupModal.setAttribute("aria-hidden", "false");
	adminGroupNameInput.focus();
}

function closeAdminGroupModal(): void {
	adminGroupModal.classList.remove("open");
	adminGroupModal.setAttribute("aria-hidden", "true");
	editingGroupId = null;
}

adminGroupModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeAdminGroupModal();
});

adminGroupCreateBtn.addEventListener("click", () => openAdminGroupModalForCreate());

adminGroupForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = adminGroupNameInput.value.trim();
	const description = adminGroupDescriptionInput.value.trim() || null;
	const leadUserId = adminGroupLeadUserIdInput.value.trim();
	if (!name) {
		showToast("Name is required", true);
		return;
	}
	if (!leadUserId) {
		showToast("Lead user id is required", true);
		return;
	}
	adminGroupSubmitBtn.disabled = true;
	try {
		if (editingGroupId === null) {
			await createAdminGroup({ name, description, leadUserId });
			showToast(`Created group "${name}"`);
		} else {
			await updateAdminGroup(editingGroupId, { name, description, leadUserId });
			showToast(`Saved group "${name}"`);
		}
		closeAdminGroupModal();
		await refreshAdmin();
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		adminGroupSubmitBtn.disabled = false;
	}
});

async function openAdminGroupMembersModal(g: AdminGroupSummary): Promise<void> {
	membersGroupId = g.id;
	adminGroupMembersModalTitle.textContent = `Members of "${g.name}"`;
	adminGroupMembersModalHint.textContent = `Lead is "${g.leadUsername}" — cannot be removed (reassign via Edit first).`;
	adminGroupAddMemberInput.value = "";
	adminGroupMembersListEl.textContent = "";
	const loading = document.createElement("p");
	loading.className = "modal-hint";
	loading.textContent = "Loading members…";
	adminGroupMembersListEl.appendChild(loading);
	adminGroupMembersModal.classList.add("open");
	adminGroupMembersModal.setAttribute("aria-hidden", "false");
	adminGroupAddMemberInput.focus();
	await refreshAdminGroupMembers(g.id, g.leadUserId);
}

function closeAdminGroupMembersModal(): void {
	adminGroupMembersModal.classList.remove("open");
	adminGroupMembersModal.setAttribute("aria-hidden", "true");
	membersGroupId = null;
}

adminGroupMembersModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeAdminGroupMembersModal();
});

async function refreshAdminGroupMembers(groupId: string, leadUserId: string): Promise<void> {
	let detail: AdminGroupDetail;
	try {
		detail = await fetchAdminGroup(groupId);
	} catch (err) {
		showToast((err as Error).message, true);
		return;
	}
	adminGroupMembersListEl.textContent = "";
	if (detail.members.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No members.";
		adminGroupMembersListEl.appendChild(empty);
		return;
	}
	for (const m of detail.members) {
		const row = document.createElement("div");
		row.className = "admin-session-row";
		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = m.username;
		meta.appendChild(name);
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		sub.textContent =
			m.userId === leadUserId
				? `lead · added ${new Date(m.addedAt).toLocaleString()}`
				: `added ${new Date(m.addedAt).toLocaleString()}`;
		meta.appendChild(sub);
		row.appendChild(meta);

		const actions = document.createElement("div");
		actions.className = "admin-session-actions";
		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.textContent = "Remove";
		removeBtn.className = "admin-session-delete";
		// Lead can't be removed without reassignment — disable the
		// button rather than letting the click 409 from the backend.
		// Same shape as `Stop` being disabled on a non-running session.
		removeBtn.disabled = m.userId === leadUserId;
		removeBtn.addEventListener("click", async () => {
			if (!confirm(`Remove ${m.username} from this group?`)) return;
			removeBtn.disabled = true;
			try {
				await removeAdminGroupMember(groupId, m.userId);
				showToast(`Removed ${m.username}`);
				await refreshAdminGroupMembers(groupId, leadUserId);
				await refreshAdmin();
			} catch (err) {
				showToast((err as Error).message, true);
				removeBtn.disabled = false;
			}
		});
		actions.appendChild(removeBtn);
		row.appendChild(actions);
		adminGroupMembersListEl.appendChild(row);
	}
}

adminGroupAddMemberForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const userId = adminGroupAddMemberInput.value.trim();
	if (!userId) {
		showToast("User id is required", true);
		return;
	}
	if (membersGroupId === null) return;
	const groupId = membersGroupId;
	// Disable the submit button across the in-flight window so a
	// double-click or fast second Enter doesn't fire a duplicate
	// POST. The backend's composite PK on (group_id, user_id) would
	// 409 the second call (caught + toasted), but keeping the noise
	// out is cheaper than handling it. Same shape as
	// `adminGroupSubmitBtn.disabled` on the create/edit handler.
	const submitBtn =
		adminGroupAddMemberForm.querySelector<HTMLButtonElement>("button[type='submit']");
	if (submitBtn) submitBtn.disabled = true;
	try {
		await addAdminGroupMember(groupId, userId);
		showToast("Member added");
		adminGroupAddMemberInput.value = "";
		// Refresh the members list — re-fetch the current group's
		// detail to render the new row, and refresh the parent admin
		// dashboard so the member-count chip on the row updates.
		// `editingGroupId` is for the create/edit modal; this path
		// keeps `membersGroupId` intact so subsequent operations on
		// the same dialog still target the right group.
		const meta = await fetchAdminGroup(groupId);
		await refreshAdminGroupMembers(groupId, meta.leadUserId);
		await refreshAdmin();
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		if (submitBtn) submitBtn.disabled = false;
	}
});

// ── Admin observe-log (#201e-2) ────────────────────────────────────────────

function renderAdminObserveLog(entries: AdminObserveLogEntry[]): void {
	adminObserveLogEl.textContent = "";
	if (entries.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No observe events yet.";
		adminObserveLogEl.appendChild(empty);
		return;
	}
	for (const e of entries) {
		const row = document.createElement("div");
		row.className = "admin-session-row";
		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = `${e.observerUsername} → ${e.ownerUsername}`;
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		const started = new Date(e.startedAt).toLocaleString();
		const ended = e.endedAt ? new Date(e.endedAt).toLocaleString() : "still watching";
		sub.textContent = `session ${e.sessionId.slice(0, 8)}… · ${started} → ${ended}`;
		meta.appendChild(name);
		meta.appendChild(sub);
		row.appendChild(meta);
		adminObserveLogEl.appendChild(row);
	}
}

// ── Per-session Observers button (#201e-2) ─────────────────────────────────
// Surfaces the per-session observe history. Owner / admin / lead-of-
// group-containing-owner can read; the backend `assertCanObserve`
// gate handles auth and surfaces the right 403/404 to the toast on
// fail. The button is shown for every authenticated user — gating it
// on isLead/isAdmin would hide it from owners, who are the primary
// audience ("who has been watching me?"). A non-authorised viewer
// just sees a toast.

function openObserversModal(): void {
	if (!activeSessionId) return;
	const sessionId = activeSessionId;
	observersModalListEl.textContent = "";
	const loading = document.createElement("p");
	loading.className = "modal-hint";
	loading.textContent = "Loading…";
	observersModalListEl.appendChild(loading);
	observersModal.classList.add("open");
	observersModal.setAttribute("aria-hidden", "false");
	void refreshObserversModal(sessionId);
}

function closeObserversModal(): void {
	observersModal.classList.remove("open");
	observersModal.setAttribute("aria-hidden", "true");
}

async function refreshObserversModal(sessionId: string): Promise<void> {
	let entries: ObserveLogEntry[];
	try {
		entries = await fetchSessionObserveLog(sessionId);
	} catch (err) {
		showToast((err as Error).message, true);
		closeObserversModal();
		return;
	}
	observersModalListEl.textContent = "";
	if (entries.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No observers yet.";
		observersModalListEl.appendChild(empty);
		return;
	}
	for (const e of entries) {
		const row = document.createElement("div");
		row.className = "admin-session-row";
		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = e.observerUsername;
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		const started = new Date(e.startedAt).toLocaleString();
		const ended = e.endedAt ? new Date(e.endedAt).toLocaleString() : "still watching";
		sub.textContent = `${started} → ${ended}`;
		meta.appendChild(name);
		meta.appendChild(sub);
		row.appendChild(meta);
		observersModalListEl.appendChild(row);
	}
}

observersModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeObserversModal();
});

observersBtn.addEventListener("click", () => openObserversModal());

export { closeAdminGroupMembersModal, closeAdminGroupModal, closeAdminModal, closeObserversModal };
