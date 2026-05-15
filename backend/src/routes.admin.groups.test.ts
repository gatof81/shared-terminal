/**
 * routes.admin.groups.test.ts — REST integration for all group-related
 * REST surfaces: admin CRUD under /api/admin/groups (#201a) and the
 * lead-side reads under /api/groups/mine[/sessions] (#201c).
 *
 * Pins the wire shape for each endpoint and the admin / auth gates.
 * Uses the same stub style as routes.admin.test.ts — auth middleware
 * mocked, the underlying `groups.ts` mocked at the module boundary
 * so we exercise the route's validation + serializer + error mapping
 * without driving D1 call sequences (those live in groups.test.ts).
 *
 * File name kept stable from 201a despite covering 201c's user-side
 * routes too — both surfaces share the module mock and the same
 * spinUp scaffold, and a single test file keeps the groups-related
 * route coverage discoverable in one place.
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
	// Flipped per-test to drive the 403 path. Default passthrough.
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
	InvalidCredentialsError: class extends Error {
		constructor() {
			super("invalid");
		}
	},
	UsernameTakenError: class extends Error {
		constructor() {
			super("taken");
		}
	},
	InviteRequiredError: class extends Error {
		constructor() {
			super("invite required");
		}
	},
	InviteQuotaExceededError: class extends Error {
		constructor() {
			super("invite quota");
		}
	},
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

// Mock the groups module wholesale so route tests don't drive the
// underlying D1 call sequences (those live in groups.test.ts).
const groupsStubs = vi.hoisted(() => {
	class GroupQuotaExceededError extends Error {
		constructor() {
			super("Group count exceeds deployment cap of 1000");
			this.name = "GroupQuotaExceededError";
		}
	}
	class GroupMembersCapExceededError extends Error {
		constructor() {
			super("Group already at member cap of 500");
			this.name = "GroupMembersCapExceededError";
		}
	}
	class GroupUserNotFoundError extends Error {
		constructor(userId: string) {
			super(`User ${userId} not found`);
			this.name = "GroupUserNotFoundError";
		}
	}
	class GroupMemberAlreadyExistsError extends Error {
		constructor(userId: string) {
			super(`User ${userId} is already a member of this group`);
			this.name = "GroupMemberAlreadyExistsError";
		}
	}
	class GroupCannotRemoveLeadError extends Error {
		constructor() {
			super("Cannot remove the lead from group members; reassign the lead first");
			this.name = "GroupCannotRemoveLeadError";
		}
	}
	return {
		listAll: vi.fn(async () => [] as unknown[]),
		getById: vi.fn(async () => ({
			id: "g-1",
			name: "Frontend",
			description: null,
			leadUserId: "u-lead",
			createdAt: new Date("2026-05-11T12:00:00Z"),
			updatedAt: new Date("2026-05-11T12:00:00Z"),
		})),
		listMembers: vi.fn(async () => [] as unknown[]),
		create: vi.fn(async () => ({
			id: "g-new",
			name: "Frontend",
			description: null,
			leadUserId: "u-lead",
			createdAt: new Date("2026-05-11T12:00:00Z"),
			updatedAt: new Date("2026-05-11T12:00:00Z"),
		})),
		update: vi.fn(async () => ({
			id: "g-1",
			name: "Renamed",
			description: null,
			leadUserId: "u-lead",
			createdAt: new Date("2026-05-11T12:00:00Z"),
			updatedAt: new Date("2026-05-11T13:00:00Z"),
		})),
		deleteGroup: vi.fn(async () => undefined),
		addMember: vi.fn(async () => undefined),
		removeMember: vi.fn(async () => undefined),
		groupsLedBy: vi.fn(async () => [] as string[]),
		listGroupsLedBy: vi.fn(async () => [] as unknown[]),
		sessionsObservableBy: vi.fn(async () => [] as unknown[]),
		GroupQuotaExceededError,
		GroupMembersCapExceededError,
		GroupUserNotFoundError,
		GroupMemberAlreadyExistsError,
		GroupCannotRemoveLeadError,
		MAX_GROUPS_TOTAL: 1000,
		MAX_MEMBERS_PER_GROUP: 500,
	};
});
vi.mock("./groups.js", () => groupsStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { __resetDispatcherStatsForTests } from "./portDispatcher.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
// The route's `handleGroupError` checks `err instanceof NotFoundError`
// against the class imported from `sessionManager.js`. Use the real
// one in throws below so the instanceof gate matches — a parallel
// mocked class would be a different identity and fall through to 500.
import { NotFoundError as SessionNotFoundError } from "./sessionManager.js";

let server: http.Server | null = null;
let baseUrl = "";

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((e) => (e ? reject(e) : resolve()));
		});
		server = null;
	}
	authStubs.requireAdmin.mockReset();
	authStubs.requireAdmin.mockImplementation((req, _res, next) => {
		(req as { userId?: string }).userId = "u1";
		next();
	});
});

async function spinUp(): Promise<void> {
	const sessions = {
		// `countByStatus` is wired for the /admin/stats handler even
		// though we don't exercise it here — the router wiring calls
		// `getStats?.()` on it during construction. Returning a frozen
		// shape avoids any incidental D1 fanout.
		countByStatus: vi.fn(async () => ({ running: 0, stopped: 0, terminated: 0, failed: 0 })),
		// Defensive: a hit on any other SessionManager method surfaces
		// as a 500 with a clear "is not a function" message — better
		// than a silent test pass.
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		getReconcileStats: () => ({
			lastRunAt: null,
			sessionsCheckedSinceBoot: 0,
			errorsSinceBoot: 0,
		}),
	} as unknown as DockerManager;
	const broadcaster = {} as BootstrapBroadcaster;
	const router = buildRouter(sessions, docker, broadcaster, {
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
	});
	const app = express();
	app.use(express.json());
	app.use("/api", router);
	const s = http.createServer(app);
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	const { port } = s.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
}

describe("GET /api/admin/groups", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.listAll.mockReset();
	});

	it("returns the serialised summary list", async () => {
		groupsStubs.listAll.mockImplementationOnce(async () => [
			{
				id: "g-1",
				name: "Frontend",
				description: "FE team",
				leadUserId: "u-lead",
				createdAt: new Date("2026-05-11T12:00:00Z"),
				updatedAt: new Date("2026-05-11T12:00:00Z"),
				leadUsername: "alice",
				memberCount: 8,
			},
		]);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			id: string;
			leadUsername: string;
			memberCount: number;
			createdAt: string;
		}>;
		expect(body).toHaveLength(1);
		expect(body[0]?.leadUsername).toBe("alice");
		expect(body[0]?.memberCount).toBe(8);
		// Dates round-trip as ISO strings.
		expect(body[0]?.createdAt).toBe("2026-05-11T12:00:00.000Z");
	});

	it("returns 403 when requireAdmin denies the caller", async () => {
		authStubs.requireAdmin.mockImplementationOnce(
			(_req: unknown, res: { status: (code: number) => { json: (b: unknown) => void } }) => {
				res.status(403).json({ error: "Admin privileges required" });
			},
		);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups`);
		expect(res.status).toBe(403);
	});
});

describe("POST /api/admin/groups", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.create.mockReset();
		groupsStubs.create.mockImplementation(async () => ({
			id: "g-new",
			name: "Frontend",
			description: null,
			leadUserId: "u-lead",
			createdAt: new Date("2026-05-11T12:00:00Z"),
			updatedAt: new Date("2026-05-11T12:00:00Z"),
		}));
	});

	async function post(body: unknown): Promise<Response> {
		return fetch(`${baseUrl}/api/admin/groups`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("rejects a missing body.name with 400", async () => {
		await spinUp();
		const res = await post({ leadUserId: "u-lead" });
		expect(res.status).toBe(400);
		expect(groupsStubs.create).not.toHaveBeenCalled();
	});

	it("rejects a missing body.leadUserId with 400", async () => {
		await spinUp();
		const res = await post({ name: "X" });
		expect(res.status).toBe(400);
	});

	it("rejects a too-long name with 400", async () => {
		await spinUp();
		const res = await post({ name: "x".repeat(101), leadUserId: "u-lead" });
		expect(res.status).toBe(400);
	});

	it("rejects a whitespace-only leadUserId with 400 (not a confusing 404)", async () => {
		// Pins #262 round-5 SHOULD-FIX: a whitespace-only leadUserId
		// pre-fix passed the length-zero gate (length 3), got trimmed
		// to "", then assertUserExists("") returned a misleading
		// `404 User  not found` (double-space message). The trim-first
		// shape catches this at the boundary as a 400.
		await spinUp();
		const res = await post({ name: "X", leadUserId: "   " });
		expect(res.status).toBe(400);
		expect(groupsStubs.create).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only name with 400", async () => {
		await spinUp();
		const res = await post({ name: "   ", leadUserId: "u-lead" });
		expect(res.status).toBe(400);
		expect(groupsStubs.create).not.toHaveBeenCalled();
	});

	it("accepts a name padded with whitespace and stores it trimmed", async () => {
		// Pre-trim length caps would have rejected "a" + " ".repeat(100)
		// as too long (101 chars) even though only 1 char persists.
		// Trim-first cap matches the template route convention.
		await spinUp();
		const padded = `${"x".repeat(50)}${" ".repeat(50)}`; // 100 raw, 50 trimmed
		const res = await post({ name: padded, leadUserId: "u-lead" });
		expect(res.status).toBe(201);
		expect(groupsStubs.create).toHaveBeenCalledWith(
			expect.objectContaining({ name: "x".repeat(50) }),
		);
	});

	it("creates and returns 201 with the serialised group", async () => {
		await spinUp();
		const res = await post({ name: "Frontend", leadUserId: "u-lead" });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; leadUserId: string };
		expect(body.id).toBe("g-new");
		expect(body.leadUserId).toBe("u-lead");
	});

	it("maps GroupUserNotFoundError to 404", async () => {
		groupsStubs.create.mockImplementationOnce(async () => {
			throw new groupsStubs.GroupUserNotFoundError("u-missing");
		});
		await spinUp();
		const res = await post({ name: "X", leadUserId: "u-missing" });
		expect(res.status).toBe(404);
	});

	it("maps GroupQuotaExceededError to 429", async () => {
		groupsStubs.create.mockImplementationOnce(async () => {
			throw new groupsStubs.GroupQuotaExceededError();
		});
		await spinUp();
		const res = await post({ name: "X", leadUserId: "u-lead" });
		expect(res.status).toBe(429);
	});
});

describe("GET /api/admin/groups/:id", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.getById.mockReset();
		groupsStubs.listMembers.mockReset();
	});

	it("returns the group + members joined with usernames", async () => {
		groupsStubs.getById.mockImplementationOnce(async () => ({
			id: "g-1",
			name: "Frontend",
			description: null,
			leadUserId: "u-lead",
			createdAt: new Date("2026-05-11T12:00:00Z"),
			updatedAt: new Date("2026-05-11T12:00:00Z"),
		}));
		groupsStubs.listMembers.mockImplementationOnce(async () => [
			{ userId: "u-lead", username: "alice", addedAt: new Date("2026-05-11T12:00:00Z") },
			{ userId: "u-2", username: "bob", addedAt: new Date("2026-05-11T12:00:01Z") },
		]);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups/g-1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: string;
			members: Array<{ userId: string; username: string }>;
		};
		expect(body.id).toBe("g-1");
		expect(body.members).toHaveLength(2);
		expect(body.members[0]?.username).toBe("alice");
	});

	it("maps NotFoundError to 404", async () => {
		groupsStubs.getById.mockImplementationOnce(async () => {
			throw new SessionNotFoundError("Group not found");
		});
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups/g-nope`);
		expect(res.status).toBe(404);
	});
});

describe("PUT /api/admin/groups/:id", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.update.mockReset();
		groupsStubs.update.mockImplementation(async () => ({
			id: "g-1",
			name: "Renamed",
			description: null,
			leadUserId: "u-lead",
			createdAt: new Date("2026-05-11T12:00:00Z"),
			updatedAt: new Date("2026-05-11T13:00:00Z"),
		}));
	});

	async function put(id: string, body: unknown): Promise<Response> {
		return fetch(`${baseUrl}/api/admin/groups/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("returns the renamed group on success", async () => {
		await spinUp();
		const res = await put("g-1", { name: "Renamed", leadUserId: "u-lead" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string };
		expect(body.name).toBe("Renamed");
	});

	it("maps NotFoundError to 404", async () => {
		groupsStubs.update.mockImplementationOnce(async () => {
			throw new SessionNotFoundError("Group not found");
		});
		await spinUp();
		const res = await put("g-nope", { name: "X", leadUserId: "u-lead" });
		expect(res.status).toBe(404);
	});
});

describe("DELETE /api/admin/groups/:id", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.deleteGroup.mockReset();
	});

	it("returns 204 on success", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups/g-1`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(groupsStubs.deleteGroup).toHaveBeenCalledWith("g-1");
	});

	it("maps NotFoundError to 404", async () => {
		groupsStubs.deleteGroup.mockImplementationOnce(async () => {
			throw new SessionNotFoundError("Group not found");
		});
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups/g-nope`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});
});

describe("POST /api/admin/groups/:id/members", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.addMember.mockReset();
	});

	async function post(id: string, body: unknown): Promise<Response> {
		return fetch(`${baseUrl}/api/admin/groups/${id}/members`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("returns 204 on success", async () => {
		await spinUp();
		const res = await post("g-1", { userId: "u-new" });
		expect(res.status).toBe(204);
		expect(groupsStubs.addMember).toHaveBeenCalledWith("g-1", "u-new");
	});

	it("rejects a missing body.userId with 400", async () => {
		await spinUp();
		const res = await post("g-1", {});
		expect(res.status).toBe(400);
		expect(groupsStubs.addMember).not.toHaveBeenCalled();
	});

	it("maps GroupMemberAlreadyExistsError to 409", async () => {
		groupsStubs.addMember.mockImplementationOnce(async () => {
			throw new groupsStubs.GroupMemberAlreadyExistsError("u-dup");
		});
		await spinUp();
		const res = await post("g-1", { userId: "u-dup" });
		expect(res.status).toBe(409);
	});

	it("maps GroupMembersCapExceededError to 429", async () => {
		groupsStubs.addMember.mockImplementationOnce(async () => {
			throw new groupsStubs.GroupMembersCapExceededError();
		});
		await spinUp();
		const res = await post("g-1", { userId: "u-new" });
		expect(res.status).toBe(429);
	});

	it("maps GroupUserNotFoundError to 404", async () => {
		groupsStubs.addMember.mockImplementationOnce(async () => {
			throw new groupsStubs.GroupUserNotFoundError("u-missing");
		});
		await spinUp();
		const res = await post("g-1", { userId: "u-missing" });
		expect(res.status).toBe(404);
	});
});

describe("DELETE /api/admin/groups/:id/members/:userId", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.removeMember.mockReset();
	});

	it("returns 204 on success", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups/g-1/members/u-2`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(groupsStubs.removeMember).toHaveBeenCalledWith("g-1", "u-2");
	});

	it("maps GroupCannotRemoveLeadError to 409", async () => {
		groupsStubs.removeMember.mockImplementationOnce(async () => {
			throw new groupsStubs.GroupCannotRemoveLeadError();
		});
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups/g-1/members/u-lead`, {
			method: "DELETE",
		});
		expect(res.status).toBe(409);
	});

	it("maps NotFoundError to 404", async () => {
		groupsStubs.removeMember.mockImplementationOnce(async () => {
			throw new SessionNotFoundError("Group not found");
		});
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/groups/g-nope/members/u-2`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
	});
});

// ── Lead-side /api/groups/mine[/sessions] (#201c) ─────────────────────────────
// `requireAuth`-gated only — no admin requirement. A non-lead caller still
// reaches the handler and gets `[]` back (the SQL is user-scoped). The
// admin-stub `requireAdmin` is irrelevant here; we keep it on the default
// passthrough.

describe("GET /api/groups/mine", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.listGroupsLedBy.mockReset();
		groupsStubs.listGroupsLedBy.mockImplementation(async () => []);
	});

	it("returns an empty array when the user leads no groups", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/groups/mine`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(body).toEqual([]);
		// Critical: the handler runs through to listGroupsLedBy even for
		// a non-lead caller. The SQL itself is the user-scoping; auth-
		// only middleware is the gate (no admin check).
		expect(groupsStubs.listGroupsLedBy).toHaveBeenCalledWith("u1");
	});

	it("serialises each group with its inlined members (userId/username/addedAt as ISO)", async () => {
		groupsStubs.listGroupsLedBy.mockImplementationOnce(async () => [
			{
				id: "g-1",
				name: "Frontend",
				description: "FE team",
				leadUserId: "u1",
				createdAt: new Date("2026-05-11T12:00:00Z"),
				updatedAt: new Date("2026-05-11T12:00:00Z"),
				members: [
					{ userId: "u1", username: "alice", addedAt: new Date("2026-05-11T12:00:00Z") },
					{ userId: "u-2", username: "bob", addedAt: new Date("2026-05-11T12:00:01Z") },
				],
			},
		]);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/groups/mine`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			id: string;
			leadUserId: string;
			members: Array<{ userId: string; username: string; addedAt: string }>;
		}>;
		expect(body).toHaveLength(1);
		expect(body[0]?.id).toBe("g-1");
		expect(body[0]?.leadUserId).toBe("u1");
		expect(body[0]?.members).toHaveLength(2);
		expect(body[0]?.members[1]?.username).toBe("bob");
		// Date round-trips as ISO so the frontend can `new Date(s)` it.
		expect(body[0]?.members[0]?.addedAt).toBe("2026-05-11T12:00:00.000Z");
	});

	it("returns 500 if the underlying helper throws (no silent empty-list degrade)", async () => {
		// The lead's UI hides the entry-point when /mine returns 0 rows,
		// so a transient D1 failure that fell back to `[]` would make
		// the entry-point disappear instead of surfacing the failure.
		// Pin the 500 shape so this never regresses.
		groupsStubs.listGroupsLedBy.mockImplementationOnce(async () => {
			throw new Error("D1 transient");
		});
		await spinUp();
		const res = await fetch(`${baseUrl}/api/groups/mine`);
		expect(res.status).toBe(500);
	});
});

describe("GET /api/groups/mine/sessions", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		groupsStubs.sessionsObservableBy.mockReset();
		groupsStubs.sessionsObservableBy.mockImplementation(async () => []);
	});

	it("returns an empty array when the user has no observable sessions", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/groups/mine/sessions`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
		expect(groupsStubs.sessionsObservableBy).toHaveBeenCalledWith("u1");
	});

	it("serialises sessions with short containerId, ISO dates, and no envVars", async () => {
		groupsStubs.sessionsObservableBy.mockImplementationOnce(async () => [
			{
				sessionId: "s-1",
				ownerUserId: "u-2",
				ownerUsername: "bob",
				name: "build-1",
				status: "running",
				// Full Docker id — the serializer must slice to 12 to match
				// the shape `serializeMeta` uses for user / admin views.
				containerId: "ct-1234567890abcdefghijk",
				containerName: "st-abc",
				cols: 120,
				rows: 36,
				createdAt: new Date("2026-05-12T10:00:00Z"),
				lastConnectedAt: new Date("2026-05-12T10:05:00Z"),
			},
		]);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/groups/mine/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		expect(body[0]?.sessionId).toBe("s-1");
		expect(body[0]?.ownerUserId).toBe("u-2");
		expect(body[0]?.ownerUsername).toBe("bob");
		expect(body[0]?.containerId).toBe("ct-123456789"); // 12-char slice
		expect(body[0]?.createdAt).toBe("2026-05-12T10:00:00.000Z");
		expect(body[0]?.lastConnectedAt).toBe("2026-05-12T10:05:00.000Z");
		// envVars are deliberately omitted from the lead view — the
		// per-session GET (with `redactStoredEntries`, per #201 lock-in)
		// is a future PR.
		expect(body[0]).not.toHaveProperty("envVars");
	});

	it("emits null for a missing containerId / lastConnectedAt without crashing the slice", async () => {
		groupsStubs.sessionsObservableBy.mockImplementationOnce(async () => [
			{
				sessionId: "s-2",
				ownerUserId: "u-2",
				ownerUsername: "bob",
				name: "fresh",
				status: "stopped",
				containerId: null,
				containerName: "st-def",
				cols: 80,
				rows: 24,
				createdAt: new Date("2026-05-12T11:00:00Z"),
				lastConnectedAt: null,
			},
		]);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/groups/mine/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body[0]?.containerId).toBeNull();
		expect(body[0]?.lastConnectedAt).toBeNull();
	});

	it("returns 500 if the underlying helper throws", async () => {
		groupsStubs.sessionsObservableBy.mockImplementationOnce(async () => {
			throw new Error("D1 transient");
		});
		await spinUp();
		const res = await fetch(`${baseUrl}/api/groups/mine/sessions`);
		expect(res.status).toBe(500);
	});
});
