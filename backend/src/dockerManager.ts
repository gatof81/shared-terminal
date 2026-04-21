/**
 * dockerManager.ts — Docker container & exec lifecycle.
 *
 * Each session is a Docker container running tmux.  When a user connects
 * via WebSocket we `docker exec … tmux attach` to get a live TTY stream.
 */

import Dockerode from "dockerode";
import { Duplex } from "stream";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
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

export interface Tab {
        tabId: string;      // tmux session name inside the container (e.g. "tab-default", "tab-abc12345")
        label: string;      // display label (tmux user-option @tab-label)
        createdAt: number;  // unix seconds
}

// One shared `tmux attach` exec per target key. All WS clients pointing at the
// same session+tab multiplex over this single exec — tmux already mirrors
// output to every attached client, so if we made one exec per client, each
// byte would fan out N times.
interface SharedExec {
        execId: string;
        stream: Duplex;
        resize(cols: number, rows: number): Promise<void>;
        listeners: Map<string /*attachId*/, OutputListener>;
        clientSizes: Map<string /*attachId*/, { cols: number; rows: number }>;
        appliedSize: { cols: number; rows: number };
}

export class DockerManager {
        private docker: Dockerode;
        private sessions: SessionManager;
        private buffers = new Map<string /*targetKey*/, RingBuffer>();
        private shared = new Map<string /*targetKey*/, Promise<SharedExec>>();
        private keyOf = new Map<string /*attachId*/, string /*targetKey*/>();

        constructor(sessions: SessionManager, dockerOpts?: Dockerode.DockerOptions) {
                this.docker = new Dockerode(dockerOpts ?? { socketPath: "/var/run/docker.sock" });
                this.sessions = sessions;
        }

        // Each tab inside a session is its own tmux session in the container and
        // gets its own shared exec + ring buffer. The targetKey is the join key.
        private targetKey(sessionId: string, tabId: string): string {
                return `${sessionId}:${tabId}`;
        }

        // Default tab name that the session-image entrypoint creates on first boot.
        // Used as the fallback when a WS connects without a `tab` query param so
        // we keep a sensible experience for single-tab users.
        static readonly DEFAULT_TAB_ID = "tab-default";

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

                if (meta?.containerId) {
                        try {
                                const container = this.docker.getContainer(meta.containerId);
                                try { await container.stop({ t: 5 }); } catch { /* already stopped */ }
                                // `v: true` also removes any anonymous volumes attached to the
                                // container (bind mounts are unaffected — those are cleaned by
                                // purgeWorkspace on hard delete).
                                try { await container.remove({ force: true, v: true }); } catch { /* already removed */ }
                        } catch (err) {
                                console.error(`[docker] error killing container for session ${sessionId}:`, (err as Error).message);
                        }
                        // The container no longer exists in Docker — reflect that in D1 so any
                        // later lookup doesn't chase a dead container id.
                        try {
                                await this.sessions.setContainerId(sessionId, null);
                        } catch (err) {
                                console.error(`[docker] failed to null container_id for session ${sessionId}:`, (err as Error).message);
                        }
                }

                // Destroy any shared exec and per-attach routing for this session.
                // Match on equality or on `sessionId:…` prefix so this keeps working
                // once per-tab targetKeys (sessionId:windowId) exist.
                const prefix = `${sessionId}:`;
                for (const [key, pending] of this.shared) {
                        if (key === sessionId || key.startsWith(prefix)) {
                                this.shared.delete(key);
                                this.buffers.delete(key);
                                pending.then(
                                        (s) => { try { s.stream.destroy(); } catch { /* already destroyed */ } },
                                        () => { /* spawn rejected — nothing to destroy */ },
                                );
                        }
                }
                for (const [attachId, key] of this.keyOf) {
                        if (key === sessionId || key.startsWith(prefix)) {
                                this.keyOf.delete(attachId);
                        }
                }
                this.buffers.delete(sessionId);
                console.log(`[docker] killed container for session ${sessionId}`);
        }

        /**
         * Delete the bind-mounted workspace directory for a session.
         *
         * This is intentionally strict about the path it will remove: it refuses
         * to touch anything that does not resolve to a child of WORKSPACE_ROOT.
         * Missing directories are a no-op (idempotent hard delete).
         */
        async purgeWorkspace(sessionId: string): Promise<void> {
                const rootAbs = path.resolve(WORKSPACE_ROOT);
                const sessionAbs = path.resolve(path.join(WORKSPACE_ROOT, sessionId));

                // Safety: the resolved session dir must be a strict child of rootAbs.
                if (!sessionAbs.startsWith(rootAbs + path.sep)) {
                        throw new Error(
                                `[docker] refusing to purge workspace outside root (root=${rootAbs}, target=${sessionAbs})`,
                        );
                }

                try {
                        await fs.rm(sessionAbs, { recursive: true, force: true });
                        console.log(`[docker] purged workspace dir ${sessionAbs}`);
                } catch (err) {
                        console.error(`[docker] failed to purge workspace ${sessionAbs}:`, (err as Error).message);
                        throw err;
                }
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

                // Case 1: no container exists (terminated session, or one whose container
                // was removed out-of-band). Spawn a fresh container reusing the existing
                // container name + workspace bind mount.
                if (!meta.containerId) {
                        await this.spawn(sessionId);
                        await this.sessions.updateStatus(sessionId, "running");
                        console.log(`[docker] respawned container for session ${sessionId}`);
                        return;
                }

                // Case 2: container id is on file. Check it still exists in Docker; if it
                // does, just start it. If Docker has no record of it, forget the stale id
                // and spawn a replacement.
                try {
                        const info = await this.docker.getContainer(meta.containerId).inspect();
                        if (!info.State.Running) {
                                await this.docker.getContainer(meta.containerId).start();
                        }
                        await this.sessions.updateStatus(sessionId, "running");
                        console.log(`[docker] restarted container for session ${sessionId}`);
                } catch {
                        console.log(`[docker] stale container_id for session ${sessionId}, respawning`);
                        await this.sessions.setContainerId(sessionId, null);
                        await this.spawn(sessionId);
                        await this.sessions.updateStatus(sessionId, "running");
                }
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
                tabId: string = DockerManager.DEFAULT_TAB_ID,
        ): Promise<{ handle: ExecHandle; replay: string | null }> {
                const key = this.targetKey(sessionId, tabId);

                // Reuse the shared exec if one already exists (or is being spawned).
                // Concurrent first-attach calls await the same promise → exactly one
                // `container.exec` on the wire.
                let pending = this.shared.get(key);
                if (!pending) {
                        pending = this.spawnSharedExec(sessionId, key, tabId);
                        // Clear the slot on rejection so the next attach retries.
                        // `.catch` here doesn't consume the rejection — awaiters on the
                        // original promise still see it; this handler exists so Node
                        // doesn't flag an unhandledRejection if the awaiter finishes
                        // before this microtask.
                        pending.catch((err) => {
                                if (this.shared.get(key) === pending) this.shared.delete(key);
                                console.error(`[docker] shared exec spawn failed for ${key}:`, (err as Error).message);
                        });
                        this.shared.set(key, pending);
                }

                const s = await pending;

                s.listeners.set(attachId, onOutput);
                s.clientSizes.set(attachId, { cols, rows });
                this.keyOf.set(attachId, key);

                await this.recomputeSize(s);

                const replay = this.getOrCreateBuffer(key).drain();
                await this.sessions.updateConnected(sessionId);
                console.log(`[docker] attached ${attachId} to session ${sessionId} (listeners=${s.listeners.size})`);

                const handle: ExecHandle = {
                        execId: attachId,
                        stream: s.stream,
                        resize: (c: number, r: number) => this.resize(attachId, c, r),
                        destroy: () => this.detach(attachId),
                };
                return { handle, replay: replay.length > 0 ? replay : null };
        }

        write(attachId: string, data: string): void {
                const key = this.keyOf.get(attachId);
                if (!key) return;
                const pending = this.shared.get(key);
                if (!pending) return;
                // By the time a client sends input, attach() has awaited `pending`,
                // so it's already resolved — the .then just defensively handles the
                // not-yet-resolved path. No error handler needed: a rejected spawn
                // clears the slot above; pending would already be gone.
                pending.then((s) => {
                        if (!s.stream.destroyed) s.stream.write(data);
                }, () => { /* spawn failed; nothing to write to */ });
        }

        async resize(attachId: string, cols: number, rows: number): Promise<void> {
                const key = this.keyOf.get(attachId);
                if (!key) return;
                const pending = this.shared.get(key);
                if (!pending) return;
                const s = await pending.catch(() => null);
                if (!s) return;
                if (!s.clientSizes.has(attachId)) return;
                s.clientSizes.set(attachId, { cols, rows });
                await this.recomputeSize(s);
        }

        detach(attachId: string): void {
                const key = this.keyOf.get(attachId);
                if (!key) return;
                this.keyOf.delete(attachId);
                const pending = this.shared.get(key);
                if (!pending) return;

                pending.then((s) => {
                        s.listeners.delete(attachId);
                        s.clientSizes.delete(attachId);

                        if (s.listeners.size === 0) {
                                // Last client gone — tear down the shared exec. The ring
                                // buffer is kept so a future re-attach gets scrollback.
                                if (this.shared.get(key) === pending) this.shared.delete(key);
                                try { s.stream.destroy(); } catch { /* already destroyed */ }
                                console.log(`[docker] detached ${attachId}; last client, shared exec closed`);
                        } else {
                                // Someone else may have had a smaller terminal; recompute so
                                // the survivors don't stay pinned to a too-small size.
                                void this.recomputeSize(s);
                                console.log(`[docker] detached ${attachId}; ${s.listeners.size} listener(s) remain`);
                        }
                }, () => { /* spawn rejected; nothing to detach from */ });
        }

        // ── Shared exec internals ──────────────────────────────────────────────

        private async spawnSharedExec(sessionId: string, key: string, tabId: string): Promise<SharedExec> {
                const meta = await this.sessions.getOrThrow(sessionId);
                if (!meta.containerId) throw new Error("No container for this session");

                const container = this.docker.getContainer(meta.containerId);
                const exec = await container.exec({
                        Cmd: ["tmux", "attach", "-t", tabId],
                        AttachStdin: true,
                        AttachStdout: true,
                        AttachStderr: true,
                        Tty: true,
                        // Initial env size is a placeholder — recomputeSize applies the real
                        // min-of-all-clients size as soon as the first attach() registers.
                        Env: [`COLUMNS=80`, `LINES=24`],
                });

                const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

                const buffer = this.getOrCreateBuffer(key);
                const s: SharedExec = {
                        execId: key,
                        stream,
                        resize: async (c: number, r: number) => {
                                try { await exec.resize({ h: r, w: c }); } catch { /* ignore */ }
                        },
                        listeners: new Map(),
                        clientSizes: new Map(),
                        // Sentinel {0,0} forces the first recomputeSize to actually call
                        // exec.resize — any real client size differs from this.
                        appliedSize: { cols: 0, rows: 0 },
                };

                // Single fan-out for the entire session. Each byte from tmux fires this
                // exactly once, regardless of how many clients are attached.
                stream.on("data", (chunk: Buffer) => {
                        const data = chunk.toString("utf-8");
                        buffer.push(data);
                        for (const l of s.listeners.values()) {
                                try { l(data); } catch { /* listener error */ }
                        }
                });

                // If the stream dies on its own (tmux server exits, container restarted,
                // docker daemon hiccup), forget the shared entry so the next attach will
                // respawn. We guard the delete with a stream-identity check so we never
                // clobber a newer spawn that replaced us. Orphaned listeners clean
                // themselves up when their WS closes and detach() runs.
                const forgetIfCurrent = async () => {
                        const currentP = this.shared.get(key);
                        if (!currentP) return;
                        try {
                                const currentS = await currentP;
                                if (currentS.stream === stream) this.shared.delete(key);
                        } catch { /* newer spawn rejected; not our concern */ }
                };
                stream.on("end", () => { void forgetIfCurrent(); });
                stream.on("close", () => { void forgetIfCurrent(); });
                stream.on("error", (err) => {
                        console.error(`[docker] shared exec stream error for ${key}:`, (err as Error).message);
                        void forgetIfCurrent();
                });

                console.log(`[docker] spawned shared exec for ${key}`);
                return s;
        }

        // ── Tabs (tmux session per tab) ────────────────────────────────────────

        async listTabs(sessionId: string): Promise<Tab[]> {
                const { stdout, exitCode } = await this.execOneShot(sessionId, [
                        "tmux", "list-sessions", "-F",
                        "#{session_name}\t#{?@tab-label,#{@tab-label},#{session_name}}\t#{session_created}",
                ]);
                // tmux returns 1 with "no server running" when the server died. That is
                // an unusable container for us — surface as empty so callers can recover.
                if (exitCode !== 0) return [];
                return stdout
                        .split("\n")
                        .map((line) => line.trim())
                        .filter((line) => line.length > 0)
                        .map((line): Tab => {
                                const [tabId = "", label = "", createdAt = "0"] = line.split("\t");
                                return { tabId, label, createdAt: Number(createdAt) || 0 };
                        });
        }

        async createTab(sessionId: string, label?: string): Promise<Tab> {
                const tabId = `tab-${randomBytes(4).toString("hex")}`;
                const displayLabel = (label ?? "").trim() || tabId;

                const create = await this.execOneShot(sessionId, [
                        "tmux", "new-session", "-d", "-s", tabId, "-x", "120", "-y", "36",
                ]);
                if (create.exitCode !== 0) {
                        throw new Error(`tmux new-session failed (exit ${create.exitCode}): ${create.stdout}`);
                }

                // User-option stays with the tmux session for its lifetime — survives
                // backend restarts, doesn't need a D1 table.
                await this.execOneShot(sessionId, [
                        "tmux", "set-option", "-t", tabId, "@tab-label", displayLabel,
                ]);

                const now = Math.floor(Date.now() / 1000);
                console.log(`[docker] created tab ${tabId} (${displayLabel}) in session ${sessionId}`);
                return { tabId, label: displayLabel, createdAt: now };
        }

        async deleteTab(sessionId: string, tabId: string): Promise<void> {
                // Tear down any shared exec + buffer for this tab first so we don't
                // leave dangling handles pointing at a dead tmux session.
                const key = this.targetKey(sessionId, tabId);
                const pending = this.shared.get(key);
                if (pending) {
                        this.shared.delete(key);
                        pending.then(
                                (s) => { try { s.stream.destroy(); } catch { /* already destroyed */ } },
                                () => { /* spawn rejected — nothing to destroy */ },
                        );
                }
                this.buffers.delete(key);
                for (const [attachId, k] of this.keyOf) {
                        if (k === key) this.keyOf.delete(attachId);
                }

                const { exitCode } = await this.execOneShot(sessionId, ["tmux", "kill-session", "-t", tabId]);
                if (exitCode !== 0) {
                        // kill-session returns non-zero if the target doesn't exist — OK for
                        // the idempotent case; caller has already validated it existed.
                        console.warn(`[docker] kill-session ${tabId} exited ${exitCode}`);
                }
                console.log(`[docker] deleted tab ${tabId} from session ${sessionId}`);
        }

        /** Resolve a sane default when a caller didn't specify a tabId. Returns the
         *  first tab from `listTabs`, falling back to DEFAULT_TAB_ID if we can't
         *  reach the container (e.g. reconcile race). */
        async getDefaultTabId(sessionId: string): Promise<string> {
                try {
                        const tabs = await this.listTabs(sessionId);
                        if (tabs.length > 0) return tabs[0]!.tabId;
                } catch { /* fall through to static default */ }
                return DockerManager.DEFAULT_TAB_ID;
        }

        private async execOneShot(
                sessionId: string,
                cmd: string[],
        ): Promise<{ stdout: string; exitCode: number }> {
                const meta = await this.sessions.getOrThrow(sessionId);
                if (!meta.containerId) throw new Error("No container for this session");
                const container = this.docker.getContainer(meta.containerId);

                const exec = await container.exec({
                        Cmd: cmd,
                        AttachStdin: false,
                        AttachStdout: true,
                        AttachStderr: true,
                        // Tty:true merges stdout/stderr onto a single stream so we don't
                        // need the docker frame demuxer for these short-lived tmux calls.
                        Tty: true,
                });
                const stream = await exec.start({ hijack: false, stdin: false });
                const chunks: Buffer[] = [];
                stream.on("data", (c: Buffer) => chunks.push(c));
                await new Promise<void>((resolve, reject) => {
                        stream.on("end", () => resolve());
                        stream.on("close", () => resolve());
                        stream.on("error", reject);
                });
                const info = await exec.inspect();
                return {
                        stdout: Buffer.concat(chunks).toString("utf-8").replace(/\r/g, ""),
                        exitCode: info.ExitCode ?? 0,
                };
        }

        private async recomputeSize(s: SharedExec): Promise<void> {
                if (s.clientSizes.size === 0) return;
                let minCols = Number.POSITIVE_INFINITY;
                let minRows = Number.POSITIVE_INFINITY;
                for (const { cols, rows } of s.clientSizes.values()) {
                        if (cols < minCols) minCols = cols;
                        if (rows < minRows) minRows = rows;
                }
                if (minCols !== s.appliedSize.cols || minRows !== s.appliedSize.rows) {
                        s.appliedSize = { cols: minCols, rows: minRows };
                        await s.resize(minCols, minRows);
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
