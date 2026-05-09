/**
 * api.ts — REST client for the shared-terminal backend.
 */

// VITE_API_URL should point to the backend (via Cloudflare Tunnel or localhost)
// e.g. https://api.terminal.yourdomain.com
const BACKEND_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_BASE = `${BACKEND_URL}/api`;

// ── Auth state (#18, #50) ───────────────────────────────────────────────────
//
// The JWT lives in an httpOnly cookie that JS cannot read. The booleans below
// are an in-memory mirror so the UI can route (login vs app, hide vs show
// admin features) without a round-trip per navigation. Hydrated on boot from
// /auth/status, updated on login/register/logout/401.

let _loggedIn = false;
let _isAdmin = false;

export function isLoggedIn(): boolean {
	return _loggedIn;
}

/** True iff `users.is_admin = 1` for the current session (#50). Gates
 *  invite-mint UI in main.ts. Refreshes on every /auth/status call so a
 *  promotion / demotion takes effect on the next reload. */
export function isAdmin(): boolean {
	return _isAdmin;
}

/** Fired by `apiFetch` once per 401-burst after flipping `_loggedIn` to false —
 * main.ts listens to perform UI teardown. See apiFetch for the emit guard. */
export const SESSION_EXPIRED_EVENT = "st:session-expired";

// ── Auth API ────────────────────────────────────────────────────────────────

export interface AuthStatus {
	needsSetup: boolean;
	authenticated: boolean;
	isAdmin: boolean;
}

export async function checkAuthStatus(): Promise<AuthStatus> {
	const res = await apiFetch("/auth/status");
	const data = (await res.json()) as AuthStatus;
	// The server is the source of truth for cookie presence + admin
	// status. Mirror both so isLoggedIn() / isAdmin() can answer
	// instantly thereafter.
	_loggedIn = data.authenticated;
	_isAdmin = data.isAdmin;
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
}

// ── Session API ─────────────────────────────────────────────────────────────

/**
 * Typed session configuration sent under POST /sessions `body.config`.
 *
 * Mirrors `SessionConfigSchema` in the backend (`backend/src/sessionConfig.ts`).
 * Every sub-field is optional; today the new-session modal only fills in the
 * `name` (Basics tab) and leaves `config` undefined — children of epic #184
 * (#186, #188, #190, #191, #194) flesh out their respective fields as they
 * ship. Keep this in sync with the backend Zod schema or the call will 400.
 */
export interface SessionConfigPayload {
	workspaceStrategy?: "preserve" | "clone";
	cpuLimit?: number;
	memLimit?: number;
	idleTtlSeconds?: number;
	postCreateCmd?: string;
	postStartCmd?: string;
	repos?: Array<{ url: string; ref?: string }>;
	ports?: Array<{ port: number; protocol?: "http" | "tcp" }>;
	envVars?: Record<string, string>;
}

/**
 * Thrown when the create succeeded up to the point of running the
 * `postCreate` hook (#185), but the hook itself exited non-zero. The
 * server has already killed the container and flipped the session
 * status to `failed`; the row stays so the user can read the captured
 * output (carried on this error). The new-session modal surfaces
 * `bootstrapOutput` inline so the user sees what their hook printed
 * before it died.
 */
export class BootstrapFailedError extends Error {
	readonly sessionId: string;
	readonly exitCode: number;
	readonly output: string;

	constructor(sessionId: string, exitCode: number, output: string, message: string) {
		super(message);
		this.name = "BootstrapFailedError";
		this.sessionId = sessionId;
		this.exitCode = exitCode;
		this.output = output;
	}
}

export async function createSession(
	name: string,
	envVars?: Record<string, string>,
	config?: SessionConfigPayload,
): Promise<SessionInfo> {
	const res = await apiFetch("/sessions", {
		method: "POST",
		body: JSON.stringify({ name, envVars, config }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as {
			error?: string;
			sessionId?: string;
			bootstrapOutput?: string;
			bootstrapExitCode?: number;
		};
		// Distinguish hook-failed from generic create errors so the modal
		// can surface the captured output instead of just a one-liner.
		// The 500 carries `bootstrapOutput` only when the hook actually
		// ran; a missing field means a different failure shape (D1
		// transient, docker spawn EACCES, etc.) and the generic Error
		// path is right.
		if (body.bootstrapOutput !== undefined && body.sessionId !== undefined) {
			throw new BootstrapFailedError(
				body.sessionId,
				body.bootstrapExitCode ?? -1,
				body.bootstrapOutput,
				body.error ?? "postCreate hook failed",
			);
		}
		throw new Error(body.error ?? "Failed to create session");
	}
	return res.json();
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

/** Soft delete stops the container and keeps the workspace; `hard` also wipes files + row. */
export async function deleteSession(id: string, hard = false): Promise<void> {
	const qs = hard ? "?hard=true" : "";
	const res = await apiFetch(`/sessions/${id}${qs}`, { method: "DELETE" });
	if (!res.ok && res.status !== 204) {
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

// ── File uploads ────────────────────────────────────────────────────────────

/**
 * Upload one or more files to a session's workspace. The backend writes
 * them under `<workspace>/uploads/` and returns the in-container paths
 * the user can pass to Claude CLI.
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
		window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
	}

	return res;
}
