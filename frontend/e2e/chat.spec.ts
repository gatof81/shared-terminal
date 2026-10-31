import { expect, test } from "./fixtures.js";

test.describe("chat", () => {
	test("lists conversations, opens a thread, follows live events, keeps the terminal", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await app.switchView("chat");

		const rows = page.locator("#chat-list .chat-conv-row");
		await expect(rows).toHaveCount(2);
		await expect(rows.first()).toContainText("Refactor auth flow");
		await expect(rows.first()).toContainText("Waiting for input");

		await rows.first().click();
		const thread = page.locator("#chat-thread");
		await expect(thread.locator(".chat-user")).toContainText("Refactor the auth flow");
		await expect(thread.locator(".chat-assistant")).toContainText("moved the cookie check");
		await expect(thread.locator(".chat-tools")).toContainText("Edit");
		await expect(thread.locator(".chat-live")).toContainText("Live");

		// A new assistant message arrives over the socket while reading.
		backend.pushConversationEvent("conv-1", {
			ts: new Date().toISOString(),
			ev: "assistant_delta",
			prompt_id: "p2",
			turn_id: "t2",
			agent_id: null,
			pane: "%1",
			data: { message_id: "m2", index: 0, delta: "One more thing: run the tests.", final: true },
		});
		await expect(thread.locator(".chat-assistant").last()).toContainText("run the tests");

		// The terminal underneath is untouched by all of this.
		expect(backend.terminalSockets.filter((s) => !s.closed)).toHaveLength(1);
		await app.switchView("terminal");
		await expect(page.locator(".tab-pane.active")).toContainText("Welcome");
	});

	test("composer: a send shows a pending bubble that yields to the CLI's own prompt", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		const ta = page.locator(".chat-composer textarea");
		await expect(ta).toBeEnabled();
		await ta.fill("Also add a logout test.");
		await page.locator(".chat-send").click();
		await expect
			.poll(() => backend.requests.some((r) => r.method === "POST" && r.path.endsWith("/messages")))
			.toBe(true);
		const you = page.locator("#chat-thread .chat-user", { hasText: "Also add a logout test." });
		await expect(you).toHaveCount(1);
		await expect(you).not.toHaveClass(/chat-pending/);
		await expect(ta).toHaveValue("");
	});

	test("composer is disabled with a reason when the conversation cannot take input", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Fix tests" }).click();
		const ta = page.locator(".chat-composer textarea");
		await expect(ta).toBeDisabled();
		await expect(page.locator(".chat-composer-status")).toContainText(
			/not available|not at its prompt/,
		);
	});

	test("mobile: thread → back returns to the list and keeps the selection", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "single-pane layout only on mobile");
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Fix tests" }).click();
		await expect(page.locator("#chat-thread")).toBeVisible();
		await expect(page.locator("#chat-list")).toBeHidden();
		await page.click("#chat-back-btn");
		await expect(page.locator("#chat-list")).toBeVisible();
		await expect(page.locator("#chat-list .chat-conv-row.selected")).toContainText("Fix tests");
	});
});
