/**
 * portDispatcher.ts — per-session-port reverse proxy + auth gate (#190 PR 190c).
 *
 * The Cloudflare Tunnel ingresses `*.<PORT_PROXY_BASE_DOMAIN>` to the
 * backend. This module parses the inbound `Host: p<container>-<sessionId>.<base>`
 * header, looks up the runtime mapping from `sessions_port_mappings`,
 * and reverse-proxies to `http://<containerName>:<containerPort>` over the
 * shared user-defined network (`SESSIONS_NETWORK`, resolved by Docker's
 * embedded DNS) — gating private ports (the `public: false` rows) on the
 * same `st_token` cookie that protects the rest of the app.
 *
 * Auth shape (matches issue #190 acceptance):
 *   - `public: false`, `Sec-Fetch-Site: cross-site`: 403 (CSRF gate, #302 —
 *     fires after the target lookup, which it needs for `isPublic`, but
 *     before cookie extraction)
 *   - `public: false`, no cookie or invalid: 401
 *   - `public: false`, cookie owned by someone else: 403
 *   - `public: false`, cookie owned by session owner: 200 (proxied)
 *   - `public: true`: skip auth entirely (webhook / OAuth callback shape)
 *
 * Every other failure mode (no mapping, stopped session, malformed host)
 * collapses to 404. Both "session never existed" and "session stopped 200 ms
 * ago" return 404 deliberately so a probe attacker can't enumerate
 * recently-active sessions by status-code timing.
 *
 * Tunnel→backend is the only acceptable inbound path: the dispatcher
 * doesn't bypass CORS, the Tunnel does (it terminates TLS and forwards
 * raw HTTP). The proxied container app sets its own CORS as needed.
 *
 * `PORT_PROXY_BASE_DOMAIN` is the only knob. Unset → dispatcher is a
 * no-op middleware, port-exposure features are silently disabled.
 * Logged once at startup so the unset case is visible.
 */

import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { isAllowedWsOrigin, verifyJwt } from "./auth.js";
import { logger } from "./logger.js";
import { lookupDispatchTarget } from "./portMappings.js";
import type { JwtPayload } from "./types.js";
import { endUpgradeSocketWithReply } from "./wsHandler.js";

/**
 * Result of parsing the inbound Host header. `null` means the request
 * is NOT for the dispatcher (let it fall through to the API/WS routes).
 */
export interface ParsedHost {
	containerPort: number;
	sessionId: string;
}

// ── Observability counters (#241c) ─────────────────────────────────────────
//
// Process-local counters surfaced via `GET /api/admin/stats`. Reset on
// every backend restart. Durable metrics belong in a separate Prometheus/
// OTel follow-up; this is the same shape as the IdleSweeper / reconcile /
// d1 counters that landed in 241b.
//
// Scope: HTTP requests only. WS upgrade counters are deferred to a future
// follow-up because the upgrade-success / upgrade-fail signal is a
// connection event, not a request event, and lumping them in with HTTP
// 2xx/3xx/4xx/5xx blurs both signals. The HTTP counters cover the
// regular browser traffic to dev-server / app ports — the dominant use
// case the dashboard needs to surface.
//
// Exclusion: rate-limited 429s never reach this module's `middleware()`
// because `dispatcherLimiter` mounts BEFORE the dispatcher in
// `index.ts`. A request the per-IP limiter rejects is therefore NOT in
// `requestsSinceBoot` — operators reading "dispatcher quiet but
// `dispatcherLimiter` 429-firing" should consult the limiter's own
// `RateLimit-*` response headers (or the limiter's express-rate-limit
// internals) for that signal. Defensible: a request that never reached
// the dispatcher is arguably not a dispatcher request, and including
// 429s here would conflate the two layers' health signals.

let requestsSinceBoot = 0;
let responses2xxSinceBoot = 0;
let responses3xxSinceBoot = 0;
let responses4xxSinceBoot = 0;
let responses5xxSinceBoot = 0;

export interface DispatcherStats {
	requestsSinceBoot: number;
	responses2xxSinceBoot: number;
	responses3xxSinceBoot: number;
	responses4xxSinceBoot: number;
	responses5xxSinceBoot: number;
}

/** Read-only snapshot for the admin stats endpoint. Cheap (no I/O,
 *  no async). */
export function getDispatcherStats(): DispatcherStats {
	return {
		requestsSinceBoot,
		responses2xxSinceBoot,
		responses3xxSinceBoot,
		responses4xxSinceBoot,
		responses5xxSinceBoot,
	};
}

/** Test seam: zero every counter so cases don't bleed. Production code
 *  never calls this. */
export function __resetDispatcherStatsForTests(): void {
	requestsSinceBoot = 0;
	responses2xxSinceBoot = 0;
	responses3xxSinceBoot = 0;
	responses4xxSinceBoot = 0;
	responses5xxSinceBoot = 0;
}

/**
 * Record one finalised dispatcher response. Called from a `res.on("close")`
 * listener (fires on both successful flush and abort), so EVERY request
 * that the dispatcher claimed contributes exactly one increment to
 * `requestsSinceBoot` and at most one to a status-class counter.
 *
 * The `!statusCode` early-return is a TypeScript safety net for the
 * `undefined` branch of the parameter union — `http.ServerResponse`
 * defaults `statusCode` to `200` and never assigns `0` at runtime,
 * so this branch is unreachable in production. Kept anyway so a
 * future caller passing through a partially-mocked response object
 * (or a different response shape) doesn't NaN the counters via
 * `>= undefined` comparisons.
 */
function bumpDispatchResponse(statusCode: number | undefined): void {
	requestsSinceBoot++;
	if (!statusCode) return;
	if (statusCode >= 200 && statusCode < 300) responses2xxSinceBoot++;
	else if (statusCode >= 300 && statusCode < 400) responses3xxSinceBoot++;
	else if (statusCode >= 400 && statusCode < 500) responses4xxSinceBoot++;
	else if (statusCode >= 500 && statusCode < 600) responses5xxSinceBoot++;
}

/**
 * Build the host-header parser bound to a fixed base domain. Returns
 * null for any host that doesn't match `p<int>-<sessionId>.<base>`.
 *
 * Session IDs are UUIDv4 (lowercase hex with hyphens, 36 chars). The
 * regex pins both the prefix and the UUID shape so a Host-header probe
 * with a guessed sessionId can't trigger downstream lookups for
 * arbitrary strings.
 */
export function makeHostParser(
	baseDomain: string,
): (host: string | undefined) => ParsedHost | null {
	// Escape every regex metachar in the base. `.` is the realistic
	// concern (would otherwise match any char in subdomain position);
	// the rest are belt-and-suspenders against an operator pasting in
	// something with special chars.
	const escaped = baseDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`^p(\\d{1,5})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.${escaped}$`,
		"i",
	);
	return (rawHost) => {
		if (!rawHost) return null;
		// Strip an optional `:<port>` suffix (browser sends "host:443"
		// only when the request was made to a non-default port; behind
		// the Tunnel this is rare but a malformed proxy chain could
		// surface it). The dispatcher only ever sees one logical
		// hostname so trimming the port is safe.
		const host = rawHost.split(":", 1)[0]!.toLowerCase();
		const m = host.match(pattern);
		if (!m) return null;
		const containerPort = Number(m[1]);
		// Range check after parse — `\d{1,5}` accepts 99999 which is
		// out of TCP range. Defence-in-depth; the per-row mapping
		// lookup would 404 for an out-of-range port anyway.
		if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
			return null;
		}
		return { containerPort, sessionId: m[2]!.toLowerCase() };
	};
}

/**
 * Same-origin check for the dispatcher's Origin gates (#391). The
 * dispatcher's per-session hostnames (`p<port>-<sid>.<base>`) are
 * dynamic, so they can never be enumerated in `CORS_ORIGINS` — yet
 * every page the dispatcher itself serves necessarily uses one of
 * them as its own origin. A built SPA (Vite emits `crossorigin`
 * module scripts/stylesheets by default) and any same-origin `fetch`
 * POST both send `Origin: https://p<port>-<sid>.<base>`, which the
 * allowlist-only gate structurally 403'd, blanking the page.
 *
 * Same-origin cannot be CSRF: if the Origin's host equals the
 * request's own Host, the initiator IS a page this dispatcher already
 * served on that exact hostname — for a private port, one that
 * already passed the cookie+ownership check in `authorize()` (which
 * still runs after this gate; nothing is bypassed). Hostnames are
 * compared port-stripped on both sides: the base domain resolves to
 * the Tunnel, so any scheme/port on that hostname terminates at this
 * same dispatcher — there is no other server an attacker could serve
 * a page from under it. A DIFFERENT session/port subdomain is NOT
 * same-origin and still goes through the allowlist (a page served
 * from one user's container must not get a free pass into another
 * user's private port).
 */
export function isSameOriginRequest(
	origin: string | string[] | undefined,
	host: string | undefined,
): boolean {
	if (typeof origin !== "string" || !host) return false;
	try {
		return new URL(origin).hostname.toLowerCase() === host.split(":", 1)[0]!.toLowerCase();
	} catch {
		// Malformed Origin (e.g. `null`, garbage) — not same-origin;
		// let the allowlist gate decide.
		return false;
	}
}

const TOKEN_COOKIE_REGEX = /(?:^|;\s*)st_token=([^;]+)/;

/**
 * Extract the JWT from the request's `Cookie` header. Returns `null`
 * when no cookie is set. Mirrors the same `st_token` name + httpOnly
 * shape the rest of the app uses (#18); the dispatcher runs BEFORE
 * `cookie-parser` populates `req.cookies` so we parse the raw header
 * inline.
 */
export function extractAuthToken(cookieHeader: string | undefined): string | null {
	if (!cookieHeader) return null;
	const m = cookieHeader.match(TOKEN_COOKIE_REGEX);
	if (!m) return null;
	// `decodeURIComponent` throws URIError on a malformed percent
	// sequence (e.g. `st_token=%ZZ`). Without the catch, the throw
	// propagates through `authorize()` to the `middleware` `.catch()`
	// and emits a 502 with a confusing "dispatch failed" log line —
	// when the right answer is "treat as raw value, let the JWT
	// verifier reject it as a 401". Mirrors the same pattern in
	// `extractTokenFromCookieHeader` in auth.ts (PR #223 round 1
	// SHOULD-FIX).
	try {
		return decodeURIComponent(m[1]!);
	} catch {
		return m[1]!;
	}
}

/**
 * `proxy.on("error")` handler. Extracted (and exported) so unit tests
 * can exercise the `headersSent` branches and the WS-vs-HTTP shape
 * detection directly — the in-flight `proxy.web()` path is awkward to
 * fault-inject without binding real sockets. PR #223 round 5 NIT.
 *
 * `res` is typed loosely (the http-proxy `error` event hands either a
 * ServerResponse or a Duplex socket depending on whether the failure
 * was on a `web()` or a `ws()` call). Branch on `writeHead` to pick
 * the right teardown shape.
 */
export function handleProxyError(
	err: Error,
	_req: IncomingMessage,
	res: ServerResponse | Duplex,
): void {
	const isHttpRes = typeof (res as ServerResponse).writeHead === "function";
	logger.warn(`[port-dispatcher] proxy error: ${err.message}`);
	if (isHttpRes) {
		const httpRes = res as ServerResponse;
		// `end()` lives inside the headersSent guard for symmetry
		// with `writeHead`. After bytes have already been streamed
		// to the client a follow-up `end("Bad Gateway: …")` would
		// emit the error string after the legitimate body —
		// truncating the proxy stream is the right call (just
		// destroy). PR #223 round 1 NIT.
		if (!httpRes.headersSent) {
			httpRes.writeHead(502, { "Content-Type": "text/plain" });
			httpRes.end("Bad Gateway: target unreachable");
		} else {
			// Mid-stream failure: bytes already left the headersSent
			// gate, so we can't legally rewrite the wire status — but
			// we DO want the dispatcher's #241c counter close-listener
			// to classify this as 5xx instead of inheriting whatever
			// 2xx the proxy started with. Setting `statusCode` after
			// `headersSent: true` is a documented no-op for the wire
			// (the value never reaches the client) AND a legitimate
			// in-process write that the close-listener reads. The
			// admin dashboard shows the failure correctly; the client
			// gets the truncated stream as before.
			httpRes.statusCode = 502;
			httpRes.destroy();
		}
	} else {
		(res as Duplex).destroy();
	}
}

/**
 * `proxy.on("proxyRes")` handler — releases the upstream idle timeout for
 * long-lived streaming responses (#408). Exported for direct unit coverage
 * (the real `proxyRes` path needs a bound upstream socket to fault-inject).
 *
 * `proxyTimeout` (set in `buildProxy`) is implemented by http-proxy as
 * `proxyReq.setTimeout(ms, () => proxyReq.abort())` — an INACTIVITY timeout
 * on the dispatcher→container socket (verified at
 * backend/node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:139).
 * That is exactly right for a container that accepts the connection then
 * goes silent (deadlock, infinite loop): no bytes for 30 s → abort → 502,
 * no fd leak.
 *
 * But a Server-Sent Events stream is INDISTINGUISHABLE from "stuck" to an
 * idle timer. After the initial `: connected`, a healthy stream can sit
 * quiet for well over 30 s waiting for the next event (an agent thinking,
 * a slow job) with no intervening heartbeat. The idle timeout then fires
 * mid-stream, `proxyReq.abort()` kills the upstream, and because the client
 * already received headers `handleProxyError` truncates the response — the
 * browser's `EventSource` sees the drop and reconnects, only to be reaped
 * again 30 s later. That is the "502 × 6 retries" in #408.
 *
 * Once the container has affirmatively declared `Content-Type:
 * text/event-stream` we know this is a long-lived stream, not a stalled
 * request, so we clear the idle timeout on the shared socket.
 * `setTimeout(0)` cancels the pending timer; the one-shot `'timeout'`
 * listener http-proxy attached simply never fires. proxyReq and proxyRes
 * ride the SAME TCP socket, so clearing it via `proxyRes.socket` cancels
 * the timer that `proxyReq.setTimeout` armed. Only the upstream socket is
 * touched — the client-facing `res.socket` has no proxyTimeout on it.
 *
 * Scope is deliberately narrow — ONLY `text/event-stream`. A generic
 * chunked response with no content-length is genuinely ambiguous ("slow
 * but alive" vs "stalled mid-download"), and reaping a stalled transfer
 * after 30 s idle is the intended behaviour, so those keep the timeout.
 * The container-never-responds fd-leak case is likewise fully protected:
 * the timeout fires BEFORE any `proxyRes` arrives, so this handler never
 * runs for it.
 */
export function handleProxyRes(proxyRes: IncomingMessage): void {
	const contentType = proxyRes.headers["content-type"];
	if (typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream")) {
		proxyRes.socket?.setTimeout(0);
	}
}

/**
 * `proxy.on("proxyReq")` handler — terminates the CLIENT response when
 * `proxyTimeout` reaps the upstream AFTER the response has already started
 * (#427). Exported for direct unit coverage.
 *
 * http-proxy implements `proxyTimeout` as `proxyReq.setTimeout(ms, () =>
 * proxyReq.abort())`. What that abort does to the client depends on timing:
 *
 *   - abort BEFORE any upstream response (`!res.headersSent`) → http-proxy
 *     emits `error`, `handleProxyError` writes a prompt 502. The fd-leak
 *     case (a container that accepts then never responds) is covered.
 *   - abort AFTER the response started (`res.headersSent`) → the abort is
 *     SILENT: no `error` event fires (verified against http-proxy 1.18.1 on
 *     Node 22), so `handleProxyError` never runs and the client is left
 *     hanging on a truncated, never-closed body until the browser / edge
 *     times it out.
 *
 * We close that second gap by attaching our own one-shot `timeout` listener:
 * on a mid-stream reap we destroy the client socket, turning the hang into a
 * clean connection drop — the honest signal that the upstream died mid-body,
 * matching `handleProxyError`'s own mid-stream branch. The `!res.headersSent`
 * case is deliberately NOT handled here — the existing `error` path already
 * emits the 502, and destroying the socket would race that cleaner response.
 *
 * Composition with #408: `handleProxyRes` clears the idle timeout for
 * `text/event-stream`, so `timeout` never fires for a healthy SSE stream and
 * this listener is a no-op for it.
 */
export function handleProxyReqTimeout(proxyReq: ClientRequest, res: ServerResponse): void {
	proxyReq.on("timeout", () => {
		if (res.headersSent) {
			// Post-headersSent the wire status can't be rewritten, but the
			// #241c close-listener reads `statusCode` — set 502 so a
			// mid-stream reap classifies as 5xx on the admin dashboard
			// instead of inheriting the upstream's 2xx.
			res.statusCode = 502;
			res.destroy();
		}
	});
}

/**
 * Singleton proxy. http-proxy keeps a per-target socket pool internally;
 * one proxy instance is enough for the whole dispatcher. The `error`
 * event is wired to `handleProxyError` so a target-side failure
 * (container died mid-request, refused connection on the host port,
 * proxyTimeout expiry) returns 502 to the client instead of crashing
 * the backend with an unhandled error event. The `proxyRes` event is
 * wired to `handleProxyRes` so long-lived SSE streams aren't reaped by
 * the idle timeout (#408).
 */
function buildProxy(): httpProxy {
	const proxy = httpProxy.createProxyServer({
		// `xfwd: true` appends `req.socket.remoteAddress` (the
		// Tunnel's egress IP, when behind a Tunnel) to the inbound
		// X-Forwarded-For chain that Cloudflare already populated
		// with the real client IP. A container app configured with
		// `trust proxy = 1` peels the Tunnel egress and sees the
		// real client address. The earlier comment here referred
		// to "Express's req.ip", which is wrong — http-proxy
		// receives a raw IncomingMessage with no Express decoration,
		// and the value it appends is the socket address. PR #223
		// round 7 NIT.
		xfwd: true,
		// `ws: false` here — the dispatcher hand-routes WS upgrades
		// via proxy.ws() in `dispatchUpgrade` below, not auto.
		ws: false,
		// 30 s upstream-response cap. Without this, a stuck container
		// (infinite loop, deadlock, slow I/O) holds the inbound client
		// socket AND the upstream socket open until the container is
		// killed — accumulating open fds against the server's limit in
		// proportion to the number of stalled in-flight requests. With
		// the timeout, http-proxy fires `error` on expiry (only while the
		// upstream hasn't responded yet) and `handleProxyError` closes the
		// response with 502; a mid-stream reap after headers are sent is
		// silent, so `handleProxyReqTimeout` terminates the client there
		// (#427). PR #223 round 1
		// SHOULD-FIX. Long-lived WS connections are unaffected
		// (proxyTimeout applies to HTTP responses, not the upgraded
		// socket lifetime). SSE / `text/event-stream` responses ARE
		// affected — an idle stream would be reaped mid-flight — so
		// `handleProxyRes` releases this timeout once the upstream
		// declares an event-stream (#408).
		proxyTimeout: 30_000,
		// Pin the safe default explicitly so a future http-proxy
		// version that flips it can't silently regress. With
		// `followRedirects: true`, http-proxy swaps the native
		// `http`/`https` modules for the `follow-redirects` package
		// — a 3xx from the container app would then be chased
		// FROM THE BACKEND'S NETWORK PERSPECTIVE before the
		// response is returned to the caller. For `is_public: true`
		// ports (no auth) that means an unauthenticated caller
		// could reach any service the backend host can hit on
		// localhost (the API itself on :3001, instance metadata
		// at 169.254.169.254, etc.) by serving a redirect from
		// the container app — net-new capability beyond what the
		// container's own network namespace allows. Native
		// `http`/`https` (the default) never chase redirects, so
		// a 3xx flows through to the client and the browser's
		// own redirect logic + same-origin policy handle it.
		// PR #223 round 8: bot's "needs verification" SSRF concern
		// — verified at backend/node_modules/http-proxy/lib/
		// http-proxy/passes/web-incoming.js:105 (the
		// `options.followRedirects ? followRedirects : nativeAgents`
		// branch). Explicit `false` documents the audit and pins
		// the choice.
		followRedirects: false,
	} as Parameters<typeof httpProxy.createProxyServer>[0] & { followRedirects: boolean });
	proxy.on("error", handleProxyError);
	proxy.on("proxyRes", handleProxyRes);
	// `proxyReq` event is `(proxyReq, req, res, options)` — we only need the
	// request (to hook its timeout) and the client response (to terminate).
	proxy.on("proxyReq", (proxyReq, _req, res) => handleProxyReqTimeout(proxyReq, res));
	return proxy;
}

export interface DispatcherDeps {
	/** Parsed `PORT_PROXY_BASE_DOMAIN`. `null` disables the dispatcher. */
	baseDomain: string | null;
	/**
	 * CORS_ORIGINS allowlist used by the WS upgrade path's CSWSH check.
	 * Same source-of-truth as the existing /ws/sessions WS auth — see
	 * `isAllowedWsOrigin` in auth.ts. Browsers attach `SameSite=None`
	 * cookies on cross-site WS upgrades in production, so without an
	 * origin allowlist a page at `evil.com` could open a WebSocket to
	 * `wss://p3000-<sid>.tunnel.example.com/`, the dispatcher would
	 * see the victim's cookie, and the proxy would happily bridge an
	 * authenticated bidirectional channel into the victim's container.
	 * `isAllowedWsOrigin` allows missing-Origin (non-browser callers
	 * like webhooks) and exact / single-label-glob matches against
	 * this list. PR #223 round 2 SHOULD-FIX.
	 */
	corsOrigins: readonly string[];
	/** Process NODE_ENV — drives `isAllowedWsOrigin`'s wildcard policy. */
	nodeEnv?: string;
	/** Test seam: pure host-header parser. Defaults to `makeHostParser`. */
	parseHost?: (host: string | undefined) => ParsedHost | null;
	/** Test seam: target lookup. Defaults to D1-backed `lookupDispatchTarget`. */
	lookupTarget?: typeof lookupDispatchTarget;
	/**
	 * Test seam: cookie verifier. Defaults to JWT `verifyJwt`. Typed
	 * with the same `JwtPayload | null` shape so a stub can't silently
	 * narrow the contract — `authorize()` only reads `payload.sub`
	 * today, but matching the production return type keeps the seam
	 * honest if a future check reads `username` (PR #223 round 3 NIT).
	 */
	verifyToken?: (token: string | undefined) => JwtPayload | null;
	/** Test seam: pre-built proxy (so tests can spy without binding sockets). */
	proxy?: httpProxy;
}

/**
 * Build the Express middleware (HTTP) and a manual upgrade handler (WS).
 * Both share auth, lookup, and 404/401/403 semantics.
 */
export function createPortDispatcher(deps: DispatcherDeps): {
	middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
	handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
	/**
	 * Cheap "would the dispatcher claim this host?" predicate that the
	 * rate-limit middleware in `index.ts` uses as its `skip` function so
	 * the limiter only counts requests heading into the dispatcher
	 * namespace (no impact on /api or /health). Same parser the real
	 * dispatch path runs, so the predicate and the dispatch decision
	 * stay in lockstep — no chance of "limited but not dispatched" or
	 * vice versa.
	 */
	isDispatcherHost: (host: string | undefined) => boolean;
} {
	if (!deps.baseDomain) {
		// Disabled: every request falls through, every upgrade is
		// "not mine". The `false` return on handleUpgrade tells the
		// caller to continue with the existing `wss.handleUpgrade`
		// path. Logging the unset case is index.ts's job (one-shot
		// at startup) — emitting a per-request log here would drown
		// the dev box where the warning fires once and the user
		// already saw it.
		return {
			middleware: (_req, _res, next) => next(),
			handleUpgrade: () => false,
			// Disabled dispatcher → no host is ever a dispatcher
			// host, so the rate limiter's `skip` always returns
			// true and the limiter is a no-op.
			isDispatcherHost: () => false,
		};
	}

	const parseHost = deps.parseHost ?? makeHostParser(deps.baseDomain);
	const lookup = deps.lookupTarget ?? lookupDispatchTarget;
	const verify = deps.verifyToken ?? verifyJwt;
	const proxy = deps.proxy ?? buildProxy();

	async function authorize(
		parsed: ParsedHost,
		cookieHeader: string | undefined,
		secFetchSite: string | undefined,
	): Promise<{ status: 200; containerName: string } | { status: 401 | 403 | 404 }> {
		const target = await lookup(parsed.sessionId, parsed.containerPort);
		if (!target) return { status: 404 };
		// Public ports skip auth entirely (webhook / OAuth-callback shape),
		// which are cross-site by nature and carry no credential to steal —
		// so the Fetch-metadata gate below would wrongly break them. Return
		// before it.
		if (target.isPublic) return { status: 200, containerName: target.containerName };
		// Fetch-metadata CSRF defence (#302). The Origin allowlist in the
		// callers allows a MISSING `Origin` (for legit non-browser callers),
		// but a cross-site `<img>` / `<script>` / link-click navigation from
		// `evil.com` also omits `Origin` while the `SameSite=None` cookie
		// auto-attaches — so a state-changing GET against a private port
		// would otherwise execute with the victim's credentials. Browsers
		// label exactly those requests `Sec-Fetch-Site: cross-site`; reject
		// them. `same-origin` (the app's own subresources), `same-site`
		// (a link from the main app on the shared parent domain), and
		// `none` (the user typing the URL / a bookmark / direct nav) all
		// pass. A MISSING header (non-browser client, pre-2020 browser)
		// falls through to the cookie+ownership check so curl / CLI access
		// to one's own private port isn't broken.
		if (secFetchSite === "cross-site") return { status: 403 };
		// Private port: cookie required.
		const token = extractAuthToken(cookieHeader);
		const payload = verify(token ?? undefined);
		if (!payload) return { status: 401 };
		if (payload.sub !== target.ownerUserId) return { status: 403 };
		return { status: 200, containerName: target.containerName };
	}

	// `Sec-Fetch-Site` is single-valued, but Node types header values as
	// `string | string[]`; normalise so `=== "cross-site"` is reliable.
	function headerValue(raw: string | string[] | undefined): string | undefined {
		return Array.isArray(raw) ? raw[0] : raw;
	}

	function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
		const parsed = parseHost(req.headers.host);
		if (!parsed) {
			next();
			return;
		}
		// Counter hookpoint (#241c). Hooked on `close` (fires on both
		// successful flush AND client disconnect mid-flush) so EVERY
		// claimed request contributes exactly one increment. `finish`
		// alone would miss aborts. The listener is attached BEFORE any
		// possible early-return below so a 403 from the CSRF gate also
		// counts.
		res.on("close", () => bumpDispatchResponse(res.statusCode));
		// CSRF defence — applies to ALL dispatcher HTTP requests,
		// symmetric with the WS `handleUpgrade` path. In production
		// the JWT cookie is `SameSite=None; Secure` (the Pages→Tunnel
		// topology requires it), so the browser attaches it on
		// cross-origin requests. The /api routes are protected by
		// the CORS-preflight-via-`Content-Type: application/json`
		// shape, but the dispatcher proxies arbitrary container
		// apps that may not require that content type — a page at
		// `evil.com` could otherwise emit a cross-origin GET / form
		// POST to `https://p<port>-<sid>.tunnel.example.com/`, the
		// browser would auto-attach the victim's cookie, and the
		// container app would execute the request with the
		// victim's credentials (response body is CORS-blocked, but
		// state changes happen). `isAllowedWsOrigin` reuses the
		// same allowlist + missing-Origin-allowed policy the WS
		// path uses (webhook senders / curl with no Origin still
		// pass). Runs BEFORE `authorize()` so cookie validation
		// can't unlock a cross-site request. PR #223 round 10
		// SHOULD-FIX. Same-origin requests (Origin host == own Host)
		// short-circuit the allowlist — the dispatcher's dynamic
		// per-session hostnames can never be allowlisted, see
		// `isSameOriginRequest` (#391).
		if (
			!isSameOriginRequest(req.headers.origin, req.headers.host) &&
			!isAllowedWsOrigin(req.headers.origin, deps.corsOrigins, deps.nodeEnv)
		) {
			res.statusCode = 403;
			res.setHeader("Content-Type", "text/plain");
			res.end("Forbidden");
			return;
		}
		// Authorize then proxy. Wrapping in a self-contained promise
		// chain (no async middleware) keeps Express's error path off
		// the table — a thrown `lookup`/`verify` lands in `.catch()`
		// and emits 502 directly, the same outcome as a target-side
		// proxy error.
		void authorize(parsed, req.headers.cookie, headerValue(req.headers["sec-fetch-site"]))
			.then((result) => {
				if (result.status !== 200) {
					res.statusCode = result.status;
					res.setHeader("Content-Type", "text/plain");
					// Body kept minimal so a probe attacker can't fingerprint
					// our error path. The status code IS the contract; bodies
					// here are diagnostic only.
					const bodies: Record<401 | 403 | 404, string> = {
						401: "Unauthorized",
						403: "Forbidden",
						404: "Not Found",
					};
					res.end(bodies[result.status]);
					return;
				}
				// Direct-proxy switch — forward to the container by name
				// over the shared user-defined network (Docker embedded
				// DNS), not a published host port. `changeOrigin: true`
				// rewrites the outbound `Host` header to
				// `<containerName>:<containerPort>` so the container app
				// receives a hostname that matches its bound address. Vite
				// dev server's `allowedHosts` (and similar host-based
				// routers) reject the original
				// `p<port>-<sid>.tunnel.example.com` value with "Invalid
				// Host header" otherwise, breaking the most common
				// public-port use case (running a dev server inside the
				// session). PR #223 round 9 NIT.
				proxy.web(req, res, {
					target: `http://${result.containerName}:${parsed.containerPort}`,
					changeOrigin: true,
				});
			})
			.catch((err) => {
				logger.error(`[port-dispatcher] dispatch failed: ${(err as Error).message}`);
				// Same guard intent as the proxy `error` handler: the
				// 502 + body is only emitted when nothing has reached
				// the client yet. In the realistic execution path
				// `authorize()` throws before `proxy.web()` runs so
				// `headersSent` is always false here, but keeping the
				// guard around `end()` matches the contract in case a
				// future refactor reorders things. PR #223 round 1
				// NIT.
				if (!res.headersSent) {
					res.statusCode = 502;
					res.setHeader("Content-Type", "text/plain");
					res.end("Bad Gateway");
				} else {
					res.destroy();
				}
			});
	}

	function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		const parsed = parseHost(req.headers.host);
		if (!parsed) return false;
		// CSWSH defence — applies to ALL dispatcher upgrades, not just
		// private ports. In production the JWT cookie is
		// `SameSite=None; Secure`, meaning browsers attach it on
		// cross-site WS handshakes; without an origin allowlist a
		// page at `evil.com` could open a WebSocket to
		// `wss://p3000-<sid>.tunnel.example.com/`, the dispatcher
		// would auth the cookie, and the proxy would bridge an
		// authenticated channel into the victim's container.
		// `isAllowedWsOrigin` allows missing-Origin (non-browser
		// callers like webhook senders, OAuth-callback servers — the
		// legitimate "public port" use case the issue calls out)
		// and rejects browser origins not in CORS_ORIGINS. Runs
		// BEFORE `authorize()` so even a valid cookie can't unlock a
		// cross-site upgrade. Same defence the /ws/* path applies in
		// `index.ts`. PR #223 round 2 SHOULD-FIX. Same-origin
		// upgrades (a proxied page opening a WS to its own host —
		// Vite HMR shape) short-circuit the allowlist, mirroring the
		// HTTP gate above — see `isSameOriginRequest` (#391).
		if (
			!isSameOriginRequest(req.headers.origin, req.headers.host) &&
			!isAllowedWsOrigin(req.headers.origin, deps.corsOrigins, deps.nodeEnv)
		) {
			// `Content-Length: 0` keeps the response framed so curl /
			// wscat report the reason phrase cleanly. Aligns with the
			// 429 in index.ts. PR #223 round 10 NIT.
			endUpgradeSocketWithReply(socket, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
			return true;
		}
		void authorize(parsed, req.headers.cookie, headerValue(req.headers["sec-fetch-site"]))
			.then((result) => {
				if (result.status !== 200) {
					// Mirror the HTTP status semantics on the upgrade
					// path. We can't issue a 401 challenge with full
					// headers cleanly here (no res object), but
					// emitting an HTTP/1.1 status line on the raw
					// socket lets curl/wscat/the browser see the
					// reason instead of an unexplained ECONNRESET.
					// `endUpgradeSocketWithReply` does the half-close-
					// safe drain (PR #223 round 2 NIT) — `socket.write`
					// + `socket.destroy()` doesn't guarantee the status
					// line flushes before teardown when the peer
					// doesn't FIN.
					const reason =
						result.status === 401
							? "Unauthorized"
							: result.status === 403
								? "Forbidden"
								: "Not Found";
					endUpgradeSocketWithReply(
						socket,
						`HTTP/1.1 ${result.status} ${reason}\r\nContent-Length: 0\r\n\r\n`,
					);
					return;
				}
				// Same direct-proxy + Host-rewrite rationale as the HTTP
				// path above — container WS handlers (Vite HMR, etc.)
				// host-check the upgrade request and reject mismatches.
				proxy.ws(req, socket, head, {
					target: `http://${result.containerName}:${parsed.containerPort}`,
					changeOrigin: true,
				});
			})
			.catch((err) => {
				logger.error(`[port-dispatcher] WS dispatch failed: ${(err as Error).message}`);
				endUpgradeSocketWithReply(socket, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
			});
		return true;
	}

	return {
		middleware,
		handleUpgrade,
		isDispatcherHost: (host) => parseHost(host) !== null,
	};
}

/**
 * Validate `PORT_PROXY_BASE_DOMAIN` at startup. Returns the trimmed
 * lowercased domain, or `null` if unset/empty/malformed (with a warn
 * for the malformed case so the operator notices at boot rather than
 * after a tunnel hit).
 *
 * Accepts: lowercase letters / digits / hyphens / dots, with at least
 * one dot (no bare TLDs). Refuses leading/trailing dots and consecutive
 * dots. Not RFC-perfect (we don't enforce label-length limits or IDN
 * shapes), but tight enough that an env-var typo (`tunnel.example`
 * forgetting a TLD) trips the warn.
 *
 * Exported for tests.
 */
export function validatePortProxyBaseDomain(raw: string | undefined): string | null {
	if (raw === undefined || raw.trim() === "") return null;
	const v = raw.trim().toLowerCase();
	// RFC 1123 §2.1: hostname labels must start AND end with alphanumeric;
	// hyphens may appear only in interior positions. The earlier
	// `[a-z0-9-]+` form passed through `tunnel-.example.com` and
	// `-tunnel.example.com`, which a Tunnel ingress would silently fail
	// to match — operator sees a dispatcher that never fires instead of
	// a startup warning. Tightened per PR #223 round 3 NIT.
	//
	// Note: the regex's required `[a-z0-9]` first character already
	// excludes a leading dot AND makes `..` impossible (any dot must
	// be followed by another alphanumeric). The earlier additional
	// `!v.includes("..") && !v.startsWith(".")` guards were redundant
	// dead-code; dropped per PR #223 round 9 NIT.
	const labelStrict = /[a-z0-9]([a-z0-9-]*[a-z0-9])?/.source;
	const domainStrict = new RegExp(`^${labelStrict}(\\.${labelStrict})+$`);
	const ok = domainStrict.test(v);
	if (!ok) {
		logger.warn(
			`[port-dispatcher] PORT_PROXY_BASE_DOMAIN=${JSON.stringify(raw)} is malformed; ` +
				"port exposure disabled. Expected something like 'tunnel.example.com'.",
		);
		return null;
	}
	return v;
}
