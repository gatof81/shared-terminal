/**
 * db.test.ts — call counter tests (#241b).
 *
 * The d1 counter exposed via `getD1CallsSinceBoot()` is what the admin
 * stats endpoint surfaces to operators. The counter is a single
 * `d1CallsSinceBoot++` at the top of `d1Query`, but pinning the
 * behaviour here means a future refactor that moves the increment
 * past an early return (or replaces `d1Query` with a wrapper that
 * forgets to bump) can't silently break the dashboard signal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub fetch globally — the real d1Query hits the Cloudflare HTTP API.
// Each test installs its own response shape via `mockFetch`.
let originalFetch: typeof fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					result: [
						{ results: [], success: true, meta: { changes: 0, duration: 0, last_row_id: 0 } },
					],
					success: true,
					errors: [],
				}),
				{ status: 200 },
			),
	);
	(globalThis as { fetch: unknown }).fetch = fetchMock;
	return fetchMock;
}

describe("d1 call counter (#241b)", () => {
	it("increments on every d1Query call", async () => {
		const { __resetD1CallsForTests, d1Query, getD1CallsSinceBoot } = await import("./db.js");
		__resetD1CallsForTests();
		mockFetch();

		expect(getD1CallsSinceBoot()).toBe(0);
		await d1Query("SELECT 1");
		expect(getD1CallsSinceBoot()).toBe(1);
		await d1Query("SELECT 2");
		await d1Query("SELECT 3");
		expect(getD1CallsSinceBoot()).toBe(3);
	});

	it("counts even when the query throws (so retried/failed calls are visible)", async () => {
		const { __resetD1CallsForTests, d1Query, getD1CallsSinceBoot } = await import("./db.js");
		__resetD1CallsForTests();
		// Mock fetch to return a non-OK response — d1Query will throw.
		(globalThis as { fetch: unknown }).fetch = vi.fn(
			async () => new Response("nope", { status: 500 }),
		);

		await expect(d1Query("SELECT 1")).rejects.toThrow();
		// Counter bumped at the TOP of the function, so failures count.
		// Operator wants to see "100 D1 calls last hour" even if half
		// of them failed — that's a useful signal, not a regression.
		expect(getD1CallsSinceBoot()).toBe(1);
	});
});

// #304: a `success: true` response with an empty `result` array must throw
// a sourced error at d1Query, not return undefined and surface later as
// `Cannot read properties of undefined (reading 'results')` in a caller.
describe("d1Query empty-result guard (#304)", () => {
	it("throws a sourced error when result[] is empty despite success:true", async () => {
		const { d1Query } = await import("./db.js");
		(globalThis as { fetch: unknown }).fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ result: [], success: true, errors: [] }), { status: 200 }),
		);
		await expect(d1Query("SELECT * FROM widgets")).rejects.toThrow(
			/no result set for: SELECT \* FROM widgets/,
		);
	});

	it("throws the same sourced error when the result key is absent entirely", async () => {
		const { d1Query } = await import("./db.js");
		(globalThis as { fetch: unknown }).fetch = vi.fn(
			async () => new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 }),
		);
		await expect(d1Query("SELECT * FROM gadgets")).rejects.toThrow(
			/no result set for: SELECT \* FROM gadgets/,
		);
	});
});

// #343: every fetch must carry an abort signal (the 10 s ceiling), and a
// fired timeout must surface as a sourced D1 error — not undici's generic
// "The operation was aborted due to timeout", which names neither the
// dependency nor the statement.
describe("d1Query timeout (#343)", () => {
	it("passes an AbortSignal to fetch", async () => {
		const { d1Query } = await import("./db.js");
		const fetchMock = mockFetch();
		await d1Query("SELECT 1");
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("rewraps a fired timeout as a sourced error naming D1 and the query", async () => {
		const { d1Query } = await import("./db.js");
		// Simulate undici's rejection shape when AbortSignal.timeout fires.
		(globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		});
		await expect(d1Query("SELECT * FROM sessions WHERE session_id = ?")).rejects.toThrow(
			/D1 API timeout after 10000 ms for: SELECT \* FROM sessions/,
		);
	});

	it("rethrows non-timeout fetch failures untouched", async () => {
		const { d1Query } = await import("./db.js");
		(globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(d1Query("SELECT 1")).rejects.toThrow(/fetch failed/);
	});
});
