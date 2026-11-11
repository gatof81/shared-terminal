/**
 * index.ts — Server entry point.
 *
 * Backend-only server.  Frontend is hosted on Cloudflare Pages.
 * Database is Cloudflare D1 (accessed via HTTP API).
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
import {
	ensureAuthReady,
	originMatches,
	parseCorsOrigins,
	resolveCookieDomain,
	validateJwtSecret,
	warnIfWildcardCorsInProduction,
} from "./auth.js";
import { BellSweeper } from "./bellSweeper.js";
import { BootstrapBroadcaster, drainInFlightBootstraps } from "./bootstrap.js";
import { parseAllowUsers } from "./conversation/allowUsers.js";
import { ATTESTATION_KEY_INFO } from "./conversation/captureAttestation.js";
import {
	policyWarnings as cliPolicyWarnings,
	describePolicy as describeCliPolicy,
	parsePolicy as parseCliPolicy,
} from "./conversation/cliPolicy.js";
import { ComposerService, composerFlagEnabled } from "./conversation/composer.js";
import { bgConfigFromEnv, workspaceTranscripts } from "./conversation/composerBg.js";
import { IngestOriginVerifier } from "./conversation/ingestOrigin.js";
import { createIngestHandler } from "./conversation/ingestRoute.js";
import { PaneRecordStore } from "./conversation/paneRecord.js";
import { ConversationService } from "./conversation/service.js";
import { ConversationStore } from "./conversation/store.js";
import { ConversationWsHub } from "./conversation/ws.js";
import { migrateDb, validateD1Config } from "./db.js";
import { DockerManager } from "./dockerManager.js";
import { IdleSweeper, listRunningSessionIds } from "./idleSweeper.js";
import { logger } from "./logger.js";
import { createPortDispatcher, validatePortProxyBaseDomain } from "./portDispatcher.js";
import {
	ProjectConversationStore,
	projectConversationFlagEnabled,
} from "./projects/conversation/store.js";
import { ProjectDirectory, projectChatFlagEnabled } from "./projects/directory.js";
import { conversationRecreatePort } from "./recreate/capturePort.js";
import { d1RecreatePort } from "./recreate/d1.js";
import { RecreationEngine } from "./recreate/engine.js";
import { RecreateAttemptStore } from "./recreateAttempt.js";
import { requestIdMiddleware } from "./requestContext.js";
import { buildRouter } from "./routes.js";
import { deriveSubkey, validateSecretsKey } from "./secrets.js";
import { sessionLifecycleLock } from "./sessionLifecycleLock.js";
import { SessionManager } from "./sessionManager.js";
import { parseTrustProxy, TrustProxyError, warnIfProductionMisconfigured } from "./trustProxy.js";
import { configureWebPush, isPushEnabled, sendToUser } from "./webPush.js";
import { handleWsConnection, startWsHeartbeat } from "./wsHandler.js";
import { createWsUpgradeHandler } from "./wsUpgrade.js";
import { createWsUpgradeRateLimiter } from "./wsUpgradeRateLimit.js";

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

// Phase 3 (docs/CONVERSATION.md) — conversation capture. Constructed
// unconditionally so the ingest endpoint always exists and answers 204
// (a hook pointed at a backend without the receiver would otherwise
// see a 404 and retry noise); with CONVERSATION_ENABLED unset/false the
// service rejects everything as `disabled`, writes no file, injects no
// token and mounts no bind — behaviour-neutral by construction.
const CONVERSATION_ENABLED = process.env.CONVERSATION_ENABLED === "true";
// CONVERSATION.md §3.1.1 (v1.8.6) — bind hook ingest to the session container's
// network origin. Off by default and kept off until the operator has verified,
// read-only, that the backend sees the containers' sessions-net addresses:
// on a deployment where it doesn't (a proxy/NAT in between), turning it on
// would reject all capture.
// Values: unset/`false` = off (no inspection at all); `observe` = run the check
// on every authenticated request and only COUNT the outcome (the activation
// gate, DEPLOYMENT.md); `true` = enforce. Anything else is treated as off and
// logged, so a typo can never enforce by accident.
const INGEST_ORIGIN_FLAG = process.env.INGEST_REQUIRE_SESSION_ORIGIN ?? "";
const INGEST_ORIGIN_MODE: "enforce" | "observe" | null =
	INGEST_ORIGIN_FLAG === "true" ? "enforce" : INGEST_ORIGIN_FLAG === "observe" ? "observe" : null;
if (INGEST_ORIGIN_MODE === null && !["", "false"].includes(INGEST_ORIGIN_FLAG)) {
	logger.warn(
		`[conversation] INGEST_REQUIRE_SESSION_ORIGIN=${JSON.stringify(INGEST_ORIGIN_FLAG)} is not true|observe|false: origin check OFF`,
	);
}
// 3.0d (§7): owners whose NEW sessions are born with capture requested.
const CONVERSATION_ALLOW_USERS = parseAllowUsers(process.env.CONVERSATION_ALLOW_USERS);
const WORKSPACE_ROOT_FOR_CONVERSATION =
	process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";
const conversationStore = new ConversationStore({ workspaceRoot: WORKSPACE_ROOT_FOR_CONVERSATION });
// 3.0d — durable recreation records and the fail-closed
// `recreate-unresolved` gate (CONVERSATION.md §2.7.4). Installed on the
// lifecycle lock before the server accepts requests, so every lifecycle
// verb checks it under the lock; reconcile passes skip such sessions.
const recreateAttempts = new RecreateAttemptStore(WORKSPACE_ROOT_FOR_CONVERSATION);
const isRecreateUnresolved = (sid: string) =>
	recreateAttempts.assertResolved(sid).then(
		() => false,
		() => true,
	);
sessionLifecycleLock.setGuard((sid, op) =>
	op === "delete-hard"
		? recreateAttempts.assertResolvedAndNotRetained(sid)
		: recreateAttempts.assertResolved(sid),
);
docker.setRecreateUnresolvedCheck(isRecreateUnresolved);
const conversation = new ConversationService({
	workspaceRoot: WORKSPACE_ROOT_FOR_CONVERSATION,
	enabled: CONVERSATION_ENABLED,
	port: PORT,
	store: conversationStore,
	execCapture: (sid, cmd, opts) => docker.execCapture(sid, cmd, opts),
	isRecreateUnresolved,
	captureDocker: {
		inspectCapture: (cid) => docker.inspectCapture(cid),
		currentImage: () => docker.currentSessionImage(),
		probeRelay: (sid, cid) => docker.probeRelay(sid, cid),
	},
	// §2.7.5.1 — capability attestations survive the loss of a container's image.
	captureAttestationKey: () => deriveSubkey(ATTESTATION_KEY_INFO),
	// §3.1.1 — absent unless the flag is on: off is the exact pre-v1.8.6 route.
	ingestOrigin: INGEST_ORIGIN_MODE
		? new IngestOriginVerifier({
				inspectSessionNetwork: (cid) => docker.inspectSessionNetwork(cid),
			})
		: undefined,
	ingestOriginMode: INGEST_ORIGIN_MODE ?? undefined,
});
docker.setConversationHooks({
	prepareSpawn: async (sid) => {
		const { prepareSpawnCapture } = await import("./conversation/activation.js");
		// Fail-closed: an image that can't be inspected counts as one
		// without the relay label ⇒ spawn without capture.
		const image = await docker.currentSessionImage().catch(() => null);
		const r = await prepareSpawnCapture(conversation.activationDeps, sid, image);
		return { env: r.env, binds: r.binds, imageId: r.imageId };
	},
	onSessionDown: (sid) => conversation.onSessionDown(sid),
	onSessionPurged: (sid) => conversation.onSessionPurged(sid),
});
// 3.0d — the recreation engine (CONVERSATION.md §2.7), driven by the admin
// `GET`/`POST /api/admin/sessions/:id/recreate`. At boot it only runs its
// pass over leftovers of RESOLVED attempts; unresolved attempts are never
// resolved after a restart (D8).
const recreation = new RecreationEngine({
	workspaceRoot: WORKSPACE_ROOT_FOR_CONVERSATION,
	docker: docker.recreatePort(),
	d1: d1RecreatePort,
	attempts: recreateAttempts,
	lock: sessionLifecycleLock,
	capture: conversationRecreatePort(conversation),
	// §2.7.7: the filesystem a carry-over writes to is Docker's data root,
	// which this container cannot see; the operator names a path on that
	// same filesystem (DEPLOYMENT.md). Unset ⇒ carry-overs block
	// (`disk-space-unknown`), nothing else changes.
	dockerFsPath: process.env.RECREATE_DOCKER_FS_PATH || null,
});
logger.info(
	CONVERSATION_ENABLED
		? "[server] conversation capture ENABLED (per-session opt-in)"
		: "[server] conversation capture disabled (CONVERSATION_ENABLED unset)",
);
// 3.2 — the composer (CONVERSATION.md §8). Off by default: with the flag off
// its routes are not mounted and `canSendInput` stays false. The Docker port
// is the composer's own (evidence-only execs with stdin), the pane records
// live under `.st-control/<sid>/composer/`, and the ack listens to the same
// persisted-event stream the WS uses.
const COMPOSER_ENABLED = composerFlagEnabled(process.env.CONVERSATION_COMPOSER_ENABLED);
// §8.1.9: exact list + optional open minimum + deny list. A malformed
// setting throws here and the backend refuses to start.
const COMPOSER_CLI_POLICY = parseCliPolicy(process.env);
// v1.9 §8.1.12 (EXPERIMENTAL): the background-session transport, through the
// CLI daemon's `reply` op. Off unless `true`/`1`, only with the composer on,
// and only for the sessions in COMPOSER_BG_SESSIONS (empty ⇒ none). Its
// version list is EXACT with an EMPTY default (nothing validated ⇒ every send
// is `cli-unvalidated`). With the flag on a malformed list stops the boot;
// with it off a malformed list only warns (bgConfigFromEnv).
const COMPOSER_BG = bgConfigFromEnv(process.env, COMPOSER_ENABLED);
const composer = new ComposerService({
	enabled: COMPOSER_ENABLED,
	cliPolicy: COMPOSER_CLI_POLICY,
	store: conversationStore,
	conversation: {
		probeSession: (sid) => conversation.probeSession(sid),
		onPersistedEvent: (l) => conversation.onPersistedEvent(l),
		captureEffective: async (sid) => (await conversation.authority.capture(sid)).effective,
	},
	sessions,
	docker: docker.composerPort(),
	records: new PaneRecordStore(WORKSPACE_ROOT_FOR_CONVERSATION),
	bg: {
		enabled: COMPOSER_BG.enabled,
		versions: COMPOSER_BG.versions,
		sessions: COMPOSER_BG.sessions,
		transcripts: workspaceTranscripts,
	},
});
logger.info(
	COMPOSER_ENABLED
		? `[server] composer ENABLED (CLI versions: ${[...COMPOSER_CLI_POLICY.exact].join(", ")})`
		: "[server] composer disabled (CONVERSATION_COMPOSER_ENABLED unset)",
);
// Same line as before the policy existed (deploy checks match it), then the
// whole policy on its own line.
if (COMPOSER_ENABLED) {
	logger.info(`[server] composer CLI policy: ${describeCliPolicy(COMPOSER_CLI_POLICY)}`);
	for (const w of cliPolicyWarnings(COMPOSER_CLI_POLICY)) logger.warn(`[server] ${w}`);
}
// Nothing at all with the flag unset (boot logs unchanged), except a warning
// for a malformed experimental variable that is being ignored.
for (const w of COMPOSER_BG.warnings) logger.warn(`[server] ${w}`);
// P3a — the project & agent directory (docs/PROJECTS.md). Off by default:
// with the flag off nothing is constructed, its routes are not mounted and
// every existing answer is unchanged. Its migration (v19) runs at boot either
// way — the flag gates the surface, not the schema.
const PROJECT_CHAT_ENABLED = projectChatFlagEnabled(process.env.PROJECT_CHAT_ENABLED);
const projectDirectory = PROJECT_CHAT_ENABLED ? new ProjectDirectory() : undefined;
if (PROJECT_CHAT_ENABLED) logger.info("[server] project directory ENABLED (P3a)");
// D1 — the project conversation (docs/PROJECT_CONVERSATION.md §1). It sends
// only through the composer and only to agents of the directory, so it is
// effective only with both on; a flag set without them is logged and stays
// off. Off ⇒ nothing is constructed and nothing under `.projects/` is created.
const PROJECT_CONVERSATION_FLAG = projectConversationFlagEnabled(
	process.env.PROJECT_CONVERSATION_ENABLED,
);
const PROJECT_CONVERSATION_ENABLED =
	PROJECT_CONVERSATION_FLAG && PROJECT_CHAT_ENABLED && COMPOSER_ENABLED;
if (PROJECT_CONVERSATION_FLAG && !PROJECT_CONVERSATION_ENABLED) {
	logger.warn(
		"[server] PROJECT_CONVERSATION_ENABLED is set but needs PROJECT_CHAT_ENABLED and " +
			"CONVERSATION_COMPOSER_ENABLED — project conversation stays OFF",
	);
}
let projectConversation: ProjectConversationStore | undefined;
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
	// Lifecycle lock (CONVERSATION.md §2.7.2) without waiting: a session
	// someone else is starting, stopping or deleting is skipped and
	// retried on the next sweep (its activity entry stays), instead of
	// stalling the sweep for every other session behind it.
	stopContainer: (sessionId) =>
		sessionLifecycleLock.run(sessionId, "stop", () => docker.stopContainer(sessionId), {
			mode: "fail",
		}),
});

// #355 — bell sweeper (Web Push). Module-scoped (like idleSweeper) so
// shutdown() can stop it; assigned in start() only when push is enabled.
let bellSweeper: BellSweeper | null = null;

// #190 PR 190c — port-exposure dispatcher. Resolves Host:
// `p<container>-<sessionId>.<base>` to the runtime mapping in
// `sessions_port_mappings` and reverse-proxies to the container by name
// (`http://<containerName>:<containerPort>`) over the shared network.
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
// #376 — correlation id, mounted FIRST so every downstream log line
// (dispatcher limiter 429s, proxy errors, route handlers, the detached
// bootstrap chain a POST /sessions starts) carries the same requestId.
// See requestContext.ts for the ALS + pino-mixin design.
app.use(requestIdMiddleware);
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
// Phase 3 — hook ingest BEFORE express.json/cookieParser/CORS: it has its
// own L5-capped body reader, no cookies and no browser caller. It only
// claims `POST /ingest/claude/hook`; everything else falls through.
app.use(createIngestHandler({ service: conversation }));
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
app.use(
	"/api",
	buildRouter(sessions, docker, bootstrapBroadcaster, undefined, idleSweeper, conversation, {
		recreation,
		conversationAllowUsers: CONVERSATION_ALLOW_USERS,
		composer,
		projects: projectDirectory,
	}),
);
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);
// Auth lands via the request's Cookie header (#18) — no protocol selection
// is needed for auth purposes, so handleProtocols is dropped along with
// the `auth.bearer.<jwt>` subprotocol convention.
const wss = new WebSocketServer({ noServer: true });

// The upgrade listener lives in wsUpgrade.ts so `wsUpgrade.test.ts` can mount
// the production entry on a real server (3.1 hotfix: the path filter is
// only testable through it). Order: dispatcher rate limit → dispatcher
// claim → path filter → Origin → handshake → `connection` below.
server.on(
	"upgrade",
	createWsUpgradeHandler({
		wss,
		portDispatcher,
		dispatcherWsUpgradeLimiter,
		trustProxyValue,
		corsOrigins: CORS_ORIGINS,
		nodeEnv: process.env.NODE_ENV,
	}),
);

// Liveness heartbeat (#79). The helper sets the per-connection `pong`
// listener and runs the 30 s interval; we keep the cleanup so the
// shutdown path can stop the timer before `wss.close()` to avoid
// racing teardown.
const stopHeartbeat = startWsHeartbeat(wss, 30_000);

// 3.1 — the Conversation WS (replay + live of persisted events, owner-only).
const conversationWs = new ConversationWsHub(conversation);

wss.on("connection", (ws, req) => {
	handleWsConnection(ws, req, sessions, docker, bootstrapBroadcaster, idleSweeper, conversationWs);
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
	await migrateDb();
	// Before the server accepts requests: the store takes the cross-process
	// writer lock (§2.1) and, without it, stays unavailable (503) — never a
	// second writer on the same logs.
	if (PROJECT_CONVERSATION_ENABLED) {
		projectConversation = await ProjectConversationStore.start({
			workspaceRoot: WORKSPACE_ROOT_FOR_CONVERSATION,
			bootId: randomUUID(),
			log: logger,
		});
		logger.info("[server] project conversation ENABLED (D1)");
	}
	// #355 — configure Web Push from VAPID env (or warn + disable). Must run
	// AFTER migrateDb so the push_subscriptions table exists before any
	// subscribe/send, and before the server accepts requests.
	configureWebPush();
	// Before any reconcile: an `open` record left by the previous process
	// becomes `uncertain` (persisted). Never resolves anything (D8). The
	// gate already refuses such sessions even before this runs (an `open`
	// record this process did not begin counts as unresolved); this only
	// makes the state explicit and logs it. Not fatal.
	try {
		const recovered = await recreateAttempts.recoverOnBoot();
		if (recovered.uncertain.length || recovered.unreadable.length) {
			logger.warn(
				`[server] recreate-unresolved sessions: ${recovered.uncertain.length} uncertain, ${recovered.unreadable.length} unreadable`,
			);
		}
	} catch (err) {
		logger.error(`[server] recreate attempt recovery failed: ${(err as Error).message}`);
	}
	await docker.reconcile();
	try {
		await recreation.bootPass();
	} catch (err) {
		logger.warn(`[server] recreation boot pass failed: ${(err as Error).message}`);
	}
	// Phase 3 — after docker.reconcile so session statuses are settled:
	// hooks files ⇔ requested ∧ token, revocation markers win over D1,
	// `gap backend_restart` per live conversation, one probe per session.
	// Flag off: only removes stale hooks files. Never fatal.
	try {
		await conversation.reconcile();
	} catch (err) {
		logger.warn(`[server] conversation reconcile failed: ${(err as Error).message}`);
	}
	// v1.7.2 §5.3: the silence decay and its re-confirming probe, after the
	// boot reconcile (which already probed every running session once).
	conversation.startSilenceSweep();
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

	// #355 — bell-flag sweeper drives Web Push. Only started when push is
	// configured, so a push-disabled deployment pays no per-session exec
	// cost. Wires DockerManager's away/bell probes to webPush.sendToUser.
	if (isPushEnabled()) {
		bellSweeper = new BellSweeper({
			hasLiveListeners: (id) => docker.hasLiveListeners(id),
			readBellFlag: (id) => docker.readSessionBellFlag(id),
			sendToUser,
		});
		bellSweeper.start();
		logger.info("[server] bell sweeper started (Web Push notifications)");
	}

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
	recreation.stop();
	// #355 — same reason: stop the bell sweeper so a sweep can't fire a
	// docker exec / D1 query / push mid-teardown. Null when push disabled
	// (never started). PR #417 review SHOULD-FIX.
	bellSweeper?.stop();

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

	// #348 — abort in-flight bootstraps and await their failure teardown
	// (status → failed, log persisted with the abort reason, container
	// killed) before exiting. Without this, a SIGTERM landing mid-
	// bootstrap — the normal deploy shape — stranded the session
	// half-provisioned at status='running' with bootstrapped_at NULL,
	// a state nothing ever resumes or reports. The drain is a couple of
	// D1 writes plus a docker kill per run, bounded by the watchdog
	// below. (SIGKILL still strands — no drain can run; documented on
	// drainInFlightBootstraps.)
	const bootstrapsDrained = drainInFlightBootstraps();
	// Phase 3 — flush queued conversation events and index snapshots so
	// a deploy restart loses nothing that was already acknowledged with
	// a 204. Bounded by the same watchdog below.
	const conversationDrained = conversation.shutdown().catch((err) => {
		logger.warn(`[server] conversation shutdown failed: ${(err as Error).message}`);
	});
	// 3.2 — refuse new sends and cancel the active executors durably (record
	// phase `cancelled`, reason `shutdown`): a late Docker answer may still
	// settle an exec as evidence, but nothing further starts (§8.1.4).
	// D1 — lets the writer-lock helper go (the kernel releases the lock when it exits).
	void projectConversation?.close();
	const composerDrained = composer.shutdown().catch((err) => {
		logger.warn(`[server] composer shutdown failed: ${(err as Error).message}`);
	});

	// Watchdog: if a client stalls its close handshake, the bootstrap
	// drain wedges on Docker/D1, or some other handle keeps the event
	// loop alive, exit anyway after a grace period instead of hanging
	// the orchestrator's stop timeout.
	const watchdog = setTimeout(() => {
		logger.warn("[server] shutdown watchdog fired — forcing exit");
		process.exit(1);
	}, 10_000);
	watchdog.unref();

	server.close(() => {
		// Exit only after BOTH the HTTP server is closed AND the bootstrap
		// drain has settled — server.close alone would exit(0) out from
		// under the drain's in-flight D1 writes. `finally` (not `then`):
		// drainInFlightBootstraps never rejects today (Promise.allSettled
		// inside), but the exit must not hinge on that staying true.
		void Promise.allSettled([bootstrapsDrained, conversationDrained, composerDrained]).finally(
			() => {
				clearTimeout(watchdog);
				process.exit(0);
			},
		);
	});
}
