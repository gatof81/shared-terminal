/**
 * routes.workroot.test.ts — `?work=<id>` on the Files, download and Git
 * routes: the root of the operation is that work's worktree
 * (`<workspace>/.st/ctx/<id>`) and nothing else.
 *
 * Files run the REAL filesystem logic against a throwaway WORKSPACE_ROOT
 * (only auth and D1 are stubbed), like routes.files.test.ts; Git runs the
 * real route + gitReadOnly against a scripted execCapture, like
 * routes.git.test.ts (the real-git side of the worktree check is in
 * gitReadOnly.integration.test.ts).
 *
 * The D1 stub answers the work lookup by evaluating the same predicate the
 * SQL states (owner, id, agent of THIS session, not cleaned) over the
 * fixtures below, so every refusal here goes through the production query
 * path, not a stub that returns a canned row.
 */

import { promises as fs, mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-workroot-ws-${process.pid}-${Date.now()}`;
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

const dbStubs = vi.hoisted(() => {
	const sessionRows = new Map<string, Record<string, unknown>>();
	const row = (session_id: string, user_id: string, status: string, cid: string | null) => ({
		session_id,
		user_id,
		name: session_id,
		status,
		container_id: cid,
		container_name: `st-${session_id}`,
		cols: 80,
		rows: 24,
		env_vars: "{}",
		created_at: "2026-01-01 00:00:00",
		last_connected_at: null,
		external_ref: null,
	});
	for (const [id, user, status, cid] of [
		["sess-1", "u1", "running", "ctr-1"],
		["sess-2", "u2", "running", "ctr-2"],
		["sess-3", "u1", "running", "ctr-3"],
		["sess-stopped", "u1", "stopped", null],
	] as const) {
		sessionRows.set(id, row(id, user, status, cid));
	}
	// agent_id → (session, owner, name)
	const agents = new Map([
		["a1", { session_id: "sess-1", owner_user_id: "u1", name: "dev" }],
		["a2", { session_id: "sess-2", owner_user_id: "u2", name: "other" }],
		["a3", { session_id: "sess-3", owner_user_id: "u1", name: "qa" }],
		["a4", { session_id: "sess-stopped", owner_user_id: "u1", name: "idle" }],
	]);
	const work = (owner_user_id: string, id: string, agent_id: string, state: string) => ({
		owner_user_id,
		id,
		agent_id,
		project_id: "p1",
		branch: `work/${id}`,
		base_sha: "b".repeat(40),
		port_base: 20100,
		state,
		note: null,
		created_by: "owner",
		created_at: "2026-11-24T00:00:00.000Z",
		closed_at: null,
		cleaned_at: null,
	});
	const works = [
		work("u1", "w1", "a1", "active"),
		work("u1", "wclosed", "a1", "closed"),
		work("u1", "wpending", "a1", "cleanup-pending"),
		work("u1", "wcleaned", "a1", "cleaned"),
		work("u1", "wcreating", "a1", "creating"),
		work("u1", "wcreating-nodir", "a1", "creating"),
		work("u1", "wlink", "a1", "active"),
		// Same owner, ANOTHER agent (sess-3): its dir is planted in sess-1 too.
		work("u1", "wqa", "a3", "active"),
		// Another owner's work, dir also planted in sess-1.
		work("u2", "wforeign", "a2", "active"),
		work("u1", "wstopped", "a4", "active"),
	];
	return {
		sessionRows,
		works,
		d1Query: async (sql: string, params: unknown[] = []) => {
			let results: unknown[] = [];
			if (/FROM sessions WHERE session_id = \?/.test(sql)) {
				const hit = sessionRows.get(String(params[0]));
				results = hit ? [hit] : [];
			} else if (/FROM agent_works w\s+JOIN acp_agents a/.test(sql)) {
				const [owner, id, sessionId] = params.map(String);
				results = works
					.filter((w) => {
						const a = agents.get(w.agent_id);
						return (
							w.owner_user_id === owner &&
							w.id === id &&
							a?.session_id === sessionId &&
							a.owner_user_id === w.owner_user_id &&
							w.state !== "cleaned"
						);
					})
					.map((w) => ({ ...w, agent: agents.get(w.agent_id)?.name }));
			} else {
				throw new Error(`unexpected SQL: ${sql}`);
			}
			return {
				results,
				success: true as const,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			};
		},
	};
});
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import { SessionManager } from "./sessionManager.js";

const OWNER = "u1";
const SESSION_ID = "sess-1";
const SESSION_ROOT = path.join(WORKSPACE_ROOT, SESSION_ID);
const CTX = path.join(SESSION_ROOT, ".st", "ctx");
const W1 = path.join(CTX, "w1");
const Z = "\0";
const CONTAINER_WS = "/home/developer/workspace";

type Capture = {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
	truncated: boolean;
	timedOut: boolean;
};
const ok = (stdout: string): Capture => ({
	stdout: Buffer.from(stdout, "utf-8"),
	stderr: Buffer.alloc(0),
	exitCode: 0,
	truncated: false,
	timedOut: false,
});

function subcommand(argv: string[]): string {
	let i = 1;
	while (argv[i] === "-C" || argv[i] === "-c") i += 2;
	const sub = argv[i] as string;
	if (sub === "diff") {
		const raw = argv.includes("--raw") ? " --raw" : "";
		if (argv.includes("--cached")) return `diff --cached${raw}`;
		if (argv.includes("--no-index")) return "diff --no-index";
		return `diff${raw}`;
	}
	return sub;
}

let answers: Record<string, Capture | ((argv: string[]) => Capture)>;
let execCalls: { sessionId: string; argv: string[]; opts: { containerId?: string } }[];
let server: http.Server | null = null;
let baseUrl = "";
let outsideDir: string;

async function spinUp() {
	const docker = {
		getUploadTmpDir: () => path.join(WORKSPACE_ROOT, ".tmp-uploads"),
		execCapture: vi.fn(
			async (sessionId: string, argv: string[], opts: { containerId?: string }) => {
				execCalls.push({ sessionId, argv, opts });
				const a = answers[subcommand(argv)];
				if (a === undefined) throw new Error(`unscripted: ${argv.join(" ")}`);
				return typeof a === "function" ? a(argv) : a;
			},
		),
	} as unknown as DockerManager;
	const lim = { ipMax: 1000, ipWindowMs: 60_000 };
	const router = buildRouter(new SessionManager(), docker, {} as BootstrapBroadcaster, {
		login: { ...lim, usernameMax: 1000, usernameWindowMs: 60_000 },
		register: lim,
		invitesCreate: lim,
		invitesList: lim,
		invitesRevoke: lim,
		fileUpload: lim,
		logout: lim,
		authStatus: lim,
		adminStats: lim,
		adminAction: lim,
		exec: lim,
		fileBrowse: lim,
		fileRaw: lim,
		git: lim,
	});
	const app = express();
	app.use(express.json());
	app.use("/api", router);
	const s = http.createServer(app);
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function get(
	route: string,
	query: Record<string, string> | string,
	opts: { sessionId?: string; user?: string } = {},
): Promise<Response> {
	const q = typeof query === "string" ? query : new URLSearchParams(query).toString();
	return fetch(`${baseUrl}/api/sessions/${opts.sessionId ?? SESSION_ID}/${route}?${q}`, {
		headers: { "x-test-user": opts.user ?? OWNER },
	});
}
const files = (ep: "list" | "preview" | "raw", query: Record<string, string> | string, o = {}) =>
	get(`fs/${ep}`, query, o);
const download = (query: Record<string, string>, o = {}) => get("files", query, o);
const git = (ep: "status" | "diff" | "log", query: Record<string, string> | string, o = {}) =>
	get(`git/${ep}`, query, o);

async function write(p: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, content);
}

beforeEach(async () => {
	outsideDir = mkdtempSync(path.join(os.tmpdir(), "st-workroot-outside-"));
	await write(path.join(outsideDir, "README.md"), "OUTSIDE-HOST");
	await write(path.join(outsideDir, "outside-only.txt"), "x");

	// Main checkout + the rest of .st (all must stay out of reach).
	await write(path.join(SESSION_ROOT, "README.md"), "MAIN-CHECKOUT");
	await write(path.join(SESSION_ROOT, ".st", "acp", "slot-2.log"), "ACP-LOG");
	await write(path.join(SESSION_ROOT, ".st", "claude-state", ".credentials.json"), "OAUTH");
	await write(
		path.join(SESSION_ROOT, ".git", "worktrees", "w1", "HEAD"),
		"ref: refs/heads/work/w1",
	);
	// The work's worktree.
	await write(path.join(W1, "README.md"), "work readme");
	await write(path.join(W1, "src", "a.ts"), "export const a = 1;\n");
	await write(path.join(W1, "logo.svg"), "<svg/>");
	await write(path.join(W1, ".env"), "API_KEY=hunter2");
	await write(path.join(W1, ".git"), `gitdir: ${CONTAINER_WS}/.git/worktrees/w1\n`);
	await write(path.join(W1, ".st", "nested", "secret.txt"), "NESTED-ST");
	// Other works' dirs, each with a recognisable file.
	for (const id of ["w2", "wclosed", "wpending", "wcleaned", "wcreating", "wqa", "wforeign"]) {
		await write(path.join(CTX, id, "README.md"), `readme of ${id}`);
	}
	await write(path.join(WORKSPACE_ROOT, "sess-stopped", ".st", "ctx", "wstopped", "a.txt"), "kept");
	execCalls = [];
	answers = {
		status: ok(`# branch.oid abc${Z}# branch.head work/w1${Z}`),
		"diff --cached": ok(""),
		diff: ok(""),
		"diff --raw": (argv) => ok(`:100644 100644 a b M${Z}${lastSpec(argv)}${Z}`),
		"diff --cached --raw": (argv) => ok(`:100644 100644 a b M${Z}${lastSpec(argv)}${Z}`),
		"ls-files": (argv) => ok(`${lastSpec(argv)}${Z}`),
		// A healthy worktree: git's top level is exactly the -C dir.
		"rev-parse": (argv) => ok(`${CONTAINER_WS}${argv[1] === "-C" ? `/${argv[2]}` : ""}\n\n`),
		log: ok(""),
	};
	await spinUp();
});

function lastSpec(argv: string[]): string {
	return (argv[argv.length - 1] as string).replace(/^:\(top,literal\)/, "");
}

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((e) => (e ? reject(e) : resolve()));
		});
		server = null;
	}
	await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
	await fs.rm(outsideDir, { recursive: true, force: true });
});

afterAll(async () => {
	await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

// ── Files: the worktree is the root ─────────────────────────────────────────

describe("Files with work", () => {
	it("lists the worktree root, with the work's view for the Tools strip", async () => {
		const res = await files("list", { work: "w1" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.path).toBe("");
		const byName = new Map(
			body.entries.map((e: { name: string; restricted: boolean }) => [e.name, e]),
		);
		expect([...byName.keys()].sort()).toEqual([
			".env",
			".git",
			".st",
			"README.md",
			"logo.svg",
			"src",
		]);
		// The worktree's `.git` FILE (→ the main repo's .git/worktrees/w1),
		// `.env` and a nested `.st/` are listed restricted, as in the workspace.
		for (const n of [".git", ".env", ".st"]) {
			expect((byName.get(n) as { restricted: boolean }).restricted).toBe(true);
		}
		expect(body.work).toMatchObject({
			id: "w1",
			agent: "dev",
			branch: "work/w1",
			dir: `${CONTAINER_WS}/.st/ctx/w1`,
			baseSha: "b".repeat(40),
			portBase: 20100,
			state: "active",
		});
	});

	it("previews, serves raw and downloads files of the worktree", async () => {
		const prev = await files("preview", { work: "w1", path: "README.md" });
		expect(prev.status).toBe(200);
		expect((await prev.json()).content).toBe("work readme");
		const raw = await files("raw", { work: "w1", path: "logo.svg" });
		expect(raw.status).toBe(200);
		expect(await raw.text()).toBe("<svg/>");
		const dl = await download({ work: "w1", path: "src/a.ts" });
		expect(dl.status).toBe(200);
		expect(await dl.text()).toBe("export const a = 1;\n");
	});

	it("without work everything is as before: the workspace root, `.st/` 403", async () => {
		const list = await (await files("list", {})).json();
		expect(list.work).toBeUndefined();
		expect(list.entries.find((e: { name: string }) => e.name === ".st").restricted).toBe(true);
		expect((await files("list", { path: ".st/ctx/w1" })).status).toBe(403);
		expect((await files("preview", { path: ".st/ctx/w1/README.md" })).status).toBe(403);
		expect((await download({ path: ".st/ctx/w1/README.md" })).status).toBe(403);
		expect((await (await files("preview", { path: "README.md" })).json()).content).toBe(
			"MAIN-CHECKOUT",
		);
	});

	it("serves a stopped session's worktree (host read, like the workspace)", async () => {
		const res = await files(
			"preview",
			{ work: "wstopped", path: "a.txt" },
			{ sessionId: "sess-stopped" },
		);
		expect(res.status).toBe(200);
	});
});

describe("Files with work: restricted paths inside the worktree", () => {
	it.each([
		".env",
		".git",
		".st/nested/secret.txt",
	])("403s %s on preview, raw and download", async (p) => {
		expect((await files("preview", { work: "w1", path: p })).status).toBe(403);
		expect((await files("raw", { work: "w1", path: p })).status).toBe(403);
		expect((await download({ work: "w1", path: p })).status).toBe(403);
	});

	it("403s listing a nested .st", async () => {
		expect((await files("list", { work: "w1", path: ".st" })).status).toBe(403);
	});
});

describe("Files with work: nothing outside the worktree", () => {
	it.each([
		"../w2/README.md",
		"../../acp/slot-2.log",
		"../../claude-state/.credentials.json",
		"../../../README.md",
		"src/../../w2/README.md",
		"../../../../../../etc/passwd",
	])("400s lexical traversal %s", async (p) => {
		for (const ep of ["preview", "raw"] as const) {
			const res = await files(ep, { work: "w1", path: p });
			expect(res.status).toBe(400);
		}
		expect((await download({ work: "w1", path: p })).status).toBe(400);
		expect((await files("list", { work: "w1", path: p.replace(/\/[^/]+$/, "") })).status).toBe(400);
	});

	it("400s an absolute path", async () => {
		expect((await files("preview", { work: "w1", path: `${SESSION_ROOT}/README.md` })).status).toBe(
			400,
		);
		expect((await files("list", { work: "w1", path: "/" })).status).toBe(400);
	});

	it("400s a percent-encoded traversal and keeps a double-encoded one literal", async () => {
		const enc = await files("preview", "work=w1&path=%2e%2e%2fw2%2fREADME.md");
		expect(enc.status).toBe(400);
		const dbl = await files("preview", "work=w1&path=%252e%252e%252fw2%252fREADME.md");
		expect(dbl.status).toBe(404);
	});

	it.each([
		["to .st/acp", "../../acp", "slot-2.log", "ACP-LOG"],
		["to .st/claude-state", "../../claude-state", ".credentials.json", "OAUTH"],
		["to the main checkout", "../../..", "README.md", "MAIN-CHECKOUT"],
		["to another work", "../w2", "README.md", "readme of w2"],
	])("a symlinked dir inside the worktree %s is never followed", async (_n, target, leaf, secret) => {
		await fs.symlink(target, path.join(W1, "link"));
		for (const res of [
			await files("preview", { work: "w1", path: `link/${leaf}` }),
			await files("list", { work: "w1", path: "link" }),
			await download({ work: "w1", path: `link/${leaf}` }),
		]) {
			expect([403, 404]).toContain(res.status);
			expect(await res.text()).not.toContain(secret);
		}
	});

	it("a symlink to outside the workspace is never followed (dir or leaf)", async () => {
		await fs.symlink(outsideDir, path.join(W1, "out"));
		await fs.symlink(path.join(outsideDir, "README.md"), path.join(W1, "leaf.md"));
		expect((await files("preview", { work: "w1", path: "out/README.md" })).status).toBe(404);
		expect((await files("list", { work: "w1", path: "out" })).status).toBe(404);
		expect((await files("preview", { work: "w1", path: "leaf.md" })).status).toBe(404);
		expect((await download({ work: "w1", path: "leaf.md" })).status).toBe(404);
	});

	it.each([
		["the main checkout", () => SESSION_ROOT],
		["outside the workspace", () => outsideDir],
		["another work", () => path.join(CTX, "w2")],
	])("a work whose ROOT is a symlink to %s is a 404", async (_n, target) => {
		await fs.symlink(target(), path.join(CTX, "wlink"));
		for (const res of [
			await files("list", { work: "wlink" }),
			await files("preview", { work: "wlink", path: "README.md" }),
			await download({ work: "wlink", path: "README.md" }),
			await git("status", { work: "wlink" }),
		]) {
			expect(res.status).toBe(404);
			const text = await res.text();
			expect(text).not.toMatch(/MAIN-CHECKOUT|OUTSIDE-HOST|readme of w2/);
		}
		expect(execCalls).toEqual([]);
	});

	it("a symlinked `.st/ctx` makes every work a 404", async () => {
		await fs.rename(CTX, path.join(SESSION_ROOT, "ctx-real"));
		await fs.symlink(path.join(SESSION_ROOT, "ctx-real"), CTX);
		expect((await files("preview", { work: "w1", path: "README.md" })).status).toBe(404);
	});
});

// ── Which work: the same 404 for everything not this session's ──────────────

describe("work authorization", () => {
	const notFound = async () => (await files("list", {}, { sessionId: "nope" })).json();

	it.each([
		["a missing id", "nope"],
		["a cleaned work (even with its dir still there)", "wcleaned"],
		["a creating work whose worktree does not exist", "wcreating-nodir"],
		["another agent's work of the same owner", "wqa"],
		["another owner's work", "wforeign"],
		["a malformed id", "../w1"],
		["an upper-case id", "W1"],
		["an empty id", ""],
	])("%s → the same 404 as a missing session, on every route", async (_n, id) => {
		const expected = await notFound();
		for (const res of [
			await files("list", { work: id }),
			await files("preview", { work: id, path: "README.md" }),
			await files("raw", { work: id, path: "README.md" }),
			await download({ work: id, path: "README.md" }),
			await git("status", { work: id }),
			await git("log", { work: id }),
			await git("diff", { work: id, path: "README.md", area: "unstaged" }),
		]) {
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual(expected);
		}
		expect(execCalls).toEqual([]);
	});

	it("a repeated work param (array) is a 404", async () => {
		expect((await files("list", "work=w1&work=w2")).status).toBe(404);
	});

	it("another owner probing this session with a valid work id gets the plain 404", async () => {
		const res = await files("list", { work: "w1" }, { user: "u2" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual(await notFound());
	});

	it("the other agent's work IS usable from its own session (sess-3), not from sess-1", async () => {
		await write(path.join(WORKSPACE_ROOT, "sess-3", ".st", "ctx", "wqa", "README.md"), "qa work");
		const res = await files("preview", { work: "wqa", path: "README.md" }, { sessionId: "sess-3" });
		expect(res.status).toBe(200);
		expect((await res.json()).content).toBe("qa work");
	});

	it.each(["wclosed", "wpending", "wcreating"])("%s (worktree present) is usable", async (id) => {
		const res = await files("preview", { work: id, path: "README.md" });
		expect(res.status).toBe(200);
		expect((await res.json()).content).toBe(`readme of ${id}`);
	});
});

// ── Git ─────────────────────────────────────────────────────────────────────

describe("Git with work", () => {
	it("status runs -C .st/ctx/<id> in the session's container and answers the work's view", async () => {
		const res = await git("status", { work: "w1" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ repo: true, root: "", branch: "work/w1" });
		expect(body.work).toMatchObject({
			id: "w1",
			branch: "work/w1",
			portBase: 20100,
			state: "active",
		});
		expect(execCalls.length).toBeGreaterThan(0);
		for (const c of execCalls) {
			expect(c.sessionId).toBe(SESSION_ID);
			expect(c.opts.containerId).toBe("ctr-1");
			expect(c.argv.slice(1, 3)).toEqual(["-C", ".st/ctx/w1"]);
		}
	});

	it("log and diff run on the worktree too", async () => {
		expect((await git("log", { work: "w1" })).status).toBe(200);
		answers.diff = ok("diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n");
		const res = await git("diff", { work: "w1", path: "src/a.ts", area: "unstaged" });
		expect(res.status).toBe(200);
		expect((await res.json()).patch).toContain("+y");
		for (const c of execCalls) expect(c.argv.slice(1, 3)).toEqual(["-C", ".st/ctx/w1"]);
	});

	it("git finding the MAIN checkout above the worktree (broken .git) is 403 outside-workspace", async () => {
		// toplevel = workspace, prefix = .st/ctx/w1/ — `dir` IS inside that
		// repository, which the workspace mode accepts; a work must not.
		answers["rev-parse"] = ok(`${CONTAINER_WS}\n.st/ctx/w1/\n`);
		answers.status = ok(`# branch.head main${Z}1 .M N... 100644 100644 100644 a b MAIN.txt${Z}`);
		answers.log = ok(
			`${"a".repeat(40)}\x1faaaaaaa\x1fA\x1f2026-01-01T00:00:00+00:00\x1fmain subject${Z}`,
		);
		for (const res of [
			await git("status", { work: "w1" }),
			await git("log", { work: "w1" }),
			await git("diff", { work: "w1", path: "src/a.ts", area: "unstaged" }),
		]) {
			expect(res.status).toBe(403);
			const text = await res.text();
			expect(text).toContain("outside-workspace");
			expect(text).not.toMatch(/MAIN\.txt|main subject/);
		}
	});

	it("a worktree whose git top level is elsewhere (core.worktree, symlink) is 403", async () => {
		answers["rev-parse"] = ok(`${CONTAINER_WS}/.st/ctx/w2\n\n`);
		expect((await git("status", { work: "w1" })).status).toBe(403);
	});

	it("refuses `dir` together with `work`", async () => {
		const res = await git("status", { work: "w1", dir: "" });
		expect(res.status).toBe(400);
		expect((await git("status", { work: "w1", dir: "../.." })).status).toBe(400);
		expect(execCalls).toEqual([]);
	});

	it.each([
		".env",
		".git",
		".st/nested/secret.txt",
	])("403s a diff of %s inside the worktree", async (p) => {
		const res = await git("diff", { work: "w1", path: p, area: "unstaged" });
		expect(res.status).toBe(403);
	});

	it("traversal in a diff path is refused before git runs", async () => {
		for (const p of ["../w2/README.md", "/etc/passwd"]) {
			expect((await git("diff", { work: "w1", path: p, area: "unstaged" })).status).toBe(400);
		}
		expect(execCalls).toEqual([]);
	});

	it("a stopped session's work answers 409 session-not-running", async () => {
		const res = await git("status", { work: "wstopped" }, { sessionId: "sess-stopped" });
		expect(res.status).toBe(409);
	});

	it("without work, `dir=.st/ctx/w1` stays refused (403)", async () => {
		expect((await git("status", { dir: ".st/ctx/w1" })).status).toBe(403);
		expect(execCalls).toEqual([]);
	});
});

// ── Adversarial races ───────────────────────────────────────────────────────
// Code in the container flips a path between a real directory and a symlink
// while probes run; outside content must NEVER be served (one-sided property,
// like routes.files.test.ts's races).

describe("directory-swap races with work", () => {
	async function race(
		target: string,
		linkTo: string,
		probe: () => Promise<string>,
	): Promise<string[]> {
		const stash = `${target}.stash`;
		const link = `${target}.link`;
		await fs.symlink(linkTo, link);
		const hold = () => new Promise((r) => setTimeout(r, 1));
		let stop = false;
		const flipper = (async () => {
			while (!stop) {
				await hold();
				await fs.rename(target, stash);
				await fs.rename(link, target);
				await hold();
				await fs.rename(target, link);
				await fs.rename(stash, target);
			}
		})();
		const bodies: string[] = [];
		try {
			for (let round = 0; round < 200; round++) {
				bodies.push(...(await Promise.all(Array.from({ length: 4 }, probe))));
			}
		} finally {
			stop = true;
			await flipper;
		}
		return bodies;
	}

	it("a subdirectory of the worktree swapped for a link outside: never served", async () => {
		await write(path.join(W1, "sub", "README.md"), "inside");
		const bodies = await race(path.join(W1, "sub"), outsideDir, async () =>
			(await files("preview", { work: "w1", path: "sub/README.md" })).text(),
		);
		expect(bodies.some((b) => b.includes("inside"))).toBe(true);
		expect(bodies.filter((b) => b.includes("OUTSIDE-HOST"))).toEqual([]);
	});

	it("the worktree ROOT swapped for a link to the main checkout: never served", async () => {
		const bodies = await race(W1, SESSION_ROOT, async () =>
			(await files("preview", { work: "w1", path: "README.md" })).text(),
		);
		expect(bodies.some((b) => b.includes("work readme"))).toBe(true);
		expect(bodies.filter((b) => b.includes("MAIN-CHECKOUT"))).toEqual([]);
	});

	it("the worktree ROOT swapped for a link outside: never listed", async () => {
		const bodies = await race(W1, outsideDir, async () =>
			(await files("list", { work: "w1" })).text(),
		);
		expect(bodies.some((b) => b.includes("logo.svg"))).toBe(true);
		expect(bodies.filter((b) => b.includes("outside-only.txt"))).toEqual([]);
	});

	it("download through a swapped worktree root: never served", async () => {
		const bodies = await race(W1, SESSION_ROOT, async () =>
			(await download({ work: "w1", path: "README.md" })).text(),
		);
		expect(bodies.filter((b) => b.includes("MAIN-CHECKOUT"))).toEqual([]);
	});
});
