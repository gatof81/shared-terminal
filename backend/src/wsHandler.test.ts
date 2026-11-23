import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock observeLog at the module boundary so the observe-mode tests
// below can assert on the audit-log call shape without driving D1.
// Hoisted so the mock is in place before wsHandler.js loads it.
const observeLogStubs = vi.hoisted(() => ({
	recordObserveStart: vi.fn(async () => "log-uuid"),
	recordObserveEnd: vi.fn(async () => undefined),
}));
vi.mock("./observeLog.js", () => observeLogStubs);

import { __resetJwtSecretForTests, validateJwtSecret } from "./auth.js";
import type { DockerManager } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";
import { endUpgradeSocketWithReply, handleWsConnection, startWsHeartbeat } from "./wsHandler.js";

// ── Test harness ────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-do-not-use-in-prod";

beforeAll(() => {
	process.env.JWT_SECRET = TEST_SECRET;
	__resetJwtSecretForTests();
	validateJwtSecret();
});

afterAll(() => {
	delete process.env.JWT_SECRET;
	__resetJwtSecretForTests();
});

interface FakeWs {
	readyState: number;
	on: ReturnType<typeof vi.fn>;
	off: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
}

function makeFakeWs(): FakeWs {
	return {
		readyState: 1, // WebSocket.OPEN — sendMsg() gates on this
		on: vi.fn(),
		// `off` mirrors the real ws EventEmitter alias; the handler swaps
		// its setup-phase 'close' listener for the steady-state teardown.
		off: vi.fn(),
		close: vi.fn(),
		send: vi.fn(),
	};
}

function makeReq(
	url: string,
	withToken: boolean,
): {
	url: string;
	headers: Record<string, string | undefined>;
} {
	const headers: Record<string, string | undefined> = {};
	if (withToken) {
		const token = jwt.sign({ sub: "user-1" }, TEST_SECRET);
		// Cookie-based auth (#18): browsers send the auth cookie on the
		// WS upgrade automatically; tests inject the same shape.
		headers.cookie = `st_token=${token}`;
	}
	return { url, headers };
}

// SessionManager / DockerManager aren't reached on any of the early-return
// paths these tests exercise, so a shallow stub is enough.
const fakeSessions = {} as SessionManager;
const fakeDocker = {} as DockerManager;

// ── Auth-first invariant ───────────────────────────────────────────────────
// These tests pin the security invariant from issue #82: an unauthenticated
// caller must always be told "Unauthorized" and never receive a more specific
// error reason that would let them probe path / tab id validity. A future
// refactor that reintroduces the strip → slice ordering of checks would
// silently restore the oracle without these tests.

describe("handleWsConnection auth-first ordering", () => {
	it("unauthenticated caller on a structurally valid path gets Unauthorized", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc?tab=tab-1", false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledTimes(1);
		expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized");
		// No leak of the path/tab error message in the pre-close frame.
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads).toContain(JSON.stringify({ type: "error", message: "Unauthorized" }));
		expect(errPayloads.some((p) => p.includes("Invalid"))).toBe(false);
		expect(errPayloads.some((p) => p.includes("Missing tab"))).toBe(false);
	});

	it("unauthenticated caller on an invalid path gets Unauthorized, not 'Invalid path'", () => {
		const ws = makeFakeWs();
		const req = makeReq("/totally-bogus-route", false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads.some((p) => p.includes("Invalid WebSocket path"))).toBe(false);
	});

	it("unauthenticated caller missing the tab param still gets Unauthorized", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc", false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads.some((p) => p.includes("Missing tab"))).toBe(false);
	});

	it("unauthenticated caller with a malformed tab still gets Unauthorized", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc?tab=evil%20tab", false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads.some((p) => p.includes("Invalid tab id"))).toBe(false);
	});

	it("authenticated caller still receives the specific path error", () => {
		const ws = makeFakeWs();
		const req = makeReq("/totally-bogus-route", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Invalid path");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads).toContain(
			JSON.stringify({ type: "error", message: "Invalid WebSocket path" }),
		);
	});

	it("authenticated caller missing the tab param receives 'Missing tab'", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Missing tab");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads).toContain(JSON.stringify({ type: "error", message: "Missing tab id" }));
	});

	// Regression test for #147. decodeURIComponent throws URIError on
	// malformed sequences like `%G%`; without the try/catch the throw
	// propagates out of the wss connection emit and (with no
	// uncaughtException handler) terminates the entire backend,
	// dropping every other attached session.
	it("authenticated caller with an undecodable tab gets 'Invalid tab', does not throw", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc?tab=%G%", true);
		expect(() => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);
		}).not.toThrow();

		expect(ws.close).toHaveBeenCalledWith(1008, "Invalid tab");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads).toContain(JSON.stringify({ type: "error", message: "Invalid tab id" }));
	});
});

// ── Geometry forwarding ───────────────────────────────────────────────────
// On WS upgrade, the client passes its post-fit cols/rows in the URL so
// docker.attach (and capture-pane downstream) run at the actual viewport
// size — not at D1's stored last-known size. Without this, the replay
// arrives at the wrong cols and the user sees mis-aligned columns until
// a frontend resize event triggers a manual reflow. Bounds are 1..1024
// integer; out-of-range or missing values fall back to session.cols/rows.

describe("handleWsConnection geometry from URL", () => {
	function makeMocks(sessionCols = 80, sessionRows = 24) {
		const sessions = {
			// Non-observe attaches authorize via assertCanOperate now
			// (owner OR admin). userId matches the authed "user-1" so this
			// is the owner path — isAdminOperating stays false, no audit.
			assertCanOperate: vi.fn().mockResolvedValue({
				status: "running",
				userId: "user-1",
				cols: sessionCols,
				rows: sessionRows,
			}),
			updateConnected: vi.fn().mockResolvedValue(undefined),
		} as unknown as SessionManager;
		const docker = {
			attach: vi.fn().mockResolvedValue({ replay: null, flushTail: () => {} }),
			detach: vi.fn(),
		} as unknown as DockerManager;
		return { sessions, docker };
	}

	it("uses cols/rows from URL when both are valid", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks();
		const req = makeReq("/ws/sessions/abc?tab=tab-1&cols=200&rows=60", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		// Wait for the async IIFE (assertOwnership → docker.attach chain) to
		// reach attach. waitFor polls until the assertion holds, robust
		// against any number of intermediate awaits in the handler.
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});

		// 7th positional arg `observe` defaults to false for the
		// owner-only path (#201d). Pin it explicitly so a future
		// refactor that swaps the parameter order surfaces here
		// rather than in the WS handler.
		expect(docker.attach).toHaveBeenCalledWith(
			"abc",
			expect.any(String),
			200,
			60,
			expect.any(Function),
			"tab-1",
			false,
		);
	});

	it("falls back to session.cols/rows when URL omits them", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks(120, 40);
		const req = makeReq("/ws/sessions/abc?tab=tab-1", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		// Wait for the async IIFE (assertOwnership → docker.attach chain) to
		// reach attach. waitFor polls until the assertion holds, robust
		// against any number of intermediate awaits in the handler.
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});

		expect(docker.attach).toHaveBeenCalledWith(
			"abc",
			expect.any(String),
			120,
			40,
			expect.any(Function),
			"tab-1",
			false,
		);
	});

	it("falls back to session.cols/rows when URL values are out of range", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks(120, 40);
		// 0 fails the >=1 guard, 9999 fails the <=1024 guard.
		const req = makeReq("/ws/sessions/abc?tab=tab-1&cols=0&rows=9999", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		// Wait for the async IIFE (assertOwnership → docker.attach chain) to
		// reach attach. waitFor polls until the assertion holds, robust
		// against any number of intermediate awaits in the handler.
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});

		expect(docker.attach).toHaveBeenCalledWith(
			"abc",
			expect.any(String),
			120,
			40,
			expect.any(Function),
			"tab-1",
			false,
		);
	});
});

// ── Close during the attach() window (#298) ──────────────────────────────
// Regression guard: if the socket closes WHILE docker.attach() (or the
// observe-row INSERT) is still awaiting, the teardown handlers aren't
// registered yet and Node won't replay the already-emitted 'close'. The
// handler must record the early close and run detach() once attach()
// resolves — otherwise the shared exec fd and the idle-sweeper-bumping
// outputListener leak forever.

describe("handleWsConnection close-during-attach (#298)", () => {
	it("detaches when the socket closes during the attach() await", async () => {
		const ws = makeFakeWs();
		const sessions = {
			assertCanOperate: vi
				.fn()
				.mockResolvedValue({ status: "running", userId: "user-1", cols: 80, rows: 24 }),
			updateConnected: vi.fn().mockResolvedValue(undefined),
		} as unknown as SessionManager;
		// Deferred attach: lets the test close the socket mid-await before
		// resolving, reproducing the race window.
		let resolveAttach!: (v: { replay: null; flushTail: () => void }) => void;
		const docker = {
			attach: vi.fn(
				() =>
					new Promise((r) => {
						resolveAttach = r;
					}),
			),
			detach: vi.fn(),
		} as unknown as DockerManager;
		const req = makeReq("/ws/sessions/s-1?tab=tab-1", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});

		// Socket closes mid-attach: invoke the only 'close' listener
		// registered so far (the setup-phase flag-setter) and flip
		// readyState as the real transport would.
		const earlyClose = ws.on.mock.calls.find((c) => c[0] === "close");
		expect(earlyClose).toBeDefined();
		(earlyClose![1] as () => void)();
		ws.readyState = 3; // WebSocket.CLOSED

		resolveAttach({ replay: null, flushTail: () => {} });

		await vi.waitFor(() => {
			expect(docker.detach).toHaveBeenCalled();
		});
		// The message handler must never be wired up for a dead socket.
		expect(ws.on.mock.calls.some((c) => c[0] === "message")).toBe(false);
	});
});

// ── Observe-mode (#201d) ─────────────────────────────────────────────────
// `?observe=true` opts into a read-only attach gated on `assertCanObserve`.
// The WS handler must: switch the auth call, pass `observe: true` to
// docker.attach (size-vote suppression at the docker layer), write an
// audit row on attach success / UPDATE on close, and DROP input + resize
// frames at the message layer. The audit log lives in observeLog.ts —
// mocked at the module boundary above so these tests assert on the call
// shape without driving D1.

describe("handleWsConnection observe-mode (#201d)", () => {
	function makeMocks(opts: { ownerId?: string } = {}) {
		// assertCanObserve returns the SessionMeta-shaped result with
		// `userId` so the wsHandler can compute `isObserverNotOwner =
		// observe && session.userId !== userId`. Auth-mode wsHandler
		// tests above set up assertOwnership; this block sets up
		// assertCanObserve.
		const sessions = {
			assertCanObserve: vi.fn().mockResolvedValue({
				status: "running",
				userId: opts.ownerId ?? "owner-1",
				cols: 80,
				rows: 24,
			}),
			// Non-observe attaches route through assertCanOperate. Returns
			// the same owner id so a test with ownerId="user-1" is the
			// owner path and ownerId="owner-bob" is admin-operate (the
			// authed caller is always "user-1").
			assertCanOperate: vi.fn().mockResolvedValue({
				status: "running",
				userId: opts.ownerId ?? "owner-1",
				cols: 80,
				rows: 24,
			}),
			updateConnected: vi.fn().mockResolvedValue(undefined),
		} as unknown as SessionManager;
		const docker = {
			attach: vi.fn().mockResolvedValue({ replay: null, flushTail: () => {} }),
			detach: vi.fn(),
			write: vi.fn(),
			resize: vi.fn().mockResolvedValue(undefined),
		} as unknown as DockerManager;
		return { sessions, docker };
	}

	beforeEach(() => {
		observeLogStubs.recordObserveStart.mockReset();
		observeLogStubs.recordObserveEnd.mockReset();
		observeLogStubs.recordObserveStart.mockResolvedValue("log-uuid");
		observeLogStubs.recordObserveEnd.mockResolvedValue(undefined);
	});

	it("routes auth via assertCanObserve (not assertOwnership) when ?observe=true", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "owner-bob" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1&observe=true", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});
		expect(sessions.assertCanObserve).toHaveBeenCalledWith("s-1", "user-1");
		// The operate gate (used by the non-observe path) must NOT fire
		// when ?observe=true routes through the read-only path.
		expect(sessions.assertCanOperate).not.toHaveBeenCalled();
	});

	it("passes observe=true to docker.attach when observer differs from owner", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "owner-bob" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1&observe=true", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});
		// 7th positional arg is the observe flag.
		const call = (docker.attach as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[6]).toBe(true);
	});

	it("passes observe=false to docker.attach when observer IS the owner (no-audit edge)", async () => {
		// `?observe=true` from the owner is allowed (assertCanObserve
		// accepts owner-self), but the audit log + read-only gate are
		// behaviourally pointless. The wsHandler sets
		// `isObserverNotOwner = observe && session.userId !== userId`
		// so the docker layer attaches normally (size-vote contribution
		// intact) and no audit row is written. Pin this so a future
		// refactor of the discriminator doesn't accidentally log the
		// owner as an observer of their own session.
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "user-1" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1&observe=true", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});
		const call = (docker.attach as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[6]).toBe(false);
		expect(observeLogStubs.recordObserveStart).not.toHaveBeenCalled();
	});

	it("INSERTs an audit row after attach success and UPDATEs on close", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "owner-bob" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1&observe=true", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(observeLogStubs.recordObserveStart).toHaveBeenCalled();
		});
		expect(observeLogStubs.recordObserveStart).toHaveBeenCalledWith(
			"user-1", // observer
			"s-1", // session
			"owner-bob", // owner (denormalised at insert)
			"observe", // #admin-operate: read-only attach tagged 'observe'
		);
		// Simulate WS close. Two "close" listeners are registered: the
		// setup-phase flag-setter (swapped off after attach) and the
		// steady-state teardown. Invoke the LAST one — the real teardown
		// that flips the audit row.
		const closeCalls = ws.on.mock.calls.filter((c) => c[0] === "close");
		expect(closeCalls.length).toBeGreaterThan(0);
		(closeCalls.at(-1)![1] as () => void)();
		// recordObserveEnd is fire-and-forget (the WS-close path doesn't
		// await it; the SQL idempotency is the safety net). waitFor
		// polls until the microtask the close handler scheduled lands.
		await vi.waitFor(() => {
			expect(observeLogStubs.recordObserveEnd).toHaveBeenCalledWith("log-uuid");
		});
	});

	it("aborts the attach + closes the socket when the audit INSERT fails", async () => {
		// The audit-trail invariant requires every observe to be logged.
		// An INSERT failure must bubble out so the socket closes with
		// 1011 — leaving the attach live and unaudited would defeat
		// the trail's purpose.
		observeLogStubs.recordObserveStart.mockRejectedValueOnce(new Error("D1 transient"));
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "owner-bob" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1&observe=true", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(ws.close).toHaveBeenCalled();
		});
		// detach() must run to release the listener registered by
		// docker.attach — otherwise the bufferedListener would pile
		// live bytes forever after the audit failure tore everything
		// else down.
		expect(docker.detach).toHaveBeenCalled();
		// Close with 1011 (internal error) is the catch-block's
		// fall-through for non-NotFound/non-Forbidden throws.
		const closeCodes = ws.close.mock.calls.map((c) => c[0] as number);
		expect(closeCodes).toContain(1011);
	});

	it("drops input frames in observe-mode (does not call docker.write)", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "owner-bob" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1&observe=true", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(observeLogStubs.recordObserveStart).toHaveBeenCalled();
		});
		// Fish out the message handler and feed it an input frame.
		const msgCall = ws.on.mock.calls.find((c) => c[0] === "message");
		expect(msgCall).toBeDefined();
		const onMessage = msgCall![1] as (raw: unknown) => void;
		onMessage(JSON.stringify({ type: "input", data: "rm -rf /" }));
		// The whole point: a write-to-someone's-shell is silently dropped.
		expect(docker.write).not.toHaveBeenCalled();
	});

	it("drops resize frames in observe-mode (does not call docker.resize)", async () => {
		// Defence-in-depth on top of the docker-layer clientSizes
		// skip: dropping the frame here avoids the wasted D1 round-trip
		// through `recomputeSize` and matches the input-drop posture.
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "owner-bob" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1&observe=true", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(observeLogStubs.recordObserveStart).toHaveBeenCalled();
		});
		const msgCall = ws.on.mock.calls.find((c) => c[0] === "message");
		const onMessage = msgCall![1] as (raw: unknown) => void;
		onMessage(JSON.stringify({ type: "resize", cols: 40, rows: 12 }));
		expect(docker.resize).not.toHaveBeenCalled();
	});

	it("non-observe attaches preserve input/resize forwarding (regression guard)", async () => {
		// Pin that the observe-mode drop is conditional on
		// `isObserverNotOwner` — without this guard a future refactor
		// could accidentally hoist the early-return out of the
		// observe branch and break every owner attach silently.
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "user-1" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});
		const msgCall = ws.on.mock.calls.find((c) => c[0] === "message");
		const onMessage = msgCall![1] as (raw: unknown) => void;
		onMessage(JSON.stringify({ type: "input", data: "ls\n" }));
		onMessage(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
		expect(docker.write).toHaveBeenCalledWith(expect.any(String), "ls\n");
		expect(docker.resize).toHaveBeenCalledWith(expect.any(String), 100, 30);
	});

	// ── Admin-operate (non-observe attach on a foreign session) ──────────────
	// An admin attaching WITHOUT ?observe=true drives the session for real:
	// authorized via assertCanOperate, writes NOT dropped, but audited with
	// mode='operate' so the trail records who drove whose session.

	it("routes a non-observe foreign attach via assertCanOperate and audits mode='operate'", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "owner-bob" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1", true); // no observe flag
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(observeLogStubs.recordObserveStart).toHaveBeenCalled();
		});
		expect(sessions.assertCanOperate).toHaveBeenCalledWith("s-1", "user-1");
		expect(observeLogStubs.recordObserveStart).toHaveBeenCalledWith(
			"user-1", // admin caller
			"s-1",
			"owner-bob", // owner
			"operate", // the discriminating tag
		);
		// docker.attach observe flag (7th arg) is FALSE — the admin's
		// viewport contributes to size votes and the pane isn't read-only.
		expect((docker.attach as ReturnType<typeof vi.fn>).mock.calls[0]![6]).toBe(false);
	});

	it("forwards input/resize for an admin-operate attach (writes NOT dropped)", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "owner-bob" });
		const req = makeReq("/ws/sessions/s-1?tab=tab-1", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});
		const onMessage = ws.on.mock.calls.find((c) => c[0] === "message")![1] as (
			raw: unknown,
		) => void;
		onMessage(JSON.stringify({ type: "input", data: "whoami\n" }));
		onMessage(JSON.stringify({ type: "resize", cols: 90, rows: 30 }));
		// The whole point of operate vs observe: the admin CAN type.
		expect(docker.write).toHaveBeenCalledWith(expect.any(String), "whoami\n");
		expect(docker.resize).toHaveBeenCalledWith(expect.any(String), 90, 30);
	});

	it("does NOT audit when the owner attaches normally (owner-operate is not cross-user)", async () => {
		const ws = makeFakeWs();
		const { sessions, docker } = makeMocks({ ownerId: "user-1" }); // owner == caller
		const req = makeReq("/ws/sessions/s-1?tab=tab-1", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, sessions, docker);
		await vi.waitFor(() => {
			expect(docker.attach).toHaveBeenCalled();
		});
		expect(observeLogStubs.recordObserveStart).not.toHaveBeenCalled();
	});
});

// ── endUpgradeSocketWithReply ──────────────────────────────────────────────
// Pins the half-close → bounded-destroy invariant from issue #67. A peer
// that never FINs would otherwise hold the upgrade socket in CLOSE_WAIT
// until kernel keepalive kicks in; the 500 ms timer caps the window so
// an attacker can't pile up dangling rejected upgrades.

describe("endUpgradeSocketWithReply", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function makeFakeSocket() {
		return {
			end: vi.fn(),
			destroy: vi.fn(),
		};
	}

	it("calls end() synchronously with the reply and defers destroy() by 500 ms", () => {
		const socket = makeFakeSocket();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		endUpgradeSocketWithReply(socket as any, "HTTP/1.1 403 Forbidden\r\n\r\n");

		expect(socket.end).toHaveBeenCalledTimes(1);
		expect(socket.end).toHaveBeenCalledWith("HTTP/1.1 403 Forbidden\r\n\r\n");
		expect(socket.destroy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(499);
		expect(socket.destroy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(socket.destroy).toHaveBeenCalledTimes(1);
	});

	it("swallows a destroy() error from a socket the peer already RST'd", () => {
		const socket = {
			end: vi.fn(),
			destroy: vi.fn(() => {
				throw new Error("ERR_SOCKET_ALREADY_DESTROYED");
			}),
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		endUpgradeSocketWithReply(socket as any, "HTTP/1.1 404 Not Found\r\n\r\n");

		// Advancing past 500 ms must not propagate the throw.
		expect(() => vi.advanceTimersByTime(500)).not.toThrow();
		expect(socket.destroy).toHaveBeenCalledTimes(1);
	});
});

// ── startWsHeartbeat ───────────────────────────────────────────────────────
// Pins the bidirectional liveness invariants from issue #79: every tick
// pings each client, terminates anything that didn't pong since the
// previous tick, and the cleanup function returned by startWsHeartbeat
// stops the timer cleanly.

describe("startWsHeartbeat", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	type FakeWs = {
		isAlive?: boolean;
		ping: ReturnType<typeof vi.fn>;
		terminate: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		_pongHandler?: () => void;
	};

	function makeFakeWs(): FakeWs {
		const ws: FakeWs = {
			ping: vi.fn(),
			terminate: vi.fn(),
			on: vi.fn(),
		};
		// Capture the pong handler the moment it's registered so the test
		// can fire it synthetically — that's the path the production code
		// expects, and it's what flips `isAlive` back to true.
		ws.on.mockImplementation((event: string, handler: () => void) => {
			if (event === "pong") ws._pongHandler = handler;
		});
		return ws;
	}

	function makeFakeWss(): {
		wss: { clients: Set<FakeWs>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
		fireConnection: (ws: FakeWs) => void;
	} {
		const clients = new Set<FakeWs>();
		let connectionHandler: ((ws: FakeWs) => void) | undefined;
		const on = vi.fn((event: string, handler: (ws: FakeWs) => void) => {
			if (event === "connection") connectionHandler = handler;
		});
		const off = vi.fn();
		return {
			wss: { clients, on, off },
			fireConnection: (ws: FakeWs) => {
				clients.add(ws);
				connectionHandler?.(ws);
			},
		};
	}

	it("pings every connected client on each tick and marks them not-yet-replied", () => {
		const { wss, fireConnection } = makeFakeWss();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		startWsHeartbeat(wss as any, 30_000);

		const ws = makeFakeWs();
		fireConnection(ws);
		expect(ws.isAlive).toBe(true);

		vi.advanceTimersByTime(30_000);
		expect(ws.ping).toHaveBeenCalledTimes(1);
		expect(ws.isAlive).toBe(false);
	});

	it("terminates a client that didn't pong before the next tick", () => {
		const { wss, fireConnection } = makeFakeWss();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		startWsHeartbeat(wss as any, 30_000);

		const ws = makeFakeWs();
		fireConnection(ws);

		// Tick 1: ping, isAlive flipped to false. No pong fired.
		vi.advanceTimersByTime(30_000);
		expect(ws.terminate).not.toHaveBeenCalled();

		// Tick 2: still false → terminate.
		vi.advanceTimersByTime(30_000);
		expect(ws.terminate).toHaveBeenCalledTimes(1);
	});

	it("does NOT terminate a client whose pong fired before the next tick", () => {
		const { wss, fireConnection } = makeFakeWss();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		startWsHeartbeat(wss as any, 30_000);

		const ws = makeFakeWs();
		fireConnection(ws);

		vi.advanceTimersByTime(30_000);
		// Production path: browser auto-replies → ws emits 'pong' → handler
		// flips isAlive back to true.
		ws._pongHandler?.();
		expect(ws.isAlive).toBe(true);

		vi.advanceTimersByTime(30_000);
		expect(ws.terminate).not.toHaveBeenCalled();
		expect(ws.ping).toHaveBeenCalledTimes(2);
	});

	it("swallows a ping() throw and terminates on the next tick", () => {
		const { wss, fireConnection } = makeFakeWss();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		startWsHeartbeat(wss as any, 30_000);

		const ws = makeFakeWs();
		ws.ping.mockImplementation(() => {
			throw new Error("ERR_SOCKET_CLOSED");
		});
		fireConnection(ws);

		// Tick 1: ping throws, isAlive stays false (already set before
		// the try/catch). Must not propagate.
		expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();

		// Tick 2: still false → terminate.
		vi.advanceTimersByTime(30_000);
		expect(ws.terminate).toHaveBeenCalledTimes(1);
	});

	it("cleanup function stops the interval AND drops the connection listener", () => {
		const { wss, fireConnection } = makeFakeWss();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const stop = startWsHeartbeat(wss as any, 30_000);

		const ws = makeFakeWs();
		fireConnection(ws);

		stop();
		// No more ticks after cleanup.
		vi.advanceTimersByTime(120_000);
		expect(ws.ping).not.toHaveBeenCalled();
		expect(ws.terminate).not.toHaveBeenCalled();
		// Connection listener removed so a future post-shutdown connection
		// (e.g. a buffered upgrade flushing late) doesn't get tagged.
		expect(wss.off).toHaveBeenCalledWith("connection", expect.any(Function));
	});

	it("snapshots wss.clients so terminating mid-iteration doesn't skip the next client", () => {
		// `ws` removes terminated clients from `wss.clients` synchronously
		// on the close event. Iterating the live Set would silently skip
		// the entry after a terminated one, postponing its reaping by a
		// full tick.
		const { wss, fireConnection } = makeFakeWss();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		startWsHeartbeat(wss as any, 30_000);

		const dead = makeFakeWs();
		const alive = makeFakeWs();
		fireConnection(dead);
		fireConnection(alive);

		// Stale `dead`: simulate a missed pong by forcing isAlive false
		// before the tick. The handler also removes from the set on
		// terminate, mirroring `ws`'s real behaviour.
		dead.isAlive = false;
		dead.terminate.mockImplementation(() => {
			wss.clients.delete(dead);
		});

		vi.advanceTimersByTime(30_000);

		expect(dead.terminate).toHaveBeenCalledTimes(1);
		// `alive` MUST still be visited inside the same tick — otherwise
		// the snapshot guarantee is broken.
		expect(alive.ping).toHaveBeenCalledTimes(1);
		expect(alive.isAlive).toBe(false);
	});
});
