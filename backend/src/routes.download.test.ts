/**
 * routes.download.test.ts — GET /sessions/:id/files route tests for #358.
 *
 * The security-critical surface is path containment: the route streams
 * files from the HOST bind mount, so a traversal / symlink escape reads
 * arbitrary host files with the backend's (typically root) privileges.
 * These tests exercise the real filesystem logic against a throwaway
 * WORKSPACE_ROOT — only auth and D1 are stubbed.
 *
 * Scaffolding follows `routes.start.test.ts` (hoisted auth/db stubs,
 * buildRouter, ephemeral server); the WORKSPACE_ROOT-before-import trick
 * follows `backup.test.ts` — the route module reads the env var at load,
 * so it must be set inside vi.hoisted, before any import executes.
 */

import { promises as fs, mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No imported helpers inside vi.hoisted — it runs before every import in
// this file is initialised (same trap backup.test.ts documents). Plain
// string + Node globals only; the dir is created in beforeEach below.
const WORKSPACE_ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-download-ws-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	return dir;
});

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
import { NotFoundError } from "./sessionManager.js";

const SESSION_ID = "sess-1";
const SESSION_ROOT = path.join(WORKSPACE_ROOT, SESSION_ID);

function makeFakeSessions(): { sessions: SessionManager; ownedSpy: ReturnType<typeof vi.fn> } {
	const ownedSpy = vi.fn(async (sessionId: string) => {
		// Foreign/missing collapse to NotFoundError, same as the real
		// assertOwnedBy — the 404-for-existing-but-foreign test relies
		// on this shape.
		if (sessionId !== SESSION_ID) throw new NotFoundError("Session not found");
		return "u1";
	});
	return { sessions: { assertOwnedBy: ownedSpy } as unknown as SessionManager, ownedSpy };
}

function makeFakeDocker(): DockerManager {
	// getUploadTmpDir is called at route-registration time by the upload
	// middleware setup; nothing else on docker is touched by downloads.
	return {
		getUploadTmpDir: () => path.join(WORKSPACE_ROOT, ".tmp-uploads"),
	} as unknown as DockerManager;
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

afterAll(async () => {
	await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

async function spinUp(sessions: SessionManager) {
	const broadcaster = {} as BootstrapBroadcaster;
	const router = buildRouter(sessions, makeFakeDocker(), broadcaster, {
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

function download(rel: string, sessionId = SESSION_ID): Promise<Response> {
	return fetch(`${baseUrl}/api/sessions/${sessionId}/files?path=${encodeURIComponent(rel)}`);
}

describe("GET /sessions/:id/files", () => {
	// A dir OUTSIDE the workspace root holding "secret" material the
	// symlink-escape tests try (and must fail) to reach.
	let outsideDir: string;

	beforeEach(async () => {
		outsideDir = mkdtempSync(path.join(os.tmpdir(), "st-download-outside-"));
		await fs.mkdir(SESSION_ROOT, { recursive: true });
		await fs.writeFile(path.join(SESSION_ROOT, "hello.txt"), "hello workspace");
		await fs.mkdir(path.join(SESSION_ROOT, "sub"), { recursive: true });
		await fs.writeFile(path.join(SESSION_ROOT, "sub", "nested.bin"), "nested bytes");
		await fs.writeFile(path.join(outsideDir, "secret.txt"), "host secret");
		// Bait directly under WORKSPACE_ROOT — where `../<name>` traversal
		// from inside a session dir would land.
		await fs.writeFile(path.join(WORKSPACE_ROOT, "escape.txt"), "other tenant data");
	});

	afterEach(async () => {
		await fs.rm(SESSION_ROOT, { recursive: true, force: true });
		await fs.rm(path.join(WORKSPACE_ROOT, "escape.txt"), { force: true });
		await fs.rm(outsideDir, { recursive: true, force: true });
	});

	// ── Param validation ────────────────────────────────────────────────

	it("400s when the path param is missing or empty", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);

		const missing = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/files`);
		expect(missing.status).toBe(400);
		expect(((await missing.json()) as { error: string }).error).toMatch(/path/);

		const empty = await download("");
		expect(empty.status).toBe(400);
	});

	it("400s on an absolute path", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await download("/etc/passwd");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/workspace-relative/);
	});

	it("400s on a path longer than 4096 chars", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await download(`a/${"b".repeat(4100)}`);
		expect(res.status).toBe(400);
	});

	// ── Containment ─────────────────────────────────────────────────────

	it("400s on `../` traversal without touching the escaped-to file", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await download("../escape.txt");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/escapes/);
	});

	it("400s on `.` (the workspace root itself is not a downloadable file)", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await download(".");
		expect(res.status).toBe(400);
	});

	it("404s a symlink leaf, even one resolving inside the workspace", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(SESSION_ROOT, "leak"));
		await fs.symlink(path.join(SESSION_ROOT, "hello.txt"), path.join(SESSION_ROOT, "inlink"));

		const escaping = await download("leak");
		expect(escaping.status).toBe(404);

		const internal = await download("inlink");
		expect(internal.status).toBe(404);
	});

	it("404s when a parent directory symlinks out of the workspace", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		await fs.symlink(outsideDir, path.join(SESSION_ROOT, "linkdir"));
		const res = await download("linkdir/secret.txt");
		expect(res.status).toBe(404);
	});

	// ── Wrong-kind / missing targets ────────────────────────────────────

	it("400s a directory with a clear error", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await download("sub");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/directory/);
	});

	it("404s a missing file with the standard error body shape", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await download("nope.txt");
		expect(res.status).toBe(404);
		expect((await res.json()) as { error: string }).toEqual({ error: "File not found" });
	});

	it("404s before any filesystem access for a foreign session", async () => {
		const { sessions, ownedSpy } = makeFakeSessions();
		await spinUp(sessions);
		// hello.txt DOES exist under sess-1; the foreign id must yield the
		// ownership 404 (from assertOwnedBy), not a file-derived response.
		const res = await download("hello.txt", "someone-elses");
		expect(res.status).toBe(404);
		expect(ownedSpy).toHaveBeenCalledWith("someone-elses", "u1");
	});

	// ── Size cap ────────────────────────────────────────────────────────

	it("413s a file over 512 MiB", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		// Sparse file — truncate allocates no blocks, so this is cheap on
		// any filesystem the suite runs on while stat.size still reports
		// past-cap.
		const big = path.join(SESSION_ROOT, "big.bin");
		const fh = await fs.open(big, "w");
		await fh.truncate(512 * 1024 * 1024 + 1);
		await fh.close();
		const res = await download("big.bin");
		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: string }).error).toMatch(/512 MiB/);
	});

	// ── Happy path ──────────────────────────────────────────────────────

	it("streams the file with attachment headers", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await download("hello.txt");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("content-length")).toBe(String("hello workspace".length));
		expect(res.headers.get("content-disposition")).toBe('attachment; filename="hello.txt"');
		expect(await res.text()).toBe("hello workspace");
	});

	it("serves nested paths, including ones that normalise back inside", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const nested = await download("sub/nested.bin");
		expect(nested.status).toBe(200);
		expect(await nested.text()).toBe("nested bytes");

		// `sub/../hello.txt` resolves lexically to a path INSIDE the
		// workspace — containment is about where the path lands, not
		// whether it contains dots.
		const normalised = await download("sub/../hello.txt");
		expect(normalised.status).toBe(200);
		expect(await normalised.text()).toBe("hello workspace");
	});

	it("quote-escapes the filename in Content-Disposition", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		await fs.writeFile(path.join(SESSION_ROOT, 'we"ird.txt'), "x");
		const res = await download('we"ird.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toBe('attachment; filename="we\\"ird.txt"');
	});
});
