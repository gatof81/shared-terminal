/**
 * chat-meta.spec.ts — CONVERSATION.md §6.2 (v1.8): rename / restore the
 * automatic title, archive / unarchive, the Active · Archived · All filters
 * (remembered per browser), an archived conversation that is live again,
 * the "metadata unavailable" state and refused changes — by keyboard, on
 * every project (desktop, mobile, and the v2 shell). None of it may touch
 * the terminal: no resize, no input, no new socket.
 */

import { expect, test } from "./fixtures.js";

const row = (page: import("@playwright/test").Page, title: string) =>
	page.locator("#chat-list .chat-conv-item", { hasText: title });
const menuBtn = (page: import("@playwright/test").Page, cid: string, where = "list") =>
	page.locator(`[data-meta-cid="${cid}"][data-meta-where="${where}"]`);

async function openChat(app: import("./fixtures.js").App, page: import("@playwright/test").Page) {
	await app.login("alice");
	await app.openSession("my-project");
	await app.expectTerminalReady();
	await app.switchView("chat");
	await expect(page.locator("#chat-list .chat-conv-row")).toHaveCount(2);
}

test.describe("chat: rename and archive (v1.8 §6.2)", () => {
	test("rename by keyboard prevails over the automatic title; restore brings it back; the terminal is untouched", async ({
		app,
		backend,
		page,
		isMobile,
	}) => {
		await openChat(app, page);
		const sock = backend.terminalSockets.find((s) => !s.closed)!;
		const sentBefore = sock.sent.length;
		const socketsBefore = backend.terminalSockets.length;

		// ⋯ → Rename… → type → Enter, all from the keyboard.
		await menuBtn(page, "conv-1").focus();
		await page.keyboard.press("Enter");
		const menu = page.locator(".action-menu[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.locator("[role=menuitem]").first()).toBeFocused();
		await expect(menu.locator('[data-action="restore"]')).toBeDisabled();
		await page.keyboard.press("Enter");
		const input = page.locator(".dialog-card input");
		await expect(input).toBeFocused();
		await expect(input).toHaveAttribute("placeholder", "Refactor auth flow");
		await input.fill("Plan de auth");
		await page.keyboard.press("Enter");

		await expect(row(page, "Plan de auth")).toHaveCount(1);
		await expect(row(page, "Refactor auth flow")).toHaveCount(0);
		expect(backend.conversations.find((c) => c.cid === "conv-1")?.customTitle).toBe("Plan de auth");
		// Focus is back on that conversation's ⋯ after the re-render.
		await expect(menuBtn(page, "conv-1")).toBeFocused();

		// The thread header shows the name, and the automatic title as secondary text.
		await row(page, "Plan de auth").locator(".chat-conv-row").click();
		const head = page.locator("#chat-thread .chat-thread-head");
		await expect(head.locator(".chat-thread-name")).toHaveText("Plan de auth");
		await expect(head).toContainText("automatic title: Refactor auth flow");

		// Restore automatic title, from the header's ⋯ (desktop) or the row's (mobile list).
		if (isMobile) await page.locator("#chat-back-btn").click();
		await menuBtn(page, "conv-1", isMobile ? "list" : "head").click();
		await page.locator('.action-menu [data-action="restore"]').click();
		await expect(row(page, "Refactor auth flow")).toHaveCount(1);
		expect(backend.conversations.find((c) => c.cid === "conv-1")?.customTitle).toBeNull();

		// Nothing reached the terminal: no resize, no input, no new socket.
		expect(
			sock.sent.slice(sentBefore).filter((f) => f.type === "resize" || f.type === "input"),
		).toEqual([]);
		expect(backend.terminalSockets.length).toBe(socketsBefore);
		expect(sock.closed).toBe(false);
	});

	test("a refused name is explained inside the dialog, the text is kept, and a retry saves it", async ({
		app,
		backend,
		page,
	}) => {
		await openChat(app, page);
		await menuBtn(page, "conv-2").click();
		await page.locator('.action-menu [data-action="rename"]').click();
		const input = page.locator(".dialog-card input");
		const error = page.locator(".dialog-card .modal-field-error");

		// Checked before the request leaves: a direction override is refused locally.
		await input.fill("abc‮def");
		await page.keyboard.press("Enter");
		await expect(error).toContainText("text-direction");
		expect(backend.requests.some((r) => r.method === "PATCH")).toBe(false);

		// The server refuses (storage down): the dialog stays, says why, keeps the text.
		backend.failNextMetaPatch = { status: 503, error: "meta-unavailable" };
		await input.fill("Tests verdes");
		await page.keyboard.press("Enter");
		await expect(error).toContainText("could not be saved");
		await expect(input).toHaveValue("Tests verdes");
		await expect(page.locator(".dialog-card")).toBeVisible();
		await expect(row(page, "Fix tests")).toHaveCount(1);

		await page.keyboard.press("Enter");
		await expect(page.locator(".dialog-card")).toHaveCount(0);
		await expect(row(page, "Tests verdes")).toHaveCount(1);
	});

	test("archive hides from Active without deleting; the Archived filter shows it; the choice survives a reload", async ({
		app,
		backend,
		page,
	}) => {
		await openChat(app, page);
		await menuBtn(page, "conv-2").click();
		await page.locator('.action-menu [data-action="archive"]').click();
		await expect(row(page, "Fix tests")).toHaveCount(0);
		await expect(page.locator('.chat-filter-btn[data-filter="archived"]')).toContainText("1");
		expect(backend.conversations.find((c) => c.cid === "conv-2")?.events.length).toBeGreaterThan(0);

		await page.locator('.chat-filter-btn[data-filter="archived"]').click();
		await expect(page.locator('.chat-filter-btn[data-filter="archived"]')).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(row(page, "Fix tests").locator(".chat-conv-archived")).toHaveText("Archived");
		// Still readable.
		await row(page, "Fix tests").locator(".chat-conv-row").click();
		await expect(page.locator("#chat-thread .chat-thread-head")).toContainText("archived");

		await page.reload();
		await app.switchView("chat");
		// The reload reopens the last conversation; on mobile that is the thread pane: back to the list.
		if (await page.locator("#chat-back-btn").isVisible()) await page.locator("#chat-back-btn").click();
		await expect(page.locator('.chat-filter-btn[data-filter="archived"]')).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(page.locator("#chat-list .chat-conv-row")).toHaveCount(1);

		await menuBtn(page, "conv-2").click();
		await page.locator('.action-menu [data-action="unarchive"]').click();
		await expect(page.locator("#chat-list .chat-empty")).toContainText("No archived conversations");
		await page.locator("#chat-list .chat-empty button", { hasText: "Show all" }).click();
		await expect(page.locator("#chat-list .chat-conv-row")).toHaveCount(2);
	});

	test("an archived conversation that is live again is surfaced in Active, marked, with Unarchive; the composer is unaffected", async ({
		app,
		backend,
		page,
	}) => {
		backend.conversations.find((c) => c.cid === "conv-1")!.archivedAt = "2026-10-31T09:00:00.000Z";
		await openChat(app, page);
		const r = row(page, "Refactor auth flow");
		await expect(r.locator(".chat-conv-archived")).toHaveText("Archived · active again");
		await expect(
			page.locator('.chat-filter-btn[data-filter="archived"] .chat-filter-live'),
		).toHaveText("1 live");

		// Archive changes nothing for the composer (§6.2).
		await r.locator(".chat-conv-row").click();
		await expect(page.locator(".chat-composer textarea")).toBeEnabled();
		await app.escape().catch(() => undefined);
		if (await page.locator("#chat-back-btn").isVisible())
			await page.locator("#chat-back-btn").click();

		await r.locator(".chat-conv-unarchive").click();
		await expect(r.locator(".chat-conv-archived")).toHaveCount(0);
		expect(backend.conversations.find((c) => c.cid === "conv-1")?.archivedAt).toBeNull();
	});

	test("with the metadata unreadable the list says so, shows everything, and the filters wait", async ({
		app,
		backend,
		page,
	}) => {
		backend.conversations.find((c) => c.cid === "conv-2")!.archivedAt = "2026-10-31T09:00:00.000Z";
		backend.metaUnavailable = true;
		await openChat(app, page);
		await expect(page.locator(".chat-meta-banner")).toContainText(
			"Names and archive state unavailable",
		);
		for (const f of ["active", "archived", "all"])
			await expect(page.locator(`.chat-filter-btn[data-filter="${f}"]`)).toBeDisabled();
		await expect(row(page, "Fix tests")).toHaveCount(1);
	});

	test("a refused archive is a visible error and nothing moves", async ({ app, backend, page }) => {
		await openChat(app, page);
		backend.failNextMetaPatch = { status: 503, error: "meta-unavailable" };
		await menuBtn(page, "conv-2").click();
		await page.locator('.action-menu [data-action="archive"]').click();
		await expect(page.locator("#toast .toast-item.error")).toContainText("could not be saved");
		await expect(row(page, "Fix tests")).toHaveCount(1);
		expect(backend.conversations.find((c) => c.cid === "conv-2")?.archivedAt ?? null).toBeNull();
	});
});
