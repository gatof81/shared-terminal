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
// Set to the number of known hops in front of the backend — "1" for a
// single Cloudflare Tunnel. Leave unset for direct localhost dev.
//
// Do NOT set this to "true": Express then takes the LEFTMOST X-Forwarded-For
// entry, which is fully attacker-controlled. An attacker rotating
// `X-Forwarded-For: <random>` per request would bypass the per-IP limiter
// entirely. The hop count ("1", "2", …) picks the rightmost-untrusted
// address, which is the real client.
const TRUST_PROXY = process.env.TRUST_PROXY;

// ── Validate config ───────────────────────────────────────────────────────────

validateD1Config();

// ── Singletons ────────────────────────────────────────────────────────────────

const sessions = new SessionManager();
const docker = new DockerManager(sessions);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
if (TRUST_PROXY !== undefined) {
        // Env values are strings; Express accepts a number (hop count), a
        // boolean, or an IP/subnet list. Coerce "1" → 1, "false" → false,
        // otherwise pass through for IPs/subnets. "true" is coerced and
        // logged as a warning — see the security note above const
        // TRUST_PROXY for why it's unsafe on a public endpoint.
        let coerced: number | boolean | string;
        if (/^\d+$/.test(TRUST_PROXY)) coerced = Number(TRUST_PROXY);
        else if (TRUST_PROXY === "true") coerced = true;
        else if (TRUST_PROXY === "false") coerced = false;
        else coerced = TRUST_PROXY;
        if (coerced === true) {
                console.warn(
                        "[server] TRUST_PROXY=true is UNSAFE: Express will take the leftmost " +
                        "X-Forwarded-For entry (attacker-controlled), which bypasses per-IP " +
                        "rate limiting on /auth. Use a hop count like '1' instead.",
                );
        }
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
