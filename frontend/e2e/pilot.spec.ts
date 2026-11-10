import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS } from "./mockBackend.js";

/**
 * Pilot 1 — "Ask the agents" (docs/design/project-chat/18, D-PIL1–D-PIL5).
 * Off unless `?pilot=1`; one ordinary Composer send per agent, independent,
 * never retried; replies attributed by the CLI's prompt id only; a forward
 * is pre-filled and leaves only on the person's click.
 */

const projectHash = `#/projects/${PROJECT_IDS.hz}`;

function panel(page: Page) {
	return page.locator("#project-view .pilot");
}
function agentBox(page: Page, handle: string) {
	return panel(page)
		.locator(".pilot-agent", { hasText: `@${handle}` })
		.locator("input");
}
function lane(page: Page, handle: string) {
	return panel(page)
		.locator(".pilot-exchange")
		.first()
		.locator(".pilot-lane", { has: page.locator(".pilot-handle", { hasText: `@${handle}` }) });
}

/** Every Composer POST the page makes: conversation, text and clientMessageId. */
function captureSends(page: Page): Array<{ url: string; text: string; id: string }> {
	const sends: Array<{ url: string; text: string; id: string }> = [];
	page.on("request", (r) => {
		if (r.method() === "POST" && /\/conversations\/[^/]+\/messages$/.test(r.url())) {
			const b = r.postDataJSON() as { text: string; clientMessageId: string };
			sends.push({ url: r.url(), text: b.text, id: b.clientMessageId });
		}
	});
	return sends;
}

test.describe("pilot — ask the agents", () => {
	test.beforeEach(({ backend }) => {
		backend.enableProjects();
		backend.seedPilot();
	});

	test("off unless ?pilot=1, and ?pilot=0 turns it off again", async ({ app, page }) => {
		await app.login("alice", projectHash);
		await expect(page.locator("#project-view .pv-title")).toHaveText("Educación HZ");
		await expect(panel(page)).toHaveCount(0);
		await app.login("alice", `?pilot=1${projectHash}`);
		await expect(panel(page)).toBeVisible();
		await expect(page).not.toHaveURL(/pilot=/); // stripped from the address, kept in this browser
		await app.login("alice", `?pilot=0${projectHash}`);
		await expect(page.locator("#project-view .pv-title")).toHaveText("Educación HZ");
		await expect(panel(page)).toHaveCount(0);
	});

	test("one message to three agents: three independent sends, a busy one never blocks the others, nothing retried", async ({
		app,
		page,
	}) => {
		const sends = captureSends(page);
		await app.login("alice", `?pilot=1${projectHash}`);
		for (const h of ["architect-hz", "developer-hz-2", "designer-hz"]) {
			await expect(agentBox(page, h)).toBeEnabled();
			await agentBox(page, h).check();
		}
		await panel(page).locator(".pilot-text").fill("Plan the import, please.");
		await panel(page).locator(".pilot-send").click();

		await expect(lane(page, "architect-hz").locator(".pilot-state")).toHaveText("Delivered");
		await expect(lane(page, "architect-hz").locator(".pilot-answer")).toHaveText(
			"Plan: split the import into two steps.",
		);
		await expect(lane(page, "developer-hz-2").locator(".pilot-answer")).toHaveText(
			"Review: step two needs a rollback.",
		);
		await expect(lane(page, "designer-hz").locator(".pilot-state")).toHaveText(
			"Claude is busy; wait for the turn to finish.",
		);
		// Each agent's answer is only under its own lane.
		await expect(lane(page, "designer-hz").locator(".pilot-answer")).toHaveCount(0);
		await expect(lane(page, "architect-hz")).not.toContainText("rollback");

		expect(sends).toHaveLength(3);
		expect(new Set(sends.map((s) => s.id)).size).toBe(3);
		expect(sends.every((s) => s.text === "Plan the import, please.")).toBe(true);
		await page.waitForTimeout(1500);
		expect(sends).toHaveLength(3); // the busy one is never retried
	});

	test("forward: pre-filled, editable, sent only on the person's click, to the others", async ({
		app,
		page,
	}) => {
		const sends = captureSends(page);
		await app.login("alice", `?pilot=1${projectHash}`);
		await agentBox(page, "architect-hz").check();
		await panel(page).locator(".pilot-text").fill("What is the plan?");
		await panel(page).locator(".pilot-send").click();
		await expect(lane(page, "architect-hz").locator(".pilot-lane-foot")).toContainText("Finished.");
		expect(sends).toHaveLength(1);

		await lane(page, "architect-hz").locator(".pilot-forward").click();
		const text = panel(page).locator(".pilot-text");
		await expect(text).toHaveValue("From @architect-hz:\n\nPlan: split the import into two steps.");
		await expect(panel(page).locator(".pilot-notice")).toContainText(
			"nothing is sent until you click",
		);
		await expect(agentBox(page, "architect-hz")).not.toBeChecked();
		await expect(agentBox(page, "developer-hz-2")).toBeChecked();
		await page.waitForTimeout(500);
		expect(sends).toHaveLength(1); // nothing left on its own

		await agentBox(page, "designer-hz").uncheck();
		await text.fill(
			"From @architect-hz:\n\nPlan: split the import into two steps.\n\nPlease review.",
		);
		await panel(page).locator(".pilot-send").click();
		await expect(panel(page).locator(".pilot-exchange").first()).toContainText(
			"forwarded from @architect-hz",
		);
		await expect(lane(page, "developer-hz-2").locator(".pilot-state")).toHaveText("Delivered");
		expect(sends).toHaveLength(2);
		expect(sends[1]!.text).toContain("Please review.");
		expect(sends[1]!.url).toContain("c-pilot-dev2");
	});

	test("the draft and the selection survive the page's polls", async ({ app, page }) => {
		await app.login("alice", `?pilot=1${projectHash}`);
		await agentBox(page, "architect-hz").check();
		const text = panel(page).locator(".pilot-text");
		await text.fill("half a thought");
		await text.focus();
		await page.waitForTimeout(6000); // > one 5 s poll of the page
		await expect(text).toHaveValue("half a thought");
		await expect(text).toBeFocused();
		await expect(agentBox(page, "architect-hz")).toBeChecked();
	});
});
