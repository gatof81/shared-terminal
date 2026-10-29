/**
 * wsUpgrade.test.ts — the WebSocket entry point THROUGH the production path.
 *
 * Every earlier WS test called `handleWsConnection` directly, so the
 * `server.on("upgrade")` filter that stands before it was never exercised —
 * and 3.1 shipped with `/ws/conversation/` refused there (404 in production
 * with a valid cookie and an allowed Origin). This suite mounts the real
 * `createWsUpgradeHandler` on a real `http.Server`, wires the real
 * `handleWsConnection` to its `connection` event, and drives both with a
 * real `ws` client, so a path the handler routes but the filter refuses
 * fails here first.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { __resetJwtSecretForTests, validateJwtSecret } from "./auth.js";
import { BootstrapBroadcaster } from "./bootstrap.js";
import { ConversationWsHub } from "./conversation/ws.js";
import type { DockerManager } from "./dockerManager.js";
import { createPortDispatcher } from "./portDispatcher.js";
import { ForbiddenError, NotFoundError, type SessionManager } from "./sessionManager.js";
import { handleWsConnection } from "./wsHandler.js";
import {
	createWsUpgradeHandler,
	isWsPath,
	WS_PATH_PREFIXES,
	type WsUpgradeDeps,
} from "./wsUpgrade.js";
import { createWsUpgradeRateLimiter } from "./wsUpgradeRateLimit.js";

// ── Harness ──────────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-do-not-use-in-prod";
const ALLOWED_ORIGIN = "https://app.test";
const OWNER = "user-owner";
const OTHER = "user-other";
const OWNED = "s-owned";
const FOREIGN = "s-foreign";

beforeAll(() => {
	process.env.JWT_SECRET = TEST_SECRET;
	__resetJwtSecretForTests();
	validateJwtSecret();
});
afterAll(() => {
	delete process.env.JWT_SECRET;
	__resetJwtSecretForTests();
});

const cookieFor = (userId: string) => `st_token=${jwt.sign({ sub: userId }, TEST_SECRET)}`;

// Controlled sessions: OWNED belongs to OWNER, FOREIGN to someone else,
// everything else does not exist. The owner-only checks are the real
// SessionManager semantics the handler relies on (NotFound / Forbidden).
const sessions = {
	assertOwnedBy: vi.fn(async (sid: string, userId: string) => {
		if (sid === OWNED && userId === OWNER) return;
		if (sid === FOREIGN || sid === OWNED) throw new ForbiddenError();
		throw new NotFoundError();
	}),
	assertCanOperate: vi.fn(async (sid: string, userId: string) => {
		if (sid === OWNED && userId === OWNER) {
			// `terminated` makes the terminal path answer deterministically
			// (1008 "Session terminated") without a Docker attach.
			return { sessionId: sid, userId: OWNER, status: "terminated" };
		}
		throw new NotFoundError();
	}),
} as unknown as SessionManager;
const docker = {} as DockerManager;

let server: http.Server;
let wss: WebSocketServer;
let port: number;
let broadcaster: BootstrapBroadcaster;
let hub: ConversationWsHub;
const summaries = vi.fn(async (_sid: string) => []);

async function start(overrides: Partial<WsUpgradeDeps> = {}) {
	wss = new WebSocketServer({ noServer: true });
	broadcaster = new BootstrapBroadcaster();
	hub = new ConversationWsHub({
		summaries,
		conversationFile: async () => null,
		residentState: () => null,
		onPersistedEvent: () => () => {},
		noteWsResync: () => {},
	});
	server = http.createServer((_req, res) => {
		res.statusCode = 404;
		res.end();
	});
	// The production wiring, minus the process-wide singletons: the real
	// (disabled) dispatcher, the real limiter, the real connection handler.
	server.on(
		"upgrade",
		createWsUpgradeHandler({
			wss,
			portDispatcher: createPortDispatcher({
				baseDomain: undefined,
				corsOrigins: [ALLOWED_ORIGIN],
				nodeEnv: "test",
			}),
			dispatcherWsUpgradeLimiter: createWsUpgradeRateLimiter({ windowMs: 60_000, max: 60 }),
			trustProxyValue: undefined,
			corsOrigins: [ALLOWED_ORIGIN],
			nodeEnv: "test",
			...overrides,
		}),
	);
	wss.on("connection", (ws, req) => {
		handleWsConnection(ws, req, sessions, docker, broadcaster, undefined, hub);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	port = (server.address() as AddressInfo).port;
}

interface Outcome {
	/** HTTP status of a refused handshake; null when the upgrade completed. */
	status: number | null;
	opened: boolean;
	frames: Array<Record<string, unknown>>;
	close: Promise<{ code: number; reason: string }>;
	ws: WebSocket;
}

/** Open a client and wait until the handshake is decided (101 or an HTTP refusal). */
function connect(path: string, headers: Record<string, string> = {}): Promise<Outcome> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
		const frames: Array<Record<string, unknown>> = [];
		ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
		const close = new Promise<{ code: number; reason: string }>((r) =>
			ws.on("close", (code, reason) => r({ code, reason: reason.toString() })),
		);
		ws.on("unexpected-response", (_req, res) => {
			res.resume();
			resolve({ status: res.statusCode ?? 0, opened: false, frames, close, ws });
		});
		ws.on("error", () => {
			/* reported through unexpected-response / close */
		});
		ws.on("open", () => resolve({ status: null, opened: true, frames, close, ws }));
	});
}

const waitFor = async (pred: () => boolean, ms = 5_000) => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 5));
	}
};

const asOwner = (extra: Record<string, string> = {}) => ({
	cookie: cookieFor(OWNER),
	origin: ALLOWED_ORIGIN,
	...extra,
});

beforeEach(async () => {
	sessions.assertOwnedBy.mockClear();
	sessions.assertCanOperate.mockClear();
	summaries.mockClear();
	await start();
});
afterEach(async () => {
	for (const c of wss.clients) c.terminate();
	await new Promise<void>((r) => server.close(() => r()));
});

// ── Admission predicate ──────────────────────────────────────────────────────

describe("isWsPath", () => {
	it("admits exactly the three app prefixes", () => {
		expect(WS_PATH_PREFIXES).toEqual(["/ws/sessions/", "/ws/bootstrap/", "/ws/conversation/"]);
		expect(isWsPath("/ws/sessions/abc?tab=t1")).toBe(true);
		expect(isWsPath("/ws/bootstrap/abc")).toBe(true);
		expect(isWsPath("/ws/conversation/abc")).toBe(true);
	});
	it("refuses near misses", () => {
		for (const p of [
			"/ws/conversation",
			"/ws/conversations/abc",
			"/ws/sessions",
			"/ws/",
			"/api/ws/sessions/x",
			"",
		]) {
			expect(isWsPath(p), p).toBe(false);
		}
	});
});

// ── /ws/conversation through the real upgrade path (3.1 hotfix) ─────────────

describe("WS /ws/conversation/<sid> through server.on('upgrade')", () => {
	it("a valid upgrade completes (101) and receives the hello frame", async () => {
		const c = await connect(`/ws/conversation/${OWNED}`, asOwner());
		expect(c.status).toBeNull();
		expect(c.opened).toBe(true);
		await waitFor(() => c.frames.some((f) => f.type === "hello"));
		expect(c.frames[0]).toEqual({ type: "hello", conversations: [] });
		expect(sessions.assertOwnedBy).toHaveBeenCalledWith(OWNED, OWNER);
		expect(summaries).toHaveBeenCalledWith(OWNED);
		expect(hub.openSockets(OWNER)).toBe(1);
		c.ws.close();
		await c.close;
	});

	it("works for a non-browser client (no Origin), like the REST surface", async () => {
		const c = await connect(`/ws/conversation/${OWNED}`, { cookie: cookieFor(OWNER) });
		expect(c.opened).toBe(true);
		await waitFor(() => c.frames.some((f) => f.type === "hello"));
		c.ws.close();
		await c.close;
	});

	it("without a valid cookie the connection is refused before any authorization or hello", async () => {
		for (const headers of [
			{ origin: ALLOWED_ORIGIN },
			{ origin: ALLOWED_ORIGIN, cookie: "st_token=not.a.jwt" },
		]) {
			const c = await connect(`/ws/conversation/${OWNED}`, headers);
			const closed = await c.close;
			expect(closed).toEqual({ code: 1008, reason: "Unauthorized" });
			expect(c.frames).toEqual([{ type: "error", message: "Unauthorized" }]);
		}
		expect(sessions.assertOwnedBy).not.toHaveBeenCalled();
		expect(summaries).not.toHaveBeenCalled();
	});

	it("a disallowed Origin is refused with 403 before the handshake — no socket, no auth", async () => {
		const c = await connect(`/ws/conversation/${OWNED}`, asOwner({ origin: "https://evil.test" }));
		expect(c.status).toBe(403);
		expect(c.opened).toBe(false);
		expect(wss.clients.size).toBe(0);
		expect(sessions.assertOwnedBy).not.toHaveBeenCalled();
		expect(hub.openSockets(OWNER)).toBe(0);
	});

	it("a foreign or missing session is refused identically, with no hello and no detail", async () => {
		const foreign = await connect(`/ws/conversation/${FOREIGN}`, asOwner());
		const missing = await connect("/ws/conversation/s-does-not-exist", asOwner());
		const [fc, mc] = await Promise.all([foreign.close, missing.close]);
		expect(fc).toEqual({ code: 1008, reason: "Not found" });
		expect(mc).toEqual(fc);
		expect(foreign.frames).toEqual([{ type: "error", message: "Session not found" }]);
		expect(missing.frames).toEqual(foreign.frames);
		expect(summaries).not.toHaveBeenCalled();
		expect(hub.openSockets(OWNER)).toBe(0);
		// The only owner check ran as the caller, never as the real owner.
		expect(sessions.assertOwnedBy).toHaveBeenCalledWith(FOREIGN, OWNER);
		expect(sessions.assertOwnedBy).toHaveBeenCalledWith("s-does-not-exist", OWNER);
	});

	it("another user's valid cookie cannot observe the owner's conversations", async () => {
		const c = await connect(`/ws/conversation/${OWNED}`, {
			cookie: cookieFor(OTHER),
			origin: ALLOWED_ORIGIN,
		});
		expect(await c.close).toEqual({ code: 1008, reason: "Not found" });
		expect(c.frames).toEqual([{ type: "error", message: "Session not found" }]);
		expect(summaries).not.toHaveBeenCalled();
	});
});

// ── The pre-existing routes and the refusals stay as they were ──────────────

describe("existing WS routes through the same entry", () => {
	it("/ws/sessions/<sid>?tab= is admitted and reaches the terminal handler", async () => {
		const c = await connect(`/ws/sessions/${OWNED}?tab=t1`, asOwner());
		expect(c.opened).toBe(true);
		// Reached `assertCanOperate` and acted on the (terminated) session.
		expect(await c.close).toEqual({ code: 1008, reason: "Session terminated" });
		expect(c.frames).toEqual([{ type: "error", message: "Session is terminated" }]);
		expect(sessions.assertCanOperate).toHaveBeenCalledWith(OWNED, OWNER);
	});

	it("/ws/bootstrap/<sid> is admitted and subscribes to the broadcaster", async () => {
		const c = await connect(`/ws/bootstrap/${OWNED}`, asOwner());
		expect(c.opened).toBe(true);
		await waitFor(() => sessions.assertOwnedBy.mock.calls.length === 1);
		// Subscription is installed after the awaited owner check.
		await waitFor(() => {
			broadcaster.broadcast(OWNED, "hello from postCreate");
			return c.frames.some((f) => f.type === "output");
		});
		expect(c.frames[0]).toEqual({ type: "output", data: "hello from postCreate" });
		c.ws.close();
		await c.close;
	});

	it("unauthenticated callers on the existing routes still get Unauthorized", async () => {
		for (const path of [`/ws/sessions/${OWNED}?tab=t1`, `/ws/bootstrap/${OWNED}`]) {
			const c = await connect(path, { origin: ALLOWED_ORIGIN });
			expect(await c.close).toEqual({ code: 1008, reason: "Unauthorized" });
		}
	});

	it("an unknown WebSocket path is refused with 404 before the handshake", async () => {
		for (const path of [
			"/ws/other/x",
			"/ws/conversations/s-owned",
			"/ws/conversation",
			"/api/sessions",
			"/",
		]) {
			const c = await connect(path, asOwner());
			expect(c.status, path).toBe(404);
			expect(c.opened, path).toBe(false);
		}
		expect(wss.clients.size).toBe(0);
		expect(sessions.assertOwnedBy).not.toHaveBeenCalled();
	});

	it("a dispatcher claim precedes the path filter and the Origin check", async () => {
		await new Promise<void>((r) => server.close(() => r()));
		const claimed: string[] = [];
		await start({
			portDispatcher: {
				isDispatcherHost: () => false,
				handleUpgrade: (req, socket) => {
					claimed.push(req.url ?? "");
					socket.end("HTTP/1.1 418 I'm a teapot\r\nContent-Length: 0\r\n\r\n");
					return true;
				},
			},
		});
		const c = await connect("/ws/nowhere", { origin: "https://evil.test" });
		expect(c.status).toBe(418);
		expect(claimed).toEqual(["/ws/nowhere"]);
		expect(wss.clients.size).toBe(0);
	});
});
