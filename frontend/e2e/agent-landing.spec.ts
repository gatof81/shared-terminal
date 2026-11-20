import { expect, test } from "./fixtures.js";
import { PROJECT_SESSION_IDS, SESSION_IDS } from "./mockBackend.js";

const AGENT = PROJECT_SESSION_IDS.scratch; // @solo's session ("scratch")

/**
 * An ACP agent's session lands on its Chat (viewPolicy.ts rule 0), in both
 * shells: running or stopped, unless the person chose another view for
 * that session; a route with a view still wins; a landing is never a
 * history entry and never flickers through Terminal while the agents list
 * is read. Traditional sessions keep each shell's landing (v1-landing,
 * chat-first).
 */
test.describe("an agent's session lands on its Chat", () => {
	test.use({ landing: "none" });
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
		await expect(page.locator("#acp-chat .acp-chat-title")).toContainText("@solo");
		await expect.poll(() => page.url()).toContain(`#/sessions/${AGENT}/chat`);
		expect(await page.evaluate(() => history.length), "a landing is not an entry").toBe(length);
		// The attach behind the overlay sends nothing on its own.
		await expect.poll(() => backend.terminalSockets.length).toBe(1);
		await page.waitForTimeout(300);
		expect(backend.terminalSockets[0]!.sent.filter((f) => f.type === "resize")).toEqual([]);
		// A traditional session still lands as its shell says.
		await app.openSession("my-project");
		if (app.shell === "v1") await app.expectTerminalReady();
		else await app.expectView("chat"); // v2: it has captured history
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
		backend.acpAgentsDelayMs = 600;
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
		await app.openSession("scratch");
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
		await expect(page.locator("#terminal-session-name")).toHaveText("nuevo-agente");
		await app.expectView("chat");
		await expect(page.locator("#acp-chat .acp-chat-title")).toContainText("@nuevo");
		expect(SESSION_IDS.running).not.toBe(sid);
	});
});
