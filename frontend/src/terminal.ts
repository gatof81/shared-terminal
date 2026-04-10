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
        // Do NOT pass a subprotocol string here: the browser requires the server
        // to echo back a matching Sec-WebSocket-Protocol header or it closes the
        // connection immediately. Our server doesn't negotiate subprotocols.
        const ws = new WebSocket(wsUrl);

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
 * Build the WebSocket URL for a session.
 *
 * In development (Vite dev server on :5173) we connect directly to the
 * backend on :3001, bypassing the Vite HMR proxy which can intercept WS
 * upgrade events before the /ws proxy rule fires.
 *
 * In production the frontend is served from the same origin as the backend
 * so we use a relative ws:// URL (same host, same port).
 *
 * Override with VITE_WS_BASE env var for custom deployments:
 *   VITE_WS_BASE=wss://api.example.com npm run build
 */
function buildWsUrl(sessionId: string): string {
        const userId = sessionStorage.getItem("userId") ?? "anonymous";
        const params = `?userId=${encodeURIComponent(userId)}`;

        // Allow explicit override via env var (set in .env or CI).
        const envBase = (import.meta as { env?: Record<string, string> }).env?.VITE_WS_BASE;
        if (envBase) {
                return `${envBase}/ws/sessions/${sessionId}${params}`;
        }

        // In Vite dev mode the page is on :5173 but the backend WS is on :3001.
        // Connect directly to avoid Vite HMR proxy interference.
        if (window.location.port === "5173") {
                const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
                return `${proto}//localhost:3001/ws/sessions/${sessionId}${params}`;
        }

        // Production: same host/port as the page.
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${window.location.host}/ws/sessions/${sessionId}${params}`;
}
