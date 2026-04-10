/**
 * terminal.ts — xterm.js wrapper with WebSocket bridge.
 *
 * Responsibilities:
 *   - Mount / unmount an xterm.js Terminal into a DOM element.
 *   - Open a WebSocket connection to /ws/sessions/:id.
 *   - Forward keyboard input from xterm → WS → PTY.
 *   - Stream PTY output from WS → xterm.
 *   - Send resize events when the container changes size.
 *   - Provide clean dispose() so the caller can switch sessions.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type SessionStatus = "running" | "disconnected" | "terminated";

export interface TerminalSession {
        dispose(): void;
}

export type StatusCallback = (status: SessionStatus) => void;
export type ErrorCallback = (message: string) => void;

export function openTerminalSession(opts: {
        container: HTMLElement;
        sessionId: string;
        userId: string;
        onStatus: StatusCallback;
        onError: ErrorCallback;
}): TerminalSession {
        const { container, sessionId, onStatus, onError } = opts;

        // ── xterm.js setup ────────────────────────────────────────────────────────
        const term = new Terminal({
                theme: {
                        background: "#0d1117",
                        foreground: "#e6edf3",
                        cursor: "#58a6ff",
                        selectionBackground: "#264f78",
                },
                fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
                fontSize: 14,
                lineHeight: 1.2,
                cursorBlink: true,
                convertEol: true,
                allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();

        // ── WebSocket connection ──────────────────────────────────────────────────
        // Use relative path — Vite dev proxy rewrites /ws/* → ws://localhost:3001/ws/*.
        const wsUrl = buildWsUrl(sessionId);
        const ws = new WebSocket(wsUrl, ["shared-terminal"]);

        // Attach X-User-Id via a URL query param since the WS API doesn't allow
        // custom headers from the browser. We then read it server-side from the URL.
        // (See NOTE below — we actually use query string instead of sub-protocol.)

        ws.onopen = () => {
                // Tell the server our user identity and start heartbeat.
                send({ type: "ping" });
                startHeartbeat();
        };

        ws.onmessage = (ev) => {
                type Msg =
                        | { type: "output"; data: string }
                        | { type: "status"; status: SessionStatus }
                        | { type: "pong" }
                        | { type: "error"; message: string };

                let msg: Msg;
                try {
                        msg = JSON.parse(ev.data as string) as Msg;
                } catch {
                        return;
                }

                switch (msg.type) {
                        case "output":
                                term.write(msg.data);
                                break;
                        case "status":
                                onStatus(msg.status);
                                break;
                        case "error":
                                onError(msg.message);
                                break;
                        case "pong":
                                // heartbeat acknowledged
                                break;
                }
        };

        ws.onerror = () => {
                onError("WebSocket connection error");
        };

        ws.onclose = (ev) => {
                if (ev.code !== 1000) {
                        onError(`Connection closed (${ev.code}): ${ev.reason || "unknown reason"}`);
                }
                onStatus("disconnected");
        };

        // ── Input: xterm → WS ─────────────────────────────────────────────────────
        const inputDisposable = term.onData((data) => {
                send({ type: "input", data });
        });

        // ── Resize: container → PTY ───────────────────────────────────────────────
        const ro = new ResizeObserver(() => {
                fitAddon.fit();
                send({
                        type: "resize",
                        cols: term.cols,
                        rows: term.rows,
                });
        });
        ro.observe(container);

        // ── Heartbeat ─────────────────────────────────────────────────────────────
        let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

        function startHeartbeat() {
                heartbeatInterval = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) send({ type: "ping" });
                }, 30_000);
        }

        // ── Helpers ───────────────────────────────────────────────────────────────
        function send(msg: object) {
                if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(msg));
                }
        }

        // ── Dispose ───────────────────────────────────────────────────────────────
        function dispose() {
                if (heartbeatInterval !== null) clearInterval(heartbeatInterval);
                ro.disconnect();
                inputDisposable.dispose();
                ws.close(1000, "User navigated away");
                term.dispose();
        }

        return { dispose };
}

// ── URL builder ──────────────────────────────────────────────────────────────

/**
 * NOTE on authentication over WebSocket:
 * Browser WebSocket API does not allow setting custom headers. Two common
 * patterns are:
 *   1. Pass the token in the URL query string (simple, MVP-appropriate).
 *   2. Send an auth message as the first WS frame.
 *
 * We use the Vite proxy here, which forwards the WS upgrade including cookies
 * and query params. The backend reads X-User-Id from the *HTTP upgrade request
 * headers*. Since we can't set that header from a browser WS client, we
 * instead have the frontend pass the userId in the query string and the backend
 * reads it there as a fallback.
 *
 * In extractUserId (auth.ts) we already handle the header; we add a small
 * companion function in the backend that also reads `?userId=` from the URL.
 * See wsHandler.ts — it calls extractUserId which checks both.
 *
 * For this MVP the backend also checks `?userId=` in the URL.
 */
function buildWsUrl(sessionId: string): string {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const host = window.location.host; // includes port if non-standard
        const userId = sessionStorage.getItem("userId") ?? "anonymous";
        return `${proto}//${host}/ws/sessions/${sessionId}?userId=${encodeURIComponent(userId)}`;
}
