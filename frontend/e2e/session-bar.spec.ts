import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

/**
 * The session bar is one line whatever it holds (terminal.css): its height
 * is part of the terminal's box. Found by the 2026-11-13 UX audit — a
 * 46-character name wrapped the v1 bar at 1440 px.
 */
const LONG = "shared-terminal-backend-recreate-engine-hotfix-and-then-some-more";

test.describe("session bar", () => {
	test("a long session name never makes the bar taller, at any desktop width", async ({
		app,
		backend,
		page,
	}) => {
		test.skip(app.mobile, "the phone bar has its own layout (drawer / merged header)");
		// Bound to an agent: the bar also carries "@handle · project".
		backend.enableProjects();
		await app.login("alice");
		await app.openSession("my-project");
		const bar = page.locator("#terminal-toolbar");
		await expect(page.locator("#terminal-session-agent")).toBeVisible();
		const short = (await bar.boundingBox())!.height;

		backend.session(SESSION_IDS.running)!.name = LONG;
		for (const width of [1920, 1440, 1280, 1024]) {
			await page.setViewportSize({ width, height: 800 });
			await page.reload();
			const name = page.locator("#terminal-session-name");
			await expect(name).toHaveText(LONG);
			expect((await bar.boundingBox())!.height, `bar height at ${width}px`).toBe(short);
			await expect(page.locator("#terminal-session-agent")).toBeVisible();
			// #terminal-area clips, so a too-wide bar never widens the page:
			// measure the bar itself — no control may be pushed out of it.
			const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
			expect(overflow, `bar overflow at ${width}px`).toBeLessThanOrEqual(0);
		}
		// The full name stays reachable when it is cut.
		await expect(page.locator("#terminal-session-name")).toHaveAttribute("title", LONG);
	});

	test("Git: a changed file is a plain button; the open one is aria-current", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("git");
		const row = page.locator("#git-list .git-row", { hasText: "auth.ts" });
		// A <button role="listitem" aria-pressed> is two ARIA errors (axe
		// aria-allowed-role, aria-allowed-attr).
		await expect(row).not.toHaveAttribute("role", /.*/);
		await expect(row).not.toHaveAttribute("aria-pressed", /.*/);
		await row.click();
		await expect(page.locator("#git-diff")).toContainText("cookie === null");
		await expect(row).toHaveAttribute("aria-current", "true");
		await expect(page.locator("#git-list .git-row[aria-current]")).toHaveCount(1);
	});
});
