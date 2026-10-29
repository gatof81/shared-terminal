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

function start(conversation?: ConversationService) {
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
		buildRouter(sessions, docker, {} as BootstrapBroadcaster, undefined, undefined, conversation),
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
		const summaries = vi.fn(async () => [
			{ sessionId: "c1", kind: "interactive", status: "running", canSendInput: false },
		]);
		await start({ list, summaries } as unknown as ConversationService);
		const res = await fetch(`${base}/api/sessions/s1/conversations?capture=0`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.capture).toBeNull();
		expect(body.conversations).toHaveLength(1);
		expect(summaries).toHaveBeenCalledWith("s1");
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
		});
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
