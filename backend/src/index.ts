/**
 * index.ts — Server entry point.
 *
 * Backend-only server.  Frontend is hosted on Cloudflare Pages.
 * Database is Cloudflare D1 (accessed via HTTP API).
 */

import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import {
        ensureAuthReady,
        isAllowedWsOrigin,
        parseCorsOrigins,
        selectWsAuthProtocol,
        validateJwtSecret,
        warnIfWildcardCorsInProduction,
} from "./auth.js";
import { migrateDb, validateD1Config } from "./db.js";
import { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import { SessionManager } from "./sessionManager.js";
import { parseTrustProxy, TrustProxyError, warnIfProductionMisconfigured } from "./trustProxy.js";
import { endUpgradeSocketWithReply, handleWsConnection } from "./wsHandler.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);
// Trim+filter so that the obvious human-readable format
// `CORS_ORIGINS="https://a, https://b"` doesn't silently fail the
// exact-match check in isAllowedWsOrigin (leading space on the second
// entry would never equal the browser-sent Origin). Also applies to
// the HTTP CORS middleware below — same allowlist, same parse.
const CORS_ORIGINS = parseCorsOrigins(process.env.CORS_ORIGINS);
// TRUST_PROXY: used by req.ip (and therefore auth rate limiting) to pick the
// real client from X-Forwarded-For instead of the tunnel's socket address.
// See trustProxy.ts for the full set of accepted values. "true" is refused
// because Express then picks the leftmost (attacker-controlled) XFF entry.
const TRUST_PROXY_RAW = process.env.TRUST_PROXY;

// ── Validate config ───────────────────────────────────────────────────────────

validateD1Config();
validateJwtSecret();

// Warn early if NODE_ENV=production but TRUST_PROXY is unset — a likely
// misconfig where per-IP rate limits collapse into a single bucket. Runs
// before the parse so the warning fires even on unset (which is not an
// error, just a smell in production).
warnIfProductionMisconfigured(TRUST_PROXY_RAW, process.env.NODE_ENV);
// Related warning: if CORS_ORIGINS is "*" in production, the HTTP CORS
// layer is happy but the WebSocket upgrade handler below will refuse
// every Origin. Surface this at boot so an operator sees the reason
// for "why won't my WebSocket connect" in the same place they'd look
// for the TRUST_PROXY warning.
warnIfWildcardCorsInProduction(CORS_ORIGINS, process.env.NODE_ENV);

// Parse upfront so a bad value fails the process immediately rather than
// silently serving traffic with req.ip derived from the wrong source.
let trustProxyValue: boolean | number | string | undefined;
try {
        trustProxyValue = parseTrustProxy(TRUST_PROXY_RAW);
} catch (err) {
        if (err instanceof TrustProxyError) {
                console.error("[server]", err.message);
                process.exit(1);
        }
        throw err;
}

// ── Singletons ────────────────────────────────────────────────────────────────

const sessions = new SessionManager();
const docker = new DockerManager(sessions);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
if (trustProxyValue !== undefined) {
        app.set("trust proxy", trustProxyValue);
        // Log the effective value so ops can spot a misconfigured prod
        // (e.g. TRUST_PROXY=0 behind a tunnel would silently collapse
        // per-IP rate limits into one bucket).
        console.log(`[server] trust proxy = ${JSON.stringify(trustProxyValue)}`);
} else {
        console.log("[server] trust proxy = unset (req.ip will be the socket address)");
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
                // socket.end() drains the write buffer before closing, so the
                // 404 line actually reaches the client. socket.write() +
                // socket.destroy() (the previous form) issues immediate
                // teardown with no drain guarantee — the status line can be
                // dropped, making "why did my WS fail" harder to debug.
                // The bounded-destroy timer in endUpgradeSocketWithReply
                // closes the CLOSE_WAIT window a half-close otherwise opens
                // up against a peer that never FINs (#67).
                endUpgradeSocketWithReply(socket, "HTTP/1.1 404 Not Found\r\n\r\n");
                return;
        }

        // CSWSH defence: reject the upgrade BEFORE the handshake completes
        // when the Origin header isn't allowed. Done here (not inside the
        // `wss.on("connection")` handler) so a rejected origin never gets
        // a WebSocket object, never runs verifyWsToken, and never appears
        // in wss.clients — closes the window where a CSWSH'd socket could
        // do anything observable before the server hung up.
        //
        // See isAllowedWsOrigin in auth.ts for the policy (in particular:
        // missing Origin is allowed because it indicates non-browser
        // clients, and "*" in CORS_ORIGINS is denied in production).
        //
        // No per-request log on rejection: an attacker can flood the upgrade
        // handler with garbage Origin headers and drown out signal. The
        // CORS_ORIGINS=* case is already covered by warnIfWildcardCorsIn-
        // Production at startup; deliberate operator misconfiguration will
        // surface through the 403 status code + the boot warning, not
        // through per-request log spam.
        if (!isAllowedWsOrigin(req.headers.origin, CORS_ORIGINS, process.env.NODE_ENV)) {
                endUpgradeSocketWithReply(socket, "HTTP/1.1 403 Forbidden\r\n\r\n");
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
        // Wait for the timing-parity dummy bcrypt hash to finish computing
        // before accepting requests. Without this, the first unknown-user
        // login would block on the ~2^BCRYPT_ROUNDS-ms hash computation,
        // producing a latency signal distinguishable from a known-user
        // login (which short-circuits the dummy path) — exactly the
        // timing leak the dummy is supposed to prevent.
        await ensureAuthReady();

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

// SIGTERM/SIGINT can fire twice (e.g. docker compose down then Ctrl-C). The
// second invocation should skip teardown — wss.close() is idempotent but
// `server.close()` throws ERR_SERVER_NOT_RUNNING on re-entry.
let shuttingDown = false;

function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("[server] shutting down…");

        // Actively close live WS clients. `wss.close()` alone only stops accepting
        // new upgrades — existing connections stay open, which keeps `server.close()`
        // hanging on its keepalive-held sockets until the OS eventually kills the
        // process. Send 1001 ("going away") so the browser surfaces a clean reason
        // rather than "connection error".
        for (const client of wss.clients) {
                try { client.close(1001, "server shutting down"); } catch { /* already closed */ }
        }
        wss.close();

        // Watchdog: if a client stalls its close handshake (or some other handle
        // keeps the event loop alive), exit anyway after a grace period instead of
        // hanging the orchestrator's stop timeout.
        const watchdog = setTimeout(() => {
                console.warn("[server] shutdown watchdog fired — forcing exit");
                process.exit(1);
        }, 10_000);
        watchdog.unref();

        server.close(() => {
                clearTimeout(watchdog);
                process.exit(0);
        });
}
