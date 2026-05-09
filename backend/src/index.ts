/**
 * index.ts — Server entry point.
 *
 * Backend-only server.  Frontend is hosted on Cloudflare Pages.
 * Database is Cloudflare D1 (accessed via HTTP API).
 */

import http from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import { WebSocketServer } from "ws";
import {
	ensureAuthReady,
	isAllowedWsOrigin,
	originMatches,
	parseCorsOrigins,
	validateJwtSecret,
	warnIfWildcardCorsInProduction,
} from "./auth.js";
import { BootstrapBroadcaster } from "./bootstrap.js";
import { migrateDb, validateD1Config } from "./db.js";
import { DockerManager } from "./dockerManager.js";
import { logger } from "./logger.js";
import { buildRouter } from "./routes.js";
import { SessionManager } from "./sessionManager.js";
import { parseTrustProxy, TrustProxyError, warnIfProductionMisconfigured } from "./trustProxy.js";
import { endUpgradeSocketWithReply, handleWsConnection, startWsHeartbeat } from "./wsHandler.js";

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
		logger.error(`[server] ${err.message}`);
		process.exit(1);
	}
	throw err;
}

// ── Singletons ────────────────────────────────────────────────────────────────

const sessions = new SessionManager();
const docker = new DockerManager(sessions);
// Single shared bootstrap broadcaster (PR 185b2b). Owned at the server
// scope so the route's runAsyncBootstrap and the WS handler's
// /ws/bootstrap subscriber see the same per-session listener sets and
// buffered output. Process-local — a load-balanced multi-backend deploy
// would lose live-tail bytes when the WS lands on a different replica
// than the one running the hook; that's documented as a single-replica
// constraint of the hook runner, same as the terminal-attach path.
const bootstrapBroadcaster = new BootstrapBroadcaster();

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
if (trustProxyValue !== undefined) {
	app.set("trust proxy", trustProxyValue);
	// Log the effective value so ops can spot a misconfigured prod
	// (e.g. TRUST_PROXY=0 behind a tunnel would silently collapse
	// per-IP rate limits into one bucket).
	logger.info(`[server] trust proxy = ${JSON.stringify(trustProxyValue)}`);
} else {
	logger.info("[server] trust proxy = unset (req.ip will be the socket address)");
}
app.use(express.json());
// Populates `req.cookies` from the Cookie header. requireAuth reads the
// JWT from `req.cookies.st_token` (#18). No `secret` is passed because we
// don't use signed cookies — the JWT itself is the integrity-protected
// payload, and signing the cookie wrapping it would be redundant.
app.use(cookieParser());

// CORS — allow frontend from Cloudflare Pages (or any configured origin).
//
// Cookie-based auth (#18) requires:
//   - `Access-Control-Allow-Credentials: true`, so the browser is willing
//     to send the cookie cross-origin.
//   - A specific `Access-Control-Allow-Origin` echoing the request's
//     origin — `*` is illegal alongside credentials and the browser
//     refuses the response. We never echo `*` here.
//
// `Authorization` is no longer in `Allow-Headers` because the frontend
// never sends one — auth travels in the cookie and there's no read path
// for the frontend that needs to inspect or set it.
app.use((_req, res, next) => {
	// `Vary: Origin` set unconditionally so an intermediate cache can't
	// serve a same-origin (no-CORS) cached response to a cross-origin
	// client, which would arrive without `Access-Control-Allow-Origin`
	// and trip the browser's same-origin block. No CDN sits in front of
	// the tunnel today; this is hardening for the moment one is added.
	res.setHeader("Vary", "Origin");
	const origin = _req.headers.origin ?? "";
	// `Access-Control-Allow-Credentials: true` is only safe when the
	// caller's origin is in our allowlist (exact or single-label glob —
	// see originMatches). Cookie auth means
	// the browser auto-attaches the cookie on credentialed requests —
	// echoing `Allow-Credentials` for an arbitrary origin would let any
	// page on the internet make authenticated calls and read the
	// responses. Wildcard config (`CORS_ORIGINS=*`) falls back to a
	// plain wildcard, no credentials: cross-origin callers get the
	// cookie dropped by the browser and effectively a 401 from the
	// auth middleware, while the wildcard still answers public reads.
	if (origin && originMatches(origin, CORS_ORIGINS)) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Access-Control-Allow-Credentials", "true");
	} else if (CORS_ORIGINS.includes("*")) {
		res.setHeader("Access-Control-Allow-Origin", "*");
	}
	res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PATCH,OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (_req.method === "OPTIONS") {
		res.sendStatus(204);
		return;
	}
	next();
});

app.use(
	"/api",
	// `undefined` for rateLimitConfig — buildRouter falls back to
	// DEFAULT_RATE_LIMIT_CONFIG. Threading the broadcaster through is
	// the only reason this call moved off the one-liner.
	buildRouter(sessions, docker, undefined, bootstrapBroadcaster),
);
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);
// Auth lands via the request's Cookie header (#18) — no protocol selection
// is needed for auth purposes, so handleProtocols is dropped along with
// the `auth.bearer.<jwt>` subprotocol convention.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = req.url ?? "";
	if (!url.startsWith("/ws/sessions/") && !url.startsWith("/ws/bootstrap/")) {
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
	// No per-request log in PRODUCTION: an attacker can flood the
	// upgrade handler with garbage Origin headers and drown out signal.
	// The CORS_ORIGINS=* case is already covered by warnIfWildcard-
	// CorsInProduction at startup; deliberate operator misconfiguration
	// surfaces through the 403 status code + the boot warning, not
	// through per-request log spam. In dev/staging we DO log (gated
	// below) so an operator deploying a typo'd Origin can grep for it.
	if (!isAllowedWsOrigin(req.headers.origin, CORS_ORIGINS, process.env.NODE_ENV)) {
		// Dev/staging only: see the block comment above and issue #66.
		if (process.env.NODE_ENV !== "production") {
			logger.info(
				"[ws] rejecting upgrade: Origin=%s not in allowlist %j",
				req.headers.origin ?? "<absent>",
				CORS_ORIGINS,
			);
		}
		endUpgradeSocketWithReply(socket, "HTTP/1.1 403 Forbidden\r\n\r\n");
		return;
	}

	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

// Liveness heartbeat (#79). The helper sets the per-connection `pong`
// listener and runs the 30 s interval; we keep the cleanup so the
// shutdown path can stop the timer before `wss.close()` to avoid
// racing teardown.
const stopHeartbeat = startWsHeartbeat(wss, 30_000);

wss.on("connection", (ws, req) => {
	handleWsConnection(ws, req, sessions, docker, bootstrapBroadcaster);
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
		logger.info(`[server] listening on http://localhost:${PORT}`);
		logger.info(`[server] WebSocket: ws://localhost:${PORT}/ws/sessions/:id`);
		logger.info(`[server] CORS origins: ${CORS_ORIGINS.join(", ")}`);
		logger.info(`[server] Database: Cloudflare D1`);
	});
}

start().catch((err) => {
	logger.error(`[server] failed to start: ${err}`);
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
	logger.info("[server] shutting down…");

	// Stop the heartbeat first so it doesn't try to ping a half-closed
	// client during teardown (would race with the close calls below).
	stopHeartbeat();

	// Actively close live WS clients. `wss.close()` alone only stops accepting
	// new upgrades — existing connections stay open, which keeps `server.close()`
	// hanging on its keepalive-held sockets until the OS eventually kills the
	// process. Send 1001 ("going away") so the browser surfaces a clean reason
	// rather than "connection error".
	for (const client of wss.clients) {
		try {
			client.close(1001, "server shutting down");
		} catch {
			/* already closed */
		}
	}
	wss.close();

	// Watchdog: if a client stalls its close handshake (or some other handle
	// keeps the event loop alive), exit anyway after a grace period instead of
	// hanging the orchestrator's stop timeout.
	const watchdog = setTimeout(() => {
		logger.warn("[server] shutdown watchdog fired — forcing exit");
		process.exit(1);
	}, 10_000);
	watchdog.unref();

	server.close(() => {
		clearTimeout(watchdog);
		process.exit(0);
	});
}
