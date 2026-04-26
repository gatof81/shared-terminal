/**
 * dockerManager.ts — Docker container & exec lifecycle.
 *
 * Each session is a Docker container running tmux.  When a user connects
 * via WebSocket we `docker exec … tmux attach` to get a live TTY stream.
 */

import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import Dockerode from "dockerode";
import { d1Query } from "./db.js";
import type { SessionManager } from "./sessionManager.js";

const SESSION_IMAGE = process.env.SESSION_IMAGE ?? "shared-terminal-session";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";

// Owner applied to freshly-created workspace directories. Must match the
// `developer` user inside session-image/Dockerfile (uid/gid 1000 by default).
// Overridable via env for deployments that customise the session image.
// Docker auto-creates missing bind sources as root, which locks the container
// user out of its own workspace — we pre-create the dir with the right owner
// instead.
const WORKSPACE_UID = Number.parseInt(process.env.WORKSPACE_UID ?? "1000", 10);
const WORKSPACE_GID = Number.parseInt(process.env.WORKSPACE_GID ?? "1000", 10);

// Opt-in: repair ownership on pre-existing *contents* under the session
// directory, not just the top-level dir. Useful one-shot for deployments
// that lived through the earlier bug where Docker auto-created the bind
// source as root, leaving nested files/dirs unwritable even after the
// top-level was fixed. Default off because:
//   - chowning arbitrary files the operator deliberately set to another
//     owner would be surprising;
//   - a deep traversal on a large workspace can be slow, and we don't
//     want to pay that cost on every spawn.
// Flip on for one boot, restart the affected sessions, flip off again.
const WORKSPACE_CHOWN_RECURSIVE =
        process.env.WORKSPACE_CHOWN_RECURSIVE === "true"
        || process.env.WORKSPACE_CHOWN_RECURSIVE === "1";

export interface ExecHandle {
        execId: string;
        stream: Duplex;
        resize(cols: number, rows: number): Promise<void>;
        destroy(): void;
}

export type OutputListener = (data: string) => void;

export interface Tab {
        tabId: string;      // tmux session name inside the container (e.g. "tab-abc12345")
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
        private shared = new Map<string /*targetKey*/, Promise<SharedExec>>();
        private keyOf = new Map<string /*attachId*/, string /*targetKey*/>();

        constructor(sessions: SessionManager, dockerOpts?: Dockerode.DockerOptions) {
                this.docker = new Dockerode(dockerOpts ?? { socketPath: "/var/run/docker.sock" });
                this.sessions = sessions;
        }

        // Each tab inside a session is its own tmux session in the container and
        // gets its own shared exec. The targetKey is the join key; replay on
        // reconnect is a tmux capture-pane snapshot (see capturePane()), not a
        // server-side byte buffer.
        private targetKey(sessionId: string, tabId: string): string {
                return `${sessionId}:${tabId}`;
        }

        // ── Container lifecycle ─────────────────────────────────────────────────

        async spawn(sessionId: string): Promise<string> {
                const meta = await this.sessions.getOrThrow(sessionId);
                const envArray = Object.entries(meta.envVars).map(([k, v]) => `${k}=${v}`);

                // Pre-create the bind-mount target so Docker doesn't auto-create it
                // as root. See `ensureWorkspaceOwnership` for the full story and the
                // non-recursive invariant.
                const workspaceDir = path.join(WORKSPACE_ROOT, sessionId);
                await fs.mkdir(workspaceDir, { recursive: true });
                await this.ensureWorkspaceOwnership(workspaceDir);

                const container = await this.docker.createContainer({
                        Image: SESSION_IMAGE,
                        name: meta.containerName,
                        Hostname: meta.name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 63),
                        Env: [
                                `SESSION_ID=${sessionId}`,
                                `SESSION_NAME=${meta.name}`,
                                `TERM=xterm-256color`,
                                `COLORTERM=truecolor`,
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

                console.log(`[docker] spawned container ${meta.containerName} (${containerId.slice(0, 12)}) for session ${sessionId}`);
                return containerId;
        }

        /**
         * Apply `WORKSPACE_UID:WORKSPACE_GID` to the session workspace.
         *
         * By default this chowns only the top-level directory, not its contents.
         * The invariant is "freshly-created or already correctly-owned": nested
         * files are assumed to have been written by the container itself (so they
         * already have the right owner). If the operator set
         * WORKSPACE_CHOWN_RECURSIVE=true we also walk descendants — useful for
         * one-shot repair of workspaces left inconsistent by an earlier version
         * that let Docker create the bind source root-owned.
         *
         * All chown calls downgrade EPERM/ENOSYS to a warning so unprivileged
         * dev mode still works; any other errno is re-thrown so we don't
         * silently boot a session with a broken workspace.
         */
        private async ensureWorkspaceOwnership(dir: string): Promise<void> {
                await this.chownToWorkspaceUser(dir);

                if (!WORKSPACE_CHOWN_RECURSIVE) return;

                // Walk the tree iteratively (not recursively) to avoid stack
                // growth on deep workspaces. `withFileTypes: true` avoids a stat
                // per entry. Symlinks are chowned in place (lchown-equivalent)
                // so we don't follow them out of the workspace root.
                const stack: string[] = [dir];
                while (stack.length > 0) {
                        // `pop()` returns `T | undefined`. The while condition
                        // already guarantees the stack is non-empty, so the
                        // undefined branch is unreachable — but we check anyway to
                        // satisfy biome's no-non-null-assertion rule and to keep
                        // the code safe if the loop header is ever refactored (e.g.
                        // changed to `while (true)`) without re-analysing the
                        // invariant.
                        const current = stack.pop();
                        if (current === undefined) break;
                        let entries: Dirent[];
                        try {
                                entries = await fs.readdir(current, { withFileTypes: true });
                        } catch (err) {
                                const code = (err as NodeJS.ErrnoException).code;
                                // A sibling-modified workspace (file removed mid-walk) shouldn't
                                // abort the whole repair; log and keep going.
                                if (code === "ENOENT" || code === "ENOTDIR") continue;
                                throw err;
                        }
                        for (const entry of entries) {
                                const full = path.join(current, entry.name);
                                await this.chownToWorkspaceUser(full);
                                if (entry.isDirectory() && !entry.isSymbolicLink()) {
                                        stack.push(full);
                                }
                        }
                }
        }

        /**
         * chown a single path to WORKSPACE_UID:WORKSPACE_GID. Downgrades
         * EPERM/ENOSYS to a warning (unprivileged dev mode), re-throws
         * everything else so a real broken-workspace error doesn't get
         * swallowed. Shared by the spawn-time ownership pass and the
         * upload writer below.
         */
        private async chownToWorkspaceUser(target: string): Promise<void> {
                try {
                        await fs.chown(target, WORKSPACE_UID, WORKSPACE_GID);
                } catch (err) {
                        const code = (err as NodeJS.ErrnoException).code;
                        if (code === "EPERM" || code === "ENOSYS") {
                                console.warn(
                                        `[docker] couldn't chown ${target} to ${WORKSPACE_UID}:${WORKSPACE_GID} (${code}); ` +
                                        `run the backend as root or pre-create paths with matching ownership.`,
                                );
                        } else {
                                throw err;
                        }
                }
        }

        /**
         * Save uploaded files into the session workspace under `uploads/`
         * and return their in-container paths. Caller must have already
         * verified ownership of `sessionId`.
         *
         * Filenames are sanitised to a safe basename and prefixed with a
         * monotonic timestamp + short random suffix so concurrent uploads
         * of the same name don't clobber each other. The host path of
         * every write is `path.resolve()`d and verified to sit inside the
         * uploads directory before opening the file — the sanitiser
         * already strips path separators, but the resolve-and-check is a
         * defence-in-depth belt against a future regression.
         */
        async writeUploads(
                sessionId: string,
                files: ReadonlyArray<{ originalname: string; path: string }>,
        ): Promise<string[]> {
                if (files.length === 0) return [];
                const uploadsHostDir = path.join(WORKSPACE_ROOT, sessionId, "uploads");
                // Lexical sanity check (matches purgeWorkspace at L306).
                // assertOwnership already constrains sessionId to a UUID from D1,
                // but if a future refactor ever lets a path-traversal-shaped
                // sessionId reach here we must not even mkdir outside WORKSPACE_ROOT.
                const rootAbs = path.resolve(WORKSPACE_ROOT);
                const uploadsHostDirAbs = path.resolve(uploadsHostDir);
                if (!uploadsHostDirAbs.startsWith(`${rootAbs}${path.sep}`)) {
                        await this.cleanupTmp(files);
                        throw new Error(`unsafe session path resolved outside ${rootAbs}: ${uploadsHostDirAbs}`);
                }
                await fs.mkdir(uploadsHostDir, { recursive: true });

                // Lexical resolve() above is purely string manipulation — it
                // does NOT follow symlinks. A container owns its bind-mounted
                // workspace and could replace `uploads/` with a symlink to /etc
                // before we got here; the lexical check would still pass and
                // a subsequent chown would change ownership of the link target.
                // fs.realpath canonicalises through the filesystem, so a
                // mis-pointed symlink shows up as a real-path outside
                // WORKSPACE_ROOT and we bail before touching anything.
                const rootReal = await fs.realpath(WORKSPACE_ROOT);
                const realUploadsDir = await fs.realpath(uploadsHostDir);
                if (!realUploadsDir.startsWith(`${rootReal}${path.sep}`)) {
                        await this.cleanupTmp(files);
                        throw new Error(`uploads dir escaped workspace root: ${realUploadsDir}`);
                }
                // Deliberately NOT chowning realUploadsDir to the workspace user.
                // The container owns the parent `<sessionId>/` directory (set by
                // spawn-time ensureWorkspaceOwnership), so it can rmdir/rename
                // any subdir it owns. If we chowned uploads/ to uid 1000, the
                // container could empty the dir then `ln -s /etc uploads/` —
                // resolving the path string at rename(2) time would land the
                // backend write outside WORKSPACE_ROOT despite the realpath
                // check above (TOCTOU on the path component, not the file).
                // Keeping uploads/ owned by the backend (typically root,
                // mode 0755) means the container can still traverse and read
                // its own files (per-file chown to uid 1000 below) but can't
                // empty or write inside the dir to stage the swap.

                const containerPaths: string[] = [];
                const now = Date.now().toString(36);
                // Track which multer tmp files we've successfully moved so the
                // finally block can clean up anything we didn't get to.
                const remaining = new Set(files.map((f) => f.path));
                try {
                        for (const file of files) {
                                const safeBase = sanitiseUploadName(file.originalname);
                                // Random suffix on top of the timestamp so two uploads
                                // landing in the same millisecond don't collide.
                                const suffix = randomBytes(3).toString("hex");
                                const filename = `${now}-${suffix}-${safeBase}`;
                                const finalPath = path.join(realUploadsDir, filename);
                                const finalPathAbs = path.resolve(finalPath);
                                if (!finalPathAbs.startsWith(`${realUploadsDir}${path.sep}`)) {
                                        throw new Error(`unsafe upload path resolved outside ${realUploadsDir}: ${finalPathAbs}`);
                                }
                                // Atomic move within the same filesystem (multer's
                                // tmp dir lives under WORKSPACE_ROOT — see routes.ts).
                                // EXDEV would fire if someone repointed multer's tmp
                                // root elsewhere; surfacing the error is fine because
                                // the tmp file is still cleaned up by the finally below.
                                await fs.rename(file.path, finalPath);
                                remaining.delete(file.path);
                                await fs.chmod(finalPath, 0o644);
                                await this.chownToWorkspaceUser(finalPath);
                                containerPaths.push(`/home/developer/workspace/uploads/${filename}`);
                        }
                } finally {
                        await this.cleanupTmp([...remaining].map((p) => ({ originalname: "", path: p })));
                }
                return containerPaths;
        }

        /**
         * Absolute host path where multer streams uploaded bodies before
         * `writeUploads` moves them to their final per-session location.
         * Lives directly under WORKSPACE_ROOT (NOT inside any session
         * subdirectory) so it's never bind-mounted into a container, and
         * `fs.rename` from here to the final path is a same-filesystem
         * atomic move.
         */
        getUploadTmpDir(): string {
                return path.join(WORKSPACE_ROOT, ".tmp-uploads");
        }

        // Best-effort cleanup of multer's on-disk temp files. Used on the
        // bail-out paths in writeUploads (containment-check failure, mid-loop
        // throw). Each unlink is independently swallowed because the only
        // failure modes here are "file already gone" or "no permission" —
        // neither is something the upload caller should hear about.
        private async cleanupTmp(
                files: ReadonlyArray<{ path: string }>,
        ): Promise<void> {
                await Promise.allSettled(files.map((f) => fs.unlink(f.path)));
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
                tabId: string,
        ): Promise<{ handle: ExecHandle; replay: string | null; flushTail: () => void }> {
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

                // ── Replay strategy ───────────────────────────────────────────────
                // We capture the pane's canonical state via `tmux capture-pane -p -e`
                // and use *that* as the replay payload. This replaces the old
                // ring-buffer-of-raw-bytes strategy that had two known defects:
                //
                //   (a) a 64 KB byte ring hands the client a mid-sequence tail of
                //       escape codes, so xterm's state (cursor pos, attrs, alt
                //       screen) could be left inconsistent after replay — classic
                //       "junk redraw" on reconnect;
                //   (b) the ring needed bytes accumulated *while at least one other
                //       client was attached* — reconnecting after a quiet period
                //       replayed nothing, leaving the user looking at a blank term.
                //
                // capture-pane is tmux's own idea of "what is on screen right now"
                // including colours and cursor attrs (the -e flag), so the replay
                // is always a valid, self-contained redraw.
                //
                // Cost note: capture-pane is a separate `docker exec` per joiner.
                // N simultaneous reconnecters to a popular session fire N sequential
                // one-shots against the same container — there's no dedup window.
                // The per-call cost is small (tens of ms each in practice) and the
                // joiner already awaited spawnSharedExec, so this isn't on a path
                // that blocks live bytes for other clients. If it ever becomes an
                // amplifier we can cache a snapshot per-tab with a short TTL and
                // hand it out to co-arriving joiners. Not worth the state today.
                //
                // ── Live-vs-replay ordering ───────────────────────────────────────
                // We have to deliver bytes to the client in the correct order: the
                // replay must land BEFORE any live bytes that arrive afterwards —
                // otherwise the user sees fresh output get overwritten by a stale
                // snapshot. Without buffering, these two concurrent streams race:
                //
                //   attach() returns → wsHandler sends replay → [live bytes can
                //   fire between these two steps] → wsHandler sends live delta →
                //   client paints replay on top of the delta it just rendered.
                //
                // To serialise them we arm an "until-flushed" listener BELOW: while
                // armed it piles live bytes into a local `tail` array instead of
                // calling onOutput. wsHandler sends the replay payload and THEN
                // calls flushTail(), which drains the tail in order and flips the
                // listener to forward-directly. Because flushTail is synchronous
                // (no awaits, ws.send is sync too) the client-visible sequence
                // from the moment the listener is registered onward is deterministic:
                // [captured screen][every live delta in arrival order].
                //
                // Residual race we accept: there is a narrow window between when
                // capture-pane is issued and when the listener below is registered.
                // Bytes tmux emits during that window are not in the snapshot (they
                // weren't on the pane when capture-pane ran) AND not in the tail
                // (the listener wasn't armed yet). The client won't see them until
                // the next live byte forces a redraw.
                //
                // Self-heal timing depends on what the pane is doing:
                //   - Interactive shell / TUI: the next keystroke echo or cursor
                //     blink redraws within ~seconds — bytes are deferred, not
                //     permanently lost.
                //   - Non-interactive output (a running `tail -f`, a build log, a
                //     background process writing periodically): the deferred bytes
                //     stay deferred until the next spontaneous write, which could
                //     be seconds or minutes away. They DO eventually repaint (the
                //     missing chars are still on the pane; any subsequent redraw
                //     of those cells shows them), but the snapshot the joining
                //     client initially sees is stale for the duration.
                //   - Fully quiet pane: deferred bytes stay missing from the
                //     client's view until *something* forces a redraw — e.g. a
                //     resize, a keystroke, or next attach. The pane is still
                //     correct server-side; only this client's initial view is
                //     behind.
                //
                // We deliberately don't close this window by arming the listener
                // BEFORE capture-pane: that would double-render every byte tmux
                // emitted between `listener registered` and `snapshot captured`,
                // because those bytes already updated the pane state that ends up
                // in the snapshot — so the client would see them once in the
                // snapshot and again in the tail. A byte-correct fix would need
                // position-aware dedup (snapshot cursor at capture time vs tail
                // start), which is more machinery than the lost-bytes symptom
                // warrants in a terminal product.
                const snapshot = await this.capturePane(sessionId, tabId);

                const tail: string[] = [];
                let armed = true;
                const bufferedListener: OutputListener = (data) => {
                        if (armed) {
                                tail.push(data);
                        } else {
                                try { onOutput(data); } catch { /* downstream error */ }
                        }
                };

                s.listeners.set(attachId, bufferedListener);
                s.clientSizes.set(attachId, { cols, rows });
                this.keyOf.set(attachId, key);

                // Once the listener is in `s.listeners`, any throw before we return
                // a handle to the caller would orphan it: wsHandler closes the
                // socket without knowing attach() got partway through, so detach()
                // is never called, and the armed `bufferedListener` keeps piling
                // live bytes into a `tail` array that nothing will ever drain.
                // recomputeSize swallows exec.resize errors internally today, but
                // updateConnected is a D1 write that CAN reject — and a future
                // refactor of either path might start propagating. Make the
                // post-register teardown explicit instead of hoping the callees
                // stay infallible.
                try {
                        await this.recomputeSize(s);
                        await this.sessions.updateConnected(sessionId);
                } catch (err) {
                        this.detach(attachId);
                        throw err;
                }
                console.log(`[docker] attached ${attachId} to session ${sessionId} (listeners=${s.listeners.size})`);

                const flushTail = () => {
                        // Drain in arrival order, then flip the gate. Node is
                        // single-threaded so the for-of loop runs atomically w.r.t.
                        // stream 'data' events (they queue on the event loop and can't
                        // interleave with synchronous JS). The order still matters at
                        // source level though: if we flipped `armed` before draining,
                        // a later refactor that inserted an await inside the loop (say
                        // for async onOutput) would let queued 'data' events wake up
                        // mid-drain and race the tail. Drain-then-flip makes that
                        // refactor-safe without needing to re-audit the invariant.
                        for (const chunk of tail) {
                                try { onOutput(chunk); } catch { /* downstream error */ }
                        }
                        tail.length = 0;
                        armed = false;
                };

                const handle: ExecHandle = {
                        execId: attachId,
                        stream: s.stream,
                        resize: (c: number, r: number) => this.resize(attachId, c, r),
                        destroy: () => this.detach(attachId),
                };
                return { handle, replay: snapshot.length > 0 ? snapshot : null, flushTail };
        }

        /**
         * Dump the tab's active pane as an escape-sequence-preserving snapshot
         * ready to write directly to an xterm. Returns "" on any failure so
         * attach() stays robust — a failed snapshot just means the client starts
         * blank and gets redrawn by the next live activity.
         *
         * `-p` prints to stdout (no paste-buffer staging), `-e` preserves colours
         * and attributes. We deliberately DON'T pass `-S -` to include scrollback:
         * the client's xterm already has its own scrollback, and dumping a full
         * history on every reconnect is both expensive and surprising (stale
         * lines moving up at connect time).
         */
        private async capturePane(sessionId: string, tabId: string): Promise<string> {
                try {
                        const { stdout, exitCode } = await this.execOneShot(sessionId, [
                                "tmux", "capture-pane", "-t", tabId, "-p", "-e",
                        ]);
                        // A non-zero exit is the common "benign race" path: when
                        // spawnSharedExec's `new-session -A` has just restarted tmux,
                        // the server socket may not be ready when capture-pane races
                        // it — tmux prints "no server running" and exits 1. Returning
                        // "" here means the client starts with a blank pane and the
                        // very next byte of live output redraws it. Intentional.
                        if (exitCode !== 0) return "";
                        // execOneShot returns clean stdout (no PTY, no \r). For a screen
                        // dump xterm needs CRLF line terminators — add the \r back.
                        return stdout.replace(/\n/g, "\r\n");
                } catch (err) {
                        console.warn(`[docker] capture-pane failed for ${this.targetKey(sessionId, tabId)}:`, (err as Error).message);
                        return "";
                }
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
                                // Last client gone — tear down the shared exec. On next
                                // attach we respawn and capture-pane replays whatever
                                // state tmux has kept alive in the container.
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
                // `new-session -A` attaches if the tmux session exists, creates it
                // if not. This is the self-healing path: if the tmux server died
                // (OOM, user `exit`ed the last pane, crash) the very next WS attach
                // respawns it transparently instead of hitting "no server running"
                // and surfacing an error toast. The `-c` keeps the freshly-created
                // session pointed at the workspace so a recreated tab doesn't land
                // next to the entrypoint script.
                //
                // Trade-off: a recreated tab loses its @tab-label user-option (the
                // label is stored in tmux memory, not D1, so a tmux restart wipes
                // it). `listTabs` falls back to `session_name` for that case, which
                // is an acceptable degradation — it's still reachable, just named
                // after its id.
                const exec = await container.exec({
                        Cmd: [
                                "tmux", "new-session", "-A",
                                "-s", tabId,
                                "-c", "/home/developer/workspace",
                        ],
                        AttachStdin: true,
                        AttachStdout: true,
                        AttachStderr: true,
                        Tty: true,
                        // Initial env size is a placeholder — recomputeSize applies the real
                        // min-of-all-clients size as soon as the first attach() registers.
                        Env: [`COLUMNS=80`, `LINES=24`],
                });

                const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

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
                // exactly once, regardless of how many clients are attached. StringDecoder
                // buffers partial multi-byte UTF-8 sequences across chunk boundaries.
                const decoder = new StringDecoder("utf8");
                const broadcast = (data: string) => {
                        if (!data) return;
                        for (const l of s.listeners.values()) {
                                try { l(data); } catch { /* listener error */ }
                        }
                };
                stream.on("data", (chunk: Buffer) => { broadcast(decoder.write(chunk)); });

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
                stream.on("end", () => { broadcast(decoder.end()); void forgetIfCurrent(); });
                // "close" fires on abrupt destroy (container killed). We intentionally
                // skip decoder.end() here — calling it would emit U+FFFD for any bytes
                // stranded in the decoder, and a partial sequence at hard close is
                // unrecoverable anyway.
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

        /**
         * Create a new tmux session inside the container, tagged with a
         * user-visible label stored as a tmux user-option (`@tab-label`).
         *
         * ## Label contract
         *
         * Callers must hand in a label that's already been validated — no
         * leading/trailing whitespace, no ASCII control chars, 1–64 chars, or
         * `undefined` to auto-default to the generated tabId. The REST route
         * enforces this (see `validateTabLabel` in routes.ts); this method
         * does NO normalisation and stores the label verbatim.
         *
         * Why the strictness matters: `listTabs` reads labels back via
         * `tmux list-sessions -F "…#{@tab-label}…"` which emits results in a
         * TSV format (\t-separated fields, \n-separated rows). A \t or \n
         * inside the stored label silently corrupts that parser — the
         * createdAt field ends up holding label fragments (timestamp parses
         * as 0) or phantom tabs appear that don't exist in tmux. \r is
         * stripped by execOneShot's demuxer, which would make the stored
         * label mismatch the sent one. Rejecting the whole 0x00–0x1F, 0x7F
         * range at the API boundary keeps all three paths sound. Higher code
         * points (emoji, accented letters, non-Latin scripts) are opaque to
         * the TSV parser and safe. See issue #92.
         *
         * Avoiding `.trim()` here is deliberate: a silent trim would let a
         * client observe "what I sent ≠ what came back" (send " foo", get
         * "foo" from listTabs). The API rejects leading/trailing whitespace
         * instead, so the value stored equals the value accepted.
         */
        async createTab(sessionId: string, label?: string): Promise<Tab> {
                const tabId = `tab-${randomBytes(4).toString("hex")}`;
                // `label` is pre-validated by the route handler (non-empty,
                // trimmed, no control chars). No normalisation here — the
                // round-trip stored == sent invariant depends on it.
                const displayLabel = label ?? tabId;

                // `-c` pins the new tab's starting directory to the bind-mounted
                // workspace. Without it, tmux inherits cwd from docker exec, which
                // uses the image's WORKDIR (/home/developer) and dumps the user
                // next to entrypoint.sh instead of in their project files.
                const create = await this.execOneShot(sessionId, [
                        "tmux", "new-session", "-d", "-s", tabId,
                        "-c", "/home/developer/workspace",
                        "-x", "120", "-y", "36",
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
                // Tear down any shared exec for this tab first so we don't leave
                // dangling handles pointing at a dead tmux session.
                const key = this.targetKey(sessionId, tabId);
                const pending = this.shared.get(key);
                if (pending) {
                        this.shared.delete(key);
                        pending.then(
                                (s) => { try { s.stream.destroy(); } catch { /* already destroyed */ } },
                                () => { /* spawn rejected — nothing to destroy */ },
                        );
                }
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
                        // Tty:false keeps stdout in Docker multiplexed frames (type=1).
                        // Tty:true would allocate a PTY which expands \t → spaces,
                        // corrupting the tab-separated output from tmux list-sessions.
                        Tty: false,
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
                        stdout: demuxDockerOutput(Buffer.concat(chunks), 1),
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
                        } catch (err) {
                                // Only 404 means container is actually gone (atomic null+stopped).
                                // Non-404 (daemon unreachable, etc.) might be transient — keep the
                                // id so /start can retry the real container, don't orphan it.
                                const statusCode = (err as { statusCode?: number }).statusCode;
                                if (statusCode === 404) {
                                        await this.sessions.recordContainerGone(row.session_id);
                                } else {
                                        console.warn(`[docker] reconcile inspect failed for session ${row.session_id}: ${(err as Error).message}`);
                                        await this.sessions.updateStatus(row.session_id, "stopped");
                                }
                        }
                }
                console.log("[docker] reconciliation complete");
        }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

// Sanitise an uploaded file's original name into a safe basename that's
// guaranteed to land inside the uploads directory. Strips any path
// components, restricts the character set, preserves a short extension,
// and falls back to "file" if everything got stripped. Exported for tests.
export function sanitiseUploadName(original: string): string {
        const base = path.basename(original ?? "");
        // Restrict to a small Latin set so the path is shell-safe (the user
        // pastes it into the terminal as-is) and filesystem-portable.
        // Anything else is collapsed to underscore.
        const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
        if (!cleaned) return "file";
        // Preserve the extension up to a max stem length so names stay
        // readable in `ls` and don't blow past common filesystem limits.
        const MAX_LEN = 80;
        if (cleaned.length <= MAX_LEN) return cleaned;
        const dot = cleaned.lastIndexOf(".");
        if (dot < 0 || dot >= cleaned.length - 1) return cleaned.slice(0, MAX_LEN);
        const ext = cleaned.slice(dot).slice(0, 16); // also cap extension
        return cleaned.slice(0, MAX_LEN - ext.length) + ext;
}

// Parse the Docker multiplexed stream format used when Tty:false.
// Frame layout: [type(1)][pad(3)][size(4 BE)] followed by `size` payload bytes.
// type 1 = stdout, type 2 = stderr. We collect only the requested type.
function demuxDockerOutput(raw: Buffer, type: 1 | 2): string {
        const chunks: Buffer[] = [];
        let off = 0;
        while (off + 8 <= raw.length) {
                const frameType = raw[off]!;
                const size = raw.readUInt32BE(off + 4);
                off += 8;
                if (off + size > raw.length) break;
                if (frameType === type) chunks.push(raw.subarray(off, off + size));
                off += size;
        }
        return Buffer.concat(chunks).toString("utf-8");
}
