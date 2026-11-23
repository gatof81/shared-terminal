import { expect, test } from "./fixtures.js";
import { PROJECT_SESSION_IDS, SESSION_IDS } from "./mockBackend.js";

const AGENT = PROJECT_SESSION_IDS.scratch; // @solo's session ("scratch")

/**
 * An ACP agent's session lands on its Chat (viewPolicy.ts rule 0), in both
 * shells: running or stopped, unless the person chose another view for
 * that session; a route with a view still wins; a landing is never a
 * history entry and never flickers through Terminal while the agents list
 * is read. A traditional session lands on Terminal (running) or Files.
 */
test.describe("an agent's session lands on its Chat", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("selected from the sidebar: Chat, in place; the terminal attaches underneath untouched", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		const length = await page.evaluate(() => history.length);
		await app.openSession("scratch");
		await app.expectView("chat");
		await expect(page.locator("#terminal-session-name")).toHaveText("@solo");
		await expect.poll(() => page.url()).toContain(`#/sessions/${AGENT}/chat`);
		expect(await page.evaluate(() => history.length), "a landing is not an entry").toBe(length);
		// The attach behind the overlay sends nothing on its own.
		await expect.poll(() => backend.terminalSockets.length).toBe(1);
		await page.waitForTimeout(300);
		expect(backend.terminalSockets[0]!.sent.filter((f) => f.type === "resize")).toEqual([]);
		// A traditional session has no Chat: it lands on its Terminal.
		await app.openSession("my-project");
		await app.expectView("terminal");
		await expect(page.locator("#view-chat-btn")).toBeHidden();
	});

	test("a stopped agent's session also lands on Chat, with its history", async ({
		app,
		backend,
	}) => {
		backend.sessions.find((s) => s.sessionId === AGENT)!.status = "stopped";
		backend.sessions.find((s) => s.sessionId === AGENT)!.tabs = [];
		await app.login("alice");
		await app.openSession("scratch");
		await app.expectView("chat");
		await expect(app.page.locator("#acp-chat .acp-msg").first()).toContainText("Resumí el README");
	});

	test("the view the person chose for that session wins; an explicit address wins over all", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("scratch");
		await app.expectView("chat");
		await app.switchView("files");
		await app.openSession("docs");
		await app.openSession("scratch");
		await app.expectView("files");
		await page.goto(`/#/sessions/${AGENT}/terminal`);
		await app.expectTerminalReady();
		expect(page.url()).toContain(`#/sessions/${AGENT}/terminal`);
	});

	test("agents not read yet: the landing waits for the list, without passing through Terminal", async ({
		app,
		backend,
		page,
	}) => {
		// The agents list is held until the session has been clicked, then
		// let go explicitly: the click always finds the read in flight, and
		// the answer always lands inside the landing's wait. (A fixed delay
		// raced the click: on a fast machine the click came early enough for
		// the wait to run out first, and the landing decided without the list.)
		const held: Array<() => void> = [];
		let holding = true;
		backend.override = async (method, path) => {
			if (!holding || method !== "GET" || path !== "/acp/agents") return false;
			await new Promise<void>((r) => held.push(r));
			return false;
		};
		// Records whether a terminal pane was ever on screen uncovered (the
		// Terminal view shown before the landing decided).
		await page.addInitScript(() => {
			const w = window as unknown as { __termShown: boolean };
			w.__termShown = false;
			new MutationObserver(() => {
				const pane = document.querySelector("#terminal-container .tab-pane.active");
				const chat = document.getElementById("chat-view");
				if (pane && chat?.hidden) w.__termShown = true;
			}).observe(document, { subtree: true, childList: true, attributes: true });
		});
		await app.login("alice");
		await expect.poll(() => held.length, "the agents read is in flight").toBeGreaterThan(0);
		await app.openSidebar();
		await app.sessionRow("scratch").click();
		holding = false;
		for (const release of held.splice(0)) release();
		await app.expectView("chat");
		await page.waitForTimeout(300);
		expect(
			await page.evaluate(() => (window as unknown as { __termShown: boolean }).__termShown),
			"no Terminal before Chat",
		).toBe(false);
	});

	test("a session created with an agent opens on its Chat", async ({ app, backend, page }) => {
		const sid = "7c1f2c3d-0000-4000-8000-0000000000aa";
		backend.override = async (method, path, route) => {
			if (method !== "POST" || path !== "/sessions") return false;
			backend.sessions.push({
				sessionId: sid,
				ownerUserId: "u-alice",
				name: "nuevo-agente",
				status: "running",
				tabs: [{ tabId: "tab-1", label: "Tab 1", createdAt: Date.parse("2026-10-31T10:00:00Z") }],
				createdAt: backend.sessions[0]!.createdAt,
			});
			backend.acpAgents.push({
				...backend.acpAgents.find((a) => a.name === "solo")!,
				name: "nuevo",
				sessionId: sid,
				projectId: null,
			});
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({
					...backend.serialize(backend.sessions.at(-1)!),
					bootstrapping: false,
				}),
			});
			return true;
		};
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await page.fill("#new-session-input", "nuevo-agente");
		await page.fill("#new-session-acp-agent", "nuevo");
		await page.click("#new-session-submit");
		await expect(page.locator("#terminal-toolbar")).toHaveAttribute(
			"data-session-name",
			"nuevo-agente",
		);
		await app.expectView("chat");
		await expect(page.locator("#terminal-session-name")).toHaveText("@nuevo");
		expect(SESSION_IDS.running).not.toBe(sid);
	});
});

/**
 * The agents list is read when the session list first loads, so a selection
 * normally finds it there and waits for nothing; a list that never answers
 * costs one bounded wait (LANDING_AGENTS_WAIT_MS, 500 ms) per page load,
 * never one per selection. Measured in the page: from the click on a row to
 * the first frame that shows the session's landing view (`view`: Git for
 * my-project, whose saved view it is; Files for the stopped docs).
 */
test.describe("the agents list never makes every selection wait", { tag: "@any-viewport" }, () => {
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

	test("a list that never answers: the first selection waits once, the next one lands at once", async ({
		app,
		backend,
		page,
	}) => {
		backend.acpAgentsDelayMs = 600_000;
		await app.login("alice");
		const first = await landingDelay(app, page, "my-project", "git");
		expect(first, "the first selection waits for the list (bounded)").toBeGreaterThanOrEqual(400);
		const second = await landingDelay(app, page, "docs", "files");
		expect(second, "the second does not wait again").toBeLessThan(first - 200);
	});

	test("a list that answers: the first selection does not wait", async ({ app, backend, page }) => {
		backend.acpAgentsDelayMs = 50;
		await app.login("alice");
		await page.waitForTimeout(300); // the read at load has answered
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
