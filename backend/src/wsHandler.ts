import { IncomingMessage } from "http";
import { WebSocket } from "ws";
import { extractUserId, extractUserIdFromUrl } from "./auth.js";
import { SessionManager, NotFoundError, ForbiddenError } from "./sessionManager.js";
import { PtyManager } from "./ptyManager.js";
import { WsClientMessage, WsServerMessage } from "./types.js";

/**
 * wsHandler — called for every new WebSocket connection on /ws/sessions/:id
 *
 * Protocol (all messages are JSON):
 *
 *   Client → Server:
 *     { type: "input",  data: "<string>" }
 *     { type: "resize", cols: number, rows: number }
 *     { type: "ping" }
 *
 *   Server → Client:
 *     { type: "output", data: "<string>" }     — PTY output (incl. replay)
 *     { type: "status", status: "..." }        — session status changes
 *     { type: "pong" }                         — heartbeat response
 *     { type: "error", message: "..." }        — fatal errors (ws closed after)
 */
export function handleWsConnection(
        ws: WebSocket,
        req: IncomingMessage,
        sessions: SessionManager,
        ptys: PtyManager,
): void {
        // ── Resolve session id from URL ────────────────────────────────────────────
        const url = req.url ?? "";
        const match = url.match(/\/ws\/sessions\/([^/?#]+)/);
        if (!match) {
                sendError(ws, "Invalid WebSocket path");
                ws.close(1008, "Invalid path");
                return;
        }
        const sessionId = match[1];

        // ── Authenticate ───────────────────────────────────────────────────────────
        // Try header first (curl / server-to-server), fall back to ?userId= query
        // param which is the only option for browser WebSocket clients.
        const userId =
                extractUserId(req.headers as Record<string, string | string[] | undefined>) ??
                extractUserIdFromUrl(req.url);
        if (!userId) {
                sendError(ws, "Missing or invalid user identity (X-User-Id header or ?userId= param)");
                ws.close(1008, "Unauthorized");
                return;
        }

        // ── Authorise ──────────────────────────────────────────────────────────────
        let session;
        try {
                session = sessions.assertOwnership(sessionId, userId);
        } catch (err) {
                if (err instanceof NotFoundError) {
                        sendError(ws, "Session not found");
                        ws.close(1008, "Not found");
                } else if (err instanceof ForbiddenError) {
                        sendError(ws, "Access denied");
                        ws.close(1008, "Forbidden");
                } else {
                        sendError(ws, "Internal error");
                        ws.close(1011, "Internal error");
                }
                return;
        }

        if (session.status === "terminated") {
                sendError(ws, "Session is terminated");
                ws.close(1008, "Session terminated");
                return;
        }

        // ── Ensure PTY is alive (respawn is NOT done automatically — session ──────
        // stays disconnected if the process exited).                                 
        if (!ptys.isAlive(sessionId)) {
                sessions.updateStatus(sessionId, "disconnected");
                sendMsg(ws, { type: "status", status: "disconnected" });
                // We still allow the client to connect — the session metadata is intact.
                // The operator would need to explicitly terminate & recreate.
                ws.close(1011, "PTY process is no longer running");
                return;
        }

        // ── Attach listener ────────────────────────────────────────────────────────
        sessions.updateConnected(sessionId);
        sendMsg(ws, { type: "status", status: "running" });

        const outputListener = (data: string) => {
                sendMsg(ws, { type: "output", data });
        };

        // attach() returns buffered output for replay — send it before live stream.
        const replay = ptys.attach(sessionId, outputListener);
        if (replay) {
                sendMsg(ws, { type: "output", data: replay });
        }

        console.log(`[ws] user=${userId} attached to session=${sessionId}`);

        // ── Message handler ────────────────────────────────────────────────────────
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
                                ptys.write(sessionId, msg.data);
                                break;

                        case "resize":
                                if (
                                        typeof msg.cols === "number" &&
                                        typeof msg.rows === "number" &&
                                        msg.cols > 0 &&
                                        msg.rows > 0
                                ) {
                                        ptys.resize(sessionId, msg.cols, msg.rows);
                                }
                                break;

                        case "ping":
                                sendMsg(ws, { type: "pong" });
                                break;

                        default:
                                // Unknown message types are silently ignored for forward-compatibility.
                                break;
                }
        });

        // ── Disconnect handler ─────────────────────────────────────────────────────
        ws.on("close", () => {
                console.log(`[ws] user=${userId} detached from session=${sessionId}`);
                ptys.detach(sessionId, outputListener);
                // Only mark as disconnected if PTY is still running (otherwise it's "terminated").
                const current = sessions.get(sessionId);
                if (current && current.status === "running") {
                        sessions.updateStatus(sessionId, "disconnected");
                }
        });

        ws.on("error", (err) => {
                console.error(`[ws] error on session=${sessionId}:`, err.message);
                ptys.detach(sessionId, outputListener);
        });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendMsg(ws: WebSocket, msg: WsServerMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg));
        }
}

function sendError(ws: WebSocket, message: string): void {
        sendMsg(ws, { type: "error", message });
}
