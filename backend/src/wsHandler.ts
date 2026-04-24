/**
 * wsHandler.ts — WebSocket connection handler for Docker-based sessions.
 */

import { IncomingMessage } from "http";
import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import { verifyWsToken } from "./auth.js";
import { SessionManager, NotFoundError, ForbiddenError } from "./sessionManager.js";
import { DockerManager } from "./dockerManager.js";
import { WsClientMessage, WsServerMessage } from "./types.js";

export function handleWsConnection(
        ws: WebSocket,
        req: IncomingMessage,
        sessions: SessionManager,
        docker: DockerManager,
): void {
        // Synchronous safety net registered BEFORE any await or sync ws.close().
        // Node's EventEmitter routes an 'error' emission with no listener to
        // process.emit('uncaughtException') → the whole server process dies,
        // dropping every other attached session. The `ws` package emits
        // 'error' on transport-level failures — RSTd TCP, malformed frames,
        // invalid UTF-8 — any of which can land during the handshake/close
        // dance or during the two awaits below (sessions.assertOwnership,
        // docker.attach). A second ws.on('error', …) is added after attach()
        // succeeds to also tear the exec down; `on` is additive, so both run.
        // See issue #91 for the DoS reproduction path.
        ws.on("error", (err) => {
                console.error(`[ws] socket error: ${err.message}`);
                // Don't trust the transport to always emit 'close' after
                // 'error'. Some failure modes (RSTd TCP mid-handshake, upgrade
                // parse error before the WS protocol is fully up) leave the
                // underlying socket half-open until Node's GC notices. Close
                // explicitly with 1011 "internal error"; ws.close() is a no-op
                // on a socket already CLOSING/CLOSED, so this is safe for
                // post-attach errors where the inner 'close' listener would
                // also run.
                ws.close(1011, "socket error");
        });


        const url = req.url ?? "";
        const match = url.match(/\/ws\/sessions\/([^/?#]+)/);
        if (!match) {
                sendError(ws, "Invalid WebSocket path");
                ws.close(1008, "Invalid path");
                return;
        }
        const sessionId = match[1]!;

        // Required ?tab=<tabId>. The container no longer creates a default tab
        // at boot, so every WS attach must name its target explicitly. Strict
        // charset: tmux session names + our own prefix; no shell metas
        // (docker exec takes argv, not a shell line, but a defensive allowlist
        // keeps surprising tmux targets like "main:1" out of the path).
        const tabQueryMatch = url.match(/[?&]tab=([^&#]+)/);
        const rawTab = tabQueryMatch ? decodeURIComponent(tabQueryMatch[1]!) : null;
        if (rawTab === null) {
                sendError(ws, "Missing tab id");
                ws.close(1008, "Missing tab");
                return;
        }
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(rawTab)) {
                sendError(ws, "Invalid tab id");
                ws.close(1008, "Invalid tab");
                return;
        }
        const tabId = rawTab;

        const payload = verifyWsToken(req.headers["sec-websocket-protocol"], req.url);
        if (!payload) {
                sendError(ws, "Missing or invalid token");
                ws.close(1008, "Unauthorized");
                return;
        }
        const userId = payload.sub;

        // Async auth + attach flow
        (async () => {
                // Authorise
                const session = await sessions.assertOwnership(sessionId, userId);

                if (session.status === "terminated") {
                        sendError(ws, "Session is terminated");
                        ws.close(1008, "Session terminated");
                        return;
                }

                // Attach to Docker container
                const attachId = `${sessionId}:${uuidv4().slice(0, 8)}`;
                const outputListener = (data: string) => {
                        sendMsg(ws, { type: "output", data });
                };

                // attach() hands back `flushTail` — until we call it, the listener
                // installed inside attach() piles incoming live bytes into a local
                // array instead of forwarding them. This lets us guarantee the
                // on-the-wire order is [replay][live], even on a noisy session
                // where bytes stream in between attach() returning and this
                // function sending the replay frame. See attach() for the full
                // rationale. `sendMsg` is synchronous, so there is no await
                // between the replay frame and flushTail() — a stream 'data'
                // event cannot interleave.
                const { replay, flushTail } = await docker.attach(
                        sessionId, attachId, session.cols, session.rows, outputListener, tabId,
                );

                sendMsg(ws, { type: "status", status: "running" });
                if (replay) {
                        sendMsg(ws, { type: "output", data: replay });
                }
                flushTail();

                console.log(`[ws] user=${userId} attached to session=${sessionId} tab=${tabId} (exec=${attachId})`);

                // Message handler
                ws.on("message", (raw) => {
                        let msg: WsClientMessage;
                        try {
                                msg = JSON.parse(raw.toString()) as WsClientMessage;
                        } catch {
                                sendError(ws, "Invalid JSON");
                                return;
                        }

                        switch (msg.type) {
                                case "input":
                                        docker.write(attachId, msg.data);
                                        break;
                                case "resize":
                                        if (msg.cols > 0 && msg.rows > 0) {
                                                docker.resize(attachId, msg.cols, msg.rows).catch(() => { });
                                        }
                                        break;
                                case "ping":
                                        sendMsg(ws, { type: "pong" });
                                        break;
                        }
                });

                ws.on("close", () => {
                        console.log(`[ws] user=${userId} detached from session=${sessionId}`);
                        docker.detach(attachId);
                });

                ws.on("error", (err) => {
                        console.error(`[ws] error on session=${sessionId}:`, err.message);
                        docker.detach(attachId);
                });
        })().catch((err) => {
                if (err instanceof NotFoundError) {
                        sendError(ws, "Session not found");
                        ws.close(1008, "Not found");
                } else if (err instanceof ForbiddenError) {
                        sendError(ws, "Access denied");
                        ws.close(1008, "Forbidden");
                } else {
                        console.error(`[ws] attach failed for session=${sessionId}:`, (err as Error).message);
                        sendError(ws, `Failed to attach: ${(err as Error).message}`);
                        ws.close(1011, "Attach failed");
                }
        });
}

function sendMsg(ws: WebSocket, msg: WsServerMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg));
        }
}

function sendError(ws: WebSocket, message: string): void {
        sendMsg(ws, { type: "error", message });
}
