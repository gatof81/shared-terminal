import { expect, test } from "./fixtures.js";

test.describe("background sessions", () => {
	test("a conversation the server's probe reports as a background session says so, and Chat does not send", async ({
		app,
		backend,
		page,
	}) => {
		const c2 = backend.conversations[1]!;
		const events = c2.events.map((e) => ({ ...e }));
		const last = events[events.length - 1]!;
		const at = (n: number) => new Date(Date.parse(last.ts) + n * 1000).toISOString();
		const base = { prompt_id: null, turn_id: null, agent_id: null, pane: null };
		events.push(
			{ ...base, seq: last.seq + 1, ts: at(1), ev: "session_start", data: { source: "resume" } },
			{
				...base,
				seq: last.seq + 2,
				ts: at(4),
				ev: "probe",
				data: { status: "idle", kind: "background", verified: false },
			},
		);
		backend.conversations.push({
			...c2,
			cid: "conv-bg",
			title: "Architecture notes",
			status: "waiting_input",
			statusEvidence: "hook:Notification",
			paneId: null,
			canSendInput: false,
			events,
		});
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Architecture notes" }).click();
		await expect(page.locator(".chat-composer-status")).toContainText(
			"runs this conversation as a background session",
		);
		await expect(page.locator(".chat-send")).toBeDisabled();
		await expect(page.locator("#chat-thread .chat-thread-sub")).toContainText("background session");
		// Never a send from Chat.
		expect(backend.requests.some((r) => r.method === "POST" && r.path.endsWith("/messages"))).toBe(
			false,
		);
	});

	test("without a probe saying so, a conversation with no pane keeps the generic wording", async ({
		app,
		backend,
		page,
	}) => {
		const c2 = backend.conversations[1]!;
		backend.conversations.push({
			...c2,
			cid: "conv-nopane",
			title: "No pane yet",
			status: "waiting_input",
			statusEvidence: "hook:Notification",
			paneId: null,
			canSendInput: false,
			events: c2.events.map((e) => ({ ...e })),
		});
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "No pane yet" }).click();
		await expect(page.locator(".chat-composer-status")).toContainText(
			"can't tie this conversation",
		);
		await expect(page.locator("#chat-thread .chat-thread-sub")).not.toContainText(
			"background session",
		);
	});
});
