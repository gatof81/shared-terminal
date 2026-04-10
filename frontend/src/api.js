/**
 * api.ts — REST client for the shared-terminal backend.
 *
 * All requests attach the X-User-Id header automatically.
 * The Vite dev proxy forwards /api/* to http://localhost:3001.
 */
export class ApiClient {
    constructor(userId) {
        Object.defineProperty(this, "userId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: userId
        });
    }
    async listSessions() {
        const res = await this.fetch("GET", "/api/sessions");
        return res.json();
    }
    async createSession(opts) {
        const res = await this.fetch("POST", "/api/sessions", opts);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error ?? "Failed to create session");
        }
        return res.json();
    }
    async terminateSession(sessionId) {
        await this.fetch("DELETE", `/api/sessions/${sessionId}`);
    }
    // ── Internal ─────────────────────────────────────────────────────────────
    fetch(method, path, body) {
        return fetch(path, {
            method,
            headers: {
                "Content-Type": "application/json",
                "X-User-Id": this.userId,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    }
}
