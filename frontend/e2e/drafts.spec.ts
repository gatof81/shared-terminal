import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

const S = SESSION_IDS.running;
const CONV = "Refactor auth flow";

test.describe("composer drafts", () => {
	test("an unsent draft survives a reload and another project; a delivered send clears it", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: CONV }).click();
		const ta = page.locator(".chat-composer textarea");
		await expect(ta).toBeEnabled();
		await ta.fill("Half-written thought");

		// A fresh page on that conversation (on a phone, chat-first already
		// reopens it in place, so the list row is not the way back).
		await app.login("alice", `#/sessions/${S}/chat/conv-1`);
		await expect(ta).toHaveValue("Half-written thought");
		// Restored as text only: nothing was sent.
		expect(backend.requests.some((r) => r.method === "POST" && r.path.endsWith("/messages"))).toBe(
			false,
		);

		await ta.fill("Half-written thought, finished.");
		await page.locator(".chat-send").click();
		await expect(ta).toHaveValue("");
		await app.login("alice", `#/sessions/${S}/chat/conv-1`);
		await expect(ta).toBeEnabled();
		await expect(ta).toHaveValue("");
	});

	test("logout forgets every draft on this browser", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: CONV }).click();
		await page.locator(".chat-composer textarea").fill("private words");
		await expect
			.poll(() =>
				page.evaluate(
					() => Object.keys(localStorage).filter((k) => k.startsWith("st.draft.")).length,
				),
			)
			.toBe(1);
		await app.appMenu("logout-btn");
		await expect(page.locator("#auth-view")).toBeVisible();
		expect(
			await page.evaluate(
				() => Object.keys(localStorage).filter((k) => k.startsWith("st.draft.")).length,
			),
		).toBe(0);
	});
});
