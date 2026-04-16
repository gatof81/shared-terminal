/**
 * dockerManager.ts — Docker container & exec lifecycle.
 *
 * Each session is a Docker container running tmux.  When a user connects
 * via WebSocket we `docker exec … tmux attach` to get a live TTY stream.
 */

import Dockerode from "dockerode";
import { Duplex } from "stream";
import { SessionManager } from "./sessionManager.js";
import { RingBuffer } from "./ringBuffer.js";
import { d1Query } from "./db.js";

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
        private buffers = new Map<string, RingBuffer>();
        private listeners = new Map<string, Set<OutputListener>>();
        private execs = new Map<string, ExecHandle>();

        constructor(sessions: SessionManager, dockerOpts?: Dockerode.DockerOptions) {
                this.docker = new Dockerode(dockerOpts ?? { socketPath: "/var/run/docker.sock" });
                this.sessions = sessions;
        }

        // ── Container lifecycle ─────────────────────────────────────────────────

        async spawn(sessionId: string): Promise<string> {
                const meta = await this.sessions.getOrThrow(sessionId);
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
                                Binds: [`${WORKSPACE_ROOT}/${sessionId}:/home/developer/workspace`],
                                Memory: 2 * 1024 * 1024 * 1024,
                                NanoCpus: 2_000_000_000,
                                RestartPolicy: { Name: "unless-stopped" },
                        },
                        OpenStdin: true,
                        Tty: true,
                });

                await container.start();
                const containerId = container.id;
                await this.sessions.setContainerId(sessionId, containerId);
                this.buffers.set(sessionId, new RingBuffer(128 * 1024));

                console.log(`[docker] spawned container ${meta.containerName} (${containerId.slice(0, 12)}) for session ${sessionId}`);
                return containerId;
        }

        async kill(sessionId: string): Promise<void> {
                const meta = await this.sessions.get(sessionId);
                if (!meta?.containerId) return;

                try {
                        const container = this.docker.getContainer(meta.containerId);
                        try { await container.stop({ t: 5 }); } catch { /* already stopped */ }
                        try { await container.remove({ force: true }); } catch { /* already removed */ }
                } catch (err) {
                        console.error(`[docker] error killing container for session ${sessionId}:`, (err as Error).message);
                }

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

        async isAlive(sessionId: string): Promise<boolean> {
                const meta = await this.sessions.get(sessionId);
                if (!meta?.containerId) return false;
                try {
                        const info = await this.docker.getContainer(meta.containerId).inspect();
                        return info.State.Running === true;
                } catch {
                        return false;
                }
        }

        async startContainer(sessionId: string): Promise<void> {
                const meta = await this.sessions.getOrThrow(sessionId);
                if (!meta.containerId) throw new Error("No container ID for this session");
                await this.docker.getContainer(meta.containerId).start();
                await this.sessions.updateStatus(sessionId, "running");
                console.log(`[docker] restarted container for session ${sessionId}`);
        }

        async stopContainer(sessionId: string): Promise<void> {
                const meta = await this.sessions.getOrThrow(sessionId);
                if (!meta.containerId) return;
                try {
                        await this.docker.getContainer(meta.containerId).stop({ t: 5 });
                } catch { /* already stopped */ }
                await this.sessions.updateStatus(sessionId, "stopped");
                console.log(`[docker] stopped container for session ${sessionId}`);
        }

        // ── Exec attach ────────────────────────────────────────────────────────

        async attach(
                sessionId: string,
                attachId: string,
                cols: number,
                rows: number,
                onOutput: OutputListener,
        ): Promise<{ handle: ExecHandle; replay: string | null }> {
                const meta = await this.sessions.getOrThrow(sessionId);
                if (!meta.containerId) throw new Error("No container for this session");

                const container = this.docker.getContainer(meta.containerId);
                const exec = await container.exec({
                        Cmd: ["tmux", "attach", "-t", "main"],
                        AttachStdin: true,
                        AttachStdout: true,
                        AttachStderr: true,
                        Tty: true,
                        Env: [`COLUMNS=${cols}`, `LINES=${rows}`],
                });

                const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
                try { await exec.resize({ h: rows, w: cols }); } catch { /* ignore */ }

                const buffer = this.getOrCreateBuffer(sessionId);

                stream.on("data", (chunk: Buffer) => {
                        const data = chunk.toString("utf-8");
                        buffer.push(data);
                        const ls = this.listeners.get(sessionId);
                        if (ls) {
                                for (const l of ls) {
                                        try { l(data); } catch { /* listener error */ }
                                }
                        }
                });

                if (!this.listeners.has(sessionId)) {
                        this.listeners.set(sessionId, new Set());
                }
                this.listeners.get(sessionId)!.add(onOutput);

                const handle: ExecHandle = {
                        execId: attachId,
                        stream,
                        resize: async (c: number, r: number) => {
                                try { await exec.resize({ h: r, w: c }); } catch { /* ignore */ }
                        },
                        destroy: () => {
                                stream.destroy();
                                this.listeners.get(sessionId)?.delete(onOutput);
                                this.execs.delete(attachId);
                        },
                };

                this.execs.set(attachId, handle);
                const replay = buffer.drain();
                await this.sessions.updateConnected(sessionId);
                console.log(`[docker] attached exec ${attachId} to session ${sessionId}`);
                return { handle, replay };
        }

        write(attachId: string, data: string): void {
                const handle = this.execs.get(attachId);
                if (handle && !handle.stream.destroyed) {
                        handle.stream.write(data);
                }
        }

        async resize(attachId: string, cols: number, rows: number): Promise<void> {
                const handle = this.execs.get(attachId);
                if (handle) await handle.resize(cols, rows);
        }

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

        async reconcile(): Promise<void> {
                console.log("[docker] reconciling session state with Docker…");
                const result = await d1Query<{ session_id: string; container_id: string | null }>(
                        "SELECT session_id, container_id FROM sessions WHERE status = 'running'",
                );

                for (const row of result.results) {
                        if (!row.container_id) {
                                await this.sessions.updateStatus(row.session_id, "stopped");
                                continue;
                        }
                        try {
                                const info = await this.docker.getContainer(row.container_id).inspect();
                                if (!info.State.Running) {
                                        await this.sessions.updateStatus(row.session_id, "stopped");
                                }
                        } catch {
                                await this.sessions.updateStatus(row.session_id, "stopped");
                        }
                }
                console.log("[docker] reconciliation complete");
        }
}
