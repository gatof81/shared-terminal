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

// ── Auth API ────────────────────────────────────────────────────────────────

export async function checkAuthStatus(): Promise<{ needsSetup: boolean }> {
        const res = await apiFetch("/auth/status");
        return res.json();
}

export async function register(username: string, password: string): Promise<{ userId: string; token: string }> {
        const res = await apiFetch("/auth/register", {
                method: "POST",
                body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
                const body = await res.json();
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
        const res = await apiFetch(`/sessions/${sessionId}/tabs`, {
                method: "POST",
                body: JSON.stringify(label ? { label } : {}),
        });
        if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? "Failed to create tab");
        }
        return res.json();
}

/** Throws `LastTabError` (HTTP 409) when the tab is the last one — callers should surface, not retry. */
export async function deleteTab(sessionId: string, tabId: string): Promise<void> {
        const res = await apiFetch(`/sessions/${sessionId}/tabs/${tabId}`, { method: "DELETE" });
        if (res.status === 409) {
                throw new LastTabError();
        }
        if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? "Failed to close tab");
        }
}

export class LastTabError extends Error {
        constructor() {
                super("Can't close the last tab of a session");
                this.name = "LastTabError";
        }
}

// ── Fetch wrapper ───────────────────────────────────────────────────────────

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
        const headers: Record<string, string> = {
                "Content-Type": "application/json",
                ...(init?.headers as Record<string, string> ?? {}),
        };
        if (_token) {
                headers["Authorization"] = `Bearer ${_token}`;
        }
        return fetch(`${API_BASE}${path}`, { ...init, headers });
}
