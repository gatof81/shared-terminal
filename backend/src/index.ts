/**
 * index.ts — Server entry point.
 *
 * Backend-only server.  Frontend is hosted on Cloudflare Pages.
 * Database is Cloudflare D1 (accessed via HTTP API).
 */

import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { validateD1Config, migrateDb } from "./db.js";
import { SessionManager } from "./sessionManager.js";
import { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import { handleWsConnection } from "./wsHandler.js";
import { selectWsAuthProtocol } from "./auth.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "*").split(",");
// TRUST_PROXY: used by req.ip (and therefore auth rate limiting) to pick the
// real client from X-Forwarded-For instead of the tunnel's socket address.
// Set to "1" for a single known proxy (e.g. Cloudflare Tunnel), a count, or
// "true" to trust everything. Leave unset for direct localhost dev.
const TRUST_PROXY = process.env.TRUST_PROXY;

// ── Validate config ───────────────────────────────────────────────────────────

validateD1Config();

// ── Singletons ────────────────────────────────────────────────────────────────

const sessions = new SessionManager();
const docker = new DockerManager(sessions);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
if (TRUST_PROXY !== undefined) {
        // Express accepts a boolean, a number (hop count), or a string/fn
        // describing which IPs to trust. Environment values are always
        // strings, so coerce "1" → 1, "true" → true, "false" → false
        // explicitly; anything else (IPs, subnets, "loopback", …) passes
        // through unchanged. Load-bearing for /auth rate limiting — without
        // it, req.ip behind a tunnel is always the tunnel's IP so per-IP
        // buckets collapse into one.
        let coerced: number | boolean | string;
        if (/^\d+$/.test(TRUST_PROXY)) coerced = Number(TRUST_PROXY);
        else if (TRUST_PROXY === "true") coerced = true;
        else if (TRUST_PROXY === "false") coerced = false;
        else coerced = TRUST_PROXY;
        app.set("trust proxy", coerced);
}
app.use(express.json());

// CORS — allow frontend from Cloudflare Pages (or any configured origin)
app.use((_req, res, next) => {
        const origin = _req.headers.origin ?? "";
        if (CORS_ORIGINS.includes("*") || CORS_ORIGINS.includes(origin)) {
                res.setHeader("Access-Control-Allow-Origin", origin || "*");
        }
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PATCH,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
        if (_req.method === "OPTIONS") {
                res.sendStatus(204);
                return;
        }
        next();
});

app.use("/api", buildRouter(sessions, docker));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => selectWsAuthProtocol(protocols),
});

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
        await migrateDb();
        await docker.reconcile();

        server.listen(PORT, () => {
                console.log(`[server] listening on http://localhost:${PORT}`);
                console.log(`[server] WebSocket: ws://localhost:${PORT}/ws/sessions/:id`);
                console.log(`[server] CORS origins: ${CORS_ORIGINS.join(", ")}`);
                console.log(`[server] Database: Cloudflare D1`);
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
        server.close(() => process.exit(0));
}
