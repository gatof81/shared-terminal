/**
 * index.ts — Server entry point.
 *
 * Backend-only server.  Frontend is hosted on Cloudflare Pages.
 * Database is Cloudflare D1 (accessed via HTTP API).
 */

import http from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
import {
	ensureAuthReady,
	isAllowedWsOrigin,
	originMatches,
	parseCorsOrigins,
	resolveCookieDomain,
	validateJwtSecret,
	warnIfWildcardCorsInProduction,
} from "./auth.js";
import { BootstrapBroadcaster } from "./bootstrap.js";
import { migrateDb, validateD1Config } from "./db.js";
import { DockerManager } from "./dockerManager.js";
import { IdleSweeper, listRunningSessionIds } from "./idleSweeper.js";
import { logger } from "./logger.js";
import { createPortDispatcher, validatePortProxyBaseDomain } from "./portDispatcher.js";
import { buildRouter } from "./routes.js";
import { validateSecretsKey } from "./secrets.js";
import { SessionManager } from "./sessionManager.js";
import { parseTrustProxy, TrustProxyError, warnIfProductionMisconfigured } from "./trustProxy.js";
import { endUpgradeSocketWithReply, handleWsConnection, startWsHeartbeat } from "./wsHandler.js";
import { createWsUpgradeRateLimiter, resolveClientIp } from "./wsUpgradeRateLimit.js";

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
// Refuse to start without SECRETS_ENCRYPTION_KEY (#186). Mirrors the
// validateD1Config / validateJwtSecret pattern: better to crash on
// boot with a clear error than to start, accept a `secret`-typed env
// var via POST /sessions, fail to encrypt at persist time, and either
// store the plaintext (data leak) or 500 the create. Operator runbook
// for key generation + rotation lives in #204.
validateSecretsKey();

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

// Idle-auto-stop sweeper. Bumped by every WS byte / resize and every
// /api/sessions/:id REST hit; sweeps every 60 s and soft-stops sessions
// whose `idle_ttl_seconds` has elapsed. In-memory state only — the
// boot path seeds `now()` for each currently-running session below
// so the first sweep doesn't reap a session whose users haven't
// reconnected yet (the previous backend's bumps are gone). Process-
// local — a load-balanced multi-backend deploy would lose the
// activity signal when traffic lands on a different replica; that's
// the same single-replica constraint the BootstrapBroadcaster has.
const idleSweeper = new IdleSweeper({
	stopContainer: (sessionId) => docker.stopContainer(sessionId),
});

// #190 PR 190c — port-exposure dispatcher. Resolves Host:
// `p<container>-<sessionId>.<base>` to the runtime mapping in
// `sessions_port_mappings` and reverse-proxies to 127.0.0.1:<host_port>.
// Unset PORT_PROXY_BASE_DOMAIN → dispatcher is a no-op middleware so
// dev/local without a Tunnel keeps working. Logged once here so the
// unset case is visible at boot.
const PORT_PROXY_BASE_DOMAIN = validatePortProxyBaseDomain(process.env.PORT_PROXY_BASE_DOMAIN);
if (PORT_PROXY_BASE_DOMAIN) {
	logger.info(`[server] port dispatcher enabled at *.${PORT_PROXY_BASE_DOMAIN}`);
	// PR #223 round 6 SHOULD-FIX. With port exposure on, the JWT
	// cookie must traverse from the API's hostname to the per-
	// session subdomains; without `COOKIE_DOMAIN` set to a shared
	// parent, RFC 6265 §5.3 host-only scoping makes private-port
	// auth structurally non-functional. Warn (not refuse) because
	// some deployments may share a hostname with the dispatcher
	// (the only topology the cookie's default scoping covers) and
	// don't need this knob.
	//
	// Three states to distinguish so the operator gets actionable
	// signal instead of silent failure (PR #223 round 7 SHOULD-FIX):
	//   - Unset / empty   → "set it" warning.
	//   - Non-empty, malformed (typo) → "your value failed validation"
	//                                   warning, with the offending
	//                                   value echoed back.
	//   - Non-empty, valid → silent (logged via the success path).
	const rawCookieDomain = process.env.COOKIE_DOMAIN?.trim();
	if (!rawCookieDomain) {
		logger.warn(
			"[server] PORT_PROXY_BASE_DOMAIN is set but COOKIE_DOMAIN is unset — private-port auth will fail in any deployment where the API and dispatcher live on different hostnames (host-only cookie won't reach the dispatcher's subdomains). See .env.example.",
		);
	} else if (resolveCookieDomain(rawCookieDomain) === null) {
		logger.warn(
			`[server] COOKIE_DOMAIN=${JSON.stringify(rawCookieDomain)} failed validation — cookie will be set host-only and private-port auth will fail. Expected a parent domain like 'terminal.example.com'. See .env.example.`,
		);
	}
} else {
	logger.info(
		"[server] PORT_PROXY_BASE_DOMAIN unset — port-exposure dispatcher disabled (set to *.<base> to enable)",
	);
}
const portDispatcher = createPortDispatcher({
	baseDomain: PORT_PROXY_BASE_DOMAIN,
	// CSWSH defence on the WS upgrade path mirrors what the
	// /ws/sessions handler below does — same allowlist, same
	// `isAllowedWsOrigin` policy. See `handleUpgrade` in
	// portDispatcher.ts for the rationale.
	corsOrigins: CORS_ORIGINS,
	nodeEnv: process.env.NODE_ENV,
});

// #190 PR 190c — per-IP upgrade rate limiter for the dispatcher's
// WS path. Express's `dispatcherLimiter` only sees HTTP requests;
// upgrade events bypass the middleware chain entirely. Without
// this, a bot sending upgrade frames with no Origin header (which
// `isAllowedWsOrigin` allows for non-browser callers like webhook
// senders) reaches `lookupDispatchTarget` per attempt — uncapped
// D1 budget burn. 60/min/IP is tighter than the HTTP 300/min
// because each upgrade is more expensive and legitimate clients
// open far fewer. PR #223 round 4 SHOULD-FIX.
const dispatcherWsUpgradeLimiter = createWsUpgradeRateLimiter({
	windowMs: 60 * 1000,
	max: 60,
});

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
// #190 PR 190c — in-process rate limit on the dispatcher namespace.
// The dispatcher costs at minimum one D1 round-trip per request
// (lookupDispatchTarget) and `public: true` ports are intentionally
// unauthenticated — without a backstop, an attacker who learns the
// host shape can flood D1 indefinitely (and hammer the container app
// behind a public port). Cloudflare Tunnel can supply WAF rules at
// the edge, but this is the in-process belt-and-braces for any
// deployment without that layer configured. `skip` short-circuits
// every non-dispatcher request so /api / /health are unaffected;
// `isDispatcherHost` shares the same parser the dispatch decision
// uses so the limiter and the dispatcher stay in lockstep. WS
// upgrades bypass Express middleware entirely (handled in the
// `server.on('upgrade')` event below), so this limiter applies only
// to HTTP — WS rate-limit is a future follow-up if it bites. Mounted
// BEFORE the dispatcher so a 429 short-circuits before any D1 call.
// PR #223 round 3 SHOULD-FIX.
const dispatcherLimiter = rateLimit({
	windowMs: 60 * 1000,
	limit: 300,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	skip: (req) => !portDispatcher.isDispatcherHost(req.headers.host),
	message: {
		error: "Too many requests to port dispatcher, please slow down.",
		scope: "dispatcher",
	},
});
app.use(dispatcherLimiter);
// #190 PR 190c — dispatcher mounts BEFORE json/cookieParser/CORS so a
// proxied container request reaches `proxy.web()` with its body stream
// intact (express.json would otherwise consume it) and without an
// `Access-Control-Allow-Origin: <our origin>` header overlaying whatever
// CORS the container app wants to set. The dispatcher reads the raw
// `Cookie` header itself for auth gating on `public: false` ports —
// see `extractAuthToken` in portDispatcher.ts.
app.use((req, res, next) => portDispatcher.middleware(req, res, next));
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
	res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (_req.method === "OPTIONS") {
		res.sendStatus(204);
		return;
	}
	next();
});

// Threading the broadcaster through as the third positional arg —
// rateLimitConfig defaults to DEFAULT_RATE_LIMIT_CONFIG. Required
// (not optional) on buildRouter so a future caller that omits it
// surfaces as a TypeScript error rather than a silently-dropped
// postCreate hook (PR #208 round 1 review).
app.use("/api", buildRouter(sessions, docker, bootstrapBroadcaster, undefined, idleSweeper));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);
// Auth lands via the request's Cookie header (#18) — no protocol selection
// is needed for auth purposes, so handleProtocols is dropped along with
// the `auth.bearer.<jwt>` subprotocol convention.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	// #190 PR 190c — rate-limit dispatcher upgrades before any D1 work
	// or `proxy.ws()` allocation. `isDispatcherHost` uses the same host
	// parser the dispatch decision uses, so the limiter and the dispatch
	// gate stay in lockstep. `socket.remoteAddress` is the bucket key
	// (X-Forwarded-For parsing happens later at the auth layer; here we
	// want a cheap pre-D1 cap, and remote address is what's available
	// without paying for trust-proxy resolution per upgrade frame).
	// Failing open on missing remoteAddress (extremely unusual) is
	// preferable to dropping a legitimate connection. PR #223 round 4
	// SHOULD-FIX.
	if (portDispatcher.isDispatcherHost(req.headers.host)) {
		// `socket` is typed as `Duplex` in the upgrade event but at
		// runtime is always a `net.Socket` (or TLSSocket, which
		// extends it). `remoteAddress` lives on net.Socket; cast
		// once to read it. `resolveClientIp` mirrors proxy-addr's
		// numeric-trust algorithm: peel `trustProxyValue` entries
		// from the right of `[...XFF, remoteAddress]` so behind a
		// Cloudflare Tunnel we key on the original client appended
		// by the trusted proxy, NOT the Tunnel's shared egress IP
		// (which would collapse every user into one bucket) and NOT
		// the leftmost XFF entry (which would let an attacker pin
		// the rate-limit bucket on a victim's IP). The algorithm
		// matches what Express's req.ip computes under our
		// `app.set('trust proxy', N)` setting, so the WS limiter
		// and the HTTP `dispatcherLimiter` agree. PR #223 round 6
		// SHOULD-FIX.
		const remote = (socket as { remoteAddress?: string }).remoteAddress;
		const clientIp = resolveClientIp(req.headers["x-forwarded-for"], remote, trustProxyValue);
		const allowed = dispatcherWsUpgradeLimiter.attempt(clientIp);
		if (!allowed) {
			// `Retry-After: 60` matches the limiter's window so a
			// compliant browser backs off automatically instead of
			// burning the next window's budget on immediate reconnect.
			// `Content-Length: 0` keeps the response framed so curl /
			// wscat report 429 cleanly. PR #223 round 5 SHOULD-FIX.
			endUpgradeSocketWithReply(
				socket,
				"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nContent-Length: 0\r\n\r\n",
			);
			return;
		}
	}
	// #190 PR 190c — let the port dispatcher claim this upgrade first
	// when the Host header parses as `p<container>-<sessionId>.<base>`.
	// `handleUpgrade` returns true iff the dispatcher took the request;
	// in that case it's already running auth + proxy.ws() and the
	// existing /ws/* path mustn't also run.
	if (portDispatcher.handleUpgrade(req, socket, head)) return;
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
	handleWsConnection(ws, req, sessions, docker, bootstrapBroadcaster, idleSweeper);
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

	// Seed the idle sweeper with every running session so the first
	// sweep doesn't reap sessions whose users haven't reconnected yet
	// (the prior backend's bumps are gone). Failure here is non-fatal:
	// log and continue; bumps will lazy-init the map on the next /api
	// or WS hit, and the sweep's `last === undefined` branch seeds and
	// skips.
	try {
		const ids = await listRunningSessionIds();
		idleSweeper.init(ids);
		logger.info(`[server] idle sweeper seeded ${ids.length} running session(s)`);
	} catch (err) {
		logger.warn(`[server] idle sweeper init failed: ${(err as Error).message}`);
	}
	idleSweeper.start();

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
	// Stop the idle sweeper so its 60-s timer doesn't fire mid-teardown
	// and try to soft-stop a session via a Docker socket the shutdown
	// path is about to close. Idempotent — `stop()` is safe to call
	// even if `start()` never ran.
	idleSweeper.stop();

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
