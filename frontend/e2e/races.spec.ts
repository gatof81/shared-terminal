import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

const S = SESSION_IDS.running;

/**
 * Races the unit tests cannot express because they live in main.ts (the
 * auth flow and showApp's post-refresh route application): hypotheses A
 * and D of the frontend audit. Every answer is held or failed explicitly
 * through the mock's `override`; no sleep decides an outcome.
 */
test.describe("auth and load races", () => {
	test("A: a session list that answers after logout + another login is not shown to the new person", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("my-project")).toBeVisible();

		// Hold alice's NEXT list request (the manual refresh below, or the
		// poll if it fires first — either carries alice's cookie).
		const aliceList = backend.sessions
			.filter((s) => s.ownerUserId === "u-alice" && s.status !== "terminated")
			.map((s) => backend.serialize(s));
		let held: Parameters<NonNullable<typeof backend.override>>[2] | null = null;
		backend.override = async (method, path, route) => {
			if (held === null && method === "GET" && /^\/sessions(\?|$)/.test(path)) {
				held = route;
				return true;
			}
			return false;
		};
		await page.click("#sidebar-refresh-btn");
		await expect.poll(() => held !== null).toBe(true);
		backend.override = null;

		// Alice logs out; Bob signs in on the same tab (no reload — the held
		// request is still alive).
		await app.appMenu("logout-btn");
		await expect(page.locator("#auth-view")).toBeVisible();
		await page.fill("#auth-username", "bob");
		await page.fill("#auth-password", "pw");
		await page.click("#auth-submit");
		await expect(page.locator("#app-view")).toBeVisible();
		await app.openSidebar();
		await expect(app.sessionRow("bob-api")).toBeVisible();
		await expect(app.sessionRow("my-project")).toHaveCount(0);

		// Alice's answer lands now.
		await held!.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(aliceList),
		});
		await page.waitForTimeout(300);
		expect(
			await app.sessionRow("my-project").count(),
			"alice's session rendered in bob's sidebar",
		).toBe(0);
		await expect(app.sessionRow("bob-api")).toBeVisible();
	});

	test("D: a deep link survives a failed first session list (not 'Session not found', address kept)", async ({
		app,
		backend,
		page,
	}) => {
		let failed = false;
		backend.override = async (method, path, route) => {
			if (!failed && method === "GET" && /^\/sessions(\?|$)/.test(path)) {
				failed = true;
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ error: "D1 unavailable" }),
				});
				return true;
			}
			return false;
		};
		const hash = `#/sessions/${S}/files`;
		await app.login("alice", hash);
		await expect(app.toast(/Failed to list sessions/)).toBeVisible();
		// The route was applied in the same turn as that toast.
		expect(page.url(), "the deep link was cleared although the session may well exist").toContain(
			hash,
		);
		await expect(app.toast(/Session not found/)).toHaveCount(0);
	});
});
