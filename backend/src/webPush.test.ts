import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webpushStubs = vi.hoisted(() => ({
	setVapidDetails: vi.fn(),
	sendNotification: vi.fn(async () => undefined),
}));
vi.mock("web-push", () => ({ default: webpushStubs }));

const subStubs = vi.hoisted(() => ({
	listSubscriptionsForUser: vi.fn(async () => [] as unknown[]),
	deleteSubscriptionByEndpoint: vi.fn(async () => true),
}));
vi.mock("./pushSubscriptions.js", () => subStubs);

import { configureWebPush, getVapidPublicKey, isPushEnabled, sendToUser } from "./webPush.js";

function setOrDelete(name: string, value?: string): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}
function setEnv(pub?: string, priv?: string, subj?: string) {
	setOrDelete("VAPID_PUBLIC_KEY", pub);
	setOrDelete("VAPID_PRIVATE_KEY", priv);
	setOrDelete("VAPID_SUBJECT", subj);
}

beforeEach(() => {
	webpushStubs.setVapidDetails.mockReset();
	webpushStubs.sendNotification.mockReset();
	webpushStubs.sendNotification.mockResolvedValue(undefined);
	subStubs.listSubscriptionsForUser.mockReset();
	subStubs.deleteSubscriptionByEndpoint.mockReset();
	subStubs.deleteSubscriptionByEndpoint.mockResolvedValue(true);
});
afterEach(() => setEnv(undefined, undefined, undefined));

describe("configureWebPush", () => {
	it("enables push when all three VAPID vars are set", () => {
		setEnv("pubkey", "privkey", "mailto:x@y.z");
		expect(configureWebPush()).toBe(true);
		expect(isPushEnabled()).toBe(true);
		expect(getVapidPublicKey()).toBe("pubkey");
		expect(webpushStubs.setVapidDetails).toHaveBeenCalledWith("mailto:x@y.z", "pubkey", "privkey");
	});

	it("disables push (no throw) when any var is missing", () => {
		setEnv("pubkey", undefined, "mailto:x@y.z");
		expect(configureWebPush()).toBe(false);
		expect(isPushEnabled()).toBe(false);
		expect(getVapidPublicKey()).toBeNull();
		expect(webpushStubs.setVapidDetails).not.toHaveBeenCalled();
	});

	it("disables push when web-push rejects the config (bad subject)", () => {
		setEnv("pubkey", "privkey", "not-a-url");
		webpushStubs.setVapidDetails.mockImplementationOnce(() => {
			throw new Error("Vapid subject is not a url or mailto");
		});
		expect(configureWebPush()).toBe(false);
		expect(isPushEnabled()).toBe(false);
	});
});

describe("sendToUser", () => {
	beforeEach(() => {
		setEnv("pubkey", "privkey", "mailto:x@y.z");
		configureWebPush();
	});

	it("is a no-op when push is disabled", async () => {
		setEnv(undefined, undefined, undefined);
		configureWebPush();
		await sendToUser("u1", { title: "t", body: "b", sessionId: "s1" });
		expect(subStubs.listSubscriptionsForUser).not.toHaveBeenCalled();
	});

	it("sends the JSON payload to every subscription", async () => {
		subStubs.listSubscriptionsForUser.mockResolvedValueOnce([
			{ endpoint: "https://a", p256dh: "k1", auth: "a1" },
			{ endpoint: "https://b", p256dh: "k2", auth: "a2" },
		]);
		await sendToUser("u1", { title: "Done", body: "Claude finished", sessionId: "s1" });
		expect(webpushStubs.sendNotification).toHaveBeenCalledTimes(2);
		const [sub, body] = webpushStubs.sendNotification.mock.calls[0]!;
		expect(sub).toEqual({ endpoint: "https://a", keys: { p256dh: "k1", auth: "a1" } });
		expect(JSON.parse(body as string)).toEqual({
			title: "Done",
			body: "Claude finished",
			sessionId: "s1",
		});
	});

	it("prunes a subscription the push service reports as gone (410)", async () => {
		subStubs.listSubscriptionsForUser.mockResolvedValueOnce([
			{ endpoint: "https://dead", p256dh: "k", auth: "a" },
		]);
		webpushStubs.sendNotification.mockRejectedValueOnce(
			Object.assign(new Error("gone"), { statusCode: 410 }),
		);
		await sendToUser("u1", { title: "t", body: "b", sessionId: "s1" });
		expect(subStubs.deleteSubscriptionByEndpoint).toHaveBeenCalledWith("https://dead");
	});

	it("does NOT prune on a transient (5xx) failure", async () => {
		subStubs.listSubscriptionsForUser.mockResolvedValueOnce([
			{ endpoint: "https://x", p256dh: "k", auth: "a" },
		]);
		webpushStubs.sendNotification.mockRejectedValueOnce(
			Object.assign(new Error("service down"), { statusCode: 503 }),
		);
		await sendToUser("u1", { title: "t", body: "b", sessionId: "s1" });
		expect(subStubs.deleteSubscriptionByEndpoint).not.toHaveBeenCalled();
	});

	it("isolates a per-subscription failure — the others still send", async () => {
		subStubs.listSubscriptionsForUser.mockResolvedValueOnce([
			{ endpoint: "https://dead", p256dh: "k", auth: "a" },
			{ endpoint: "https://ok", p256dh: "k", auth: "a" },
		]);
		webpushStubs.sendNotification
			.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
			.mockResolvedValueOnce(undefined);
		await expect(
			sendToUser("u1", { title: "t", body: "b", sessionId: "s1" }),
		).resolves.toBeUndefined();
		expect(webpushStubs.sendNotification).toHaveBeenCalledTimes(2);
	});

	it("never throws when loading subscriptions fails", async () => {
		subStubs.listSubscriptionsForUser.mockRejectedValueOnce(new Error("D1 down"));
		await expect(
			sendToUser("u1", { title: "t", body: "b", sessionId: "s1" }),
		).resolves.toBeUndefined();
	});
});
