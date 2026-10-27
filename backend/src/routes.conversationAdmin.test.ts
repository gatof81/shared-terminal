/**
 * routes.conversationAdmin.test.ts — the 3.0d admin surface (CONVERSATION.md
 * §7): `PATCH /admin/sessions/:id/conversation`, `GET`/`POST
 * /admin/sessions/:id/recreate` and the `conversation` block of
 * `/admin/stats`.
 *
 * Integration, not mocks of the logic: the PATCH runs the real
 * `ConversationService` (real files under a temp root, D1 an in-memory
 * table behind the `db.js` stub), and the recreate routes run the real
 * `RecreationEngine` on the engine's own test harness (fake Docker, D1 and
 * capture). Only auth and HTTP are stubbed.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStubs = vi.hoisted(() => ({
	requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "admin-1";
		next();
	},
	requireAdmin: vi.fn((req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "admin-1";
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

/** The `sessions` columns the capture code reads and writes, by session id. */
type Row = {
	status: string;
	conversation_requested: number;
	ingest_token_hash: string | null;
	ingest_token_hash_suspended: string | null;
	user_id: string;
	container_id: string | null;
};
const db = vi.hoisted(() => ({
	rows: new Map<string, Row>(),
	sql: [] as string[],
	observeLog: [] as Array<{ op: "start" | "end"; params: unknown[] }>,
	failObserveInsert: false,
	/** Observed at the audit INSERT: what had been done by then. */
	onObserveInsert: null as (() => Promise<void> | void) | null,
}));
const ok = (results: unknown[] = [], changes = 0) => ({
	results,
	success: true as const,
	meta: { changes, duration: 0, last_row_id: 0 },
});
vi.mock("./db.js", () => ({
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		db.sql.push(sql);
		const sid = String(params[params.length - 1]);
		const row = db.rows.get(sid);
		if (/^SELECT status, conversation_requested, ingest_token_hash/.test(sql)) {
			return ok(row ? [{ ...row }] : []);
		}
		if (/^SELECT session_id, status, \(ingest_token_hash IS NOT NULL\) AS authorized/.test(sql)) {
			return ok(
				[...db.rows.entries()]
					.filter(([, r]) => r.conversation_requested === 1)
					.map(([id, r]) => ({
						session_id: id,
						status: r.status,
						authorized: r.ingest_token_hash ? 1 : 0,
					})),
			);
		}
		if (/^UPDATE sessions SET conversation_requested = \? WHERE/.test(sql) && row) {
			row.conversation_requested = Number(params[0]);
			return ok([], 1);
		}
		if (/^UPDATE sessions SET ingest_token_hash_suspended = ingest_token_hash/.test(sql) && row) {
			row.ingest_token_hash_suspended = row.ingest_token_hash;
			row.ingest_token_hash = null;
			row.conversation_requested = 0;
			return ok([], 1);
		}
		if (/^UPDATE sessions SET ingest_token_hash = COALESCE/.test(sql) && row) {
			row.ingest_token_hash = row.ingest_token_hash ?? row.ingest_token_hash_suspended;
			row.ingest_token_hash_suspended = null;
			row.conversation_requested = 1;
			return ok([], 1);
		}
		if (/^INSERT INTO session_observe_log/.test(sql)) {
			await db.onObserveInsert?.();
			if (db.failObserveInsert) throw new Error("D1 unavailable");
			db.observeLog.push({ op: "start", params });
			return ok([], 1);
		}
		if (/^UPDATE session_observe_log SET ended_at/.test(sql)) {
			db.observeLog.push({ op: "end", params });
			return ok([], 1);
		}
		return ok();
	}),
	D1StatementError: class extends Error {},
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));

import type { BootstrapBroadcaster } from "./bootstrap.js";
import { hooksFileExists, writeHooksFile } from "./conversation/activation.js";
import {
	type ContainerView,
	relayEnabledExists,
	writeRelayEnabled,
} from "./conversation/captureAuth.js";
import { hashIngestToken } from "./conversation/registry.js";
import {
	checkRevocation,
	writeGlobalRevocation,
	writeSessionRevocation,
} from "./conversation/revocation.js";
import { ConversationService } from "./conversation/service.js";
import { ConversationStore } from "./conversation/store.js";
import type { DockerManager } from "./dockerManager.js";
import { deferred, harness, IMG_N, O_ID, SID, stateOf } from "./recreate/engine.testutil.js";
import { buildRouter } from "./routes.js";
import { sessionLifecycleLock } from "./sessionLifecycleLock.js";
import type { SessionManager } from "./sessionManager.js";

const OWNER = "owner-1";
const TOKEN = "t".repeat(64);
const N_RUNNING = "n".repeat(64);
const IMAGE_N = `sha256:${"a".repeat(64)}`;

type H = Awaited<ReturnType<typeof harness>>;

let server: http.Server | null = null;
let baseUrl = "";
let root = "";
let h: H;
let service: ConversationService;
/** What the service's Docker view answers: the D1 container, running, with capture. */
let view: ContainerView;
const probe = vi.fn(async () => true);
const inspectCapture = vi.fn(async () => view);
let unresolved = false;
/**
 * Holds of the shared (singleton) lifecycle lock taken by a test. Released
 * in afterEach even when an assertion failed first: a leaked hold would
 * make every later test in the file see `busy`.
 */
const holds: Array<{ release: () => void; held: Promise<unknown> }> = [];
function holdLock(op: "delete" | "start", whileHeld: () => Promise<void> = async () => {}) {
	const gate = deferred();
	const held = sessionLifecycleLock
		.run(SID, op, async () => {
			await gate.promise;
			await whileHeld();
		})
		.catch(() => undefined);
	const h = { release: () => gate.resolve(), held };
	holds.push(h);
	return h;
}
/** Sessions the stubbed manager no longer finds (a hard delete happened). */
const gone = new Set<string>();

function sessionRow(over: Partial<Row> = {}): Row {
	return {
		status: "running",
		conversation_requested: 0,
		ingest_token_hash: null,
		ingest_token_hash_suspended: null,
		user_id: OWNER,
		container_id: N_RUNNING,
		...over,
	};
}

async function spinUp(
	opts: {
		flag?: boolean;
		withService?: boolean;
		owner?: string;
		config?: NonNullable<Parameters<typeof harness>[0]>["config"];
	} = {},
) {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-convadmin-"));
	// The production wiring: the engine and the routes share one lock.
	h = await harness({ lock: sessionLifecycleLock, config: opts.config });
	// A real image ID: the route only accepts `sha256:<64 hex>` (D6).
	h.docker.current = { imageId: IMAGE_N, relay2: true };
	h.docker.skillsByImage.set(IMAGE_N, h.docker.skillsByImage.get(IMG_N) ?? null);
	view = {
		exists: true,
		running: true,
		token: TOKEN,
		managedMount: true,
		controlMount: true,
		imageId: IMAGE_N,
		imageRelay2: true,
	};
	service = new ConversationService({
		workspaceRoot: root,
		enabled: opts.flag ?? true,
		port: 3001,
		store: new ConversationStore({ workspaceRoot: root }),
		isRecreateUnresolved: async (sid) =>
			unresolved ||
			(await h.attempts.assertResolved(sid).then(
				() => false,
				() => true,
			)),
		captureDocker: {
			inspectCapture,
			currentImage: async () => ({ imageId: IMAGE_N, relay2: true }),
			probeRelay: probe,
		},
	});
	const sessions = {
		get: vi.fn(async (id: string) =>
			db.rows.has(id) || (id === SID && !gone.has(SID))
				? { sessionId: id, userId: opts.owner ?? OWNER, status: "stopped" }
				: null,
		),
		countByStatus: vi.fn(async () => ({})),
		listAll: vi.fn(async () => []),
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		getReconcileStats: () => ({ lastRunAt: null, sessionsCheckedSinceBoot: 0, errorsSinceBoot: 0 }),
		gatherStats: vi.fn(async () => new Map()),
	} as unknown as DockerManager;
	const limit = { ipMax: 1000, ipWindowMs: 60_000 };
	const router = buildRouter(
		sessions,
		docker,
		{} as BootstrapBroadcaster,
		{
			login: { ...limit, usernameMax: 1000, usernameWindowMs: 60_000 },
			register: limit,
			invitesCreate: limit,
			invitesList: limit,
			invitesRevoke: limit,
			fileUpload: limit,
			logout: limit,
			authStatus: limit,
			adminStats: limit,
			adminAction: limit,
			exec: limit,
		},
		undefined,
		opts.withService === false ? undefined : service,
		{ recreation: h.engine },
	);
	const app = express();
	app.use(express.json());
	app.use("/api", router);
	const s = http.createServer(app);
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function call(method: string, p: string, body?: unknown) {
	return fetch(`${baseUrl}/api${p}`, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
const patch = (sid: string, body: unknown) =>
	call("PATCH", `/admin/sessions/${sid}/conversation`, body);

async function files(sid: string) {
	return {
		marker: await relayEnabledExists(root, sid),
		hooksFile: await hooksFileExists(root, sid),
	};
}

beforeEach(() => {
	db.rows.clear();
	db.sql.length = 0;
	db.observeLog.length = 0;
	db.failObserveInsert = false;
	db.onObserveInsert = null;
	unresolved = false;
	gone.clear();
	probe.mockReset();
	probe.mockImplementation(async () => true);
	inspectCapture.mockClear();
	authStubs.requireAdmin.mockReset();
	authStubs.requireAdmin.mockImplementation((req, _res, next) => {
		(req as { userId?: string }).userId = "admin-1";
		next();
	});
});

afterEach(async () => {
	for (const x of holds.splice(0)) {
		x.release();
		await x.held;
	}
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
	}
	h?.engine.stop();
	sessionLifecycleLock.setGuard(null);
	if (root) await fs.rm(root, { recursive: true, force: true });
	if (h) await fs.rm(h.root, { recursive: true, force: true });
});

function denyAdmin() {
	authStubs.requireAdmin.mockImplementation((_req, res, _next) => {
		(res as { status(n: number): { json(b: unknown): void } })
			.status(403)
			.json({ error: "Forbidden" });
	});
}

// ── PATCH /admin/sessions/:id/conversation ─────────────────────────────────

describe("PATCH /admin/sessions/:id/conversation (§7, §2.4)", () => {
	it("admin only: a non-admin gets 403 and nothing changes", async () => {
		await spinUp();
		db.rows.set(SID, sessionRow({ ingest_token_hash: hashIngestToken(TOKEN) }));
		denyAdmin();
		expect((await patch(SID, { enabled: true })).status).toBe(403);
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
	});

	it("the body must be {enabled: boolean}; an unknown session is 404", async () => {
		await spinUp();
		db.rows.set(SID, sessionRow());
		for (const body of [{}, { enabled: "true" }, { enabled: 1 }, []]) {
			expect((await patch(SID, body)).status).toBe(400);
		}
		expect((await patch("0b1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", { enabled: true })).status).toBe(
			404,
		);
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
	});

	it("enable on a running container with full authorization ⇒ marker → relay identified → hooks file, effective:true", async () => {
		await spinUp();
		db.rows.set(SID, sessionRow({ ingest_token_hash: hashIngestToken(TOKEN) }));
		const res = await patch(SID, { enabled: true });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { enabled: boolean; capture: Record<string, unknown> };
		expect(body).toMatchObject({
			enabled: true,
			capture: { requested: true, effective: true, requiresRecreate: false, pendingReasons: [] },
		});
		expect(db.rows.get(SID)?.conversation_requested).toBe(1);
		expect(await files(SID)).toEqual({ marker: true, hooksFile: true });
	});

	it("relay not identified ⇒ effective:false, relay-unavailable, no hooks file, marker retired", async () => {
		await spinUp();
		db.rows.set(SID, sessionRow({ ingest_token_hash: hashIngestToken(TOKEN) }));
		probe.mockImplementation(async () => false);
		const body = (await (await patch(SID, { enabled: true })).json()) as {
			capture: { effective: boolean; pendingReasons: string[] };
		};
		expect(body.capture.effective).toBe(false);
		expect(body.capture.pendingReasons).toEqual(expect.arrayContaining(["hooks-file-missing"]));
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
	}, 15_000);

	it("a container that can't capture in place (no token / no control mount / token-mismatch) ⇒ requiresRecreate, residual files removed, nothing written", async () => {
		const cases: Array<[string, Partial<ContainerView>, Partial<Row>, string]> = [
			["no token", { token: null }, {}, "container-without-capture"],
			["3.0c, no control mount", { controlMount: false }, {}, "container-without-capture"],
			[
				"token-mismatch",
				{},
				{ ingest_token_hash: hashIngestToken("x".repeat(64)) },
				"token-mismatch",
			],
		];
		for (const [label, over, rowOver, reason] of cases) {
			await spinUp();
			view = { ...(view as Extract<ContainerView, { exists: true }>), ...over } as ContainerView;
			db.rows.set(SID, sessionRow({ ingest_token_hash: hashIngestToken(TOKEN), ...rowOver }));
			await writeRelayEnabled(root, SID);
			await writeHooksFile({ workspaceRoot: root, enabled: true, port: 3001 }, SID);
			const res = await patch(SID, { enabled: true });
			const body = (await res.json()) as {
				capture: { effective: boolean; requiresRecreate: boolean; pendingReasons: string[] };
			};
			expect([label, res.status, body.capture.effective, body.capture.requiresRecreate]).toEqual([
				label,
				200,
				false,
				true,
			]);
			expect([label, body.capture.pendingReasons]).toEqual([
				label,
				expect.arrayContaining([reason]),
			]);
			expect([label, await files(SID)]).toEqual([label, { marker: false, hooksFile: false }]);
			// The mismatch is never "repaired" by copying the fingerprint.
			if (label === "token-mismatch") {
				expect(db.rows.get(SID)?.ingest_token_hash).toBe(hashIngestToken("x".repeat(64)));
			}
			await new Promise<void>((r) => server?.close(() => r()));
			server = null;
			h.engine.stop();
		}
	});

	it("a stopped container is never written: requiresRecreate:false, pendingReasons stopped + hooks-file-missing", async () => {
		await spinUp();
		view = { ...(view as Extract<ContainerView, { exists: true }>), running: false };
		db.rows.set(SID, sessionRow({ status: "stopped", ingest_token_hash: hashIngestToken(TOKEN) }));
		const body = (await (await patch(SID, { enabled: true })).json()) as {
			capture: { effective: boolean; requiresRecreate: boolean; pendingReasons: string[] };
		};
		expect(body.capture).toMatchObject({ effective: false, requiresRecreate: false });
		expect(body.capture.pendingReasons).toEqual(
			expect.arrayContaining(["stopped", "hooks-file-missing"]),
		);
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
		expect(probe).not.toHaveBeenCalled();
	});

	it("enable is refused with the contract's codes and no effects: flag off, global revocation, unresolved recreation", async () => {
		// Flag off.
		await spinUp({ flag: false });
		db.rows.set(SID, sessionRow({ ingest_token_hash: hashIngestToken(TOKEN) }));
		let res = await patch(SID, { enabled: true });
		expect([res.status, await res.json()]).toEqual([409, { error: "flag-off" }]);
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
		await new Promise<void>((r) => server?.close(() => r()));
		server = null;
		h.engine.stop();
		// Global revocation (the emergency `--all`).
		await spinUp();
		db.rows.set(SID, sessionRow({ ingest_token_hash: hashIngestToken(TOKEN) }));
		await writeGlobalRevocation(root, { at: "t", by: "cli" });
		res = await patch(SID, { enabled: true });
		expect([res.status, await res.json()]).toEqual([409, { error: "revoked-globally" }]);
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
		await new Promise<void>((r) => server?.close(() => r()));
		server = null;
		h.engine.stop();
		// A recreation of the session not resolved (K1): the real record.
		await spinUp();
		db.rows.set(SID, sessionRow({ ingest_token_hash: hashIngestToken(TOKEN) }));
		await h.attempts.begin(SID, {
			attemptId: "a1",
			oContainerId: O_ID,
			oCanonicalName: "st-0a1b2c3d-4e5",
			oOldName: "st-0a1b2c3d-4e5-old-1",
			nTempName: "st-0a1b2c3d-4e5-new-1",
		});
		res = await patch(SID, { enabled: true });
		expect([res.status, await res.json()]).toEqual([409, { error: "recreate-unresolved" }]);
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
	});

	it("disable reflects D1, the hooks file and the marker by the time it answers (≤ 1 s), and the receiver refuses from the marker on", async () => {
		await spinUp();
		db.rows.set(
			SID,
			sessionRow({ conversation_requested: 1, ingest_token_hash: hashIngestToken(TOKEN) }),
		);
		await writeRelayEnabled(root, SID);
		await writeHooksFile({ workspaceRoot: root, enabled: true, port: 3001 }, SID);
		const t0 = Date.now();
		const res = await patch(SID, { enabled: false });
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			enabled: false,
			emissionStopsAfterRestart: true,
			capture: { requested: false, effective: false },
		});
		expect(db.rows.get(SID)).toMatchObject({
			conversation_requested: 0,
			ingest_token_hash: null,
			ingest_token_hash_suspended: hashIngestToken(TOKEN),
		});
		expect(await checkRevocation(root, SID)).toBe("session");
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
		// No probe for a capture that is not requested.
		expect(probe).not.toHaveBeenCalled();
	});

	it("disable always works — also while a recreation is unresolved (K1) — and enable afterwards restores the suspended hash", async () => {
		await spinUp();
		db.rows.set(
			SID,
			sessionRow({ conversation_requested: 1, ingest_token_hash: hashIngestToken(TOKEN) }),
		);
		unresolved = true;
		expect((await patch(SID, { enabled: false })).status).toBe(200);
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
		expect((await patch(SID, { enabled: true })).status).toBe(409);
		unresolved = false;
		const body = (await (await patch(SID, { enabled: true })).json()) as {
			capture: { effective: boolean };
		};
		expect(body.capture.effective).toBe(true);
		expect(db.rows.get(SID)).toMatchObject({
			conversation_requested: 1,
			ingest_token_hash: hashIngestToken(TOKEN),
			ingest_token_hash_suspended: null,
		});
		expect(await checkRevocation(root, SID)).toBe("none");
	});

	it("a failure reading the state after a done disable still answers 200 (capture: null), never 500", async () => {
		await spinUp();
		db.rows.set(
			SID,
			sessionRow({ conversation_requested: 1, ingest_token_hash: hashIngestToken(TOKEN) }),
		);
		vi.spyOn(service.authority, "capture").mockRejectedValueOnce(new Error("EIO"));
		const res = await patch(SID, { enabled: false });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			enabled: false,
			emissionStopsAfterRestart: true,
			capture: null,
		});
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
		expect(await checkRevocation(root, SID)).toBe("session");
	});

	// ── #464 R1: enable is a lifecycle operation ──

	const configuredRow = () => sessionRow({ ingest_token_hash: hashIngestToken(TOKEN) });

	for (const op of ["delete", "start"] as const) {
		it(`a ${op} holding the lock ⇒ enable waits, writes nothing meanwhile, then acts on the state it left`, async () => {
			await spinUp();
			db.rows.set(SID, configuredRow());
			const lock = holdLock(op);
			const pending = patch(SID, { enabled: true });
			await new Promise((r) => setTimeout(r, 150));
			expect(sessionLifecycleLock.queued(SID)).toBe(1);
			expect(db.rows.get(SID)?.conversation_requested).toBe(0);
			expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
			lock.release();
			await lock.held;
			const res = await pending;
			expect(res.status).toBe(200);
			expect(((await res.json()) as { capture: { effective: boolean } }).capture.effective).toBe(
				true,
			);
			expect(await files(SID)).toEqual({ marker: true, hooksFile: true });
		});
	}

	it("the session is deleted while enable waits ⇒ 404, nothing written", async () => {
		await spinUp();
		db.rows.set(SID, configuredRow());
		const lock = holdLock("delete", async () => {
			// The hard delete drops the row.
			db.rows.delete(SID);
			gone.add(SID);
		});
		const pending = patch(SID, { enabled: true });
		await new Promise((r) => setTimeout(r, 100));
		lock.release();
		await lock.held;
		const res = await pending;
		expect([res.status, await res.json()]).toEqual([404, { error: "Session not found" }]);
		expect(db.rows.has(SID)).toBe(false);
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
		expect(db.sql.some((q) => /^UPDATE sessions SET conversation_requested/.test(q))).toBe(false);
	});

	it("a recreation holding the lock ⇒ enable waits for it and writes nothing until it is resolved", async () => {
		await spinUp();
		db.rows.set(SID, configuredRow());
		const gate = deferred();
		const started = deferred();
		h.docker.hooks.set("start", async (a) => {
			if (a[0] !== O_ID) {
				started.resolve();
				await gate.promise;
			}
		});
		holds.push({ release: () => gate.resolve(), held: Promise.resolve() });
		const recreating = call("POST", `/admin/sessions/${SID}/recreate`, { expectImageId: IMAGE_N });
		await started.promise;
		expect(sessionLifecycleLock.heldBy(SID)).toBe("recreate");
		const pending = patch(SID, { enabled: true });
		await new Promise((r) => setTimeout(r, 150));
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
		gate.resolve();
		expect((await recreating).status).toBe(200);
		expect(await h.attempts.read(SID)).toMatchObject({ record: { state: "resolved" } });
		expect((await pending).status).toBe(200);
	});

	it("the wait runs out ⇒ 409 busy, nothing written", async () => {
		await spinUp();
		db.rows.set(SID, configuredRow());
		const run = sessionLifecycleLock.run.bind(sessionLifecycleLock);
		const spy = vi
			.spyOn(sessionLifecycleLock, "run")
			.mockImplementation((sid, op, fn, opts) =>
				run(sid, op, fn, op === "enable" ? { ...opts, maxWaitMs: 50 } : opts),
			);
		holdLock("delete");
		try {
			const res = await patch(SID, { enabled: true });
			expect([res.status, await res.json()]).toEqual([409, { error: "busy" }]);
			expect(db.rows.get(SID)?.conversation_requested).toBe(0);
			expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
		} finally {
			spy.mockRestore();
		}
	});

	it("disable never waits for the lock: it cuts while a delete holds it", async () => {
		await spinUp();
		db.rows.set(
			SID,
			sessionRow({ conversation_requested: 1, ingest_token_hash: hashIngestToken(TOKEN) }),
		);
		await writeRelayEnabled(root, SID);
		holdLock("delete");
		const res = await patch(SID, { enabled: false });
		expect(res.status).toBe(200);
		expect(sessionLifecycleLock.heldBy(SID)).toBe("delete");
		expect(db.rows.get(SID)?.conversation_requested).toBe(0);
		expect(await files(SID)).toEqual({ marker: false, hooksFile: false });
	});

	it("without the conversation subsystem wired ⇒ 503, nothing done", async () => {
		await spinUp({ withService: false });
		db.rows.set(SID, sessionRow());
		expect((await patch(SID, { enabled: true })).status).toBe(503);
	});
});

// ── GET /admin/sessions/:id/recreate ──────────────────────────────────────

describe("GET /admin/sessions/:id/recreate (preflight, no effects)", () => {
	it("admin only", async () => {
		await spinUp();
		denyAdmin();
		expect((await call("GET", `/admin/sessions/${SID}/recreate`)).status).toBe(403);
	});

	it("answers the engine's preflight — codes and counts, never paths — and changes nothing", async () => {
		await spinUp();
		const before = stateOf(h);
		const res = await call("GET", `/admin/sessions/${SID}/recreate`);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			["blockers", "captureAfter", "currentImageId", "imageId", "recreatable"].sort(),
		);
		expect(body).toMatchObject({ recreatable: true, blockers: [], currentImageId: IMAGE_N });
		expect(stateOf(h)).toEqual(before);
		expect(h.docker.mutations()).toEqual([]);
		expect((await h.attempts.read(SID)).kind).toBe("none");
	});

	it("blockers are listed, every one of them; an unresolved record is one", async () => {
		await spinUp();
		h.capture.revocation = "session";
		h.cli.version = "2.1.999";
		let body = (await (await call("GET", `/admin/sessions/${SID}/recreate`)).json()) as {
			recreatable: boolean;
			blockers: Array<{ code: string }>;
		};
		expect(body.recreatable).toBe(false);
		expect(body.blockers.map((b) => b.code)).toEqual(
			expect.arrayContaining(["revoked", "control-marker-incompatible"]),
		);
		h.capture.revocation = "none";
		h.cli.version = "2.1.308";
		await h.attempts.begin(SID, {
			attemptId: "a1",
			oContainerId: O_ID,
			oCanonicalName: "st-0a1b2c3d-4e5",
			oOldName: "st-0a1b2c3d-4e5-old-1",
			nTempName: "st-0a1b2c3d-4e5-new-1",
		});
		body = (await (await call("GET", `/admin/sessions/${SID}/recreate`)).json()) as typeof body;
		expect(body.blockers[0]?.code).toBe("recreate-unresolved");
		expect(h.docker.mutations()).toEqual([]);
	});

	it("unknown session ⇒ 404; dockerd unreachable ⇒ 503 docker-unavailable", async () => {
		await spinUp();
		h.d1.row = { ...h.d1.row };
		const getRow = h.d1.getRow.bind(h.d1);
		h.d1.getRow = async () => null;
		expect((await call("GET", `/admin/sessions/${SID}/recreate`)).status).toBe(404);
		h.d1.getRow = getRow;
		h.docker.hooks.set("inspect", () => {
			throw new Error("connect ECONNREFUSED /var/run/docker.sock");
		});
		const res = await call("GET", `/admin/sessions/${SID}/recreate`);
		expect([res.status, await res.json()]).toEqual([503, { error: "docker-unavailable" }]);
	});
});

// ── POST /admin/sessions/:id/recreate ─────────────────────────────────────

describe("POST /admin/sessions/:id/recreate", () => {
	const post = (sid: string, body: unknown) =>
		call("POST", `/admin/sessions/${sid}/recreate`, body);

	it("admin only; expectImageId must be an image ID; both refused with no effects", async () => {
		await spinUp();
		denyAdmin();
		expect((await post(SID, { expectImageId: IMAGE_N })).status).toBe(403);
		authStubs.requireAdmin.mockImplementation((req, _res, next) => {
			(req as { userId?: string }).userId = "admin-1";
			next();
		});
		for (const body of [{}, { expectImageId: "shared-terminal-session" }, { expectImageId: 7 }]) {
			expect((await post(SID, body)).status).toBe(400);
		}
		expect(h.docker.mutations()).toEqual([]);
		expect((await h.attempts.read(SID)).kind).toBe("none");
	});

	it("success ⇒ 200 committed, the engine's body, record resolved", async () => {
		await spinUp();
		const res = await post(SID, { expectImageId: IMAGE_N });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ outcome: "committed", nContainerId: expect.any(String) });
		expect(body).not.toHaveProperty("ok");
		expect(await h.attempts.read(SID)).toMatchObject({
			kind: "ok",
			record: { state: "resolved", outcome: { kind: "committed" } },
		});
	});

	it("the first failing precondition ⇒ 409 with its code, no record, no effects (image-changed)", async () => {
		await spinUp();
		const before = stateOf(h);
		const res = await post(SID, { expectImageId: `sha256:${"b".repeat(64)}` });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: "image-changed" });
		expect(stateOf(h)).toEqual(before);
		expect(h.docker.mutations()).toEqual([]);
		expect((await h.attempts.read(SID)).kind).toBe("none");
	});

	it("another lifecycle operation in progress ⇒ 409 busy, no effects; unresolved ⇒ 409 recreate-unresolved", async () => {
		await spinUp();
		const lock = holdLock("start");
		let res = await post(SID, { expectImageId: IMAGE_N });
		expect([res.status, await res.json()]).toEqual([409, { error: "busy" }]);
		lock.release();
		await lock.held;
		expect(h.docker.mutations()).toEqual([]);
		await h.attempts.begin(SID, {
			attemptId: "a1",
			oContainerId: O_ID,
			oCanonicalName: "st-0a1b2c3d-4e5",
			oOldName: "st-0a1b2c3d-4e5-old-1",
			nTempName: "st-0a1b2c3d-4e5-new-1",
		});
		res = await post(SID, { expectImageId: IMAGE_N });
		expect([res.status, await res.json()]).toEqual([409, { error: "recreate-unresolved" }]);
		expect(h.docker.mutations()).toEqual([]);
	});

	it("a resolved rollback ⇒ 500 recreate-failed {step} without unresolved", async () => {
		await spinUp();
		h.docker.hooks.set("start", (a) => {
			if (a[0] !== O_ID) throw new Error("start failed");
		});
		const res = await post(SID, { expectImageId: IMAGE_N });
		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ error: "recreate-failed", step: "start" });
	});

	it("a foreign owner: the operate row is written once the preconditions passed and BEFORE any effect; its end after", async () => {
		await spinUp({ owner: OWNER });
		const seenAtInsert: Array<{ record: string; mutations: string[]; lock: string | null }> = [];
		db.onObserveInsert = async () => {
			seenAtInsert.push({
				// The durable record is the engine's first effect.
				record: (await h.attempts.read(SID)).kind,
				mutations: [...h.docker.mutations()],
				lock: h.lock.heldBy(SID),
			});
		};
		const res = await post(SID, { expectImageId: IMAGE_N });
		expect(res.status).toBe(200);
		// Under the recreation's lock, after the preconditions, before anything.
		expect(seenAtInsert).toEqual([{ record: "none", mutations: [], lock: "recreate" }]);
		const start = db.observeLog.find((e) => e.op === "start");
		expect(start?.params).toEqual(expect.arrayContaining(["admin-1", SID, OWNER, "operate"]));
		await vi.waitFor(() => expect(db.observeLog.map((e) => e.op)).toEqual(["start", "end"]));
	});

	it("audit fail-closed: the INSERT fails ⇒ 500, no record, no Docker effect", async () => {
		await spinUp({ owner: OWNER });
		db.failObserveInsert = true;
		const before = stateOf(h);
		const res = await post(SID, { expectImageId: IMAGE_N });
		expect(res.status).toBe(500);
		expect(stateOf(h)).toEqual(before);
		expect(h.docker.mutations()).toEqual([]);
		expect((await h.attempts.read(SID)).kind).toBe("none");
		expect(db.observeLog).toEqual([]);
	});

	it("no row when the admin owns the session, nor for a refused request (409)", async () => {
		await spinUp({ owner: "admin-1" });
		expect((await post(SID, { expectImageId: IMAGE_N })).status).toBe(200);
		expect(db.observeLog).toEqual([]);
		await new Promise<void>((r) => server?.close(() => r()));
		server = null;
		h.engine.stop();
		await spinUp({ owner: OWNER });
		expect((await post(SID, { expectImageId: `sha256:${"b".repeat(64)}` })).status).toBe(409);
		expect(db.observeLog).toEqual([]);
	});

	// ── #464 R2: nothing starts after a shutdown or past T_rec ──

	it("audit pending → engine.stop() → late answer ⇒ no create, rename, start, exec or remove; no record", async () => {
		await spinUp({ owner: OWNER });
		const inserting = deferred();
		const answer = deferred();
		db.onObserveInsert = async () => {
			inserting.resolve();
			await answer.promise;
		};
		const pending = post(SID, { expectImageId: IMAGE_N });
		await inserting.promise;
		h.engine.stop();
		answer.resolve();
		const res = await pending;
		expect([res.status, await res.json()]).toEqual([
			500,
			{ error: "recreate-failed", step: "prepare" },
		]);
		expect(h.docker.mutations()).toEqual([]);
		expect((await h.attempts.read(SID)).kind).toBe("none");
	});

	it("an audit that answers after T_rec ⇒ nothing starts, no record", async () => {
		await spinUp({ owner: OWNER, config: { tRecMs: 200, tRbMs: 100 } });
		db.onObserveInsert = () => new Promise((r) => setTimeout(r, 300));
		const res = await post(SID, { expectImageId: IMAGE_N });
		expect([res.status, await res.json()]).toEqual([
			500,
			{ error: "recreate-failed", step: "prepare" },
		]);
		expect(h.docker.mutations()).toEqual([]);
		expect((await h.attempts.read(SID)).kind).toBe("none");
	});

	it("shutdown while begin() writes the record ⇒ no Docker effect; the open record stays as written (D8), no further record write", async () => {
		await spinUp();
		const beginning = deferred();
		const release = deferred();
		const realBegin = h.attempts.begin.bind(h.attempts);
		h.attempts.begin = async (sid, identity) => {
			beginning.resolve();
			await release.promise;
			return realBegin(sid, identity);
		};
		const resolveSpy = vi.spyOn(h.attempts, "resolve");
		const markSpy = vi.spyOn(h.attempts, "markUncertain");
		const pending = post(SID, { expectImageId: IMAGE_N });
		await beginning.promise;
		h.engine.stop();
		release.resolve();
		const res = await pending;
		expect([res.status, await res.json()]).toEqual([
			500,
			{ error: "recreate-failed", step: "prepare", unresolved: true },
		]);
		await new Promise((r) => setTimeout(r, 150));
		expect(h.docker.mutations()).toEqual([]);
		expect(await h.attempts.read(SID)).toMatchObject({ kind: "ok", record: { state: "open" } });
		expect(resolveSpy).not.toHaveBeenCalled();
		expect(markSpy).not.toHaveBeenCalled();
	});

	it("begin() failing during a shutdown ⇒ no durable 'resolved' written after stop() (E5)", async () => {
		await spinUp();
		const realBegin = h.attempts.begin.bind(h.attempts);
		h.attempts.begin = async (sid, identity) => {
			const r = await realBegin(sid, identity);
			h.engine.stop();
			void r;
			throw new Error("fsync of the session dir failed");
		};
		const resolveSpy = vi.spyOn(h.attempts, "resolve");
		const res = await post(SID, { expectImageId: IMAGE_N });
		expect([res.status, await res.json()]).toEqual([
			500,
			{ error: "recreate-failed", step: "record" },
		]);
		expect(resolveSpy).not.toHaveBeenCalled();
		expect(h.docker.mutations()).toEqual([]);
		expect(await h.attempts.read(SID)).toMatchObject({ kind: "ok", record: { state: "open" } });
	});

	it("unknown session ⇒ 404 without touching the engine", async () => {
		await spinUp();
		const res = await post("0b1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", { expectImageId: IMAGE_N });
		expect(res.status).toBe(404);
		expect(h.docker.mutations()).toEqual([]);
	});
});

// ── GET /admin/stats → conversation ────────────────────────────────────────

describe("GET /admin/stats → conversation (§7)", () => {
	const SID2 = "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
	const SID3 = "2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
	const SID4 = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

	async function configured(sid: string) {
		await writeRelayEnabled(root, sid);
		await writeHooksFile({ workspaceRoot: root, enabled: true, port: 3001 }, sid);
	}

	it("the contract's fields only — no titles, no ids — and no Docker call or probe", async () => {
		await spinUp();
		const hash = hashIngestToken(TOKEN);
		// Configured: requested, running, authorized hash, both files.
		db.rows.set(SID, sessionRow({ conversation_requested: 1, ingest_token_hash: hash }));
		await configured(SID);
		// Requested but stopped; requested but revoked; requested without files.
		db.rows.set(
			SID2,
			sessionRow({ conversation_requested: 1, ingest_token_hash: hash, status: "stopped" }),
		);
		await configured(SID2);
		db.rows.set(SID3, sessionRow({ conversation_requested: 1, ingest_token_hash: hash }));
		await configured(SID3);
		await writeSessionRevocation(root, SID3, { at: "t", by: "api" });
		db.rows.set(SID4, sessionRow({ conversation_requested: 1, ingest_token_hash: hash }));
		// Not requested at all.
		db.rows.set("4a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", sessionRow());
		db.sql.length = 0;
		const res = await call("GET", "/admin/stats");
		expect(res.status).toBe(200);
		const text = await res.text();
		const conv = (JSON.parse(text) as { conversation: Record<string, unknown> }).conversation;
		expect(Object.keys(conv).sort()).toEqual(
			[
				"enabledSessions",
				"effectiveSessions",
				"eventsSinceBoot",
				"rejectedSinceBoot",
				"gapsSinceBoot",
				"unattributedGaps",
				"bytesOnDisk",
				"queueBytesNow",
				"queueBytesMax",
				"wsResyncsSinceBoot",
				"recreateOrphans",
			].sort(),
		);
		expect(conv).toMatchObject({
			enabledSessions: 4,
			effectiveSessions: 1,
			rejectedSinceBoot: { byReason: {} },
			recreateOrphans: 0,
		});
		for (const sid of [SID, SID2, SID3, SID4]) expect(text).not.toContain(sid);
		expect(inspectCapture).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(db.sql.filter((q) => /conversation_requested = 1/.test(q))).toHaveLength(1);
	});

	it("flag off ⇒ nothing effective; bytesOnDisk walks the tree at most once per TTL", async () => {
		await spinUp({ flag: false });
		db.rows.set(
			SID,
			sessionRow({ conversation_requested: 1, ingest_token_hash: hashIngestToken(TOKEN) }),
		);
		await configured(SID);
		await fs.mkdir(path.join(root, ".conversations", SID), { recursive: true });
		await fs.writeFile(path.join(root, ".conversations", SID, "c.events.jsonl"), "x".repeat(10));
		const read = async () =>
			(
				(await (await call("GET", "/admin/stats")).json()) as {
					conversation: Record<string, number>;
				}
			).conversation;
		const first = await read();
		expect(first).toMatchObject({ enabledSessions: 1, effectiveSessions: 0, bytesOnDisk: 10 });
		await fs.writeFile(path.join(root, ".conversations", SID, "d.events.jsonl"), "y".repeat(5));
		// Within the TTL: the cached walk.
		expect((await read()).bytesOnDisk).toBe(10);
	});

	it("without the conversation subsystem ⇒ conversation: null, the rest unchanged", async () => {
		await spinUp({ withService: false });
		const body = (await (await call("GET", "/admin/stats")).json()) as Record<string, unknown>;
		expect(body.conversation).toBeNull();
		expect(body).toHaveProperty("sessions");
	});
});
