/**
 * routes.files.test.ts — Workspace Explorer routes (`GET /sessions/:id/fs/*`).
 *
 * Like routes.download.test.ts, these exercise the REAL filesystem logic
 * against a throwaway WORKSPACE_ROOT — only auth and D1 are stubbed —
 * because the security-critical surface is path containment: the routes
 * read the HOST bind mount with the backend's (typically root) privileges.
 *
 * Auth stub: unlike the download test's always-authed stub, requireAuth
 * here honours an `x-test-user` header (absent → 401) so the
 * unauthenticated and cross-user cases run through the real route wiring.
 */

import { promises as fs, mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No imported helpers inside vi.hoisted — it runs before every import in
// this file is initialised (same trap backup.test.ts documents).
const WORKSPACE_ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-files-ws-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	return dir;
});

const authStubs = vi.hoisted(() => {
	const requireAuth = (
		req: { userId?: string; headers: Record<string, string | undefined> },
		res: { status: (n: number) => { json: (b: unknown) => void } },
		next: () => void,
	) => {
		const user = req.headers["x-test-user"];
		if (!user) {
			res.status(401).json({ error: "Authentication required" });
			return;
		}
		req.userId = user;
		next();
	};
	return {
		requireAuth,
		requireAdmin: requireAuth,
		AUTH_COOKIE_NAME: "st_token",
		setAuthCookie: () => {},
		clearAuthCookie: () => {},
		extractTokenFromCookieHeader: () => null,
		verifyJwt: () => null,
		hasAnyUsers: async () => true,
		isUserAdmin: async () => false,
		registerUser: () => {},
		loginUser: () => {},
		listInvites: async () => [] as unknown[],
		createInvite: () => {},
		revokeInvite: () => {},
		InvalidCredentialsError: class extends Error {},
		UsernameTakenError: class extends Error {},
		InviteRequiredError: class extends Error {},
		InviteQuotaExceededError: class extends Error {},
	};
});
vi.mock("./auth.js", () => authStubs);

const dbStubs = vi.hoisted(() => ({
	d1Query: async () => ({
		results: [],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import {
	decodePreview,
	IMAGE_PREVIEW_MAX_BYTES,
	MAX_DIR_ENTRIES,
	TEXT_PREVIEW_MAX_BYTES,
} from "./routes/files.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
import { NotFoundError } from "./sessionManager.js";

const OWNER = "u1";
const SESSION_ID = "sess-1";
// Another tenant's workspace, owned by someone else. Exists on disk so a
// leak would be observable, not just a 404 from a missing dir.
const OTHER_SESSION_ID = "sess-2";
const SESSION_ROOT = path.join(WORKSPACE_ROOT, SESSION_ID);
const OTHER_ROOT = path.join(WORKSPACE_ROOT, OTHER_SESSION_ID);

// Mirrors the real assertOwnedBy contract: missing AND foreign both
// collapse to NotFoundError (no existence oracle).
const ownedSpy = vi.fn(async (sessionId: string, userId: string) => {
	if (sessionId === SESSION_ID && userId === OWNER) return OWNER;
	if (sessionId === OTHER_SESSION_ID && userId === "u2") return "u2";
	throw new NotFoundError("Session not found");
});
// The observe / operate tiers must never be consulted by these routes —
// if a refactor swaps assertOwnedBy for assertCanObserve, a group lead
// could read arbitrary workspace files. Spies that grant access loudly so
// a regression shows up as a test failure, not a silent widening.
const observeSpy = vi.fn(async () => ({ userId: OWNER }));
const operateSpy = vi.fn(async () => ({ userId: OWNER }));

function makeFakeSessions(): SessionManager {
	return {
		assertOwnedBy: ownedSpy,
		assertCanObserve: observeSpy,
		assertCanOperate: operateSpy,
	} as unknown as SessionManager;
}

// No container methods at all: every call path here must work with the
// session's container stopped / gone. Any docker access throws.
function makeFakeDocker(): DockerManager {
	return {
		getUploadTmpDir: () => path.join(WORKSPACE_ROOT, ".tmp-uploads"),
	} as unknown as DockerManager;
}

let server: http.Server | null = null;
let baseUrl = "";

async function spinUp() {
	const router = buildRouter(makeFakeSessions(), makeFakeDocker(), {} as BootstrapBroadcaster, {
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
		fileBrowse: { ipMax: 1000, ipWindowMs: 60_000 },
	});
	const app = express();
	app.use(express.json());
	app.use("/api", router);
	const s = http.createServer(app);
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

type Endpoint = "list" | "preview" | "raw";

/** `rawQuery` is appended verbatim — for the encoding-trick tests. */
function call(
	endpoint: Endpoint,
	opts: { path?: string; rawQuery?: string; sessionId?: string; user?: string | null } = {},
): Promise<Response> {
	const sessionId = opts.sessionId ?? SESSION_ID;
	const query =
		opts.rawQuery !== undefined
			? `?${opts.rawQuery}`
			: opts.path !== undefined
				? `?path=${encodeURIComponent(opts.path)}`
				: "";
	const user = opts.user === undefined ? OWNER : opts.user;
	return fetch(`${baseUrl}/api/sessions/${sessionId}/fs/${endpoint}${query}`, {
		headers: user === null ? {} : { "x-test-user": user },
	});
}

function download(rel: string): Promise<Response> {
	return fetch(`${baseUrl}/api/sessions/${SESSION_ID}/files?path=${encodeURIComponent(rel)}`, {
		headers: { "x-test-user": OWNER },
	});
}

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

let outsideDir: string;

beforeEach(async () => {
	ownedSpy.mockClear();
	observeSpy.mockClear();
	operateSpy.mockClear();
	outsideDir = mkdtempSync(path.join(os.tmpdir(), "st-files-outside-"));
	await fs.writeFile(path.join(outsideDir, "secret.txt"), "host secret");
	await fs.mkdir(path.join(outsideDir, "dir"), { recursive: true });
	await fs.writeFile(path.join(outsideDir, "dir", "inner.txt"), "host inner");

	await fs.mkdir(path.join(SESSION_ROOT, "src", "lib"), { recursive: true });
	await fs.writeFile(path.join(SESSION_ROOT, "README.md"), "# Hello\n\nworld\n");
	await fs.writeFile(path.join(SESSION_ROOT, "src", "index.ts"), "export const x = 1;\n");
	await fs.writeFile(path.join(SESSION_ROOT, "src", "lib", "util.ts"), "export {};\n");
	await fs.writeFile(path.join(SESSION_ROOT, "logo.png"), PNG_BYTES);
	await fs.writeFile(path.join(SESSION_ROOT, "blob.bin"), Buffer.from([0x7f, 0x45, 0x00, 0x01]));
	// Sensitive material in the shapes the session image really produces.
	await fs.writeFile(path.join(SESSION_ROOT, ".env"), "API_KEY=hunter2\n");
	await fs.writeFile(path.join(SESSION_ROOT, ".env.example"), "API_KEY=\n");
	await fs.mkdir(path.join(SESSION_ROOT, ".st", "claude-state"), { recursive: true });
	await fs.writeFile(
		path.join(SESSION_ROOT, ".st", "claude-state", ".credentials.json"),
		'{"token":"oauth"}',
	);
	await fs.mkdir(path.join(SESSION_ROOT, ".st", "ssh"), { recursive: true });
	await fs.writeFile(path.join(SESSION_ROOT, ".st", "ssh", "id_ed25519"), "PRIVATE KEY");
	await fs.mkdir(path.join(SESSION_ROOT, ".config", "gh"), { recursive: true });
	await fs.writeFile(path.join(SESSION_ROOT, ".config", "gh", "hosts.yml"), "oauth_token: x");
	await fs.mkdir(path.join(SESSION_ROOT, ".git"), { recursive: true });
	await fs.writeFile(path.join(SESSION_ROOT, ".git", "config"), "[remote]\n");
	await fs.writeFile(path.join(SESSION_ROOT, "server.pem"), "-----BEGIN PRIVATE KEY-----");

	await fs.mkdir(OTHER_ROOT, { recursive: true });
	await fs.writeFile(path.join(OTHER_ROOT, "tenant2.txt"), "other tenant data");
	// Bait directly under WORKSPACE_ROOT — where `../<name>` traversal
	// from inside a session dir would land.
	await fs.writeFile(path.join(WORKSPACE_ROOT, "escape.txt"), "root-level data");
	await spinUp();
});

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((e) => (e ? reject(e) : resolve()));
		});
		server = null;
	}
	await fs.rm(SESSION_ROOT, { recursive: true, force: true });
	await fs.rm(OTHER_ROOT, { recursive: true, force: true });
	await fs.rm(path.join(WORKSPACE_ROOT, "escape.txt"), { force: true });
	await fs.rm(outsideDir, { recursive: true, force: true });
});

afterAll(async () => {
	await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

// ── Authentication & authorization ──────────────────────────────────────

describe("authentication and authorization", () => {
	it.each<Endpoint>([
		"list",
		"preview",
		"raw",
	])("%s: 401s without a session before any ownership or fs work", async (endpoint) => {
		const res = await call(endpoint, { path: "README.md", user: null });
		expect(res.status).toBe(401);
		expect(ownedSpy).not.toHaveBeenCalled();
	});

	it.each<Endpoint>([
		"list",
		"preview",
		"raw",
	])("%s: 404s (not 403) for another user's session, identical to a missing one", async (endpoint) => {
		// u2 owns sess-2, not sess-1. The response must not differ from
		// a nonexistent session id — no existence oracle.
		const foreign = await call(endpoint, { path: "logo.png", user: "u2" });
		const missing = await call(endpoint, { path: "logo.png", sessionId: "nope", user: "u2" });
		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		expect(await foreign.json()).toEqual(await missing.json());
	});

	it("uses the owner-only check, never the observe/operate tiers", async () => {
		await call("list", { path: "" });
		await call("preview", { path: "README.md" });
		await call("raw", { path: "logo.png" });
		expect(ownedSpy).toHaveBeenCalledTimes(3);
		expect(ownedSpy).toHaveBeenCalledWith(SESSION_ID, OWNER);
		expect(observeSpy).not.toHaveBeenCalled();
		expect(operateSpy).not.toHaveBeenCalled();
	});

	it("can't reach another session's workspace via traversal from an owned one", async () => {
		const res = await call("preview", { path: `../${OTHER_SESSION_ID}/tenant2.txt` });
		expect(res.status).toBe(400);
		const list = await call("list", { path: `../${OTHER_SESSION_ID}` });
		expect(list.status).toBe(400);
	});

	it("can't reach another session's workspace via a planted symlink", async () => {
		await fs.symlink(OTHER_ROOT, path.join(SESSION_ROOT, "peer"));
		expect((await call("list", { path: "peer" })).status).toBe(404);
		expect((await call("preview", { path: "peer/tenant2.txt" })).status).toBe(404);
	});
});

// ── Path validation & traversal ─────────────────────────────────────────

describe("path validation and traversal", () => {
	it("400s preview/raw without a path; list defaults to the root", async () => {
		expect((await call("preview")).status).toBe(400);
		expect((await call("raw")).status).toBe(400);
		const res = await call("list");
		expect(res.status).toBe(200);
		expect((await res.json()).path).toBe("");
	});

	it("400s a repeated path param (array shape)", async () => {
		const res = await call("preview", { rawQuery: "path=a&path=b" });
		expect(res.status).toBe(400);
	});

	it.each(["/etc/passwd", "a\0b", "x".repeat(4097)])("400s an invalid path %#", async (p) => {
		expect((await call("preview", { path: p })).status).toBe(400);
		expect((await call("list", { path: p })).status).toBe(400);
	});

	it.each([
		"../escape.txt",
		"src/../../escape.txt",
		"../../../../etc/passwd",
	])("400s lexical traversal %s without serving the target", async (p) => {
		const res = await call("preview", { path: p });
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).not.toContain("root-level data");
	});

	it("400s a percent-encoded traversal (decoded once by Express)", async () => {
		// %2e%2e%2f → "../" after the single query-string decode.
		const res = await call("preview", { rawQuery: "path=%2e%2e%2fescape.txt" });
		expect(res.status).toBe(400);
	});

	it("treats a double-encoded traversal as a literal in-workspace name", async () => {
		// %252e%252e%252f decodes ONCE to the literal "%2e%2e%2f" — a legal
		// filename. Must not be decoded again into "../".
		const res = await call("preview", { rawQuery: "path=%252e%252e%252fescape.txt" });
		expect(res.status).toBe(404);
		await fs.writeFile(path.join(SESSION_ROOT, "%2e%2e%2fescape.txt"), "literal name");
		const res2 = await call("preview", { rawQuery: "path=%252e%252e%252fescape.txt" });
		expect(res2.status).toBe(200);
		expect((await res2.json()).content).toBe("literal name");
	});

	it("normalises paths that resolve back inside the workspace", async () => {
		const res = await call("preview", { path: "src/lib/../index.ts" });
		expect(res.status).toBe(200);
		expect((await res.json()).path).toBe("src/index.ts");
	});

	it("rejects a traversal-shaped session id that would select a dot dir", async () => {
		// Ownership is stubbed to pass so this exercises the fs-layer
		// defence-in-depth, not the auth check.
		ownedSpy.mockResolvedValueOnce(OWNER);
		const res = await call("list", { sessionId: ".uploads" });
		expect(res.status).toBe(404);
	});
});

// ── Symlinks ────────────────────────────────────────────────────────────

describe("symlinks", () => {
	it("404s a symlink leaf pointing outside the workspace", async () => {
		await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(SESSION_ROOT, "leak.txt"));
		const res = await call("preview", { path: "leak.txt" });
		expect(res.status).toBe(404);
		expect(JSON.stringify(await res.json())).not.toContain("host secret");
	});

	it("404s a symlink leaf even when it resolves inside the workspace", async () => {
		await fs.symlink("README.md", path.join(SESSION_ROOT, "alias.md"));
		expect((await call("preview", { path: "alias.md" })).status).toBe(404);
	});

	it("404s reads through a parent directory symlinked out of the workspace", async () => {
		await fs.symlink(outsideDir, path.join(SESSION_ROOT, "out"));
		expect((await call("preview", { path: "out/secret.txt" })).status).toBe(404);
		expect((await call("raw", { path: "out/x.png" })).status).toBe(404);
	});

	it("404s listing a directory symlinked out of the workspace", async () => {
		await fs.symlink(outsideDir, path.join(SESSION_ROOT, "out"));
		const res = await call("list", { path: "out" });
		expect(res.status).toBe(404);
		expect(JSON.stringify(await res.json())).not.toContain("secret.txt");
		expect((await call("list", { path: "out/dir" })).status).toBe(404);
	});

	it("reports symlinks in listings as `symlink` without following them", async () => {
		await fs.symlink(outsideDir, path.join(SESSION_ROOT, "out"));
		await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(SESSION_ROOT, "leak.txt"));
		const body = await (await call("list", { path: "" })).json();
		const out = body.entries.find((e: { name: string }) => e.name === "out");
		const leak = body.entries.find((e: { name: string }) => e.name === "leak.txt");
		expect(out).toMatchObject({ type: "symlink", size: null });
		expect(leak).toMatchObject({ type: "symlink", size: null });
	});

	it("403s a restricted file reached through an in-workspace symlinked dir", async () => {
		// `docs -> .st` makes the path look harmless lexically.
		await fs.symlink(".st", path.join(SESSION_ROOT, "docs"));
		const res = await call("preview", { path: "docs/claude-state/.credentials.json" });
		expect(res.status).toBe(403);
		expect(JSON.stringify(await res.json())).not.toContain("oauth");
		expect((await call("list", { path: "docs" })).status).toBe(403);
		expect((await call("list", { path: "docs/ssh" })).status).toBe(403);
	});
});

// ── Restricted files ────────────────────────────────────────────────────

describe("restricted files", () => {
	it.each([
		".env",
		".st/claude-state/.credentials.json",
		".st/ssh/id_ed25519",
		".config/gh/hosts.yml",
		".git/config",
		"server.pem",
		"SRC/../.ENV",
	])("403s preview of %s without disclosing content", async (p) => {
		const res = await call("preview", { path: p });
		expect(res.status).toBe(403);
		const text = JSON.stringify(await res.json());
		for (const secret of ["hunter2", "oauth", "PRIVATE KEY", "[remote]"]) {
			expect(text).not.toContain(secret);
		}
	});

	it.each([
		".st",
		".st/claude-state",
		".st/ssh",
		".config/gh",
		".git",
	])("403s listing restricted directory %s", async (p) => {
		expect((await call("list", { path: p })).status).toBe(403);
	});

	it("403s the full-file download route for restricted files too", async () => {
		for (const p of [".env", ".st/ssh/id_ed25519", ".st/claude-state/.credentials.json"]) {
			const res = await download(p);
			expect(res.status).toBe(403);
			expect(await res.text()).not.toMatch(/hunter2|PRIVATE KEY|oauth/);
		}
	});

	it("still serves env templates and ordinary dotfiles", async () => {
		const res = await call("preview", { path: ".env.example" });
		expect(res.status).toBe(200);
		expect((await res.json()).content).toBe("API_KEY=\n");
		expect((await download(".env.example")).status).toBe(200);
	});

	it("lists restricted entries flagged, without size or mtime", async () => {
		const body = await (await call("list", { path: "" })).json();
		const byName = new Map(body.entries.map((e: { name: string }) => [e.name, e]));
		expect(byName.get(".env")).toEqual({
			name: ".env",
			type: "file",
			size: null,
			mtime: null,
			restricted: true,
		});
		expect(byName.get(".st")).toMatchObject({ type: "dir", restricted: true });
		expect(byName.get(".git")).toMatchObject({ type: "dir", restricted: true });
		expect(byName.get(".env.example")).toMatchObject({ restricted: false });
		expect(byName.get("README.md")).toMatchObject({ restricted: false, size: 15 });
		// .config itself is fine; only .config/gh is restricted.
		expect(byName.get(".config")).toMatchObject({ restricted: false });
		const config = await (await call("list", { path: ".config" })).json();
		expect(config.entries[0]).toMatchObject({ name: "gh", restricted: true });
	});

	it("doesn't restrict a source directory that merely shares a secret-file name", async () => {
		await fs.mkdir(path.join(SESSION_ROOT, "src", "credentials"), { recursive: true });
		await fs.writeFile(path.join(SESSION_ROOT, "src", "credentials", "index.ts"), "export {};");
		const list = await (await call("list", { path: "src" })).json();
		expect(list.entries.find((e: { name: string }) => e.name === "credentials")).toMatchObject({
			type: "dir",
			restricted: false,
		});
		expect((await call("preview", { path: "src/credentials/index.ts" })).status).toBe(200);
	});
});

// ── Listing ─────────────────────────────────────────────────────────────

describe("GET /fs/list", () => {
	it("lists one level, directories first, then natural name order", async () => {
		await fs.writeFile(path.join(SESSION_ROOT, "file10.txt"), "");
		await fs.writeFile(path.join(SESSION_ROOT, "file2.txt"), "");
		const res = await call("list", { path: "" });
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.json();
		expect(body.truncated).toBe(false);
		const names: string[] = body.entries.map((e: { name: string }) => e.name);
		const firstFile = body.entries.findIndex((e: { type: string }) => e.type !== "dir");
		expect(body.entries.slice(0, firstFile).every((e: { type: string }) => e.type === "dir")).toBe(
			true,
		);
		expect(names.indexOf("file2.txt")).toBeLessThan(names.indexOf("file10.txt"));
		expect(names).not.toContain("lib"); // one level only
	});

	it("lists nested directories", async () => {
		const body = await (await call("list", { path: "src/lib" })).json();
		expect(body.path).toBe("src/lib");
		expect(body.entries).toEqual([
			expect.objectContaining({ name: "util.ts", type: "file", size: 11 }),
		]);
	});

	it("404s a missing directory and 400s a file", async () => {
		expect((await call("list", { path: "nope" })).status).toBe(404);
		expect((await call("list", { path: "README.md" })).status).toBe(400);
	});

	it("caps very large directories and flags truncation", async () => {
		const big = path.join(SESSION_ROOT, "big");
		await fs.mkdir(big);
		await Promise.all(
			Array.from({ length: MAX_DIR_ENTRIES + 5 }, (_, i) =>
				fs.writeFile(path.join(big, `f${i}`), ""),
			),
		);
		const body = await (await call("list", { path: "big" })).json();
		expect(body.entries).toHaveLength(MAX_DIR_ENTRIES);
		expect(body.truncated).toBe(true);
	});

	it("works with no container at all (stopped session)", async () => {
		// makeFakeDocker has no container methods — reaching here with a
		// 200 proves the route never touched docker.
		expect((await call("list", { path: "src" })).status).toBe(200);
		expect((await call("preview", { path: "src/index.ts" })).status).toBe(200);
		expect((await call("raw", { path: "logo.png" })).status).toBe(200);
	});
});

// ── Preview ─────────────────────────────────────────────────────────────

describe("GET /fs/preview", () => {
	it("returns text content with metadata", async () => {
		const res = await call("preview", { path: "README.md" });
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.json();
		expect(body).toMatchObject({
			kind: "text",
			path: "README.md",
			name: "README.md",
			size: 15,
			content: "# Hello\n\nworld\n",
			truncated: false,
		});
		expect(typeof body.mtime).toBe("string");
	});

	it("truncates text past the preview cap", async () => {
		const big = "a".repeat(TEXT_PREVIEW_MAX_BYTES + 100);
		await fs.writeFile(path.join(SESSION_ROOT, "big.log"), big);
		const body = await (await call("preview", { path: "big.log" })).json();
		expect(body.kind).toBe("text");
		expect(body.truncated).toBe(true);
		expect(body.size).toBe(big.length);
		expect(body.content).toHaveLength(TEXT_PREVIEW_MAX_BYTES);
	});

	it("doesn't misreport a multi-byte char cut at the cap as binary", async () => {
		// "é" is 2 bytes; put one straddling the cap boundary.
		const content = `${"a".repeat(TEXT_PREVIEW_MAX_BYTES - 1)}é${"b".repeat(10)}`;
		await fs.writeFile(path.join(SESSION_ROOT, "edge.txt"), content);
		const body = await (await call("preview", { path: "edge.txt" })).json();
		expect(body.kind).toBe("text");
		expect(body.truncated).toBe(true);
	});

	it("reports binaries without content", async () => {
		const body = await (await call("preview", { path: "blob.bin" })).json();
		expect(body).toMatchObject({ kind: "binary", reason: "binary", size: 4 });
		expect(body.content).toBeUndefined();
	});

	it("reports images as previewable with their mime type", async () => {
		const body = await (await call("preview", { path: "logo.png" })).json();
		expect(body).toMatchObject({ kind: "image", mime: "image/png", size: PNG_BYTES.length });
	});

	it("reports oversized images as too-large instead of previewable", async () => {
		const fh = await fs.open(path.join(SESSION_ROOT, "huge.png"), "w");
		await fh.truncate(IMAGE_PREVIEW_MAX_BYTES + 1);
		await fh.close();
		const body = await (await call("preview", { path: "huge.png" })).json();
		expect(body).toMatchObject({ kind: "binary", reason: "too-large" });
	});

	it("400s a directory, 404s a missing file", async () => {
		expect((await call("preview", { path: "src" })).status).toBe(400);
		expect((await call("preview", { path: "missing.txt" })).status).toBe(404);
	});

	it("400s a FIFO without hanging", async () => {
		const { execFileSync } = await import("node:child_process");
		execFileSync("mkfifo", [path.join(SESSION_ROOT, "pipe")]);
		expect((await call("preview", { path: "pipe" })).status).toBe(400);
	});
});

describe("decodePreview", () => {
	it("flags NUL bytes as binary", () => {
		expect(decodePreview(Buffer.from("abc\0def"), false).kind).toBe("binary");
	});
	it("flags invalid UTF-8 as binary", () => {
		expect(decodePreview(Buffer.from([0xff, 0xfe, 0x41]), false).kind).toBe("binary");
	});
	it("tolerates an incomplete trailing sequence only when truncated", () => {
		const cut = Buffer.from([0x61, 0xc3]); // "a" + first byte of "é"
		expect(decodePreview(cut, true)).toEqual({ kind: "text", content: "a" });
		expect(decodePreview(cut, false).kind).toBe("binary");
	});
});

// ── Raw (inline image) ──────────────────────────────────────────────────

describe("GET /fs/raw", () => {
	it("serves image bytes with a locked-down response", async () => {
		const res = await call("raw", { path: "logo.png" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
	});

	it("415s non-image extensions, so it can't serve HTML/JS with a renderable type", async () => {
		await fs.writeFile(path.join(SESSION_ROOT, "page.html"), "<script>alert(1)</script>");
		expect((await call("raw", { path: "page.html" })).status).toBe(415);
		expect((await call("raw", { path: "README.md" })).status).toBe(415);
	});

	it("serves SVG as image/svg+xml with the sandbox CSP", async () => {
		await fs.writeFile(
			path.join(SESSION_ROOT, "x.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		);
		const res = await call("raw", { path: "x.svg" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/svg+xml");
		expect(res.headers.get("content-security-policy")).toBe(
			"default-src 'none'; style-src 'unsafe-inline'; sandbox",
		);
	});

	it("413s images over the inline cap", async () => {
		const fh = await fs.open(path.join(SESSION_ROOT, "huge.png"), "w");
		await fh.truncate(IMAGE_PREVIEW_MAX_BYTES + 1);
		await fh.close();
		expect((await call("raw", { path: "huge.png" })).status).toBe(413);
	});

	it("403s restricted paths even with an image extension", async () => {
		await fs.writeFile(path.join(SESSION_ROOT, ".st", "shot.png"), PNG_BYTES);
		expect((await call("raw", { path: ".st/shot.png" })).status).toBe(403);
	});
});
