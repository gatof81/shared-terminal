// A session list requested BEFORE a session was created must not wipe that
// session from the sidebar when its (older) answer lands after the creation
// (seen in the lab: an agent session vanished until the next 15 s poll).

import { expect, test } from "./fixtures.js";
import type { MockSession } from "./mockBackend.js";

test("a stale list answer does not hide a session created meanwhile", async ({
	page,
	app,
	backend,
}) => {
	const serialize = (s: MockSession) =>
		(backend as unknown as { serialize: (x: MockSession) => unknown }).serialize(s);
	await app.login("alice");
	let release!: () => void;
	const held = new Promise<void>((r) => {
		release = r;
	});
	let answered!: () => void;
	const staleAnswered = new Promise<void>((r) => {
		answered = r;
	});
	let hold = false;
	backend.override = async (method, path, route) => {
		if (method === "GET" && path === "/sessions" && hold) {
			hold = false;
			// The list as the server read it when the request arrived: before the creation.
			const before = backend.sessions
				.filter((s) => s.ownerUserId === "u-alice" && s.status !== "terminated")
				.map(serialize);
			await held;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(before),
			});
			answered();
			return true;
		}
		if (method === "POST" && path === "/sessions") {
			const s: MockSession = {
				sessionId: "eeeeeeee-5555-4555-8555-555555555555",
				ownerUserId: "u-alice",
				name: "nueva",
				status: "running",
				tabs: [{ tabId: "tab-1", label: "Tab 1", createdAt: Date.parse("2026-10-31T10:29:00Z") }],
				createdAt: "2026-10-31T10:29:00Z",
			};
			backend.sessions.push(s);
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify(serialize(s)),
			});
			return true;
		}
		return false;
	};
	await app.openSidebar();
	// A list refresh leaves (the 15 s poll, a click) and is still on its way…
	hold = true;
	await app.refreshSessions();
	// …while the person creates a session.
	await page.click("#new-session-btn");
	await page.fill("#new-session-input", "nueva");
	await page.click("#new-session-submit");
	await expect(page.locator("#new-session-modal")).not.toHaveClass(/open/);
	await expect(page.locator("#session-list .session-name", { hasText: /^nueva$/ })).toHaveCount(1);
	// The older answer lands last: the list must still show the new session
	// right then — not only after some later refresh repairs it.
	release();
	await staleAnswered;
	await page.waitForTimeout(150);
	expect(await page.locator("#session-list .session-name").allTextContents()).toContain("nueva");
});
