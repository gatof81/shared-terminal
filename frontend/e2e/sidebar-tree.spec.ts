import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS, SESSION_IDS } from "./mockBackend.js";

/**
 * The sidebar tree (UX iter3 §1, ui-nav): "+ New session" first, then three
 * foldable sections with the same heading — Proyectos (one row per project,
 * a link to its page; its agents are not listed), the agents without a
 * project, and the sessions worked from their Terminal — whose ⋯ holds
 * "Show terminated" and Refresh.
 */
test.describe("sidebar tree", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	const group = (key: string) => `.sgroup[data-group="${key}"]`;

	test("order: the primary action, Proyectos, agents without a project, Sesiones; a project is one row", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("scratch")).toBeVisible();
		const top = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
		const order = [
			await top("#new-session-btn"),
			await top(group("~projects")),
			await top(group("~agents")),
			await top(group("~sessions")),
		];
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// The same heading for the three: a chevron, the name, a count.
		for (const [key, name] of [
			["~projects", "Proyectos"],
			["~agents", "Agentes sin proyecto"],
			["~sessions", "Sesiones"],
		] as const) {
			const head = page.locator(`${group(key)} .sgroup-head`);
			await expect(head.locator(".sgroup-toggle")).toHaveAccessibleName(`Plegar ${name}`);
			await expect(head.locator(".sgroup-name")).toHaveText(name);
		}
		// The old bar and the old Projects section are gone with the tree.
		await expect(page.locator("#sidebar-header")).toBeHidden();
		await expect(page.locator("#project-section")).toHaveCount(0);
		// A project: one link row, no chevron, none of its agents under it.
		const row = page.locator(`${group("~projects")} a.project-row`);
		await expect(row).toHaveCount(1);
		await expect(row).toHaveAttribute("href", `#/projects/${PROJECT_IDS.hz}`);
		await expect(row.locator(".sgroup-toggle")).toHaveCount(0);
		const agentRow = (name: string) => `.session-select[data-session-name="${name}"]`;
		await expect(page.locator(agentRow("hz-architect"))).toHaveCount(0);
		await expect(page.locator(agentRow("hz-dev-2"))).toHaveCount(0);
		await expect(page.locator(group("~agents")).locator(agentRow("scratch"))).toHaveCount(1);
		const sessions = page.locator(group("~sessions"));
		await expect(sessions.locator(".session-name", { hasText: /^my-project$/ })).toHaveCount(1);
		await expect(sessions.locator(".session-agent-item")).toHaveCount(0);
		// Folding is remembered under the section's key only.
		await page.locator(`${group("~sessions")} .sgroup-toggle`).click();
		await expect(sessions.locator(".sgroup-rows")).toBeHidden();
		await expect(page.locator(`${group("~sessions")} .sgroup-toggle`)).toBeFocused();
		expect(
			await page.evaluate(() => JSON.parse(localStorage.getItem("st.sidebarCollapsed") ?? "[]")),
		).toEqual(["~sessions"]);
	});

	test("no agent without a project: that section is not there; Proyectos always is", async ({
		app,
		backend,
		page,
	}) => {
		backend.acpAgents = [];
		backend.projects = [];
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("my-project")).toBeVisible();
		await expect(page.locator(group("~agents"))).toHaveCount(0);
		await expect(page.locator(`${group("~projects")} .sgroup-empty`)).toHaveText(
			/^Sin proyectos\./,
		);
	});

	test("a project's row: the activity dot, ONE pill by priority, said in its name; it opens the page", async ({
		app,
		backend,
		page,
	}) => {
		// @dev works; a question of the project waits; a result is new.
		backend.acpAgents.find((a) => a.name === "dev")!.running = [12];
		const asked = backend.addAcpMessage({
			to_id: "arq",
			body: "@arq ¿seguimos?",
			state: "running",
			project_id: PROJECT_IDS.hz,
		});
		backend.acpQuestions.push({ id: 9, agent: "arq", message_id: asked.id, state: "open" });
		await app.login("alice");
		await app.openSidebar();
		const row = page.locator(`${group("~projects")} a.project-row`);
		await expect(row.locator(".psig-dot")).toHaveClass(/\bon\b/);
		await expect(row.locator(".psig-pill")).toHaveText("1");
		await expect(row.locator(".psig-pill")).toHaveClass(/psig-waits/);
		await expect(row).toHaveAccessibleName("Educación HZ — 1 agente trabajando, 1 te espera");
		// Folded, Proyectos says what waits in place of its count.
		await page.locator(`${group("~projects")} .sgroup-toggle`).click();
		await expect(page.locator(`${group("~projects")} .sgroup-asks`)).toHaveText(/^●1/);
		await page.locator(`${group("~projects")} .sgroup-toggle`).click();
		// The question answered: nothing waits; nothing new either (no topic read).
		backend.acpQuestions.length = 0;
		backend.acpAgents.find((a) => a.name === "dev")!.running = [];
		backend.pushAcp({ type: "agents" });
		backend.pushAcp({ type: "question", question: { id: 9, agent: "arq", state: "answered" } });
		await expect(row.locator(".psig-pill")).toHaveCount(0);
		await expect(row.locator(".psig-dot")).not.toHaveClass(/\bon\b/);
		await expect(row).toHaveAccessibleName("Educación HZ");
		await row.click();
		await expect(page).toHaveURL(new RegExp(`#/projects/${PROJECT_IDS.hz}`));
		await expect(page.locator("#project-view")).toBeVisible();
	});

	test("the Sessions ⋯ shows terminated sessions and refreshes the list", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("my-project")).toBeVisible();
		await expect(app.sessionRow("old-poc")).toHaveCount(0);
		const more = page.locator(".sgroup-sessions .ssection-menu");
		await expect(more).toHaveAccessibleName("Opciones de Sesiones");
		await more.click();
		await page.getByRole("menuitem", { name: /^Mostrar terminadas/ }).click();
		await expect(app.sessionRow("old-poc")).toBeVisible();
		await expect(page.locator("#show-terminated-toggle")).toBeChecked();
		// The same ⋯ says the other way round now.
		await app.openSidebar();
		await more.click();
		await expect(page.getByRole("menuitem", { name: /^Ocultar terminadas/ })).toBeVisible();
		const reads = backend.requests.filter((r) => r.path.startsWith("/sessions")).length;
		await page.getByRole("menuitem", { name: /^Actualizar/ }).click();
		await expect
			.poll(() => backend.requests.filter((r) => r.path.startsWith("/sessions")).length)
			.toBeGreaterThan(reads);
	});

	test("the selected row: accent background, a 3-px bar, aria-current; rows are 32 px with a mouse", async ({
		app,
	}, info) => {
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}`);
		await app.openSidebar();
		const row = app.sessionRow("scratch");
		await expect(row).toHaveClass(/\bactive\b/);
		await expect(row.locator(".session-select")).toHaveAttribute("aria-current", "true");
		const bar = await row.evaluate((e) => {
			const b = getComputedStyle(e, "::before");
			return { width: b.width, bg: getComputedStyle(e).backgroundColor };
		});
		expect(bar.width).toBe("3px");
		expect(bar.bg).not.toBe("rgba(0, 0, 0, 0)");
		if (!info.project.use.hasTouch)
			expect(Math.round((await app.sessionRow("my-project").boundingBox())!.height)).toBe(32);
	});
});

test.describe("sidebar tree on a phone", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("48-px rows; 44 px of backdrop to close it; the last row clear of the footer; focus in and back to ☰", async ({
		app,
		page,
	}, info) => {
		test.skip(!info.project.use.isMobile, "the phone's drawer");
		// Over a session: with no address the list is the screen, not a drawer.
		await app.login("alice", `#/sessions/${SESSION_IDS.running}`);
		await app.openSidebar();
		await expect(app.sessionRow("hz-design")).toBeVisible();
		for (const name of ["scratch", "my-project"])
			expect(Math.round((await app.sessionRow(name).boundingBox())!.height)).toBe(48);
		expect(Math.round((await page.locator("a.project-row").boundingBox())!.height)).toBe(48);
		// No hover on a touch screen: every row's ⋯ shows, not only the selected one's.
		for (const name of ["scratch", "my-project"])
			expect(
				await app
					.sessionRow(name)
					.locator(".session-menu-btn")
					.evaluate((e) => getComputedStyle(e).opacity),
			).toBe("1");
		const vw = page.viewportSize()!.width;
		const drawer = (await page.locator("#sidebar").boundingBox())!;
		expect(vw - (drawer.x + drawer.width)).toBeGreaterThanOrEqual(44);
		// Scrolled to its end, the last row sits above the footer (when there is one).
		const clear = await page.evaluate(() => {
			const list = document.getElementById("session-list")!;
			list.scrollTop = list.scrollHeight;
			const last = [...list.querySelectorAll(".session-item")].at(-1)!.getBoundingClientRect();
			const foot = document.getElementById("sidebar-footer")!.getBoundingClientRect();
			return foot.height === 0 || last.bottom <= foot.top;
		});
		expect(clear).toBe(true);
		// Focus: inside on open; the backdrop closes it and gives it back to ☰.
		await expect(page.locator("#sidebar")).toContainText("Sesión nueva");
		expect(
			await page.evaluate(() =>
				document.getElementById("sidebar")!.contains(document.activeElement),
			),
		).toBe(true);
		await page.mouse.click(vw - 20, Math.round(drawer.height / 2));
		await expect(page.locator("main")).not.toHaveClass(/sidebar-open/);
		await expect(page.locator("#sidebar-toggle")).toBeFocused();
	});
});
