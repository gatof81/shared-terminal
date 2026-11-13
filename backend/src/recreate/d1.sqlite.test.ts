/**
 * recreate/d1.ts — the commit fence's statements (CONVERSATION.md §2.7.4,
 * v1.9.4, #627) against a REAL SQLite (node:sqlite; D1 is SQLite): `fetch`
 * to the D1 REST endpoint is answered by an in-memory database built by the
 * real `migrateDb()`, so these are the exact statements `d1RecreatePort`
 * sends, with SQLite deciding which rows they change. Both orders of a
 * commit and a recovery's fence are replayed, plus the migration itself.
 */

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Loaded through require: Vite's resolver (vitest 2) does not know `node:sqlite` as a builtin.
const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

let db: DatabaseSyncT;
const realFetch = globalThis.fetch;

function run(sql: string, params: unknown[]) {
	try {
		const st = db.prepare(sql);
		const bind = params as Array<string | number | null>;
		if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
			return {
				success: true,
				errors: [],
				result: [{ results: st.all(...bind), success: true, meta: { changes: 0 } }],
			};
		}
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

beforeAll(() => {
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
	vi.stubEnv("D1_DATABASE_ID", "dbid");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			if (!String(url).includes("/d1/database/")) return realFetch(url, init);
			const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params?: unknown[] };
			const answer = run(sql, params ?? []);
			return new Response(JSON.stringify(answer), { status: 200 });
		}),
	);
});
afterAll(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

// Imported after the env stubs: db.ts reads the D1 config at module load.
const load = async () => ({
	dbm: await import("../db.js"),
	port: (await import("./d1.js")).d1RecreatePort,
});

const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const O = "o".repeat(64);
const N = "n".repeat(64);

async function fresh(upTo?: number) {
	db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	const { dbm } = await load();
	if (upTo === undefined) await dbm.migrateDb();
	else for (const m of dbm.MIGRATIONS) if (m.version <= upTo) await m.apply();
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'owner', 'x')").run();
	db.prepare(
		"INSERT INTO sessions (session_id, user_id, name, container_name, status, container_id, conversation_requested, ingest_token_hash) VALUES (?, 'u1', 's', 'st-0a1b2c3d-4e5', 'stopped', ?, 1, 'H-old')",
	).run(SID, O);
}
const row = () =>
	db
		.prepare(
			"SELECT container_id, ingest_token_hash, ingest_token_hash_suspended, recreate_fence FROM sessions WHERE session_id = ?",
		)
		.get(SID) as {
		container_id: string;
		ingest_token_hash: string | null;
		ingest_token_hash_suspended: string | null;
		recreate_fence: number;
	};

beforeEach(async () => {
	await fresh();
});

describe("migration v20: sessions.recreate_fence", () => {
	it("is additive: an existing row reads 0; re-applying is a no-op", async () => {
		await fresh(19);
		expect(
			(db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(
				(c) => c.name === "recreate_fence",
			),
		).toBe(false);
		const { dbm, port } = await load();
		const v20 = dbm.MIGRATIONS.find((m) => m.version === 20);
		await v20?.apply();
		await v20?.apply();
		expect(row().recreate_fence).toBe(0);
		expect(await port.getRow(SID)).toMatchObject({ container_id: O, recreate_fence: 0 });
	});
});

describe("the fenced commit statements (real SQLite)", () => {
	it("CAS first: it applies and consumes the generation; the recovery's fence then matches 0 rows and the re-read shows both", async () => {
		const { port } = await load();
		expect(await port.cas(SID, O, N, "H-new", 0)).toBe("applied");
		expect(row()).toMatchObject({ container_id: N, ingest_token_hash: "H-new", recreate_fence: 1 });
		expect(await port.fence(SID, 0)).toBe("not-applied");
		const r = await port.getRow(SID);
		expect(r?.recreate_fence).toBeGreaterThan(0); // proven
		expect(r?.container_id).toBe(N); // the commit won: keep N
		// The same statement landing again (a duplicate delivery) changes nothing.
		expect(await port.cas(SID, O, N, "H-new", 0)).toBe("not-applied");
	});

	it("fence first: the late CAS carrying the old generation changes 0 rows; D1 stays on O", async () => {
		const { port } = await load();
		expect(await port.fence(SID, 0)).toBe("applied");
		expect(row().recreate_fence).toBe(1);
		expect(await port.cas(SID, O, N, "H-new", 0)).toBe("not-applied");
		expect(row()).toMatchObject({ container_id: O, ingest_token_hash: "H-old", recreate_fence: 1 });
		// A second recovery's fence on the same generation: 0 rows, still proven by the read.
		expect(await port.fence(SID, 0)).toBe("not-applied");
		expect(row().recreate_fence).toBe(1);
		// The next attempt commits on the current generation.
		expect(await port.cas(SID, O, N, "H-new", 1)).toBe("applied");
		expect(row()).toMatchObject({ container_id: N, recreate_fence: 2 });
	});

	it("casBack in both orders", async () => {
		const { port } = await load();
		expect(await port.cas(SID, O, N, "H-new", 0)).toBe("applied"); // fence 1, D1 on N
		// casBack first, then the fence: applied, hashes cleared, the fence finds it consumed.
		expect(await port.casBack(SID, N, O, 1)).toBe("applied");
		expect(row()).toMatchObject({
			container_id: O,
			ingest_token_hash: null,
			ingest_token_hash_suspended: null,
			recreate_fence: 2,
		});
		expect(await port.fence(SID, 1)).toBe("not-applied");
		// Fence first, then a late casBack: 0 rows.
		expect(await port.cas(SID, O, N, "H-2", 2)).toBe("applied"); // fence 3
		expect(await port.fence(SID, 3)).toBe("applied");
		expect(await port.casBack(SID, N, O, 3)).toBe("not-applied");
		expect(row()).toMatchObject({ container_id: N, recreate_fence: 4 });
	});

	it("the CAS keeps its other guards: requested=0 (a disable) and a foreign container_id refuse it", async () => {
		const { port } = await load();
		db.prepare("UPDATE sessions SET conversation_requested = 0 WHERE session_id = ?").run(SID);
		expect(await port.cas(SID, O, N, "H-new", 0)).toBe("not-applied");
		db.prepare("UPDATE sessions SET conversation_requested = 1 WHERE session_id = ?").run(SID);
		expect(await port.cas(SID, "x".repeat(64), N, "H-new", 0)).toBe("not-applied");
		expect(row()).toMatchObject({ container_id: O, recreate_fence: 0 });
	});
});
