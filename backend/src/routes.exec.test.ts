/**
 * routes.exec.test.ts — HTTP exec API route tests (#381).
 *
 * Pins the contract documented in docs/EXEC_API.md: NDJSON event order
 * (`started` strictly first, even when stderr beats the pgid sentinel),
 * exit-reason attribution (exited / killed / timeout), the recovery
 * endpoint's `unknown` semantics, kill idempotency without /proc
 * re-probing, and the per-session concurrency cap.
 *
 * Heavy mocking pattern follows `routes.start.test.ts`: stub `./auth.js`
 * so routing tests don't touch D1, then exercise the express app via a
 * real HTTP server bound to an ephemeral port.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const authStubs = vi.hoisted(() => ({
	requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "u1";
		next();
	},
	requireAdmin: (req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "u1";
		next();
	},
	AUTH_COOKIE_NAME: "st_token",
	setAuthCookie: vi.fn(),
	clearAuthCookie: vi.fn(),
	extractTokenFromCookieHeader: vi.fn(() => null),
	verifyJwt: vi.fn(() => null),
	hasAnyUsers: vi.fn(async () => true),
	registerUser: vi.fn(),
	loginUser: vi.fn(),
	listInvites: vi.fn(async () => [] as unknown[]),
	createInvite: vi.fn(),
	revokeInvite: vi.fn(),
	InvalidCredentialsError: class extends Error {},
	UsernameTakenError: class extends Error {},
	InviteRequiredError: class extends Error {},
	InviteQuotaExceededError: class extends Error {},
}));
vi.mock("./auth.js", () => authStubs);

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { requestIdMiddleware } from "./requestContext.js";
import type { RouteIdleSweeper } from "./routes/shared.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
import { ForbiddenError, NotFoundError } from "./sessionManager.js";
import type { SessionMeta, SessionStatus } from "./types.js";

type StreamExecOpts = {
	cmd: string[];
	env?: Record<string, string>;
	workingDir?: string;
	newProcessGroup?: boolean;
	onProcessGroup?: (pgid: number) => void;
	onStreamHandle?: (handle: { pause: () => void; resume: () => void }) => void;
};
type OnOutput = (chunk: string, stream: "stdout" | "stderr") => void;
type StreamExecImpl = (
	sessionId: string,
	opts: StreamExecOpts,
	onOutput?: OnOutput,
) => Promise<{ exitCode: number }>;

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running",
		containerId: "c1",
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
		...overrides,
	};
}

function makeFakeSessions(
	status: SessionStatus = "running",
	metaOverrides: Partial<SessionMeta> = {},
): SessionManager {
	const meta = makeMeta({
		status,
		containerId: status === "running" ? "c1" : null,
		...metaOverrides,
	});
	// All three exec routes authorize operate-tier (#416): the meta-returning
	// assertCanOperate is the only predicate they call.
	return {
		assertCanOperate: vi.fn(async () => meta),
	} as unknown as SessionManager;
}

function makeFakeDocker(streamExec: StreamExecImpl) {
	const killSpy = vi.fn(async (): Promise<string> => "killed");
	const docker = {
		streamExec: vi.fn(streamExec),
		killExecProcessGroup: killSpy,
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
	} as unknown as DockerManager;
	return { docker, killSpy };
}

let server: http.Server | null = null;
let baseUrl = "";

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((e) => (e ? reject(e) : resolve()));
		});
		server = null;
	}
});

async function spinUp(
	sessions: SessionManager,
	docker: DockerManager,
	idleSweeper?: RouteIdleSweeper,
) {
	const broadcaster = {} as BootstrapBroadcaster;
	const router = buildRouter(
		sessions,
		docker,
		broadcaster,
		{
			login: { ipMax: 1000, ipWindowMs: 60_000, usernameMax: 1000, usernameWindowMs: 60_000 },
			register: { ipMax: 1000, ipWindowMs: 60_000 },
			invitesCreate: { ipMax: 1000, ipWindowMs: 60_000 },
			invitesList: { ipMax: 1000, ipWindowMs: 60_000 },
			invitesRevoke: { ipMax: 1000, ipWindowMs: 60_000 },
			fileUpload: { ipMax: 1000, ipWindowMs: 60_000 },
			logout: { ipMax: 1000, ipWindowMs: 60_000 },
			authStatus: { ipMax: 1000, ipWindowMs: 60_000 },
			adminStats: { ipMax: 1000, ipWindowMs: 60_000 },
			adminAction: { ipMax: 1000, ipWindowMs: 60_000 },
			exec: { ipMax: 1000, ipWindowMs: 60_000 },
		},
		idleSweeper,
	);
	const app = express();
	// Real request-id middleware so the routes' X-Request-Id emission and
	// the started event's requestId echo are exercised, not stubbed.
	app.use(requestIdMiddleware);
	app.use(express.json());
	app.use("/api", router);
	const s = http.createServer(app);
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	const { port } = s.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
}

function startExec(body: unknown): Promise<Response> {
	return fetch(`${baseUrl}/api/sessions/sess-1/exec`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Incremental NDJSON reader over a fetch response body. */
function ndjsonReader(res: Response) {
	const reader = res.body?.getReader();
	if (!reader) throw new Error("response has no body");
	const decoder = new TextDecoder();
	let buf = "";
	return {
		async next(): Promise<Record<string, unknown> | null> {
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl !== -1) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line.trim() === "") continue;
					return JSON.parse(line) as Record<string, unknown>;
				}
				const { done, value } = await reader.read();
				if (done) return null;
				buf += decoder.decode(value, { stream: true });
			}
		},
	};
}

async function readAllEvents(res: Response): Promise<Record<string, unknown>[]> {
	const text = await res.text();
	return text
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("POST /sessions/:id/exec", () => {
	it("streams started → output(stream-labelled) → exit with reason 'exited'", async () => {
		const { docker } = makeFakeDocker(async (_sid, opts, onOutput) => {
			opts.onProcessGroup?.(4321);
			onOutput?.("hello ", "stdout");
			onOutput?.("oops\n", "stderr");
			return { exitCode: 0 };
		});
		await spinUp(makeFakeSessions(), docker);

		const res = await startExec({ cmd: ["echo", "hi"] });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		const requestId = res.headers.get("x-request-id");
		expect(requestId).toMatch(/^[0-9a-f]{16}$/);

		const events = await readAllEvents(res);
		expect(events.map((e) => e.type)).toEqual(["started", "output", "output", "exit"]);
		expect(events[0]).toMatchObject({ v: 1, pgid: 4321, requestId });
		expect(events[0]?.execId).toMatch(/^e_[0-9a-f]{16}$/);
		expect(events[1]).toMatchObject({ stream: "stdout", data: "hello " });
		expect(events[2]).toMatchObject({ stream: "stderr", data: "oops\n" });
		expect(events[3]).toMatchObject({ exitCode: 0, reason: "exited" });
	});

	it("holds output that beats the pgid sentinel so `started` is still first", async () => {
		const { docker } = makeFakeDocker(async (_sid, opts, onOutput) => {
			// Early stderr arrives before the wrapper's stdout sentinel.
			onOutput?.("early diagnostics\n", "stderr");
			opts.onProcessGroup?.(99);
			onOutput?.("late\n", "stdout");
			return { exitCode: 2 };
		});
		await spinUp(makeFakeSessions(), docker);

		const events = await readAllEvents(await startExec({ cmd: ["x"] }));
		expect(events.map((e) => e.type)).toEqual(["started", "output", "output", "exit"]);
		expect(events[1]).toMatchObject({ stream: "stderr", data: "early diagnostics\n" });
		expect(events[3]).toMatchObject({ exitCode: 2 });
	});

	it("signals pre-sentinel buffer overflow with a `dropped` event instead of a silent gap", async () => {
		// Two 200 KiB stderr chunks before the sentinel: the first fits the
		// 256 KiB hold buffer, the second overflows and must be reported.
		const big = "x".repeat(200 * 1024);
		const { docker } = makeFakeDocker(async (_sid, opts, onOutput) => {
			onOutput?.(big, "stderr");
			onOutput?.(big, "stderr");
			opts.onProcessGroup?.(31);
			return { exitCode: 0 };
		});
		await spinUp(makeFakeSessions(), docker);

		const events = await readAllEvents(await startExec({ cmd: ["x"] }));
		expect(events.map((e) => e.type)).toEqual(["started", "output", "dropped", "exit"]);
		// The surviving buffered chunk flushes intact; the dropped event
		// reports raw output bytes so the consumer can size the gap.
		expect((events[1]?.data as string).length).toBe(big.length);
		expect(events[2]).toMatchObject({ v: 1, scope: "pre-start", bytes: big.length });
	});

	it("passes cmd/env/workingDir through and always requests a fresh process group", async () => {
		let seen: StreamExecOpts | undefined;
		const { docker } = makeFakeDocker(async (_sid, opts) => {
			seen = opts;
			opts.onProcessGroup?.(2);
			return { exitCode: 0 };
		});
		await spinUp(makeFakeSessions(), docker);

		await readAllEvents(
			await startExec({ cmd: ["env"], env: { FOO: "bar" }, workingDir: "/home/developer" }),
		);
		expect(seen).toMatchObject({
			cmd: ["env"],
			env: { FOO: "bar" },
			workingDir: "/home/developer",
			newProcessGroup: true,
		});
	});

	it("409s when the session is not running, before any docker call", async () => {
		const { docker } = makeFakeDocker(async () => ({ exitCode: 0 }));
		await spinUp(makeFakeSessions("stopped"), docker);

		const res = await startExec({ cmd: ["echo"] });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "container-not-running" });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("400s malformed bodies without registering an exec", async () => {
		const { docker } = makeFakeDocker(async () => ({ exitCode: 0 }));
		await spinUp(makeFakeSessions(), docker);

		for (const body of [
			{},
			{ cmd: [] },
			{ cmd: "echo hi" },
			{ cmd: [""] },
			{ cmd: ["x"], extra: 1 },
		]) {
			const res = await startExec(body);
			expect(res.status).toBe(400);
		}
		// env validation rides the session-config validator: "=" in a name
		// would smuggle a second variable through the k=v join.
		const res = await startExec({ cmd: ["x"], env: { "BAD=NAME": "v" } });
		expect(res.status).toBe(400);
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("404s a missing session", async () => {
		const sessions = {
			assertCanOperate: vi.fn(async () => {
				throw new NotFoundError("Session not found");
			}),
		} as unknown as SessionManager;
		const { docker } = makeFakeDocker(async () => ({ exitCode: 0 }));
		await spinUp(sessions, docker);

		const res = await startExec({ cmd: ["x"] });
		expect(res.status).toBe(404);
	});

	it("429s the 5th concurrent exec for the same session", async () => {
		const resolvers: Array<(v: { exitCode: number }) => void> = [];
		const { docker } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(10 + resolvers.length);
			return new Promise((resolve) => {
				resolvers.push(resolve);
			});
		});
		await spinUp(makeFakeSessions(), docker);

		// Await each response: its arrival proves the exec registered (the
		// `started` event has been flushed) before the next one fires.
		const streams: Response[] = [];
		for (let i = 0; i < 4; i++) streams.push(await startExec({ cmd: ["sleep"] }));

		const fifth = await startExec({ cmd: ["sleep"] });
		expect(fifth.status).toBe(429);
		expect(await fifth.json()).toEqual({ error: "too-many-concurrent-execs" });

		for (const r of resolvers) r({ exitCode: 0 });
		await Promise.all(streams.map((s) => s.text()));
	});

	it("emits a terminal error event on mid-stream docker failure", async () => {
		const { docker } = makeFakeDocker(async (_sid, opts, onOutput) => {
			opts.onProcessGroup?.(55);
			onOutput?.("partial", "stdout");
			throw new Error("container died");
		});
		await spinUp(makeFakeSessions(), docker);

		const res = await startExec({ cmd: ["x"] });
		expect(res.status).toBe(200);
		const events = await readAllEvents(res);
		const last = events.at(-1);
		expect(last).toMatchObject({ type: "error", code: "exec-failed" });
	});

	it("kills on maxDurationMs expiry and attributes the exit to 'timeout'", async () => {
		let resolveExec: ((v: { exitCode: number }) => void) | undefined;
		const { docker, killSpy } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(77);
			return new Promise((resolve) => {
				resolveExec = resolve;
			});
		});
		killSpy.mockImplementation(async () => {
			resolveExec?.({ exitCode: 124 });
			return "killed";
		});
		await spinUp(makeFakeSessions(), docker);

		const res = await startExec({ cmd: ["sleep", "999"], maxDurationMs: 40 });
		const events = await readAllEvents(res);
		expect(killSpy).toHaveBeenCalledWith("sess-1", 77, 5000);
		expect(events.at(-1)).toMatchObject({ type: "exit", exitCode: 124, reason: "timeout" });
	});
});

describe("POST /sessions/:id/exec/:execId/kill", () => {
	it("kills a running exec by pgid and the stream exits with reason 'killed'", async () => {
		let resolveExec: ((v: { exitCode: number }) => void) | undefined;
		const { docker, killSpy } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(88);
			return new Promise((resolve) => {
				resolveExec = resolve;
			});
		});
		killSpy.mockImplementation(async () => {
			resolveExec?.({ exitCode: 137 });
			return "killed";
		});
		await spinUp(makeFakeSessions(), docker);

		const res = await startExec({ cmd: ["sleep", "999"] });
		const reader = ndjsonReader(res);
		const started = await reader.next();
		expect(started?.type).toBe("started");
		const execId = started?.execId as string;

		const kill = await fetch(`${baseUrl}/api/sessions/sess-1/exec/${execId}/kill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ graceMs: 1000 }),
		});
		expect(kill.status).toBe(200);
		expect(await kill.json()).toEqual({ outcome: "killed" });
		expect(killSpy).toHaveBeenCalledWith("sess-1", 88, 1000);

		const exit = await reader.next();
		expect(exit).toMatchObject({ type: "exit", exitCode: 137, reason: "killed" });
	});

	it("404s an execId the registry does not hold", async () => {
		const { docker } = makeFakeDocker(async () => ({ exitCode: 0 }));
		await spinUp(makeFakeSessions(), docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/exec/e_deadbeefdeadbeef/kill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(404);
	});

	it("answers 'already-exited' from the registry without re-probing the pgid", async () => {
		const { docker, killSpy } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(66);
			return { exitCode: 0 };
		});
		await spinUp(makeFakeSessions(), docker);

		const events = await readAllEvents(await startExec({ cmd: ["true"] }));
		const execId = events[0]?.execId as string;

		const kill = await fetch(`${baseUrl}/api/sessions/sess-1/exec/${execId}/kill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(kill.status).toBe(200);
		expect(await kill.json()).toEqual({ outcome: "already-exited" });
		// The pgid may have been recycled inside the container — a probe
		// here could shoot an unrelated process group.
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("400s a graceMs above the server cap", async () => {
		const { docker } = makeFakeDocker(async () => ({ exitCode: 0 }));
		await spinUp(makeFakeSessions(), docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/exec/e_deadbeefdeadbeef/kill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ graceMs: 60_000 }),
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /sessions/:id/exec/:execId", () => {
	it("reports running (with pgid), exited (with code + reason), and unknown", async () => {
		let resolveExec: ((v: { exitCode: number }) => void) | undefined;
		const { docker } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(44);
			return new Promise((resolve) => {
				resolveExec = resolve;
			});
		});
		await spinUp(makeFakeSessions(), docker);

		const res = await startExec({ cmd: ["sleep"] });
		const reader = ndjsonReader(res);
		const started = await reader.next();
		const execId = started?.execId as string;

		const statusUrl = `${baseUrl}/api/sessions/sess-1/exec/${execId}`;
		const running = await (await fetch(statusUrl)).json();
		expect(running).toMatchObject({ execId, state: "running", pgid: 44 });

		resolveExec?.({ exitCode: 3 });
		await reader.next(); // drain the exit event so the registry settles
		const exited = await (await fetch(statusUrl)).json();
		expect(exited).toMatchObject({ execId, state: "exited", exitCode: 3, reason: "exited" });

		// Registry-lost / never-existed are indistinguishable: both answer
		// `unknown` (a 404 would misread as "never existed" after restart).
		const unknown = await (
			await fetch(`${baseUrl}/api/sessions/sess-1/exec/e_0000000000000000`)
		).json();
		expect(unknown).toEqual({ execId: "e_0000000000000000", state: "unknown" });
	});
});

// ── Operate-tier authorization + cross-user audit (#416) ────────────────────
//
// The auth stub pins the caller to "u1"; a FOREIGN session is simulated by
// having assertCanOperate resolve meta with a different owner (the shape it
// returns for an admin caller), and a denied caller by having it throw
// ForbiddenError (the shape it returns for a non-admin non-owner).

/** SQL fragments recorded against the mocked d1Query. */
function observeLogCalls() {
	return dbStubs.d1Query.mock.calls as unknown as [string, unknown[]][];
}
function auditInserts() {
	return observeLogCalls().filter(([sql]) => sql.includes("INSERT INTO session_observe_log"));
}
function auditEnds() {
	return observeLogCalls().filter(([sql]) => sql.includes("UPDATE session_observe_log"));
}

describe("exec operate-tier (#416)", () => {
	const forbidden = () =>
		({
			assertCanOperate: vi.fn(async () => {
				throw new ForbiddenError("Forbidden");
			}),
		}) as unknown as SessionManager;

	it("admin exec into a foreign session streams normally and writes a start→end audit row", async () => {
		dbStubs.d1Query.mockClear();
		const { docker } = makeFakeDocker(async (_sid, opts, onOutput) => {
			opts.onProcessGroup?.(21);
			onOutput?.("out\n", "stdout");
			return { exitCode: 0 };
		});
		await spinUp(makeFakeSessions("running", { userId: "owner-9" }), docker);

		const res = await startExec({ cmd: ["echo"] });
		expect(res.status).toBe(200);
		const events = await readAllEvents(res);
		expect(events.map((e) => e.type)).toEqual(["started", "output", "exit"]);

		const inserts = auditInserts();
		expect(inserts).toHaveLength(1);
		// [id, observer_user_id, session_id, owner_user_id, mode]
		expect(inserts[0]?.[1]?.slice(1)).toEqual(["u1", "sess-1", "owner-9", "operate"]);
		// ended_at flip is fire-and-forget in the route's finally — poll for it.
		await vi.waitFor(() => {
			expect(auditEnds()).toHaveLength(1);
		});
		expect(auditEnds()[0]?.[1]?.[0]).toBe(inserts[0]?.[1]?.[0]);
	});

	it("owner exec writes no audit row", async () => {
		dbStubs.d1Query.mockClear();
		const { docker } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(22);
			return { exitCode: 0 };
		});
		await spinUp(makeFakeSessions(), docker);

		await readAllEvents(await startExec({ cmd: ["echo"] }));
		expect(auditInserts()).toHaveLength(0);
	});

	it("aborts the exec (500, no process started, slot released) when the audit INSERT fails", async () => {
		dbStubs.d1Query.mockClear();
		dbStubs.d1Query.mockRejectedValueOnce(new Error("d1 down"));
		const { docker } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(23);
			return { exitCode: 0 };
		});
		await spinUp(makeFakeSessions("running", { userId: "owner-9" }), docker);

		const res = await startExec({ cmd: ["echo"] });
		expect(res.status).toBe(500);
		expect(docker.streamExec).not.toHaveBeenCalled();
		// The registered slot was released: 4 more execs fit under the cap.
		for (let i = 0; i < 4; i++) {
			const ok = await startExec({ cmd: ["echo"] });
			expect(ok.status).toBe(200);
			await ok.text();
		}
	});

	it("403s a non-admin non-owner on start, status, and kill", async () => {
		const { docker } = makeFakeDocker(async () => ({ exitCode: 0 }));
		await spinUp(forbidden(), docker);

		expect((await startExec({ cmd: ["x"] })).status).toBe(403);
		expect((await fetch(`${baseUrl}/api/sessions/sess-1/exec/e_deadbeefdeadbeef`)).status).toBe(
			403,
		);
		expect(
			(
				await fetch(`${baseUrl}/api/sessions/sess-1/exec/e_deadbeefdeadbeef/kill`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(403);
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("admin status + kill on a foreign session's exec work as for the owner", async () => {
		let resolveExec: ((v: { exitCode: number }) => void) | undefined;
		const { docker, killSpy } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(24);
			return new Promise((resolve) => {
				resolveExec = resolve;
			});
		});
		killSpy.mockImplementation(async () => {
			resolveExec?.({ exitCode: 137 });
			return "killed";
		});
		await spinUp(makeFakeSessions("running", { userId: "owner-9" }), docker);

		const res = await startExec({ cmd: ["sleep", "999"] });
		const reader = ndjsonReader(res);
		const started = await reader.next();
		const execId = started?.execId as string;

		const status = await (await fetch(`${baseUrl}/api/sessions/sess-1/exec/${execId}`)).json();
		expect(status).toMatchObject({ execId, state: "running", pgid: 24 });

		const kill = await fetch(`${baseUrl}/api/sessions/sess-1/exec/${execId}/kill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(kill.status).toBe(200);
		expect(await kill.json()).toEqual({ outcome: "killed" });
		expect(killSpy).toHaveBeenCalledWith("sess-1", 24, 5000);
		const exit = await reader.next();
		expect(exit).toMatchObject({ type: "exit", reason: "killed" });
	});

	it("audits a cross-user kill with its own operate row, but not a 404'd kill", async () => {
		// The start row alone doesn't attribute the kill: an owner-started
		// exec has no start row at all, and even a cross-user-started one
		// was attributed to the starter, not the killer (#422 review).
		dbStubs.d1Query.mockClear();
		let resolveExec: ((v: { exitCode: number }) => void) | undefined;
		const { docker, killSpy } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(27);
			return new Promise((resolve) => {
				resolveExec = resolve;
			});
		});
		killSpy.mockImplementation(async () => {
			resolveExec?.({ exitCode: 137 });
			return "killed";
		});
		await spinUp(makeFakeSessions("running", { userId: "owner-9" }), docker);

		const res = await startExec({ cmd: ["sleep", "999"] });
		const reader = ndjsonReader(res);
		const started = await reader.next();
		const execId = started?.execId as string;
		expect(auditInserts()).toHaveLength(1); // cross-user start row

		// A kill the registry rejects (404) took no action — no audit row.
		const notFound = await fetch(`${baseUrl}/api/sessions/sess-1/exec/e_0000000000000000/kill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(notFound.status).toBe(404);
		expect(auditInserts()).toHaveLength(1);

		const kill = await fetch(`${baseUrl}/api/sessions/sess-1/exec/${execId}/kill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(kill.status).toBe(200);
		await reader.next(); // drain exit
		// Kill row is fire-and-forget — poll. Both rows end up closed.
		await vi.waitFor(() => {
			expect(auditInserts()).toHaveLength(2);
			expect(auditEnds()).toHaveLength(2);
		});
		expect(auditInserts()[1]?.[1]?.slice(1)).toEqual(["u1", "sess-1", "owner-9", "operate"]);
	});

	it("skips the idle bump for cross-user calls but keeps it for the owner", async () => {
		// No-output execs so the only possible bump is the REST finish-bump.
		const { docker } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(25);
			return { exitCode: 0 };
		});
		const bump = vi.fn();
		const sweeper: RouteIdleSweeper = { bump, forget: vi.fn() };
		await spinUp(makeFakeSessions("running", { userId: "owner-9" }), docker, sweeper);

		await readAllEvents(await startExec({ cmd: ["true"] }));
		const statusRes = await fetch(`${baseUrl}/api/sessions/sess-1/exec/e_0000000000000000`);
		expect(statusRes.status).toBe(200);
		// finish-bumps land on res 'finish' — settle the event loop.
		await new Promise((r) => setImmediate(r));
		expect(bump).not.toHaveBeenCalled();
	});

	it("owner exec still bumps the idle sweeper on finish", async () => {
		const { docker } = makeFakeDocker(async (_sid, opts) => {
			opts.onProcessGroup?.(26);
			return { exitCode: 0 };
		});
		const bump = vi.fn();
		const sweeper: RouteIdleSweeper = { bump, forget: vi.fn() };
		await spinUp(makeFakeSessions(), docker, sweeper);

		await readAllEvents(await startExec({ cmd: ["true"] }));
		await new Promise((r) => setImmediate(r));
		expect(bump).toHaveBeenCalledWith("sess-1");
	});
});
