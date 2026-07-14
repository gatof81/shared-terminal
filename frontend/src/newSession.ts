/**
 * newSession.ts — the create-session modal and its tabs (repo #188,
 * advanced #191, env #186, ports #190) plus the save-as-template flow
 * (#195) and the templates page (#195). Extracted from main.ts (#312).
 *
 * Same TDZ-safe pattern as the other splits: DOM re-queried locally; the
 * main.ts imports (openSession / refreshSessions / renderSessionList /
 * showToast / sessions) are used only inside functions. The three modal
 * close functions are exported for main.ts's Escape handler.
 */

import {
	createSession,
	createTemplate,
	deleteTemplate,
	type EnvVarEntryInput,
	fetchBootstrapLog,
	fetchMyQuotas,
	getResourceCaps,
	getTemplate,
	idleSecondsToFormUnit,
	listTemplates,
	memBytesToFormUnit,
	openBootstrapWs,
	type SessionConfigPayload,
	type SessionInfo,
	stripConfigForTemplate,
	type Template,
	type TemplateSummary,
	updateTemplate,
} from "./api.js";
import { parseDotEnv } from "./envParser.js";
import { sessions, showToast } from "./main.js";
import { openSession, refreshSessions, renderSessionList } from "./sessionCore.js";

// ── DOM (re-queried locally) — added below after tsc enumerates them ──────
const newSessionBtn = document.getElementById("new-session-btn") as HTMLButtonElement;
const newSessionModal = document.getElementById("new-session-modal")!;
const newSessionForm = document.getElementById("new-session-form") as HTMLFormElement;
const newSessionInput = document.getElementById("new-session-input") as HTMLInputElement;
const newSessionInputLabel = document.getElementById("new-session-input-label")!;
const newSessionSubmitBtn = document.getElementById("new-session-submit") as HTMLButtonElement;
const newSessionModalTitle = document.getElementById("new-session-modal-title")!;
const editTemplateDescriptionField = document.getElementById("edit-template-description-field")!;
const editTemplateDescriptionInput = document.getElementById(
	"edit-template-description-input",
) as HTMLInputElement;
const templatesBtn = document.getElementById("templates-btn") as HTMLButtonElement;

// ── New session ─────────────────────────────────────────────────────────────
//
// The new-session UI is a tabbed modal: Basics / Repo / Env / Ports / Advanced.
// Foundation lands in #185; only the Basics tab (session name) is functional
// today. The other tabs render placeholder copy linking to the child issue
// that wires each one up so users can see what's coming. PR 185b adds the
// bootstrap-output live-tail panel inside the modal once the runner exists.

// All previously-placeholder tabs (env / hooks / ports) are now wired
// up to real form UI, but the registry stays so a future #197 / #199
// child issue can drop in a placeholder without re-adding the
// rendering scaffold below.
const SESSION_TAB_PLACEHOLDERS: Record<string, { title: string; body: string; issueUrl: string }> =
	{};

let newSessionOpener: HTMLElement | null = null;

function renderSessionTabPlaceholders() {
	for (const [key, info] of Object.entries(SESSION_TAB_PLACEHOLDERS)) {
		const panel = document.getElementById(`session-tab-${key}`);
		if (!panel || panel.childElementCount > 0) continue;
		const wrap = document.createElement("p");
		wrap.className = "session-placeholder";
		// textContent path for the title + body so any future copy
		// change with user-supplied parts can't smuggle markup. The
		// trailing link is built with createElement and assembled below.
		const strong = document.createElement("strong");
		strong.textContent = info.title;
		wrap.appendChild(strong);
		wrap.appendChild(document.createElement("br"));
		wrap.appendChild(document.createTextNode(info.body));
		wrap.appendChild(document.createElement("br"));
		const a = document.createElement("a");
		a.href = info.issueUrl;
		a.target = "_blank";
		a.rel = "noopener";
		a.textContent = "Track progress on this tab →";
		wrap.appendChild(a);
		panel.appendChild(wrap);
	}
}

function setActiveSessionTab(key: string) {
	const tabs = newSessionModal.querySelectorAll<HTMLButtonElement>(".session-tab");
	const panels = newSessionModal.querySelectorAll<HTMLDivElement>(".session-tab-panel");
	for (const tab of tabs) {
		const active = tab.dataset.sessionTab === key;
		tab.classList.toggle("is-active", active);
		tab.setAttribute("aria-selected", active ? "true" : "false");
	}
	for (const panel of panels) {
		const active = panel.id === `session-tab-${key}`;
		panel.classList.toggle("is-active", active);
		// `hidden` is the source of truth for accessibility-tree
		// visibility; the .is-active class only handles the CSS
		// transitions. Keep them in sync so a screen reader doesn't
		// announce four placeholder panels every time the modal opens.
		panel.toggleAttribute("hidden", !active);
	}
}

// Edit-template state (#231). When non-null the create-session modal
// is in "edit template" mode: submit calls `PUT /api/templates/:id`
// instead of `POST /api/sessions`, the session-name input is reused
// as the template name, and a description field appears below it.
// `setNewSessionModalMode` flips all the user-visible chrome so a
// stale label or button text from a previous open can't leak into
// the wrong mode.
let editingTemplateId: string | null = null;

function setNewSessionModalMode(template: Template | null): void {
	editingTemplateId = template ? template.id : null;
	if (template) {
		newSessionModalTitle.textContent = "Edit template";
		newSessionInputLabel.textContent = "Template name";
		newSessionSubmitBtn.textContent = "Save changes";
		// Hide the save-as-template-from-edit path entirely. Nesting
		// "save as template" inside an edit form is a UX trap (does it
		// fork the template? overwrite? open a second modal?) the
		// issue body explicitly says to skip.
		saveTemplateBtn.hidden = true;
		editTemplateDescriptionField.hidden = false;
		editTemplateDescriptionInput.value = template.description ?? "";
	} else {
		newSessionModalTitle.textContent = "New session";
		newSessionInputLabel.textContent = "Session name";
		newSessionSubmitBtn.textContent = "Create session";
		saveTemplateBtn.hidden = false;
		editTemplateDescriptionField.hidden = true;
		editTemplateDescriptionInput.value = "";
	}
}

function openNewSessionModal(opener: HTMLElement) {
	newSessionOpener = opener;
	renderSessionTabPlaceholders();
	setActiveSessionTab("basics");
	newSessionInput.value = "";
	newSessionSubmitBtn.disabled = false;
	clearBootstrapError();
	// Default every open to create-mode. Edit-mode is opted into by
	// `editTemplate(id)` after the modal is open and the form has been
	// populated via `applyTemplateToForm`.
	setNewSessionModalMode(null);
	// `resetEnvTab` no longer fires here — `closeNewSessionModal`
	// already wiped state on the previous close, and the initial
	// declaration of `envRows = []` covers the very first open.
	// #200: re-apply caps in case checkAuthStatus refreshed them since
	// initAuth ran (idempotent — same numbers if nothing changed).
	applyResourceCapsToForm();
	// #202: headroom hint is fetched async so modal-open never blocks on
	// it; the hint fills in when the response lands.
	void refreshQuotaHeadroom();
	newSessionModal.classList.add("open");
	newSessionModal.setAttribute("aria-hidden", "false");
	// Defer focus to the next paint so the input is reliably focusable
	// (some browsers ignore .focus() on an element that just transitioned
	// from display:none in the same frame).
	requestAnimationFrame(() => newSessionInput.focus());
}

/**
 * PR 185b2b live-tail state. While a bootstrap WS is open we hold onto
 * the close thunk + the rendered `<pre>` so:
 *   - cancelling the modal (Esc, X, backdrop) closes the WS and the
 *     hook keeps running server-side; the user can re-open the
 *     session later from the sidebar to attach to its terminal.
 *   - submitting again while a previous WS is still draining
 *     (shouldn't happen, modal disables the button, but defensive)
 *     tears the old one down first.
 */
let activeBootstrap: { close: () => void } | null = null;

function startBootstrapLiveTail(session: SessionInfo, name: string) {
	clearBootstrapError();
	const panel = document.createElement("div");
	panel.className = "bootstrap-tail";
	panel.id = "bootstrap-error-panel"; // reused id so clearBootstrapError() removes either kind
	const heading = document.createElement("strong");
	heading.textContent = "Bootstrapping session…";
	panel.appendChild(heading);
	const hint = document.createElement("p");
	hint.className = "bootstrap-error-hint";
	hint.textContent =
		"Live output from session bootstrap (clone, dotfiles, agent seed, postCreate). The modal will close on success.";
	panel.appendChild(hint);
	const pre = document.createElement("pre");
	pre.className = "bootstrap-error-output";
	pre.textContent = "";
	panel.appendChild(pre);
	document.getElementById("session-tab-basics")?.appendChild(panel);

	activeBootstrap = openBootstrapWs(session.sessionId, {
		onOutput: (chunk) => {
			// Append a text node rather than `pre.textContent += chunk`
			// (#308): the `+=` form re-reads and re-serialises the entire
			// accumulated log on every frame, so a verbose hook (npm install
			// can emit hundreds of KB over the 10-min bootstrap cap) makes
			// the modal quadratic and janky. Appending a node is O(chunk).
			pre.appendChild(document.createTextNode(chunk));
			// Auto-scroll to the bottom so the latest line is visible
			// — `npm install`-style hooks emit hundreds of lines and
			// the user expects the tail, not the head.
			pre.scrollTop = pre.scrollHeight;
		},
		onDone: (success, exitCode, error, stage) => {
			activeBootstrap = null;
			if (success) {
				closeNewSessionModal();
				void openSession(session.sessionId);
				showToast(`Session "${name}" created`);
				return;
			}
			// Hard fail: server already flipped row to `failed` and
			// killed the container. Switch panel into the error
			// styling, refresh sidebar so the failed row appears,
			// re-enable the submit button so the user can fix the
			// hook + try again.
			//
			// `stage` (#252) names the pipeline step that failed
			// (gitIdentity / clone / dotfiles / agentSeed /
			// postCreate). Without it, this UI used to hardcode
			// "postCreate hook failed" — confusing for a user whose
			// failure was actually in clone or dotfiles AND who
			// hadn't configured a postCreate at all.
			panel.classList.add("bootstrap-error");
			// Fall back to "bootstrap" (the generic), NOT "postCreate" —
			// the no-stage case (config-fetch failure before any stage
			// runs) would otherwise recreate the exact misleading
			// "postCreate hook failed" label this PR is fixing.
			const stageLabel = stage ?? "bootstrap";
			heading.textContent = error
				? `Bootstrap stage '${stageLabel}' failed (${error})`
				: `Bootstrap stage '${stageLabel}' failed (exit ${exitCode ?? "?"})`;
			hint.textContent =
				stage === "postCreate"
					? "The postCreate command exited non-zero, so the container was killed and the session marked failed. Captured output above — fix the command and create a new session."
					: `The '${stageLabel}' bootstrap stage failed, so the container was killed and the session marked failed. Captured output above — fix the ${stageLabel} config and create a new session.`;
			void refreshSessions();
			newSessionSubmitBtn.disabled = false;
		},
	});
}

function teardownBootstrapTail() {
	if (activeBootstrap) {
		activeBootstrap.close();
		activeBootstrap = null;
	}
	// Clear any rendered tail / error panel too. Without this, a
	// cancelled-mid-bootstrap close left the error-styled panel in
	// the DOM; the next time the modal opened it briefly flashed a
	// "postCreate hook failed" message that didn't apply to the new
	// session (PR #208 round 3).
	clearBootstrapError();
}

function clearBootstrapError() {
	document.getElementById("bootstrap-error-panel")?.remove();
}

/**
 * #274 — Open a modal showing the persisted bootstrap output for a
 * failed (or successful) session. Built programmatically rather than
 * declared in index.html because it's a leaf utility used only when
 * the user clicks a failed row; pulling the markup into HTML would
 * add weight everyone else pays for. Reuses the global `.modal` /
 * `.modal-backdrop` / `.modal-card` styles so the visual matches
 * other modals.
 */
// #274 — single-modal invariant. A rapid double-click on a failed
// row would otherwise register two `escHandler` closures on document
// (the second open removes the stale DOM element but the prior
// listener is still attached). Calling the prior `close()` first
// unregisters its handler cleanly. Module-level so an in-flight
// log fetch from the first open can still resolve into the closed
// modal harmlessly — `pre.textContent =` on an orphaned node is a
// no-op.
let activeBootstrapLogClose: (() => void) | null = null;

async function openBootstrapLogModal(session: SessionInfo): Promise<void> {
	// Close any previous viewer cleanly (removes its escHandler) before
	// stacking a new one. Falls through to a defensive DOM-remove for
	// the case where activeBootstrapLogClose is null but a stale
	// element somehow survived (shouldn't happen post-fix, but cheap).
	activeBootstrapLogClose?.();
	document.getElementById("bootstrap-log-modal")?.remove();

	const modal = document.createElement("div");
	modal.id = "bootstrap-log-modal";
	modal.className = "modal open";
	modal.setAttribute("aria-hidden", "false");

	const backdrop = document.createElement("div");
	backdrop.className = "modal-backdrop";
	backdrop.setAttribute("data-close-modal", "");
	modal.appendChild(backdrop);

	const card = document.createElement("div");
	card.className = "modal-card bootstrap-log-card";
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-modal", "true");

	const header = document.createElement("div");
	header.className = "modal-header";
	const h2 = document.createElement("h2");
	h2.textContent = `Bootstrap log — ${session.name}`;
	header.appendChild(h2);
	const closeBtn = document.createElement("button");
	closeBtn.className = "modal-close";
	closeBtn.type = "button";
	closeBtn.setAttribute("aria-label", "Close");
	closeBtn.setAttribute("data-close-modal", "");
	closeBtn.textContent = "×";
	header.appendChild(closeBtn);
	card.appendChild(header);

	const hint = document.createElement("p");
	hint.className = "modal-hint";
	hint.textContent =
		session.status === "failed"
			? "Captured output from the failed bootstrap (gitIdentity / clone / dotfiles / agentSeed / writeEnvFile / postCreate). Fix the cause and create a new session."
			: "Captured output from the last bootstrap run.";
	card.appendChild(hint);

	const pre = document.createElement("pre");
	pre.className = "bootstrap-error-output";
	pre.textContent = "Loading…";
	card.appendChild(pre);

	modal.appendChild(card);
	document.body.appendChild(modal);

	// `escHandler` declared first so `close()` can unregister it on
	// every close path (backdrop / × / Esc). Without this, the
	// non-Esc close paths leak a listener on `document` each time
	// the modal opens — they self-heal on the next Esc press but
	// accumulate in between.
	const escHandler = (e: KeyboardEvent) => {
		if (e.key === "Escape") close();
	};
	const close = () => {
		modal.remove();
		document.removeEventListener("keydown", escHandler);
		// Clear the module-level reference only if it still points at
		// our close — a second-open before our close ran would have
		// already swapped it. Avoids the second modal's `close` being
		// silently nulled out by the first's tear-down.
		if (activeBootstrapLogClose === close) activeBootstrapLogClose = null;
	};
	activeBootstrapLogClose = close;
	// Close on backdrop / × / Esc — same affordances as the rest of
	// the app's modals. The shared admin-modal click handler doesn't
	// reach us (different element); wire ours explicitly.
	modal.addEventListener("click", (e) => {
		if ((e.target as HTMLElement).hasAttribute("data-close-modal")) close();
	});
	document.addEventListener("keydown", escHandler);

	try {
		const log = await fetchBootstrapLog(session.sessionId);
		if (log === null || log === "") {
			pre.textContent =
				"(no captured output — session may pre-date the bootstrap-log feature, or no bootstrap ever ran)";
		} else {
			pre.textContent = log;
			// Auto-scroll to the bottom so the user sees the tail —
			// failure messages are at the END of the log, not the
			// start.
			pre.scrollTop = pre.scrollHeight;
		}
	} catch (err) {
		pre.textContent = `Failed to load log: ${(err as Error).message}`;
	}
}

function closeNewSessionModal() {
	newSessionModal.classList.remove("open");
	newSessionModal.setAttribute("aria-hidden", "true");
	// PR 185b2b: closing the modal mid-bootstrap MUST cancel the WS
	// subscription. The hook itself keeps running server-side (the
	// async runner is fire-and-forget); we just stop tailing it. The
	// user can re-attach to the session from the sidebar once it
	// reaches `running` (or see the failure in the row's status if it
	// flipped to `failed`).
	teardownBootstrapTail();
	// Reset Env-tab state on close (#211 round 2) so the in-memory
	// `envRows` doesn't drift from the now-hidden DOM between close
	// and re-open. The redundant reset on `openNewSessionModal` is
	// gone — closing always leaves the array empty.
	resetEnvTab();
	// Reset Repo-tab state on close (#188 PR 188e). Critical for the
	// credential fields (PAT, SSH key) — leaving them mounted would
	// risk leaking a stale credential into the next session create.
	resetRepoTab();
	// Reset Advanced-tab state on close (#191 PR 191c). Same
	// rationale plus the agent-seed bodies can be substantial.
	resetAdvancedTab();
	// Reset Ports-tab state on close (#190 PR 190d). Drops any
	// configured ports + the allowPrivilegedPorts toggle so a stale
	// 80/443 row from an earlier modal session doesn't carry over.
	resetPortsTab();
	// Reset edit-template mode (#231). Mirrors the resetXTab pattern
	// above — every modal-close path must leave the module in a clean
	// default state, otherwise a future caller that shows the modal
	// without going through `openNewSessionModal` would silently
	// enter edit mode with a stale `editingTemplateId`.
	setNewSessionModalMode(null);
	(newSessionOpener ?? newSessionBtn).focus();
	newSessionOpener = null;
}

newSessionBtn.addEventListener("click", () => openNewSessionModal(newSessionBtn));

newSessionModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeNewSessionModal();
	const tab = target.closest<HTMLButtonElement>("[data-session-tab]");
	if (tab?.dataset.sessionTab) setActiveSessionTab(tab.dataset.sessionTab);
});

// ── Repo tab (#188 / PR 188e) ───────────────────────────────────────────────
//
// State + render + wiring for the repo-clone Repo tab. The tab is the
// frontend half of #188; backend pieces shipped in 188a-188d.
//
// Three auth modes selected by the `Auth` dropdown:
//   - `none` — anonymous HTTPS clone, no credentials.
//   - `pat`  — HTTPS + personal access token. Token panel reveals.
//   - `ssh`  — SSH clone (git@host:path). Key + known_hosts panel reveals.
//
// State here is read directly from the DOM at submit time
// (`collectRepoForSubmit`) — no in-memory mirror. The form is small
// enough that the env-tab's array-source-of-truth pattern would be
// overkill, and a single-shot collect avoids needing to sync after
// every keystroke.
//
// `resetRepoTab()` runs on modal close so a partially-typed PAT or
// SSH key doesn't leak into the next session create.

const repoUrl = document.getElementById("repo-url") as HTMLInputElement;
const repoRef = document.getElementById("repo-ref") as HTMLInputElement;
const repoTarget = document.getElementById("repo-target") as HTMLInputElement;
const repoDepth = document.getElementById("repo-depth") as HTMLInputElement;
const repoAuth = document.getElementById("repo-auth") as HTMLSelectElement;
const repoAuthPatPanel = document.getElementById("repo-auth-pat-panel") as HTMLDivElement;
const repoAuthPatToken = document.getElementById("repo-auth-pat-token") as HTMLInputElement;
const repoAuthSshPanel = document.getElementById("repo-auth-ssh-panel") as HTMLDivElement;
const repoAuthSshKey = document.getElementById("repo-auth-ssh-key") as HTMLTextAreaElement;
const repoAuthSshKnownHostsMode = document.getElementById(
	"repo-auth-ssh-known-hosts-mode",
) as HTMLSelectElement;
const repoAuthSshKnownHostsCustomWrap = document.getElementById(
	"repo-auth-ssh-known-hosts-custom-wrap",
) as HTMLLabelElement;
const repoAuthSshKnownHostsCustom = document.getElementById(
	"repo-auth-ssh-known-hosts-custom",
) as HTMLTextAreaElement;

/** Show/hide the auth subpanel based on the dropdown selection. */
function syncRepoAuthPanels(): void {
	const mode = repoAuth.value;
	repoAuthPatPanel.toggleAttribute("hidden", mode !== "pat");
	repoAuthSshPanel.toggleAttribute("hidden", mode !== "ssh");
}

/** Show/hide the custom-paste textarea based on the known_hosts mode. */
function syncRepoSshKnownHostsCustom(): void {
	const mode = repoAuthSshKnownHostsMode.value;
	repoAuthSshKnownHostsCustomWrap.toggleAttribute("hidden", mode !== "custom");
}

repoAuth.addEventListener("change", syncRepoAuthPanels);
repoAuthSshKnownHostsMode.addEventListener("change", syncRepoSshKnownHostsCustom);

/**
 * Wipe Repo-tab state on modal close. Critical for the credential
 * fields (PAT, SSH private key) — leaving them in the DOM after a
 * close would let the next session-create operator (or even the
 * same user reopening for a different repo) accidentally submit a
 * stale credential. Reset to the default "none" auth mode so the
 * subpanels collapse too.
 */
function resetRepoTab(): void {
	repoUrl.value = "";
	repoRef.value = "";
	repoTarget.value = "";
	repoDepth.value = "";
	repoAuth.value = "none";
	repoAuthPatToken.value = "";
	repoAuthSshKey.value = "";
	repoAuthSshKnownHostsMode.value = "default";
	repoAuthSshKnownHostsCustom.value = "";
	syncRepoAuthPanels();
	syncRepoSshKnownHostsCustom();
}

/**
 * Read the Repo tab into the wire shape the backend accepts. Returns
 * `undefined` when no URL is set — that's the "no repo configured"
 * signal the bootstrap runner reads as a no-op.
 *
 * Trims input strings; empty `ref` / `target` are omitted entirely
 * from the payload (the backend's `.optional()` fields treat omission
 * identically to `""` — "remote HEAD" and "workspace root"
 * respectively). `depth` is parsed as int if non-empty.
 *
 * The collected shape is the `{ repo, auth }` pair the backend's
 * `validateSessionConfig` cross-field check expects. We do NOT
 * pre-validate URL scheme / refname rules here — the backend's Zod
 * schema is the single source of truth; client-side mirroring would
 * just be one more place to keep in sync. The user gets a 400 with
 * a precise field path on submit.
 *
 * Exported so a future test file (jsdom + DOM seed) can pin the
 * wire shape per (auth-mode) variant without going through the
 * full main.ts side-effect chain. None ship in this PR — the
 * Env tab's equivalent (`collectEnvVarsForSubmit`) is also
 * untested and the precedent is to add tests when the form is
 * extracted into its own module.
 */
export function collectRepoForSubmit(): {
	repo: SessionConfigPayload["repo"];
	auth: SessionConfigPayload["auth"];
} {
	const url = repoUrl.value.trim();
	if (url === "") return { repo: undefined, auth: undefined };
	const ref = repoRef.value.trim();
	const target = repoTarget.value.trim();
	const depthRaw = repoDepth.value.trim();
	const depth = depthRaw === "" ? undefined : Number.parseInt(depthRaw, 10);
	const auth = repoAuth.value as "none" | "pat" | "ssh";

	const repo: NonNullable<SessionConfigPayload["repo"]> = {
		url,
		auth,
	};
	if (ref !== "") repo.ref = ref;
	if (target !== "") repo.target = target;
	if (depth !== undefined && Number.isFinite(depth)) repo.depth = depth;

	if (auth === "none") {
		return { repo, auth: undefined };
	}
	if (auth === "pat") {
		// Trim the PAT — clipboard sources (1Password, GitHub copy
		// button) often append a trailing newline. A `\n`-suffixed
		// token would pass Zod's `.min(1)` check, encrypt fine, and
		// then fail with a cryptic git-auth error at clone time
		// rather than a clean message here (PR #216 round 1 NIT).
		// SSH keys below are deliberately NOT trimmed — they have
		// load-bearing newlines.
		const token = repoAuthPatToken.value.trim();
		// Plaintext token flows into the payload — sent over HTTPS,
		// encrypted server-side at the route boundary before D1 write.
		// Empty token is allowed through here; the backend rejects it
		// in Zod's `.min(1)` check on `auth.pat` (the cross-field guard
		// only fires when `auth.pat` is `undefined`, not `""` — PR #216
		// round 2 NIT corrected the misstatement here).
		return { repo, auth: { pat: token } };
	}
	// auth === "ssh"
	const privateKey = repoAuthSshKey.value;
	const knownHostsMode = repoAuthSshKnownHostsMode.value;
	// "default" is the wire-shape sentinel the backend resolves to the
	// bundled github/gitlab/bitbucket fingerprints (see 188d's
	// knownHosts.ts). Custom mode passes the textarea content verbatim.
	const knownHosts = knownHostsMode === "custom" ? repoAuthSshKnownHostsCustom.value : "default";
	return { repo, auth: { ssh: { privateKey, knownHosts } } };
}

// ── Advanced tab (#191 / PR 191c) ───────────────────────────────────────────
//
// Four sections: Git identity, Dotfiles, Agent config seed, and the
// existing postCreate / postStart lifecycle commands. State is read
// directly from the DOM at submit time (`collectAdvancedForSubmit`)
// — same pattern as the Repo tab, no in-memory mirror needed.
//
// `resetAdvancedTab()` runs on modal close. Critical for the agent-
// seed textareas in particular: those bodies can be substantial
// (settings.json, CLAUDE.md), and leaving them mounted between
// closes risks the next session-create operator submitting stale
// content from a previous attempt.
//
// `validateAgentSeedSettings()` runs on blur of the settings.json
// textarea: client-side JSON parse → red error message inline. The
// backend's Zod refine is the source of truth (catches the same
// case with a 400), but immediate feedback is much friendlier than
// waiting for submit.

const gitIdentityName = document.getElementById("git-identity-name") as HTMLInputElement;
const gitIdentityEmail = document.getElementById("git-identity-email") as HTMLInputElement;
const dotfilesUrl = document.getElementById("dotfiles-url") as HTMLInputElement;
const dotfilesRef = document.getElementById("dotfiles-ref") as HTMLInputElement;
const dotfilesInstallScript = document.getElementById(
	"dotfiles-install-script",
) as HTMLInputElement;
const agentSeedSettings = document.getElementById("agent-seed-settings") as HTMLTextAreaElement;
const agentSeedSettingsError = document.getElementById(
	"agent-seed-settings-error",
) as HTMLSpanElement;
const agentSeedClaudeMd = document.getElementById("agent-seed-claude-md") as HTMLTextAreaElement;
const postCreateCmd = document.getElementById("post-create-cmd") as HTMLTextAreaElement;
const postStartCmd = document.getElementById("post-start-cmd") as HTMLTextAreaElement;
// Resources sub-section. CPU is in cores → translated to nano-CPUs on
// submit (Docker's HostConfig unit; matches the backend's wire shape).
// Memory is amount + GiB/MiB → translated to bytes. Idle is amount +
// minutes/hours → translated to seconds, OR omitted (undefined) for
// "Never" — the schema is `.optional()` not `.nullable()`, so sending
// `null` returns 400.
const resourcesCpuCores = document.getElementById("resources-cpu-cores") as HTMLInputElement;
const resourcesMemAmount = document.getElementById("resources-mem-amount") as HTMLInputElement;
const resourcesMemUnit = document.getElementById("resources-mem-unit") as HTMLSelectElement;
const resourcesIdleAmount = document.getElementById("resources-idle-amount") as HTMLInputElement;
const resourcesIdleUnit = document.getElementById("resources-idle-unit") as HTMLSelectElement;

/**
 * Validate `~/.claude/settings.json` content client-side. Backend's
 * Zod refine catches the same case with a precise 400, but inline
 * feedback on blur is much friendlier than a server round-trip.
 *
 * Returns true when valid (or empty — empty is "don't write the
 * file" per the schema). Sets the inline error message as a side
 * effect.
 */
function validateAgentSeedSettings(): boolean {
	const value = agentSeedSettings.value;
	if (value.trim() === "") {
		agentSeedSettingsError.textContent = "";
		return true;
	}
	try {
		JSON.parse(value);
		agentSeedSettingsError.textContent = "";
		return true;
	} catch (err) {
		agentSeedSettingsError.textContent = `Invalid JSON: ${(err as Error).message}`;
		return false;
	}
}

agentSeedSettings.addEventListener("blur", validateAgentSeedSettings);

// #200 — DOM mirror of the operator-tunable per-session caps. The
// HTML ships with the v1 defaults baked in (cpu max="8", hint says
// "0.25–8 cores, 256 MiB–16 GiB") so that a pre-#200 backend / a
// pre-checkAuthStatus paint shows the same numbers the form would
// have shown before this PR. This function rewrites those two
// surfaces (input `max`, bounds-hint text) once the API client has
// the effective caps. Called from `initAuth` after checkAuthStatus
// succeeds and from `openNewSessionModal` so an operator change
// between auth-check and modal-open still surfaces correctly on the
// next modal open. The `min` attribute is NOT changed — the floor is
// fixed at 0.25c / 256 MiB regardless of operator policy.
const resourcesBoundsHint = document.getElementById(
	"resources-bounds-hint",
) as HTMLParagraphElement;

function applyResourceCapsToForm(): void {
	const caps = getResourceCaps();
	resourcesCpuCores.max = String(caps.cpuMaxCores);
	// Memory hint: surface MiB exactly when the cap is below 1 GiB,
	// otherwise express in GiB for readability. Same dual-unit shape
	// the form's mem-unit dropdown uses.
	const memMaxStr =
		caps.memMaxMiB >= 1024 && caps.memMaxMiB % 1024 === 0
			? `${caps.memMaxMiB / 1024} GiB`
			: `${caps.memMaxMiB} MiB`;
	resourcesBoundsHint.textContent =
		`Per-session limits. Empty fields fall back to the deployment defaults ` +
		`(2 cores / 2 GiB / no auto-stop). Bounds: CPU 0.25–${caps.cpuMaxCores} cores, ` +
		`memory 256 MiB–${memMaxStr}, idle TTL 1 minute–24 hours.`;
}

// #202 — the caller's own quota headroom, shown under the bounds hint.
// A create that would bust the account budget 429s server-side; this
// hint lets the user see it coming instead of discovering it on submit.
// Best-effort: a failed fetch just leaves the line empty (the server
// still enforces).
const quotaHeadroomHint = document.getElementById("quota-headroom-hint") as HTMLParagraphElement;

async function refreshQuotaHeadroom(): Promise<void> {
	quotaHeadroomHint.textContent = "";
	try {
		const q = await fetchMyQuotas();
		const parts = [`Your account: ${q.usage.activeSessions}/${q.effective.maxSessions} sessions`];
		if (q.effective.maxTotalCpu !== null) {
			parts.push(
				`${q.usage.cpuNanos / 1e9}/${q.effective.maxTotalCpu / 1e9} cores of CPU budget in use`,
			);
		}
		if (q.effective.maxTotalMem !== null) {
			parts.push(
				`${Math.round(q.usage.memBytes / 2 ** 20)}/${Math.round(q.effective.maxTotalMem / 2 ** 20)} MiB of memory budget in use`,
			);
		}
		quotaHeadroomHint.textContent = `${parts.join(" · ")}.`;
	} catch {
		// Non-fatal: the hint is advisory; the backend still enforces.
	}
}

/** Wipe Advanced-tab state on modal close. Important for the agent-
 *  seed textareas — leaving 256 KiB of pasted content mounted between
 *  modal closes is bad UX (and a potential leak if the next operator
 *  is a different user, though that's not the typical case here). */
function resetAdvancedTab(): void {
	gitIdentityName.value = "";
	gitIdentityEmail.value = "";
	dotfilesUrl.value = "";
	dotfilesRef.value = "";
	dotfilesInstallScript.value = "";
	agentSeedSettings.value = "";
	agentSeedClaudeMd.value = "";
	postCreateCmd.value = "";
	postStartCmd.value = "";
	agentSeedSettingsError.textContent = "";
	resourcesCpuCores.value = "";
	resourcesMemAmount.value = "";
	resourcesMemUnit.value = "GiB";
	resourcesIdleAmount.value = "";
	resourcesIdleUnit.value = "minutes";
}

/**
 * Read the Advanced tab into the wire shape the backend accepts under
 * `body.config`. Returns the four optional fields plus the two cmd
 * strings; `undefined` for any field whose inputs are empty.
 *
 * Trims trimmable values; keeps newlines in agent-seed bodies and the
 * cmd textareas (those are content, not formatting). The backend's
 * Zod schema is the single source of truth for shape validation —
 * client-side mirroring would just be one more place to keep in
 * sync. The user gets a 400 with a precise field path on submit.
 *
 * Exported so a future test file can pin the wire shape; matches the
 * `collectRepoForSubmit` precedent.
 */
export function collectAdvancedForSubmit(): {
	gitIdentity?: SessionConfigPayload["gitIdentity"];
	dotfiles?: SessionConfigPayload["dotfiles"];
	agentSeed?: SessionConfigPayload["agentSeed"];
	postCreateCmd?: string;
	postStartCmd?: string;
	cpuLimit?: number;
	memLimit?: number;
	idleTtlSeconds?: number;
} {
	const out: ReturnType<typeof collectAdvancedForSubmit> = {};

	const name = gitIdentityName.value.trim();
	const email = gitIdentityEmail.value.trim();
	if (name !== "" || email !== "") {
		// Both required when either is set; backend cross-validates.
		// We send what we have and let the 400 surface the missing
		// half — same precedent as the Repo tab's PAT/SSH cases.
		out.gitIdentity = { name, email };
	}

	const dotUrl = dotfilesUrl.value.trim();
	if (dotUrl !== "") {
		const dot: NonNullable<SessionConfigPayload["dotfiles"]> = { url: dotUrl };
		const ref = dotfilesRef.value.trim();
		const install = dotfilesInstallScript.value.trim();
		if (ref !== "") dot.ref = ref;
		if (install !== "") dot.installScript = install;
		out.dotfiles = dot;
	}

	// Trim BOTH fields before the empty check (PR #219 round 1
	// SHOULD-FIX). A whitespace-only `settings` would otherwise pass
	// the empty-check and reach the backend, where `JSON.parse("  ")`
	// throws and Zod returns a 400 with no inline-error indication.
	// Trimming JSON is safe — leading/trailing whitespace is
	// insignificant per the spec. Trimming `claudeMd` is also fine
	// here because the backend's bootstrap stage skips writing the
	// file when the value is empty after the runner's own check.
	const settings = agentSeedSettings.value.trim();
	const claudeMd = agentSeedClaudeMd.value.trim();
	if (settings !== "" || claudeMd !== "") {
		const seed: NonNullable<SessionConfigPayload["agentSeed"]> = {};
		if (settings !== "") seed.settings = settings;
		if (claudeMd !== "") seed.claudeMd = claudeMd;
		out.agentSeed = seed;
	}

	const pc = postCreateCmd.value.trim();
	const ps = postStartCmd.value.trim();
	if (pc !== "") out.postCreateCmd = pc;
	if (ps !== "") out.postStartCmd = ps;

	// Resources sub-section. Each field is optional and only emitted
	// when it parses to a finite positive number — the backend's
	// schema enforces the actual bounds (CPU 0.25–8 cores, memory
	// 256 MiB–16 GiB, idle TTL 60 s–24 h), so a value at-or-near the
	// edge gets a precise 400 with the field path. Empty / "Never" /
	// non-numeric inputs drop through and the field is omitted —
	// `.optional()` in the schema means an absent field falls back
	// to the spawn-time default.
	const cpuRaw = resourcesCpuCores.value.trim();
	if (cpuRaw !== "") {
		const cores = Number(cpuRaw);
		// `Number.isFinite` (not `isInteger`) — the spec accepts
		// fractional cores like 0.25 and 0.5; nano-CPU integer math
		// happens at the multiplication step. Backend re-validates
		// the integer result.
		if (Number.isFinite(cores) && cores > 0) {
			out.cpuLimit = Math.round(cores * 1_000_000_000);
		}
	}

	const memRaw = resourcesMemAmount.value.trim();
	if (memRaw !== "") {
		const amount = Number(memRaw);
		if (Number.isFinite(amount) && amount > 0) {
			const unitFactor = resourcesMemUnit.value === "GiB" ? 1024 ** 3 : 1024 ** 2;
			out.memLimit = Math.round(amount * unitFactor);
		}
	}

	const idleRaw = resourcesIdleAmount.value.trim();
	if (idleRaw !== "") {
		const amount = Number(idleRaw);
		if (Number.isFinite(amount) && amount > 0) {
			const unitSeconds = resourcesIdleUnit.value === "hours" ? 3600 : 60;
			out.idleTtlSeconds = Math.round(amount * unitSeconds);
		}
	}

	return out;
}

// ── Env tab (#186 / PR 186c) ────────────────────────────────────────────────
//
// State + render + wiring for the typed env-var Env tab. Each row
// holds `{ name, value, type }`; the type cell is a toggle that flips
// between plain and secret. Secret rows mask the value input
// (`type="password"`) so the value isn't shoulder-surfable; the
// underlying string still flows out via the form's submit handler.
//
// Invariant: the in-memory `envRows` is the source of truth. We
// re-render rows from the array on every mutation rather than mutating
// the DOM in place — keeps the table mirror of state simple and
// avoids drift between input values and the array.

interface EnvRow {
	id: string; // stable per-row key for the DOM (not sent to the server)
	name: string;
	value: string;
	type: "plain" | "secret";
}

let envRows: EnvRow[] = [];

const envTableBody = document.getElementById("env-table-body") as HTMLTableSectionElement;
const envAddRowBtn = document.getElementById("env-add-row") as HTMLButtonElement;
const envPasteToggle = document.getElementById("env-paste-toggle") as HTMLButtonElement;
const envPastePanel = document.getElementById("env-paste-panel") as HTMLDivElement;
const envPasteTextarea = document.getElementById("env-paste-textarea") as HTMLTextAreaElement;
const envPasteCancel = document.getElementById("env-paste-cancel") as HTMLButtonElement;
const envPasteImport = document.getElementById("env-paste-import") as HTMLButtonElement;
const envPasteStatus = document.getElementById("env-paste-status") as HTMLSpanElement;
// #277 — `.env` materialisation toggle. Lives in the Env tab so it
// reads as "what happens to these entries on bootstrap" right under
// the table. Off by default; flipped to true on `Use template` when
// the source template had it on, cleared in `resetEnvTab`.
const envWriteFileCheckbox = document.getElementById("env-write-file") as HTMLInputElement;

function newEnvRowId(): string {
	// Random per-row id stays stable across re-renders so input focus
	// can be preserved (we read DOM input values BEFORE re-rendering;
	// the id is the table row's `data-row-id`).
	return `env-row-${Math.random().toString(36).slice(2, 10)}`;
}

function renderEnvRows() {
	envTableBody.textContent = "";
	for (const row of envRows) {
		const tr = document.createElement("tr");
		tr.className = "env-row";
		tr.dataset.rowId = row.id;

		const nameCell = document.createElement("td");
		const nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.value = row.name;
		nameInput.placeholder = "FOO";
		nameInput.spellcheck = false;
		nameInput.autocapitalize = "characters";
		nameInput.className = "env-input env-input-name";
		nameInput.dataset.field = "name";
		nameCell.appendChild(nameInput);
		tr.appendChild(nameCell);

		const valueCell = document.createElement("td");
		const valueInput = document.createElement("input");
		// Secret rows mask the value visually — the user-typed string
		// still flows through `.value` on submit; password masking is
		// purely UX (shoulder-surfing defence).
		valueInput.type = row.type === "secret" ? "password" : "text";
		valueInput.value = row.value;
		valueInput.placeholder = row.type === "secret" ? "••••••••" : "value";
		valueInput.spellcheck = false;
		valueInput.autocomplete = "off";
		valueInput.className = "env-input env-input-value";
		valueInput.dataset.field = "value";
		valueCell.appendChild(valueInput);
		tr.appendChild(valueCell);

		const typeCell = document.createElement("td");
		const typeToggle = document.createElement("button");
		typeToggle.type = "button";
		typeToggle.className = `env-type-toggle env-type-${row.type}`;
		typeToggle.textContent = row.type === "secret" ? "secret" : "plain";
		typeToggle.title =
			row.type === "secret"
				? "Click to mark this entry plain (value visible)"
				: "Click to mark this entry secret (value masked + encrypted server-side)";
		typeToggle.dataset.action = "toggle-type";
		typeCell.appendChild(typeToggle);
		tr.appendChild(typeCell);

		const removeCell = document.createElement("td");
		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "env-row-remove";
		removeBtn.textContent = "✕";
		removeBtn.title = "Remove this entry";
		removeBtn.setAttribute("aria-label", `Remove ${row.name || "entry"}`);
		removeBtn.dataset.action = "remove";
		removeCell.appendChild(removeBtn);
		tr.appendChild(removeCell);

		envTableBody.appendChild(tr);
	}
}

/**
 * Pull the latest input values out of the DOM into `envRows` before
 * any operation that re-renders. Without this, a user typing into a
 * row and then clicking Add / toggle / Delete on a different row
 * would lose their pending edit when render wipes the table.
 */
function syncEnvRowsFromDom() {
	const trs = envTableBody.querySelectorAll<HTMLTableRowElement>(".env-row");
	for (const tr of trs) {
		const id = tr.dataset.rowId ?? "";
		const row = envRows.find((r) => r.id === id);
		if (!row) continue;
		const nameInput = tr.querySelector<HTMLInputElement>('[data-field="name"]');
		const valueInput = tr.querySelector<HTMLInputElement>('[data-field="value"]');
		// Uppercase at the read site (#211 round 1). The Env-table CSS
		// applies `text-transform: uppercase` for visual consistency,
		// but DOM `.value` returns raw keystrokes — a desktop user
		// typing `foo` sees `FOO` rendered and then hits the backend's
		// `^[A-Z_][A-Z0-9_]*$` regex with the lowercase value on
		// submit. `.toUpperCase()` here keeps state aligned with the
		// rendering. `autocapitalize` already handled mobile.
		if (nameInput) row.name = nameInput.value.toUpperCase();
		if (valueInput) row.value = valueInput.value;
	}
}

function resetEnvTab() {
	envRows = [];
	renderEnvRows();
	envPastePanel.hidden = true;
	envPasteToggle.setAttribute("aria-expanded", "false");
	envPasteTextarea.value = "";
	envPasteStatus.textContent = "";
	envWriteFileCheckbox.checked = false;
}

envAddRowBtn.addEventListener("click", () => {
	syncEnvRowsFromDom();
	envRows.push({ id: newEnvRowId(), name: "", value: "", type: "plain" });
	renderEnvRows();
	// Focus the new row's name input so the user can type immediately.
	const last =
		envTableBody.lastElementChild?.querySelector<HTMLInputElement>('[data-field="name"]');
	last?.focus();
});

envTableBody.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	const action = target.dataset.action;
	if (!action) return;
	const tr = target.closest<HTMLTableRowElement>(".env-row");
	const id = tr?.dataset.rowId ?? "";
	syncEnvRowsFromDom();
	if (action === "toggle-type") {
		const row = envRows.find((r) => r.id === id);
		if (row) row.type = row.type === "secret" ? "plain" : "secret";
		renderEnvRows();
	} else if (action === "remove") {
		envRows = envRows.filter((r) => r.id !== id);
		renderEnvRows();
	}
});

envPasteToggle.addEventListener("click", () => {
	const isOpen = !envPastePanel.hidden;
	envPastePanel.hidden = isOpen;
	envPasteToggle.setAttribute("aria-expanded", String(!isOpen));
	if (!isOpen) requestAnimationFrame(() => envPasteTextarea.focus());
});

envPasteCancel.addEventListener("click", () => {
	envPastePanel.hidden = true;
	envPasteToggle.setAttribute("aria-expanded", "false");
	envPasteTextarea.value = "";
	envPasteStatus.textContent = "";
});

envPasteImport.addEventListener("click", () => {
	syncEnvRowsFromDom();
	const result = parseDotEnv(envPasteTextarea.value);
	for (const entry of result.parsed) {
		// Spec: imported entries default to `plain`. User flips to
		// `secret` afterwards by clicking the type toggle on the row.
		envRows.push({
			id: newEnvRowId(),
			name: entry.name,
			value: entry.value,
			type: "plain",
		});
	}
	const skippedSummary = result.skipped
		.slice(0, 3) // first 3 reasons; "+N more" if longer
		.map((s) => `line ${s.line}: ${s.reason}`)
		.join("; ");
	const moreCount = result.skipped.length - 3;
	const more = moreCount > 0 ? ` (+${moreCount} more)` : "";
	envPasteStatus.textContent =
		result.skipped.length === 0
			? `Imported ${result.parsed.length} entr${result.parsed.length === 1 ? "y" : "ies"}.`
			: `Imported ${result.parsed.length}, skipped ${result.skipped.length} — ${skippedSummary}${more}`;
	envPasteTextarea.value = "";
	envPastePanel.hidden = true;
	envPasteToggle.setAttribute("aria-expanded", "false");
	renderEnvRows();
});

/**
 * Collect the in-memory `envRows` into the wire shape the backend
 * accepts under `body.config.envVars`. Drops fully-empty rows
 * (user added an entry then deleted both fields) but DOES surface
 * partially-filled rows so the backend's clear 400 covers the typo
 * cases the user is most likely to hit.
 */
function collectEnvVarsForSubmit(): EnvVarEntryInput[] | undefined {
	syncEnvRowsFromDom();
	const out: EnvVarEntryInput[] = [];
	for (const row of envRows) {
		if (row.name === "" && row.value === "") continue;
		out.push(
			row.type === "secret"
				? { name: row.name, type: "secret", value: row.value }
				: { name: row.name, type: "plain", value: row.value },
		);
	}
	return out.length > 0 ? out : undefined;
}

newSessionForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = newSessionInput.value.trim();
	if (!name) {
		newSessionInput.focus();
		return;
	}
	// Disable the submit button for the duration of the request so a
	// double-click doesn't fire two POSTs (which would create two
	// sessions and burn quota silently — or two PUTs in edit mode).
	newSessionSubmitBtn.disabled = true;
	clearBootstrapError();
	teardownBootstrapTail();

	// Edit-template branch (#231). Build the same SessionConfigPayload
	// the create flow would, then strip secret values and PUT to the
	// templates endpoint. The strip is the same one save-as-template
	// uses — so a template that's been edited can be `Use template`d
	// without any "stale credential leaked" surprise.
	if (editingTemplateId !== null) {
		try {
			const config = stripConfigForTemplate(buildSessionConfigPayload() ?? {});
			const description = editTemplateDescriptionInput.value.trim();
			await updateTemplate(editingTemplateId, {
				name,
				description: description.length > 0 ? description : null,
				config,
			});
			showToast(`Template "${name}" saved`);
			closeNewSessionModal();
			// Re-open the templates modal so the user lands back on the
			// list (with the freshly-saved row at the top via D1's
			// `ORDER BY updated_at DESC`). `openTemplatesModal` already
			// kicks off `refreshTemplatesList` so no separate fetch
			// is needed here.
			openTemplatesModal(resolveTemplatesOpener());
		} catch (err) {
			showToast((err as Error).message, true);
			newSessionSubmitBtn.disabled = false;
		}
		return;
	}

	try {
		showToast("Creating session…");
		const config = buildSessionConfigPayload();
		const session = await createSession(name, undefined, config);
		sessions.unshift(session);
		renderSessionList();
		if (session.bootstrapping) {
			// PR 185b2b: postCreate is running asynchronously on the
			// server. Switch the modal into live-tail mode and wait
			// for the WS terminal message before either closing
			// (success) or rendering an error panel (failure).
			startBootstrapLiveTail(session, name);
			return;
		}
		closeNewSessionModal();
		void openSession(session.sessionId);
		showToast(`Session "${name}" created`);
	} catch (err) {
		showToast((err as Error).message, true);
		newSessionSubmitBtn.disabled = false;
	}
});

/**
 * Collects the current modal state into a `SessionConfigPayload`.
 * Returns `undefined` when nothing has been configured (the bare
 * `POST /sessions` shape) so callers can omit `body.config`.
 *
 * Extracted from the submit handler so the edit-template path can
 * reuse it (#231) — without this, the edit branch would have to
 * duplicate the whole "is anything configured" check.
 */
function buildSessionConfigPayload(): SessionConfigPayload | undefined {
	const envVars = collectEnvVarsForSubmit();
	const writeEnvFile = envWriteFileCheckbox.checked;
	const { repo, auth } = collectRepoForSubmit();
	const advanced = collectAdvancedForSubmit();
	const { ports, allowPrivilegedPorts } = collectPortsForSubmit();
	const advancedHasContent =
		advanced.gitIdentity !== undefined ||
		advanced.dotfiles !== undefined ||
		advanced.agentSeed !== undefined ||
		advanced.postCreateCmd !== undefined ||
		advanced.postStartCmd !== undefined ||
		advanced.cpuLimit !== undefined ||
		advanced.memLimit !== undefined ||
		advanced.idleTtlSeconds !== undefined;
	const portsHasContent = ports !== undefined || allowPrivilegedPorts === true;
	// #277 — `writeEnvFile` alone (without any envVars) still counts
	// as "something configured" so the bare-POST short-circuit
	// doesn't drop the toggle. The backend's stage no-ops when
	// envVars is empty, so a toggle-on-but-no-vars submission costs
	// only one extra config row and one no-op bootstrap step.
	if (!envVars && !writeEnvFile && !repo && !advancedHasContent && !portsHasContent)
		return undefined;
	return {
		...(envVars ? { envVars } : {}),
		...(writeEnvFile ? { writeEnvFile: true } : {}),
		...(repo ? { repo } : {}),
		...(auth ? { auth } : {}),
		...advanced,
		...(ports ? { ports } : {}),
		...(allowPrivilegedPorts ? { allowPrivilegedPorts } : {}),
	};
}

// ── Save-as-template flow (#195 / PR 195b) ──────────────────────────────────
//
// "Save as template…" button on the create-session modal opens a tiny
// dialog (name + optional description), strips secrets from the
// current form state via `stripConfigForTemplate`, and POSTs to
// `/api/templates`. The create-session modal stays open underneath so
// the user can still create the session after saving the template, or
// dismiss both. The Templates *page* (list / use / delete) lands in
// the next sub-PR; this PR is "save only".

const saveTemplateBtn = document.getElementById("save-as-template-btn") as HTMLButtonElement;
const saveTemplateModal = document.getElementById("save-template-modal")!;
const saveTemplateForm = document.getElementById("save-template-form") as HTMLFormElement;
const saveTemplateNameInput = document.getElementById("save-template-name") as HTMLInputElement;
const saveTemplateDescriptionInput = document.getElementById(
	"save-template-description",
) as HTMLInputElement;
const saveTemplateSubmit = document.getElementById("save-template-submit") as HTMLButtonElement;

function openSaveTemplateModal() {
	saveTemplateNameInput.value = "";
	saveTemplateDescriptionInput.value = "";
	saveTemplateSubmit.disabled = false;
	saveTemplateModal.classList.add("open");
	saveTemplateModal.setAttribute("aria-hidden", "false");
	requestAnimationFrame(() => saveTemplateNameInput.focus());
}

function closeSaveTemplateModal() {
	saveTemplateModal.classList.remove("open");
	saveTemplateModal.setAttribute("aria-hidden", "true");
	// Return focus to the trigger button so keyboard users don't lose
	// their tab-order position. Same shape as `closeInvitesModal` /
	// `closePasteModal`. PR #229 round 1 NIT.
	saveTemplateBtn.focus();
}

saveTemplateBtn.addEventListener("click", () => {
	openSaveTemplateModal();
});

saveTemplateModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeSaveTemplateModal();
});

/**
 * Build the same `body.config` payload `createSession` would send,
 * then strip secrets before handing it to `createTemplate`. Reuses
 * the four collectors so the template captures EXACTLY what the
 * user sees in the form — no drift between "what would I create"
 * and "what would I save".
 */
function buildTemplateConfigFromForm(): SessionConfigPayload {
	const envVars = collectEnvVarsForSubmit();
	const writeEnvFile = envWriteFileCheckbox.checked;
	const { repo, auth } = collectRepoForSubmit();
	const advanced = collectAdvancedForSubmit();
	const { ports, allowPrivilegedPorts } = collectPortsForSubmit();
	const config: SessionConfigPayload = {
		...(envVars ? { envVars } : {}),
		...(writeEnvFile ? { writeEnvFile: true } : {}),
		...(repo ? { repo } : {}),
		...(auth ? { auth } : {}),
		...advanced,
		...(ports ? { ports } : {}),
		...(allowPrivilegedPorts ? { allowPrivilegedPorts } : {}),
	};
	return stripConfigForTemplate(config);
}

saveTemplateForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = saveTemplateNameInput.value.trim();
	if (!name) {
		saveTemplateNameInput.focus();
		return;
	}
	const description = saveTemplateDescriptionInput.value.trim();
	saveTemplateSubmit.disabled = true;
	try {
		const config = buildTemplateConfigFromForm();
		await createTemplate({
			name,
			...(description !== "" ? { description } : {}),
			config,
		});
		closeSaveTemplateModal();
		showToast(`Template "${name}" saved`);
	} catch (err) {
		showToast((err as Error).message, true);
		saveTemplateSubmit.disabled = false;
	}
});

// ── Templates page (#195 / PR 195c) ─────────────────────────────────────────
//
// Sidebar entry → modal listing the user's own templates with Use /
// Delete actions. Use opens the create-session modal pre-filled with
// the template's config; secret-slot env entries collapse back to
// type:"secret" with empty values so the user has to fill them in
// before submit. Edit is deferred to a follow-up.

const sidebarTemplatesBtn = document.getElementById("sidebar-templates-btn") as HTMLButtonElement;
const templatesModal = document.getElementById("templates-modal")!;
const templatesList = document.getElementById("templates-list") as HTMLDivElement;
const templatesEmptyHint = document.getElementById("templates-empty-hint") as HTMLParagraphElement;

let templatesOpener: HTMLElement | null = null;

/**
 * Pick the Templates button that's actually rendered for the current
 * viewport — `templatesBtn` on desktop, `sidebarTemplatesBtn` on mobile.
 * `offsetParent === null` is the standard "is this element rendered"
 * test (returns null for `display:none` ancestors), and the header /
 * sidebar split is exactly the case it was designed for.
 *
 * Used by callers that open the templates modal from a third place
 * (e.g. the save-template flow re-opening templates after a save) —
 * those callers don't know which button the user clicked first, so
 * they must resolve the contextually-correct opener themselves.
 * Without this, focus restoration on close would land on a hidden
 * element and silently drop to `document.body`. See PR #257 review.
 */
function resolveTemplatesOpener(): HTMLButtonElement {
	return templatesBtn.offsetParent !== null ? templatesBtn : sidebarTemplatesBtn;
}

function openTemplatesModal(opener: HTMLElement) {
	templatesOpener = opener;
	templatesModal.classList.add("open");
	templatesModal.setAttribute("aria-hidden", "false");
	void refreshTemplatesList();
}

function closeTemplatesModal() {
	templatesModal.classList.remove("open");
	templatesModal.setAttribute("aria-hidden", "true");
	// Fall back to whichever button is rendered for the current
	// viewport if the opener is missing (legacy path or a future
	// caller that forgot to set it). The resolver covers both
	// desktop and mobile — `templatesBtn` is `display:none` on
	// mobile and would silently drop focus there otherwise.
	(templatesOpener ?? resolveTemplatesOpener()).focus();
	templatesOpener = null;
}

async function refreshTemplatesList() {
	templatesList.textContent = "";
	templatesEmptyHint.textContent = "Loading templates…";
	templatesList.appendChild(templatesEmptyHint);
	try {
		const list = await listTemplates();
		templatesList.textContent = "";
		if (list.length === 0) {
			templatesEmptyHint.textContent =
				'No templates yet. Use "Save as template…" on the new-session modal to create one.';
			templatesList.appendChild(templatesEmptyHint);
			return;
		}
		for (const t of list) {
			templatesList.appendChild(renderTemplateCard(t));
		}
	} catch (err) {
		templatesEmptyHint.textContent = `Failed to load: ${(err as Error).message}`;
		templatesList.appendChild(templatesEmptyHint);
	}
}

function renderTemplateCard(t: TemplateSummary): HTMLElement {
	const card = document.createElement("div");
	card.className = "template-card";
	card.dataset.templateId = t.id;

	const header = document.createElement("div");
	header.className = "template-card-header";
	const nameEl = document.createElement("strong");
	nameEl.textContent = t.name;
	header.appendChild(nameEl);
	card.appendChild(header);

	if (t.description) {
		const desc = document.createElement("p");
		desc.className = "template-card-description";
		desc.textContent = t.description;
		card.appendChild(desc);
	}

	const actions = document.createElement("div");
	actions.className = "template-card-actions";
	const useBtn = document.createElement("button");
	useBtn.type = "button";
	useBtn.textContent = "Use";
	useBtn.dataset.action = "use";
	const editBtn = document.createElement("button");
	editBtn.type = "button";
	editBtn.textContent = "Edit";
	editBtn.dataset.action = "edit";
	const delBtn = document.createElement("button");
	delBtn.type = "button";
	delBtn.textContent = "Delete";
	delBtn.dataset.action = "delete";
	delBtn.className = "template-card-delete";
	actions.appendChild(useBtn);
	actions.appendChild(editBtn);
	actions.appendChild(delBtn);
	card.appendChild(actions);

	return card;
}

templatesList.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	const action = target.dataset.action;
	if (action !== "use" && action !== "edit" && action !== "delete") return;
	const card = target.closest<HTMLDivElement>(".template-card");
	const id = card?.dataset.templateId;
	if (!id) return;
	if (action === "use" || action === "edit") {
		// Disable the button before the in-flight `getTemplate` so a
		// double-click can't fire two concurrent fetches that both
		// race to apply config + close-and-open modals. Mirrors the
		// `saveTemplateSubmit.disabled = true` shape on the save
		// flow. PR #230 round 2 NIT.
		const btn = target as HTMLButtonElement;
		btn.disabled = true;
		const op = action === "use" ? useTemplate(id) : editTemplate(id);
		void op.finally(() => {
			btn.disabled = false;
		});
	} else {
		void deleteTemplateConfirmed(id, card!);
	}
});

templatesModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeTemplatesModal();
});

templatesBtn.addEventListener("click", () => openTemplatesModal(templatesBtn));
sidebarTemplatesBtn.addEventListener("click", () => openTemplatesModal(sidebarTemplatesBtn));

async function deleteTemplateConfirmed(id: string, card: HTMLDivElement) {
	const name = card.querySelector("strong")?.textContent ?? "this template";
	if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
	try {
		await deleteTemplate(id);
		showToast(`Template "${name}" deleted`);
		void refreshTemplatesList();
	} catch (err) {
		showToast((err as Error).message, true);
	}
}

/**
 * Use template: closes the templates modal, opens the create-session
 * modal, and pre-fills the form from the template's config. Secret
 * values are placeholders the user fills in before submit.
 */
async function useTemplate(id: string) {
	try {
		const t = await getTemplate(id);
		closeTemplatesModal();
		openNewSessionModal(resolveTemplatesOpener());
		applyTemplateToForm(t);
		showToast(`Loaded template "${t.name}". Fill in any required secrets, then Create.`);
	} catch (err) {
		showToast((err as Error).message, true);
	}
}

/**
 * Edit template (#231): reuses the create-session modal as the editor.
 * The flow is `useTemplate`'s shape — load, close templates modal,
 * open session modal, apply config — plus a `setNewSessionModalMode`
 * call after the form is populated so the chrome reflects edit mode.
 *
 * The mode flip happens AFTER `applyTemplateToForm` because the
 * latter resets `newSessionInput.value` to the template name (which
 * is what we want as the editable name field), and the mode setter's
 * extra work (description population, button labels) needs to run
 * after the input value is in place.
 */
async function editTemplate(id: string) {
	try {
		const t = await getTemplate(id);
		closeTemplatesModal();
		openNewSessionModal(resolveTemplatesOpener());
		applyTemplateToForm(t);
		setNewSessionModalMode(t);
	} catch (err) {
		showToast((err as Error).message, true);
	}
}

/**
 * Apply a template's stored config to the create-session form's
 * in-memory state. Mirrors the collectors' field shapes in reverse —
 * so a save-then-use round-trip ends up at the same form state the
 * user originally typed (modulo stripped secrets).
 *
 * Secret-slot env entries collapse to `secret`-typed rows with empty
 * values; the user has to type each one before submit. PAT / SSH
 * "intent without credential" cases (config.repo.auth = pat/ssh with
 * no auth.pat / auth.ssh) leave the credential fields empty for the
 * user to fill in.
 */
function applyTemplateToForm(t: Template): void {
	const cfg = t.config;
	// Pre-fill the session name from the template name. The user
	// can rename before submit; sessions and templates have
	// independent name spaces (no uniqueness collision).
	newSessionInput.value = t.name;

	// Env vars — secret-slot becomes a `secret` row with empty
	// value the user must fill in. Plain rows pass through.
	envRows = (cfg.envVars ?? []).map((entry) => {
		if (entry.type === "secret-slot") {
			return { id: newEnvRowId(), name: entry.name, value: "", type: "secret" };
		}
		return {
			id: newEnvRowId(),
			name: entry.name,
			value: entry.value,
			type: entry.type,
		};
	});
	renderEnvRows();
	envWriteFileCheckbox.checked = cfg.writeEnvFile === true;

	// Repo + auth. The credential fields stay empty if the
	// template only carried the auth declaration (the strip
	// helper drops auth.pat / auth.ssh.privateKey but keeps
	// auth.ssh.knownHosts and the repo.auth flag).
	if (cfg.repo) {
		repoUrl.value = cfg.repo.url;
		repoRef.value = cfg.repo.ref ?? "";
		repoTarget.value = cfg.repo.target ?? "";
		repoAuth.value = cfg.repo.auth;
		repoDepth.value = cfg.repo.depth ? String(cfg.repo.depth) : "";
		// Trigger the auth panel's render so PAT/SSH fields show
		// or hide per the auth selector.
		repoAuth.dispatchEvent(new Event("change"));
		repoAuthPatToken.value = cfg.auth?.pat ?? "";
		repoAuthSshKey.value = cfg.auth?.ssh?.privateKey ?? "";
		// Leave the known-hosts mode/custom selector in its default
		// state — known_hosts is a niche secondary field with its
		// own mode-selector UX, and the strip helper preserves the
		// public fingerprints anyway. Users who need a custom
		// known_hosts after applying a template re-enter via the
		// existing Repo-tab UI.
	}

	// Advanced — all the optional sub-sections.
	gitIdentityName.value = cfg.gitIdentity?.name ?? "";
	gitIdentityEmail.value = cfg.gitIdentity?.email ?? "";
	dotfilesUrl.value = cfg.dotfiles?.url ?? "";
	dotfilesRef.value = cfg.dotfiles?.ref ?? "";
	dotfilesInstallScript.value = cfg.dotfiles?.installScript ?? "";
	agentSeedSettings.value = cfg.agentSeed?.settings ?? "";
	agentSeedClaudeMd.value = cfg.agentSeed?.claudeMd ?? "";
	postCreateCmd.value = cfg.postCreateCmd ?? "";
	postStartCmd.value = cfg.postStartCmd ?? "";

	// Resources (cpu nano-CPUs → cores, mem bytes → GiB/MiB,
	// idleTtl seconds → minutes/hours). Pick the most natural
	// unit per field so the user sees the same values they would
	// have typed.
	resourcesCpuCores.value = cfg.cpuLimit ? String(cfg.cpuLimit / 1_000_000_000) : "";
	const mem = memBytesToFormUnit(cfg.memLimit);
	if (mem) {
		resourcesMemAmount.value = String(mem.amount);
		resourcesMemUnit.value = mem.unit;
	} else {
		resourcesMemAmount.value = "";
		resourcesMemUnit.value = "GiB";
	}
	const idle = idleSecondsToFormUnit(cfg.idleTtlSeconds);
	if (idle) {
		resourcesIdleAmount.value = String(idle.amount);
		resourcesIdleUnit.value = idle.unit;
	} else {
		resourcesIdleAmount.value = "";
		resourcesIdleUnit.value = "minutes";
	}

	// Ports — round-trip from the wire shape's `{container,public}`
	// back to `PortRow` shape (string container for the input).
	portRows = (cfg.ports ?? []).map((p) => ({
		id: newPortRowId(),
		container: String(p.container),
		public: p.public,
	}));
	renderPortRows();
	allowPrivilegedPortsCheckbox.checked = cfg.allowPrivilegedPorts === true;
}

// ── Ports tab (#190 / PR 190d) ──────────────────────────────────────────────
//
// Mirror of the env-tab pattern. Rows hold `{ container, public }` plus a
// stable per-row id for DOM identity across re-renders. The
// `allowPrivilegedPorts` toggle lives on the Advanced tab (granting
// CAP_NET_BIND_SERVICE is a different mental model than picking ports;
// keeps the Ports tab itself cognitively narrow). Backend rejects
// privileged ports without the toggle, so a user who tries to enter
// `80` while the toggle is off gets a 400 with a precise path
// (`config.ports.0.container`) — surfaced via the existing
// createSession error handler.

interface PortRow {
	id: string; // stable per-row key for the DOM (not sent to the server)
	container: string; // raw input value; parsed to int on submit
	public: boolean;
}

let portRows: PortRow[] = [];

const portsTableBody = document.getElementById("ports-table-body") as HTMLTableSectionElement;
const portsAddRowBtn = document.getElementById("ports-add-row") as HTMLButtonElement;
const allowPrivilegedPortsCheckbox = document.getElementById(
	"allow-privileged-ports",
) as HTMLInputElement;

function newPortRowId(): string {
	return `port-row-${Math.random().toString(36).slice(2, 10)}`;
}

function renderPortRows() {
	portsTableBody.textContent = "";
	for (const row of portRows) {
		const tr = document.createElement("tr");
		tr.className = "ports-row";
		tr.dataset.rowId = row.id;

		const containerCell = document.createElement("td");
		const containerInput = document.createElement("input");
		containerInput.type = "number";
		// Don't pin `min`/`max` on the input itself — privileged-port
		// rejection is a cross-field rule (depends on the Advanced
		// toggle), and the backend's superRefine produces the
		// authoritative error with the right path. Letting the input
		// accept the full TCP range here keeps the form usable when
		// the user enables the toggle and edits an existing row.
		containerInput.inputMode = "numeric";
		containerInput.value = row.container;
		containerInput.placeholder = "3000";
		containerInput.spellcheck = false;
		containerInput.autocomplete = "off";
		containerInput.className = "env-input";
		containerInput.dataset.field = "container";
		containerCell.appendChild(containerInput);
		tr.appendChild(containerCell);

		const publicCell = document.createElement("td");
		const publicWrap = document.createElement("label");
		publicWrap.className = "ports-public-toggle";
		const publicInput = document.createElement("input");
		publicInput.type = "checkbox";
		publicInput.checked = row.public;
		publicInput.dataset.field = "public";
		publicWrap.appendChild(publicInput);
		// Warning chip only when the row is currently `public: true` —
		// the issue spec calls this out as a deliberate UX cue so a
		// user can't tick public by accident without seeing the
		// "anyone with the URL" implication.
		if (row.public) {
			const chip = document.createElement("span");
			chip.className = "ports-public-warning";
			chip.textContent = "anyone with the URL can reach this port";
			publicWrap.appendChild(chip);
		}
		publicCell.appendChild(publicWrap);
		tr.appendChild(publicCell);

		const removeCell = document.createElement("td");
		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "env-row-remove";
		removeBtn.textContent = "✕";
		removeBtn.title = "Remove this port";
		removeBtn.setAttribute("aria-label", `Remove port ${row.container || "(empty)"}`);
		removeBtn.dataset.action = "remove";
		removeCell.appendChild(removeBtn);
		tr.appendChild(removeCell);

		portsTableBody.appendChild(tr);
	}
}

/**
 * Pull current input values out of the DOM into `portRows` before any
 * operation that re-renders. Same shape as `syncEnvRowsFromDom`: the
 * in-memory array is the source of truth, and a partially-typed input
 * would otherwise be lost on add / remove / public-toggle.
 */
function syncPortRowsFromDom() {
	const trs = portsTableBody.querySelectorAll<HTMLTableRowElement>(".ports-row");
	for (const tr of trs) {
		const id = tr.dataset.rowId ?? "";
		const row = portRows.find((r) => r.id === id);
		if (!row) continue;
		const containerInput = tr.querySelector<HTMLInputElement>('[data-field="container"]');
		const publicInput = tr.querySelector<HTMLInputElement>('[data-field="public"]');
		if (containerInput) row.container = containerInput.value.trim();
		if (publicInput) row.public = publicInput.checked;
	}
}

function resetPortsTab() {
	portRows = [];
	renderPortRows();
	allowPrivilegedPortsCheckbox.checked = false;
}

portsAddRowBtn.addEventListener("click", () => {
	syncPortRowsFromDom();
	portRows.push({ id: newPortRowId(), container: "", public: false });
	renderPortRows();
	const last = portsTableBody.lastElementChild?.querySelector<HTMLInputElement>(
		'[data-field="container"]',
	);
	last?.focus();
});

portsTableBody.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	const action = target.dataset.action;
	if (action !== "remove") return;
	const tr = target.closest<HTMLTableRowElement>(".ports-row");
	const id = tr?.dataset.rowId ?? "";
	syncPortRowsFromDom();
	portRows = portRows.filter((r) => r.id !== id);
	renderPortRows();
});

// `change` (not `click`) so keyboard interaction with the checkbox
// (Space) also re-renders. The render swap toggles the warning chip;
// without re-render the chip wouldn't appear/disappear when public
// flips.
portsTableBody.addEventListener("change", (e) => {
	const target = e.target as HTMLElement;
	if (target.dataset.field !== "public") return;
	syncPortRowsFromDom();
	renderPortRows();
});

/**
 * Collect the in-memory `portRows` + `allowPrivilegedPorts` toggle
 * into the wire shape `SessionConfigPayload` accepts. Returns
 * `undefined` for both when the user touched neither — a bare
 * POST keeps the field absent so the backend's `.strict()` stays
 * happy and the row in `session_configs.ports_json` collapses to
 * NULL.
 *
 * Container values that don't parse to a positive integer are
 * skipped silently; the backend would reject them at validation
 * with a precise error path, but it's better UX to drop a stray
 * empty row than to surface "ports.3.container: expected number"
 * for a row the user clearly didn't fill in. Out-of-range
 * integers (negative, > 65535) are still sent — those are real
 * misconfigurations the backend's error path should surface.
 */
export function collectPortsForSubmit(): {
	ports?: SessionConfigPayload["ports"];
	allowPrivilegedPorts?: boolean;
} {
	syncPortRowsFromDom();
	const out: NonNullable<SessionConfigPayload["ports"]> = [];
	for (const row of portRows) {
		if (row.container === "") continue;
		// `Number()` + `Number.isInteger` REJECTS decimal-like input
		// instead of silently truncating it. `Number("3000.9")` is
		// `3000.9` → not an integer → row dropped, the user retypes a
		// real port. `parseInt("3000.9", 10)` would return `3000`,
		// which is exactly the truncation we want to avoid (a user
		// who typed `3000.9` clearly didn't mean port 3000).
		// `type="number"` step=1 mostly prevents this at the browser
		// layer, but pasted text or a non-strict browser can still
		// surface it. PR #224 round 2 NIT (corrects round 1, which
		// inadvertently used `parseInt` and silently truncated).
		const parsed = Number(row.container);
		if (!Number.isInteger(parsed)) continue;
		out.push({ container: parsed, public: row.public });
	}
	const result: ReturnType<typeof collectPortsForSubmit> = {};
	if (out.length > 0) result.ports = out;
	if (allowPrivilegedPortsCheckbox.checked) result.allowPrivilegedPorts = true;
	return result;
}

export {
	applyResourceCapsToForm,
	closeNewSessionModal,
	closeSaveTemplateModal,
	closeTemplatesModal,
	openBootstrapLogModal,
};
