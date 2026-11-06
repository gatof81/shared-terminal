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

// v1.9 §8.1.12 (EXPERIMENTAL): the background transport, flag on (the mock
// marks the conversation `transport: "background"` and answers `accepted`).
test.describe("background transport (experimental)", () => {
	const seed = (
		backend: import("./mockBackend.js").MockBackend,
		bgOutcome: "delivered" | "unconfirmed" | "duplicated" | "possible-duplicate",
	) => {
		const c2 = backend.conversations[1]!;
		backend.conversations.push({
			...c2,
			cid: `conv-bgt-${bgOutcome}`,
			title: `Background ${bgOutcome}`,
			status: "waiting_input",
			statusEvidence: "hook:Stop",
			paneId: null,
			canSendInput: true,
			transport: "background",
			bgOutcome,
			events: c2.events.map((e) => ({ ...e })),
		});
	};
	const posts = (backend: import("./mockBackend.js").MockBackend) =>
		backend.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages")).length;

	test("one-time notice before the first send; accepted is not delivered; delivered clears the draft", async ({
		app,
		backend,
		page,
	}) => {
		seed(backend, "delivered");
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Background delivered" }).click();
		const ta = page.locator(".chat-composer textarea");
		await ta.fill("hello background");
		await page.locator(".chat-send").click();
		await expect(page.locator(".chat-composer-status")).toContainText("runs in the background");
		expect(posts(backend)).toBe(0);
		await page.getByRole("button", { name: "I understand — send" }).click();
		await expect(page.locator(".chat-composer-status")).toContainText(
			"Accepted by Claude Code — not yet delivered to Claude",
		);
		await expect(page.locator(".chat-composer-status")).not.toContainText("✓");
		await expect(ta).toHaveValue("hello background");
		await expect(ta).toBeDisabled();
		await expect(page.locator(".chat-composer-status")).toContainText("Delivered to Claude", {
			timeout: 5000,
		});
		await expect(ta).toHaveValue("");
		expect(posts(backend)).toBe(1);
	});

	test("unconfirmed keeps the draft and asks to check the Terminal", async ({
		app,
		backend,
		page,
	}) => {
		seed(backend, "unconfirmed");
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Background unconfirmed" }).click();
		const ta = page.locator(".chat-composer textarea");
		await ta.fill("maybe lost");
		await page.locator(".chat-send").click();
		await page.getByRole("button", { name: "I understand — send" }).click();
		await expect(page.locator(".chat-composer-status")).toContainText(
			"Not confirmed: it may have been lost or still be queued. Check the Terminal before resending.",
			{ timeout: 5000 },
		);
		await expect(ta).toHaveValue("maybe lost");
		await expect(page.getByRole("button", { name: "I checked the Terminal" })).toBeVisible();
	});

	// D4: a proven repetition and an unconfirmed one read differently.
	for (const [outcome, title, words, notWords] of [
		[
			"duplicated",
			"Background duplicated",
			"Strong evidence this message ran twice",
			"not confirmed",
		],
		[
			"possible-duplicate",
			"Background possible-duplicate",
			"may have run twice (not confirmed)",
			"Strong evidence",
		],
	] as const) {
		test(`${outcome} is its own visible marker in the thread`, async ({ app, backend, page }) => {
			seed(backend, outcome);
			await app.login("alice");
			await app.openSession("my-project");
			await app.switchView("chat");
			await page.locator("#chat-list .chat-conv-row", { hasText: title }).click();
			await page.locator(".chat-composer textarea").fill("run once");
			await page.locator(".chat-send").click();
			await page.getByRole("button", { name: "I understand — send" }).click();
			await expect(page.locator("#chat-thread .chat-marker", { hasText: words })).toBeVisible({
				timeout: 5000,
			});
			await expect(page.locator("#chat-thread .chat-marker", { hasText: notWords })).toHaveCount(0);
		});
	}
});
