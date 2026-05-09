/**
 * portDispatcher.ts — per-session-port reverse proxy + auth gate (#190 PR 190c).
 *
 * The Cloudflare Tunnel ingresses `*.<PORT_PROXY_BASE_DOMAIN>` to the
 * backend. This module parses the inbound `Host: p<container>-<sessionId>.<base>`
 * header, looks up the runtime mapping from `sessions_port_mappings`,
 * and reverse-proxies to `127.0.0.1:<host_port>` — gating private ports
 * (the `public: false` rows) on the same `st_token` cookie that protects
 * the rest of the app.
 *
 * Auth shape (matches issue #190 acceptance):
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

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { isAllowedWsOrigin, verifyJwt } from "./auth.js";
import { logger } from "./logger.js";
import { lookupDispatchTarget } from "./portMappings.js";
import { endUpgradeSocketWithReply } from "./wsHandler.js";

/**
 * Result of parsing the inbound Host header. `null` means the request
 * is NOT for the dispatcher (let it fall through to the API/WS routes).
 */
export interface ParsedHost {
	containerPort: number;
	sessionId: string;
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
 * Singleton proxy. http-proxy keeps a per-target socket pool internally;
 * one proxy instance is enough for the whole dispatcher. We wire a
 * single `error` handler so a target-side failure (container died
 * mid-request, refused connection on the host port) returns 502 to the
 * client instead of crashing the backend with an unhandled error event.
 */
function buildProxy(): httpProxy {
	const proxy = httpProxy.createProxyServer({
		// `xfwd: true` adds X-Forwarded-{For,Host,Proto,Port} headers
		// the container app may use to log the real client IP. The
		// `For` value is what Express's req.ip resolves to under our
		// `trust proxy` setting, so the chain stays consistent end-to-
		// end.
		xfwd: true,
		// `ws: false` here — the dispatcher hand-routes WS upgrades
		// via proxy.ws() in `dispatchUpgrade` below, not auto.
		ws: false,
		// 30 s upstream-response cap. Without this, a stuck container
		// (infinite loop, deadlock, slow I/O) holds the inbound client
		// socket AND the upstream socket open until the container is
		// killed — accumulating open fds against the server's limit in
		// proportion to the number of stalled in-flight requests. With
		// the timeout, http-proxy fires `error` on expiry and our
		// handler below closes the response with 502. PR #223 round 1
		// SHOULD-FIX. Long-lived WS connections are unaffected
		// (proxyTimeout applies to HTTP responses, not the upgraded
		// socket lifetime).
		proxyTimeout: 30_000,
	});
	proxy.on("error", (err, _req, res) => {
		// res can be either a ServerResponse or a Socket (for WS).
		// ServerResponse has `headersSent` + `writeHead`; a raw socket
		// has `destroy`. Branch on shape to emit the right thing.
		const isHttpRes = typeof (res as ServerResponse).writeHead === "function";
		logger.warn(`[port-dispatcher] proxy error: ${(err as Error).message}`);
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
				httpRes.destroy();
			}
		} else {
			(res as Duplex).destroy();
		}
	});
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
	/** Test seam: cookie verifier. Defaults to JWT verifyJwt. */
	verifyToken?: (token: string | undefined) => { sub: string } | null;
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
		};
	}

	const parseHost = deps.parseHost ?? makeHostParser(deps.baseDomain);
	const lookup = deps.lookupTarget ?? lookupDispatchTarget;
	const verify = deps.verifyToken ?? verifyJwt;
	const proxy = deps.proxy ?? buildProxy();

	async function authorize(
		parsed: ParsedHost,
		cookieHeader: string | undefined,
	): Promise<{ status: 200; hostPort: number } | { status: 401 | 403 | 404 }> {
		const target = await lookup(parsed.sessionId, parsed.containerPort);
		if (!target) return { status: 404 };
		if (target.isPublic) return { status: 200, hostPort: target.hostPort };
		// Private port: cookie required.
		const token = extractAuthToken(cookieHeader);
		const payload = verify(token ?? undefined);
		if (!payload) return { status: 401 };
		if (payload.sub !== target.ownerUserId) return { status: 403 };
		return { status: 200, hostPort: target.hostPort };
	}

	function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
		const parsed = parseHost(req.headers.host);
		if (!parsed) {
			next();
			return;
		}
		// Authorize then proxy. Wrapping in a self-contained promise
		// chain (no async middleware) keeps Express's error path off
		// the table — a thrown `lookup`/`verify` lands in `.catch()`
		// and emits 502 directly, the same outcome as a target-side
		// proxy error.
		void authorize(parsed, req.headers.cookie)
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
				proxy.web(req, res, { target: `http://127.0.0.1:${result.hostPort}` });
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
		// `index.ts`. PR #223 round 2 SHOULD-FIX.
		if (!isAllowedWsOrigin(req.headers.origin, deps.corsOrigins, deps.nodeEnv)) {
			endUpgradeSocketWithReply(socket, "HTTP/1.1 403 Forbidden\r\n\r\n");
			return true;
		}
		void authorize(parsed, req.headers.cookie)
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
					endUpgradeSocketWithReply(socket, `HTTP/1.1 ${result.status} ${reason}\r\n\r\n`);
					return;
				}
				proxy.ws(req, socket, head, { target: `http://127.0.0.1:${result.hostPort}` });
			})
			.catch((err) => {
				logger.error(`[port-dispatcher] WS dispatch failed: ${(err as Error).message}`);
				endUpgradeSocketWithReply(socket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
			});
		return true;
	}

	return { middleware, handleUpgrade };
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
	const ok = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) && !v.includes("..") && !v.startsWith(".");
	if (!ok) {
		logger.warn(
			`[port-dispatcher] PORT_PROXY_BASE_DOMAIN=${JSON.stringify(raw)} is malformed; ` +
				"port exposure disabled. Expected something like 'tunnel.example.com'.",
		);
		return null;
	}
	return v;
}
