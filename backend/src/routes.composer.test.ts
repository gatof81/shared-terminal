/**
 * routes.composer.test.ts — the HTTP and host-CLI surface of the 3.2 composer
 * (CONVERSATION.md §8.1.1, §8.1.11) over a real ComposerService, a real
 * ConversationStore and a real PaneRecordStore, with the Docker side
 * scripted. What the route layer owns: the flag gate (routes absent when
 * off), `assertCanOperate` (403 for lead/observer, 404 missing), the
 * cross-user `operate` row, body validation of the admin endpoint, and the
 * host CLI calling the SAME endpoint — so a CLI resolution and an active
 * send meet on the backend's pane exclusion, never on a second lock.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const authStubs = vi.hoisted(() => ({
	requireAuth: (
		req: { userId?: string; headers: Record<string, string | undefined> },
		_res: unknown,
		next: () => void,
	) => {
		req.userId = req.headers["x-test-user"] ?? "owner";
		next();
	},
	requireAdmin: vi.fn(
		(
			req: { userId?: string; headers: Record<string, string | undefined> },
			res: { status: (n: number) => { json: (b: unknown) => void } },
			next: () => void,
		) => {
			if ((req.headers["x-test-user"] ?? "owner") !== "admin-1") {
				res.status(403).json({ error: "admin only" });
				return;
			}
			req.userId = "admin-1";
			next();
		},
	),
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
	isUserAdmin: vi.fn(async () => false),
	InvalidCredentialsError: class extends Error {},
	UsernameTakenError: class extends Error {},
	InviteRequiredError: class extends Error {},
	InviteQuotaExceededError: class extends Error {},
}));
vi.mock("./auth.js", () => authStubs);
const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async (..._args: unknown[]) => ({
		results: [] as unknown[],
		success: true as const,
		meta: {},
	})),
	getD1CallsSinceBoot: vi.fn(() => 0),
	__resetD1CallsForTests: vi.fn(),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import { type ComposerDockerPort, ComposerService } from "./conversation/composer.js";
import { runComposerCli } from "./conversation/composerCli.js";
import { CSI_U_NEWLINE } from "./conversation/composerText.js";
import { PaneRecordStore } from "./conversation/paneRecord.js";
import type { ConversationService } from "./conversation/service.js";
import { ConversationStore } from "./conversation/store.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import { ForbiddenError, NotFoundError, type SessionManager } from "./sessionManager.js";
import type { SessionMeta } from "./types.js";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CID = "conv-a";
const PANE = "%3";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const RULE = "─".repeat(40);

class FakeDocker implements ComposerDockerPort {
	calls: string[] = [];
	parkPaste = false;
	parked: Array<(exit: number) => void> = [];
	states = new Map<string, { running: boolean; exitCode: number | null }>();
	/** What the pane's input shows, as the CLI would echo it. */
	typed = "";
	private n = 0;
	async exec(
		_c: string,
		cmd: string[],
		_stdin: Buffer | null,
		onCreated: (id: string) => Promise<boolean>,
	) {
		const j = cmd.join(" ");
		const id = `e${++this.n}`;
		const step = j.includes("tmux display")
			? "display"
			: j.includes("capture-pane")
				? "capture"
				: j.includes("st-ancestry")
					? "ancestry"
					: j.includes("load-buffer")
						? "paste"
						: j.includes(CSI_U_NEWLINE)
							? "newline"
							: "enter";
		this.calls.push(step);
		if (!(await onCreated(id))) return { execId: id, exitCode: null, stdout: "" };
		let exit = 0;
		if (step === "paste" && this.parkPaste)
			exit = await new Promise<number>((r) => this.parked.push(r));
		this.states.set(id, { running: false, exitCode: exit });
		if (exit === 0) {
			if (step === "paste") this.typed += _stdin?.toString("utf8") ?? "";
			else if (step === "newline") this.typed += "\n";
			else if (step === "enter") this.typed = "";
		}
		const stdout =
			step === "display"
				? "700 0 0 claude\n"
				: step === "capture"
					? `${RULE}\n❯ ${this.typed}\n${RULE}\n`
					: step === "ancestry"
						? "yes\n"
						: "";
		return { execId: id, exitCode: exit, stdout };
	}
	async execState(id: string) {
		return this.states.get(id) ?? null;
	}
	async containerState() {
		return "running" as const;
	}
}

let root: string;
let store: ConversationStore;
let docker: FakeDocker;
let composer: ComposerService;
let server: http.Server;
let base: string;
let meta: SessionMeta;

async function start(opts: { enabled?: boolean } = {}) {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-croute-"));
	store = new ConversationStore({ workspaceRoot: root });
	await store.open(SID, CID);
	store.update(SID, CID, (i) => {
		i.kind = "interactive";
		i.paneId = PANE;
		i.claudeVersion = "2.1.314";
	});
	await store.flush(SID, CID);
	docker = new FakeDocker();
	meta = {
		sessionId: SID,
		userId: "owner",
		status: "running",
		containerId: "cont-1",
	} as unknown as SessionMeta;
	composer = new ComposerService({
		enabled: opts.enabled ?? true,
		store,
		records: new PaneRecordStore(root),
		docker,
		sessions: { getOrThrow: async () => meta },
		conversation: {
			probeSession: async () => [{ sessionId: CID, kind: "interactive", pid: 733, status: "idle" }],
			onPersistedEvent: (l) => store.onEvent(l),
			captureEffective: async () => true,
		},
		after: () => new Promise(() => undefined), // no timer ever fires in these tests
	});
	const sessions = {
		assertCanOperate: vi.fn(async (id: string, userId: string) => {
			if (id === "missing") throw new NotFoundError();
			if (userId === "lead" || userId === "observer") throw new ForbiddenError();
			return meta;
		}),
		get: vi.fn(async (id: string) => (id === "missing" ? null : meta)),
	} as unknown as SessionManager;
	const dockerManager = {
		getUploadTmpDir: () => "/tmp/x",
		getReconcileStats: () => ({ lastRunAt: null, sessionsCheckedSinceBoot: 0, errorsSinceBoot: 0 }),
	} as unknown as DockerManager;
	const app = express();
	app.use(express.json());
	app.use(
		"/api",
		buildRouter(
			sessions,
			dockerManager,
			{} as BootstrapBroadcaster,
			undefined,
			undefined,
			{} as ConversationService,
			{
				composer,
			},
		),
	);
	server = http.createServer(app);
	await new Promise<void>((r) =>
		server.listen(0, () => {
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			r();
		}),
	);
}
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
	await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	dbStubs.d1Query.mockClear();
});

const post = (path: string, body: unknown, user = "owner") =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-test-user": user },
		body: JSON.stringify(body),
	});
const until = async (pred: () => boolean, ms = 3000) => {
	const t = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > t) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
};
async function promptArrives(text: string) {
	store.enqueue(SID, CID, {
		ev: "user_prompt",
		prompt_id: "p1",
		turn_id: null,
		agent_id: null,
		pane: PANE,
		data: { prompt: text },
	});
	await store.flush(SID, CID);
}

describe("POST /api/sessions/:id/conversations/:cid/messages (§8.1.1)", () => {
	it("flag off ⇒ the route does not exist, nor the admin ones", async () => {
		await start({ enabled: false });
		expect(
			(
				await post(`/api/sessions/${SID}/conversations/${CID}/messages`, {
					text: "x",
					clientMessageId: ID1,
				})
			).status,
		).toBe(404);
		expect((await post(`/api/admin/sessions/${SID}/composer/resolve`, {}, "admin-1")).status).toBe(
			404,
		);
		expect(
			(
				await fetch(`${base}/api/admin/sessions/${SID}/composer/panes`, {
					headers: { "x-test-user": "admin-1" },
				})
			).status,
		).toBe(404);
	});
	it("owner: 400 for a bad body, 202 delivered once the CLI's prompt lands; no-store", async () => {
		await start();
		const bad = await post(`/api/sessions/${SID}/conversations/${CID}/messages`, { text: "x" });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "invalid-body" });
		const p = post(`/api/sessions/${SID}/conversations/${CID}/messages`, {
			text: "hello",
			clientMessageId: ID1,
		});
		await until(() => docker.calls.includes("enter"));
		await promptArrives("hello");
		const res = await p;
		expect(res.status).toBe(202);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toMatchObject({
			result: "delivered",
			clientMessageId: ID1,
			promptId: "p1",
		});
		// Owner: no operate row.
		expect(dbStubs.d1Query).not.toHaveBeenCalled();
	});
	it("lead and observer get 403; a missing session 404; nothing is executed", async () => {
		await start();
		expect(
			(
				await post(
					`/api/sessions/${SID}/conversations/${CID}/messages`,
					{ text: "x", clientMessageId: ID1 },
					"lead",
				)
			).status,
		).toBe(403);
		expect(
			(
				await post(
					`/api/sessions/${SID}/conversations/${CID}/messages`,
					{ text: "x", clientMessageId: ID1 },
					"observer",
				)
			).status,
		).toBe(403);
		expect(
			(
				await post(`/api/sessions/missing/conversations/${CID}/messages`, {
					text: "x",
					clientMessageId: ID1,
				})
			).status,
		).toBe(404);
		expect(docker.calls).toEqual([]);
	});
	it("an admin on a foreign session writes the operate row before any effect (D1 insert)", async () => {
		await start();
		const p = post(
			`/api/sessions/${SID}/conversations/${CID}/messages`,
			{ text: "hi", clientMessageId: ID1 },
			"admin-1",
		);
		await until(() => docker.calls.includes("enter"));
		const insert = dbStubs.d1Query.mock.calls.find((c) =>
			String(c[0]).includes("INSERT INTO session_observe_log"),
		);
		expect(insert).toBeTruthy();
		expect((insert as unknown[])[1]).toEqual(
			expect.arrayContaining(["admin-1", SID, "owner", "operate"]),
		);
		await promptArrives("hi");
		expect((await p).status).toBe(202);
	});
});

describe("admin resolve / panes and the host CLI (§8.1.11)", () => {
	it("validates the body, answers 404 without an operation, and 409 operation-active during an active send — from the API and from the CLI alike", async () => {
		await start();
		const bad = await post(
			`/api/admin/sessions/${SID}/composer/resolve`,
			{ paneId: "3", clientMessageId: ID1, outcome: "discarded" },
			"admin-1",
		);
		expect(bad.status).toBe(400);
		expect(
			(
				await post(
					`/api/admin/sessions/${SID}/composer/resolve`,
					{ paneId: PANE, clientMessageId: ID1, outcome: "reconcile" },
					"admin-1",
				)
			).status,
		).toBe(404);
		expect(
			(
				await post(
					`/api/admin/sessions/${SID}/composer/resolve`,
					{ paneId: PANE, clientMessageId: ID1, outcome: "reconcile" },
					"owner",
				)
			).status,
		).toBe(403);

		docker.parkPaste = true;
		const p = post(`/api/sessions/${SID}/conversations/${CID}/messages`, {
			text: "slow",
			clientMessageId: ID1,
		});
		await until(() => docker.parked.length === 1);
		// API: the executor holds the pane ⇒ 409, nothing written.
		const r = await post(
			`/api/admin/sessions/${SID}/composer/resolve`,
			{ paneId: PANE, clientMessageId: ID1, outcome: "discarded" },
			"admin-1",
		);
		expect(r.status).toBe(409);
		expect(await r.json()).toEqual({ error: "operation-active" });
		// CLI: the same endpoint, the same exclusion, the same 409.
		const out: string[] = [];
		const err: string[] = [];
		const cli = {
			port: (server.address() as AddressInfo).port,
			lookupAdmin: async (u: string) => (u === "root" ? { id: "admin-1", username: "root" } : null),
			signToken: () => "tok",
			fetch: (url: string | URL | Request, init?: RequestInit) =>
				fetch(url, {
					...init,
					headers: { ...(init?.headers as Record<string, string>), "x-test-user": "admin-1" },
				}),
			stdout: (l: string) => out.push(l),
			stderr: (l: string) => err.push(l),
		};
		expect(await runComposerCli([SID, PANE, ID1, "discarded", "--user", "root"], cli)).toBe(1);
		expect(out[0]).toMatch(/^409 .*operation-active/);
		expect(err[0]).toMatch(/refused by the backend's pane exclusion/);
		// A non-admin user is refused before any request.
		expect(await runComposerCli([SID, PANE, ID1, "discarded", "--user", "nobody"], cli)).toBe(1);
		// The listing shows the active operation.
		out.length = 0;
		expect(await runComposerCli([SID, "--list", "--user", "root"], cli)).toBe(0);
		expect(JSON.parse(out[0]!)).toMatchObject({
			panes: [{ paneId: PANE, clientMessageId: ID1, phase: "active", result: "pending" }],
		});
		// The send completes untouched by the refused resolutions.
		docker.parked[0]!(0);
		await until(() => docker.calls.includes("enter"));
		await promptArrives("slow");
		expect(await (await p).json()).toMatchObject({ result: "delivered" });
		// The HTTP answer precedes `released` (result → answer → release, §8.1.4);
		// once the record is gone, nothing is left on the pane: reconcile is a 404.
		await until(() => (composer as unknown as { live: Map<string, unknown> }).live.size === 0);
		expect(await runComposerCli([SID, PANE, ID1, "reconcile", "--user", "root"], cli)).toBe(1);
		expect(out.at(-1)).toMatch(/^404 /);
		// The second declaration path never happened: one operate row at most would be the send's; owner sent, so none.
		expect(
			dbStubs.d1Query.mock.calls.filter((c) =>
				String(c[0]).includes("INSERT INTO session_observe_log"),
			),
		).toHaveLength(0);
	});
	it("the CLI refuses when the backend is not reachable (the exclusion lives there)", async () => {
		await start();
		const err: string[] = [];
		const code = await runComposerCli([SID, PANE, ID2, "reconcile", "--user", "root"], {
			port: 1, // nothing listens
			lookupAdmin: async () => ({ id: "admin-1", username: "root" }),
			signToken: () => "tok",
			fetch,
			stdout: () => undefined,
			stderr: (l) => err.push(l),
		});
		expect(code).toBe(1);
		expect(err[0]).toMatch(/backend not reachable|ECONNREFUSED|fetch failed/);
	});
});
