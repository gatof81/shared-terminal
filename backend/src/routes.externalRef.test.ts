/**
 * routes.externalRef.test.ts — opaque session external_ref (#418).
 *
 * Pins the contract: PATCH /sessions/:id sets/clears the ref at the
 * operate tier, both list endpoints serialize it and filter by exact
 * match in SQL (before the admin LIMIT), and the SessionManager query
 * shapes parameterize the value rather than interpolating it.
 *
 * Mocking shape mirrors `routes.list.test.ts`: stub `./auth.js` so
 * `requireAuth` injects a fixed user id, run the router against an
 * ephemeral express server.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStubs = vi.hoisted(() => ({
	requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "u1";
		next();
	},
	requireAdmin: vi.fn((req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "u1";
		next();
	}),
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
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
	getD1CallsSinceBoot: vi.fn(() => 0),
	__resetD1CallsForTests: vi.fn(),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import type { RouteIdleSweeper } from "./routes/shared.js";
import { buildRouter } from "./routes.js";
import { ForbiddenError, SessionManager } from "./sessionManager.js";
import type { SessionMeta } from "./types.js";

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

function fakeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId: "s1",
		userId: "u1",
		name: "alpha",
		status: "running",
		containerId: "c1",
		containerName: "st-s1",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date("2026-07-17T02:00:00Z"),
		lastConnectedAt: null,
		externalRef: null,
		...overrides,
	};
}

async function spinUp(sessions: SessionManager, idleSweeper?: RouteIdleSweeper) {
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		gatherStats: vi.fn(async () => new Map()),
	} as unknown as DockerManager;
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
	app.use(express.json());
	app.use("/api", router);
	const s = http.createServer(app);
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	const { port } = s.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
}

function patchRef(id: string, body: unknown): Promise<Response> {
	return fetch(`${baseUrl}/api/sessions/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("PATCH /sessions/:id — externalRef (#418)", () => {
	function makePatchFakes(meta: SessionMeta) {
		let stored = meta;
		const updateExternalRef = vi.fn(async (_sid: string, ref: string | null) => {
			stored = { ...stored, externalRef: ref };
		});
		const sessions = {
			assertCanOperate: vi.fn(async () => meta),
			updateExternalRef,
			get: vi.fn(async () => stored),
		} as unknown as SessionManager;
		return { sessions, updateExternalRef };
	}

	it("sets the ref for the owner and returns the updated meta", async () => {
		const { sessions, updateExternalRef } = makePatchFakes(fakeMeta());
		await spinUp(sessions);

		const res = await patchRef("s1", { externalRef: "hub:project:42" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { externalRef: string | null };
		expect(body.externalRef).toBe("hub:project:42");
		expect(updateExternalRef).toHaveBeenCalledWith("s1", "hub:project:42");
	});

	it("clears the ref with null", async () => {
		const { sessions, updateExternalRef } = makePatchFakes(
			fakeMeta({ externalRef: "hub:project:42" }),
		);
		await spinUp(sessions);

		const res = await patchRef("s1", { externalRef: null });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { externalRef: string | null };
		expect(body.externalRef).toBeNull();
		expect(updateExternalRef).toHaveBeenCalledWith("s1", null);
	});

	it("400s a missing field, unknown keys, and invalid values without writing", async () => {
		const { sessions, updateExternalRef } = makePatchFakes(fakeMeta());
		await spinUp(sessions);

		for (const body of [
			{},
			{ externalRef: "x", name: "sneaky-rename" },
			{ externalRef: "" },
			{ externalRef: "x".repeat(129) },
			{ externalRef: 42 },
		]) {
			const res = await patchRef("s1", body);
			expect(res.status).toBe(400);
		}
		expect(updateExternalRef).not.toHaveBeenCalled();
	});

	it("accepts exactly 128 chars (boundary)", async () => {
		const { sessions } = makePatchFakes(fakeMeta());
		await spinUp(sessions);
		const ref = "x".repeat(128);
		const res = await patchRef("s1", { externalRef: ref });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { externalRef: string }).externalRef).toBe(ref);
	});

	it("403s a non-admin non-owner (operate tier)", async () => {
		const sessions = {
			assertCanOperate: vi.fn(async () => {
				throw new ForbiddenError();
			}),
			updateExternalRef: vi.fn(),
		} as unknown as SessionManager;
		await spinUp(sessions);

		const res = await patchRef("s1", { externalRef: "hub:project:42" });
		expect(res.status).toBe(403);
	});

	it("admin PATCH on a foreign session succeeds and skips the idle bump", async () => {
		const { sessions } = makePatchFakes(fakeMeta({ userId: "owner-9" }));
		const bump = vi.fn();
		await spinUp(sessions, { bump, forget: vi.fn() });

		const res = await patchRef("s1", { externalRef: "hub:project:42" });
		expect(res.status).toBe(200);
		await new Promise((r) => setImmediate(r));
		expect(bump).not.toHaveBeenCalled();
	});

	it("owner PATCH still bumps the idle sweeper", async () => {
		const { sessions } = makePatchFakes(fakeMeta());
		const bump = vi.fn();
		await spinUp(sessions, { bump, forget: vi.fn() });

		const res = await patchRef("s1", { externalRef: "hub:project:42" });
		expect(res.status).toBe(200);
		await new Promise((r) => setImmediate(r));
		expect(bump).toHaveBeenCalledWith("s1");
	});
});

describe("GET /sessions — externalRef serialization + filter (#418)", () => {
	it("serializes externalRef on every row (null when unset)", async () => {
		const sessions = {
			listForUser: vi.fn(async () => [
				fakeMeta({ sessionId: "s1", externalRef: "hub:project:42" }),
				fakeMeta({ sessionId: "s2", externalRef: null }),
			]),
			listAllForUser: vi.fn(async () => []),
		} as unknown as SessionManager;
		await spinUp(sessions);

		const body = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{
			sessionId: string;
			externalRef: string | null;
		}>;
		expect(body.find((r) => r.sessionId === "s1")?.externalRef).toBe("hub:project:42");
		expect(body.find((r) => r.sessionId === "s2")?.externalRef).toBeNull();
	});

	it("threads ?externalRef= to the list queries (both all=true and default)", async () => {
		const listForUser = vi.fn(async () => []);
		const listAllForUser = vi.fn(async () => []);
		await spinUp({ listForUser, listAllForUser } as unknown as SessionManager);

		await fetch(`${baseUrl}/api/sessions?externalRef=hub%3Aproject%3A42`);
		expect(listForUser).toHaveBeenCalledWith("u1", "hub:project:42");

		await fetch(`${baseUrl}/api/sessions?all=true&externalRef=hub%3Aproject%3A42`);
		expect(listAllForUser).toHaveBeenCalledWith("u1", "hub:project:42");
	});

	it("400s a repeated externalRef param instead of silently dropping the filter", async () => {
		const listForUser = vi.fn(async () => []);
		await spinUp({
			listForUser,
			listAllForUser: vi.fn(async () => []),
		} as unknown as SessionManager);

		const res = await fetch(`${baseUrl}/api/sessions?externalRef=a&externalRef=b`);
		expect(res.status).toBe(400);
		expect(listForUser).not.toHaveBeenCalled();
	});
});

describe("GET /admin/sessions — externalRef filter (#418)", () => {
	it("threads ?externalRef= to listAll and 400s a repeated param", async () => {
		const listAll = vi.fn(async () => []);
		await spinUp({ listAll } as unknown as SessionManager);

		const ok = await fetch(`${baseUrl}/api/admin/sessions?externalRef=hub%3Aproject%3A42`);
		expect(ok.status).toBe(200);
		expect(listAll).toHaveBeenCalledWith("hub:project:42");

		const bad = await fetch(`${baseUrl}/api/admin/sessions?externalRef=a&externalRef=b`);
		expect(bad.status).toBe(400);
	});
});

describe("SessionManager — externalRef query shapes (#418)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockClear();
	});

	function lastQuery(): [string, unknown[]] {
		const call = dbStubs.d1Query.mock.calls.at(-1) as unknown as [string, unknown[]?];
		return [call[0], call[1] ?? []];
	}

	it("filters listForUser / listAllForUser / listAll via a parameterized WHERE", async () => {
		const mgr = new SessionManager();

		await mgr.listForUser("u1", "ref-1");
		let [sql, params] = lastQuery();
		expect(sql).toContain("AND external_ref = ?");
		expect(params).toEqual(["u1", "ref-1"]);

		await mgr.listAllForUser("u1", "ref-1");
		[sql, params] = lastQuery();
		expect(sql).toContain("AND external_ref = ?");
		expect(params).toEqual(["u1", "ref-1"]);

		// Admin list: the WHERE must precede the LIMIT so a match older
		// than the newest-500 window is still found.
		await mgr.listAll("ref-1");
		[sql, params] = lastQuery();
		expect(sql).toMatch(/WHERE s\.external_ref = \? ORDER BY[\s\S]*LIMIT/);
		expect(params).toEqual(["ref-1"]);

		// Unfiltered calls keep the original shapes (no WHERE on the ref).
		await mgr.listForUser("u1");
		[sql, params] = lastQuery();
		expect(sql).not.toContain("external_ref");
		expect(params).toEqual(["u1"]);
	});

	it("persists externalRef on create and via updateExternalRef", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		const mgr = new SessionManager();
		// create() re-reads the row after insert; feed it a minimal row.
		dbStubs.d1Query.mockImplementation(async (sql: string) => ({
			results: /SELECT \* FROM sessions/.test(sql)
				? [
						{
							session_id: "sid",
							user_id: "u1",
							name: "n",
							status: "running",
							container_id: null,
							container_name: "st-sid",
							cols: 80,
							rows: 24,
							env_vars: "{}",
							created_at: "2026-07-17 02:00:00",
							last_connected_at: null,
							external_ref: "ref-1",
						},
					]
				: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		}));
		const meta = await mgr.create({ userId: "u1", name: "n", externalRef: "ref-1" });
		expect(meta.externalRef).toBe("ref-1");
		const insertCall = dbStubs.d1Query.mock.calls.find(([sql]) =>
			(sql as string).includes("INSERT INTO sessions"),
		) as unknown as [string, unknown[]];
		expect(insertCall[0]).toContain("external_ref");
		expect(insertCall[1]).toContain("ref-1");

		await mgr.updateExternalRef("sid", null);
		const [sql, params] = lastQuery();
		expect(sql).toContain("UPDATE sessions SET external_ref = ?");
		expect(params).toEqual([null, "sid"]);
	});
});
