import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
	class D1StatementError extends Error {}
	return {
		D1StatementError,
		d1Query: vi.fn(),
		getD1CallsSinceBoot: () => 0,
	};
});
vi.mock("../db.js", () => db);

import { d1RecreatePort } from "./d1.js";

describe("the commit CAS (§2.7.2 step 4)", () => {
	it("one statement moving container_id and the hash together, guarded by O and requested=1", async () => {
		db.d1Query.mockResolvedValueOnce({ results: [], success: true, meta: { changes: 1 } });
		expect(await d1RecreatePort.cas("sid", "O", "N", "H")).toBe("applied");
		const [sql, params] = db.d1Query.mock.calls[0] as [string, unknown[]];
		expect(sql).toBe(
			"UPDATE sessions SET container_id = ?, ingest_token_hash = ?, ingest_token_hash_suspended = NULL WHERE session_id = ? AND container_id = ? AND conversation_requested = 1",
		);
		expect(params).toEqual(["N", "H", "sid", "O"]);
	});
	it("0 rows ⇒ not-applied; D1 answering that the statement failed ⇒ not-applied", async () => {
		db.d1Query.mockResolvedValueOnce({ results: [], success: true, meta: { changes: 0 } });
		expect(await d1RecreatePort.cas("sid", "O", "N", "H")).toBe("not-applied");
		db.d1Query.mockRejectedValueOnce(new db.D1StatementError("D1 query failed: constraint"));
		expect(await d1RecreatePort.cas("sid", "O", "N", "H")).toBe("not-applied");
	});
	it("a timeout, a network error or a non-2xx ⇒ ambiguous (it may have applied)", async () => {
		for (const err of [
			new Error("D1 API timeout after 10000 ms for: UPDATE sessions"),
			new TypeError("fetch failed"),
			new Error("D1 API error (502): bad gateway"),
		]) {
			db.d1Query.mockRejectedValueOnce(err);
			expect(await d1RecreatePort.cas("sid", "O", "N", "H")).toBe("ambiguous");
		}
	});
});
