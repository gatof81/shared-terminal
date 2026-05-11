/**
 * routes.admin.groups.test.ts — REST integration for /api/admin/groups (#201a).
 *
 * Pins the wire shape for each endpoint and the admin gate. Uses the
 * same stub style as routes.admin.test.ts — auth middleware mocked,
 * the underlying `groups.ts` mocked at the module boundary so we
 * exercise the route's validation + error mapping logic without
 * driving D1 call sequences.
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
