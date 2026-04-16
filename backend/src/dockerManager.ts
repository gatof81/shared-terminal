/**
 * dockerManager.ts — Docker container & exec lifecycle.
 *
 * Replaces the old PtyManager.  Each session is a Docker container running
 * tmux.  When a user connects via WebSocket we `docker exec … tmux attach`
 * to get a live TTY stream.
 *
 * Key concepts:
 *   Container  — long-lived, one per session, runs tmux in the background.
 *   ExecSession — short-lived, one per WebSocket connection.  Created on
 *                 attach, destroyed on detach.  Multiple users could attach
 *                 to the same container simultaneously (shared terminal).
 */

import Dockerode from "dockerode";
import { Duplex } from "stream";
import { SessionManager } from "./sessionManager.js";
import { RingBuffer } from "./ringBuffer.js";

const SESSION_IMAGE = process.env.SESSION_IMAGE ?? "shared-terminal-session";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";

export interface ExecHandle {
        execId: string;
        stream: Duplex;
        resize(cols: number, rows: number): Promise<void>;
        destroy(): void;
}

export type OutputListener = (data: string) => void;

export class DockerManager {
        private docker: Dockerode;
        private sessions: SessionManager;
        /** Ring buffers keyed by sessionId for reconnect replay. */
        private buffers = new Map<string, RingBuffer>();
        /** Active listeners per session (fan-out to all attached WebSockets). */
        private listeners = new Map<string, Set<OutputListener>>();
        /** Active exec handles keyed by a unique attach id. */
        private execs = new Map<string, ExecHandle>();

        constructor(sessions: SessionManager, dockerOpts?: Dockerode.DockerOptions) {
                this.docker = new Dockerode(dockerOpts ?? { socketPath: "/var/run/docker.sock" });
                this.sessions = sessions;
        }

        // ── Container lifecycle ─────────────────────────────────────────────────

        /**
         * Create & start a Docker container for the given session.
         * Returns the Docker container ID.
         */
        async spawn(sessionId: string): Promise<string> {
                const meta = this.sessions.getOrThrow(sessionId);

                // Build env array from session env vars
                const envArray = Object.entries(meta.envVars).map(([k, v]) => `${k}=${v}`);

                const container = await this.docker.createContainer({
                        Image: SESSION_IMAGE,
                        name: meta.containerName,
                        Hostname: meta.name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 63),
                        Env: [
                                `SESSION_ID=${sessionId}`,
                                `SESSION_NAME=${meta.name}`,
                                `TERM=xterm-256color`,
                                ...envArray,
                        ],
                        HostConfig: {
                                Binds: [
                                        `${WORKSPACE_ROOT}/${sessionId}:/home/developer/workspace`,
                                ],
                                // Resource limits (adjust as needed)
                                Memory: 2 * 1024 * 1024 * 1024, // 2 GB
                                NanoCpus: 2_000_000_000,         // 2 CPUs
                                RestartPolicy: { Name: "unless-stopped" },
                        },
                        OpenStdin: true,
                        Tty: true,
                });

                await container.start();

                const containerId = container.id;
                this.sessions.setContainerId(sessionId, containerId);
                this.buffers.set(sessionId, new RingBuffer(128 * 1024)); // 128 KB

                console.log(`[docker] spawned container ${meta.containerName} (${containerId.slice(0, 12)}) for session ${sessionId}`);
                return containerId;
        }

        /**
         * Stop & remove the container for a session.
         */
        async kill(sessionId: string): Promise<void> {
                const meta = this.sessions.get(sessionId);
                if (!meta?.containerId) return;

                try {
                        const container = this.docker.getContainer(meta.containerId);
                        try { await container.stop({ t: 5 }); } catch { /* already stopped */ }
                        try { await container.remove({ force: true }); } catch { /* already removed */ }
                } catch (err) {
                        console.error(`[docker] error killing container for session ${sessionId}:`, (err as Error).message);
                }

                // Clean up active execs
                for (const [key, handle] of this.execs) {
                        if (key.startsWith(sessionId)) {
                                handle.destroy();
                                this.execs.delete(key);
                        }
                }

                this.buffers.delete(sessionId);
                this.listeners.delete(sessionId);

                console.log(`[docker] killed container for session ${sessionId}`);
        }

        /**
         * Check whether the session's container is running.
         */
        async isAlive(sessionId: string): Promise<boolean> {
                const meta = this.sessions.get(sessionId);
                if (!meta?.containerId) return false;
                try {
                        const info = await this.docker.getContainer(meta.containerId).inspect();
                        return info.State.Running === true;
                } catch {
                        return false;
                }
        }

        /**
         * Start a stopped container.
         */
        async startContainer(sessionId: string): Promise<void> {
                const meta = this.sessions.getOrThrow(sessionId);
                if (!meta.containerId) throw new Error("No container ID for this session");
                const container = this.docker.getContainer(meta.containerId);
                await container.start();
                this.sessions.updateStatus(sessionId, "running");
                console.log(`[docker] restarted container for session ${sessionId}`);
        }

        /**
         * Stop a running container without removing it.
         */
        async stopContainer(sessionId: string): Promise<void> {
                const meta = this.sessions.getOrThrow(sessionId);
                if (!meta.containerId) return;
                try {
                        await this.docker.getContainer(meta.containerId).stop({ t: 5 });
                } catch { /* already stopped */ }
                this.sessions.updateStatus(sessionId, "stopped");
                console.log(`[docker] stopped container for session ${sessionId}`);
        }

        // ── Exec attach (for WebSocket connections) ─────────────────────────────

        /**
         * Attach to the session's tmux via docker exec.
         * Returns an ExecHandle for writing input, resizing, and cleanup.
         * Also replays the ring buffer and starts fan-out to the listener.
         */
        async attach(
                sessionId: string,
                attachId: string,
                cols: number,
                rows: number,
                onOutput: OutputListener,
        ): Promise<{ handle: ExecHandle; replay: string | null }> {
                const meta = this.sessions.getOrThrow(sessionId);
                if (!meta.containerId) throw new Error("No container for this session");

                const container = this.docker.getContainer(meta.containerId);

                // Create an exec that attaches to the tmux session
                const exec = await container.exec({
                        Cmd: ["tmux", "attach", "-t", "main"],
                        AttachStdin: true,
                        AttachStdout: true,
                        AttachStderr: true,
                        Tty: true,
                        Env: [`COLUMNS=${cols}`, `LINES=${rows}`],
                });

                const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

                // Resize to match the client's terminal size
                try {
                        await exec.resize({ h: rows, w: cols });
                } catch { /* some versions don't support resize immediately */ }

                // Fan-out output to the listener and ring buffer
                const buffer = this.getOrCreateBuffer(sessionId);

                stream.on("data", (chunk: Buffer) => {
                        const data = chunk.toString("utf-8");
                        buffer.push(data);
                        // Fan-out to all attached listeners
                        const ls = this.listeners.get(sessionId);
                        if (ls) {
                                for (const l of ls) {
                                        try { l(data); } catch { /* listener error */ }
                                }
                        }
                });

                // Register the listener
                if (!this.listeners.has(sessionId)) {
                        this.listeners.set(sessionId, new Set());
                }
                this.listeners.get(sessionId)!.add(onOutput);

                // Build the exec handle
                const handle: ExecHandle = {
                        execId: attachId,
                        stream,
                        resize: async (c: number, r: number) => {
                                try {
                                        await exec.resize({ h: r, w: c });
                                } catch { /* ignore resize errors */ }
                        },
                        destroy: () => {
                                stream.destroy();
                                this.listeners.get(sessionId)?.delete(onOutput);
                                this.execs.delete(attachId);
                        },
                };

                this.execs.set(attachId, handle);

                // Get replay from ring buffer
                const replay = buffer.drain();

                this.sessions.updateConnected(sessionId);
                console.log(`[docker] attached exec ${attachId} to session ${sessionId}`);

                return { handle, replay };
        }

        /**
         * Write data to an exec's stdin.
         */
        write(attachId: string, data: string): void {
                const handle = this.execs.get(attachId);
                if (handle && !handle.stream.destroyed) {
                        handle.stream.write(data);
                }
        }

        /**
         * Resize an exec's TTY.
         */
        async resize(attachId: string, cols: number, rows: number): Promise<void> {
                const handle = this.execs.get(attachId);
                if (handle) {
                        await handle.resize(cols, rows);
                }
        }

        /**
         * Detach an exec (called on WebSocket close).
         */
        detach(attachId: string): void {
                const handle = this.execs.get(attachId);
                if (handle) {
                        handle.destroy();
                        console.log(`[docker] detached exec ${attachId}`);
                }
        }

        // ── Helpers ─────────────────────────────────────────────────────────────

        private getOrCreateBuffer(sessionId: string): RingBuffer {
                let buf = this.buffers.get(sessionId);
                if (!buf) {
                        buf = new RingBuffer(128 * 1024);
                        this.buffers.set(sessionId, buf);
                }
                return buf;
        }

        /**
         * On server startup, reconcile DB state with running Docker containers.
         * Mark sessions whose containers are gone as "stopped".
         */
        async reconcile(): Promise<void> {
                console.log("[docker] reconciling session state with Docker…");
                const db = await import("./db.js");
                const database = db.getDb();
                const rows = database
                        .prepare("SELECT session_id, container_id FROM sessions WHERE status = 'running'")
                        .all() as Array<{ session_id: string; container_id: string | null }>;

                for (const row of rows) {
                        if (!row.container_id) {
                                this.sessions.updateStatus(row.session_id, "stopped");
                                continue;
                        }
                        try {
                                const info = await this.docker.getContainer(row.container_id).inspect();
                                if (!info.State.Running) {
                                        this.sessions.updateStatus(row.session_id, "stopped");
                                }
                        } catch {
                                // Container doesn't exist anymore
                                this.sessions.updateStatus(row.session_id, "stopped");
                        }
                }
                console.log("[docker] reconciliation complete");
        }
}
