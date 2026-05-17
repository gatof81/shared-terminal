/**
 * api.ts — REST client for the shared-terminal backend.
 */

// VITE_API_URL should point to the backend (via Cloudflare Tunnel or localhost)
// e.g. https://api.terminal.yourdomain.com
const BACKEND_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_BASE = `${BACKEND_URL}/api`;
// http(s) → ws(s) for the same host. Used by the bootstrap live-tail
// channel (PR 185b2b) and could be reused by the terminal-attach WS
// helper if it ever moves into this module.
const WS_BASE = BACKEND_URL.replace(/^http/, "ws");

// ── Auth state (#18, #50) ───────────────────────────────────────────────────
//
// The JWT lives in an httpOnly cookie that JS cannot read. The booleans below
// are an in-memory mirror so the UI can route (login vs app, hide vs show
// admin features) without a round-trip per navigation. Hydrated on boot from
// /auth/status, updated on login/register/logout/401.

let _loggedIn = false;
let _isAdmin = false;
let _isLead = false;
// #200 — effective per-session resource caps mirrored from /auth/status
// so the create-session form's CPU input `max` and the bounds hint can
// reflect operator-lowered caps. Defaults match the v1 ceilings so a
// pre-cap-aware backend (or a status fetch that hasn't completed yet)
// surfaces the same numbers the form would have shown before #200.
let _resourceCaps: { cpuMaxCores: number; memMaxMiB: number } = {
	cpuMaxCores: 8,
	memMaxMiB: 16 * 1024,
};

export function isLoggedIn(): boolean {
	return _loggedIn;
}

/** True iff `users.is_admin = 1` for the current session (#50). Gates
 *  invite-mint UI in main.ts. Refreshes on every /auth/status call so a
 *  promotion / demotion takes effect on the next reload. */
export function isAdmin(): boolean {
	return _isAdmin;
}

/** True iff the user leads at least one group (#201e). Gates the
 *  "My groups" button in main.ts. Same refresh shape as `isAdmin()`
 *  — hydrated from /auth/status, login, register; cleared on logout
 *  and on 401. An admin who happens to also lead a group sees both
 *  buttons. */
export function isLead(): boolean {
	return _isLead;
}

/** Effective per-session caps from the backend (#200). Mirrored on
 *  every /auth/status call so an operator change picks up on the next
 *  page reload. The create-session form reads these to set the CPU
 *  input `max` and the bounds hint text — without this the form
 *  would advertise the v1 ceiling and the user would hit a 400 with
 *  an operator-named env var they can't act on. Returns a fresh
 *  object so callers can't mutate the module state by reference. */
export function getResourceCaps(): { cpuMaxCores: number; memMaxMiB: number } {
	return { ..._resourceCaps };
}

/** Fired by `apiFetch` once per 401-burst after flipping `_loggedIn` to false —
 * main.ts listens to perform UI teardown. See apiFetch for the emit guard. */
export const SESSION_EXPIRED_EVENT = "st:session-expired";

// ── Auth API ────────────────────────────────────────────────────────────────

export interface AuthStatus {
	needsSetup: boolean;
	authenticated: boolean;
	isAdmin: boolean;
	/** Surfaced alongside isAdmin (#201e). Always present in fresh
	 *  responses; older backends (pre-#201e) omit it — fall back to
	 *  `false` defensively when the field is missing so a stale cached
	 *  client + new server, or vice versa, doesn't surface undefined. */
	isLead?: boolean;
	/** Effective per-session resource caps (#200). Same backwards-
	 *  compatible shape — pre-#200 backends omit the field and the
	 *  client falls back to the hardcoded v1 ceilings. Units mirror
	 *  the form: cores (decimal) and MiB (integer). */
	resourceCaps?: { cpuMaxCores: number; memMaxMiB: number };
}

export async function checkAuthStatus(): Promise<AuthStatus> {
	const res = await apiFetch("/auth/status");
	const data = (await res.json()) as AuthStatus;
	// The server is the source of truth for cookie presence + admin
	// + lead status. Mirror all three so isLoggedIn() / isAdmin() /
	// isLead() can answer instantly thereafter.
	_loggedIn = data.authenticated;
	_isAdmin = data.isAdmin;
	_isLead = data.isLead === true;
	// #200: mirror caps if present. A pre-#200 backend omits the field
	// and leaves the v1 defaults in place — same hardcoded ceilings the
	// form would have used before this PR.
	if (
		data.resourceCaps &&
		Number.isFinite(data.resourceCaps.cpuMaxCores) &&
		Number.isFinite(data.resourceCaps.memMaxMiB)
	) {
		_resourceCaps = {
			cpuMaxCores: data.resourceCaps.cpuMaxCores,
			memMaxMiB: data.resourceCaps.memMaxMiB,
		};
	}
	return data;
}

export class InviteRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InviteRequiredError";
	}
}

export interface AuthSuccess {
	userId: string;
	isAdmin: boolean;
	/** Same defensive optionality as `AuthStatus.isLead` — older
	 *  backends omit it, new accounts via /auth/register hardcode false. */
	isLead?: boolean;
}

export async function register(
	username: string,
	password: string,
	inviteCode?: string,
): Promise<AuthSuccess> {
	const res = await apiFetch("/auth/register", {
		method: "POST",
		body: JSON.stringify({ username, password, inviteCode }),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		if (res.status === 403) {
			throw new InviteRequiredError(body.error ?? "Invite code required");
		}
		throw new Error(body.error ?? "Registration failed");
	}
	const data = (await res.json()) as AuthSuccess;
	_loggedIn = true;
	_isAdmin = data.isAdmin;
	_isLead = data.isLead === true;
	return data;
}

export async function login(username: string, password: string): Promise<AuthSuccess> {
	const res = await apiFetch("/auth/login", {
		method: "POST",
		body: JSON.stringify({ username, password }),
	});
	if (!res.ok) {
		const body = await res.json();
		throw new Error(body.error ?? "Login failed");
	}
	const data = (await res.json()) as AuthSuccess;
	_loggedIn = true;
	_isAdmin = data.isAdmin;
	_isLead = data.isLead === true;
	return data;
}

export async function logout(): Promise<void> {
	// POST is the canonical HTTP verb for state-changing operations.
	// The CSRF guard in production is the CORS + Content-Type preflight,
	// not SameSite — the cookie is SameSite=None there to permit
	// cross-site delivery on the Pages → Tunnel deploy. The endpoint is
	// unauthenticated server-side because we don't want a stale cookie
	// to lock the user out of clearing it; the only consequence of a
	// forced cross-site logout is user inconvenience.
	//
	// Swallow network errors so a logout-while-offline still tears down
	// local state. The server's view becomes consistent on the next
	// /auth/status round-trip after the user comes back online.
	try {
		await apiFetch("/auth/logout", { method: "POST" });
	} catch {
		/* network down — local teardown is what the user actually wants */
	}
	_loggedIn = false;
	_isAdmin = false;
	_isLead = false;
}

// ── Session types ───────────────────────────────────────────────────────────

export interface SessionInfo {
	sessionId: string;
	name: string;
	status: "running" | "stopped" | "terminated" | "failed";
	containerId: string | null;
	containerName: string;
	createdAt: string;
	lastConnectedAt: string | null;
	cols: number;
	rows: number;
	envVars: Record<string, string>;
	// #271 — surfaced to the user so the sidebar can show their own
	// session's caps + live cgroup usage without going through the
	// admin dashboard. `null` cap means the session uses the spawn
	// default; `null` usage means the session isn't running OR the
	// stats fetch failed (status disambiguates).
	cpuLimit: number | null;
	memLimit: number | null;
	usage: {
		cpuPercent: number;
		memBytes: number;
		memLimitBytes: number;
		memPercent: number;
	} | null;
}

// ── Session API ─────────────────────────────────────────────────────────────

/**
 * Typed env-var entry on the wire (#186 / PR 186c). Mirrors the
 * backend `EnvVarEntryInput` discriminated union from
 * `backend/src/sessionConfig.ts`. Both `plain` and `secret` carry
 * plaintext `value`; the backend encrypts secret values before they
 * reach D1, so plaintext is in scope only inside the request handler.
 * `secret-slot` is template-load-only (#195) and rejected at POST.
 */
export type EnvVarEntryInput =
	| { name: string; type: "plain"; value: string }
	| { name: string; type: "secret"; value: string }
	| { name: string; type: "secret-slot" };

/**
 * Typed session configuration sent under POST /sessions `body.config`.
 *
 * Mirrors `SessionConfigSchema` in the backend (`backend/src/sessionConfig.ts`).
 * Every sub-field is optional; today the new-session modal only fills in the
 * `name` (Basics tab) and `envVars` (Env tab) and leaves the rest undefined
 * — children of epic #184 (#188, #190, #191, #194) flesh out their respective
 * fields as they ship. Keep this in sync with the backend Zod schema or the
 * call will 400.
 */
export interface SessionConfigPayload {
	workspaceStrategy?: "preserve" | "clone";
	cpuLimit?: number;
	memLimit?: number;
	idleTtlSeconds?: number;
	postCreateCmd?: string;
	postStartCmd?: string;
	// #188: single-repo today; multi-repo deferred to #197.
	repo?: {
		url: string;
		ref?: string;
		target?: string;
		auth: "none" | "pat" | "ssh";
		depth?: number | null;
	} | null;
	// Credential blob for `repo.auth` ∈ {pat, ssh}. Plaintext on the
	// wire — the backend encrypts before persistence (#188 PR 188b).
	auth?: {
		pat?: string;
		ssh?: { privateKey: string; knownHosts: string };
	};
	// #191 — git identity / dotfiles / agent config seed. All three
	// are independent and skippable; the backend's bootstrap runner
	// walks each stage in declared order and runs only the configured
	// ones. `null` is the wire-shape signal for "explicitly not
	// configured" (treated identically to omission).
	gitIdentity?: { name: string; email: string } | null;
	dotfiles?: {
		url: string;
		ref?: string | null;
		installScript?: string | null;
	} | null;
	agentSeed?: {
		settings?: string | null;
		claudeMd?: string | null;
	} | null;
	// #190 PR 190a — typed `{ container, public }` shape. `protocol` is
	// intentionally absent in v1 (every port goes through the HTTP/WS
	// dispatcher in 190c). 190d wires the form against this type.
	ports?: Array<{ container: number; public: boolean }>;
	// #190 PR 190a — session-level toggle that re-grants
	// CAP_NET_BIND_SERVICE on `docker run` so the in-container process
	// can bind to ports < 1024. Required when any `ports[].container` is
	// privileged (the backend's superRefine rejects the config otherwise).
	allowPrivilegedPorts?: boolean;
	envVars?: EnvVarEntryInput[];
}

// ── Bootstrap live-tail WS (#185 / PR 185b2b) ───────────────────────────────

/** Server → client message shape on `/ws/bootstrap/<sessionId>`. */
export type BootstrapServerMessage =
	| { type: "output"; data: string }
	| { type: "done"; success: true }
	| { type: "fail"; exitCode: number; error?: string; stage?: string }
	| { type: "error"; message: string };

export interface BootstrapHandlers {
	onOutput(chunk: string): void;
	/** `stage` (#252) names the pipeline stage that failed
	 *  (`gitIdentity` / `clone` / `dotfiles` / `agentSeed` /
	 *  `postCreate`) so the UI can render an accurate error.
	 *  Undefined for the synthetic-error path (auth fail before
	 *  any stage runs) or success. */
	onDone(success: boolean, exitCode: number | null, error?: string, stage?: string): void;
}

/**
 * Open the bootstrap live-tail WS for a session. Returns a `close()`
 * thunk so the modal can tear it down on cancel. Auth is via the
 * httpOnly JWT cookie — the browser auto-attaches it on the WS
 * upgrade. The server handles late subscribers by replaying buffered
 * output + the terminal message, so a slow connect doesn't lose log
 * lines.
 *
 * Failure modes:
 *   - WS close before any message: the server dropped us (auth fail,
 *     ownership fail). Surface as a synthetic `fail` so the modal
 *     doesn't sit on a stuck spinner.
 *   - JSON parse error on a frame: log + skip; the next frame can
 *     still recover.
 */
export function openBootstrapWs(
	sessionId: string,
	handlers: BootstrapHandlers,
): { close: () => void } {
	const ws = new WebSocket(`${WS_BASE}/ws/bootstrap/${encodeURIComponent(sessionId)}`);
	let terminal = false;

	ws.addEventListener("message", (e) => {
		let msg: BootstrapServerMessage;
		try {
			msg = JSON.parse(e.data as string) as BootstrapServerMessage;
		} catch {
			console.warn("[bootstrap] dropped malformed frame");
			return;
		}
		if (msg.type === "output") {
			handlers.onOutput(msg.data);
		} else if (msg.type === "done") {
			terminal = true;
			// Server's `done` message has no exitCode field — postCreate
			// exited zero by definition (otherwise we'd be in `fail`).
			// Pass null to match the `exitCode: number | null` type's
			// "not explicitly carried on the wire" semantic, rather than
			// hardcoding 0 which a future caller reading `exitCode` on
			// the success path would mistake for an explicit known
			// value. See #208 round 1 NIT.
			handlers.onDone(true, null);
		} else if (msg.type === "fail") {
			terminal = true;
			handlers.onDone(false, msg.exitCode, msg.error, msg.stage);
		} else if (msg.type === "error") {
			// Server-side auth/path failure — don't get a `fail`
			// message after this, just a close. Hand a synthetic
			// terminal up to the modal so it doesn't hang.
			terminal = true;
			handlers.onDone(false, null, msg.message);
		}
	});

	ws.addEventListener("close", () => {
		if (terminal) return;
		// Server dropped us before sending a terminal. Most likely
		// the session vanished or the broadcaster GC'd the entry.
		// Synthetic fail so the modal can render an error instead
		// of waiting indefinitely.
		handlers.onDone(false, null, "Bootstrap channel closed unexpectedly");
	});

	return {
		close: () => {
			// Mark `terminal` BEFORE the close so the asynchronous
			// `close` event handler's guard short-circuits and we
			// don't synthesize a fake `fail` message for an
			// intentional cancel (PR #208 round 3). Without this the
			// modal would render "Bootstrap channel closed unexpectedly"
			// every time the user closed the new-session modal during
			// a hook, even though they explicitly chose to cancel.
			terminal = true;
			try {
				ws.close(1000, "client cancelled");
			} catch {
				/* already closed */
			}
		},
	};
}

/**
 * Response shape for `POST /sessions`. The optional `bootstrapping`
 * flag is set by the backend when a `postCreateCmd` was configured
 * and the hook is running asynchronously — the modal subscribes to
 * `/ws/bootstrap/<sessionId>` to tail output and waits for the
 * terminal `done` / `fail` message before closing.
 */
export interface CreateSessionResponse extends SessionInfo {
	bootstrapping?: boolean;
}

export async function createSession(
	name: string,
	envVars?: Record<string, string>,
	config?: SessionConfigPayload,
): Promise<CreateSessionResponse> {
	const res = await apiFetch("/sessions", {
		method: "POST",
		body: JSON.stringify({ name, envVars, config }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? "Failed to create session");
	}
	return res.json();
}

// ── Templates (#195) ────────────────────────────────────────────────────────

/**
 * Strip a SessionConfigPayload down to a template-safe shape:
 *   - `secret`-typed envVars collapse to `secret-slot` (no value);
 *   - `auth.pat` is dropped entirely (PAT material must not land in
 *     the unencrypted `templates.config` column);
 *   - `auth.ssh.privateKey` is dropped, but `knownHosts` (public
 *     fingerprints) stays — the recipient re-supplies the key on
 *     `Use template`.
 *
 * Pure function, exported so `main.ts` can call it before the API
 * request and a test can pin the contract. The backend's
 * `assertTemplateConfigShape` is the regression guard if a
 * misbehaving client tries to skip this strip — it 400s a config
 * with live credentials. Same shape the issue spec calls out.
 */
export function stripConfigForTemplate(config: SessionConfigPayload): SessionConfigPayload {
	const out: SessionConfigPayload = { ...config };
	if (config.envVars) {
		out.envVars = config.envVars.map((entry) =>
			entry.type === "secret" ? ({ name: entry.name, type: "secret-slot" } as const) : entry,
		);
	}
	if (config.auth) {
		const stripped: NonNullable<SessionConfigPayload["auth"]> = {};
		// `auth.pat` is the entire PAT credential — drop it. The
		// `repo.auth: "pat"` declaration on `config.repo` stays
		// (preserves intent for the Use-template re-prompt). The
		// schema's `allowMissingAuth: true` flag in 195a tolerates
		// the missing credential.
		if (config.auth.ssh) {
			// SSH: keep knownHosts (public), drop privateKey.
			if (config.auth.ssh.knownHosts) {
				stripped.ssh = { knownHosts: config.auth.ssh.knownHosts } as {
					privateKey: string;
					knownHosts: string;
				};
				// Type cheat: the wire type's `ssh.privateKey` is
				// declared required, but the backend accepts the
				// shape with `privateKey` absent under
				// `allowMissingAuth: true`. The cast keeps us
				// honest about the runtime shape we're sending.
				delete (stripped.ssh as { privateKey?: string }).privateKey;
			}
		}
		// Only attach `auth` if there's anything left after stripping.
		if (Object.keys(stripped).length > 0) {
			out.auth = stripped;
		} else {
			delete out.auth;
		}
	}
	return out;
}

export interface TemplateSummary {
	id: string;
	name: string;
	description: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Template extends TemplateSummary {
	config: SessionConfigPayload;
}

export async function createTemplate(input: {
	name: string;
	description?: string;
	config: SessionConfigPayload;
}): Promise<Template> {
	const res = await apiFetch("/templates", {
		method: "POST",
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string; path?: string };
		throw new Error(body.error ?? `Failed to create template (${res.status})`);
	}
	return res.json();
}

/**
 * Pure helpers for the use-template flow's reverse unit conversion
 * (nano-CPUs → cores, bytes → GiB-or-MiB, seconds → hours-or-minutes).
 * Extracted so the boundary cases the templates-page form pre-fill
 * relies on can be unit-tested directly — `applyTemplateToForm` in
 * `main.ts` is DOM-heavy and not easily exercised in jsdom.
 *
 * Each helper returns either a `{ amount, unit }` pair or `null`
 * when the input is undefined / 0 / negative (the form's "leave
 * the field blank" state). Picks the most natural unit for the
 * common cases — integer GiB / divisible-by-3600 seconds — and
 * falls back to MiB / minutes otherwise.
 */
export function memBytesToFormUnit(bytes: number | undefined): {
	amount: number;
	unit: "GiB" | "MiB";
} | null {
	if (bytes === undefined || bytes <= 0) return null;
	const gib = bytes / 1024 ** 3;
	if (Number.isInteger(gib) && gib >= 1) return { amount: gib, unit: "GiB" };
	return { amount: Math.round(bytes / 1024 ** 2), unit: "MiB" };
}

export function idleSecondsToFormUnit(seconds: number | undefined): {
	amount: number;
	unit: "hours" | "minutes";
} | null {
	if (seconds === undefined || seconds <= 0) return null;
	if (seconds % 3600 === 0) return { amount: seconds / 3600, unit: "hours" };
	return { amount: Math.round(seconds / 60), unit: "minutes" };
}

export async function listTemplates(): Promise<TemplateSummary[]> {
	const res = await apiFetch("/templates");
	if (!res.ok) {
		throw new Error(`Failed to list templates (${res.status})`);
	}
	return res.json();
}

export async function getTemplate(id: string): Promise<Template> {
	const res = await apiFetch(`/templates/${encodeURIComponent(id)}`);
	if (!res.ok) {
		throw new Error(`Failed to load template (${res.status})`);
	}
	return res.json();
}

export async function updateTemplate(
	id: string,
	input: {
		name: string;
		description?: string | null;
		config: SessionConfigPayload;
	},
): Promise<Template> {
	const res = await apiFetch(`/templates/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string; path?: string };
		throw new Error(body.error ?? `Failed to update template (${res.status})`);
	}
	return res.json();
}

export async function deleteTemplate(id: string): Promise<void> {
	const res = await apiFetch(`/templates/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	// 204 is in the 2xx range, so `res.ok` is already true. Earlier
	// shape had a redundant `&& res.status !== 204` clause; dropped
	// per PR #230 round 1 NIT.
	if (!res.ok) {
		throw new Error(`Failed to delete template (${res.status})`);
	}
}

export async function listSessions(includeTerminated = false): Promise<SessionInfo[]> {
	const path = includeTerminated ? "/sessions?all=true" : "/sessions";
	const res = await apiFetch(path);
	if (!res.ok) throw new Error("Failed to list sessions");
	return res.json();
}

export async function getSession(id: string): Promise<SessionInfo> {
	const res = await apiFetch(`/sessions/${id}`);
	if (!res.ok) throw new Error("Session not found");
	return res.json();
}

/** #274 — Read the captured bootstrap output (success or failure) for
 *  a session. `log` is `null` when no bootstrap ever ran (bare-create
 *  with no hooks). Used by the failed-row "View log" action so a user
 *  can debug a postCreate/clone failure after the live modal closes. */
export async function fetchBootstrapLog(id: string): Promise<string | null> {
	const res = await apiFetch(`/sessions/${id}/bootstrap-log`);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? "Failed to load bootstrap log");
	}
	const data = (await res.json()) as { log: string | null };
	return data.log;
}

/** Soft delete stops the container and keeps the workspace; `hard` also wipes files + row. */
export async function deleteSession(id: string, hard = false): Promise<void> {
	const qs = hard ? "?hard=true" : "";
	const res = await apiFetch(`/sessions/${id}${qs}`, { method: "DELETE" });
	// 204 falls inside `res.ok`; the `&& res.status !== 204` clause
	// the previous form had was dead code (mirrors the cleanup in
	// `deleteTemplate` above).
	if (!res.ok) {
		throw new Error("Failed to delete session");
	}
}

export async function stopSession(id: string): Promise<SessionInfo> {
	const res = await apiFetch(`/sessions/${id}/stop`, { method: "POST" });
	if (!res.ok) throw new Error("Failed to stop session");
	return res.json();
}

export async function startSession(id: string): Promise<SessionInfo> {
	const res = await apiFetch(`/sessions/${id}/start`, { method: "POST" });
	if (!res.ok) throw new Error("Failed to start session");
	return res.json();
}

export async function updateEnvVars(
	id: string,
	envVars: Record<string, string>,
): Promise<SessionInfo> {
	const res = await apiFetch(`/sessions/${id}/env`, {
		method: "PATCH",
		body: JSON.stringify({ envVars }),
	});
	if (!res.ok) throw new Error("Failed to update env vars");
	return res.json();
}

// ── Tabs API ────────────────────────────────────────────────────────────────

export interface Tab {
	tabId: string;
	label: string;
	createdAt: number;
}

export async function listTabs(sessionId: string): Promise<Tab[]> {
	const res = await apiFetch(`/sessions/${sessionId}/tabs`);
	if (!res.ok) throw new Error("Failed to list tabs");
	return res.json();
}

export async function createTab(sessionId: string, label?: string): Promise<Tab> {
	// JSON.stringify drops undefined props, so this serialises to `{}` when
	// no label is supplied — backend `req.body ?? {}` handles either form.
	const res = await apiFetch(`/sessions/${sessionId}/tabs`, {
		method: "POST",
		body: JSON.stringify({ label }),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error ?? "Failed to create tab");
	}
	return res.json();
}

/** Throws `TabNotFoundError` (HTTP 404) when the tab is already gone in the backend (e.g. tmux
 *  server died and dropped its sessions); callers should treat this as success and drop the
 *  stale chip from the UI. */
export async function deleteTab(sessionId: string, tabId: string): Promise<void> {
	const res = await apiFetch(`/sessions/${sessionId}/tabs/${tabId}`, { method: "DELETE" });
	if (res.status === 404) {
		throw new TabNotFoundError();
	}
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error ?? "Failed to close tab");
	}
}

export class TabNotFoundError extends Error {
	constructor() {
		super("Tab no longer exists in the session");
		this.name = "TabNotFoundError";
	}
}

// ── Invites API ─────────────────────────────────────────────────────────────

// Codes are hashed at rest (#49). `codeHash` is the public id (used for
// revoke); `codePrefix` is a 4-char display hint so the user can recognise
// their own codes in the list. The plaintext only appears in the
// `MintedInvite` returned by `createInvite()` and is never persisted.
export interface Invite {
	codeHash: string;
	codePrefix: string;
	createdAt: string;
	usedAt: string | null;
	expiresAt: string | null;
}

export interface MintedInvite extends Invite {
	/** Plaintext returned once at creation. Surface to the user immediately —
	 *  it cannot be recovered after this response. */
	code: string;
}

export async function listInvites(): Promise<Invite[]> {
	const res = await apiFetch("/invites");
	if (!res.ok) throw new Error("Failed to list invites");
	return res.json();
}

export async function createInvite(): Promise<MintedInvite> {
	const res = await apiFetch("/invites", { method: "POST" });
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error ?? "Failed to create invite");
	}
	return res.json();
}

export async function revokeInvite(codeHash: string): Promise<void> {
	const res = await apiFetch(`/invites/${encodeURIComponent(codeHash)}`, { method: "DELETE" });
	// 404 means the row is already gone (concurrent revoke from another
	// tab, or the invite was redeemed in the interim). The user-visible
	// outcome — "the code is no longer in the list" — is identical to a
	// 204, so swallow it. Without this, two tabs racing on the same code
	// would show one success and one spurious "not found" toast.
	if (res.status === 404) return;
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error ?? "Failed to revoke invite");
	}
}

// ── Admin (#241) ────────────────────────────────────────────────────────────
//
// Shapes mirror the backend's `routes.ts` admin endpoints. All admin
// surface is gated server-side by `requireAdmin` + `requireAuth`; the
// client just calls and surfaces errors.

export interface AdminStats {
	bootedAt: string;
	uptimeSeconds: number;
	sessions: {
		byStatus: { running: number; stopped: number; terminated: number; failed: number };
	};
	idleSweeper: {
		lastSweepAt: number | null;
		sweptSinceBoot: number;
		currentMapSize: number;
	} | null;
	reconcile: {
		lastRunAt: number | null;
		sessionsCheckedSinceBoot: number;
		errorsSinceBoot: number;
	};
	dispatcher: {
		requestsSinceBoot: number;
		responses2xxSinceBoot: number;
		responses3xxSinceBoot: number;
		responses4xxSinceBoot: number;
		responses5xxSinceBoot: number;
	};
	d1: { callsSinceBoot: number };
	// #270: aggregate live CPU/RAM across running sessions + the bounds
	// the "Edit caps" form needs to know about. `limits` carries the
	// per-session min/max/default the backend will validate against, so
	// the form's `min`/`max`/`step` attributes match the server cap and
	// stay in sync with `MAX_SESSION_CPU` / `MAX_SESSION_MEM`.
	resources: {
		runningCount: number;
		statsAvailable: number;
		totalCpuPercent: number;
		totalMemBytes: number;
		totalCpuLimitNanos: number;
		totalMemLimitBytes: number;
		limits: {
			minCpuNanos: number;
			maxCpuNanos: number;
			minMemBytes: number;
			maxMemBytes: number;
			defaultCpuNanos: number;
			defaultMemBytes: number;
		};
	};
}

/** Admin-visible session row — extends `SessionInfo` with the
 *  cross-user identifiers the dashboard needs to attribute and
 *  act on each row. */
export interface AdminSession extends SessionInfo {
	userId: string;
	ownerUsername: string;
	// #270: per-row caps + live usage. cpuLimit/memLimit `null` means
	// "no explicit cap was set — the session is running with the spawn
	// default" (which the resources.limits block exposes for display).
	cpuLimit: number | null;
	memLimit: number | null;
	usage: {
		cpuPercent: number;
		memBytes: number;
		memLimitBytes: number;
		memPercent: number;
	} | null;
}

export async function fetchAdminStats(): Promise<AdminStats> {
	const res = await apiFetch("/admin/stats");
	if (!res.ok) throw new Error(`Failed to load admin stats (${res.status})`);
	return res.json();
}

export async function fetchAdminSessions(): Promise<AdminSession[]> {
	const res = await apiFetch("/admin/sessions");
	if (!res.ok) throw new Error(`Failed to load admin sessions (${res.status})`);
	return res.json();
}

export async function adminForceStop(sessionId: string): Promise<void> {
	const res = await apiFetch(`/admin/sessions/${encodeURIComponent(sessionId)}/stop`, {
		method: "POST",
	});
	if (res.status === 404) return; // race: session removed between list + action
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to force-stop session (${res.status})`);
	}
}

export async function adminForceDelete(sessionId: string, hard: boolean): Promise<void> {
	const path = hard
		? `/admin/sessions/${encodeURIComponent(sessionId)}?hard=true`
		: `/admin/sessions/${encodeURIComponent(sessionId)}`;
	const res = await apiFetch(path, { method: "DELETE" });
	if (res.status === 404) return;
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to force-delete session (${res.status})`);
	}
}

/** Live-edit CPU / RAM caps on a session via #270. Backend persists
 *  the new values AND (when the session is running) calls
 *  `docker update` to push them to cgroup. 409 → cgroup rejected the
 *  memory drop because current usage exceeds the new cap; the caller
 *  should surface a "free memory first" toast. */
export async function adminUpdateResources(
	sessionId: string,
	caps: { cpuLimit?: number; memLimit?: number },
): Promise<void> {
	const res = await apiFetch(`/admin/sessions/${encodeURIComponent(sessionId)}/resources`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(caps),
	});
	if (res.ok) return;
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	// Throw a typed-enough error so the caller can distinguish 409
	// (user-fixable: free memory) from a plain 500. The error message
	// in the 409 branch comes verbatim from the backend.
	const err = new Error(body.error ?? `Failed to update caps (${res.status})`) as Error & {
		status?: number;
	};
	err.status = res.status;
	throw err;
}

// ── Admin groups CRUD (#201e-2) ─────────────────────────────────────────────
//
// Wire-shape mirrors of the backend `Group` / `GroupSummary` /
// `GroupMember` types from `backend/src/groups.ts`. All endpoints
// here are admin-gated server-side; calling them as a non-admin
// returns 403.

export interface AdminGroupSummary {
	id: string;
	name: string;
	description: string | null;
	leadUserId: string;
	leadUsername: string;
	memberCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface AdminGroupMember {
	userId: string;
	username: string;
	addedAt: string;
}

export interface AdminGroupDetail {
	id: string;
	name: string;
	description: string | null;
	leadUserId: string;
	createdAt: string;
	updatedAt: string;
	members: AdminGroupMember[];
}

export interface AdminGroupInput {
	name: string;
	description?: string | null;
	leadUserId: string;
}

export async function fetchAdminGroups(): Promise<AdminGroupSummary[]> {
	const res = await apiFetch("/admin/groups");
	if (!res.ok) throw new Error(`Failed to load groups (${res.status})`);
	return res.json();
}

export async function fetchAdminGroup(id: string): Promise<AdminGroupDetail> {
	const res = await apiFetch(`/admin/groups/${encodeURIComponent(id)}`);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to load group (${res.status})`);
	}
	return res.json();
}

export async function createAdminGroup(input: AdminGroupInput): Promise<AdminGroupSummary> {
	const res = await apiFetch("/admin/groups", {
		method: "POST",
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to create group (${res.status})`);
	}
	return res.json();
}

export async function updateAdminGroup(
	id: string,
	input: AdminGroupInput,
): Promise<AdminGroupSummary> {
	const res = await apiFetch(`/admin/groups/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to update group (${res.status})`);
	}
	return res.json();
}

export async function deleteAdminGroup(id: string): Promise<void> {
	const res = await apiFetch(`/admin/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (res.status === 404) return; // race: deleted between list + action
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to delete group (${res.status})`);
	}
}

export async function addAdminGroupMember(groupId: string, userId: string): Promise<void> {
	const res = await apiFetch(`/admin/groups/${encodeURIComponent(groupId)}/members`, {
		method: "POST",
		body: JSON.stringify({ userId }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to add member (${res.status})`);
	}
}

export async function removeAdminGroupMember(groupId: string, userId: string): Promise<void> {
	const res = await apiFetch(
		`/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
		{ method: "DELETE" },
	);
	if (res.status === 404) return; // race: removed between list + action
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to remove member (${res.status})`);
	}
}

// ── Observe-log (#201e-2) ──────────────────────────────────────────────────
//
// Owner / lead / admin can read a session's observe history;
// admin only can read the cross-user log. Wire-shape mirrors of
// the backend `ObserveLogEntry` / `AdminObserveLogEntry` types
// from `backend/src/observeLog.ts`.

export interface ObserveLogEntry {
	id: string;
	observerUserId: string;
	observerUsername: string;
	sessionId: string;
	ownerUserId: string;
	startedAt: string;
	endedAt: string | null;
}

export interface AdminObserveLogEntry extends ObserveLogEntry {
	ownerUsername: string;
}

/** Per-session observe history. Gated by `assertCanObserve`
 *  server-side — owner / admin / lead-of-group-containing-owner
 *  can read; everyone else gets 403. */
export async function fetchSessionObserveLog(sessionId: string): Promise<ObserveLogEntry[]> {
	const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/observe-log`);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `Failed to load observe log (${res.status})`);
	}
	return res.json();
}

/** Cross-user observe log for the admin dashboard. Hard-capped at
 *  500 entries newest-first server-side; older entries are silently
 *  dropped if the deployment ever hits the cap. */
export async function fetchAdminObserveLog(): Promise<AdminObserveLogEntry[]> {
	const res = await apiFetch("/admin/observe-log");
	if (!res.ok) throw new Error(`Failed to load admin observe log (${res.status})`);
	return res.json();
}

// ── Groups (#201e — lead-side reads) ────────────────────────────────────────
//
// Wire-shape mirrors of the backend `LeadGroup` and `ObservableSessionMeta`
// types from `backend/src/groups.ts`. Date columns arrive as ISO strings
// (the route serializer calls `.toISOString()`); the UI parses with
// `new Date(...)` only when a Date object is needed.

export interface LeadGroupMember {
	userId: string;
	username: string;
	addedAt: string;
}

export interface LeadGroup {
	id: string;
	name: string;
	description: string | null;
	leadUserId: string;
	createdAt: string;
	updatedAt: string;
	members: LeadGroupMember[];
}

/**
 * Cross-user session shape returned by `/api/groups/mine/sessions`.
 * Mirrors `serializeObservableSession` on the backend — note it does
 * NOT include `envVars` (the lead's observability surface is
 * intentionally narrower than admin's). Adds `ownerUserId` /
 * `ownerUsername` so the UI can render "alice's session" without a
 * second lookup.
 */
export interface ObservableSession {
	sessionId: string;
	ownerUserId: string;
	ownerUsername: string;
	name: string;
	status: "running" | "stopped" | "terminated" | "failed";
	containerId: string | null;
	containerName: string;
	cols: number;
	rows: number;
	createdAt: string;
	lastConnectedAt: string | null;
}

/** Fetch every group the current user leads, with each group's full
 *  member list inlined. Returns `[]` for a non-lead caller (the
 *  backend SQL is the user-scoping; no auth gate beyond requireAuth). */
export async function fetchMyGroups(): Promise<LeadGroup[]> {
	const res = await apiFetch("/groups/mine");
	if (!res.ok) throw new Error(`Failed to load groups (${res.status})`);
	return res.json();
}

/** Fetch every observable session — sessions of any user in any
 *  group the caller leads, newest-first. Excludes terminated.
 *  Returns `[]` for a non-lead caller. */
export async function fetchMyObservableSessions(): Promise<ObservableSession[]> {
	const res = await apiFetch("/groups/mine/sessions");
	if (!res.ok) throw new Error(`Failed to load observable sessions (${res.status})`);
	return res.json();
}

// ── File uploads ────────────────────────────────────────────────────────────

/**
 * Upload one or more files to a session. The backend writes them
 * under `~/uploads/` (in-container path, sibling of the workspace —
 * #188 PR 188a moved it out of the workspace tree so a clone at the
 * workspace root has a clean target) and returns the in-container
 * paths the user can pass to Claude CLI.
 */
export async function uploadSessionFiles(
	sessionId: string,
	files: File[],
): Promise<{ paths: string[] }> {
	const fd = new FormData();
	for (const f of files) fd.append("files", f, f.name);
	const res = await apiFetch(`/sessions/${sessionId}/files`, {
		method: "POST",
		body: fd,
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error ?? `Upload failed (${res.status})`);
	}
	return res.json() as Promise<{ paths: string[] }>;
}

// ── Fetch wrapper ───────────────────────────────────────────────────────────

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
	// FormData carries its own multipart boundary — letting us set
	// Content-Type would clobber that and the server would fail to
	// parse the upload. Skip the JSON default in that case.
	const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
	const headers: Record<string, string> = {
		...(isFormData ? {} : { "Content-Type": "application/json" }),
		...((init?.headers as Record<string, string>) ?? {}),
	};
	// Captured before the fetch so a concurrent flip of `_loggedIn`
	// between here and the response doesn't change how we classify the
	// 401 below. `sentAuth` is "we believed we were logged in when this
	// request started"; only those 401s are treated as "session expired".
	// A 401 from /auth/login on bad credentials, with `_loggedIn === false`
	// before the call, must NOT trigger the SESSION_EXPIRED_EVENT.
	const sentAuth = _loggedIn;
	// `credentials: "include"` is mandatory for cookie-based auth across
	// origins (frontend on Pages, backend on Tunnel). Without it the
	// browser silently drops the auth cookie.
	const res = await fetch(`${API_BASE}${path}`, {
		...init,
		headers,
		credentials: "include",
	});

	// Centralised stale-cookie handling (#95). Without this, the 15 s
	// session poll toasts an error every 15 s forever once the JWT
	// expires, because nothing else flips `_loggedIn` on 401.
	//
	// - sentAuth distinguishes authed 401s from unauthed ones like a
	//   wrong-password /auth/login on a logged-out session — we mustn't
	//   pretend a session existed when one didn't.
	// - 401 is specifically "session stale"; 403 is policy and must not
	//   trigger a logout.
	// - `_loggedIn` check dedups concurrent 401 bursts (session poll +
	//   a user-triggered call racing): the first one through flips it
	//   false and the rest see false, so the event fires exactly once.
	if (sentAuth && res.status === 401 && _loggedIn) {
		_loggedIn = false;
		_isAdmin = false;
		_isLead = false;
		window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
	}

	return res;
}
