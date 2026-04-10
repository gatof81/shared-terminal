/**
 * api.ts — REST client for the shared-terminal backend.
 *
 * All requests attach the X-User-Id header automatically.
 * The Vite dev proxy forwards /api/* to http://localhost:3001.
 */

export interface SessionInfo {
        sessionId: string;
        name: string;
        status: "running" | "disconnected" | "terminated";
        createdAt: string;
        lastConnectedAt: string | null;
        cols: number;
        rows: number;
        pid: number | null;
        shell: string;
        cwd: string;
}

export class ApiClient {
        constructor(private readonly userId: string) { }

        async listSessions(): Promise<SessionInfo[]> {
                const res = await this.fetch("GET", "/api/sessions");
                return res.json();
        }

        async createSession(opts: {
                name: string;
                cols?: number;
                rows?: number;
        }): Promise<SessionInfo> {
                const res = await this.fetch("POST", "/api/sessions", opts);
                if (!res.ok) {
                        const body = await res.json().catch(() => ({}));
                        throw new Error((body as { error?: string }).error ?? "Failed to create session");
                }
                return res.json();
        }

        async terminateSession(sessionId: string): Promise<void> {
                await this.fetch("DELETE", `/api/sessions/${sessionId}`);
        }

        // ── Internal ─────────────────────────────────────────────────────────────

        private fetch(method: string, path: string, body?: unknown): Promise<Response> {
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
