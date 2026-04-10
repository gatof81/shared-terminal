import * as pty from "node-pty";
import { RingBuffer } from "./ringBuffer.js";
import { SessionManager } from "./sessionManager.js";

/**
 * PtyManager — owns all live IPty instances.
 *
 * Responsibilities:
 *   - Spawn and kill PTY processes.
 *   - Bridge PTY output to registered listeners (active WebSocket connections).
 *   - Maintain a per-session RingBuffer for reconnect replay.
 *   - Forward resize events to the PTY.
 *   - Clean up terminated or idle sessions.
 *
 * Design note: a PTY can outlive any individual WebSocket connection, which is
 * what makes reconnection possible. Listeners are added/removed on connect/
 * disconnect without affecting the underlying process.
 */

type OutputListener = (data: string) => void;

interface PtyEntry {
        pty: pty.IPty;
        buffer: RingBuffer;
        listeners: Set<OutputListener>;
        /** Timer handle for idle cleanup (set when last listener disconnects). */
        idleTimer: ReturnType<typeof setTimeout> | null;
}

/** How long (ms) to keep an orphaned PTY alive after the last client leaves. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class PtyManager {
        private readonly entries = new Map<string, PtyEntry>();

        constructor(private readonly sessions: SessionManager) { }

        // ── Lifecycle ────────────────────────────────────────────────────────────────

        spawn(sessionId: string): void {
                if (this.entries.has(sessionId)) return; // already running

                const meta = this.sessions.get(sessionId);
                if (!meta) throw new Error(`Session ${sessionId} not found`);

                const proc = pty.spawn(meta.shell, [], {
                        name: "xterm-256color",
                        cols: meta.cols,
                        rows: meta.rows,
                        cwd: meta.cwd,
                        env: process.env as Record<string, string>,
                });

                this.sessions.setPid(sessionId, proc.pid);

                const entry: PtyEntry = {
                        pty: proc,
                        buffer: new RingBuffer(),
                        listeners: new Set(),
                        idleTimer: null,
                };

                proc.onData((data) => {
                        entry.buffer.push(data);
                        for (const fn of entry.listeners) fn(data);
                });

                proc.onExit(({ exitCode }) => {
                        console.log(`[pty] session ${sessionId} exited with code ${exitCode}`);
                        this.sessions.updateStatus(sessionId, "terminated");
                        this.entries.delete(sessionId);
                });

                this.entries.set(sessionId, entry);
        }

        kill(sessionId: string): void {
                const entry = this.entries.get(sessionId);
                if (!entry) return;

                this._clearIdle(entry);
                try {
                        entry.pty.kill();
                } catch {
                        // process may already be gone
                }
                this.entries.delete(sessionId);
        }

        // ── Listener management ──────────────────────────────────────────────────────

        /**
         * Attach a listener and immediately replay buffered output so the
         * reconnecting client catches up without the PTY needing to re-emit.
         */
        attach(sessionId: string, listener: OutputListener): string {
                const entry = this.entries.get(sessionId);
                if (!entry) throw new Error(`No live PTY for session ${sessionId}`);

                // Cancel any pending idle cleanup.
                this._clearIdle(entry);

                // Replay buffered output first, then start live streaming.
                const replay = entry.buffer.drain();
                entry.listeners.add(listener);
                return replay;
        }

        detach(sessionId: string, listener: OutputListener): void {
                const entry = this.entries.get(sessionId);
                if (!entry) return;

                entry.listeners.delete(listener);

                // Start the idle timer once no clients are connected.
                if (entry.listeners.size === 0) {
                        this._clearIdle(entry);
                        entry.idleTimer = setTimeout(() => {
                                console.log(`[pty] idle timeout for session ${sessionId} — killing PTY`);
                                this.kill(sessionId);
                                this.sessions.updateStatus(sessionId, "terminated");
                        }, IDLE_TIMEOUT_MS);
                }
        }

        // ── Input / resize ───────────────────────────────────────────────────────────

        write(sessionId: string, data: string): void {
                this.entries.get(sessionId)?.pty.write(data);
        }

        resize(sessionId: string, cols: number, rows: number): void {
                const entry = this.entries.get(sessionId);
                if (!entry) return;
                entry.pty.resize(cols, rows);
                this.sessions.updateDimensions(sessionId, cols, rows);
        }

        // ── Helpers ──────────────────────────────────────────────────────────────────

        isAlive(sessionId: string): boolean {
                return this.entries.has(sessionId);
        }

        private _clearIdle(entry: PtyEntry): void {
                if (entry.idleTimer !== null) {
                        clearTimeout(entry.idleTimer);
                        entry.idleTimer = null;
                }
        }
}
