import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

const S = SESSION_IDS.running;

/**
 * The router (docs/design/ui-unificada.md §5.4, PR 5): the address bar
 * says session, view and detail; Back/Forward and the mobile back gesture
 * undo what the person opened; a reload restores the view; permissions and
 * unknown sessions behave as before; and none of it touches the terminal.
 */
test.describe("router", () => {
	test("the address follows the view and the detail; a view is a history entry, a tab switch is not", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await expect.poll(() => page.url()).toContain(`#/sessions/${S}/terminal/tab-1`);

		await app.switchView("files");
		await expect.poll(() => page.url()).toContain(`#/sessions/${S}/files`);
		await page.locator("#files-tree .files-row", { hasText: "src" }).click();
		await page.locator("#files-tree .files-row", { hasText: "auth.ts" }).click();
		await expect.poll(() => page.url()).toContain(`#/sessions/${S}/files/src/auth.ts`);

		await app.switchView("git");
		await page.locator("#git-list .git-row", { hasText: "auth.ts" }).click();
		await expect.poll(() => page.url()).toContain(`#/sessions/${S}/git/unstaged:src/auth.ts`);

		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Fix tests" }).click();
		await expect.poll(() => page.url()).toContain(`#/sessions/${S}/chat/conv-2`);

		await app.switchView("terminal");
		if (app.mobile) await page.click("#chrome-toggle");
		const depthBefore = await page.evaluate(
			() => (history.state as { st?: { n: number } })?.st?.n ?? 0,
		);
		await page.locator('#terminal-tabs [role="tab"]', { hasText: "Tab 2" }).click();
		await expect.poll(() => page.url()).toContain(`#/sessions/${S}/terminal/tab-2`);
		expect(await page.evaluate(() => (history.state as { st?: { n: number } })?.st?.n ?? 0)).toBe(
			depthBefore,
		);
		// Through all of it the first attach stayed; only the second tab added a socket.
		expect(backend.terminalSockets.map((s) => `${s.tabId}:${s.closed}`)).toEqual([
			"tab-1:false",
			"tab-2:false",
		]);
	});

	test("Back and Forward walk the views without touching the terminal", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.waitForTimeout(300);
		const sock = backend.terminalSockets[0]!;
		const frames = () => sock.sent.length;
		const sockets = backend.terminalSockets.length;

		await app.switchView("files");
		await app.switchView("git");
		await app.switchView("chat");
		const f0 = frames();
		await page.goBack();
		await app.expectView("git");
		await page.goBack();
		await app.expectView("files");
		await page.goForward();
		await app.expectView("git");
		await page.goBack();
		await page.goBack();
		await app.expectView("terminal");
		await page.waitForTimeout(300);
		// Pure view history: no socket, no resize, no input (the mobile
		// drawer hop that costs resizes in v1 is not part of Back/Forward).
		expect(backend.terminalSockets.length).toBe(sockets);
		expect(sock.closed).toBe(false);
		expect(frames() - f0, "frames sent during Back/Forward").toBe(0);
		await expect(page.locator(".tab-pane.active")).toContainText("Welcome");
	});

	test("Back undoes an opened file / diff / conversation; the chat history survives", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		const rows = page.locator("#chat-list .chat-conv-row");
		await rows.filter({ hasText: "Refactor auth flow" }).click();
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("cookie check");
		// The second conversation by address (on mobile the list pane is
		// hidden behind the thread); a hash assignment is a history entry.
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/chat/conv-2`);
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("All green");
		await page.goBack();
		await expect.poll(() => page.url()).toContain("/chat/conv-1");
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("cookie check");
		await page.goBack();
		await expect.poll(() => page.url()).toMatch(new RegExp(`#/sessions/${S}/chat$`));
		await expect(page.locator("#chat-list")).toBeVisible();
		if (app.mobile) await expect(page.locator("#chat-thread")).toBeHidden();
		// Forward brings the thread back from the cache (no events request).
		const events = page.locator("#chat-thread .chat-assistant");
		await page.goForward();
		await expect(events).toContainText("cookie check");

		await app.switchView("files");
		await page.locator("#files-tree .files-row", { hasText: "README.md" }).click();
		await expect(page.locator("#files-preview")).toContainText("sample workspace");
		await page.goBack();
		await expect.poll(() => page.url()).toMatch(new RegExp(`#/sessions/${S}/files$`));
		await expect(page.locator("#files-preview")).toContainText("Select a file");
		if (app.mobile) await expect(page.locator("#files-tree")).toBeVisible();
	});

	test("mobile: the in-app back shows the list in place; the back gesture walks history", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "single-pane layout only on mobile");
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("git");
		await page.locator("#git-list .git-row", { hasText: "auth.ts" }).click();
		await expect(page.locator("#git-diff")).toBeVisible();
		// ‹ Changes: the list, address updated in place (no new entry).
		await page.locator("#git-diff button", { hasText: "Changes" }).click();
		await expect(page.locator("#git-list")).toBeVisible();
		await expect.poll(() => page.url()).toMatch(new RegExp(`#/sessions/${S}/git$`));
		// The back gesture: the entry before the diff was opened — Git's list.
		await page.goBack();
		await expect(page.locator("#git-list")).toBeVisible();
		await expect.poll(() => page.url()).toMatch(new RegExp(`#/sessions/${S}/git$`));
		// And once more: back to the Terminal view the session opened on.
		await page.goBack();
		await app.expectView("terminal");
	});

	test("reload restores session, view and detail", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("git");
		await page.locator("#git-list .git-row", { hasText: "auth.ts" }).click();
		await expect(page.locator("#git-diff")).toContainText("cookie === null");
		await page.reload();
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await app.expectView("git");
		await expect(page.locator("#git-diff")).toContainText("cookie === null");
		await expect(page.locator("#git-list .git-row.selected")).toContainText("auth.ts");
	});

	test("deep links open a conversation, a file and a tab directly", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `#/sessions/${S}/chat/conv-1`);
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await app.expectView("chat");
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("cookie check");

		await page.goto(`/#/sessions/${S}/files/src/auth.ts`);
		await app.expectView("files");
		await expect(page.locator("#files-preview")).toContainText("export function login");
		await expect(page.locator("#files-breadcrumbs")).toContainText("auth.ts");

		await page.goto(`/#/sessions/${S}/terminal/tab-2`);
		await app.expectView("terminal");
		await expect(page.locator(".tab-pane.active")).toContainText("(tab-2)");
		// Landed straight on tab-2: tab-1 was never attached for this load.
		const since = backend.terminalSockets.filter((s) => !s.closed).map((s) => s.tabId);
		expect(since[since.length - 1]).toBe("tab-2");
	});

	test("a stopped session's deep link to the terminal shows its state; to chat shows the history", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/sessions/${SESSION_IDS.stopped}/terminal`);
		await expect(page.locator("#terminal-session-name")).toHaveText("docs");
		await app.expectView("terminal");
		await expect(page.locator("#terminal-state")).toContainText("stopped");
		await page.goto(`/#/sessions/${SESSION_IDS.stopped}/chat`);
		await app.expectView("chat");
		await expect(page.locator("#chat-list .chat-conv-row")).toHaveCount(2);
	});

	test("an unknown or foreign session: one toast, the address cleared, no request for it", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `#/sessions/${SESSION_IDS.bob}/chat/conv-1`);
		await expect(app.toast("Session not found")).toBeVisible();
		await expect.poll(() => page.url()).not.toContain(SESSION_IDS.bob);
		expect(backend.requests.filter((r) => r.path.includes(SESSION_IDS.bob))).toEqual([]);
		// A malformed route is simply ignored.
		await page.goto(`/#/sessions/${S}/settings`);
		await expect(page.locator("#empty-state")).toBeVisible();
	});

	test("a pasted address while the app is open switches session and view", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${SESSION_IDS.stopped}/files/README.md`);
		await expect(page.locator("#terminal-session-name")).toHaveText("docs");
		await app.expectView("files");
		await expect(page.locator("#files-preview")).toContainText("sample workspace");
	});
});
