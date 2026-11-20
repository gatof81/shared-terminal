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

	test("ACP chats: settings and the manage panel open, a refused model flagged", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableAcp();
		const solo = backend.acpAgents.find((a) => a.name === "solo")!;
		solo.projectId = PROJECT_IDS.hz;
		solo.model = "claude-opus-5-5";
		solo.modelApplied = { requested: "claude-opus-5-5", current: null, error: "no disponible" };
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		await expect(page.locator("#acp-chat .acp-settings-btn")).toBeVisible();
		// The headers and their panels (the thread's own badges are not part of this change).
		const chat = [
			"#acp-chat .acp-chat-header",
			"#acp-chat .acp-settings",
			"#acp-chat .acp-chat-composer",
		];
		await expectClean(page, "ACP chat, settings closed", chat);
		await page.locator("#acp-chat .acp-settings-btn").click();
		await expect(page.locator("#acp-chat .acp-model-select")).toBeVisible();
		await expectClean(page, "ACP chat, settings open", chat);
		await page.goto(`/#/projects/${PROJECT_IDS.hz}`);
		await page.getByRole("button", { name: "Acciones del proyecto" }).click();
		await page.getByRole("menuitem", { name: "Administrar agentes" }).click();
		await expect(page.locator("#project-view .acp-agents-panel")).toBeVisible();
		await expectClean(page, "Project Chat, manage panel open", [
			"#project-view .pv-header",
			"#project-view .acp-project-agents",
			"#project-view .acp-agents-panel",
			"#project-view .acp-chat-composer",
		]);
	});
});
