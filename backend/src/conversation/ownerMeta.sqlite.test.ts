/**
 * conversation/ownerMeta.sqlite.test.ts — CONVERSATION.md §6.2 (v1.8) against
 * a REAL SQLite (node:sqlite; D1 is SQLite): `fetch` to the D1 REST endpoint
 * is answered by an in-memory database, so the real `migrateDb()` (v1…v18),
 * the real registry SQL (one-query LEFT JOIN + UNION ALL, the per-field
 * upsert) and the real ConversationService/ConversationStore run end to end.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Loaded through require: Vite's resolver (vitest 2) does not know `node:sqlite` as a builtin.
const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");
let db: DatabaseSyncT;
let failD1 = false;
const realFetch = globalThis.fetch;

function d1Answer(sql: string, params: unknown[]) {
	if (failD1) return { success: false, errors: [{ message: "D1 down (test)" }], result: [] };
	try {
		const st = db.prepare(sql);
		const bind = params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as Array<
			string | number | null
		>;
		const returnsRows = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
		let results: unknown[] = [];
		if (returnsRows) results = st.all(...bind);
		else st.run(...bind);
		return { success: true, errors: [], result: [{ results, success: true, meta: {} }] };
	} catch (err) {
		return { success: false, errors: [{ message: (err as Error).message }], result: [] };
	}
}

beforeAll(() => {
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
	vi.stubEnv("D1_DATABASE_ID", "dbid");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			if (!String(url).includes("/d1/database/")) return realFetch(url, init);
			const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] };
			return new Response(JSON.stringify(d1Answer(sql, params ?? [])), { status: 200 });
		}),
	);
});
afterAll(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

// Imported after the env stubs: db.ts reads the D1 config at module load.
const load = async () => {
	const dbm = await import("../db.js");
	const reg = await import("./registry.js");
	const { ConversationService } = await import("./service.js");
	const { ConversationStore } = await import("./store.js");
	return { dbm, reg, ConversationService, ConversationStore };
};

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CID = "11111111-2222-4333-8444-555555555555";
let root: string;

async function freshDb() {
	db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	const { dbm } = await load();
	await dbm.migrateDb();
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'owner', 'x')").run();
	insertSession(SID, 1);
}
function insertSession(sid: string, requested = 0) {
	db.prepare(
		`INSERT INTO sessions (session_id, user_id, name, container_name, status, conversation_requested)
			VALUES (?, 'u1', 's', ?, 'running', ?)`,
	).run(sid, `st-${sid.slice(0, 12)}`, requested);
}

beforeEach(async () => {
	failD1 = false;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-ownermeta-"));
	await freshDb();
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("migration v18", () => {
	it("creates conversation_user_meta with the (st_session_id, cid) key and the FK cascade", async () => {
		const cols = db.prepare("PRAGMA table_info(conversation_user_meta)").all() as Array<{
			name: string;
			pk: number;
		}>;
		expect(cols.map((c) => c.name)).toEqual([
			"st_session_id",
			"cid",
			"custom_title",
			"archived_at",
			"updated_at",
		]);
		expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["st_session_id", "cid"]);
		const v = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
		expect(v.v).toBe(18);
		const { dbm } = await load();
		await dbm.migrateDb(); // idempotent on a migrated DB
	});
});

describe("registry SQL", () => {
	const row = (cid: string, lastEventAt: string) =>
		db
			.prepare(
				`INSERT INTO claude_conversations (session_id, st_session_id, kind, status, status_evidence, status_at,
					started_at, last_event_at) VALUES (?, ?, 'interactive', 'ended', 'hook', 't', 't', ?)`,
			)
			.run(cid, SID, lastEventAt);

	it("upsert is per field and archiving twice keeps the first time", async () => {
		const { reg } = await load();
		row(CID, "2026-11-03T10:00:00Z");
		expect(await reg.upsertConversationMeta(SID, CID, { title: "Mi nombre" })).toEqual({
			customTitle: "Mi nombre",
			archivedAt: null,
		});
		const a1 = await reg.upsertConversationMeta(SID, CID, { archived: true });
		expect(a1.customTitle).toBe("Mi nombre");
		expect(a1.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		db.prepare("UPDATE conversation_user_meta SET archived_at = '2026-01-01 00:00:00'").run();
		expect((await reg.upsertConversationMeta(SID, CID, { archived: true })).archivedAt).toBe(
			"2026-01-01 00:00:00",
		);
		expect(await reg.upsertConversationMeta(SID, CID, { title: null })).toEqual({
			customTitle: null,
			archivedAt: "2026-01-01 00:00:00",
		});
		expect(await reg.upsertConversationMeta(SID, CID, { archived: false })).toEqual({
			customTitle: null,
			archivedAt: null,
		});
	});

	it("the list is ONE query: rows with their metadata, plus metadata of a conversation with no row", async () => {
		const { reg } = await load();
		row("c-old", "2026-11-01T00:00:00Z");
		row("c-new", "2026-11-03T00:00:00Z");
		await reg.upsertConversationMeta(SID, "c-new", { title: "Nuevo" });
		await reg.upsertConversationMeta(SID, "c-disk-only", { archived: true });
		const fetchMock = vi.mocked(globalThis.fetch);
		fetchMock.mockClear();
		const { rows, meta } = await reg.listConversationRowsWithMeta(SID);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(rows.map((r) => r.session_id)).toEqual(["c-new", "c-old"]);
		expect(Object.keys(rows[0]).sort()).not.toContain("meta_cid");
		expect(meta.get("c-new")).toEqual({ customTitle: "Nuevo", archivedAt: null });
		expect(meta.get("c-old")).toBeUndefined();
		expect(meta.get("c-disk-only")?.archivedAt).not.toBeNull();
	});

	it("hard delete removes the metadata with the rows; another session's stays", async () => {
		const { reg } = await load();
		const other = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		insertSession(other);
		await reg.upsertConversationMeta(SID, CID, { title: "x" });
		await reg.upsertConversationMeta(other, CID, { title: "y" });
		await reg.deleteConversationRows(SID);
		const left = db.prepare("SELECT st_session_id FROM conversation_user_meta").all();
		expect(left).toEqual([{ st_session_id: other }]);
	});
});

describe("ConversationService owner metadata", () => {
	async function serviceWithConversation() {
		const { ConversationService, ConversationStore } = await load();
		const store = new ConversationStore({ workspaceRoot: root });
		const service = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store,
		});
		const out = await service.ingest(SID, "%0", {
			hook_event_name: "UserPromptSubmit",
			session_id: CID,
			prompt: "el primer prompt de la persona",
			cwd: "/w",
		});
		expect(out).toMatchObject({ accepted: true });
		await store.flush(SID, CID);
		return { service, store };
	}

	it("rename prevails, the automatic title stays in `title`, and nothing of the capture moves", async () => {
		const { service, store } = await serviceWithConversation();
		const eventsBefore = await fs.readFile(store.eventsPath(SID, CID));
		const indexBefore = JSON.stringify(await store.peekIndex(SID, CID));

		const renamed = await service.setOwnerMeta(SID, CID, { title: "Plan de migración" });
		expect(renamed).toMatchObject({
			sessionId: CID,
			title: "el primer prompt de la persona",
			customTitle: "Plan de migración",
			archivedAt: null,
		});
		const archived = await service.setOwnerMeta(SID, CID, { archived: true });
		expect(archived?.customTitle).toBe("Plan de migración");
		expect(archived?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);

		await store.flush(SID, CID);
		expect(Buffer.compare(await fs.readFile(store.eventsPath(SID, CID)), eventsBefore)).toBe(0);
		expect(JSON.stringify(await store.peekIndex(SID, CID))).toBe(indexBefore);
		await service.shutdown();
	});

	it("survives a later CLI session_title, a resume of the same cid, and a restarted service", async () => {
		const { service, store } = await serviceWithConversation();
		await service.setOwnerMeta(SID, CID, { title: "Mío", archived: true });
		await service.ingest(SID, "%0", {
			hook_event_name: "SessionStart",
			session_id: CID,
			source: "resume",
			session_title: "Título que puso el CLI",
			cwd: "/w",
		});
		await store.flush(SID, CID);
		const { conversations, meta } = await service.summariesWithMeta(SID);
		expect(meta).toBe("ok");
		// The automatic title moved; the owner's name did not.
		expect(conversations.find((c) => c.sessionId === CID)).toMatchObject({
			title: "Título que puso el CLI",
			customTitle: "Mío",
		});
		expect(conversations.find((c) => c.sessionId === CID)?.archivedAt).not.toBeNull();
		await service.shutdown();

		const { ConversationService, ConversationStore } = await load();
		const restarted = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: new ConversationStore({ workspaceRoot: root }),
		});
		const again = await restarted.summariesWithMeta(SID);
		expect(again.conversations.find((c) => c.sessionId === CID)?.customTitle).toBe("Mío");
		await restarted.shutdown();
	});

	it("an unknown, foreign-session or unsafe cid is not found and writes nothing", async () => {
		const { service } = await serviceWithConversation();
		expect(
			await service.setOwnerMeta(SID, "22222222-2222-4333-8444-555555555555", { title: "x" }),
		).toBeNull();
		expect(await service.setOwnerMeta(SID, "../../etc", { title: "x" })).toBeNull();
		const other = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		insertSession(other);
		expect(await service.setOwnerMeta(other, CID, { title: "x" })).toBeNull();
		expect(db.prepare("SELECT COUNT(*) AS n FROM conversation_user_meta").get()).toEqual({ n: 0 });
		await service.shutdown();
	});

	it("a conversation known only from its files (no D1 row, not resident) can be renamed AND is listed with its name", async () => {
		const { service } = await serviceWithConversation();
		await service.shutdown();
		// Its row upsert failed back then (or the row was lost): only the index and events file remain.
		db.prepare("DELETE FROM claude_conversations WHERE session_id = ?").run(CID);
		const { ConversationService, ConversationStore } = await load();
		const restarted = new ConversationService({
			workspaceRoot: root,
			enabled: true,
			port: 3001,
			store: new ConversationStore({ workspaceRoot: root }),
		});
		const out = await restarted.setOwnerMeta(SID, CID, { title: "Solo en disco" });
		expect(out).toMatchObject({ sessionId: CID, customTitle: "Solo en disco" });
		const fetchMock = vi.mocked(globalThis.fetch);
		fetchMock.mockClear();
		const { conversations, meta } = await restarted.summariesWithMeta(SID);
		// Still ONE D1 call for the list (§6.2 rule 3).
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(meta).toBe("ok");
		expect(conversations.find((c) => c.sessionId === CID)).toMatchObject({
			customTitle: "Solo en disco",
			title: "el primer prompt de la persona",
		});
		await restarted.shutdown();
	});

	it("with D1 down the list still answers from the resident index and says meta is unavailable", async () => {
		const { service } = await serviceWithConversation();
		await service.setOwnerMeta(SID, CID, { title: "Mío" });
		failD1 = true;
		const { conversations, meta } = await service.summariesWithMeta(SID);
		expect(meta).toBe("unavailable");
		expect(conversations.find((c) => c.sessionId === CID)).toMatchObject({ customTitle: null });
		await expect(service.setOwnerMeta(SID, CID, { title: "otro" })).rejects.toThrow();
		failD1 = false;
		await service.shutdown();
	});
});
