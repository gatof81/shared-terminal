/**
 * backup.tasks.sqlite.test.ts — a real backup → restore of the v29 tasks:
 * goals, children, links, their history and the messages that name them, from
 * one SQLite (D1 is SQLite) to a fresh one, through the real runBackup /
 * runRestore, the real migrations and triggers. What it pins: the restored
 * relations are the backup's, row for row — the triggers that write history
 * and bump versions on a live write add nothing while the rows are replayed.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

let db: DatabaseSyncT;
let tmp: string;

function run(sql: string, params: unknown[]) {
	try {
		const st = db.prepare(sql);
		const bind = params as Array<string | number | null>;
		if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql))
			return {
				success: true,
				errors: [],
				result: [{ results: st.all(...bind), success: true, meta: {} }],
			};
		const info = st.run(...bind);
		return {
			success: true,
			errors: [],
			result: [{ results: [], success: true, meta: { changes: Number(info.changes) } }],
		};
	} catch (err) {
		return { success: false, errors: [{ message: (err as Error).message }], result: [] };
	}
}

const fresh = () => {
	const d = new DatabaseSync(":memory:");
	d.exec("PRAGMA foreign_keys = ON");
	return d;
};

beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "st-backup-tasks-"));
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
	vi.stubEnv("D1_DATABASE_ID", "dbid");
	vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
	vi.stubEnv("WORKSPACE_ROOT", path.join(tmp, "ws"));
	await fs.mkdir(path.join(tmp, "ws"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string | URL, init?: RequestInit) => {
			const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params?: unknown[] };
			return new Response(JSON.stringify(run(sql, params ?? [])));
		}),
	);
	db = fresh();
});

afterAll(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await fs.rm(tmp, { recursive: true, force: true });
});

const dump = (d: DatabaseSyncT) => ({
	tasks: d.prepare("SELECT * FROM tasks ORDER BY id").all(),
	task_links: d.prepare("SELECT * FROM task_links ORDER BY task_id, kind, ref").all(),
	task_events: d.prepare("SELECT * FROM task_events ORDER BY id").all(),
	messages: d.prepare("SELECT id, task_id, reply_to FROM agent_messages ORDER BY id").all(),
});

describe("backup → restore of tasks (v29)", () => {
	it("TABLES keeps the order the v29 triggers rely on", async () => {
		const { TABLES } = await import("./backup.js");
		const at = (n: string) => TABLES.findIndex((t) => t.name === n);
		// Messages before tasks: replaying a request fires the counting trigger,
		// and the tasks restored after it land with the backup's own counters.
		expect(at("agent_messages")).toBeLessThan(at("tasks"));
		// History before tasks and links: their triggers skip what already has its event.
		expect(at("task_events")).toBeLessThan(at("tasks"));
		expect(at("tasks")).toBeLessThan(at("task_links"));
	});

	it("goals, children, links, history and the messages' task_id come back as they were", async () => {
		const { migrateDb } = await import("./db.js");
		const { runBackup, runRestore } = await import("./backup.js");
		await migrateDb();
		const U = "u-1";
		db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'o', 'x')").run(U);
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES ('p', ?, 'P', 'c', 'h')",
		).run(U);
		const task = db.prepare(
			`INSERT INTO tasks (owner_user_id, project_id, parent_id, title, coordinator, origin_key, budget_limit, created_by, updated_by)
			 VALUES (?, 'p', ?, ?, ?, ?, ?, ?, ?)`,
		);
		const goal = Number(
			task.run(U, null, "Objetivo", "arq", "c:req-1", 150, "arq", "arq").lastInsertRowid,
		);
		const a = Number(task.run(U, goal, "Hija A", null, null, null, "arq", "arq").lastInsertRowid);
		const b = Number(
			task.run(U, goal, "Hija B", null, null, null, "owner", "owner").lastInsertRowid,
		);
		// Writes as the API makes them: versioned updates and links (history by trigger).
		db.prepare(
			"UPDATE tasks SET assignee = 'dev', version = version + 1, updated_by = 'arq' WHERE id = ?",
		).run(a);
		db.prepare(
			"UPDATE tasks SET status = 'done', done_at = '2026-11-26T00:00:00.000Z', done_by = 'qa', version = version + 1, updated_by = 'qa' WHERE id = ?",
		).run(b);
		const link = db.prepare(
			"INSERT INTO task_links (owner_user_id, task_id, kind, ref, created_by) VALUES (?, ?, ?, ?, ?)",
		);
		link.run(U, a, "pr", "812", "dev");
		link.run(U, a, "dep", String(b), "arq");
		link.run(U, goal, "external", "espera a la persona", "arq");
		const msg = db.prepare(
			"INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, reply_to, body, state, task_id) VALUES (?, ?, ?, ?, ?, 'x', 'done', ?)",
		);
		const req = Number(msg.run(U, "arq", "dev", "request", null, a).lastInsertRowid);
		msg.run(U, "dev", "arq", "reply", req, a);
		msg.run(U, "owner", "arq", "request", null, null);

		const before = dump(db);
		expect(before.task_events.length).toBe(3 + 2 + 3);
		expect((before.tasks.find((t) => t.id === a) as { version: number }).version).toBe(4);

		const out = path.join(tmp, ".backups", "b1");
		const manifest = await runBackup(out);
		expect(manifest.tables).toMatchObject({ tasks: 3, task_links: 3, task_events: 8 });

		db = fresh();
		await runRestore(out);
		expect(dump(db)).toEqual(before);

		// A live write after the restore still records its history and bumps the version.
		db.prepare(
			"INSERT INTO task_links (owner_user_id, task_id, kind, ref, created_by) VALUES (?, ?, 'pr', '900', 'dev')",
		).run(U, a);
		const after = dump(db);
		expect(after.task_events.length).toBe(before.task_events.length + 1);
		expect((after.tasks.find((t) => t.id === a) as { version: number }).version).toBe(5);
	});
});
