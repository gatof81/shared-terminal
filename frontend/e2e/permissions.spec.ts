import { SESSION_IDS } from "./mockBackend.js";
import { expect, test } from "./fixtures.js";

/**
 * Role-gated UI: what each role sees, and that the client never asks the
 * server about a session it has no business with (the no-existence-leak
 * invariant of the deep-link resolver).
 */
test.describe("permissions", () => {
	test("a plain user sees no admin, invites or groups controls", async ({ app, page }) => {
		await app.login("alice");
		for (const id of ["admin-btn", "invites-btn", "my-groups-btn"]) {
			await expect(page.locator(`#${id}`)).toHaveClass(/hidden/);
			await expect(page.locator(`#sidebar-${id}`)).toHaveClass(/hidden/);
		}
		await expect(page.locator("#observable-section")).toHaveClass(/hidden/);
	});

	test("a deep link to a foreign session is 'not found' and sends no request for it", async ({
		app,
		backend,
	}) => {
		await app.login("alice", `#/sessions/${SESSION_IDS.bob}`);
		await expect(app.toast("Session not found")).toBeVisible();
		expect(backend.requests.filter((r) => r.path.includes(SESSION_IDS.bob))).toEqual([]);
	});

	test("an admin sees the dashboard with every user's session", async ({ app, page }) => {
		await app.login("admin");
		await app.openSidebar();
		await page.click(app.mobile ? "#sidebar-admin-btn" : "#admin-btn");
		const modal = page.locator("#admin-modal");
		await expect(modal).toHaveClass(/open/);
		const list = modal.locator("#admin-sessions-list");
		await expect(list).toContainText("my-project");
		await expect(list).toContainText("bob-api");
		await expect(list.locator(".admin-session-row", { hasText: "bob-api" })).toContainText("bob");
		await app.escape();
		await expect(modal).not.toHaveClass(/open/);
	});

	test("a lead sees My groups and the observable member session in the sidebar", async ({
		app,
		page,
	}) => {
		await app.login("lead");
		await app.openSidebar();
		await expect(page.locator("#sidebar-my-groups-btn, #my-groups-btn").first()).not.toHaveClass(
			/hidden/,
		);
		const observable = page.locator("#observable-section");
		await expect(observable).not.toHaveClass(/hidden/);
		await expect(observable).toContainText("bob-api");
		await expect(observable).toContainText("read-only");
	});

	test("a lead observing a session gets a read-only attach (observe=true, input dropped)", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("lead");
		await app.openSidebar();
		await page.locator("#observable-list .session-item", { hasText: "bob-api" }).click();
		await expect(page.locator("#observe-modal")).toHaveClass(/open/);
		await expect(page.locator("#observe-modal-title")).toContainText('Observing "bob-api"');
		await expect(page.locator("#observe-take-control-btn")).toBeHidden();
		await expect.poll(() => backend.terminalSockets.length).toBe(1);
		expect(backend.terminalSockets[0]!.observe).toBe(true);
		await page.keyboard.type("rm -rf");
		await page.waitForTimeout(200);
		expect(backend.terminalSockets[0]!.sent.filter((f) => f.type === "input")).toEqual([]);
		await app.escape();
		await expect(page.locator("#observe-modal")).not.toHaveClass(/open/);
		await expect.poll(() => backend.terminalSockets[0]!.closed).toBe(true);
	});
});
