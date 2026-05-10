/**
 * wsHandler.ts — WebSocket connection handler for Docker-based sessions.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { v4 as uuidv4 } from "uuid";
import { WebSocket, type WebSocketServer } from "ws";
import { verifyWsToken } from "./auth.js";
import type { BootstrapBroadcaster, BootstrapMessage } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { logger } from "./logger.js";
import { TERMINAL_DIM_MAX } from "./routes.js";
import { ForbiddenError, NotFoundError, type SessionManager } from "./sessionManager.js";
import type { WsClientMessage, WsServerMessage } from "./types.js";

// Send a tiny HTTP error response on the raw upgrade socket and tear it
// down with a bounded grace window.
//
// socket.end(msg) flushes the status line, sends FIN, and waits for the
// peer's FIN before fully releasing the fd. A misbehaving peer that never
// sends FIN leaves the socket in CLOSE_WAIT until kernel keepalive kicks
// in (minutes to hours depending on tuning) — and on the 403 path that's
// cheap to script, since an attacker piling up garbage-Origin upgrades
// and dropping post-response could exhaust the process fd table.
// socket.destroy() alone (the pre-#64 form) was bounded but didn't
// guarantee the status line flushed first, hiding the 4xx reason from
// anyone debugging. Belt-and-braces: end() for the flush, then a hard
// destroy() after 500 ms if the peer hasn't FIN'd. unref()'d so the timer
// never holds the process open during shutdown. See issue #67.
// `Duplex` matches the upgrade-event signature for http.Server and a
// hypothetical https.Server (TLSSocket extends Duplex too).
export function endUpgradeSocketWithReply(socket: Duplex, reply: string): void {
	// socket.end() on an already-destroyed socket is a no-op in Node 20+,
	// so the asymmetry with the guarded destroy() below is intentional —
	// the only failure mode worth swallowing is a peer that RST'd between
	// the upgrade event and our 500 ms timer firing.
	socket.end(reply);
	setTimeout(() => {
		try {
			socket.destroy();
		} catch {
			/* already destroyed */
		}
	}, 500).unref();
}

export function handleWsConnection(
	ws: WebSocket,
	req: IncomingMessage,
	sessions: SessionManager,
	docker: DockerManager,
	broadcaster: BootstrapBroadcaster,
	// Optional so the existing test suite (which constructs WS handlers
	// without the sweeper) keeps working unchanged. Production wires
	// the singleton from index.ts; the absent-sweeper case just means
	// auto-stop never fires for that handler invocation, which is the
	// pre-#194 behaviour.
	idleSweeper?: { bump: (sessionId: string) => void },
): void {
	// Synchronous safety net registered BEFORE any await or sync ws.close().
	// Node's EventEmitter routes an 'error' emission with no listener to
	// process.emit('uncaughtException') → the whole server process dies,
	// dropping every other attached session. The `ws` package emits
	// 'error' on transport-level failures — RSTd TCP, malformed frames,
	// invalid UTF-8 — any of which can land during the handshake/close
	// dance or during the two awaits below (sessions.assertOwnership,
	// docker.attach). A second ws.on('error', …) is added after attach()
	// succeeds to also tear the exec down; `on` is additive, so both run.
	// See issue #91 for the DoS reproduction path.
	ws.on("error", (err) => {
		logger.error(`[ws] socket error: ${err.message}`);
		// Don't trust the transport to always emit 'close' after
		// 'error'. Some failure modes (RSTd TCP mid-handshake, upgrade
		// parse error before the WS protocol is fully up) leave the
		// underlying socket half-open until Node's GC notices. Close
		// explicitly with 1011 "internal error"; ws.close() is a no-op
		// on a socket already CLOSING/CLOSED, so this is safe for
		// post-attach errors where the inner 'close' listener would
		// also run.
		ws.close(1011, "socket error");
	});

	// Auth must run before path/tab inspection: distinct pre-close
	// error reasons ("Invalid path" / "Missing tab" / …) leaked a
	// probe oracle to unauthenticated callers (issue #82). Once we
	// know the caller is a user, the specific errors below are fine
	// — they're useful for diagnosing client bugs.
	const url = req.url ?? "";
	const payload = verifyWsToken(req.headers.cookie);
	if (!payload) {
		sendError(ws, "Unauthorized");
		ws.close(1008, "Unauthorized");
		return;
	}
	const userId = payload.sub;

	// PR 185b2b: `/ws/bootstrap/<sessionId>` is the live-tail channel
	// for the postCreate hook. Authed identically to the terminal-attach
	// path, but routes to the broadcaster's per-session listener set
	// instead of `docker.attach`. Owns its own auth-and-subscribe block
	// below so terminal-attach logic doesn't have to special-case the
	// bootstrap shape.
	const bootstrapMatch = url.match(/\/ws\/bootstrap\/([^/?#]+)/);
	if (bootstrapMatch) {
		if (!broadcaster) {
			// Defensive: server boot wires the broadcaster in, so this
			// branch is unreachable in production. If we land here a
			// future caller forgot to thread it through; loudly close.
			sendError(ws, "Bootstrap channel not configured");
			ws.close(1011, "Bootstrap channel not configured");
			return;
		}
		const bootstrapSessionId = bootstrapMatch[1]!;
		void handleBootstrapWs(ws, bootstrapSessionId, userId, sessions, broadcaster);
		return;
	}

	const match = url.match(/\/ws\/sessions\/([^/?#]+)/);
	if (!match) {
		sendError(ws, "Invalid WebSocket path");
		ws.close(1008, "Invalid path");
		return;
	}
	const sessionId = match[1]!;

	// Required ?tab=<tabId>. The container no longer creates a default tab
	// at boot, so every WS attach must name its target explicitly. Strict
	// charset: tmux session names + our own prefix; no shell metas
	// (docker exec takes argv, not a shell line, but a defensive allowlist
	// keeps surprising tmux targets like "main:1" out of the path).
	const tabQueryMatch = url.match(/[?&]tab=([^&#]+)/);
	if (tabQueryMatch === null) {
		sendError(ws, "Missing tab id");
		ws.close(1008, "Missing tab");
		return;
	}
	// decodeURIComponent throws URIError on malformed sequences (e.g.
	// `?tab=%G%`). Without a guard the throw propagates out of
	// wss.emit("connection", …) and there is no uncaughtException
	// handler — Node terminates the process, dropping every other
	// attached session. Auth runs before this so an unauth'd caller
	// can't trigger it, but any logged-in user could DoS the entire
	// server with one bad URL otherwise. Same shape of "one socket
	// kills the process" bug as #91. See #147.
	let rawTab: string;
	try {
		rawTab = decodeURIComponent(tabQueryMatch[1]!);
	} catch {
		sendError(ws, "Invalid tab id");
		ws.close(1008, "Invalid tab");
		return;
	}
	if (!/^[a-zA-Z0-9._-]{1,64}$/.test(rawTab)) {
		sendError(ws, "Invalid tab id");
		ws.close(1008, "Invalid tab");
		return;
	}
	const tabId = rawTab;

	// Optional geometry hint from the client. Used in lieu of
	// session.cols/rows (the persisted last-good size from D1) so
	// capture-pane runs at the actual viewport size on this attach;
	// otherwise the replay arrives at D1's stored size and the user
	// sees mis-aligned columns until something fires a frontend
	// resize. Bounds match POST /sessions (TERMINAL_DIM_MAX shared
	// from routes.ts so both validators move together).
	const parseDim = (re: RegExp): number | null => {
		const m = url.match(re);
		if (m === null) return null;
		const n = Number.parseInt(m[1]!, 10);
		return Number.isInteger(n) && n >= 1 && n <= TERMINAL_DIM_MAX ? n : null;
	};
	// `\d{1,4}` (not `[^&#]+`) so values like `cols=100abc` don't
	// silently truncate via parseInt's partial-parse — the value will
	// just fail to match and fall through to session.cols.
	const urlCols = parseDim(/[?&]cols=(\d{1,4})/);
	const urlRows = parseDim(/[?&]rows=(\d{1,4})/);

	// Async auth + attach flow
	(async () => {
		// Authorise
		const session = await sessions.assertOwnership(sessionId, userId);

		if (session.status === "terminated") {
			sendError(ws, "Session is terminated");
			ws.close(1008, "Session terminated");
			return;
		}
		// `failed` (#185) means the postCreate hook exited non-zero, the
		// container was killed, and the user can no longer /start the
		// session (REST returns 409). Without this short-circuit
		// `docker.attach` would try `getContainer(meta.containerId)` on
		// a null id, throw "No container for this session", and close
		// the socket with 1011 Internal Error — a misleading code that
		// also pollutes server logs with a spurious error for an
		// avoidable path. 1008 ("policy violation") is the same code
		// `terminated` uses; matching it gives the client a single
		// "session is in a non-attachable state" signal to handle.
		if (session.status === "failed") {
			sendError(ws, "Session failed during postCreate; recreate it to retry.");
			ws.close(1008, "Session failed");
			return;
		}

		// Attach to Docker container
		const attachId = `${sessionId}:${uuidv4().slice(0, 8)}`;
		const outputListener = (data: string) => {
			// Bump the idle-sweeper on every byte from tmux. Cheap
			// (single Map.set) so it's safe on the hot path. Pairs
			// with the input/resize bumps in the message handler so
			// "user is watching the terminal" counts as activity even
			// when they're not typing — common case for a build that
			// takes minutes and the user just wants to watch the log.
			idleSweeper?.bump(sessionId);
			sendMsg(ws, { type: "output", data });
		};

		// attach() hands back `flushTail` — until we call it, the listener
		// installed inside attach() piles incoming live bytes into a local
		// array instead of forwarding them. This lets us guarantee the
		// on-the-wire order is [replay][live], even on a noisy session
		// where bytes stream in between attach() returning and this
		// function sending the replay frame. See attach() for the full
		// rationale. `sendMsg` is synchronous, so there is no await
		// between the replay frame and flushTail() — a stream 'data'
		// event cannot interleave.
		const { replay, flushTail } = await docker.attach(
			sessionId,
			attachId,
			urlCols ?? session.cols,
			urlRows ?? session.rows,
			outputListener,
			tabId,
		);

		sendMsg(ws, { type: "status", status: "running" });
		if (replay) {
			sendMsg(ws, { type: "output", data: replay });
		}
		flushTail();

		logger.info(
			`[ws] user=${userId} attached to session=${sessionId} tab=${tabId} (exec=${attachId})`,
		);

		// Message handler
		ws.on("message", (raw) => {
			let msg: WsClientMessage;
			try {
				msg = JSON.parse(raw.toString()) as WsClientMessage;
			} catch {
				sendError(ws, "Invalid JSON");
				return;
			}

			switch (msg.type) {
				case "input":
					idleSweeper?.bump(sessionId);
					docker.write(attachId, msg.data);
					break;
				case "resize":
					if (msg.cols > 0 && msg.rows > 0) {
						idleSweeper?.bump(sessionId);
						docker.resize(attachId, msg.cols, msg.rows).catch(() => {});
					}
					break;
			}
		});

		ws.on("close", () => {
			logger.info(`[ws] user=${userId} detached from session=${sessionId}`);
			docker.detach(attachId);
		});

		ws.on("error", (err) => {
			logger.error(`[ws] error on session=${sessionId}: ${err.message}`);
			docker.detach(attachId);
		});
	})().catch((err) => {
		if (err instanceof NotFoundError) {
			sendError(ws, "Session not found");
			ws.close(1008, "Not found");
		} else if (err instanceof ForbiddenError) {
			sendError(ws, "Access denied");
			ws.close(1008, "Forbidden");
		} else {
			logger.error(`[ws] attach failed for session=${sessionId}: ${(err as Error).message}`);
			sendError(ws, `Failed to attach: ${(err as Error).message}`);
			ws.close(1011, "Attach failed");
		}
	});
}

/**
 * Bidirectional protocol-level liveness heartbeat for the WebSocket
 * server (#79). Tags each connection with `isAlive` (set true on
 * connect and on every pong frame from the peer), and on every tick
 * terminates any client that didn't pong since the previous tick,
 * then re-pings the survivors. The legacy app-layer `{type:"ping"}`
 * was unidirectional (client → server only) and missed both:
 *   - server-side hangs that left TCP alive but the WS unresponsive
 *     (the client saw a frozen terminal until kernel keepalive
 *     reaped the socket — minutes later);
 *   - clients that went silent (backgrounded mobile tab, frozen JS),
 *     where the server kept the shared exec up indefinitely.
 *
 * Returns a cleanup function the caller invokes during shutdown to
 * stop the interval before `wss.close()` so a tick doesn't race
 * teardown and ping a half-closed client.
 */
export function startWsHeartbeat(wss: WebSocketServer, intervalMs: number): () => void {
	const onConnection = (ws: WebSocket) => {
		const c = ws as WebSocket & { isAlive?: boolean };
		c.isAlive = true;
		ws.on("pong", () => {
			c.isAlive = true;
		});
	};
	wss.on("connection", onConnection);

	const tick = setInterval(() => {
		// Snapshot the client set: terminate() fires `close` synchronously
		// and `ws` removes the client from `wss.clients` inside the loop,
		// which silently skips the next iterator entry on a live Set.
		// Reaping a dead peer one tick late isn't a safety bug, but the
		// snapshot keeps the cadence honest.
		for (const client of [...wss.clients]) {
			const c = client as WebSocket & { isAlive?: boolean };
			if (c.isAlive === false) {
				c.terminate();
				continue;
			}
			c.isAlive = false;
			try {
				c.ping();
			} catch {
				// Peer already dead — terminate on the next tick (isAlive stays false).
			}
		}
	}, intervalMs);
	tick.unref();

	return () => {
		clearInterval(tick);
		wss.off("connection", onConnection);
	};
}

function sendMsg(ws: WebSocket, msg: WsServerMessage): void {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

function sendError(ws: WebSocket, message: string): void {
	sendMsg(ws, { type: "error", message });
}

/**
 * Bootstrap-channel attach (PR 185b2b). Subscribes the WS to the
 * broadcaster's per-session listener set so the modal's live-tail
 * panel sees output as it streams from `runPostCreate`. Auth +
 * ownership match the terminal-attach path; on close (whether the
 * client navigated away or the broadcaster sent a terminal message
 * and we hung up) the listener is unsubscribed so the broadcaster's
 * Set doesn't leak.
 */
async function handleBootstrapWs(
	ws: WebSocket,
	sessionId: string,
	userId: string,
	sessions: SessionManager,
	broadcaster: BootstrapBroadcaster,
): Promise<void> {
	try {
		await sessions.assertOwnedBy(sessionId, userId);
	} catch (err) {
		if (err instanceof NotFoundError) {
			sendError(ws, "Session not found");
			ws.close(1008, "Not found");
			return;
		}
		if (err instanceof ForbiddenError) {
			sendError(ws, "Forbidden");
			ws.close(1008, "Forbidden");
			return;
		}
		logger.error(`[ws] bootstrap auth failed for ${sessionId}: ${(err as Error).message}`);
		ws.close(1011, "Internal error");
		return;
	}

	const listener = (msg: BootstrapMessage) => {
		if (ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(msg));
		} catch (sendErr) {
			logger.warn(`[ws] bootstrap send failed for ${sessionId}: ${(sendErr as Error).message}`);
		}
		// Close the WS after a terminal message lands. Letting the
		// connection idle would mean every browser tab leaks an
		// open WS forever after the hook completes; explicit close
		// also signals the client to clean up its modal handlers.
		if (msg.type === "done" || msg.type === "fail") {
			ws.close(1000, "Bootstrap complete");
		}
	};

	const unsubscribe = broadcaster.subscribe(sessionId, listener);
	ws.on("close", () => unsubscribe());
	ws.on("error", () => unsubscribe());
	logger.info(`[ws] user=${userId} subscribed to bootstrap channel for session=${sessionId}`);
}
