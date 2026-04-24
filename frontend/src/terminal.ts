/**
 * terminal.ts — xterm.js wrapper with WebSocket bridge to Docker exec.
 */

import { Terminal, ILink, ILinkProvider, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "./api.js";

export type SessionStatus = "running" | "stopped" | "terminated" | "disconnected";

export interface TerminalSession {
        dispose(): void;
        setFontSize(px: number): void;
}

export type StatusCallback = (status: SessionStatus) => void;
export type ErrorCallback = (message: string) => void;

export function openTerminalSession(opts: {
        container: HTMLElement;
        sessionId: string;
        tabId?: string;
        fontSize?: number;
        onStatus: StatusCallback;
        onError: ErrorCallback;
}): TerminalSession {
        const { container, sessionId, tabId, fontSize, onStatus, onError } = opts;

        // ── xterm.js setup ──────────────────────────────────────────────────────
        const term = new Terminal({
                theme: {
                        background: "#0d1117",
                        foreground: "#e6edf3",
                        cursor: "#58a6ff",
                        selectionBackground: "#264f78",
                },
                fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", "Monaco", "Courier New", monospace',
                fontSize: fontSize ?? 14,
                lineHeight: 1.2,
                cursorBlink: true,
                cursorInactiveStyle: "outline",
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
                scrollback: 5000,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);

        // Touch-action none so the OS doesn't eat vertical drags as page-scroll
        // — our touch handler below routes them into terminal scroll instead.
        container.style.touchAction = "none";

        // ── WebGL renderer ──────────────────────────────────────────────────────
        // WebGL avoids the DOM renderer's visibility-loss glitches (rows written
        // while a tab is hidden drop out of the paint). Activate after open so
        // the canvas exists. If the GPU driver revokes the context we dispose
        // the addon and xterm silently falls back to the DOM renderer.
        let webgl: WebglAddon | null = null;
        try {
                webgl = new WebglAddon();
                webgl.onContextLoss(() => {
                        webgl?.dispose();
                        webgl = null;
                });
                term.loadAddon(webgl);
        } catch (err) {
                console.warn("[terminal] WebGL renderer unavailable, falling back to DOM:", err);
                webgl = null;
        }

        // webglcontextlost bubbles; webglcontextrestored does not — listen on the
        // canvas obtained from the loss event's target.
        let pendingRestoreCanvas: HTMLCanvasElement | null = null;
        const onContextRestored = () => {
                // Guard against misbehaving drivers; by spec webgl is always null here.
                if (webgl) return;
                pendingRestoreCanvas = null;
                let restoredAddon: WebglAddon | undefined;
                try {
                        const addon = new WebglAddon();
                        restoredAddon = addon;
                        addon.onContextLoss(() => { addon.dispose(); webgl = null; });
                        term.loadAddon(addon);
                        webgl = addon;
                        console.debug("[terminal] WebGL context restored, re-enabled GPU renderer");
                } catch (err) {
                        restoredAddon?.dispose();
                        console.warn("[terminal] WebGL restore failed:", err);
                }
        };
        const onContextLost = (ev: Event) => {
                if (!(ev.target instanceof HTMLCanvasElement)) return;
                pendingRestoreCanvas?.removeEventListener("webglcontextrestored", onContextRestored);
                pendingRestoreCanvas = ev.target;
                pendingRestoreCanvas.addEventListener("webglcontextrestored", onContextRestored, { once: true });
        };
        if (webgl) container.addEventListener("webglcontextlost", onContextLost);

        fitAddon.fit();

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

        // Mouse clicks should focus xterm immediately. Touch taps are handled
        // in onTouchEnd below — we wait until touchend to distinguish a tap
        // from a scroll gesture so a swipe doesn't pop the keyboard mid-drag.
        const focusOnPointer = (ev: PointerEvent) => {
                if (ev.pointerType !== "touch") term.focus();
        };
        container.addEventListener("pointerdown", focusOnPointer);

        // ── WebSocket connection ────────────────────────────────────────────────
        // Prefer passing the JWT as a subprotocol (`auth.bearer.<jwt>`) so the
        // token stays out of the URL, access logs, browser history and Referer
        // headers. Some proxies/tunnels silently strip `Sec-WebSocket-Protocol`
        // though, so we also include the token as a `?token=` query param as a
        // fallback — the backend accepts either.
        const token = getToken() ?? "";
        const wsUrl = buildWsUrl(sessionId, token, tabId);
        const ws = new WebSocket(wsUrl, [`auth.bearer.${token}`]);
        let disposed = false;

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
                if (disposed) return;
                onError("WebSocket connection error");
        };

        ws.onclose = (ev) => {
                // disposed: stale async close from a prior navigate-away — ignore
                if (disposed) return;
                if (ev.code !== 1000) {
                        onError(`Connection closed (${ev.code}): ${ev.reason || "unknown reason"}`);
                }
                onStatus("disconnected");
        };

        // ── Input: xterm → WS ──────────────────────────────────────────────────
        const inputDisposable = term.onData((data) => {
                send({ type: "input", data });
        });

        // ── Touch scroll ────────────────────────────────────────────────────────
        // On mobile there are no wheel events, and `mouse on` in tmux means
        // finger drags aren't forwarded as anything useful. We translate the
        // drag into terminal scroll:
        //
        //  - Main buffer (shell prompt, command output): scroll xterm's own
        //    scrollback with `scrollLines`. Users expect to pull older lines
        //    back into view; we don't involve tmux at all, so there's no weird
        //    copy-mode dance.
        //  - Alt buffer (vim, less, Claude Code, htop, …): synthesise
        //    up/down arrow keys. Every TUI app responds to arrows, so the
        //    user can navigate without needing mouse-wheel support in the app
        //    or tmux copy-mode.
        //
        // Direction follows iOS/Android convention — content tracks the
        // finger: drag up → view moves up → scroll toward newer (bottom).
        let lastTouchY: number | null = null;
        let touchIsScroll = false; // true once the gesture has moved ≥1 cell
        const getCellHeight = () => (term.rows > 0 ? container.clientHeight / term.rows : 20);

        const onTouchStart = (ev: TouchEvent) => {
                if (ev.touches.length !== 1) { lastTouchY = null; touchIsScroll = false; return; }
                lastTouchY = ev.touches[0]!.clientY;
                touchIsScroll = false;
        };
        const onTouchMove = (ev: TouchEvent) => {
                if (lastTouchY === null || ev.touches.length !== 1) return;
                const y = ev.touches[0]!.clientY;
                const cellH = getCellHeight();
                const deltaPx = lastTouchY - y;
                const lines = Math.trunc(deltaPx / cellH);

                // Once the gesture is classified as a scroll, keep suppressing
                // xterm's drag-selection handler on every subsequent frame —
                // including sub-cell frames where lines === 0. Without this,
                // slow swipes leave an unguarded window at the start.
                if (touchIsScroll) ev.preventDefault();
                if (lines === 0) return;

                touchIsScroll = true;
                // Prevent xterm from treating the drag as a text-selection gesture
                // (touch-action:none is set in CSS, so this won't cause a passive
                // event listener warning).
                ev.preventDefault();

                if (term.buffer.active.type === "alternate") {
                        // Cap the burst so a fast flick doesn't fire 100+ arrows
                        // at the app in one frame.
                        const n = Math.min(Math.abs(lines), 20);
                        const key = lines > 0 ? "\x1b[B" : "\x1b[A";
                        send({ type: "input", data: key.repeat(n) });
                } else {
                        term.scrollLines(lines);
                }
                lastTouchY -= lines * cellH;
        };
        const onTouchEnd = () => {
                // If the finger never moved a full cell it was a tap: focus xterm
                // so the OS keyboard appears for typing. Scroll gestures skip this
                // so the keyboard doesn't flash open mid-swipe.
                // Guard on lastTouchY !== null: a multi-touch start (pinch) clears
                // lastTouchY and resets touchIsScroll, so when one finger lifts we
                // must not treat it as a tap and pop the keyboard.
                if (!touchIsScroll && lastTouchY !== null) term.focus();
                lastTouchY = null;
                touchIsScroll = false;
        };
        const onTouchCancel = () => { lastTouchY = null; touchIsScroll = false; };

        container.addEventListener("touchstart", onTouchStart, { passive: true });
        // passive:false required so ev.preventDefault() can stop xterm's drag-selection
        container.addEventListener("touchmove", onTouchMove, { passive: false });
        container.addEventListener("touchend", onTouchEnd, { passive: true });
        container.addEventListener("touchcancel", onTouchCancel, { passive: true });

        // ── Resize ──────────────────────────────────────────────────────────────
        // ResizeObserver fires continuously during mobile viewport churn (URL
        // bar show/hide, soft-keyboard open/close, rotation) and desktop
        // window drags. Coalescing to one fit per frame avoids overlapping
        // tmux redraws that leave half-painted cells on screen.
        //
        // LOCAL fit runs every animation frame so the visible terminal
        // tracks the container smoothly (xterm handles the cell math client
        // side). The REMOTE resize notification is trailing-debounced on a
        // short idle window, because every `{type:"resize"}` WS message
        // triggers a synchronous chain on the backend:
        //
        //   wsHandler → DockerManager.resize → recomputeSize →
        //   exec.resize → tmux resize-window → pane repaint fan-out.
        //
        // A sustained window-edge drag on a 1080p display can cross cell
        // boundaries ~50× per second; forwarding every crossing lets the
        // Docker exec API queue up dozens of resizes that tmux processes
        // after the fact, producing a cascade of repaints that each get
        // invalidated by the next one. Debouncing collapses a drag into a
        // single backend resize at the settled size.
        //
        // 100 ms is enough to absorb the noisy tail of a mouse-drag or
        // soft-keyboard slide but short enough to feel "instant" when the
        // user stops adjusting.
        const RESIZE_DEBOUNCE_MS = 100;
        let lastSentCols = term.cols;
        let lastSentRows = term.rows;
        let fitScheduled = false;
        let resizeSendTimer: ReturnType<typeof setTimeout> | null = null;
        const sendResizeDebounced = () => {
                if (resizeSendTimer !== null) clearTimeout(resizeSendTimer);
                resizeSendTimer = setTimeout(() => {
                        resizeSendTimer = null;
                        // Skip if disposed between schedule and fire — the socket is
                        // already being torn down by the parent component.
                        if (disposed) return;
                        // Re-check dimensions at fire time; they may have bounced back
                        // to the last-sent size during the debounce window (e.g. user
                        // overshoots a drag and returns). No point spending a round
                        // trip for a no-op.
                        if (term.cols === lastSentCols && term.rows === lastSentRows) return;
                        lastSentCols = term.cols;
                        lastSentRows = term.rows;
                        send({ type: "resize", cols: term.cols, rows: term.rows });
                }, RESIZE_DEBOUNCE_MS);
        };
        const scheduleFit = () => {
                if (fitScheduled) return;
                fitScheduled = true;
                requestAnimationFrame(() => {
                        fitScheduled = false;
                        try { fitAddon.fit(); } catch { /* container detached mid-resize */ }
                        if (term.cols !== lastSentCols || term.rows !== lastSentRows) {
                                sendResizeDebounced();
                        }
                });
        };
        const ro = new ResizeObserver(scheduleFit);
        ro.observe(container);

        // ── Visibility / focus refresh ──────────────────────────────────────────
        // Backgrounded tabs get rAF throttled, so xterm's renderer stops
        // flushing dirty cells while the user is away. Output still streams
        // in and lands in the internal buffer, but the painted DOM/canvas
        // can end up several screens stale by the time the tab returns.
        //
        // On return, re-fit (viewport may have resized while hidden), wipe
        // the WebGL texture atlas (fonts render sharp again after DPR change
        // or OS font-smoothing toggles), and force a full refresh so every
        // row repaints.
        const onVisibilityChange = () => {
                if (document.hidden) return;
                scheduleFit();
                try {
                        webgl?.clearTextureAtlas();
                } catch {
                        webgl?.dispose();
                        webgl = null;
                }
                term.refresh(0, term.rows - 1);
        };
        const onWindowFocus = () => {
                scheduleFit();
                term.refresh(0, term.rows - 1);
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("focus", onWindowFocus);

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

        function setFontSize(px: number) {
                term.options.fontSize = px;
                scheduleFit();
        }

        // ── Dispose ─────────────────────────────────────────────────────────────
        function dispose() {
                disposed = true;
                if (heartbeatInterval !== null) clearInterval(heartbeatInterval);
                // The resize send is debounced on a trailing 100 ms window; if the
                // user navigates away inside that window the timer would fire after
                // the socket closes. The `if (disposed) return` guard at the top of
                // the callback already makes this harmless today — but it leaves
                // the pending timer holding a closure reference to the (disposed)
                // xterm + ws for up to 100 ms, and any future logic added to the
                // callback ahead of that guard would run post-dispose. Cancelling
                // here matches the heartbeatInterval path and removes the subtle
                // refactor trap.
                if (resizeSendTimer !== null) clearTimeout(resizeSendTimer);
                ro.disconnect();
                document.removeEventListener("visibilitychange", onVisibilityChange);
                window.removeEventListener("focus", onWindowFocus);
                container.removeEventListener("pointerdown", focusOnPointer);
                container.removeEventListener("touchstart", onTouchStart);
                container.removeEventListener("touchmove", onTouchMove);
                container.removeEventListener("touchend", onTouchEnd);
                container.removeEventListener("touchcancel", onTouchCancel);
                inputDisposable.dispose();
                linkProviderDisposable.dispose();
                pendingRestoreCanvas?.removeEventListener("webglcontextrestored", onContextRestored);
                container.removeEventListener("webglcontextlost", onContextLost);
                webgl?.dispose();
                ws.close(1000, "User navigated away");
                term.dispose();
        }

        return { dispose, setFontSize };
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
                // (─-╿ — covers │ ─ ╭ ╮ etc. that ink/React TUIs draw
                // around their panels). This lets us treat a row's URL "zone" as
                // the contiguous run of URL-safe chars between the left and right
                // borders/padding of the row.
                const NON_URL = /[\s<>"'`{}()[\]─-╿|]/;
                const URL_RE = /https?:\/\/[^\s<>"'`{}()[\]─-╿|]+/g;

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

function buildWsUrl(sessionId: string, token: string, tabId?: string): string {
        // Use VITE_API_URL to derive the WebSocket URL
        const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
        const url = new URL(apiUrl);
        const wsProto = url.protocol === "https:" ? "wss:" : "ws:";
        const base = `${wsProto}//${url.host}/ws/sessions/${sessionId}`;
        const params = new URLSearchParams();
        if (token) params.set("token", token);
        // tabId is server-issued and re-validated on the backend before any
        // `tmux attach -t` — see backend/src/wsHandler.ts (rawTab regex
        // /^[a-zA-Z0-9._-]{1,64}$/). Excluding `:` is the load-bearing part:
        // tmux target syntax needs a colon to parse `session:window.pane`, so
        // `.` alone can't escalate a tabId into a different tmux target.
        if (tabId) params.set("tab", tabId);
        const qs = params.toString();
        return qs ? `${base}?${qs}` : base;
}
