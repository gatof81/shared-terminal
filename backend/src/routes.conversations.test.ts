/**
 * routes.conversations.test.ts — `GET /api/sessions/:id/conversations`
 * (docs/CONVERSATION.md §6): owner-only with the foreign→404 collapse,
 * the response shape, `canSendInput: false`, and the honest empty shape
 * when the subsystem is not wired.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStubs = vi.hoisted(() => ({
	// `x-test-user` lets a test act as another caller (an admin, a group lead); default the owner u1.
	requireAuth: (
		req: { userId?: string; isAdmin?: boolean; headers: Record<string, string | undefined> },
		_res: unknown,
		next: () => void,
	) => {
		req.userId = req.headers["x-test-user"] ?? "u1";
		req.isAdmin = req.headers["x-test-admin"] === "1";
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
	d1Query: vi.fn(async () => ({ results: [] as unknown[], success: true as const, meta: {} })),
	getD1CallsSinceBoot: vi.fn(() => 0),
	__resetD1CallsForTests: vi.fn(),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { ConversationService } from "./conversation/service.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import { ForbiddenError, NotFoundError, type SessionManager } from "./sessionManager.js";

let server: http.Server;
let base: string;

function start(conversation?: ConversationService, composer?: unknown) {
	const sessions = {
		assertOwnedBy: vi.fn(async (id: string, userId: string) => {
			if (id === "missing") throw new NotFoundError();
			if (id === "foreign" || userId !== "u1") throw new ForbiddenError();
		}),
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		getReconcileStats: () => ({ lastRunAt: null, sessionsCheckedSinceBoot: 0, errorsSinceBoot: 0 }),
	} as unknown as DockerManager;
	const app = express();
	app.use(express.json());
	app.use(
		"/api",
		buildRouter(
			sessions,
			docker,
			{} as BootstrapBroadcaster,
			undefined,
			undefined,
			conversation,
			composer ? { composer: composer as never } : {},
		),
	);
	server = http.createServer(app);
	return new Promise<void>((r) =>
		server.listen(0, () => {
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			r();
		}),
	);
}

beforeEach(() => {
	dbStubs.d1Query.mockClear();
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

describe("GET /api/sessions/:id/conversations", () => {
	it("returns the service's list for the owner, with no-store caching", async () => {
		const list = vi.fn(async () => ({
			capture: { requested: true, effective: true, effectiveAfterRestart: false },
			conversations: [
				{ sessionId: "c1", kind: "interactive", status: "waiting_input", canSendInput: false },
			],
		}));
		await start({ list } as unknown as ConversationService);
		const res = await fetch(`${base}/api/sessions/s1/conversations`);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.json();
		expect(body.capture.effective).toBe(true);
		expect(body.conversations[0]).toMatchObject({ sessionId: "c1", canSendInput: false });
		expect(list).toHaveBeenCalledWith("s1");
	});
	it("?capture=0 answers the summaries alone, without the capture check (no relay probe)", async () => {
		const list = vi.fn();
		const summariesWithMeta = vi.fn(async () => ({
			conversations: [
				{ sessionId: "c1", kind: "interactive", status: "running", canSendInput: false },
			],
			meta: "unavailable",
		}));
		await start({ list, summariesWithMeta } as unknown as ConversationService);
		const res = await fetch(`${base}/api/sessions/s1/conversations?capture=0`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.capture).toBeNull();
		expect(body.conversations).toHaveLength(1);
		// v1.8 §6.2: the UI must be able to say the names could not be loaded.
		expect(body.meta).toBe("unavailable");
		expect(summariesWithMeta).toHaveBeenCalledWith("s1");
		expect(list).not.toHaveBeenCalled();
		// A foreign session is still a 404 on this path.
		expect((await fetch(`${base}/api/sessions/foreign/conversations?capture=0`)).status).toBe(404);
	});
	it("a foreign session answers 404 exactly like a missing one", async () => {
		const list = vi.fn();
		await start({ list } as unknown as ConversationService);
		const foreign = await fetch(`${base}/api/sessions/foreign/conversations`);
		const missing = await fetch(`${base}/api/sessions/missing/conversations`);
		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		expect(await foreign.json()).toEqual(await missing.json());
		expect(list).not.toHaveBeenCalled();
	});
	it("without the subsystem wired, answers an honest empty capture shape", async () => {
		await start(undefined);
		const res = await fetch(`${base}/api/sessions/s1/conversations`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			capture: {
				requested: false,
				effective: false,
				effectiveAfterRestart: false,
				requiresRecreate: false,
				pendingReasons: ["flag-off"],
				checkedAt: null,
			},
			conversations: [],
			meta: "ok",
		});
	});
});

// ── v1.8 §6.2 rename / archive ─────────────────────────────────────────────

describe("PATCH /api/sessions/:id/conversations/:cid", () => {
	const summary = (patch: Record<string, unknown> = {}) => ({
		sessionId: "c1",
		kind: "interactive",
		title: "auto",
		customTitle: null,
		archivedAt: null,
		status: "ended",
		canSendInput: false,
		...patch,
	});
	const patchReq = (
		sid: string,
		cid: string,
		body: unknown,
		type = "application/json",
		as: Record<string, string> = {},
	) =>
		fetch(`${base}/api/sessions/${sid}/conversations/${cid}`, {
			method: "PATCH",
			headers: { "Content-Type": type, ...as },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	const svc = (impl?: (sid: string, cid: string, p: unknown) => unknown) => {
		const setOwnerMeta = vi.fn(
			impl ??
				(async (_sid: string, cid: string, p: { title?: string | null; archived?: boolean }) =>
					cid === "c1"
						? summary({
								customTitle: p.title ?? null,
								archivedAt: p.archived ? "2026-11-03T10:00:00.000Z" : null,
							})
						: null),
		);
		return { setOwnerMeta, service: { setOwnerMeta } as unknown as ConversationService };
	};

	it("renames for the owner and answers the summary, with only the given field passed down", async () => {
		const { setOwnerMeta, service } = svc();
		await start(service);
		const res = await patchReq("s1", "c1", { title: "  Mi   plan " });
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toMatchObject({
			sessionId: "c1",
			title: "auto",
			customTitle: "Mi plan",
		});
		expect(setOwnerMeta).toHaveBeenCalledWith("s1", "c1", { title: "Mi plan" });
	});
	it("archive alone does not touch the title; an empty title means clear", async () => {
		const { setOwnerMeta, service } = svc();
		await start(service);
		expect((await patchReq("s1", "c1", { archived: true })).status).toBe(200);
		expect(setOwnerMeta).toHaveBeenLastCalledWith("s1", "c1", { archived: true });
		expect((await patchReq("s1", "c1", { title: "   " })).status).toBe(200);
		expect(setOwnerMeta).toHaveBeenLastCalledWith("s1", "c1", { title: null });
	});
	it("foreign and missing sessions answer the same 404 and never reach the service", async () => {
		const { setOwnerMeta, service } = svc();
		await start(service);
		const foreign = await patchReq("foreign", "c1", { title: "x" });
		const missing = await patchReq("missing", "c1", { title: "x" });
		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		expect(await foreign.json()).toEqual(await missing.json());
		expect(setOwnerMeta).not.toHaveBeenCalled();
	});
	it("an admin or a group lead of the owner is NOT the owner: 404, the service is never reached (§10 3.1b)", async () => {
		const { setOwnerMeta, service } = svc();
		await start(service);
		const admin = await patchReq("s1", "c1", { title: "x" }, "application/json", {
			"x-test-user": "admin1",
			"x-test-admin": "1",
		});
		const lead = await patchReq("s1", "c1", { archived: true }, "application/json", {
			"x-test-user": "lead1",
		});
		expect(admin.status).toBe(404);
		expect(lead.status).toBe(404);
		expect(setOwnerMeta).not.toHaveBeenCalled();
	});
	it("an unknown conversation is 404 conversation-not-found", async () => {
		await start(svc().service);
		const res = await patchReq("s1", "nope", { title: "x" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "conversation-not-found" });
	});
	it.each([
		["no keys", {}],
		["an unknown key", { title: "x", pinned: true }],
		["archived not boolean", { archived: "yes" }],
		["an array body", [1]],
	])("400 invalid-body for %s", async (_n, body) => {
		const { setOwnerMeta, service } = svc();
		await start(service);
		const res = await patchReq("s1", "c1", body);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid-body" });
		expect(setOwnerMeta).not.toHaveBeenCalled();
	});
	it("a JSON `null` body is a 400 from express.json's strict mode, before the handler", async () => {
		const { setOwnerMeta, service } = svc();
		await start(service);
		expect((await patchReq("s1", "c1", "null")).status).toBe(400);
		expect(setOwnerMeta).not.toHaveBeenCalled();
	});
	it("400 invalid-body without a JSON content type (CSRF shape)", async () => {
		const { setOwnerMeta, service } = svc();
		await start(service);
		const res = await patchReq("s1", "c1", JSON.stringify({ title: "x" }), "text/plain");
		expect(res.status).toBe(400);
		expect(setOwnerMeta).not.toHaveBeenCalled();
	});
	it("title rules: invalid-title and title-too-long, never truncated", async () => {
		const { setOwnerMeta, service } = svc();
		await start(service);
		const bad = await patchReq("s1", "c1", { title: "a\u202Eb" });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "invalid-title" });
		const long = await patchReq("s1", "c1", { title: "x".repeat(81) });
		expect(long.status).toBe(400);
		expect(await long.json()).toEqual({ error: "title-too-long" });
		expect((await patchReq("s1", "c1", { title: 5 })).status).toBe(400);
		expect(setOwnerMeta).not.toHaveBeenCalled();
	});
	it("a D1 failure is 503 meta-unavailable", async () => {
		await start(
			svc(async () => {
				throw new Error("D1 down");
			}).service,
		);
		const res = await patchReq("s1", "c1", { archived: true });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "meta-unavailable" });
	});
	it("without the subsystem wired the route is a 404", async () => {
		await start(undefined);
		expect((await patchReq("s1", "c1", { title: "x" })).status).toBe(404);
	});
	it("archiving never changes composer eligibility: the composer sees cid/kind/pane only, same answer", async () => {
		const availability = vi.fn(
			async (_sid: string, items: Array<{ cid: string; kind: string; paneId: string | null }>) =>
				new Map(items.map((i) => [i.cid, { canSendInput: true, composer: { blocked: false } }])),
		);
		const composer = {
			availability,
			noteCapture: vi.fn(),
			lastCaptureEffective: vi.fn(() => true),
		};
		const summariesWithMeta = vi.fn(async () => ({
			conversations: [
				summary({ sessionId: "c1", paneId: "%0", archivedAt: "2026-11-03T10:00:00.000Z" }),
				summary({ sessionId: "c2", paneId: "%1", archivedAt: null }),
			],
			meta: "ok",
		}));
		await start({ summariesWithMeta } as unknown as ConversationService, composer);
		const body = await (await fetch(`${base}/api/sessions/s1/conversations?capture=0`)).json();
		expect(availability.mock.calls[0][1]).toEqual([
			{ cid: "c1", kind: "interactive", paneId: "%0" },
			{ cid: "c2", kind: "interactive", paneId: "%1" },
		]);
		expect(body.conversations.map((c: { canSendInput: boolean }) => c.canSendInput)).toEqual([
			true,
			true,
		]);
		expect(body.conversations[0].archivedAt).not.toBeNull();
	});
});

// ── 3.1 reads ───────────────────────────────────────────────────────────────

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("3.1 conversation reads", () => {
	let dir: string;
	let eventsFile: string;
	const index = {
		firstRetainedSeq: 1,
		agents: {
			a2: {
				agentType: "Plan",
				status: "done",
				startedSeq: 7,
				endedSeq: 9,
				toolCount: 0,
				hasResult: true,
			},
			a1: {
				agentType: "Explore",
				status: "running",
				startedSeq: 3,
				toolCount: 2,
				hasResult: false,
			},
		},
	};
	const service = (known = "c1") =>
		({
			conversationFile: vi.fn(async (_sid: string, cid: string) =>
				cid === known ? { index, eventsFile } : null,
			),
		}) as unknown as ConversationService;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "conv-routes-"));
		eventsFile = path.join(dir, "c1.events.jsonl");
		const lines = Array.from({ length: 12 }, (_, i) =>
			JSON.stringify({
				seq: i + 1,
				ts: "t",
				ev: "user_prompt",
				prompt_id: null,
				turn_id: null,
				agent_id: null,
				pane: null,
				data: { prompt: `p${i + 1}` },
			}),
		);
		await fsp.writeFile(eventsFile, `${lines.join("\n")}\n`);
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("GET …/events pages backwards with before/limit, firstRetainedSeq and no-store", async () => {
		await start(service());
		const r1 = await fetch(`${base}/api/sessions/s1/conversations/c1/events?limit=5`);
		expect(r1.status).toBe(200);
		expect(r1.headers.get("cache-control")).toBe("no-store");
		const b1 = await r1.json();
		expect(b1.events.map((e: { seq: number }) => e.seq)).toEqual([8, 9, 10, 11, 12]);
		expect(b1).toMatchObject({ hasMore: true, firstRetainedSeq: 1 });
		const b2 = await (
			await fetch(`${base}/api/sessions/s1/conversations/c1/events?before=3`)
		).json();
		expect(b2.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
		expect(b2.hasMore).toBe(false);
	});

	it("limit is capped at 500 and malformed before/limit answer 400", async () => {
		await start(service());
		expect(
			(await fetch(`${base}/api/sessions/s1/conversations/c1/events?limit=100000`)).status,
		).toBe(200);
		for (const q of ["limit=0", "limit=-1", "limit=abc", "before=1.5", "before=-3"]) {
			expect((await fetch(`${base}/api/sessions/s1/conversations/c1/events?${q}`)).status).toBe(
				400,
			);
		}
	});

	it("GET …/events/:seq returns one event, 404 when absent, 400 when malformed", async () => {
		await start(service());
		const r = await fetch(`${base}/api/sessions/s1/conversations/c1/events/4`);
		expect(r.status).toBe(200);
		expect((await r.json()).data).toEqual({ prompt: "p4" });
		expect((await fetch(`${base}/api/sessions/s1/conversations/c1/events/99`)).status).toBe(404);
		expect((await fetch(`${base}/api/sessions/s1/conversations/c1/events/x`)).status).toBe(400);
	});

	it("GET …/agents lists the index's agents in start order", async () => {
		await start(service());
		const body = await (await fetch(`${base}/api/sessions/s1/conversations/c1/agents`)).json();
		expect(body.agents).toEqual([
			{
				agentId: "a1",
				agentType: "Explore",
				status: "running",
				startedSeq: 3,
				toolCount: 2,
				hasResult: false,
			},
			{
				agentId: "a2",
				agentType: "Plan",
				status: "done",
				startedSeq: 7,
				endedSeq: 9,
				toolCount: 0,
				hasResult: true,
			},
		]);
	});

	it("foreign session, missing session and unknown conversation all answer the same 404", async () => {
		const svc = service();
		await start(svc);
		const paths = [
			"/api/sessions/foreign/conversations/c1/events",
			"/api/sessions/missing/conversations/c1/events",
			"/api/sessions/s1/conversations/nope/events",
			"/api/sessions/foreign/conversations/c1/events/1",
			"/api/sessions/s1/conversations/nope/agents",
		];
		const bodies: unknown[] = [];
		for (const p of paths) {
			const r = await fetch(`${base}${p}`);
			expect(r.status).toBe(404);
			bodies.push(await r.json());
		}
		for (const b of bodies) expect(b).toEqual(bodies[0]);
		// The foreign/missing session is refused before the conversation is looked up.
		expect(
			(svc.conversationFile as ReturnType<typeof vi.fn>).mock.calls.every(([sid]) => sid === "s1"),
		).toBe(true);
	});

	it("without the subsystem wired, a conversation read is a 404", async () => {
		await start(undefined);
		expect((await fetch(`${base}/api/sessions/s1/conversations/c1/events`)).status).toBe(404);
	});
});
