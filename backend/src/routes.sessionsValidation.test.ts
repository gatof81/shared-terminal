/**
 * routes.sessionsValidation.test.ts — route-level branches of the
 * session-scoped mutation endpoints (#353): DELETE /sessions/:id
 * (soft vs ?hard=true, NotFoundError → 404), PATCH /sessions/:id/env
 * (validateEnvVars 400s), POST /sessions/:id/tabs (validateTabLabel
 * 400s) and DELETE /sessions/:id/tabs/:tabId (missing-tab 404).
 *
 * Module logic (envVarValidation.test.ts, dockerManager.test.ts,
 * sessionManager.test.ts) is covered elsewhere — these pin the ROUTE
 * wrappers: which validator runs, before which side effect, and what
 * status/message the failure surfaces as. The delete tests especially
 * pin the soft/hard split: soft must never purge the workspace (that's
 * the documented respawn path), hard must purge AND drop the row.
 *
 * Scaffolding mirrors routes.start.test.ts: stub `./auth.js` and
 * `./db.js`, exercise the express app over a real ephemeral-port
 * server. validateEnvVars / validateTabLabel run REAL — the routes'
 * choice of validator is part of what's under test.
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
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
// Real error class, NOT a stub: handleSessionError in routes/shared.ts
// matches via `instanceof NotFoundError` against this exact import.
import { NotFoundError } from "./sessionManager.js";
import type { SessionMeta, SessionStatus } from "./types.js";

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running",
		containerId: null,
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
		...overrides,
	};
}

type SessionsStub = {
	sessions: SessionManager;
	spies: {
		assertOwnership: ReturnType<typeof vi.fn>;
		assertOwnedBy: ReturnType<typeof vi.fn>;
		terminate: ReturnType<typeof vi.fn>;
		deleteRow: ReturnType<typeof vi.fn>;
		updateEnvVars: ReturnType<typeof vi.fn>;
	};
};

function makeFakeSessions(status: SessionStatus = "running"): SessionsStub {
	const meta = makeMeta({ status });
	const spies = {
		assertOwnership: vi.fn(async () => meta),
		assertOwnedBy: vi.fn(async () => undefined),
		terminate: vi.fn(async () => undefined),
		deleteRow: vi.fn(async () => undefined),
		updateEnvVars: vi.fn(async () => undefined),
	};
	const sessions = {
		...spies,
		get: vi.fn(async () => meta),
	} as unknown as SessionManager;
	return { sessions, spies };
}

type DockerStub = {
	docker: DockerManager;
	spies: {
		kill: ReturnType<typeof vi.fn>;
		purgeWorkspace: ReturnType<typeof vi.fn>;
		listTabs: ReturnType<typeof vi.fn>;
		createTab: ReturnType<typeof vi.fn>;
		deleteTab: ReturnType<typeof vi.fn>;
	};
};

function makeFakeDocker(): DockerStub {
	const spies = {
		kill: vi.fn(async () => undefined),
		purgeWorkspace: vi.fn(async () => undefined),
		listTabs: vi.fn(async () => [{ tabId: "tab-1", label: "main" }]),
		createTab: vi.fn(async (_sid: string, label?: string) => ({
			tabId: "tab-new",
			label: label ?? "tab-new",
		})),
		deleteTab: vi.fn(async () => undefined),
	};
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		...spies,
	} as unknown as DockerManager;
	return { docker, spies };
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

async function spinUp(sessions: SessionManager, docker: DockerManager) {
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

describe("DELETE /sessions/:id", () => {
	it("soft delete kills + terminates but preserves workspace and row", async () => {
		const { sessions, spies } = makeFakeSessions("running");
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(dockerSpies.kill).toHaveBeenCalledWith("sess-1");
		expect(spies.terminate).toHaveBeenCalledWith("sess-1");
		// The soft-delete contract: workspace + row survive so POST /start
		// can respawn later.
		expect(dockerSpies.purgeWorkspace).not.toHaveBeenCalled();
		expect(spies.deleteRow).not.toHaveBeenCalled();
	});

	it("soft delete is idempotent — already-terminated skips kill/terminate", async () => {
		const { sessions, spies } = makeFakeSessions("terminated");
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(dockerSpies.kill).not.toHaveBeenCalled();
		expect(spies.terminate).not.toHaveBeenCalled();
	});

	it("?hard=true additionally purges the workspace and drops the row", async () => {
		const { sessions, spies } = makeFakeSessions("running");
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1?hard=true`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(dockerSpies.kill).toHaveBeenCalledWith("sess-1");
		expect(spies.terminate).toHaveBeenCalledWith("sess-1");
		expect(dockerSpies.purgeWorkspace).toHaveBeenCalledWith("sess-1");
		expect(spies.deleteRow).toHaveBeenCalledWith("sess-1");
	});

	it("?hard=1 also triggers the hard branch", async () => {
		const { sessions, spies } = makeFakeSessions("terminated");
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1?hard=1`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(dockerSpies.purgeWorkspace).toHaveBeenCalledWith("sess-1");
		expect(spies.deleteRow).toHaveBeenCalledWith("sess-1");
	});

	it("maps NotFoundError from assertOwnership to 404, touching nothing", async () => {
		const { sessions, spies } = makeFakeSessions();
		spies.assertOwnership.mockRejectedValue(new NotFoundError("Session not found"));
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/nope`, { method: "DELETE" });
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Session not found");
		expect(dockerSpies.kill).not.toHaveBeenCalled();
		expect(spies.deleteRow).not.toHaveBeenCalled();
	});
});

describe("PATCH /sessions/:id/env", () => {
	async function patchEnv(body: unknown): Promise<Response> {
		return fetch(`${baseUrl}/api/sessions/sess-1/env`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("400s when envVars is omitted entirely", async () => {
		const { sessions, spies } = makeFakeSessions();
		const { docker } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await patchEnv({});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("body.envVars is required");
		expect(spies.updateEnvVars).not.toHaveBeenCalled();
	});

	it("400s a non-object envVars via the real validateEnvVars", async () => {
		const { sessions, spies } = makeFakeSessions();
		const { docker } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await patchEnv({ envVars: "FOO=bar" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("envVars must be an object");
		expect(spies.updateEnvVars).not.toHaveBeenCalled();
	});

	it("400s a denylisted name (PATH) before any ownership check or write", async () => {
		const { sessions, spies } = makeFakeSessions();
		const { docker } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await patchEnv({ envVars: { PATH: "/evil" } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("PATH");
		// Validation runs before assertOwnedBy — a malformed payload never
		// costs a D1 round-trip.
		expect(spies.assertOwnedBy).not.toHaveBeenCalled();
		expect(spies.updateEnvVars).not.toHaveBeenCalled();
	});

	it("persists a valid payload and returns the updated meta", async () => {
		const { sessions, spies } = makeFakeSessions();
		const { docker } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await patchEnv({ envVars: { FOO: "bar" } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessionId: string };
		expect(body.sessionId).toBe("sess-1");
		expect(spies.updateEnvVars).toHaveBeenCalledWith("sess-1", { FOO: "bar" });
	});
});

describe("POST /sessions/:id/tabs", () => {
	async function postTab(body: unknown): Promise<Response> {
		return fetch(`${baseUrl}/api/sessions/sess-1/tabs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it.each([
		[{ label: 123 }, "label must be a string"],
		[{ label: "" }, "label must not be empty"],
		[{ label: "x".repeat(65) }, "label must be at most 64 characters"],
		[{ label: " padded " }, "label must not have leading or trailing whitespace"],
		[{ label: "tab\tname" }, "label must not contain control characters (tab, newline, etc.)"],
	])("400s an invalid label %j without creating a tab", async (body, expectedError) => {
		const { sessions } = makeFakeSessions();
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postTab(body);
		expect(res.status).toBe(400);
		const resBody = (await res.json()) as { error: string };
		expect(resBody.error).toBe(expectedError);
		expect(dockerSpies.createTab).not.toHaveBeenCalled();
	});

	it("201s a valid label", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postTab({ label: "build" });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { tabId: string; label: string };
		expect(body.label).toBe("build");
		expect(dockerSpies.createTab).toHaveBeenCalledWith("sess-1", "build");
	});

	it("201s an omitted label (falls back to tabId inside createTab)", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postTab({});
		expect(res.status).toBe(201);
		expect(dockerSpies.createTab).toHaveBeenCalledWith("sess-1", undefined);
	});
});

describe("DELETE /sessions/:id/tabs/:tabId", () => {
	it("404s a tabId that listTabs doesn't report, without deleting", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/tabs/tab-missing`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("tab not found");
		expect(dockerSpies.deleteTab).not.toHaveBeenCalled();
	});

	it("204s and deletes a tab listTabs knows about", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/tabs/tab-1`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(dockerSpies.deleteTab).toHaveBeenCalledWith("sess-1", "tab-1");
	});

	it("maps NotFoundError from assertOwnedBy to 404 before listing tabs", async () => {
		const { sessions, spies } = makeFakeSessions();
		spies.assertOwnedBy.mockRejectedValue(new NotFoundError("Session not found"));
		const { docker, spies: dockerSpies } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/nope/tabs/tab-1`, { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(dockerSpies.listTabs).not.toHaveBeenCalled();
		expect(dockerSpies.deleteTab).not.toHaveBeenCalled();
	});
});
