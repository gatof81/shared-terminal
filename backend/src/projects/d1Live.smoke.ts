/**
 * d1Live.smoke.ts — P3a's D1 assumptions (PROJECTS.md §2–§3, §6) against a
 * REAL Cloudflare D1, through the backend's own code: `migrateDb()`,
 * `d1Query()` (the REST `/query` endpoint, one statement per call), the real
 * `ProjectDirectory`, `SessionManager.markFailed` and the hard-delete guard.
 * The SQLite suite (directory.sqlite.test.ts) proves the logic; this proves
 * that D1 itself stores and fires the triggers (cloudflare/workers-sdk#15314
 * is a trigger/BEGIN parsing bug elsewhere in Cloudflare's stack), raises
 * with the texts the classifier reads, and answers a refusal in a shape
 * `isD1Envelope` recognises.
 *
 * Run it only against a DEDICATED test account (never the production one):
 *
 *   cd backend && npx tsx --env-file=<file outside the repo, mode 600> src/projects/d1Live.smoke.ts
 *
 *   CLOUDFLARE_ACCOUNT_ID=<test account>   CLOUDFLARE_API_TOKEN=<D1:Edit on that account only>
 *   P3A_D1_LIVE_EXPECT_ACCOUNT=<same test account id, typed twice on purpose>
 *   P3A_D1_LIVE_FORBID_ACCOUNTS=<production account id[,…]>   (the token must NOT reach them)
 *   P3A_D1_LIVE_CREATE=1   — create a fresh `st-p3a-smoke-<ms>` database, run, delete it, prove it gone
 *   (or D1_DATABASE_ID + P3A_D1_LIVE_CONFIRM=<same id> + P3A_D1_LIVE_EXPECT_NAME=<its name>)
 *
 * Before ANY statement, the target is identified and refused unless every
 * guard holds (G1–G4 below): the token reaches the expected account and none
 * of the forbidden ones, every database already in that account is a smoke
 * database (`st-p3a-smoke-` prefix: the account is dedicated), and the target's
 * id AND name are the expected ones. The empty-database check (C0) is kept as
 * one more guard, not the only one. Nothing prints the token. Checks are
 * MANDATORY (PASS/FAIL, they decide the result) or DIAGNOSTIC (recorded,
 * never gate — e.g. the CRLF probe and the raw refusal envelopes). Exits 1 on
 * any mandatory FAIL, 2 on a refused target. Not a vitest test, not built.
 */

import { randomUUID } from "node:crypto";

// ok: true/false = mandatory PASS/FAIL; null = diagnostic (recorded, never gates).
type Check = { id: string; ok: boolean | null; detail: string };
const checks: Check[] = [];
const pass = (id: string, detail: string) => checks.push({ id, ok: true, detail });
const fail = (id: string, detail: string) => checks.push({ id, ok: false, detail });
const info = (id: string, detail: string) => checks.push({ id, ok: null, detail });
const verdict = (id: string, ok: boolean, detail: string) => (ok ? pass : fail)(id, detail);

// ── Raw HTTP evidence: every D1 answer's status and envelope ───────────────

const realFetch = globalThis.fetch;
/** The last REFUSAL D1 sent (success: false): a refusal is followed by read-backs. */
let lastAnswer: { status: number; body: string } | null = null;
/** One-shot: the next statement matching runs on D1, then its answer is "lost". */
let loseAnswerOf: RegExp | null = null;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
	const res = await realFetch(url, init);
	if (!String(url).includes("/d1/database/")) return res;
	const body = await res.text();
	try {
		if ((JSON.parse(body) as { success?: unknown }).success === false) {
			lastAnswer = { status: res.status, body };
		}
	} catch {
		lastAnswer = { status: res.status, body };
	}
	const sql = (JSON.parse(String(init?.body ?? "{}")) as { sql?: string }).sql ?? "";
	if (loseAnswerOf?.test(sql)) {
		loseAnswerOf = null;
		throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
	}
	return new Response(body, { status: res.status, headers: res.headers });
}) as typeof fetch;

// ── Target identity (G1–G4), before any SQL ────────────────────────────────

const API = "https://api.cloudflare.com/client/v4";
const PREFIX = "st-p3a-smoke-";
const redact = (id: string) => `${id.slice(0, 6)}…`;
let created: { account: string; id: string } | null = null;

/** A refused target: thrown (not process.exit) so a database this run created is still deleted. */
class Refused extends Error {}
function refuse(why: string): never {
	throw new Refused(why);
}

async function cf(method: string, path: string, body?: unknown) {
	const res = await realFetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? ""}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	const json = (await res.json().catch(() => null)) as {
		success?: boolean;
		result?: unknown;
	} | null;
	return { status: res.status, ok: res.ok && json?.success === true, result: json?.result };
}

async function identifyTarget(): Promise<void> {
	const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
	if (!account || !process.env.CLOUDFLARE_API_TOKEN)
		refuse("CLOUDFLARE_ACCOUNT_ID / _API_TOKEN unset");
	if (process.env.P3A_D1_LIVE_EXPECT_ACCOUNT !== account) {
		refuse("P3A_D1_LIVE_EXPECT_ACCOUNT must repeat CLOUDFLARE_ACCOUNT_ID");
	}
	const forbidden = (process.env.P3A_D1_LIVE_FORBID_ACCOUNTS ?? "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
	if (forbidden.includes(account)) refuse("the target account is in P3A_D1_LIVE_FORBID_ACCOUNTS");

	// G1 — the token's reach. Either listing shows exactly the test account, or
	// (a D1-only token may not list accounts) every forbidden account refuses it.
	// At least one of the two proofs is required.
	const listed = await cf("GET", "/accounts?per_page=50");
	const ids = Array.isArray(listed.result)
		? (listed.result as Array<{ id: string }>).map((a) => a.id)
		: null;
	let reachProven = false;
	if (listed.ok && ids) {
		if (ids.length !== 1 || ids[0] !== account) {
			refuse(`the token reaches ${ids.length} account(s), expected only the test account`);
		}
		pass("G1 token reach (listing)", `exactly one account: ${redact(account)}`);
		reachProven = true;
	} else {
		info("G1 token reach (listing)", `account listing not permitted (HTTP ${listed.status})`);
	}
	for (const f of forbidden) {
		const probe = await cf("GET", `/accounts/${f}/d1/database?per_page=1`);
		if (probe.ok) refuse(`the token CAN read D1 of forbidden account ${redact(f)}`);
		pass("G1 token reach (forbidden)", `${redact(f)} refuses it (HTTP ${probe.status})`);
		reachProven = true;
	}
	if (!reachProven) {
		refuse("no proof the token is limited to the test account (set P3A_D1_LIVE_FORBID_ACCOUNTS)");
	}

	// G2 — the account is dedicated: every database in it is a smoke database.
	const dbs = await cf("GET", `/accounts/${account}/d1/database?per_page=100`);
	if (!dbs.ok || !Array.isArray(dbs.result))
		refuse(`cannot list D1 databases (HTTP ${dbs.status})`);
	const names = (dbs.result as Array<{ name: string }>).map((d) => d.name);
	const foreign = names.filter((n) => !n.startsWith(PREFIX));
	if (foreign.length > 0) refuse(`the account holds non-smoke databases (${foreign.length})`);
	pass("G2 dedicated account", `${names.length} database(s), all ${PREFIX}*`);

	// G3 — the target: a fresh one, or the named one confirmed twice.
	let id: string;
	let expectName: string;
	if (process.env.P3A_D1_LIVE_CREATE === "1") {
		expectName = `${PREFIX}${Date.now()}`;
		const c = await cf("POST", `/accounts/${account}/d1/database`, { name: expectName });
		const uuid = (c.result as { uuid?: string } | undefined)?.uuid;
		if (!c.ok || !uuid) refuse(`could not create ${expectName} (HTTP ${c.status})`);
		id = uuid;
		created = { account, id };
		process.env.D1_DATABASE_ID = id;
	} else {
		id = process.env.D1_DATABASE_ID ?? "";
		expectName = process.env.P3A_D1_LIVE_EXPECT_NAME ?? "";
		if (!id || process.env.P3A_D1_LIVE_CONFIRM !== id) {
			refuse("set P3A_D1_LIVE_CONFIRM to the same value as D1_DATABASE_ID");
		}
		if (!expectName.startsWith(PREFIX)) refuse(`P3A_D1_LIVE_EXPECT_NAME must start with ${PREFIX}`);
	}
	const got = await cf("GET", `/accounts/${account}/d1/database/${id}`);
	const name = (got.result as { name?: string } | undefined)?.name;
	// G4 — id and name both match before the first statement.
	if (!got.ok || name !== expectName) refuse(`database ${id} is not ${expectName} (got ${name})`);
	pass("G3 target", `account ${redact(account)} · database ${name} · id ${id}`);
}

async function cleanup(): Promise<void> {
	if (!created) return;
	const del = await cf("DELETE", `/accounts/${created.account}/d1/database/${created.id}`);
	const after = await cf("GET", `/accounts/${created.account}/d1/database/${created.id}`);
	verdict(
		"Z cleanup",
		del.ok && !after.ok && after.status === 404,
		`DELETE HTTP ${del.status}; GET afterwards HTTP ${after.status}`,
	);
}

async function main(): Promise<void> {
	await identifyTarget();
	// Imported after the identity checks: db.ts reads the D1 config at module load.
	const { d1Query, migrateDb, MIGRATIONS, PROJECT_DIRECTORY_DDL, D1StatementError } = await import(
		"../db.js"
	);
	const { SessionManager } = await import("../sessionManager.js");
	const { ProjectDirectory, ProjectError, AgentActiveError, assertNoLiveBinding, isD1Envelope } =
		await import("./directory.js");

	// ── C0: the target is empty ────────────────────────────────────────────
	const tables = await d1Query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
	);
	if (tables.results.length > 0) {
		refuse(`database is not empty (${tables.results.map((t) => t.name).join(", ")})`);
	}
	pass("C0 empty-target", "no table before the run");

	// ── C1: migrateDb from zero, ledger complete ───────────────────────────
	await migrateDb();
	const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
	const ledger = await d1Query<{ version: number }>(
		"SELECT version FROM schema_migrations ORDER BY version",
	);
	const versions = ledger.results.map((r) => r.version);
	verdict(
		"C1 migrate",
		versions.length === MIGRATIONS.length && versions.at(-1) === latest && latest === 19,
		`ledger ${versions.length} rows, max ${versions.at(-1)}`,
	);

	// ── C2: schema objects as D1 stored them ───────────────────────────────
	const objs = await d1Query<{ type: string; name: string; sql: string | null }>(
		"SELECT type, name, sql FROM sqlite_master WHERE name IN ('trg_project_agent_creation','trg_project_agent_removed','idx_agent_bindings_live_agent','idx_agent_bindings_live_session','idx_projects_request')",
	);
	const byName = new Map(objs.results.map((o) => [o.name, o]));
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	const ddlOf = (name: string) => PROJECT_DIRECTORY_DDL.find((d) => d.includes(name)) ?? "";
	for (const t of ["trg_project_agent_creation", "trg_project_agent_removed"]) {
		const o = byName.get(t);
		verdict(
			`C2 trigger ${t}`,
			o?.type === "trigger" && norm(o.sql ?? "") === norm(ddlOf(t).replace("IF NOT EXISTS ", "")),
			o ? "stored SQL identical to the DDL (whitespace-normalised)" : "missing",
		);
	}
	for (const i of ["idx_agent_bindings_live_agent", "idx_agent_bindings_live_session"]) {
		const o = byName.get(i);
		verdict(
			`C2 index ${i}`,
			o?.type === "index" && /WHERE state IN \('active','draining'\)/.test(o.sql ?? ""),
			o?.sql ?? "missing",
		);
	}

	// ── Seed: two users, sessions in each state ────────────────────────────
	const OWNER = `u-${randomUUID()}`;
	const OTHER = `u-${randomUUID()}`;
	for (const [id, name] of [
		[OWNER, "owner"],
		[OTHER, "other"],
	]) {
		await d1Query("INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')", [
			id,
			`${name}-${id.slice(2, 10)}`,
		]);
	}
	const session = async (owner: string, status: string) => {
		const sid = randomUUID();
		await d1Query(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, ?)",
			[sid, owner, `smoke-${sid.slice(0, 8)}`, `st-${sid.slice(0, 12)}`, status],
		);
		return sid;
	};
	const sRun = await session(OWNER, "running");
	const sRun2 = await session(OWNER, "running");
	const sTerm = await session(OWNER, "terminated");
	const sForeign = await session(OTHER, "running");

	const dir = new ProjectDirectory();
	// Callers pass a thunk: `lastAnswer` is cleared BEFORE the call, so the raw line printed after
	// a check is that check's refusal or "none", never an earlier one.
	const refusal = async (
		id: string,
		call: () => Promise<unknown>,
		status: number,
		code: string,
	) => {
		lastAnswer = null;
		const p = call();
		try {
			await p;
			fail(id, `expected ${status} ${code}, got success`);
		} catch (err) {
			const e = err as InstanceType<typeof ProjectError>;
			verdict(
				id,
				err instanceof ProjectError && e.status === status && e.code === code,
				`${e.status ?? "?"} ${e.code ?? (err as Error).message}`,
			);
		}
	};
	const n = async (sql: string, p: unknown[] = []) =>
		(await d1Query<{ n: number }>(sql, p)).results[0].n;

	// ── C3: projects + idempotent retry ────────────────────────────────────
	const pBody = { name: "Smoke", clientRequestId: randomUUID() };
	const p1 = await dir.createProject(OWNER, pBody);
	const p1b = await dir.createProject(OWNER, pBody);
	verdict(
		"C3 project replay",
		!p1.replayed && p1b.replayed && p1b.body.projectId === p1.body.projectId,
		`replayed=${p1b.replayed}`,
	);
	const pid = p1.body.projectId;

	// ── C4: atomic agent + binding ─────────────────────────────────────────
	const aBody = { handle: "alpha", role: "Dev", sessionId: sRun, clientRequestId: randomUUID() };
	const a1 = await dir.createAgent(OWNER, pid, aBody);
	const rows = await d1Query<{ state: string; epoch: number; st_session_id: string }>(
		"SELECT state, epoch, st_session_id FROM agent_bindings WHERE agent_id = ?",
		[a1.body.agentId],
	);
	verdict(
		"C4 atomic create",
		rows.results.length === 1 &&
			rows.results[0].state === "active" &&
			rows.results[0].epoch === 1 &&
			rows.results[0].st_session_id === sRun,
		JSON.stringify(rows.results),
	);

	// ── C5: retry with the same clientRequestId ────────────────────────────
	const a1b = await dir.createAgent(OWNER, pid, aBody);
	verdict(
		"C5 replay",
		a1b.replayed &&
			a1b.body.agentId === a1.body.agentId &&
			(await n("SELECT COUNT(*) AS n FROM project_agents")) === 1,
		`replayed=${a1b.replayed}`,
	);
	await refusal(
		"C5 idempotency-conflict",
		() => dir.createAgent(OWNER, pid, { ...aBody, role: "Other" }),
		409,
		"idempotency-conflict",
	);

	// ── C6: SQLite refusals through D1, classified, nothing left behind ────
	const before = await n("SELECT COUNT(*) AS n FROM project_agents");
	await refusal(
		"C6 session-taken (UNIQUE)",
		() => dir.createAgent(OWNER, pid, { ...aBody, handle: "beta", clientRequestId: randomUUID() }),
		409,
		"session-taken",
	);
	info("C6 session-taken raw", lastAnswer ? JSON.stringify(lastAnswer) : "none");
	await refusal(
		"C6 handle-taken (UNIQUE)",
		() =>
			dir.createAgent(OWNER, pid, { ...aBody, sessionId: sRun2, clientRequestId: randomUUID() }),
		409,
		"handle-taken",
	);
	info("C6 handle-taken raw", lastAnswer ? JSON.stringify(lastAnswer) : "none");
	await refusal(
		"C6 session-not-found (RAISE, terminated)",
		() =>
			dir.createAgent(OWNER, pid, {
				handle: "gamma",
				sessionId: sTerm,
				clientRequestId: randomUUID(),
			}),
		404,
		"session-not-found",
	);
	info("C6 RAISE raw", lastAnswer ? JSON.stringify(lastAnswer) : "none");
	await refusal(
		"C6 session-not-found (RAISE, foreign owner)",
		() =>
			dir.createAgent(OWNER, pid, {
				handle: "gamma",
				sessionId: sForeign,
				clientRequestId: randomUUID(),
			}),
		404,
		"session-not-found",
	);
	await refusal(
		"C6 project-not-found (RAISE, foreign project)",
		() =>
			dir.createAgent(OTHER, pid, {
				handle: "gamma",
				sessionId: sForeign,
				clientRequestId: randomUUID(),
			}),
		404,
		"project-not-found",
	);
	verdict(
		"C6 no partial rows",
		(await n("SELECT COUNT(*) AS n FROM project_agents")) === before &&
			(await n("SELECT COUNT(*) AS n FROM project_agent_creations")) === before,
		"agents and creation records unchanged after every refusal",
	);
	// The raw refusal, as d1Query reports it.
	try {
		await d1Query(
			`INSERT INTO project_agent_creations (owner_user_id, client_request_id, request_hash, project_id, agent_id, binding_id, st_session_id, handle, created_at)
			 VALUES (?, ?, 'h', ?, ?, ?, ?, 'raw', datetime('now'))`,
			[OWNER, randomUUID(), randomUUID(), randomUUID(), randomUUID(), sRun2],
		);
		fail("C6 envelope", "a RAISE did not refuse");
	} catch (err) {
		const m = (err as Error).message;
		verdict(
			"C6 envelope",
			isD1Envelope(err) && /\bst:project-not-found\b/.test(m),
			`${err instanceof D1StatementError ? "D1StatementError (2xx)" : "4xx envelope"}: ${m.slice(0, 160)}`,
		);
	}

	// ── C7: a lost answer after an applied write ⇒ read-back, replayed ─────
	const lostBody = { handle: "lost", sessionId: sRun2, clientRequestId: randomUUID() };
	loseAnswerOf = /INSERT INTO project_agent_creations/;
	const lost = await dir.createAgent(OWNER, pid, lostBody).catch((e: Error) => e);
	verdict(
		"C7 lost answer → replayed",
		!(lost instanceof Error) && lost.replayed === true,
		lost instanceof Error ? lost.message : `replayed=${lost.replayed}`,
	);

	// ── C8: concurrent creations on one session ────────────────────────────
	let raceOk = true;
	for (let i = 0; i < 5; i++) {
		const sid = await session(OWNER, "running");
		const results = await Promise.allSettled(
			["r1", "r2"].map((h) =>
				dir.createAgent(OWNER, pid, {
					handle: `${h}-${i}`,
					sessionId: sid,
					clientRequestId: randomUUID(),
				}),
			),
		);
		const ok = results.filter((r) => r.status === "fulfilled").length;
		const taken = results.filter(
			(r) =>
				r.status === "rejected" &&
				(r.reason as InstanceType<typeof ProjectError>).code === "session-taken",
		).length;
		const live = await n(
			"SELECT COUNT(*) AS n FROM agent_bindings WHERE st_session_id = ? AND state IN ('active','draining')",
			[sid],
		);
		if (ok !== 1 || taken !== 1 || live !== 1) raceOk = false;
		// Remove the winner so the project stays under its limit.
		const winner = results.find((r) => r.status === "fulfilled") as
			| PromiseFulfilledResult<Awaited<ReturnType<typeof dir.createAgent>>>
			| undefined;
		if (winner) await dir.removeAgent(OWNER, pid, winner.value.body.agentId);
	}
	verdict(
		"C8 concurrency",
		raceOk,
		"5 rounds: exactly one winner, one session-taken, one live binding",
	);
	const sameId = {
		handle: "twin",
		sessionId: await session(OWNER, "running"),
		clientRequestId: randomUUID(),
	};
	const twins = await Promise.allSettled([
		dir.createAgent(OWNER, pid, sameId),
		dir.createAgent(OWNER, pid, sameId),
	]);
	const twinIds = twins.map((t) => (t.status === "fulfilled" ? t.value.body.agentId : "rejected"));
	verdict(
		"C8 concurrent same clientRequestId",
		twinIds[0] !== "rejected" && twinIds[0] === twinIds[1],
		JSON.stringify(
			twins.map((t) =>
				t.status === "fulfilled" ? { replayed: t.value.replayed } : String(t.reason),
			),
		),
	);

	// ── C9: removal trigger retires the binding; the session is free again ─
	await dir.removeAgent(OWNER, pid, a1.body.agentId);
	const retired = await d1Query<{ state: string; retire_reason: string | null }>(
		"SELECT state, retire_reason FROM agent_bindings WHERE agent_id = ?",
		[a1.body.agentId],
	);
	const again = await dir.createAgent(OWNER, pid, {
		handle: "alpha2",
		sessionId: sRun,
		clientRequestId: randomUUID(),
	});
	verdict(
		"C9 removal",
		retired.results[0]?.state === "retired" &&
			retired.results[0]?.retire_reason === "agent-removed" &&
			again.body.binding.sessionId === sRun,
		JSON.stringify(retired.results),
	);

	// ── C10: agent limit RAISE ─────────────────────────────────────────────
	const live = await n(
		"SELECT COUNT(*) AS n FROM project_agents WHERE project_id = ? AND removed_at IS NULL",
		[pid],
	);
	for (let i = live; i < 32; i++) {
		await dir.createAgent(OWNER, pid, {
			handle: `fill-${i}`,
			sessionId: await session(OWNER, "running"),
			clientRequestId: randomUUID(),
		});
	}
	const overSession = await session(OWNER, "running");
	await refusal(
		"C10 agent-limit (RAISE)",
		() =>
			dir.createAgent(OWNER, pid, {
				handle: "over",
				sessionId: overSession,
				clientRequestId: randomUUID(),
			}),
		409,
		"agent-limit",
	);

	// ── C11: hard-delete guard + markFailed on D1 ──────────────────────────
	try {
		await assertNoLiveBinding(sRun);
		fail("C11 guard", "a bound session passed the guard");
	} catch (err) {
		verdict("C11 guard", err instanceof AgentActiveError, (err as Error).message);
	}
	const sm = new SessionManager();
	const flippedTerm = await sm.markFailed(sTerm);
	const termNow = (
		await d1Query<{ status: string }>("SELECT status FROM sessions WHERE session_id = ?", [sTerm])
	).results[0].status;
	const flippedRun = await sm.markFailed(sRun2);
	verdict(
		"C11 markFailed",
		!flippedTerm && termNow === "terminated" && flippedRun,
		`terminated row flipped=${flippedTerm} (now ${termNow}); running row flipped=${flippedRun}`,
	);

	// ── C12: restart and re-migration ──────────────────────────────────────
	const counts = async () =>
		JSON.stringify(
			await Promise.all(
				[
					"projects",
					"project_agents",
					"agent_bindings",
					"project_agent_creations",
					"schema_migrations",
				].map((t) => n(`SELECT COUNT(*) AS n FROM ${t}`)),
			),
		);
	const c0 = await counts();
	await migrateDb();
	for (const ddl of PROJECT_DIRECTORY_DDL) await d1Query(ddl);
	const trig = await n(
		"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_project_agent_%'",
	);
	const fresh = new ProjectDirectory();
	const listed = await fresh.listAgents(OWNER, pid);
	verdict(
		"C12 re-migrate + restart",
		(await counts()) === c0 && trig === 2 && listed.agents.length === 32,
		`counts ${c0}; triggers ${trig}; a fresh directory lists ${listed.agents.length} agents`,
	);
	// The previous backend (≤ v18) finds every one of its versions recorded and applies nothing.
	const have = new Set(versions);
	// Not a test of older code: main's migrateDb skips every version already in the ledger
	// (`applied.has(m.version)`), so with 1–18 recorded it applies nothing. Recorded as context.
	info(
		"C12 previous backend boot",
		`versions 1–18 recorded: ${MIGRATIONS.filter((m) => m.version <= 18).every((m) => have.has(m.version))} (an older migrateDb skips recorded versions)`,
	);

	// ── C13 (INFO): a CRLF trigger body through /query ─────────────────────
	try {
		await d1Query("CREATE TABLE p3a_smoke_crlf (x INTEGER)");
		await d1Query("CREATE TABLE p3a_smoke_crlf_log (x INTEGER)");
		await d1Query(
			"CREATE TRIGGER p3a_smoke_crlf_trg\r\nAFTER INSERT ON p3a_smoke_crlf\r\nBEGIN\r\n\tINSERT INTO p3a_smoke_crlf_log (x) VALUES (NEW.x);\r\nEND",
		);
		await d1Query("INSERT INTO p3a_smoke_crlf (x) VALUES (7)");
		info(
			"C13 CRLF trigger",
			`fired=${(await n("SELECT COUNT(*) AS n FROM p3a_smoke_crlf_log")) === 1}`,
		);
	} catch (err) {
		info("C13 CRLF trigger", `refused: ${(err as Error).message.slice(0, 200)}`);
	}
	info("C13 note", "the v19 DDL contains no CR (checked below)");
	verdict(
		"C13 v19 DDL has no CR",
		PROJECT_DIRECTORY_DDL.every((d) => !d.includes("\r")),
		"LF only",
	);
}

let refused: string | null = null;
main()
	.catch((err) => {
		if (err instanceof Refused) refused = err.message;
		else fail("ABORT", (err as Error).stack ?? String(err));
	})
	.finally(async () => {
		await cleanup().catch((err) => fail("Z cleanup", (err as Error).message));
		console.log("── MANDATORY ──");
		for (const c of checks.filter((x) => x.ok !== null)) {
			console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.id} — ${c.detail}`);
		}
		console.log("── DIAGNOSTIC (recorded, never gates) ──");
		for (const c of checks.filter((x) => x.ok === null)) console.log(`INFO  ${c.id} — ${c.detail}`);
		const failed = checks.filter((c) => c.ok === false).length;
		if (refused !== null) {
			console.log(`RESULT: REFUSED — ${refused}`);
			process.exitCode = 2;
			return;
		}
		console.log(failed === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failed})`);
		process.exitCode = failed === 0 ? 0 : 1;
	});
