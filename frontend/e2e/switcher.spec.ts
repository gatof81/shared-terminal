import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

/**
 * switcher.spec.ts — "Go to a conversation": every conversation of the
 * person's running projects, the ones that need them first; a stale wait is
 * never "needs you"; a failed project says so (and can be retried) while the
 * others stay navigable; opening only navigates (GETs only, terminal
 * untouched); Ctrl/⌘+K never fires while typing.
 */

async function openSwitcher(
	app: import("./fixtures.js").App,
	page: import("@playwright/test").Page,
): Promise<void> {
	if (app.mobile) {
		await app.openSidebar();
		await page.click("#sidebar-switcher-btn");
	} else {
		await page.click("#switcher-btn");
	}
	await expect(page.locator(".switcher-card")).toBeVisible();
	await expect(page.locator("#switcher-input")).toBeFocused();
}

const option = (page: import("@playwright/test").Page, title: string) =>
	page.locator(".switcher-option", { hasText: title });

test.describe("conversation switcher", () => {
	test("lists conversations by what they need, and Enter opens one in Chat without touching the session", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		const sock = backend.terminalSockets.find((s) => !s.closed)!;
		const sentBefore = sock.sent.length;
		const reqBefore = backend.requests.length;

		await openSwitcher(app, page);
		const groups = page.locator(".switcher-group-title");
		await expect(groups).toHaveText(["Needs you", "Recent"]);
		await expect(option(page, "Refactor auth flow")).toContainText("my-project");
		await expect(option(page, "Refactor auth flow")).toContainText("Waiting for input");
		await expect(option(page, "Fix tests")).toContainText("Ended");
		// Only running projects are asked ("docs" is stopped).
		expect(
			backend.requests
				.slice(reqBefore)
				.filter((r) => r.path.includes(SESSION_IDS.stopped) && r.path.includes("/conversations")),
		).toEqual([]);

		// The first option is active; Enter opens it in Chat.
		await expect(option(page, "Refactor auth flow")).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("Enter");
		await expect(page.locator(".switcher-card")).toHaveCount(0);
		await expect(page).toHaveURL(new RegExp(`#/sessions/${SESSION_IDS.running}/chat/conv-1$`));
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("cookie check");

		// Navigation only: GETs, no input or resize to the terminal.
		expect(backend.requests.slice(reqBefore).filter((r) => r.method !== "GET")).toEqual([]);
		expect(
			sock.sent.slice(sentBefore).filter((f) => f.type === "input" || f.type === "resize"),
		).toEqual([]);
	});

	test("a stale wait is not 'Needs you': it is listed as no recent activity", async ({
		app,
		backend,
		page,
	}) => {
		const c1 = backend.conversations.find((c) => c.cid === "conv-1")!;
		c1.status = "waiting_permission";
		c1.statusAt = "2026-10-31T09:00:00Z";
		for (const e of c1.events) e.ts = "2026-10-31T09:00:00Z";
		await app.login("alice");
		await openSwitcher(app, page);
		await expect(page.locator(".switcher-group-title")).toHaveText([
			"Recent",
			"Unknown or no recent activity",
		]);
		await expect(option(page, "Refactor auth flow")).toContainText("No recent activity");
	});

	test("search narrows by conversation or project, and says when nothing matches", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await openSwitcher(app, page);
		await page.fill("#switcher-input", "fix");
		await expect(page.locator(".switcher-option")).toHaveCount(1);
		await expect(option(page, "Fix tests")).toBeVisible();
		await page.fill("#switcher-input", "my-project refactor");
		await expect(page.locator(".switcher-option")).toHaveCount(1);
		await page.fill("#switcher-input", "nothing-like-this");
		await expect(page.locator(".switcher-option")).toHaveCount(0);
		await expect(page.locator(".switcher-empty")).toContainText("No conversation matches");
		await page.keyboard.press("Escape");
		await expect(page.locator(".switcher-card")).toHaveCount(0);
	});

	test("a project that fails says so and can be retried; the others stay navigable", async ({
		app,
		backend,
		page,
	}) => {
		const docs = backend.sessions.find((s) => s.sessionId === SESSION_IDS.stopped)!;
		docs.status = "running";
		backend.override = async (method, path, route) => {
			if (method === "GET" && path.includes(`${SESSION_IDS.stopped}/conversations`)) {
				await route.fulfill({ status: 429, body: JSON.stringify({ error: "Too many requests" }) });
				return true;
			}
			return false;
		};
		await app.login("alice");
		await openSwitcher(app, page);
		const err = page.locator(".switcher-error");
		await expect(err).toContainText("docs");
		await expect(err).toContainText("Too many requests");
		// The other project's conversations are there, not an empty list.
		await expect(page.locator(".switcher-option").first()).toBeVisible();
		await expect(page.locator(".switcher-empty")).toHaveCount(0);

		backend.override = null;
		await err.locator("button", { hasText: "Retry" }).click();
		await expect(page.locator(".switcher-error")).toHaveCount(0);
		await expect(page.locator(".switcher-option", { hasText: "docs" }).first()).toBeVisible();
	});

	test("no running project: says so instead of an empty list", async ({ app, backend, page }) => {
		for (const s of backend.sessions) if (s.status === "running") s.status = "stopped";
		await app.login("alice");
		await openSwitcher(app, page);
		await expect(page.locator(".switcher-empty")).toContainText("No running projects");
	});

	test("Ctrl+K opens it from the page but never while typing in the composer", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		const ta = page.locator(".chat-composer textarea");
		await ta.click();
		await page.keyboard.press("Control+k");
		await expect(page.locator(".switcher-card")).toHaveCount(0);
		await page.locator("#chat-thread .chat-assistant").first().click();
		await page.keyboard.press("Control+k");
		await expect(page.locator(".switcher-card")).toBeVisible();
	});
});
