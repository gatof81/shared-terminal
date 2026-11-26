import { expect, test } from "./fixtures.js";
import { CONV_IDS, PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * The terminal invariant (docs/design/ui-unificada.md §5.1): switching
 * views must not reconnect, resize or disturb the terminal. The mock
 * records every socket and every frame the app sends, so the assertion
 * is on the wire, not on pixels.
 */
test.describe("terminal invariant", () => {
	test("switching views opens no socket and sends no resize or input", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		// Let the attach settle (fit → possible initial resize) before measuring.
		await page.waitForTimeout(400);
		const sockets = backend.terminalSockets.length;
		const sock = backend.terminalSockets[0]!;
		const resizes = () => sock.sent.filter((f) => f.type === "resize").length;
		const inputs = () => sock.sent.filter((f) => f.type === "input").length;

		// From here on: pure view switches. Nothing may reach the terminal.
		const framesBefore = sock.sent.length;
		const rowsBefore = await page.locator(".tab-pane.active .xterm-rows > div").count();
		const r0 = resizes();
		const i0 = inputs();
		// Every switch is pure on both layouts: the view tabs are always on screen.
		await app.switchView("files");
		await app.switchView("git");
		await app.switchView("terminal");
		await app.switchView("files");
		await app.switchView("terminal");
		await page.waitForTimeout(400);

		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(resizes() - r0, "no resize sent by a view switch").toBe(0);
		expect(inputs() - i0, "no input sent by a view switch").toBe(0);
		expect(sock.sent.length - framesBefore, "no frame of any kind").toBe(0);
		const rowsAfter = await page.locator(".tab-pane.active .xterm-rows > div").count();
		expect(rowsAfter).toBe(rowsBefore);
		// Output that arrives while an overlay is up still lands in the terminal.
		await app.switchView("git");
		backend.pushTerminalOutput(sock.sessionId, "\r\nstill here\r\n");
		await app.switchView("terminal");
		await expect(page.locator(".tab-pane.active")).toContainText("still here");
	});

	test("rail ⇄ topic ⇄ Pendientes ⇄ menus ⇄ terminal: nothing touches the terminal", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableConversations();
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sockets = backend.terminalSockets.length;
		const sock = backend.terminalSockets[0]!;
		const framesBefore = sock.sent.length;
		const rowsBefore = await page.locator(".tab-pane.active .xterm-rows > div").count();
		const topicRow = (title: string) => page.locator(".rail-body .rail-conv", { hasText: title });

		// The project from its row in the sidebar: its rail.
		await app.openSidebar();
		await page.locator(`a.project-row[data-project-id="${PROJECT_IDS.hz}"]`).click();
		await expect(page.locator(".rail-body")).toBeVisible();
		// Topic, another topic, back to the rail.
		await topicRow("Optimización de CI").click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Optimización de CI");
		if (app.mobile) await page.locator(".ps-back").click();
		await topicRow("Rediseño de UI/UX").click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Rediseño de UI/UX");
		// Pendientes and the topic's menu over the topic.
		const inbox = page.locator(".acp-inbox-card");
		await page.locator("#inbox-btn").click();
		await expect(inbox).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(inbox).toBeHidden();
		await page.locator(".ps-topic-head .pv-menu-btn").click();
		await expect(page.locator('[role="menu"].action-menu')).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator('[role="menu"].action-menu')).toBeHidden();
		await page.goBack();
		await expect(page.locator(".rail-body")).toBeVisible();
		// The rail's ‹ to the main level: the terminal again. Wide it goes back
		// to the entry the project was entered from (Forward returns to the
		// rail); on a phone it opens the drawer, whose row is a new entry.
		await page.locator(".rail-back").click();
		if (app.mobile) {
			await expect(page.locator("main")).toHaveClass(/sidebar-open/);
			await app.sessionRow("my-project").locator(".session-select").click();
		}
		await expect(page.locator("#project-view")).toBeHidden();
		if (app.mobile) await page.goBack();
		else await page.goForward();
		await expect(page.locator(".rail-body")).toBeVisible();
		if (app.mobile) await page.goForward();
		else await page.goBack();
		await expect(page.locator("#project-view")).toBeHidden();
		// Pendientes and the account's menu with the terminal on screen.
		await page.locator("#inbox-btn").click();
		await expect(inbox).toBeVisible();
		await inbox.getByRole("button", { name: "Cerrar Pendientes" }).click();
		await expect(inbox).toBeHidden();
		await app.openUserMenu();
		await page.keyboard.press("Escape");
		await page.waitForTimeout(400);

		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(sock.sent.length - framesBefore, "no frame of any kind (no resize)").toBe(0);
		expect(await page.locator(".tab-pane.active .xterm-rows > div").count()).toBe(rowsBefore);
		expect(app.errors).toEqual([]);
	});

	test("Archive ⇄ an archived chat ⇄ «Continuar…» ⇄ back: nothing touches the terminal", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableConversations();
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sockets = backend.terminalSockets.length;
		const sock = backend.terminalSockets[0]!;
		const framesBefore = sock.sent.length;
		const rowsBefore = await page.locator(".tab-pane.active .xterm-rows > div").count();

		// The project, its Archive, the previous Project Chat.
		await app.openSidebar();
		await page.locator(`a.project-row[data-project-id="${PROJECT_IDS.hz}"]`).click();
		await page.locator(".rail-body .rail-archive-row").click();
		await page.locator(".ps-archive-row", { hasText: "Project Chat anterior" }).click();
		await expect(page.locator("#ps-archive-title")).toHaveText("Project Chat anterior");
		// «Continuar en una conversación nueva»: a topic, created and opened.
		await page.getByRole("button", { name: "Continuar en una conversación nueva" }).click();
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page.locator("#ps-topic-title")).toHaveText(
			"Continuación de Project Chat anterior",
		);
		// Back to the archived chat, to the list, and out to the session.
		await page.goBack();
		await expect(page.locator("#ps-archive-title")).toHaveText("Project Chat anterior");
		await page.goBack();
		await expect(page.locator("#ps-archive-title")).toHaveText("Archivo · solo lectura");
		// A phone's stack: the project's screen (the rail, with its ‹) is one more Back.
		if (app.mobile) await page.goBack();
		await page.locator(".rail-back").click();
		if (app.mobile) await app.sessionRow("my-project").locator(".session-select").click();
		await expect(page.locator("#project-view")).toBeHidden();
		await page.waitForTimeout(400);

		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(sock.sent.length - framesBefore, "no frame of any kind (no resize)").toBe(0);
		expect(await page.locator(".tab-pane.active .xterm-rows > div").count()).toBe(rowsBefore);
		expect(app.errors).toEqual([]);
	});

	test("topic ⇄ Herramientas ⇄ menus: no resize, no new socket; another agent is another attach", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableConversations();
		backend.enableWorks();
		const topicHash = `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.ci}`;
		await app.login("alice", topicHash);
		await expect(page.locator("#ps-topic-title")).toHaveText("Optimización de CI");
		const menu = page.locator('[role="menu"].action-menu');
		const agentMenu = async () => {
			await page.locator('#project-view .acp-agent-id[data-agent="dev"]').first().click();
			await expect(menu).toBeVisible();
		};
		// Herramientas of @dev, Terminal: its session attaches — once.
		await agentMenu();
		await menu.getByRole("menuitem", { name: /^Terminal de la sesión/ }).click();
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sockets = backend.terminalSockets.length;
		const sock = backend.terminalSockets.find(
			(s) => s.sessionId === PROJECT_SESSION_IDS.developer2 && !s.closed,
		)!;
		expect(sock).toBeTruthy();
		const framesBefore = sock.sent.length;
		const rowsBefore = await page.locator(".tab-pane.active .xterm-rows > div").count();

		// «‹ Tema» and Forward; Back and Forward.
		await page.locator(".tools-back").click();
		await expect(page.locator("#ps-topic-title")).toBeVisible();
		await page.goForward();
		await expect(page.locator(".tools-bar")).toBeVisible();
		await page.goBack();
		await expect(page.locator("#ps-topic-title")).toBeVisible();
		// The agent's menu over the topic, dismissed; then its Files, Git, Terminal.
		await agentMenu();
		await app.escape();
		await expect(menu).toBeHidden();
		await agentMenu();
		await menu.getByRole("menuitem", { name: /^Files · principal/ }).click();
		await app.expectView("files");
		await page.click("#view-git-btn");
		await app.expectView("git");
		await page.locator(".tools-ws").selectOption("ci-cache");
		await expect(page.locator("#git-list")).toContainText("ci.yml");
		await page.click("#view-terminal-btn");
		await app.expectView("terminal");
		// The session's ⋯ over the tools.
		await page.click("#session-menu-btn");
		await expect(menu).toBeVisible();
		await app.escape();
		await page.locator(".tools-back").click();
		await expect(page.locator("#ps-topic-title")).toBeVisible();
		await page.goForward();
		await expect(page.locator(".tools-bar")).toBeVisible();
		await page.waitForTimeout(400);

		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(sock.sent.length - framesBefore, "no frame of any kind (no resize)").toBe(0);
		expect(await page.locator(".tab-pane.active .xterm-rows > div").count()).toBe(rowsBefore);

		// Another AGENT: its session attaches — a new socket, never a resize of this one.
		await page.locator(".tools-agent").selectOption("arq");
		await expect
			.poll(() =>
				backend.terminalSockets.some(
					(s) => s.sessionId === PROJECT_SESSION_IDS.architect && !s.closed,
				),
			)
			.toBe(true);
		expect(sock.sent.filter((f) => f.type === "resize").length).toBe(0);
		expect(app.errors).toEqual([]);
	});

	test("Herramientas ⇄ Pendientes (criterion 7): no resize, no new socket; a review's tools are another attach", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableConversations();
		backend.enableWorks();
		// An interruption of @arq waiting in Pendientes.
		backend.addAcpMessage({
			to_id: "arq",
			body: "@arq medí también la variante sin shards.",
			project_id: PROJECT_IDS.hz,
			conversation_id: CONV_IDS.ci,
			state: "uncertain",
			note: "se reinició el runner de @arq",
		});
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.ci}`);
		await expect(page.locator("#ps-topic-title")).toHaveText("Optimización de CI");
		const menu = page.locator('[role="menu"].action-menu');
		await page.locator('#project-view .acp-agent-id[data-agent="dev"]').first().click();
		await menu.getByRole("menuitem", { name: /^Terminal de la sesión/ }).click();
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sockets = backend.terminalSockets.length;
		const sock = backend.terminalSockets.find(
			(s) => s.sessionId === PROJECT_SESSION_IDS.developer2 && !s.closed,
		)!;
		expect(sock).toBeTruthy();
		const framesBefore = sock.sent.length;
		const rowsBefore = await page.locator(".tab-pane.active .xterm-rows > div").count();

		// Pendientes over each of the tools' views, opened from the header and dismissed.
		const inbox = page.locator("#inbox-btn");
		const panel = page.locator(".acp-inbox-card");
		for (const view of ["terminal", "files", "git"] as const) {
			if (view !== "terminal") await page.click(`#view-${view}-btn`);
			await app.expectView(view);
			await expect(page.locator(".tools-bar")).toBeVisible();
			await inbox.click();
			await expect(panel).toBeVisible();
			await app.escape();
			await expect(panel).toBeHidden();
		}
		await page.click("#view-terminal-btn");
		await app.expectView("terminal");
		await page.waitForTimeout(400);
		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(sock.sent.length - framesBefore, "no frame of any kind (no resize)").toBe(0);
		expect(await page.locator(".tab-pane.active .xterm-rows > div").count()).toBe(rowsBefore);

		// From Pendientes, an interruption of @arq: «Ver cambios en Git» opens
		// @arq's Herramientas — its session attaches; @dev's gets no resize.
		await inbox.click();
		await panel
			.locator(".acp-ib-item.is-interrupted", { hasText: "variante sin shards" })
			.getByRole("button", { name: "Revisar interrupción" })
			.click();
		const review = page.locator(".acp-review-card");
		await expect(review).toBeVisible();
		await review.getByRole("button", { name: "Ver cambios en Git" }).click();
		await expect(review).toBeHidden();
		await app.expectView("git");
		await expect(page.locator(".tools-agent")).toHaveValue("arq");
		await page.click("#view-terminal-btn");
		await expect
			.poll(() =>
				backend.terminalSockets.some(
					(s) => s.sessionId === PROJECT_SESSION_IDS.architect && !s.closed,
				),
			)
			.toBe(true);
		expect(sock.sent.filter((f) => f.type === "resize").length, "no resize to @dev's session").toBe(
			0,
		);
		expect(app.errors).toEqual([]);
	});

	test("typing reaches the session and the echo renders", async ({ app, backend, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.locator(".tab-pane.active .xterm-helper-textarea").focus();
		await page.keyboard.type("ls");
		await expect
			.poll(() =>
				backend.terminalSockets[0]!.sent.filter((f) => f.type === "input").map((f) => f.data),
			)
			.toEqual(["l", "s"]);
		await expect(page.locator(".tab-pane.active")).toContainText("$ ls");
	});

	test("switching tabs attaches the other tab without dropping the first", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.locator("#terminal-tabs .tab-chip", { hasText: "Tab 2" }).click();
		await expect
			.poll(() => backend.terminalSockets.map((s) => `${s.tabId}:${s.closed}`))
			.toEqual(["tab-1:false", "tab-2:false"]);
		await expect(page.locator(".tab-pane.active")).toContainText("(tab-2)");
	});
});
