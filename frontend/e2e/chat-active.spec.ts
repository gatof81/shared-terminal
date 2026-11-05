import { expect, test } from "./fixtures.js";

/**
 * The list's "Live" section (v1.8: renamed from "Active", now a filter) and the composer's reasons follow the
 * backend's status AND the age of its evidence (conversationModel
 * presentStatus): a live claim nobody has confirmed for 10 minutes, an
 * `unknown` conversation and one without a pane are listed under
 * "Earlier", stay readable, and explain why Chat cannot send to them.
 * The fixed test clock is 2026-10-31T10:30:00Z.
 */
test.describe("chat: active vs earlier", () => {
	test("stale, unknown and pane-less conversations are Earlier, readable, and say why they cannot take input", async ({
		app,
		backend,
		page,
	}) => {
		const [c1, c2] = backend.conversations;
		// conv-1: claims "waiting_input" but the last evidence is 20 min old.
		c1!.statusAt = "2026-10-31T10:10:00Z";
		c1!.canSendInput = true;
		// A third conversation: resumed, no report yet.
		backend.conversations.push({
			...c2!,
			cid: "conv-3",
			title: "Resumed session",
			status: "unknown",
			statusEvidence: "created",
			canSendInput: true,
			events: c2!.events.map((e) => ({ ...e })),
		});
		// A fourth: lost its pane to another conversation.
		backend.conversations.push({
			...c2!,
			cid: "conv-4",
			title: "Displaced session",
			status: "unknown",
			statusEvidence: "binding_lost",
			paneId: null,
			canSendInput: false,
			events: c2!.events.map((e) => ({ ...e })),
		});
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");

		const list = page.locator("#chat-list");
		await expect(list.locator(".chat-conv-row")).toHaveCount(4);
		// Nothing is active: no "Active"/"Earlier" split, no "N active" count.
		await expect(list.locator(".chat-list-title")).toHaveCount(0);
		await expect(page.locator("#chat-summary .chat-summary-active")).toHaveCount(0);
		const row = (title: string) => list.locator(".chat-conv-row", { hasText: title });
		await expect(row("Refactor auth flow")).toContainText("No recent activity");
		await expect(row("Resumed session")).toContainText("State unknown");
		await expect(row("Displaced session")).toContainText("State unknown");

		// Unknown: readable, and the composer explains how it resolves.
		await row("Resumed session").click();
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("All green");
		await expect(page.locator(".chat-composer textarea")).toBeDisabled();
		await expect(page.locator(".chat-composer-status")).toContainText("State unknown");
		await expect(page.locator(".chat-composer-status")).toContainText("Terminal");
		if (app.mobile) await page.click("#chat-back-btn");

		// No pane: readable, and the reason is the pane, not a generic refusal.
		await row("Displaced session").click();
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("All green");
		await expect(page.locator(".chat-composer-status")).toContainText(
			"no longer has a terminal pane",
		);
	});

	test("a conversation still bound to its pane that cannot take input does not claim the pane was lost", async ({
		app,
		backend,
		page,
	}) => {
		// Bound (paneId set) and fresh, but not sendable for another reason
		// (e.g. the viewer may not operate it): the generic reason, not "no pane".
		const c1 = backend.conversations[0]!;
		c1.canSendInput = false;
		c1.paneId = "%1";
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		const status = page.locator(".chat-composer-status");
		await expect(status).toContainText("Sending from Chat is not available");
		await expect(status).not.toContainText("no longer has a terminal pane");
	});

	test("a long turn that keeps emitting events stays Active although its status time is old", async ({
		app,
		backend,
		page,
	}) => {
		// running since 10:05, last tool event at 10:29 (the clock is 10:30):
		// the backend renews statusAt only on transitions.
		const c1 = backend.conversations[0]!;
		c1.status = "running";
		c1.statusAt = "2026-10-31T10:05:00Z";
		c1.events.push({
			seq: (c1.events.at(-1)?.seq ?? 0) + 1,
			ts: "2026-10-31T10:29:00Z",
			ev: "tool_start",
			prompt_id: "p-long",
			turn_id: "t-long",
			agent_id: null,
			pane: "%1",
			data: { tool_use_id: "tu-long", tool_name: "Bash", summary: { program: "npm" } },
		});
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		const row = page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" });
		await expect(row).toContainText("Working");
		await expect(page.locator("#chat-summary .chat-summary-active")).toHaveText("1 live");
	});

	test("a fresh live claim is the one Active conversation, counted once", async ({
		app,
		backend,
		page,
	}) => {
		backend.conversations[0]!.statusAt = "2026-10-31T10:29:00Z";
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		const list = page.locator("#chat-list");
		await expect(list.locator(".chat-list-title")).toHaveText(["Live", "Earlier"]);
		await expect(page.locator("#chat-summary .chat-summary-active")).toHaveText("1 live");
		await expect(list.locator(".chat-conv-row").first()).toContainText("Waiting for input");
	});

	test("'Open terminal' from a busy conversation lands on that conversation's tab, not the active one", async ({
		app,
		backend,
		page,
	}) => {
		const c1 = backend.conversations[0]!;
		c1.status = "running";
		c1.tabId = "tab-2";
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await expect(page.locator("#terminal-tabs .tab-chip.active")).toHaveAttribute(
			"data-tab-id",
			"tab-1",
		);
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		const link = page.locator(".chat-composer-status button", { hasText: "Open terminal" });
		await expect(link).toHaveText("Open terminal · Tab 2");
		await link.click();
		await expect(page.locator("#terminal-tabs .tab-chip.active")).toHaveAttribute(
			"data-tab-id",
			"tab-2",
		);
		await expect(page.locator("#terminal-container .tab-pane.active")).toContainText("(tab-2)");
	});
});
