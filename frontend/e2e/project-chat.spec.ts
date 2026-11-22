import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * Project Chat (U-2, spec/U2-project-chat.md): one header row (on a phone,
 * the app's header), one "Agentes" panel over the thread, no ×, an address
 * that never empties and a way out always on screen.
 */

const HZ = `#/projects/${PROJECT_IDS.hz}/chat`;
const THREAD = "#project-view .acp-chat-thread";
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

async function openPanel(page: Page) {
	await page.locator(".acp-agents-group").click();
	const panel = page.locator("#acp-agents");
	await expect(panel).toBeVisible();
	return panel;
}

test.describe("Project Chat (U-2)", () => {
	test("the header: one row (the app's on a phone), no ×, ⋯ = Renombrar · Archivar; the header keeps its height and the terminal gets no resize", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sock = backend.terminalSockets[0]!;
		const resizes = () => sock.sent.filter((f) => f.type === "resize").length;
		const r0 = resizes();
		const headerH = (await box(page, "header")).height;
		await page.evaluate((h) => (location.hash = h), HZ);
		await expect(page.locator("#pv-title")).toHaveText("Educación HZ");
		await expect(page.locator(".pv-close")).toHaveCount(0);
		if (app.mobile) {
			// ☰ · title · group · ⋯ in the header's one row; nothing above the thread.
			expect((await box(page, "header")).height).toBe(headerH);
			for (const sel of ["#sidebar-toggle", "#pv-title", ".acp-agents-group", ".pv-menu-btn"]) {
				const b = await box(page, `header ${sel}`);
				expect(b.y, sel).toBeLessThan(headerH);
				expect(b.height, sel).toBeGreaterThanOrEqual(sel === "#pv-title" ? 0 : 44);
			}
			await expect(page.locator("#terminal-toolbar")).toBeHidden();
			expect((await box(page, THREAD)).y).toBeLessThanOrEqual(headerH + 2);
		} else {
			expect((await box(page, "#project-view .pv-header")).height).toBeLessThanOrEqual(48);
		}
		await page.locator(".pv-menu-btn").click();
		await expect(page.locator('[role="menu"].action-menu [role="menuitem"]')).toHaveText([
			/^Renombrar/,
			/^Archivar/,
		]);
		await app.escape();
		// Out through the sidebar (☰ on a phone) and back with Back: 0 resize.
		await app.openSidebar();
		await page.locator("#session-list .session-select", { hasText: "my-project" }).first().click();
		await expect(page.locator("#project-view")).toBeHidden();
		expect(page.url()).toContain(`#/sessions/`);
		await page.goBack();
		await expect(page.locator("#pv-title")).toBeVisible();
		await page.goBack();
		await page.waitForTimeout(400);
		expect((await box(page, "header")).height).toBe(headerH);
		expect(resizes(), "no resize entering or leaving a project").toBe(r0);
	});

	test("one 'Agentes' panel over the thread: the thread does not move, it never covers the message box; rows of 64 px; focus in and back", async ({
		app,
		page,
	}) => {
		await app.login("alice", HZ);
		await expect(page.locator("#acp-agents-panel")).toHaveCount(0);
		const thread = page.locator(THREAD);
		await expect(thread).toBeVisible();
		const before = await thread.evaluate((t) => [
			t.getBoundingClientRect().top,
			t.clientHeight,
			t.scrollTop,
		]);
		const panel = await openPanel(page);
		const after = await thread.evaluate((t) => [
			t.getBoundingClientRect().top,
			t.clientHeight,
			t.scrollTop,
		]);
		expect(after).toEqual(before);
		// The focus on the first row's first action.
		await expect(
			panel.locator(".acp-agents-row").first().locator("button, a").first(),
		).toBeFocused();
		const p = await box(page, "#acp-agents");
		const opener = app.mobile
			? await box(page, "header")
			: await box(page, "#project-view .pv-header");
		expect(Math.round(p.y - (opener.y + opener.height))).toBe(4);
		const composer = await box(page, "#project-view .acp-chat-composer");
		expect(composer.y - (p.y + p.height)).toBeGreaterThanOrEqual(8);
		expect(p.height).toBeLessThanOrEqual(page.viewportSize()!.height * 0.6 + 1);
		for (const r of await panel.locator(".acp-agents-row").all())
			expect(Math.abs((await r.boundingBox())!.height - 64)).toBeLessThanOrEqual(1);
		// Escape: closed, focus back on the group; nothing in the thread moved.
		await page.keyboard.press("Escape");
		await expect(panel).toBeHidden();
		await expect(page.locator(".acp-agents-group")).toBeFocused();
		expect(
			await thread.evaluate((t) => [t.getBoundingClientRect().top, t.clientHeight, t.scrollTop]),
		).toEqual(before);
		// A tap outside only closes it.
		await openPanel(page);
		await page.mouse.click(20, (await box(page, "#project-view .acp-chat-composer")).y - 20);
		await expect(panel).toBeHidden();
	});

	test("at 320 px: rows without overlaps, the name on one line; 44-px targets; 7 agents at 390×450 scroll only the list, the foot stays", async ({
		app,
		backend,
		page,
	}) => {
		test.skip(!app.mobile, "a phone");
		backend.acpAgents.find((a) => a.name === "dev")!.name = "infraestructura-y-despliegues";
		const base = backend.acpAgents.find((a) => a.name === "arq")!;
		for (let i = 0; i < 5; i++)
			backend.acpAgents.push({ ...base, name: `agente-${i}`, sessionId: `${base.sessionId}-${i}` });
		backend.acpAgents.push({
			...base,
			name: "fuera",
			sessionId: `${base.sessionId}-x`,
			projectId: null,
		});
		await page.setViewportSize({ width: 320, height: 568 });
		await app.login("alice", HZ);
		const panel = await openPanel(page);
		const row = panel.locator(".acp-agents-row", { hasText: "infraestructura" });
		const parts = await row.evaluate((r) =>
			[
				".acp-agents-face",
				".acp-agents-name",
				".acp-agents-state",
				".acp-agents-open",
				".acp-agents-more",
			].map((s) => {
				const b = r.querySelector(s)!.getBoundingClientRect();
				return { s, x: b.x, y: b.y, r: b.right, b: b.bottom, h: b.height };
			}),
		);
		for (const a of parts)
			for (const b of parts)
				if (a !== b) {
					const overlap = a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
					expect(overlap, `${a.s} × ${b.s}`).toBe(false);
				}
		const name = row.locator(".acp-agents-name");
		expect(await name.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
		expect((await name.boundingBox())!.height).toBeLessThanOrEqual(21);
		for (const sel of [".acp-agents-close", ".acp-agents-open", ".acp-agents-more"])
			expect((await panel.locator(sel).first().boundingBox())!.height, sel).toBeGreaterThanOrEqual(
				44,
			);
		await app.escape();
		await page.setViewportSize({ width: 390, height: 450 });
		await openPanel(page);
		const rows = panel.locator(".acp-agents-rows");
		expect(await rows.evaluate((e) => e.scrollHeight > e.clientHeight + 1)).toBe(true);
		await expect(panel.locator(".acp-agents-foot")).toBeInViewport({ ratio: 1 });
		const composer = await box(page, "#project-view .acp-chat-composer");
		const p = await box(page, "#acp-agents");
		expect(composer.y - (p.y + p.height)).toBeGreaterThanOrEqual(8);
	});

	for (const width of [320, 360, 390])
		test(`at ${width} px the longest state chip is whole, clear of "Abrir su chat"; a tappable chip takes 44 px`, async ({
			app,
			backend,
			page,
		}) => {
			test.skip(!app.mobile, "a phone");
			backend.acpAgents.find((a) => a.name === "dev")!.waitingInput = true;
			const m = backend.addAcpMessage({
				to_id: "arq",
				body: "@arq algo",
				state: "running",
				project_id: PROJECT_IDS.hz,
			});
			backend.acpAgents.find((a) => a.name === "arq")!.running = m.id;
			await page.setViewportSize({ width, height: 700 });
			await app.login("alice", HZ);
			const panel = await openPanel(page);
			for (const name of ["dev", "arq"]) {
				const row = panel.locator(".acp-agents-row", { hasText: `@${name}` });
				const chip = row.locator(".acp-agents-state");
				const geo = await chip.evaluate((c) => {
					const open = c.parentElement!.querySelector(".acp-agents-open")!.getBoundingClientRect();
					const b = c.getBoundingClientRect();
					// The end of what it shows: the "›" of a tappable chip (its ::after,
					// the larger touch area, counts in scrollWidth), else its text.
					const r = document.createRange();
					r.selectNodeContents(c);
					const end =
						c.querySelector(".acp-agents-goto-mark")?.getBoundingClientRect().right ??
						r.getBoundingClientRect().right;
					return { cut: end > b.right + 0.5, right: b.right, openLeft: open.left };
				});
				expect(geo.cut, `@${name}'s chip is not cut`).toBe(false);
				expect(geo.right, `@${name}'s chip clear of the button`).toBeLessThanOrEqual(geo.openLeft);
				expect(Math.abs((await row.boundingBox())!.height - 64)).toBeLessThanOrEqual(1);
			}
			await expect(panel.locator(".acp-agents-open").first()).toHaveAccessibleName(
				/^Abrir su chat \(@/,
			);
			const first = panel.locator(".acp-agents-open").first();
			await expect(
				first.locator(width <= 360 ? ".acp-agents-open-short" : ".acp-agents-open-long"),
			).toBeVisible();
			await expect(
				first.locator(width <= 360 ? ".acp-agents-open-long" : ".acp-agents-open-short"),
			).toBeHidden();
			// The tappable chip answers a tap 12 px above and below its box.
			const go = panel.locator(".acp-agents-goto");
			const b = (await go.boundingBox())!;
			for (const y of [b.y - 11, b.y + b.height + 11]) {
				const hit = await page.evaluate(
					([x, y]) => document.elementFromPoint(x!, y!)?.closest(".acp-agents-goto") !== null,
					[b.x + b.width / 2, y] as const,
				);
				expect(hit, `a tap at y=${Math.round(y)}`).toBe(true);
			}
		});

	test("Quitar del proyecto: the row's ⋯ and a confirmation; the agent is then in 'Agregar agente existente…'; the panel stays open", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", HZ);
		const panel = await openPanel(page);
		await panel.getByRole("button", { name: "Acciones de @dev" }).click();
		await page.getByRole("menuitem", { name: /^Quitar del proyecto/ }).click();
		await page
			.locator(".modal-primary-action, .modal-danger-action", { hasText: "Quitar" })
			.click();
		await expect.poll(() => backend.acpAgents.find((a) => a.name === "dev")?.projectId).toBeNull();
		await expect(panel).toBeVisible();
		await expect(panel.locator(".acp-agents-row")).toHaveCount(1);
		await expect(panel.locator(".acp-add-select option", { hasText: "@dev" })).toHaveCount(1);
	});

	test("a project without agents: the panel opens by itself, with its text and its foot", async ({
		app,
		backend,
		page,
	}) => {
		for (const a of backend.acpAgents) if (a.projectId === PROJECT_IDS.hz) a.projectId = null;
		await app.login("alice", HZ);
		const panel = page.locator("#acp-agents");
		await expect(panel).toBeVisible();
		await expect(panel).toContainText("Todavía no hay agentes en este proyecto.");
		await expect(panel.getByRole("button", { name: "+ Nueva sesión con agente" })).toBeVisible();
		await expect(page.locator(".acp-agents-group")).toHaveAccessibleName("Agregar agentes");
	});

	test("the running message: a chip with ›; at a quarter of the thread, flashed then not; the panel closes", async ({
		app,
		backend,
		page,
	}) => {
		let running = 0;
		for (let i = 1; i <= 30; i++) {
			const m = backend.addAcpMessage({
				to_id: "arq",
				body: `@arq tema ${i}`,
				state: i === 6 ? "running" : "done",
				result_text: i === 6 ? null : `Tema ${i} resuelto.\n\nCon otra línea.`,
				project_id: PROJECT_IDS.hz,
			});
			if (i === 6) running = m.id;
		}
		backend.acpAgents.find((a) => a.name === "arq")!.running = running;
		await app.login("alice", HZ);
		await expect(page.locator(THREAD)).toContainText("Tema 30 resuelto.");
		const panel = await openPanel(page);
		const go = panel.getByRole("button", { name: /^Ir al mensaje en curso de @arq/ });
		await expect(go).toContainText(`trabajando en #${running}`);
		await expect(go.locator(".acp-agents-goto-mark")).toHaveText("›");
		// The other agent's state is not a control.
		await expect(
			panel.locator(".acp-agents-row", { hasText: "@dev" }).locator("button.chip"),
		).toHaveCount(0);
		await go.click();
		await expect(panel).toBeHidden();
		const target = page.locator(`${THREAD} [data-ids~="${running}"]`);
		const h = await page.locator(THREAD).evaluate((e) => e.clientHeight);
		const top = await target.evaluate(
			(r, sel) =>
				r.getBoundingClientRect().top - document.querySelector(sel)!.getBoundingClientRect().top,
			THREAD,
		);
		expect(Math.abs(top - h * 0.25)).toBeLessThanOrEqual(8);
		await page.waitForTimeout(200);
		await expect(target).toHaveClass(/acp-msg-flash/);
		await page.waitForTimeout(1800);
		await expect(target).not.toHaveClass(/acp-msg-flash/);
	});

	test("navigation: the address is the project's (…/chat); Abrir su chat is a history entry; archiving stays on the page, read-only", async ({
		app,
		page,
	}) => {
		const length = await page.evaluate(() => history.length);
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator("#pv-title")).toBeVisible();
		// Entered by the bare form: the address becomes the canonical …/chat, in place (N3).
		await expect(page).toHaveURL(new RegExp(`#/projects/${PROJECT_IDS.hz}/chat$`));
		expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(length + 1);
		const panel = await openPanel(page);
		await panel.getByRole("link", { name: "Abrir su chat (@dev)" }).click();
		await expect(page).toHaveURL(new RegExp(`#/sessions/${PROJECT_SESSION_IDS.developer2}/chat$`));
		await page.goBack();
		await expect(page.locator("#pv-title")).toBeVisible();
		expect(new URL(page.url()).hash).toBe(`#/projects/${PROJECT_IDS.hz}/chat`);
		// Archive: same address, archived · read-only, no composer, no ⋯ of row, no foot.
		const hash = new URL(page.url()).hash;
		await page.locator(".pv-menu-btn").click();
		await page.getByRole("menuitem", { name: /^Archivar/ }).click();
		await page
			.locator(".modal-primary-action, .modal-danger-action", { hasText: "Archivar" })
			.click();
		await expect(page.locator("#project-view")).toContainText("Proyecto archivado · solo lectura");
		// On a phone the note is one line (U-2 §2.4).
		if (app.mobile) {
			const notes = page.locator("#project-view .acp-project-agents");
			expect((await notes.boundingBox())!.height).toBeLessThanOrEqual(32);
		}
		expect(new URL(page.url()).hash).toBe(hash);
		await expect(page.locator("#project-view .acp-chat-input")).toBeHidden();
		const ro = await openPanel(page);
		await expect(ro.locator(".acp-agents-more")).toHaveCount(0);
		await expect(ro.locator(".acp-agents-foot")).toBeHidden();
		// A way out on screen: ☰ (44×44) on a phone, the sidebar on a wide screen.
		await app.escape();
		if (app.mobile) {
			const t = await box(page, "#sidebar-toggle");
			expect(t.width).toBeGreaterThanOrEqual(44);
			expect(t.height).toBeGreaterThanOrEqual(44);
		} else await expect(page.locator("#sidebar")).toBeVisible();
	});
});
