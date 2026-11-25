import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * The sidebar tree (UX iter3 §1, alternative A): "+ New session" first,
 * then Projects with their agents, then the agents without a project, then
 * the sessions worked from their Terminal — whose ⋯ holds "Show terminated"
 * and Refresh.
 */
test.describe("sidebar tree", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("order: the primary action, Projects with their agents, agents without a project, Sessions", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("hz-architect")).toBeVisible();
		const top = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
		const order = [
			await top("#new-session-btn"),
			await top("#project-section-title"),
			await top(`.sgroup[data-group="${PROJECT_IDS.hz}"]`),
			await top("#ssection-title-agents"),
			await top("#ssection-title-sessions"),
		];
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// The old bar above the list is gone with the tree.
		await expect(page.locator("#sidebar-header")).toBeHidden();
		// Each kind of row in its own place.
		const agentRow = (name: string) => `.session-select[data-session-name="${name}"]`;
		const hz = page.locator(`.sgroup[data-group="${PROJECT_IDS.hz}"]`);
		await expect(hz.locator(agentRow("hz-architect"))).toHaveCount(1);
		await expect(page.locator(".ssection-agents").locator(agentRow("scratch"))).toHaveCount(1);
		const sessions = page.locator(".ssection-sessions");
		await expect(sessions.locator(".session-name", { hasText: /^my-project$/ })).toHaveCount(1);
		await expect(sessions.locator(".session-agent-item")).toHaveCount(0);
	});

	test("the Sessions ⋯ shows terminated sessions and refreshes the list", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("my-project")).toBeVisible();
		await expect(app.sessionRow("old-poc")).toHaveCount(0);
		const more = page.locator(".ssection-sessions .ssection-menu");
		await expect(more).toHaveAccessibleName("Sessions options");
		await more.click();
		await page.getByRole("menuitem", { name: /^Show terminated/ }).click();
		await expect(app.sessionRow("old-poc")).toBeVisible();
		await expect(page.locator("#show-terminated-toggle")).toBeChecked();
		// The same ⋯ says the other way round now.
		await app.openSidebar();
		await more.click();
		await expect(page.getByRole("menuitem", { name: /^Hide terminated/ })).toBeVisible();
		const reads = backend.requests.filter((r) => r.path.startsWith("/sessions")).length;
		await page.getByRole("menuitem", { name: /^Refresh/ }).click();
		await expect
			.poll(() => backend.requests.filter((r) => r.path.startsWith("/sessions")).length)
			.toBeGreaterThan(reads);
	});

	test("the selected row: accent background, a 3-px bar, aria-current; rows are 32 px with a mouse", async ({
		app,
	}, info) => {
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}`);
		await app.openSidebar();
		const row = app.sessionRow("scratch");
		await expect(row).toHaveClass(/\bactive\b/);
		await expect(row.locator(".session-select")).toHaveAttribute("aria-current", "true");
		const bar = await row.evaluate((e) => {
			const b = getComputedStyle(e, "::before");
			return { width: b.width, bg: getComputedStyle(e).backgroundColor };
		});
		expect(bar.width).toBe("3px");
		expect(bar.bg).not.toBe("rgba(0, 0, 0, 0)");
		if (!info.project.use.hasTouch)
			expect(Math.round((await app.sessionRow("my-project").boundingBox())!.height)).toBe(32);
	});
});

test.describe("sidebar tree on a phone", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("48-px rows; 44 px of backdrop to close it; the last row clear of the footer; focus in and back to ☰", async ({
		app,
		page,
	}, info) => {
		test.skip(!info.project.use.isMobile, "the phone's drawer");
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("hz-design")).toBeVisible();
		for (const name of ["hz-architect", "my-project"])
			expect(Math.round((await app.sessionRow(name).boundingBox())!.height)).toBe(48);
		// No hover on a touch screen: every row's ⋯ shows, not only the selected one's.
		for (const name of ["hz-architect", "my-project"])
			expect(
				await app
					.sessionRow(name)
					.locator(".session-menu-btn")
					.evaluate((e) => getComputedStyle(e).opacity),
			).toBe("1");
		const vw = page.viewportSize()!.width;
		const drawer = (await page.locator("#sidebar").boundingBox())!;
		expect(vw - (drawer.x + drawer.width)).toBeGreaterThanOrEqual(44);
		// Scrolled to its end, the last row sits above the footer (when there is one).
		const clear = await page.evaluate(() => {
			const list = document.getElementById("session-list")!;
			list.scrollTop = list.scrollHeight;
			const last = [...list.querySelectorAll(".session-item")].at(-1)!.getBoundingClientRect();
			const foot = document.getElementById("sidebar-footer")!.getBoundingClientRect();
			return foot.height === 0 || last.bottom <= foot.top;
		});
		expect(clear).toBe(true);
		// Focus: inside on open; the backdrop closes it and gives it back to ☰.
		await expect(page.locator("#sidebar")).toContainText("New session");
		expect(
			await page.evaluate(() =>
				document.getElementById("sidebar")!.contains(document.activeElement),
			),
		).toBe(true);
		await page.mouse.click(vw - 20, Math.round(drawer.height / 2));
		await expect(page.locator("main")).not.toHaveClass(/sidebar-open/);
		await expect(page.locator("#sidebar-toggle")).toBeFocused();
	});
});
