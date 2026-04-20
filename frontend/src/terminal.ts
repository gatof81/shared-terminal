/**
 * terminal.ts — xterm.js wrapper with WebSocket bridge to Docker exec.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "./api.js";

export type SessionStatus = "running" | "stopped" | "terminated" | "disconnected";

export interface TerminalSession {
        dispose(): void;
}

export type StatusCallback = (status: SessionStatus) => void;
export type ErrorCallback = (message: string) => void;

export function openTerminalSession(opts: {
        container: HTMLElement;
        sessionId: string;
        onStatus: StatusCallback;
        onError: ErrorCallback;
}): TerminalSession {
        const { container, sessionId, onStatus, onError } = opts;

        // ── xterm.js setup ──────────────────────────────────────────────────────
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
        // URLs in terminal output become clickable — opens in a new tab, which
        // matters for OAuth flows (e.g. `claude` login) where the container
        // can't open a browser itself.
        term.loadAddon(
                new WebLinksAddon((event, uri) => {
                        event.preventDefault();
                        window.open(uri, "_blank", "noopener,noreferrer");
                }),
        );
        term.open(container);
        fitAddon.fit();

        // ── WebSocket connection ────────────────────────────────────────────────
        // Prefer passing the JWT as a subprotocol (`auth.bearer.<jwt>`) so the
        // token stays out of the URL, access logs, browser history and Referer
        // headers. Some proxies/tunnels silently strip `Sec-WebSocket-Protocol`
        // though, so we also include the token as a `?token=` query param as a
        // fallback — the backend accepts either.
        const token = getToken() ?? "";
        const wsUrl = buildWsUrl(sessionId, token);
        const ws = new WebSocket(wsUrl, [`auth.bearer.${token}`]);

        ws.onopen = () => {
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

        // ── Input: xterm → WS ──────────────────────────────────────────────────
        const inputDisposable = term.onData((data) => {
                send({ type: "input", data });
        });

        // ── Resize ──────────────────────────────────────────────────────────────
        const ro = new ResizeObserver(() => {
                fitAddon.fit();
                send({ type: "resize", cols: term.cols, rows: term.rows });
        });
        ro.observe(container);

        // ── Heartbeat ───────────────────────────────────────────────────────────
        let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
        function startHeartbeat() {
                heartbeatInterval = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) send({ type: "ping" });
                }, 30_000);
        }

        // ── Helpers ─────────────────────────────────────────────────────────────
        function send(msg: object) {
                if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(msg));
                }
        }

        // ── Dispose ─────────────────────────────────────────────────────────────
        function dispose() {
                if (heartbeatInterval !== null) clearInterval(heartbeatInterval);
                ro.disconnect();
                inputDisposable.dispose();
                ws.close(1000, "User navigated away");
                term.dispose();
        }

        return { dispose };
}

// ── URL builder ─────────────────────────────────────────────────────────────

function buildWsUrl(sessionId: string, token: string): string {
        // Use VITE_API_URL to derive the WebSocket URL
        const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
        const url = new URL(apiUrl);
        const wsProto = url.protocol === "https:" ? "wss:" : "ws:";
        const base = `${wsProto}//${url.host}/ws/sessions/${sessionId}`;
        return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
