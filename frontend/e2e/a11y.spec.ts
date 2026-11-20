import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS, SESSION_IDS } from "./mockBackend.js";

/**
 * Accessibility sweep (UX audit A1–A4): axe-core over the main views, in
 * every project (both shells, desktop and phone). The bar is "no critical
 * or serious violation" — the WCAG A/AA rules a screen-reader or keyboard
 * user actually trips on. A new violation fails here with its rule and the
 * element, instead of waiting for the next manual audit.
 */

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

interface Violation {
	id: string;
	impact: string | null;
	nodes: string[];
}

async function violations(page: Page, include?: string[]): Promise<Violation[]> {
	await page.evaluate(AXE);
	return page.evaluate(async (inc) => {
		// biome-ignore lint/suspicious/noExplicitAny: axe is injected as a page global.
		const res = await (window as any).axe.run(inc ? { include: inc.map((x) => [x]) } : document, {
			runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
		});
		// biome-ignore lint/suspicious/noExplicitAny: axe's result shape.
		return res.violations.map((v: any) => ({
			id: v.id,
			impact: v.impact,
			// biome-ignore lint/suspicious/noExplicitAny: axe's result shape.
			nodes: v.nodes.map((n: any) => n.target.join(" ")),
		}));
	}, include);
}

async function expectClean(page: Page, view: string, include?: string[]): Promise<void> {
	const bad = (await violations(page, include)).filter(
		(v) => v.impact === "critical" || v.impact === "serious",
	);
	expect(bad, `axe on ${view}`).toEqual([]);
}

test.describe("accessibility — axe on the main views", () => {
	test("session views: Terminal, Files, Git, Chat", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		// Phones (v1): the tabs live in the chrome drawer.
		await app.openChrome();
		await expect(page.locator("#terminal-tabs .tab-chip-btn")).toHaveCount(2);
		await expectClean(page, "terminal");
		for (const view of ["files", "git", "chat"]) {
			await page.goto(`/#/sessions/${SESSION_IDS.running}/${view}`);
			await expect(page.locator(`#${view}-view`)).toBeVisible();
			await expectClean(page, view);
		}
	});

	test("sidebar tree and a project page", async ({ app, backend, page }) => {
		backend.enableProjects();
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator("#project-view .pv-title")).toBeVisible();
		await expectClean(page, "project page");
		await app.openSidebar();
		await expect(app.sessionRow("hz-architect")).toBeVisible();
		await expectClean(page, "sidebar");
	});

	test("sidebar with agents: free, working, waiting for you, login", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableAcp();
		const set = (name: string, p: Record<string, unknown>) =>
			Object.assign(backend.acpAgents.find((a) => a.name === name)!, p);
		set("arq", { runnerSeenAt: "2026-10-31T10:29:58Z" });
		set("dev", { runnerSeenAt: "2026-10-31T10:29:58Z", running: 12 });
		set("solo", { runnerSeenAt: "2026-10-31T10:29:58Z", waitingInput: true });
		backend.acpAgents.push({
			...backend.acpAgents[0]!,
			name: "dis",
			sessionId: PROJECT_SESSION_IDS.designer,
			authRequired: true,
		});
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("scratch").locator(".session-agent-status")).toHaveText(
			"te espera",
		);
		await expectClean(page, "sidebar with agents", ["#session-list"]);
	});
});
