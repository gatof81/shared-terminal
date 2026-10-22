/**
 * routes.git.test.ts — Git Changes routes (`GET /sessions/:id/git/*`).
 *
 * Auth + D1 follow routes.files.test.ts: a header-driven requireAuth stub
 * and a D1 stub behind the REAL SessionManager, so the owner-only /
 * foreign-equals-missing contract runs production code. Docker is a fake
 * whose `execCapture` records every argv and answers from a script — the
 * assertions that matter are about WHAT gets exec'd (fixed argv, client
 * strings only after `--`), WHERE (the owner's container, never another
 * session's), and WHEN (never for a stopped session or a foreign one).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	const row = (
		session_id: string,
		user_id: string,
		status: string,
		container_id: string | null,
	) => ({
		session_id,
		user_id,
		name: session_id,
		status,
		container_id,
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
		["sess-stopped", "u1", "stopped", null],
		// Row says running but the container id is gone (reconcile lag).
		["sess-limbo", "u1", "running", null],
	] as const) {
		sessionRows.set(id, row(id, user, status, cid));
	}
	return {
		sessionRows,
		d1Query: async (sql: string, params: unknown[] = []) => {
			const hit = /FROM sessions WHERE session_id = \?/.test(sql)
				? sessionRows.get(String(params[0]))
				: undefined;
			return {
				results: hit ? [hit] : [],
				success: true as const,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			};
		},
	};
});
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { GIT_ENV } from "./gitReadOnly.js";
import { GIT_IN_FLIGHT_PER_USER } from "./routes/git.js";
import { buildRouter } from "./routes.js";
import { SessionManager } from "./sessionManager.js";

const OWNER = "u1";
const SESSION_ID = "sess-1";
const Z = "\0";

type Capture = {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
	truncated: boolean;
	timedOut: boolean;
};
type ExecCall = {
	sessionId: string;
	argv: string[];
	opts: { containerId?: string; cwd?: string; env?: Record<string, string>; maxBytes: number };
};

const ok = (stdout: string, extra: Partial<Capture> = {}): Capture => ({
	stdout: Buffer.from(stdout, "utf-8"),
	stderr: Buffer.alloc(0),
	exitCode: 0,
	truncated: false,
	timedOut: false,
	...extra,
});
const fail = (stderr: string, exitCode = 128, extra: Partial<Capture> = {}): Capture => ({
	stdout: Buffer.alloc(0),
	stderr: Buffer.from(stderr, "utf-8"),
	exitCode,
	truncated: false,
	timedOut: false,
	...extra,
});

function subcommand(argv: string[]): string {
	if (argv[0] !== "git") return argv[0] as string;
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

// `git diff --raw -z` record for one modified file / one rename.
const rawM = (path: string) => `:100644 100644 abc def M${Z}${path}${Z}`;
const rawR = (oldPath: string, path: string) =>
	`:100644 100644 abc def R100${Z}${oldPath}${Z}${path}${Z}`;
const WORKSPACE = "/home/developer/workspace";

// A clean repo on `main` by default; tests override per subcommand.
let answers: Record<string, Capture | ((argv: string[]) => Capture | Promise<Capture>)>;
let execCalls: ExecCall[];

function makeFakeDocker(): DockerManager {
	return {
		getUploadTmpDir: () => "/tmp/st-git-test-uploads",
		execCapture: vi.fn(async (sessionId: string, argv: string[], opts: ExecCall["opts"]) => {
			execCalls.push({ sessionId, argv, opts });
			const a = answers[subcommand(argv)];
			if (a === undefined) throw new Error(`unscripted: ${argv.join(" ")}`);
			return typeof a === "function" ? a(argv) : a;
		}),
	} as unknown as DockerManager;
}

let sessions: SessionManager;
let ownedSpy: ReturnType<typeof vi.spyOn>;
let observeSpy: ReturnType<typeof vi.spyOn>;
let operateSpy: ReturnType<typeof vi.spyOn>;
let docker: DockerManager;
let server: http.Server | null = null;
let baseUrl = "";

async function spinUp() {
	sessions = new SessionManager();
	ownedSpy = vi.spyOn(sessions, "assertOwnedBy");
	observeSpy = vi.spyOn(sessions, "assertCanObserve");
	operateSpy = vi.spyOn(sessions, "assertCanOperate");
	docker = makeFakeDocker();
	const router = buildRouter(sessions, docker, {} as BootstrapBroadcaster, {
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
		git: { ipMax: 1000, ipWindowMs: 60_000 },
	});
	const app = express();
	app.use(express.json());
	app.use("/api", router);
	const s = http.createServer(app);
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

type Endpoint = "status" | "diff" | "log";

/** The requested path: the last `:(top,literal)` operand, prefix stripped. */
function lastSpec(argv: string[]): string {
	return (argv[argv.length - 1] as string).replace(/^:\(top,literal\)/, "");
}

function call(
	endpoint: Endpoint,
	opts: {
		query?: Record<string, string>;
		rawQuery?: string;
		sessionId?: string;
		user?: string | null;
	} = {},
): Promise<Response> {
	const sessionId = opts.sessionId ?? SESSION_ID;
	const query =
		opts.rawQuery !== undefined
			? `?${opts.rawQuery}`
			: opts.query
				? `?${new URLSearchParams(opts.query).toString()}`
				: "";
	const user = opts.user === undefined ? OWNER : opts.user;
	return fetch(`${baseUrl}/api/sessions/${sessionId}/git/${endpoint}${query}`, {
		headers: user === null ? {} : { "x-test-user": user },
	});
}

const DIFF_Q = { path: "src/app.ts", area: "unstaged" };

/** The exec that produced the patch (not the `--raw` / `ls-files` identification run). */
function patchCall(): ExecCall | undefined {
	return execCalls.find((c) => {
		const k = subcommand(c.argv);
		return k === "diff" || k === "diff --cached" || k === "diff --no-index";
	});
}

beforeEach(async () => {
	execCalls = [];
	answers = {
		status: ok(
			`# branch.oid abc${Z}# branch.head main${Z}# branch.upstream origin/main${Z}# branch.ab +0 -0${Z}`,
		),
		"diff --cached": ok(""),
		diff: ok(""),
		// Identification (gitReadOnly.identifyChange): by default every
		// pathspec resolves to exactly the requested file.
		"diff --raw": (argv) => ok(rawM(lastSpec(argv))),
		"diff --cached --raw": (argv) => ok(rawM(lastSpec(argv))),
		"ls-files": (argv) => ok(`${lastSpec(argv)}${Z}`),
		// `--show-toplevel --show-prefix`: at the workspace root (or at
		// `-C <dir>` when given), prefix empty.
		"rev-parse": (argv) => ok(`${WORKSPACE}${argv[1] === "-C" ? `/${argv[2]}` : ""}\n\n`),
		log: ok(""),
		find: ok(""),
	};
	await spinUp();
});

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((e) => (e ? reject(e) : resolve()));
		});
		server = null;
	}
});

// ── Authentication & authorization ──────────────────────────────────────────

describe("authentication and authorization", () => {
	it.each<Endpoint>([
		"status",
		"diff",
		"log",
	])("%s: 401s without a session before any ownership check or exec", async (endpoint) => {
		const res = await call(endpoint, { query: DIFF_Q, user: null });
		expect(res.status).toBe(401);
		expect(ownedSpy).not.toHaveBeenCalled();
		expect(execCalls).toHaveLength(0);
	});

	it.each<Endpoint>([
		"status",
		"diff",
		"log",
	])("%s: 404s for another user's session, identical to a missing one, and never execs", async (endpoint) => {
		for (let i = 0; i < 2; i++) {
			const foreign = await call(endpoint, { query: DIFF_Q, user: "u2" });
			const missing = await call(endpoint, { query: DIFF_Q, sessionId: "nope", user: "u2" });
			expect(foreign.status).toBe(404);
			expect(missing.status).toBe(404);
			expect(await foreign.json()).toEqual(await missing.json());
		}
		expect(execCalls).toHaveLength(0);
	});

	it("uses the owner-only predicate, never observe/operate tiers", async () => {
		await call("status");
		await call("diff", { query: DIFF_Q });
		await call("log");
		expect(ownedSpy).toHaveBeenCalledTimes(3);
		expect(observeSpy).not.toHaveBeenCalled();
		expect(operateSpy).not.toHaveBeenCalled();
	});

	it("execs only in the owner's own container, with the session's id and the read-only env", async () => {
		const res = await call("status");
		expect(res.status).toBe(200);
		expect(execCalls.length).toBe(4);
		for (const c of execCalls) {
			expect(c.sessionId).toBe(SESSION_ID);
			expect(c.opts.containerId).toBe("ctr-1");
			expect(c.opts.cwd).toBe("/home/developer/workspace");
			expect(c.opts.env).toEqual(GIT_ENV);
			expect(c.opts.env?.GIT_OPTIONAL_LOCKS).toBe("0");
		}
		// u2's own session resolves to u2's container, not sess-1's.
		execCalls = [];
		await call("status", { sessionId: "sess-2", user: "u2" });
		expect(execCalls.every((c) => c.sessionId === "sess-2" && c.opts.containerId === "ctr-2")).toBe(
			true,
		);
	});
});

// ── Session state ───────────────────────────────────────────────────────────

describe("session state", () => {
	it.each(["sess-stopped", "sess-limbo"])("%s: 409 session-not-running, no exec", async (sid) => {
		for (const endpoint of ["status", "diff", "log"] as Endpoint[]) {
			const res = await call(endpoint, { sessionId: sid, query: DIFF_Q });
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ code: "session-not-running" });
		}
		expect(execCalls).toHaveLength(0);
	});

	it("maps a daemon 'not running' rejection to the same 409", async () => {
		answers.status = () => {
			throw Object.assign(new Error("container ctr-1 is not running"), { statusCode: 409 });
		};
		const res = await call("status");
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "session-not-running" });
	});
});

// ── Status ──────────────────────────────────────────────────────────────────

describe("GET /git/status", () => {
	it("clean repository", async () => {
		const res = await call("status");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({
			repo: true,
			root: "",
			truncated: false,
			branch: "main",
			detached: false,
			head: "abc",
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			changes: [],
		});
	});

	it("staged, unstaged, both, untracked and renamed entries with line counts", async () => {
		answers.status = ok(
			[
				"# branch.oid abc",
				"# branch.head feat",
				"1 M. N... 100644 100644 100644 a b staged.ts",
				"1 .M N... 100644 100644 100644 a b unstaged.ts",
				"1 MM N... 100644 100644 100644 a b both.ts",
				"2 R. N... 100644 100644 100644 a b R100 renamed.ts",
				"orig.ts",
				"? brand new.txt",
				"",
			].join(Z),
		);
		answers["diff --cached"] = ok(
			`4\t0\tstaged.ts${Z}1\t1\tboth.ts${Z}0\t0\t${Z}orig.ts${Z}renamed.ts${Z}`,
		);
		answers.diff = ok(`0\t2\tunstaged.ts${Z}3\t3\tboth.ts${Z}`);
		const body = await (await call("status")).json();
		expect(body.branch).toBe("feat");
		expect(body.changes).toEqual([
			expect.objectContaining({
				area: "staged",
				status: "M",
				path: "staged.ts",
				additions: 4,
				deletions: 0,
			}),
			expect.objectContaining({
				area: "unstaged",
				status: "M",
				path: "unstaged.ts",
				additions: 0,
				deletions: 2,
			}),
			expect.objectContaining({
				area: "staged",
				status: "M",
				path: "both.ts",
				additions: 1,
				deletions: 1,
			}),
			expect.objectContaining({
				area: "unstaged",
				status: "M",
				path: "both.ts",
				additions: 3,
				deletions: 3,
			}),
			expect.objectContaining({
				area: "staged",
				status: "R",
				path: "renamed.ts",
				oldPath: "orig.ts",
				additions: 0,
				deletions: 0,
			}),
			expect.objectContaining({
				area: "untracked",
				status: "?",
				path: "brand new.txt",
				additions: null,
			}),
		]);
	});

	it("not a repository → repo:false plus one-level candidates", async () => {
		const notRepo = fail("fatal: not a git repository (or any of the parent directories): .git");
		answers = {
			...answers,
			status: notRepo,
			"diff --cached": notRepo,
			diff: notRepo,
			"rev-parse": notRepo,
		};
		answers.find = ok(`./app/.git${Z}`);
		expect(await (await call("status")).json()).toEqual({ repo: false, candidates: ["app"] });
	});

	it("dir= is passed to git as -C and reflected as root", async () => {
		const res = await call("status", { query: { dir: "app" } });
		expect(res.status).toBe(200);
		expect((await res.json()).root).toBe("app");
		for (const c of execCalls) expect(c.argv.slice(0, 3)).toEqual(["git", "-C", "app"]);
	});

	it.each([
		["../other", 400],
		["/abs", 400],
		["a/../b", 400],
		[".git", 403],
		["x/.ssh", 403],
	])("dir=%s is refused with %i before any exec", async (dir, status) => {
		const res = await call("status", { query: { dir } });
		expect(res.status).toBe(status);
		expect(execCalls).toHaveLength(0);
	});

	it("timeouts answer 504 and other git failures 502, with a code", async () => {
		answers.status = fail("", 124, { timedOut: true });
		let res = await call("status");
		expect(res.status).toBe(504);
		expect(await res.json()).toMatchObject({ code: "timeout" });
		answers.status = fail("fatal: index file corrupt");
		res = await call("status");
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({
			code: "git-failed",
			error: expect.stringContaining("corrupt"),
		});
		answers.status = fail(
			"fatal: detected dubious ownership in repository at '/home/developer/workspace'",
		);
		res = await call("status");
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "unsafe-repository" });
	});

	it("passes a truncated status through with the flag set", async () => {
		answers.status = ok(`# branch.head main${Z}? a${Z}? b${Z}? partial-rec`, {
			truncated: true,
			exitCode: null,
		});
		// exitCode null + truncated: the status command itself was cut.
		// getGitStatus treats non-zero exit as failure, so a cut status
		// surfaces as 502 rather than a silently incomplete list — the
		// list cap (GIT_MAX_STATUS_FILES) is the designed truncation path.
		const res = await call("status");
		expect(res.status).toBe(502);
	});
});

// ── Diff ────────────────────────────────────────────────────────────────────

describe("GET /git/diff", () => {
	it("returns the patch for a file, with the client path only after --", async () => {
		answers.diff = ok("diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n");
		const res = await call("diff", { query: DIFF_Q });
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({
			path: "src/app.ts",
			area: "unstaged",
			patch: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n",
			truncated: false,
			binary: false,
		});
		const argv = patchCall()?.argv as string[];
		expect(argv.slice(-2)).toEqual(["--", ":(top,literal)src/app.ts"]);
		// Before the patch: the location check and the identification run.
		expect(execCalls.map((c) => subcommand(c.argv)).sort()).toEqual([
			"diff",
			"diff --raw",
			"rev-parse",
		]);
	});

	it.each([
		["staged", ["--cached"]],
		["conflict", []],
	])("area=%s", async (area, expectFlags) => {
		answers["diff --cached"] = ok("c");
		answers.diff = ok("u");
		const res = await call("diff", { query: { path: "x.ts", area } });
		expect(res.status).toBe(200);
		for (const f of expectFlags) expect(patchCall()?.argv).toContain(f);
		if (area === "conflict") expect(patchCall()?.argv).not.toContain("--cached");
	});

	it("area=untracked diffs against /dev/null without touching the index", async () => {
		answers["diff --no-index"] = ok("diff --git a/n.txt b/n.txt\n+hello\n", { exitCode: 1 });
		const res = await call("diff", { query: { path: "n.txt", area: "untracked" } });
		expect(res.status).toBe(200);
		expect((await res.json()).patch).toContain("+hello");
		expect(patchCall()?.argv.slice(-3)).toEqual(["--", "/dev/null", "n.txt"]);
		// The worktree read is gated on git's own untracked listing.
		const ls = execCalls.find((c) => subcommand(c.argv) === "ls-files")?.argv as string[];
		expect(ls).toContain("--others");
		expect(ls.slice(-2)).toEqual(["--", ":(top,literal)n.txt"]);
	});

	it("renames carry oldPath as a second literal pathspec", async () => {
		answers["diff --cached"] = ok("r");
		answers["diff --cached --raw"] = ok(rawR("old.ts", "new.ts"));
		await call("diff", { query: { path: "new.ts", area: "staged", oldPath: "old.ts" } });
		expect(patchCall()?.argv.slice(-3)).toEqual([
			"--",
			":(top,literal)old.ts",
			":(top,literal)new.ts",
		]);
	});

	it("adversarial file names ride through as literal operands, never as options", async () => {
		answers.diff = ok("");
		for (const p of [
			"-rf",
			"--output=/tmp/x",
			"*.ts",
			":(glob)*",
			"a;rm -rf x",
			"$(id)",
			"`id`",
			"a b\tc",
		]) {
			execCalls = [];
			const res = await call("diff", { query: { path: p, area: "unstaged" } });
			expect(res.status).toBe(200);
			for (const key of ["diff --raw", "diff"]) {
				const argv = execCalls.find((c) => subcommand(c.argv) === key)?.argv as string[];
				const dd = argv.indexOf("--");
				expect(dd).toBeGreaterThan(0);
				expect(argv.slice(dd + 1)).toEqual([`:(top,literal)${p}`]);
				// Nothing before `--` came from the request.
				expect(argv.slice(0, dd).join(" ")).not.toContain(p);
			}
		}
	});

	it.each([
		["missing path", "area=unstaged", 400],
		["missing area", "path=a.ts", 400],
		["bad area", "path=a.ts&area=all", 400],
		["traversal", "path=..%2Fetc%2Fpasswd&area=unstaged", 400],
		["absolute", "path=%2Fetc%2Fpasswd&area=unstaged", 400],
		["NUL", "path=a%00b&area=unstaged", 400],
		["dot segment", "path=a%2F..%2Fb&area=unstaged", 400],
		["repeated param", "path=a&path=b&area=unstaged", 400],
		["bad oldPath", "path=a&oldPath=..%2Fx&area=staged", 400],
		["restricted .env", "path=.env&area=unstaged", 403],
		["restricted key", "path=keys%2Fid_rsa&area=staged", 403],
		["restricted under .git", "path=.git%2Fconfig&area=unstaged", 403],
		["restricted oldPath", "path=ok.txt&oldPath=.env&area=staged", 403],
	])("%s → %i before any exec", async (_label, rawQuery, status) => {
		const res = await call("diff", { rawQuery });
		expect(res.status).toBe(status);
		expect(execCalls).toHaveLength(0);
	});

	it("a cut patch comes back truncated and line-aligned; binary is flagged", async () => {
		answers.diff = ok("@@ -1 +1 @@\n-a\n+b\n+partial", { truncated: true, exitCode: null });
		let body = await (await call("diff", { query: DIFF_Q })).json();
		expect(body).toMatchObject({ truncated: true, patch: "@@ -1 +1 @@\n-a\n+b\n" });
		answers.diff = ok("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n");
		body = await (await call("diff", { query: { path: "i.png", area: "unstaged" } })).json();
		expect(body.binary).toBe(true);
	});

	// ── G1: the denylist holds against what git RESOLVES, not what was typed ──

	it("a directory pathspec (which would include src/.env) is refused before any patch", async () => {
		answers["diff --raw"] = ok(`${rawM("src/.env")}${rawM("src/app.ts")}`);
		answers.diff = () => {
			throw new Error("patch must not run");
		};
		const res = await call("diff", { query: { path: "src", area: "unstaged" } });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "not-a-single-file" });
		expect(execCalls.some((c) => subcommand(c.argv) === "diff")).toBe(false);
	});

	it("a single match that is not the requested entry is refused too", async () => {
		answers["diff --raw"] = ok(rawM("src/.env"));
		const res = await call("diff", { query: { path: "src", area: "unstaged" } });
		expect(res.status).toBe(400);
	});

	it("an oldPath hint that drags in other files is refused", async () => {
		answers["diff --cached --raw"] = ok(`${rawM("src/other.ts")}${rawM("src/app.ts")}`);
		const res = await call("diff", {
			query: { path: "src/app.ts", area: "staged", oldPath: "src/other.ts" },
		});
		expect(res.status).toBe(400);
	});

	it("a rename whose OLD side is restricted is refused even though the client hid it", async () => {
		answers["diff --cached --raw"] = ok(rawR(".env", "config.txt"));
		const res = await call("diff", { query: { path: "config.txt", area: "staged" } });
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "restricted" });
		expect(execCalls.some((c) => subcommand(c.argv) === "diff --cached")).toBe(false);
	});

	it("untracked: a path git does not list (e.g. behind a symlinked dir) is never opened", async () => {
		answers["ls-files"] = ok("");
		answers["diff --no-index"] = () => {
			throw new Error("--no-index must not run");
		};
		const res = await call("diff", { query: { path: "alias/notes.txt", area: "untracked" } });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ patch: "", truncated: false });
		expect(execCalls.some((c) => subcommand(c.argv) === "diff --no-index")).toBe(false);
	});

	it("untracked: a directory (several listed files) is refused", async () => {
		answers["ls-files"] = ok(`newdir/a.txt${Z}newdir/b.txt${Z}`);
		const res = await call("diff", { query: { path: "newdir", area: "untracked" } });
		expect(res.status).toBe(400);
	});

	it("a patch that grew a second file between identification and read is refused", async () => {
		answers.diff = ok(
			"diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/src/.env b/src/.env\n@@ -1 +1 @@\n-S=1\n+S=2\n",
		);
		const res = await call("diff", { query: DIFF_Q });
		expect(res.status).toBe(400);
		expect((await res.json()).error).not.toContain("S=2");
	});

	it.each([
		"status",
		"diff",
		"log",
	] as Endpoint[])("%s: a dir that resolves to a repository outside the workspace is 403", async (endpoint) => {
		answers["rev-parse"] = ok("/home/developer/.st\n\n");
		answers.status = ok(`# branch.head main${Z}1 .M N... 100644 100644 100644 a b notes.txt${Z}`);
		answers.log = ok(
			`${"a".repeat(40)}\x1faaaaaaa\x1fA\x1f2026-01-01T00:00:00+00:00\x1fsecret subject${Z}`,
		);
		answers.diff = ok("diff --git a/notes.txt b/notes.txt\n@@ -1 +1 @@\n-x\n+secret body\n");
		const res = await call(endpoint, { query: { ...DIFF_Q, dir: "alias" } });
		expect(res.status).toBe(403);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("outside-workspace");
		expect(body).not.toContain("secret");
		expect(body).not.toContain("notes.txt");
	});

	it("a repository reached through a symlink INSIDE the workspace is refused as well", async () => {
		// `link -> proj`: toplevel is the real path, not the lexical one.
		answers["rev-parse"] = ok(`${WORKSPACE}/proj\n\n`);
		const res = await call("status", { query: { dir: "link" } });
		expect(res.status).toBe(403);
	});
});

// ── Log ─────────────────────────────────────────────────────────────────────

describe("GET /git/log", () => {
	it("returns parsed commits", async () => {
		const h = "c".repeat(40);
		answers.log = ok(`${h}\x1fccccccc\x1fAda\x1f2026-10-22T10:00:00+00:00\x1ffeat: x${Z}`);
		const res = await call("log");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			commits: [
				{
					hash: h,
					shortHash: "ccccccc",
					author: "Ada",
					date: "2026-10-22T10:00:00+00:00",
					subject: "feat: x",
				},
			],
		});
	});

	it("an unborn branch is an empty list, not an error", async () => {
		answers.log = fail("fatal: your current branch 'main' does not have any commits yet");
		expect(await (await call("log")).json()).toEqual({ commits: [] });
	});
});

// ── Concurrency ─────────────────────────────────────────────────────────────

describe("concurrency", () => {
	// Each log request is a location check plus the log itself; count the latter.
	const logExecs = () => execCalls.filter((c) => subcommand(c.argv) === "log").length;

	it("answers 429 past the per-user in-flight cap and recovers once requests finish", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		answers.log = async () => {
			await gate;
			return ok("");
		};
		const held = Array.from({ length: GIT_IN_FLIGHT_PER_USER }, () => call("log"));
		// Let the held requests reach the exec before probing.
		await vi.waitFor(() => expect(logExecs()).toBe(GIT_IN_FLIGHT_PER_USER));
		const extra = await call("log");
		expect(extra.status).toBe(429);
		expect(extra.headers.get("retry-after")).toBe("1");
		// Another user is not affected by u1's budget.
		const other = await call("status", { sessionId: "sess-2", user: "u2" });
		expect(other.status).toBe(200);
		release();
		for (const r of await Promise.all(held)) expect(r.status).toBe(200);
		expect((await call("log")).status).toBe(200);
	});

	// ── G2: a slot follows the WORK, not the connection ──

	it("disconnecting clients do not free slots while their git runs are still active", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		answers.log = async () => {
			await gate;
			return ok("");
		};
		// Fill the budget, then hang up on every one of them.
		const controllers = Array.from({ length: GIT_IN_FLIGHT_PER_USER }, () => new AbortController());
		const held = controllers.map((c) =>
			fetch(`${baseUrl}/api/sessions/${SESSION_ID}/git/log`, {
				headers: { "x-test-user": OWNER },
				signal: c.signal,
			}).catch(() => null),
		);
		await vi.waitFor(() => expect(logExecs()).toBe(GIT_IN_FLIGHT_PER_USER));
		for (const c of controllers) c.abort();
		await Promise.all(held);
		// The execs are still running: the budget is still spent.
		const probe = await call("log");
		expect(probe.status).toBe(429);
		expect(logExecs()).toBe(GIT_IN_FLIGHT_PER_USER);
		// Only once git actually finished does the budget come back.
		release();
		await vi.waitFor(async () => expect((await call("log")).status).toBe(200));
	});

	it("an early refusal (outside-workspace) does not answer — nor free the slot — while the sibling log run is pending", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		answers["rev-parse"] = ok("/home/developer/.st\n\n");
		answers.log = async () => {
			await gate;
			return ok("");
		};
		const held = Array.from({ length: GIT_IN_FLIGHT_PER_USER }, () =>
			call("log", { query: { dir: "alias" } }),
		);
		await vi.waitFor(() => expect(logExecs()).toBe(GIT_IN_FLIGHT_PER_USER));
		// The 403 is decided already, but its git process isn't done.
		let answered = 0;
		for (const h of held) h.then(() => answered++);
		await new Promise((r) => setTimeout(r, 50));
		expect(answered).toBe(0);
		const extra = await call("log", { query: { dir: "alias" } });
		expect(extra.status).toBe(429);
		expect(logExecs()).toBe(GIT_IN_FLIGHT_PER_USER);
		release();
		for (const r of await Promise.all(held)) expect(r.status).toBe(403);
		// Slots back: a well-located request now goes through.
		answers["rev-parse"] = ok(`${WORKSPACE}\n\n`);
		await vi.waitFor(async () => expect((await call("log")).status).toBe(200));
	});

	it("a request that fails inside git still returns its slot", async () => {
		answers.log = fail("fatal: broken", 128);
		for (let i = 0; i < GIT_IN_FLIGHT_PER_USER + 2; i++) {
			expect((await call("log")).status).toBe(502);
		}
	});
});
