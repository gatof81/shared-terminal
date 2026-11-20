import { expect, test } from "./fixtures.js";
import { PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * The base controls (UX iter3 §5, base.css): `.btn` and its sizes, the
 * focus ring, and the one state chip — applied so far to the session bar's
 * state and to the ACP chats' buttons.
 */
test.describe("base controls", () => {
	test("the session's state is a chip: a filled dot when running, a hollow one when stopped", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		const badge = page.locator("#terminal-status-badge");
		await expect(badge).toHaveText("running");
		await expect(badge).toHaveClass(/\bchip\b.*\btone-ok\b/);
		const dot = () =>
			badge.evaluate((e) => {
				const c = getComputedStyle(e, "::before");
				return { fill: c.backgroundColor, ring: c.borderTopStyle };
			});
		expect((await dot()).fill).not.toBe("rgba(0, 0, 0, 0)");

		await app.openSession("docs");
		await expect(badge).toHaveText("stopped");
		// Not amber: a stopped session asks nothing of the person.
		await expect(badge).toHaveClass(/\btone-off\b/);
		expect(await dot()).toEqual({ fill: "rgba(0, 0, 0, 0)", ring: "solid" });
	});

	test("a .btn.sm is 28 px with a mouse, 44 to the touch; the keyboard focus is one accent ring", async ({
		app,
		backend,
		page,
	}, info) => {
		backend.enableAcp();
		backend.acpAgents.find((a) => a.name === "solo")!.authRequired = true;
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		// "Abrir Terminal" of the login notice: a .btn.sm in every shell and width.
		const settings = page.locator("#acp-chat .acp-login-actions .btn", {
			hasText: "Abrir Terminal",
		});
		await expect(settings).toHaveClass(/\bbtn sm\b/);
		const h = Math.round((await settings.boundingBox())!.height);
		if (info.project.use.hasTouch) expect(h).toBeGreaterThanOrEqual(44);
		else expect(h).toBe(28);
		await settings.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		await expect(settings).toBeFocused();
		// 2 px of accent (the chat view's own rule sets the offset to 1 px there).
		const ring = await settings.evaluate((e) => {
			const c = getComputedStyle(e);
			const probe = document.createElement("i");
			probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--c-accent");
			document.body.append(probe);
			const accent = getComputedStyle(probe).color;
			probe.remove();
			return `${c.outlineStyle} ${c.outlineWidth} ${c.outlineColor === accent}`;
		});
		expect(ring).toBe("solid 2px true");
	});
});
