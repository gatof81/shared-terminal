import { expect, test } from "./fixtures.js";
import { PROJECT_IDS } from "./mockBackend.js";

/**
 * Project Chat's header (UX iter3 D): on a v2 phone its row IS the app's bar
 * — title, the agents' group with ●N, ⋯ (which then also closes the page)
 * — and the thread gets its height; a header that says more (archived, an
 * error) stays in the page. On a v1 phone the app's header names the
 * project. On a desktop the page keeps its own header, with × and the
 * base controls.
 */
test.describe("Project Chat's header", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("a v2 phone: the page's header is the bar; ⋯ closes the page; the thread starts under the bar", async ({
		app,
		page,
		shell,
	}, info) => {
		test.skip(!(info.project.use.isMobile && shell === "v2"), "shell v2 on a phone");
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const head = page.locator("#project-view .pv-header");
		await expect(page.locator("#project-view .acp-agents-group")).toBeVisible();
		const bar = (await page.locator("header").boundingBox())!;
		const row = (await head.boundingBox())!;
		expect(Math.abs(row.y - bar.y)).toBeLessThanOrEqual(1);
		// It ends above the header's bottom line, which stays visible.
		expect(row.y + row.height).toBeLessThanOrEqual(bar.y + bar.height - 1);
		// The thread starts right under the bar: no row of its own above it.
		const thread = (await page.locator("#project-view .acp-chat-thread").boundingBox())!;
		expect(thread.y).toBeLessThan(bar.y + bar.height + 16);
		await expect(page.locator("header #terminal-toolbar")).toBeHidden();
		await expect(head.locator(".pv-close")).toBeHidden();
		await page.getByRole("button", { name: "Acciones del proyecto" }).click();
		await page.getByRole("menuitem", { name: "Cerrar" }).click();
		await expect(page.locator("#project-view")).toBeHidden();
	});

	test("a v2 phone: an archived project's header stays in the page, with what it says", async ({
		app,
		backend,
		page,
		shell,
	}, info) => {
		test.skip(!(info.project.use.isMobile && shell === "v2"), "shell v2 on a phone");
		const p = backend.projects.find((x) => x.projectId === PROJECT_IDS.hz)!;
		p.archivedAt = "2026-10-31T10:00:00Z";
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const head = page.locator("#project-view .pv-header");
		await expect(head).toContainText("archivado");
		expect(await head.evaluate((e) => getComputedStyle(e).position)).not.toBe("fixed");
	});

	test("a v1 phone names the project in the app's header", async ({ app, page, shell }, info) => {
		test.skip(!(info.project.use.isMobile && shell !== "v2"), "shell v1 on a phone");
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator("#header-project-title")).toHaveText("Educación HZ");
		await expect(page.locator("#header-project-title")).toBeVisible();
	});

	test("a desktop keeps the page's own header: × closes, the ⋯ has no 'Cerrar'", async ({
		app,
		page,
	}, info) => {
		test.skip(info.project.use.isMobile === true, "desktop");
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const close = page.getByRole("button", { name: "Cerrar el proyecto" });
		await expect(close).toBeVisible();
		await expect(close).toHaveClass(/\bbtn-icon\b/);
		await page.getByRole("button", { name: "Acciones del proyecto" }).click();
		await expect(page.getByRole("menuitem", { name: "Cerrar" })).toHaveCount(0);
		await page.keyboard.press("Escape");
		await close.click();
		await expect(page.locator("#project-view")).toBeHidden();
	});
});
