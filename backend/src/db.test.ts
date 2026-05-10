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
