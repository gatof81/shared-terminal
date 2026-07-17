import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import {
	deleteSubscriptionByEndpoint,
	listSubscriptionsForUser,
	MAX_PUSH_SUBSCRIPTIONS_PER_USER,
	PushQuotaExceededError,
	upsertSubscription,
	userHasSubscription,
} from "./pushSubscriptions.js";

beforeEach(() => dbStubs.d1Query.mockReset());

// Helper: queue the two cap-check reads (endpoint-exists, then count) that
// precede the INSERT for a NEW endpoint.
function queueCapChecks(endpointExists: boolean, count: number) {
	dbStubs.d1Query.mockResolvedValueOnce({
		results: endpointExists ? [{ one: 1 }] : [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	});
	if (!endpointExists) {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ n: count }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
	}
}

describe("upsertSubscription", () => {
	it("INSERTs with ON CONFLICT(endpoint) re-owning the row + refreshing keys", async () => {
		queueCapChecks(false, 0);
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		await upsertSubscription("u1", { endpoint: "https://a", p256dh: "k", auth: "a" });
		// The INSERT is the 3rd call (after the two cap checks).
		const [sql, params] = dbStubs.d1Query.mock.calls[2]!;
		expect(sql).toMatch(/INSERT INTO push_subscriptions/);
		// The conflict target is the endpoint, and the update re-points user_id
		// (shared-device account switch) + refreshes both keys.
		expect(sql).toMatch(/ON CONFLICT\(endpoint\) DO UPDATE SET/);
		expect(sql).toMatch(/user_id = excluded\.user_id/);
		expect(sql).toMatch(/p256dh = excluded\.p256dh/);
		expect(sql).toMatch(/auth = excluded\.auth/);
		// params: id, user_id, endpoint, p256dh, auth
		expect((params as string[])[1]).toBe("u1");
		expect((params as string[]).slice(2)).toEqual(["https://a", "k", "a"]);
	});

	it("throws PushQuotaExceededError when a NEW endpoint would exceed the cap", async () => {
		queueCapChecks(false, MAX_PUSH_SUBSCRIPTIONS_PER_USER);
		await expect(
			upsertSubscription("u1", { endpoint: "https://new", p256dh: "k", auth: "a" }),
		).rejects.toBeInstanceOf(PushQuotaExceededError);
		// No INSERT fired — only the two cap-check reads ran.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(2);
	});

	it("allows re-subscribing an EXISTING endpoint even at the cap (UPDATE path, no count check)", async () => {
		// Endpoint already exists → skip the count read entirely and upsert.
		queueCapChecks(true, 0);
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		await upsertSubscription("u1", { endpoint: "https://a", p256dh: "k2", auth: "a2" });
		// exists-check (1) + INSERT (2), NO count read.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(2);
		expect(dbStubs.d1Query.mock.calls[1]![0]).toMatch(/INSERT INTO push_subscriptions/);
	});
});

describe("listSubscriptionsForUser", () => {
	it("selects the endpoint + keys scoped to the user", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ endpoint: "https://a", p256dh: "k", auth: "a" }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const subs = await listSubscriptionsForUser("u1");
		expect(subs).toHaveLength(1);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = \?/);
		expect(params).toEqual(["u1"]);
	});
});

describe("deleteSubscriptionByEndpoint", () => {
	it("deletes by endpoint and reports whether a row went", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		expect(await deleteSubscriptionByEndpoint("https://a")).toBe(true);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/DELETE FROM push_subscriptions WHERE endpoint = \?/);
		expect(params).toEqual(["https://a"]);
	});

	it("returns false when nothing matched", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		expect(await deleteSubscriptionByEndpoint("https://gone")).toBe(false);
	});
});

describe("userHasSubscription", () => {
	it("is true when the count is positive", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ n: 2 }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		expect(await userHasSubscription("u1")).toBe(true);
	});

	it("is false when zero (and on an empty result set)", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ n: 0 }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		expect(await userHasSubscription("u1")).toBe(false);
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		expect(await userHasSubscription("u1")).toBe(false);
	});
});
