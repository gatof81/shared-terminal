/**
 * terminal.ts — xterm.js wrapper with WebSocket bridge to Docker exec.
 */

import { Terminal, ILink, ILinkProvider, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
                // Apps like Claude Code emit OSC 8 hyperlink escapes. xterm renders
                // them (underline + pointer cursor) but needs an explicit handler
                // to actually open them on click.
                linkHandler: {
                        activate(event, uri) {
                                event.preventDefault();
                                window.open(uri, "_blank", "noopener,noreferrer");
                        },
                        allowNonHttpProtocols: false,
                },
                // Auto-copy selected text to the clipboard — avoids the xterm quirk
                // where Cmd-C doesn't copy unless a custom key handler intercepts.
                // Works on secure contexts (https + localhost).
                scrollback: 5000,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();
        // Suppress the browser context menu over the terminal so tmux mouse
        // mode (enabled in session-image/tmux.conf) actually receives the
        // right-click as an SGR mouse event instead of the OS menu eating it.
        const suppressContextMenu = (e: Event) => e.preventDefault();
        container.addEventListener("contextmenu", suppressContextMenu);
        // Cmd/Ctrl + C copies the current xterm selection to the clipboard.
        // Without this, Cmd-C falls through to the terminal (Claude Code
        // intercepts it as SIGINT) and nothing gets copied.
        term.attachCustomKeyEventHandler((ev) => {
                if (
                        ev.type === "keydown" &&
                        (ev.metaKey || ev.ctrlKey) &&
                        !ev.altKey &&
                        !ev.shiftKey &&
                        ev.key.toLowerCase() === "c"
                ) {
                        const sel = term.getSelection();
                        if (sel) {
                                navigator.clipboard.writeText(sel).catch(() => { });
                                return false;
                        }
                }
                return true;
        });
        // Fallback for plain-text URLs (without OSC 8). Custom provider so URLs
        // that soft-wrap across rows are still recognised as ONE link — hover
        // underlines the full URL and clicking anywhere on it opens the
        // complete URL. No-op when the app already emits OSC 8 (xterm's native
        // hyperlink handling takes precedence per-cell).
        const linkProviderDisposable = term.registerLinkProvider(
                new MultilineUrlLinkProvider(term),
        );

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
                container.removeEventListener("contextmenu", suppressContextMenu);
                inputDisposable.dispose();
                linkProviderDisposable.dispose();
                ws.close(1000, "User navigated away");
                term.dispose();
        }

        return { dispose };
}

// ── Multiline URL link provider ─────────────────────────────────────────────
// xterm's built-in WebLinksAddon only matches URLs within a single row. OAuth
// URLs (like Claude's login link) commonly soft-wrap across 3–4 rows, so the
// addon only recognises the first row. This provider walks the buffer,
// reassembles soft-wrapped rows back into logical lines, finds URLs, and
// returns ILink entries whose `range` spans every row the URL actually
// occupies — hover underlines the full URL and clicking anywhere on any row
// opens the complete URL.
//
// xterm re-invokes `provideLinks` for each row the user hovers. We rebuild a
// cache of detected URLs whenever the buffer changes (onWriteParsed) rather
// than on every hover.

interface CachedLink {
        url: string;
        // 1-based buffer coordinates (xterm's ILink range convention)
        startX: number;
        startY: number;
        endX: number;
        endY: number;
}

class MultilineUrlLinkProvider implements ILinkProvider {
        private cache: CachedLink[] = [];
        private dirty = true;
        private onWrite: IDisposable;

        constructor(private term: Terminal) {
                this.onWrite = term.onWriteParsed(() => {
                        this.dirty = true;
                });
        }

        provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
                if (this.dirty) this.rebuild();
                const y = bufferLineNumber;
                const links: ILink[] = [];
                for (const c of this.cache) {
                        if (c.startY <= y && c.endY >= y) {
                                // Return the FULL multi-row range, not a per-row slice. xterm
                                // iterates start.y → end.y internally when drawing the hover
                                // underline, so one link with the full span lights up every
                                // row the URL occupies. Returning per-row slices here is what
                                // caused "hover only underlines the first line" — each slice
                                // was a distinct link confined to its own row.
                                links.push({
                                        range: {
                                                start: { x: c.startX, y: c.startY },
                                                end: { x: c.endX, y: c.endY },
                                        },
                                        text: c.url,
                                        decorations: { underline: true, pointerCursor: true },
                                        activate: (event, text) => {
                                                event.preventDefault();
                                                window.open(text, "_blank", "noopener,noreferrer");
                                        },
                                });
                        }
                }
                callback(links.length ? links : undefined);
        }


        dispose(): void {
                this.onWrite.dispose();
        }

        private rebuild(): void {
                this.cache = [];
                const buf = this.term.buffer.active;

                // "Terminators" that can't appear inside a URL. Includes whitespace,
                // common quote/bracket chars, and the Unicode Box Drawing block
                // (\u2500-\u257F — covers │ ─ ╭ ╮ etc. that ink/React TUIs draw
                // around their panels). This lets us treat a row's URL "zone" as
                // the contiguous run of URL-safe chars between the left and right
                // borders/padding of the row.
                const NON_URL = /[\s<>"'`{}()[\]\u2500-\u257F|]/;
                const URL_RE = /https?:\/\/[^\s<>"'`{}()[\]\u2500-\u257F|]+/g;

                // Phase 1 — for every row in the buffer, strip leading/trailing
                // non-URL chars (borders, padding) and record where the interior
                // URL zone starts and ends. Inner whitespace in the zone is kept
                // (the URL regex will terminate at it).
                interface Row {
                        content: string;  // interior zone, inclusive of both ends
                        startCol: number; // 0-based col in the row where `content` begins
                        endCol: number;   // 0-based col where `content` ends (inclusive)
                }
                const rows: Row[] = [];
                for (let r = 0; r < buf.length; r++) {
                        const line = buf.getLine(r);
                        const raw = line?.translateToString(false) ?? "";
                        let first = 0;
                        let last = raw.length - 1;
                        while (first <= last && NON_URL.test(raw[first])) first++;
                        while (last >= first && NON_URL.test(raw[last])) last--;
                        if (first > last) {
                                rows.push({ content: "", startCol: -1, endCol: -1 });
                        } else {
                                rows.push({ content: raw.slice(first, last + 1), startCol: first, endCol: last });
                        }
                }

                // Phase 2 — find URL starts and follow them across row boundaries
                // when the URL clearly continues. A "continuation" row is one
                // whose entire interior zone is a single whitespace-free run
                // (i.e. all URL-safe chars). Any whitespace anywhere in the next
                // row's zone means the URL has ended.
                for (let r = 0; r < rows.length; r++) {
                        const row = rows[r];
                        if (row.startCol < 0) continue;
                        for (const m of row.content.matchAll(URL_RE)) {
                                if (m.index === undefined) continue;
                                let url = m[0];
                                const matchStartInZone = m.index;
                                const matchEndInZone = matchStartInZone + url.length; // exclusive
                                let endRow = r;
                                let endColInRow = row.startCol + matchEndInZone - 1;

                                // Only try to extend if the URL reaches the very end of the
                                // row's interior — otherwise the URL already terminated with
                                // whitespace or punctuation on this same row.
                                if (matchEndInZone === row.content.length) {
                                        for (let next = r + 1; next < rows.length; next++) {
                                                const nr = rows[next];
                                                if (nr.startCol < 0) break; // empty row ends the URL
                                                if (/\s/.test(nr.content)) break; // sentence text, not URL
                                                url += nr.content;
                                                endRow = next;
                                                endColInRow = nr.endCol;
                                        }
                                }

                                // Strip trailing sentence punctuation that's usually not URL.
                                const trailingPunct = url.match(/[.,;:!?)]+$/)?.[0] ?? "";
                                if (trailingPunct) {
                                        url = url.slice(0, -trailingPunct.length);
                                        endColInRow -= trailingPunct.length;
                                }
                                if (!url) continue;

                                this.cache.push({
                                        url,
                                        // +1 because xterm's IBufferRange is 1-based in both x and y.
                                        startX: row.startCol + matchStartInZone + 1,
                                        startY: r + 1,
                                        endX: endColInRow + 1,
                                        endY: endRow + 1,
                                });
                        }
                }

                this.dirty = false;
        }


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
