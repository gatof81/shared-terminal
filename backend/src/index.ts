import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { SessionManager } from "./sessionManager.js";
import { PtyManager } from "./ptyManager.js";
import { buildRouter } from "./routes.js";
import { handleWsConnection } from "./wsHandler.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";

// ── Singletons ────────────────────────────────────────────────────────────────

const sessions = new SessionManager();
const ptys = new PtyManager(sessions);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

app.use(express.json());

// Permissive CORS for development — tighten for production.
app.use((_req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-User-Id");
        if (_req.method === "OPTIONS") {
                res.sendStatus(204);
                return;
        }
        next();
});

app.use("/api", buildRouter(sessions, ptys));

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);

// noServer: true — we manage the upgrade event ourselves so we can
// filter by path prefix before handing off to the WS server.
// If we passed { server } instead, ws would register its own 'upgrade'
// listener that fires before ours, then ours would call handleUpgrade a
// second time on an already-consumed socket → browser sees code 1006.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";
        if (!url.startsWith("/ws/sessions/")) {
                // Reject any upgrade not aimed at our WS endpoint (e.g. stray requests).
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit("connection", ws, req);
        });
});

wss.on("connection", (ws, req) => {
        handleWsConnection(ws, req, sessions, ptys);
});

server.listen(PORT, () => {
        console.log(`[server] listening on http://localhost:${PORT}`);
        console.log(`[server] WebSocket endpoint: ws://localhost:${PORT}/ws/sessions/:id`);
        console.log(`[server] Allowed CORS origin: ${FRONTEND_ORIGIN}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
        console.log("[server] shutting down…");
        wss.close();
        server.close(() => process.exit(0));
}
