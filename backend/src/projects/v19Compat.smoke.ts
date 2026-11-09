/**
 * v19Compat.smoke.ts — Claude A's QA request on #557 (2026-11-09): migration
 * v19 on a v18 database that holds data, and the v18 backend on a v19 database
 * (rollback), against a REAL, disposable Cloudflare D1.
 *
 *   Scenario 1  main's migrateDb (v18) → representative rows → #557's migrateDb:
 *               ledger +19 only, exactly the v19 objects added, every
 *               pre-existing table byte-identical (count + digest), re-run no-op.
 *   Scenario 2  main's real backend (`node dist/index.js`, clean build, flag
 *               absent) on that v19 database: boot, auth/status and the session
 *               reads identical to the same backend on v18, writes (login,
 *               externalRef, conversation meta, a failing create and its
 *               rollback, soft and hard delete), main's backup. Then roll
 *               forward: #557's backend with PROJECT_CHAT_ENABLED=true (only in
 *               this disposable database) — directory reads/writes, the guard,
 *               and #557's backup with the four tables.
 *
 * Each backend is built from `git archive <sha>` of backend/src (as the image
 * does since #555), never from a working tree. Docker is a fake HTTP daemon on
 * 127.0.0.1 that answers 404 for every container and image: no real daemon is
 * reachable, and a 404 is what the backend treats as "already gone".
 *
 *   cd backend && npx tsx --env-file=<file outside the repo, mode 600> src/projects/v19Compat.smoke.ts
 *
 *   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN       — test account; token D1:Edit on it only
 *   P3A_D1_LIVE_EXPECT_ACCOUNT                         — the same account id, typed twice
 *   P3A_D1_LIVE_FORBID_ACCOUNTS                        — REQUIRED: production id(s); each must answer 401/403
 *   V19C_MAIN_SHA, V19C_PR_SHA                         — the two commits (full or short SHAs)
 *
 * Same target guards as d1Live.smoke.ts (G1 forbidden accounts refuse the
 * token, the listing shows only the test account when permitted; G2 every
 * database is `st-p3a-smoke-*`; C0 the new database is empty). The database
 * is created by the script and deleted at the end (GET 404 confirmed), on
 * every exit path. Nothing prints the token; account and database ids are
 * masked in every captured log. Exit 0 PASS, 1 FAIL, 2 refused, 130/143
 * interrupted. Not a vitest test, not built.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

// ── Report ─────────────────────────────────────────────────────────────────

type Check = { id: string; ok: boolean | null; detail: string };
const checks: Check[] = [];
const pass = (id: string, detail: string) => checks.push({ id, ok: true, detail });
const fail = (id: string, detail: string) => checks.push({ id, ok: false, detail });
const info = (id: string, detail: string) => checks.push({ id, ok: null, detail });
const verdict = (id: string, ok: boolean, detail: string) => (ok ? pass : fail)(id, detail);
const raw: string[] = [];

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const PREFIX = "st-p3a-smoke-";
const PRELOAD = process.env.V19C_NODE_PRELOAD; // emulator dry runs only
let dbId = "";
const mask = (s: string) => {
	let out = s;
	for (const [v, m] of [
		[TOKEN, "<token>"],
		[ACCOUNT, "<account>"],
		...targets.map((t, i) => [t.id, `<database-${i + 1}>`] as const),
	] as const) {
		if (v) out = out.split(v).join(m);
	}
	return out;
};
const redact = (id: string) => `${id.slice(0, 6)}…`;

class Refused extends Error {}
function refuse(why: string): never {
	throw new Refused(why);
}

// ── Cloudflare API ─────────────────────────────────────────────────────────

const API = "https://api.cloudflare.com/client/v4";
async function cf(method: string, p: string, body?: unknown) {
	const res = await fetch(`${API}${p}`, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const json = (await res.json().catch(() => null)) as {
		success?: boolean;
		result?: unknown;
		result_info?: { total_count?: number };
		errors?: unknown;
	} | null;
	return {
		status: res.status,
		ok: res.ok && json?.success === true,
		result: json?.result,
		info: json?.result_info,
		errors: json?.errors,
	};
}

/** One statement on the target, independent of either backend's db.ts. */
async function q<T = Record<string, unknown>>(
	sql: string,
	params: unknown[] = [],
	db = dbId,
): Promise<T[]> {
	const r = await cf("POST", `/accounts/${ACCOUNT}/d1/database/${db}/query`, { sql, params });
	if (!r.ok) throw new Error(`D1 ${r.status}: ${mask(JSON.stringify(r.errors))}`);
	return ((r.result as Array<{ results: T[] }>)[0]?.results ?? []) as T[];
}

// ── Target guards (as d1Live.smoke.ts) ─────────────────────────────────────

async function identifyTarget(): Promise<void> {
	if (!ACCOUNT || !TOKEN) refuse("CLOUDFLARE_ACCOUNT_ID / _API_TOKEN unset");
	if (process.env.P3A_D1_LIVE_EXPECT_ACCOUNT !== ACCOUNT) {
		refuse("P3A_D1_LIVE_EXPECT_ACCOUNT must repeat CLOUDFLARE_ACCOUNT_ID");
	}
	const forbidden = (process.env.P3A_D1_LIVE_FORBID_ACCOUNTS ?? "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
	if (forbidden.length === 0) {
		refuse("P3A_D1_LIVE_FORBID_ACCOUNTS is required (the production account id)");
	}
	// A value that fails is never echoed: the likeliest wrong paste is the token.
	for (const [i, id] of [ACCOUNT, ...forbidden].entries()) {
		if (!/^[0-9a-f]{32}$/.test(id)) {
			const where = i === 0 ? "CLOUDFLARE_ACCOUNT_ID" : `P3A_D1_LIVE_FORBID_ACCOUNTS entry ${i}`;
			refuse(`${where} is not a Cloudflare account id (length ${id.length})`);
		}
	}
	if (forbidden.includes(ACCOUNT)) refuse("the target account is in P3A_D1_LIVE_FORBID_ACCOUNTS");

	const listed = await cf("GET", "/accounts?per_page=50");
	const ids = Array.isArray(listed.result)
		? (listed.result as Array<{ id: string }>).map((a) => a.id)
		: null;
	if (listed.ok && ids) {
		if (ids.length !== 1 || ids[0] !== ACCOUNT) {
			refuse(`the token reaches ${ids.length} account(s), expected only the test account`);
		}
		pass("G1 token reach (listing)", `exactly one account: ${redact(ACCOUNT)}`);
	} else {
		info("G1 token reach (listing)", `account listing not permitted (HTTP ${listed.status})`);
	}
	for (const f of forbidden) {
		const probe = await cf("GET", `/accounts/${f}/d1/database?per_page=1`);
		if (probe.ok) refuse(`the token CAN read D1 of forbidden account ${redact(f)}`);
		if (probe.status !== 401 && probe.status !== 403) {
			refuse(
				`forbidden account ${redact(f)} answered HTTP ${probe.status}: not a proof of refusal`,
			);
		}
		pass("G1 token reach (forbidden)", `${redact(f)} refuses it (HTTP ${probe.status})`);
	}

	const dbs = await cf("GET", `/accounts/${ACCOUNT}/d1/database?per_page=100`);
	if (!dbs.ok || !Array.isArray(dbs.result))
		refuse(`cannot list D1 databases (HTTP ${dbs.status})`);
	const names = (dbs.result as Array<{ name: string }>).map((d) => d.name);
	if ((dbs.info?.total_count ?? names.length) > names.length) {
		refuse(`the account holds more databases than one page lists (${dbs.info?.total_count})`);
	}
	if (names.some((n) => !n.startsWith(PREFIX))) refuse("the account holds non-smoke databases");
	pass("G2 dedicated account", `${names.length} database(s), all ${PREFIX}*`);
}

// ── Create / cleanup (every exit path) ─────────────────────────────────────

const targets: Array<{ name: string; id: string; settled: boolean }> = [];
/** Creates a disposable database, tracked for cleanup BEFORE the request leaves. */
async function createDb(suffix: string): Promise<string> {
	if (stopping) throw new Error("stopping: no new database");
	const name = `${PREFIX}v19c-${suffix}-${Date.now()}`;
	const t = { name, id: "", settled: false };
	targets.push(t);
	const r = await cf("POST", `/accounts/${ACCOUNT}/d1/database`, { name }).catch(() => null);
	if (r?.ok) {
		t.id = (r.result as { uuid: string }).uuid;
		t.settled = true;
	} else if (r && r.status >= 400 && r.status < 500) {
		t.settled = true;
		refuse(`database create refused (HTTP ${r.status})`);
	} else {
		t.id = (await findByName(name, 60_000)) ?? refuse("database create outcome unknown");
	}
	const got = await cf("GET", `/accounts/${ACCOUNT}/d1/database/${t.id}`);
	if (!got.ok || (got.result as { name?: string }).name !== name)
		refuse("created database not identified");
	const tables = await q<{ n: number }>(
		"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
		[],
		t.id,
	);
	if (tables[0]?.n !== 0) refuse(`${name} is not empty`);
	pass(`G3/C0 ${suffix} target`, `database ${name} · id ${redact(t.id)} · empty`);
	return t.id;
}

async function findByName(name: string, ms: number): Promise<string | null> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const l = await cf(
			"GET",
			`/accounts/${ACCOUNT}/d1/database?name=${encodeURIComponent(name)}`,
		).catch(() => null);
		const hit = Array.isArray(l?.result)
			? (l.result as Array<{ uuid: string; name: string }>).find((d) => d.name === name)
			: undefined;
		if (hit) return hit.uuid;
		await new Promise((r) => setTimeout(r, 3_000));
	}
	return null;
}

let cleanupPromise: Promise<void> | null = null;
const cleanupOnce = () => {
	cleanupPromise ??= cleanup();
	return cleanupPromise;
};
async function cleanup(): Promise<void> {
	stopping = true;
	for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
	fakeDocker?.close();
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	for (const t of targets) await dropDb(t);
}

async function dropDb(t: { name: string; id: string; settled: boolean }): Promise<void> {
	if (!t.id && !t.settled) t.id = (await findByName(t.name, 60_000)) ?? "";
	if (!t.id) {
		if (!t.settled)
			fail("Z cleanup", `${t.name}: create outcome unknown and not found — CHECK BY HAND`);
		return;
	}
	for (let attempt = 1; attempt <= 3; attempt++) {
		const del = await cf("DELETE", `/accounts/${ACCOUNT}/d1/database/${t.id}`).catch(() => null);
		const after = await cf("GET", `/accounts/${ACCOUNT}/d1/database/${t.id}`).catch(() => null);
		if (after?.status === 404) {
			pass(
				"Z cleanup",
				`${t.name}: DELETE HTTP ${del?.status}; GET afterwards HTTP 404 (attempt ${attempt})`,
			);
			return;
		}
		await new Promise((r) => setTimeout(r, 3_000));
	}
	fail("Z cleanup", `${t.name} still present after 3 attempts — DELETE IT BY HAND`);
}

// ── Builds ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const NODE_MODULES = path.join(REPO, "backend", "node_modules");

function build(label: string, sha: string): { dir: string; sha: string } {
	const full = execFileSync("git", ["-C", REPO, "rev-parse", "--verify", `${sha}^{commit}`], {
		encoding: "utf8",
	}).trim();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `v19c-${label}-`));
	tmpDirs.push(dir);
	const tar = execFileSync(
		"git",
		[
			"-C",
			REPO,
			"archive",
			full,
			"backend/src",
			"backend/tsconfig.json",
			"backend/package.json",
			"backend/package-lock.json",
		],
		{ maxBuffer: 512 * 1024 * 1024 },
	);
	execFileSync("tar", ["-x", "-C", dir], { input: tar });
	const be = path.join(dir, "backend");
	// The symlinked node_modules must be the one this commit's lockfile installs.
	const lock = fs.readFileSync(path.join(be, "package-lock.json"));
	if (!lock.equals(fs.readFileSync(path.join(REPO, "backend", "package-lock.json")))) {
		refuse(`${label}: its package-lock.json differs from the installed node_modules`);
	}
	fs.symlinkSync(NODE_MODULES, path.join(be, "node_modules"));
	execFileSync(path.join(be, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: be });
	const files = execFileSync("find", ["dist", "-type", "f", "-name", "*.js"], {
		cwd: be,
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const lines = files
		.map(
			(f) =>
				`${createHash("sha256")
					.update(fs.readFileSync(path.join(be, f)))
					.digest("hex")}  ${f}\n`,
		)
		.join("");
	const digest = createHash("sha256").update(lines).digest("hex");
	info(
		`B ${label} build`,
		`${full} · dist/**/*.js ${digest.slice(0, 16)}… (${files.length} files)`,
	);
	return { dir: be, sha: full };
}

// ── Child processes ────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
/** Set first thing by cleanup: nothing new may start (no child, no database) once it is. */
let stopping = false;
function track(c: ChildProcess): ChildProcess {
	children.push(c);
	// An 'error' without a listener would be an uncaught exception that skips cleanup.
	c.on("error", () => {});
	if (stopping) c.kill("SIGKILL");
	return c;
}
const baseEnv = (): NodeJS.ProcessEnv => ({
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
	CLOUDFLARE_API_TOKEN: TOKEN,
	D1_DATABASE_ID: dbId,
	...(PRELOAD
		? { FAKE_STATE_DIR: process.env.FAKE_STATE_DIR, FAKE_ACCOUNTS: process.env.FAKE_ACCOUNTS }
		: {}),
});
const nodeArgs = (args: string[]) => (PRELOAD ? ["--require", PRELOAD, ...args] : args);

function runNode(
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string }> {
	if (stopping) return Promise.reject(new Error("stopping: no new child"));
	return new Promise((resolve) => {
		const c = spawn(process.execPath, nodeArgs(args), {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		track(c);
		let out = "";
		c.stdout?.on("data", (b) => (out += b));
		c.stderr?.on("data", (b) => (out += b));
		c.on("close", (code) => resolve({ code, out: mask(out) }));
	});
}

async function migrate(label: string, be: string): Promise<string> {
	const r = await runNode(
		be,
		[
			"-e",
			"require('./dist/db.js').migrateDb().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })",
		],
		baseEnv(),
	);
	raw.push(`── ${label} migrateDb (exit ${r.code}) ──\n${r.out.trim()}`);
	if (r.code !== 0) throw new Error(`${label} migrateDb exited ${r.code}`);
	return r.out;
}

// ── Fake Docker daemon: nothing exists ─────────────────────────────────────

let fakeDocker: http.Server | null = null;
const dockerCalls = new Map<string, number>();
async function startFakeDocker(): Promise<string> {
	fakeDocker = http.createServer((req, res) => {
		const key = `${req.method} ${(req.url ?? "").replace(/\?.*$/, "").replace(/\/v[0-9.]+\//, "/")}`;
		dockerCalls.set(key, (dockerCalls.get(key) ?? 0) + 1);
		req.resume();
		res.setHeader("Content-Type", "application/json");
		const url = req.url ?? "";
		if (/\/_ping$/.test(url)) return void res.end("OK");
		if (/\/version$/.test(url))
			return void res.end(JSON.stringify({ ApiVersion: "1.43", Version: "fake" }));
		if (/\/(containers|images)\/json(\?|$)/.test(url)) return void res.end("[]");
		res.statusCode = 404;
		res.end(JSON.stringify({ message: "No such object (fake daemon)" }));
	});
	await new Promise<void>((r) => fakeDocker?.listen(0, "127.0.0.1", r));
	return `tcp://127.0.0.1:${(fakeDocker.address() as AddressInfo).port}`;
}

// ── Backend under test ─────────────────────────────────────────────────────

type Backend = { url: string; proc: ChildProcess; log: () => string; stop: () => Promise<void> };
async function startBackend(label: string, be: string, extra: NodeJS.ProcessEnv): Promise<Backend> {
	if (stopping) throw new Error("stopping: no new backend");
	const port = await new Promise<number>((r) => {
		const s = http.createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as AddressInfo).port;
			s.close(() => r(p));
		});
	});
	const env = { ...baseEnv(), ...shared.backendEnv, PORT: String(port), ...extra };
	const proc = spawn(process.execPath, nodeArgs(["dist/index.js"]), {
		cwd: be,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	track(proc);
	let out = "";
	proc.stdout?.on("data", (b) => (out += b));
	proc.stderr?.on("data", (b) => (out += b));
	const url = `http://127.0.0.1:${port}`;
	const until = Date.now() + 90_000;
	while (Date.now() < until) {
		if (proc.exitCode !== null)
			throw new Error(`${label} exited ${proc.exitCode} during boot:\n${mask(out)}`);
		const ok = await fetch(`${url}/health`)
			.then((r) => r.ok)
			.catch(() => false);
		if (ok) break;
		await new Promise((r) => setTimeout(r, 500));
	}
	const stop = async () => {
		if (proc.exitCode !== null) return;
		proc.kill("SIGTERM");
		await new Promise<void>((r) => {
			const t = setTimeout(() => {
				proc.kill("SIGKILL");
				r();
			}, 20_000);
			proc.on("close", () => {
				clearTimeout(t);
				r();
			});
		});
		raw.push(`── ${label} log (masked) ──\n${mask(out).trim()}`);
	};
	return { url, proc, log: () => mask(out), stop };
}

async function http_(
	b: Backend,
	method: string,
	p: string,
	body?: unknown,
	cookie?: string,
): Promise<{ status: number; json: unknown; text: string; setCookie: string | null }> {
	const res = await fetch(`${b.url}${p}`, {
		method,
		headers: {
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(cookie ? { Cookie: cookie } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") };
}

async function login(b: Backend): Promise<string> {
	const r = await http_(b, "POST", "/api/auth/login", {
		username: "v19c-admin",
		password: shared.password,
	});
	const m = /st_token=[^;]+/.exec(r.setCookie ?? "");
	if (r.status !== 200 || !m) throw new Error(`login failed: HTTP ${r.status}`);
	return m[0];
}

// ── Representative v18 data ────────────────────────────────────────────────

const shared = {
	password: randomBytes(18).toString("base64url"),
	backendEnv: {} as NodeJS.ProcessEnv,
	ids: {} as Record<string, string>,
	workspace: "",
};

async function seed(): Promise<void> {
	const bcrypt = (await import(path.join(NODE_MODULES, "bcryptjs", "index.js"))) as {
		default?: { hash: (p: string, r: number) => Promise<string> };
		hash?: (p: string, r: number) => Promise<string>;
	};
	const hash = await (bcrypt.default?.hash ?? bcrypt.hash)?.(shared.password, 10);
	const id = (k: string) => {
		shared.ids[k] = randomUUID();
		return shared.ids[k];
	};
	const admin = id("admin");
	const bob = id("bob");
	await q(
		"INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, 'v19c-admin', ?, 1)",
		[admin, hash],
	);
	await q(
		"INSERT INTO users (id, username, password_hash, is_admin, max_sessions, max_total_cpu) VALUES (?, 'v19c-bob', ?, 0, 3, 4000000000)",
		[bob, hash],
	);
	const group = id("group");
	await q(
		"INSERT INTO user_groups (id, name, description, lead_user_id) VALUES (?, 'v19c group', 'qa', ?)",
		[group, admin],
	);
	await q("INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?)", [group, bob]);
	await q(
		"INSERT INTO invite_codes (code_hash, code_prefix, created_by, expires_at) VALUES (?, 'abcd', ?, '2099-01-01 00:00:00')",
		[createHash("sha256").update(randomBytes(16).toString("hex")).digest("hex"), admin],
	);
	await q(
		"INSERT INTO invite_codes (code_hash, code_prefix, created_by, used_by, used_at) VALUES (?, 'efgh', ?, ?, datetime('now'))",
		[createHash("sha256").update(randomBytes(16).toString("hex")).digest("hex"), admin, bob],
	);
	await q(
		"INSERT INTO templates (id, owner_user_id, name, description, config) VALUES (?, ?, 'v19c tpl', 'qa', ?)",
		[id("template"), bob, JSON.stringify({ envVars: [{ name: "A", type: "plain", value: "1" }] })],
	);
	await q(
		"INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, 'https://push.invalid/v19c', 'p', 'a')",
		[id("push"), admin],
	);
	// running (its container is gone: reconcile flips it), stopped, terminated, failed,
	// plus three stopped sessions the scenario acts on.
	const sessions: Array<[string, string, string, string | null]> = [
		[
			"running",
			admin,
			"running",
			"c0ffee0000000000000000000000000000000000000000000000000000000001",
		],
		["stopped", admin, "stopped", null],
		["terminated", admin, "terminated", null],
		["failed", bob, "failed", null],
		["soft", admin, "stopped", null],
		["hard", admin, "stopped", null],
		["bind", admin, "stopped", null],
	];
	for (const [k, owner, status, container] of sessions) {
		const sid = id(`s-${k}`);
		await q(
			"INSERT INTO sessions (session_id, user_id, name, status, container_id, container_name, env_vars, external_ref, conversation_requested) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				sid,
				owner,
				`v19c ${k}`,
				status,
				container,
				`st-${sid.slice(0, 12)}`,
				JSON.stringify({ K: k }),
				`ref-${k}`,
				k === "stopped" ? 1 : 0,
			],
		);
		await q(
			"INSERT INTO session_configs (session_id, cpu_limit, mem_limit, idle_ttl_seconds, ports_json, env_vars_json, bootstrapped_at) VALUES (?, 2000000000, 2147483648, 3600, ?, '[]', datetime('now'))",
			[sid, JSON.stringify([{ port: 3000, public: false }])],
		);
		fs.mkdirSync(path.join(shared.workspace, sid), { recursive: true });
		fs.writeFileSync(path.join(shared.workspace, sid, "README.md"), `v19c ${k}\n`);
	}
	await q(
		"INSERT INTO sessions_port_mappings (session_id, container_port, host_port, is_public) VALUES (?, 3000, 3000, 0)",
		[shared.ids["s-running"]],
	);
	await q(
		"INSERT INTO session_observe_log (id, observer_user_id, session_id, owner_user_id, mode) VALUES (?, ?, ?, ?, 'observe')",
		[id("observe"), admin, shared.ids["s-failed"], bob],
	);
	const cid = id("conversation");
	await q(
		`INSERT INTO claude_conversations (session_id, st_session_id, kind, title, status, status_evidence, status_at, started_at, ended_at, end_reason, last_event_at, last_seq, events_count)
		 VALUES (?, ?, 'interactive', 'v19c conversation', 'ended', 'hook', datetime('now'), datetime('now'), datetime('now'), 'exit', datetime('now'), 3, 3)`,
		[cid, shared.ids["s-stopped"]],
	);
	await q(
		"INSERT INTO conversation_user_meta (st_session_id, cid, custom_title, updated_at) VALUES (?, ?, 'seeded title', datetime('now'))",
		[shared.ids["s-stopped"], cid],
	);
}

// ── Snapshot of the whole database ─────────────────────────────────────────

type Snapshot = {
	master: Map<string, string>; // "type name" → sha256(tbl_name + sql)
	tables: Map<string, { count: number; digest: string }>;
	ledger: Array<{ version: number; description: string }>;
};
async function snapshot(): Promise<Snapshot> {
	const master = new Map<string, string>();
	const objs = await q<{ type: string; name: string; tbl_name: string; sql: string | null }>(
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' ORDER BY type, name",
	);
	for (const o of objs) {
		master.set(
			`${o.type} ${o.name}`,
			createHash("sha256")
				.update(`${o.tbl_name}\n${o.sql ?? ""}`)
				.digest("hex"),
		);
	}
	const tables = new Map<string, { count: number; digest: string }>();
	for (const o of objs.filter((x) => x.type === "table" && !x.name.startsWith("sqlite_"))) {
		// rowid order: no migration rebuilds these tables, so rowids are stable.
		const rows = await q(`SELECT * FROM "${o.name}" ORDER BY rowid`);
		tables.set(o.name, {
			count: rows.length,
			digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
		});
	}
	const ledger = await q<{ version: number; description: string }>(
		"SELECT version, description FROM schema_migrations ORDER BY version",
	);
	return { master, tables, ledger };
}
const tableLine = (s: Snapshot) =>
	[...s.tables].map(([t, v]) => `${t}=${v.count}/${v.digest.slice(0, 12)}`).join(" ");

// ── Main ───────────────────────────────────────────────────────────────────

let interrupted = 0;
let signals = 0;
async function main(): Promise<void> {
	const mainSha = process.env.V19C_MAIN_SHA ?? refuse("V19C_MAIN_SHA unset");
	const prSha = process.env.V19C_PR_SHA ?? refuse("V19C_PR_SHA unset");
	await identifyTarget();
	const v18 = build("main", mainSha);
	const v19 = build("pr", prSha);
	info(
		"B toolchain",
		`node ${process.version} · npm ${execFileSync("npm", ["-v"], { encoding: "utf8" }).trim()}`,
	);
	dbId = await createDb("main");

	shared.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v19c-ws-"));
	tmpDirs.push(shared.workspace);
	const dockerHost = await startFakeDocker();
	shared.backendEnv = {
		NODE_ENV: "development",
		WORKSPACE_ROOT: shared.workspace,
		DOCKER_HOST: dockerHost,
		JWT_SECRET: randomBytes(32).toString("hex"),
		SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
	};

	// ── Scenario 1 ──
	await migrate("main", v18.dir);
	const l18 = await q<{ v: number; n: number }>(
		"SELECT MAX(version) AS v, COUNT(*) AS n FROM schema_migrations",
	);
	verdict(
		"S1.1 main ledger",
		l18[0]?.v === 18 && l18[0]?.n === 18,
		`max ${l18[0]?.v}, rows ${l18[0]?.n}`,
	);
	await seed();

	// Baseline: the same v18 backend on the v18 database (its boot reconcile
	// settles the gone container first), so scenario 2 compares like with like.
	const b0 = await startBackend("main backend on v18 (baseline)", v18.dir, {});
	const c0 = await login(b0);
	const base = {
		status: (await http_(b0, "GET", "/api/auth/status", undefined, c0)).text,
		list: (await http_(b0, "GET", "/api/sessions", undefined, c0)).text,
		one: (await http_(b0, "GET", `/api/sessions/${shared.ids["s-stopped"]}`, undefined, c0)).text,
	};
	await b0.stop();
	// b0's boot reconcile stopped the seeded running session (its container is
	// gone) and cleared its port mapping. Put a running session with a mapping
	// back, owned by bob — GET /api/sessions is per user, so admin's baseline
	// is unaffected — so v19 migrates over every status and a non-empty mapping.
	const runningBob = randomUUID();
	shared.ids["s-running-bob"] = runningBob;
	await q(
		"INSERT INTO sessions (session_id, user_id, name, status, container_id, container_name, env_vars) VALUES (?, ?, 'v19c running', 'running', ?, ?, '{}')",
		[runningBob, shared.ids.bob, `c0ffee${"0".repeat(57)}2`, `st-${runningBob.slice(0, 12)}`],
	);
	await q("INSERT INTO session_configs (session_id, ports_json) VALUES (?, ?)", [
		runningBob,
		JSON.stringify([{ port: 8080, public: true }]),
	]);
	await q(
		"INSERT INTO sessions_port_mappings (session_id, container_port, host_port, is_public) VALUES (?, 8080, 8080, 1)",
		[runningBob],
	);

	const before = await snapshot();
	const statuses = await q<{ status: string }>(
		"SELECT DISTINCT status FROM sessions ORDER BY status",
	);
	const statusSet = statuses.map((r) => r.status);
	verdict(
		"S1.2 representative data at migration time",
		["failed", "running", "stopped", "terminated"].every((x) => statusSet.includes(x)) &&
			(before.tables.get("sessions_port_mappings")?.count ?? 0) >= 1,
		`session statuses ${statusSet.join(",")}; port mappings ${before.tables.get("sessions_port_mappings")?.count}`,
	);
	info("S1.2 before (table=count/digest)", tableLine(before));
	await migrate("pr", v19.dir);
	const after = await snapshot();
	info("S1.4 after (table=count/digest)", tableLine(after));

	const newLedger = after.ledger.filter((r) => !before.ledger.some((b) => b.version === r.version));
	verdict(
		"S1.4 ledger +19 only",
		newLedger.length === 1 &&
			newLedger[0]?.version === 19 &&
			after.ledger.length === before.ledger.length + 1,
		JSON.stringify(newLedger),
	);
	const added = [...after.master.keys()].filter((k) => !before.master.has(k)).sort();
	const removed = [...before.master.keys()].filter((k) => !after.master.has(k));
	const changed = [...before.master.keys()].filter(
		(k) => after.master.has(k) && after.master.get(k) !== before.master.get(k),
	);
	const NEW_TABLES = ["agent_bindings", "project_agent_creations", "project_agents", "projects"];
	const expected = [
		...NEW_TABLES.map((t) => `table ${t}`),
		"index idx_agent_bindings_live_agent",
		"index idx_agent_bindings_live_session",
		"index idx_projects_request",
		"trigger trg_project_agent_creation",
		"trigger trg_project_agent_removed",
	].sort();
	// SQLite's own indexes for PRIMARY KEY/UNIQUE on the new tables (no SQL).
	const auto = added.filter((k) => /^index sqlite_autoindex_/.test(k));
	const autoOnNew = auto.every((k) =>
		NEW_TABLES.some((t) => k.startsWith(`index sqlite_autoindex_${t}_`)),
	);
	const explicit = added.filter((k) => !auto.includes(k));
	verdict(
		"S1.4 sqlite_master: exactly the v19 objects added",
		JSON.stringify(explicit) === JSON.stringify(expected) && autoOnNew,
		`added ${JSON.stringify(explicit)}; autoindexes ${JSON.stringify(auto)}`,
	);
	const trig = await q<{ name: string; tbl_name: string }>(
		"SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
	);
	verdict(
		"S1.4 triggers on new tables only",
		trig.length === 2 && trig.every((t) => NEW_TABLES.includes(t.tbl_name)),
		JSON.stringify(trig),
	);
	verdict(
		"S1.4 nothing removed or changed in sqlite_master",
		removed.length === 0 && changed.length === 0,
		JSON.stringify({ removed, changed }),
	);
	const diffs: string[] = [];
	for (const [t, v] of before.tables) {
		const a = after.tables.get(t);
		if (t === "schema_migrations") continue;
		if (!a || a.count !== v.count || a.digest !== v.digest) diffs.push(t);
	}
	const led18 =
		JSON.stringify(after.ledger.filter((r) => r.version <= 18)) === JSON.stringify(before.ledger);
	verdict(
		"S1.4 every pre-existing table identical (count + digest)",
		diffs.length === 0 && led18,
		diffs.length === 0
			? `${before.tables.size - 1} tables identical; ledger rows 1–18 identical: ${led18}`
			: `differ: ${diffs.join(", ")}`,
	);
	const again = await migrate("pr (re-run)", v19.dir);
	const after2 = await snapshot();
	verdict(
		"S1.5 re-run is a no-op",
		/schema up to date/.test(again) &&
			!/applying migration/.test(again) &&
			tableLine(after2) === tableLine(after) &&
			JSON.stringify([...after2.master]) === JSON.stringify([...after.master]),
		"'schema up to date', snapshot identical",
	);

	// ── Scenario 2: the v18 backend on the v19 database ──
	const b1 = await startBackend("main backend on v19 (rollback)", v18.dir, {});
	verdict(
		"S2.1 boot",
		/migrations complete \(schema up to date\)/.test(b1.log()) &&
			!/applying migration/.test(b1.log()),
		"'schema up to date', nothing applied",
	);
	const health = await http_(b1, "GET", "/health");
	verdict(
		"S2.2 /health",
		health.status === 200 && (health.json as { ok?: boolean })?.ok === true,
		`HTTP ${health.status}`,
	);
	const c1 = await login(b1);
	pass("S2.3 login", "HTTP 200, st_token set");
	const st = await http_(b1, "GET", "/api/auth/status", undefined, c1);
	verdict(
		"S2.2 /api/auth/status identical to v18",
		st.status === 200 && st.text === base.status,
		`HTTP ${st.status}`,
	);
	const list = await http_(b1, "GET", "/api/sessions", undefined, c1);
	verdict(
		"S2.3 GET /api/sessions identical to v18",
		list.status === 200 && list.text === base.list,
		`HTTP ${list.status}`,
	);
	const one = await http_(b1, "GET", `/api/sessions/${shared.ids["s-stopped"]}`, undefined, c1);
	verdict(
		"S2.3 GET /api/sessions/:id identical to v18",
		one.status === 200 && one.text === base.one,
		`HTTP ${one.status}`,
	);
	const ext = await http_(
		b1,
		"PATCH",
		`/api/sessions/${shared.ids["s-stopped"]}`,
		{ externalRef: "v19c-patched" },
		c1,
	);
	const extRow = await q<{ external_ref: string }>(
		"SELECT external_ref FROM sessions WHERE session_id = ?",
		[shared.ids["s-stopped"]],
	);
	verdict(
		"S2.3 PATCH externalRef",
		ext.status === 200 && extRow[0]?.external_ref === "v19c-patched",
		`HTTP ${ext.status}`,
	);
	const meta = await http_(
		b1,
		"PATCH",
		`/api/sessions/${shared.ids["s-stopped"]}/conversations/${shared.ids.conversation}`,
		{ title: "renamed by v18", archived: true },
		c1,
	);
	const metaRow = await q<{ custom_title: string; archived_at: string | null }>(
		"SELECT custom_title, archived_at FROM conversation_user_meta WHERE st_session_id = ? AND cid = ?",
		[shared.ids["s-stopped"], shared.ids.conversation],
	);
	verdict(
		"S2.3 PATCH conversation meta (rename + archive)",
		meta.status === 200 &&
			metaRow[0]?.custom_title === "renamed by v18" &&
			metaRow[0]?.archived_at !== null,
		`HTTP ${meta.status}`,
	);
	const nBefore = await q<{ n: number }>("SELECT COUNT(*) AS n FROM sessions");
	const create = await http_(b1, "POST", "/api/sessions", { name: "v19c create" }, c1);
	const nAfter = await q<{ n: number }>("SELECT COUNT(*) AS n FROM sessions");
	verdict(
		"S2.3 failing create rolls back (fake daemon has no image)",
		create.status >= 500 && nAfter[0]?.n === nBefore[0]?.n,
		`HTTP ${create.status} ${mask(create.text).slice(0, 160)}; sessions ${nBefore[0]?.n} → ${nAfter[0]?.n}`,
	);
	const soft = await http_(b1, "DELETE", `/api/sessions/${shared.ids["s-soft"]}`, undefined, c1);
	const softRow = await q<{ status: string }>("SELECT status FROM sessions WHERE session_id = ?", [
		shared.ids["s-soft"],
	]);
	verdict(
		"S2.3 soft delete",
		soft.status === 204 && softRow[0]?.status === "terminated",
		`HTTP ${soft.status} → ${softRow[0]?.status}`,
	);
	const hard = await http_(
		b1,
		"DELETE",
		`/api/sessions/${shared.ids["s-hard"]}?hard=true`,
		undefined,
		c1,
	);
	const hardRows = await q<{ n: number }>(
		"SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?",
		[shared.ids["s-hard"]],
	);
	const hardDir = fs.existsSync(path.join(shared.workspace, shared.ids["s-hard"]));
	verdict(
		"S2.3 hard delete (row dropped, workspace purged)",
		hard.status === 204 && hardRows[0]?.n === 0 && !hardDir,
		`HTTP ${hard.status}; row ${hardRows[0]?.n}; dir ${hardDir ? "present" : "gone"}`,
	);
	info(
		"S2.3 fail path (failSession / markFailed)",
		"not exercised here: a bootstrap failure needs a running container. v18's failSession writes only sessions.status; #557's markFailed is C11 of d1Live.smoke.ts on real D1",
	);
	const bk18 = await runNode(
		v18.dir,
		["dist/backup.js", "backup", path.join(shared.workspace, ".backups", "v18")],
		{
			...baseEnv(),
			...shared.backendEnv,
		},
	);
	raw.push(`── main backup (exit ${bk18.code}) ──\n${bk18.out.trim()}`);
	const atBackup = await q<{ n: number }>("SELECT COUNT(*) AS n FROM sessions");
	const files18 = fs.existsSync(path.join(shared.workspace, ".backups", "v18"))
		? fs.readdirSync(path.join(shared.workspace, ".backups", "v18")).sort()
		: [];
	const v19In18 = NEW_TABLES.filter((t) => files18.includes(`${t}.jsonl`));
	verdict(
		"S2.4 main backup runs",
		bk18.code === 0 && files18.includes("manifest.json"),
		`exit ${bk18.code}; files ${files18.join(" ")}`,
	);
	info(
		"S2.4 main backup and the v19 tables",
		`v19 tables in it: ${v19In18.length === 0 ? "none (expected: v18 does not know them)" : v19In18.join(", ")}. A restore of this backup on a fresh target runs #557's migrateDb first, so the four tables exist EMPTY — any directory rows (only possible after the flag was on) are lost; with the flag never on (case A) nothing is lost`,
	);
	await b1.stop();

	// ── Roll forward: #557 on the same database ──
	const b2 = await startBackend("pr backend, flag on (roll forward)", v19.dir, {
		PROJECT_CHAT_ENABLED: "true",
	});
	verdict(
		"S2.5 boot",
		/migrations complete \(schema up to date\)/.test(b2.log()) &&
			!/applying migration/.test(b2.log()),
		"'schema up to date'",
	);
	const c2 = await login(b2);
	const st2 = await http_(b2, "GET", "/api/auth/status", undefined, c2);
	verdict(
		"S2.5 features.projectChat",
		(st2.json as { features?: { projectChat?: boolean } })?.features?.projectChat === true,
		`HTTP ${st2.status}`,
	);
	const p0 = await http_(b2, "GET", "/api/projects", undefined, c2);
	verdict(
		"S2.5 GET /api/projects",
		p0.status === 200,
		`HTTP ${p0.status} ${p0.text.slice(0, 120)}`,
	);
	const pc = await http_(
		b2,
		"POST",
		"/api/projects",
		{ name: "v19c project", clientRequestId: randomUUID() },
		c2,
	);
	const pid = (pc.json as { projectId?: string })?.projectId ?? "";
	verdict("S2.5 POST /api/projects", pc.status === 201 && !!pid, `HTTP ${pc.status}`);
	const ac = await http_(
		b2,
		"POST",
		`/api/projects/${pid}/agents`,
		{ handle: "qa", sessionId: shared.ids["s-bind"], clientRequestId: randomUUID() },
		c2,
	);
	verdict(
		"S2.5 POST agent bound to a pre-existing session",
		ac.status === 201,
		`HTTP ${ac.status} ${mask(ac.text).slice(0, 160)}`,
	);
	const al = await http_(b2, "GET", `/api/projects/${pid}/agents`, undefined, c2);
	const agents =
		(al.json as { agents?: Array<{ binding?: { sessionId?: string } }> })?.agents ?? [];
	verdict(
		"S2.5 GET agents",
		al.status === 200 &&
			agents.length === 1 &&
			agents[0]?.binding?.sessionId === shared.ids["s-bind"],
		`HTTP ${al.status}, ${agents.length} agent(s)`,
	);
	const sl = await http_(b2, "GET", "/api/sessions", undefined, c2);
	const rows = (sl.json as Array<{ sessionId: string; binding?: unknown }>) ?? [];
	const bound = rows.find((r) => r.sessionId === shared.ids["s-bind"]);
	const unbound = rows.find((r) => r.sessionId === shared.ids["s-stopped"]);
	verdict(
		"S2.5 GET /api/sessions binding",
		sl.status === 200 && !!bound?.binding && unbound?.binding === null,
		`bound: ${bound?.binding ? "object" : String(bound?.binding)}, unbound: ${String(unbound?.binding)}`,
	);
	const guard = await http_(
		b2,
		"DELETE",
		`/api/sessions/${shared.ids["s-bind"]}?hard=true`,
		undefined,
		c2,
	);
	verdict(
		"S2.5 hard delete of a bound session refused",
		guard.status === 409 && (guard.json as { error?: string })?.error === "agent-active",
		`HTTP ${guard.status} ${guard.text.slice(0, 80)}`,
	);
	const bk19 = await runNode(
		v19.dir,
		["dist/backup.js", "backup", path.join(shared.workspace, ".backups", "v19")],
		{
			...baseEnv(),
			...shared.backendEnv,
		},
	);
	raw.push(`── pr backup (exit ${bk19.code}) ──\n${bk19.out.trim()}`);
	const dir19 = path.join(shared.workspace, ".backups", "v19");
	const files19 = fs.existsSync(dir19) ? fs.readdirSync(dir19) : [];
	const counts19 = NEW_TABLES.map((t) => {
		const f = path.join(dir19, `${t}.jsonl`);
		return `${t}=${fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length : "missing"}`;
	});
	verdict(
		"S2.6 pr backup has the four tables",
		bk19.code === 0 && NEW_TABLES.every((t) => files19.includes(`${t}.jsonl`)),
		counts19.join(" "),
	);
	await b2.stop();
	// ── S2.7: main's backup (taken on the v19 database) restored on a fresh D1 ──
	const manifest18 = JSON.parse(
		fs.readFileSync(path.join(shared.workspace, ".backups", "v18", "manifest.json"), "utf8"),
	) as { schemaVersion?: number };
	info(
		"S2.7 main backup manifest",
		`schemaVersion ${manifest18.schemaVersion} (the ledger's maximum)`,
	);
	const restoreDb = await createDb("restore");
	const restoreWs = fs.mkdtempSync(path.join(os.tmpdir(), "v19c-restore-ws-"));
	tmpDirs.push(restoreWs);
	const restoreEnv = {
		...baseEnv(),
		...shared.backendEnv,
		D1_DATABASE_ID: restoreDb,
		WORKSPACE_ROOT: restoreWs,
	};
	const backupDir = path.join(shared.workspace, ".backups", "v18");
	const rs18 = await runNode(v18.dir, ["dist/backup.js", "restore", backupDir], restoreEnv);
	raw.push(`── main restore of main backup (exit ${rs18.code}) ──\n${rs18.out.trim()}`);
	const users18 = await q<{ n: number }>("SELECT COUNT(*) AS n FROM users", [], restoreDb);
	verdict(
		"S2.7 main restore refuses its own post-rollback backup",
		rs18.code !== 0 && /NEWER than this code's v18/.test(rs18.out) && users18[0]?.n === 0,
		`exit ${rs18.code}; users on target ${users18[0]?.n}`,
	);
	// #557's restore on a FRESH database (main's refusal above already left a
	// v18 schema on the first one).
	const restoreDb2 = await createDb("restore2");
	const rs19 = await runNode(v19.dir, ["dist/backup.js", "restore", backupDir], {
		...restoreEnv,
		D1_DATABASE_ID: restoreDb2,
	});
	raw.push(`── pr restore of main backup (exit ${rs19.code}) ──\n${rs19.out.trim()}`);
	const warned = NEW_TABLES.filter((t) =>
		new RegExp(`\\[restore\\] ${t}: no ${t}\\.jsonl although the backup is schema v19`).test(
			rs19.out,
		),
	);
	const restored = await q<{ u: number; s: number; m: number }>(
		"SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM sessions) AS s, (SELECT MAX(version) FROM schema_migrations) AS m",
		[],
		restoreDb2,
	);
	verdict(
		"S2.7 pr restores it and warns for the four tables",
		rs19.code === 0 &&
			warned.length === NEW_TABLES.length &&
			restored[0]?.u === 2 &&
			restored[0]?.s === atBackup[0]?.n &&
			restored[0]?.m === 19,
		`exit ${rs19.code}; WARN for ${warned.join(", ") || "none"}; target users ${restored[0]?.u}, sessions ${restored[0]?.s} (source at backup ${atBackup[0]?.n}), ledger max ${restored[0]?.m}`,
	);
	info("S2 fake Docker calls", JSON.stringify(Object.fromEntries(dockerCalls)));
}

function report(result: string): void {
	const line = (c: Check) =>
		`${c.ok === true ? "PASS" : c.ok === false ? "FAIL" : "INFO"}  ${c.id} — ${mask(c.detail)}`;
	console.log(PRELOAD ? "!! DRY RUN against the emulator, not Cloudflare !!" : "");
	console.log("── MANDATORY ──");
	for (const c of checks.filter((x) => x.ok !== null)) console.log(line(c));
	console.log("── INFORMATIVE ──");
	for (const c of checks.filter((x) => x.ok === null)) console.log(line(c));
	if (process.env.V19C_RAW === "1") for (const r of raw) console.log(mask(r));
	console.log(`RESULT: ${result}`);
}

const onSignal = (sig: NodeJS.Signals) => {
	interrupted = sig === "SIGINT" ? 130 : 143;
	// Count signals: a cleanup already running (the normal end of the run) is
	// joined by the first one, never abandoned by it.
	if (++signals > 1) {
		console.error(
			"second signal: CLEANUP ABANDONED — check the account for st-p3a-smoke-v19c-* by hand",
		);
		process.exit(interrupted);
	}
	console.error("interrupted: cleaning up (signal again to abandon)");
	void cleanupOnce().then(() => {
		report("INTERRUPTED");
		process.exit(interrupted);
	});
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const onCrash = (e: unknown) => {
	if (interrupted) return;
	interrupted = 1;
	fail("X crashed", mask(String((e as Error)?.stack ?? e)).slice(0, 2000));
	void cleanupOnce().then(() => {
		report("FAIL");
		process.exit(1);
	});
};
process.on("uncaughtException", onCrash);
process.on("unhandledRejection", onCrash);

main()
	.then(
		() => null,
		(e: unknown) => e,
	)
	.then(async (err) => {
		if (interrupted) return;
		await cleanupOnce();
		if (interrupted) return;
		if (err instanceof Refused) {
			report(`REFUSED — ${err.message}`);
			process.exit(2);
		}
		if (err) fail("X aborted", mask((err as Error).stack ?? String(err)).slice(0, 2000));
		const failed = checks.some((c) => c.ok === false);
		report(failed ? "FAIL" : "PASS");
		process.exit(failed ? 1 : 0);
	});
