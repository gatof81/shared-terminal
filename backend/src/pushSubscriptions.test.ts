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
	upsertSubscription,
	userHasSubscription,
} from "./pushSubscriptions.js";

beforeEach(() => dbStubs.d1Query.mockReset());

describe("upsertSubscription", () => {
	it("INSERTs with ON CONFLICT(endpoint) re-owning the row + refreshing keys", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		await upsertSubscription("u1", { endpoint: "https://a", p256dh: "k", auth: "a" });
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
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
