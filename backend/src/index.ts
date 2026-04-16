/**
 * index.ts — Server entry point.
 *
 * Initialises the database, reconciles Docker state, and starts the
 * Express + WebSocket server.
 */

import http from "http";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";
import { getDb, closeDb } from "./db.js";
import { SessionManager } from "./sessionManager.js";
import { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import { handleWsConnection } from "./wsHandler.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",");

// ── Singletons ────────────────────────────────────────────────────────────────

// Initialise DB (creates tables on first run)
getDb();

const sessions = new SessionManager();
const docker = new DockerManager(sessions);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS
app.use((_req, res, next) => {
        const origin = _req.headers.origin ?? "";
        if (CORS_ORIGINS.includes(origin) || CORS_ORIGINS.includes("*")) {
                res.setHeader("Access-Control-Allow-Origin", origin);
        }
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PATCH,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
        if (_req.method === "OPTIONS") {
                res.sendStatus(204);
                return;
        }
        next();
});

// API routes
app.use("/api", buildRouter(sessions, docker));

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// In production, serve the frontend static build
const frontendDist = path.join(__dirname, "../../frontend/dist");
app.use(express.static(frontendDist));
app.get("*", (_req, res, next) => {
        // Only serve index.html for non-API, non-WS paths
        if (_req.path.startsWith("/api") || _req.path.startsWith("/ws") || _req.path === "/health") {
                next();
                return;
        }
        res.sendFile(path.join(frontendDist, "index.html"), (err) => {
                if (err) next();
        });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";
        if (!url.startsWith("/ws/sessions/")) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit("connection", ws, req);
        });
});

wss.on("connection", (ws, req) => {
        handleWsConnection(ws, req, sessions, docker);
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
        // Reconcile DB state with Docker reality (containers may have stopped
        // while the server was down).
        await docker.reconcile();

        server.listen(PORT, () => {
                console.log(`[server] listening on http://localhost:${PORT}`);
                console.log(`[server] WebSocket: ws://localhost:${PORT}/ws/sessions/:id`);
                console.log(`[server] CORS origins: ${CORS_ORIGINS.join(", ")}`);
        });
}

start().catch((err) => {
        console.error("[server] failed to start:", err);
        process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
        console.log("[server] shutting down…");
        wss.close();
        closeDb();
        server.close(() => process.exit(0));
}
