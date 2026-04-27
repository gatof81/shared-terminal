/**
 * api.ts — REST client for the shared-terminal backend.
 */

// VITE_API_URL should point to the backend (via Cloudflare Tunnel or localhost)
// e.g. https://api.terminal.yourdomain.com
const BACKEND_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_BASE = `${BACKEND_URL}/api`;

// ── Token management ────────────────────────────────────────────────────────

let _token: string | null = localStorage.getItem("st_token");

export function getToken(): string | null { return _token; }

export function setToken(token: string | null): void {
        _token = token;
        if (token) {
                localStorage.setItem("st_token", token);
        } else {
                localStorage.removeItem("st_token");
        }
}

export function isLoggedIn(): boolean { return !!_token; }

/** Fired by `apiFetch` once per 401-burst after clearing the stale token —
 * main.ts listens to perform UI teardown. See apiFetch for the emit guard. */
export const SESSION_EXPIRED_EVENT = "st:session-expired";

// ── Auth API ────────────────────────────────────────────────────────────────

export async function checkAuthStatus(): Promise<{ needsSetup: boolean }> {
        const res = await apiFetch("/auth/status");
        return res.json();
}

export class InviteRequiredError extends Error {
        constructor(message: string) {
                super(message);
                this.name = "InviteRequiredError";
        }
}

export async function register(
        username: string,
        password: string,
        inviteCode?: string,
): Promise<{ userId: string; token: string }> {
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
        const data = await res.json();
        setToken(data.token);
        return data;
}

export async function login(username: string, password: string): Promise<{ userId: string; token: string }> {
        const res = await apiFetch("/auth/login", {
                method: "POST",
                body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
                const body = await res.json();
                throw new Error(body.error ?? "Login failed");
        }
        const data = await res.json();
        setToken(data.token);
        return data;
}

export function logout(): void {
        setToken(null);
}

// ── Session types ───────────────────────────────────────────────────────────

export interface SessionInfo {
        sessionId: string;
        name: string;
        status: "running" | "stopped" | "terminated";
        containerId: string | null;
        containerName: string;
        createdAt: string;
        lastConnectedAt: string | null;
        cols: number;
        rows: number;
        envVars: Record<string, string>;
}

// ── Session API ─────────────────────────────────────────────────────────────

export async function createSession(
        name: string,
        envVars?: Record<string, string>,
): Promise<SessionInfo> {
        const res = await apiFetch("/sessions", {
                method: "POST",
                body: JSON.stringify({ name, envVars }),
        });
        if (!res.ok) {
                const body = await res.json();
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

export async function updateEnvVars(id: string, envVars: Record<string, string>): Promise<SessionInfo> {
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

export interface Invite {
        code: string;
        createdAt: string;
        usedAt: string | null;
        expiresAt: string | null;
}

export async function listInvites(): Promise<Invite[]> {
        const res = await apiFetch("/invites");
        if (!res.ok) throw new Error("Failed to list invites");
        return res.json();
}

export async function createInvite(): Promise<Invite> {
        const res = await apiFetch("/invites", { method: "POST" });
        if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? "Failed to create invite");
        }
        return res.json();
}

export async function revokeInvite(code: string): Promise<void> {
        const res = await apiFetch(`/invites/${encodeURIComponent(code)}`, { method: "DELETE" });
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
                ...(init?.headers as Record<string, string> ?? {}),
        };
        // Captured before the fetch so a concurrent setToken(null) between
        // here and the response doesn't change how we classify the 401 below.
        // `sentAuth` pins "this request carried an Authorization header" —
        // only authed 401s are treated as "token is stale"; an unauthed 401
        // (e.g. wrong password on /auth/login) must not clear token state.
        const sentAuth = !!_token;
        if (_token) {
                headers["Authorization"] = `Bearer ${_token}`;
        }
        const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

        // Centralised stale-token handling (#95). Without this, the 15 s
        // session poll toasts an error every 15 s forever once the JWT
        // expires, because nothing else clears _token on 401.
        //
        // - sentAuth (captured pre-fetch) distinguishes authed 401s from
        //   unauthed ones like a wrong-password /auth/login on a session
        //   that already has a token — we mustn't clear auth state on that.
        // - 401 is specifically "token stale"; 403 is policy and must not
        //   trigger a logout.
        // - _token !== null dedups concurrent 401 bursts (session poll +
        //   a user-triggered call racing): the first setToken(null) through
        //   silences the rest so the event fires exactly once per burst.
        if (sentAuth && res.status === 401 && _token !== null) {
                setToken(null);
                window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
        }

        return res;
}
