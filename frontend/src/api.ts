/**
 * api.ts — REST client for the shared-terminal backend.
 */

const API_BASE = import.meta.env.DEV ? "http://localhost:3001/api" : "/api";

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

export async function listSessions(): Promise<SessionInfo[]> {
        const res = await apiFetch("/sessions");
        if (!res.ok) throw new Error("Failed to list sessions");
        return res.json();
}

export async function getSession(id: string): Promise<SessionInfo> {
        const res = await apiFetch(`/sessions/${id}`);
        if (!res.ok) throw new Error("Session not found");
        return res.json();
}

export async function deleteSession(id: string): Promise<void> {
        const res = await apiFetch(`/sessions/${id}`, { method: "DELETE" });
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
