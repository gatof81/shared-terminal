/**
 * routes.groupsMine.test.ts — lead-side GET /groups/mine and
 * GET /groups/mine/sessions route wrappers (#353).
 *
 * groups.test.ts covers the module SQL; these tests pin the ROUTE
 * layer: the serialised wire shape (Dates → ISO strings, containerId
 * sliced to the 12-char short id) and the 500-on-throw contract. The
 * 500 mapping is deliberate product behaviour — the lead UI hides the
 * "My groups" entry-point on an empty list, so a route that degraded a
 * D1 transient to `[]` would make the feature vanish instead of
 * surfacing the failure (see the comment block in routes/groups.ts).
 *
 * Scaffolding mirrors routes.start.test.ts (stub ./auth.js + ./db.js,
 * real ephemeral-port server) plus a hoisted stub for ./groups.js —
 * the module under the routes being tested. The stub also carries
 * `isLeadOfUserViaGroup` because sessionManager.ts imports it by name
 * from the same (now mocked) module.
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

const groupsStubs = vi.hoisted(() => ({
	listGroupsLedBy: vi.fn(),
	sessionsObservableBy: vi.fn(),
	isUserLead: vi.fn(async () => false),
	isLeadOfUserViaGroup: vi.fn(async () => false),
	groupsLedBy: vi.fn(async () => [] as string[]),
	listAll: vi.fn(async () => [] as unknown[]),
	getById: vi.fn(),
	listMembers: vi.fn(async () => [] as unknown[]),
	create: vi.fn(),
	update: vi.fn(),
	deleteGroup: vi.fn(),
	addMember: vi.fn(),
	removeMember: vi.fn(),
	GroupQuotaExceededError: class extends Error {},
	GroupMembersCapExceededError: class extends Error {},
	GroupUserNotFoundError: class extends Error {},
	GroupMemberAlreadyExistsError: class extends Error {},
	GroupCannotRemoveLeadError: class extends Error {},
}));
vi.mock("./groups.js", () => groupsStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";

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

async function spinUp() {
	const sessions = {} as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
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
		exec: { ipMax: 1000, ipWindowMs: 60_000 },
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

beforeEach(() => {
	groupsStubs.listGroupsLedBy.mockReset();
	groupsStubs.sessionsObservableBy.mockReset();
});

describe("GET /groups/mine", () => {
	it("200s the caller's led groups with ISO-serialised dates", async () => {
		await spinUp();
		groupsStubs.listGroupsLedBy.mockResolvedValue([
			{
				id: "g1",
				name: "backend",
				description: "the backend crew",
				leadUserId: "u1",
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-02-01T00:00:00Z"),
				members: [
					{
						userId: "u2",
						username: "bob",
						addedAt: new Date("2026-01-15T12:00:00Z"),
					},
				],
			},
		]);
		const res = await fetch(`${baseUrl}/api/groups/mine`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(body).toEqual([
			{
				id: "g1",
				name: "backend",
				description: "the backend crew",
				leadUserId: "u1",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-02-01T00:00:00.000Z",
				members: [{ userId: "u2", username: "bob", addedAt: "2026-01-15T12:00:00.000Z" }],
			},
		]);
		expect(groupsStubs.listGroupsLedBy).toHaveBeenCalledWith("u1");
	});

	it("500s with a generic body when the groups module throws", async () => {
		await spinUp();
		groupsStubs.listGroupsLedBy.mockRejectedValue(new Error("D1 timeout: internal detail"));
		const res = await fetch(`${baseUrl}/api/groups/mine`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
	});
});

describe("GET /groups/mine/sessions", () => {
	it("200s observable sessions with the short containerId and ISO dates", async () => {
		await spinUp();
		groupsStubs.sessionsObservableBy.mockResolvedValue([
			{
				sessionId: "sess-1",
				ownerUserId: "u2",
				ownerUsername: "bob",
				name: "bob's session",
				status: "running",
				containerId: "0123456789abcdef0123456789abcdef",
				containerName: "st-sess-1",
				cols: 80,
				rows: 24,
				createdAt: new Date("2026-03-01T00:00:00Z"),
				lastConnectedAt: null,
			},
		]);
		const res = await fetch(`${baseUrl}/api/groups/mine/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		// Short-id slice matches serializeMeta so clients don't need a
		// per-endpoint switch.
		expect(body[0]).toEqual({
			sessionId: "sess-1",
			ownerUserId: "u2",
			ownerUsername: "bob",
			name: "bob's session",
			status: "running",
			containerId: "0123456789ab",
			containerName: "st-sess-1",
			cols: 80,
			rows: 24,
			createdAt: "2026-03-01T00:00:00.000Z",
			lastConnectedAt: null,
		});
		expect(groupsStubs.sessionsObservableBy).toHaveBeenCalledWith("u1");
	});

	it("500s with a generic body when the groups module throws", async () => {
		await spinUp();
		groupsStubs.sessionsObservableBy.mockRejectedValue(new Error("boom"));
		const res = await fetch(`${baseUrl}/api/groups/mine/sessions`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
	});
});
