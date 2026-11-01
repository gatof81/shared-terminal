import { expect, FIXED_NOW, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

const S = SESSION_IDS.running;
const STOPPED = SESSION_IDS.stopped;

/**
 * The landing policy (docs/design/ui-unificada.md §9, decision 1;
 * viewPolicy.ts), shell v2 only: the person's last view for the session,
 * else Chat with captured history, else Terminal (running) / Files
 * (stopped). A route with a view wins; a landing writes the address in
 * place and never adds a history entry; the terminal underneath is
 * attached exactly as before and never resized by any of it.
 */
test.describe("chat-first landing", () => {
	test.skip(({ shell }) => shell !== "v2", "v2 only");
	test.use({ landing: "none" });

	test("a running session with history lands on Chat; the terminal attaches underneath, untouched", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		const length = await page.evaluate(() => history.length);
		await app.openSession("my-project");
		await app.expectView("chat");
		await expect(page.locator("#chat-list .chat-conv-row")).toHaveCount(2);
		expect(page.url()).toContain(`#/sessions/${S}/chat`);
		expect(await page.evaluate(() => history.length), "a landing is not an entry").toBe(length);
		// One attach for the session's first tab, behind the overlay (it
		// sends nothing on its own: no resize, no input).
		await expect.poll(() => backend.terminalSockets.length).toBe(1);
		const sock = backend.terminalSockets[0]!;
		await page.waitForTimeout(300);
		const frames = sock.sent.length;
		await app.switchView("terminal");
		await app.expectTerminalReady();
		await page.waitForTimeout(300);
		expect(sock.sent.length - frames, "no frame sent by the switch").toBe(0);
		expect(backend.terminalSockets, "no second socket").toHaveLength(1);
	});

	test("a running session without history lands on Terminal", async ({ app, backend, page }) => {
		backend.historySessions.delete(S);
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		expect(page.url()).toContain(`#/sessions/${S}/terminal`);
	});

	test("stopped: Chat with history, Files without", async ({ app, backend, page }) => {
		await app.login("alice");
		await app.openSession("docs");
		await app.expectView("chat");
		expect(page.url()).toContain(`#/sessions/${STOPPED}/chat`);
		backend.historySessions.delete(STOPPED);
		await app.openSidebar();
		await page.locator("#show-terminated-toggle").check();
		await app.openSession("old-poc");
		await app.expectView("files");
		expect(page.url()).toContain(`#/sessions/${SESSION_IDS.terminated}/files`);
	});

	test("the person's last view for a session wins its next landing; a route's view wins the route", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectView("chat");
		await app.switchView("git");
		await app.openSession("docs");
		await app.expectView("chat");
		await app.openSession("my-project");
		await app.expectView("git");
		// Reload: the memory is per browser.
		await page.reload();
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await app.expectView("git");
		// An explicit view in the address is applied as is, and does not become the preference.
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/files`);
		await app.expectView("files");
		await app.openSession("docs");
		await app.openSession("my-project");
		await app.expectView("git");
	});

	test("Chat reopens the last conversation read, in place; Back to the list is not undone", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Fix tests" }).click();
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("All green");
		await app.openSession("docs");
		const length = await page.evaluate(() => history.length);
		await app.openSession("my-project");
		await app.expectView("chat");
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("All green");
		expect(page.url()).toContain(`#/sessions/${S}/chat/conv-2`);
		expect(await page.evaluate(() => history.length), "the restore adds no entry").toBe(length);
		// Back to the list (in app): the list stays, nothing reopens.
		if (app.mobile) await page.click("#chat-back-btn");
		else await page.goBack();
		await expect(page.locator("#chat-list .chat-conv-row.selected")).toHaveCount(0);
		await page.waitForTimeout(400);
		await expect(page.locator("#chat-list .chat-conv-row.selected")).toHaveCount(0);
		// A route naming no conversation wins over the memory.
		await app.openSession("docs");
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/chat`);
		await app.expectView("chat");
		await page.waitForTimeout(400);
		await expect(page.locator("#chat-list .chat-conv-row.selected")).toHaveCount(0);
	});

	test("P2-A: a view picked while the landing is still deciding stands — on screen, in the address and as the preference", async ({
		app,
		backend,
		page,
	}) => {
		// The history answer arrives first, the tabs much later: the landing
		// (Chat) resolves only after the tabs, and the person has clicked by then.
		backend.delays = { tabs: 1500 };
		await app.login("alice");
		const length = await page.evaluate(() => history.length);
		await app.openSidebar();
		await app.sessionRow("my-project").click();
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await expect
			.poll(() => backend.requests.some((r) => r.path.endsWith("/conversations?capture=0")))
			.toBe(true);
		await page.click("#view-files-btn");
		await app.expectView("files");
		expect(page.url()).toContain(`#/sessions/${S}/files`);
		// The tabs land, the landing continuation runs: nothing changes.
		await expect.poll(() => backend.terminalSockets.length, { timeout: 10_000 }).toBe(1);
		await page.waitForTimeout(500);
		await app.expectView("files");
		expect(page.url()).toContain(`#/sessions/${S}/files`);
		expect(await page.evaluate((k) => localStorage.getItem(k), `st.view.${S}`)).toBe("files");
		// The click is the one entry; neither the selection nor the landing added any.
		expect(await page.evaluate(() => history.length)).toBe(length + 1);
	});

	test("P2-C: #/sessions/<id> on a fresh load lands by policy, the address says the view, no entry is added, later writes flow", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		const base = await page.evaluate(() => history.length);
		await page.goto(`/#/sessions/${S}`);
		await app.expectView("chat");
		await expect(page.locator("#chat-list .chat-conv-row")).toHaveCount(2);
		await expect.poll(() => page.url()).toContain(`#/sessions/${S}/chat`);
		// The navigation itself is the one entry; the landing added none.
		expect(await page.evaluate(() => history.length)).toBe(base + 1);
		// The route's suppression is over: a manual selection reaches the address.
		await app.openSession("docs");
		await expect.poll(() => page.url()).toContain(`#/sessions/${STOPPED}/chat`);
		expect(await page.evaluate(() => history.length)).toBe(base + 1);
	});

	test("an unknown session asks once, then remembers", async ({ app, backend, page }) => {
		await app.login("alice");
		const listCalls = () =>
			backend.requests.filter(
				(r) => r.method === "GET" && r.path.endsWith("/conversations?capture=0"),
			).length;
		await app.openSession("my-project");
		await app.expectView("chat");
		await app.switchView("terminal");
		await app.openSession("docs");
		await app.openSession("my-project");
		await app.expectView("terminal");
		await page.waitForTimeout(300);
		// The landing itself asked once per session; later landings came from memory.
		expect(listCalls()).toBeLessThanOrEqual(2);
	});
});

test.describe("chat states", () => {
	test("empty list: capture pending, capture off, and no conversations read differently; a failed load offers Retry", async ({
		app,
		backend,
		page,
	}) => {
		backend.historySessions.clear();
		backend.capture = { requested: true, effective: false, effectiveAfterRestart: true };
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		const empty = page.locator("#chat-list .chat-empty");
		await expect(empty).toContainText("not active yet");
		await expect(empty).toHaveAttribute("data-reason", "pending");

		backend.capture = { requested: false, effective: false, effectiveAfterRestart: false };
		await page.click("#chat-refresh-btn");
		await expect(empty).toContainText("Capture is off");
		await expect(empty).toHaveAttribute("data-reason", "off");

		backend.capture = { requested: true, effective: true, effectiveAfterRestart: true };
		await page.click("#chat-refresh-btn");
		await expect(empty).toContainText("No conversations recorded yet");
		await expect(empty).toHaveAttribute("data-reason", "none");

		backend.override = async (method, path, route) => {
			if (method === "GET" && path.includes("/conversations")) {
				await route.fulfill({ status: 500, body: JSON.stringify({ error: "disk unavailable" }) });
				return true;
			}
			return false;
		};
		await page.click("#chat-refresh-btn");
		await expect(page.locator("#chat-list")).toContainText("Could not load the conversations");
		backend.override = null;
		await page.locator("#chat-list button", { hasText: "Retry" }).click();
		await expect(empty).toContainText("No conversations recorded yet");
	});

	test("an ended conversation says so in the composer; a permission prompt and a working turn too", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		const row = (title: string) => page.locator("#chat-list .chat-conv-row", { hasText: title });
		const toList = async () => {
			if (app.mobile) await page.click("#chat-back-btn");
		};
		await expect(row("Fix tests")).toContainText("Ended");
		await row("Fix tests").click();
		await expect(page.locator(".chat-thread-head .chat-status")).toContainText("Ended");
		await expect(page.locator(".chat-composer-status")).toContainText("has ended");
		await toList();
		// The list's status is the summary's; the composer explains the same thing.
		const conv = backend.conversations.find((c) => c.cid === "conv-1")!;
		// Fresh evidence: a live claim older than a few minutes does not block the composer.
		conv.events[conv.events.length - 1]!.ts = FIXED_NOW;
		conv.status = "waiting_permission";
		await page.click("#chat-refresh-btn");
		await expect(row("Refactor auth flow")).toContainText("Needs permission");
		await row("Refactor auth flow").click();
		await expect(page.locator(".chat-composer-status")).toContainText("permission prompt");
		await toList();
		conv.status = "running";
		await page.click("#chat-refresh-btn");
		await expect(row("Refactor auth flow")).toContainText("Working");
		await row("Refactor auth flow").click();
		await expect(page.locator(".chat-composer-status")).toContainText("Claude is working");
	});
});
