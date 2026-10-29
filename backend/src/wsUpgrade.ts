/**
 * wsUpgrade.ts — the server's `upgrade` listener: the single entry point of
 * every WebSocket in production (`server.on("upgrade", …)` in index.ts).
 *
 * Lives outside index.ts so a test can mount the SAME function on a real
 * `http.Server` and drive it with a real `ws` client. The 3.1 hotfix that
 * created this module fixed a filter that refused `/ws/conversation/` while
 * every test called `handleWsConnection` directly, behind the filter — the
 * admitted paths are now one list (`WS_PATH_PREFIXES`) that the handler
 * routes and this filter admits, and `wsUpgrade.test.ts` goes through the
 * production entry.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import { isAllowedWsOrigin } from "./auth.js";
import { logger } from "./logger.js";
import { newRequestId, runWithRequestId } from "./requestContext.js";
import type { TrustProxyValue } from "./trustProxy.js";
import { endUpgradeSocketWithReply } from "./wsHandler.js";
import { resolveClientIp, type WsUpgradeRateLimiter } from "./wsUpgradeRateLimit.js";

/**
 * The `/ws/*` paths `handleWsConnection` (wsHandler.ts) routes. The upgrade
 * filter admits exactly these; anything else is refused with 404 before a
 * WebSocket object exists. Keep the two in step: a path the handler routes
 * but this list lacks is unreachable in production (that was the 3.1 bug).
 */
export const WS_PATH_PREFIXES: readonly string[] = [
	"/ws/sessions/",
	"/ws/bootstrap/",
	"/ws/conversation/",
];

/** Does `url` (the raw request-target of an upgrade) name an app WebSocket? */
export function isWsPath(url: string): boolean {
	return WS_PATH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export interface WsUpgradeDeps {
	/** `noServer` server whose `connection` event runs `handleWsConnection`. */
	wss: WebSocketServer;
	portDispatcher: {
		isDispatcherHost: (host: string | undefined) => boolean;
		handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
	};
	dispatcherWsUpgradeLimiter: WsUpgradeRateLimiter;
	trustProxyValue: TrustProxyValue | undefined;
	corsOrigins: readonly string[];
	nodeEnv: string | undefined;
}

export type WsUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Build the `upgrade` listener. Order, unchanged since #190/#223: dispatcher
 * rate limit → dispatcher claim → path filter (404) → Origin (403) →
 * handshake → `connection` (cookie auth + per-path authorization happen
 * there, in `handleWsConnection`).
 */
export function createWsUpgradeHandler(deps: WsUpgradeDeps): WsUpgradeHandler {
	const { wss, portDispatcher, dispatcherWsUpgradeLimiter, trustProxyValue, corsOrigins, nodeEnv } =
		deps;
	// #376 — WS upgrades bypass Express middleware entirely, so the
	// correlation id is entered here instead; everything the upgrade
	// spawns (dispatcher proxy, terminal attach, bootstrap subscribe)
	// inherits it through the async chain.
	return (req, socket, head) =>
		runWithRequestId(newRequestId(), () => {
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
			if (!isWsPath(url)) {
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
			if (!isAllowedWsOrigin(req.headers.origin, corsOrigins, nodeEnv)) {
				// Dev/staging only: see the block comment above and issue #66.
				if (nodeEnv !== "production") {
					logger.info(
						"[ws] rejecting upgrade: Origin=%s not in allowlist %j",
						req.headers.origin ?? "<absent>",
						corsOrigins,
					);
				}
				endUpgradeSocketWithReply(socket, "HTTP/1.1 403 Forbidden\r\n\r\n");
				return;
			}

			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit("connection", ws, req);
			});
		});
}
