import { expect, test } from "./fixtures.js";
import { PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * The base controls (UX iter3 §5, base.css): `.btn` and its sizes, the
 * focus ring, and the one state chip — applied so far to the session bar's
 * state and to the ACP buttons.
 */
test.describe("base controls", () => {
	test("a .btn with `hidden` is hidden (the model's save button until another model is picked)", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableAcp();
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}`);
		await app.openAgentSettings();
		const select = page.locator(".acp-settings-dialog .acp-model-select");
		await expect(select).toBeVisible();
		const save = page.locator(".acp-settings-dialog .btn", { hasText: "Cambiar modelo" });
		await expect(save).toHaveCount(1);
		await expect(save).toBeHidden();
		await select.selectOption({ index: 1 });
		await expect(save).toBeVisible();
	});

	test("the session's state is a chip: a filled dot when running, a hollow one when stopped", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		const badge = page.locator("#terminal-status-badge");
		await expect(badge).toHaveText("en marcha");
		await expect(badge).toHaveClass(/\bchip\b.*\btone-ok\b/);
		const dot = () =>
			badge.evaluate((e) => {
				const c = getComputedStyle(e, "::before");
				return { fill: c.backgroundColor, ring: c.borderTopStyle };
			});
		expect((await dot()).fill).not.toBe("rgba(0, 0, 0, 0)");

		await app.openSession("docs");
		await expect(badge).toHaveText("detenida");
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
		const solo = backend.acpAgents.find((a) => a.name === "solo")!;
		solo.authRequired = true;
		solo.loginMethods = [{ id: "claude-ai", name: "Claude.ai", description: "" }];
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}`);
		await app.openAgentSettings();
		// «Conectar cuenta» of the agent's settings: a .btn.sm in every shell and width.
		const settings = page.locator(".acp-settings-dialog .acp-login-actions .btn", {
			hasText: "Conectar cuenta",
		});
		await expect(settings).toHaveClass(/\bbtn sm\b/);
		const h = Math.round((await settings.boundingBox())!.height);
		if (info.project.use.hasTouch) expect(h).toBeGreaterThanOrEqual(44);
		else expect(h).toBe(28);
		await settings.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		await expect(settings).toBeFocused();
		// 2 px of accent, 2 px off the edge.
		const ring = await settings.evaluate((e) => {
			const c = getComputedStyle(e);
			const probe = document.createElement("i");
			probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--c-accent");
			document.body.append(probe);
			const accent = getComputedStyle(probe).color;
			probe.remove();
			return `${c.outlineStyle} ${c.outlineWidth} ${c.outlineOffset} ${c.outlineColor === accent}`;
		});
		expect(ring).toBe("solid 2px 2px true");
	});
});
