import { expect, test } from "./fixtures.js";
import { PROJECT_SESSION_IDS, SESSION_IDS } from "./mockBackend.js";

const AGENT = PROJECT_SESSION_IDS.scratch; // @solo's session ("scratch")

/**
 * An ACP agent's session is opened like any session (3B F5: the agent is
 * talked to in its project's topics, there is no Chat view): Terminal when
 * running, Files when stopped, the view the person chose for it otherwise.
 * Nothing about the landing waits for the agents list.
 */
test.describe("an agent's session lands like any session", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("running: its Terminal, named by the agent; no Chat view, no Chat address", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("scratch");
		await app.expectView("terminal");
		await expect(page.locator("#terminal-session-name")).toHaveText("@solo");
		await expect(page.locator("#view-switch button")).toHaveCount(3);
		await expect(page.locator("#chat-view")).toHaveCount(0);
		// An old Chat address is no route: the session's own landing.
		await page.goto(`/#/sessions/${AGENT}/chat`);
		await app.expectView("terminal");
	});

	test("stopped: its Files, like any stopped session", async ({ app, backend }) => {
		backend.sessions.find((s) => s.sessionId === AGENT)!.status = "stopped";
		backend.sessions.find((s) => s.sessionId === AGENT)!.tabs = [];
		await app.login("alice");
		await app.openSession("scratch");
		await app.expectView("files");
	});
});

/**
 * Measured in the page: from the click on a row to the first frame that
 * shows the session's landing view (`view`: Git for my-project, whose saved
 * view it is; Files for the stopped docs).
 */
test.describe("a selection never waits for the agents list", { tag: "@any-viewport" }, () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(
			(sid) => localStorage.setItem(`st.view.${sid}`, "git"),
			SESSION_IDS.running,
		);
	});

	async function landingDelay(
		app: import("./fixtures.js").App,
		page: import("@playwright/test").Page,
		name: string,
		view: "files" | "git",
	): Promise<number> {
		await app.openSidebar();
		const row = app.sessionRow(name).locator(".session-select");
		await page.evaluate((view) => {
			const w = window as unknown as { __landed: number | null; __clicked: number | null };
			w.__landed = null;
			w.__clicked = null;
			document.addEventListener(
				"click",
				() => {
					w.__clicked = performance.now();
					const tick = () => {
						if (!document.getElementById(`${view}-view`)!.hidden) w.__landed = performance.now();
						else requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
				},
				{ capture: true, once: true },
			);
		}, view);
		await row.click();
		await app.expectView(view);
		return page.evaluate(() => {
			const w = window as unknown as { __landed: number; __clicked: number };
			return w.__landed - w.__clicked;
		});
	}

	test("a list that never answers delays no selection", async ({ app, backend, page }) => {
		backend.acpAgentsDelayMs = 600_000;
		await app.login("alice");
		expect(await landingDelay(app, page, "my-project", "git")).toBeLessThan(400);
		expect(await landingDelay(app, page, "docs", "files")).toBeLessThan(400);
	});
});

test.describe("the agents list's background retry", { tag: "@any-viewport" }, () => {
	test("reads nothing while the tab is hidden; one read when it shows again", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableAcp();
		let reads = 0;
		backend.override = async (method, path, route) => {
			if (method !== "GET" || path !== "/acp/agents") return false;
			reads++;
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: '{"error":"down"}',
			});
			return true;
		};
		await app.login("alice");
		await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
		const hide = (hidden: boolean) =>
			page.evaluate((h) => {
				Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
				document.dispatchEvent(new Event("visibilitychange"));
			}, hidden);
		await hide(true);
		const before = reads;
		// The first retry is due 5 s after the failure: past it, still nothing.
		await page.waitForTimeout(7_000);
		expect(reads, "no read while hidden").toBe(before);
		await hide(false);
		await expect.poll(() => reads).toBe(before + 1);
		await page.waitForTimeout(1_000);
		expect(reads, "one read, not a burst").toBe(before + 1);
	});
});
