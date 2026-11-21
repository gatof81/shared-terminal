// ACP chats (individual + Project Chat) against the mock's /acp routes and
// /ws/acp: what a person must not lose or misdirect while agents work.

import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const chatOf = (sid: string) => `#/sessions/${sid}/chat`;
const activity = (agent: string, seq: number) => ({
	type: "activity",
	agent,
	events: [{ seq, at: "2026-10-31T10:29:59Z", messageId: null, kind: "turn" }],
});

test.describe("ACP chat", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("an answer reads as Markdown, and a live event keeps the reader's selection", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const result = page.locator("#acp-chat .acp-msg-result");
		await expect(result.locator("h2")).toHaveText("Resumen");
		await expect(result.locator("strong")).toHaveText("dos");
		await expect(result.locator(".chat-pre .chat-copy")).toHaveCount(1);
		await page.evaluate(() => {
			const r = document.createRange();
			r.selectNodeContents(document.querySelector("#acp-chat .acp-msg-result h2")!);
			getSelection()!.removeAllRanges();
			getSelection()!.addRange(r);
		});
		backend.pushAcp(activity("solo", 1));
		backend.addAcpMessage({ to_id: "solo", body: "otra cosa" });
		backend.pushAcp({ type: "message", message: backend.acpMessages.at(-1) });
		await expect(page.locator("#acp-chat .acp-msg")).toHaveCount(2);
		expect(await page.evaluate(() => String(getSelection()))).toBe("Resumen");
	});

	test("an unsaved project choice and its focus survive live updates", async ({
		page,
		app,
		backend,
	}, info) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const opener = await app.openAgentSettings();
		const select = page.locator("#acp-chat .acp-project-select");
		await select.selectOption({ label: "Educación HZ" });
		await select.focus();
		backend.pushAcp(activity("solo", 1));
		backend.pushAcp(activity("solo", 2));
		await page.waitForTimeout(300);
		await expect(select).toHaveValue(PROJECT_IDS.hz);
		await expect(select).toBeFocused();
		// Closed (Escape: the focus goes back to what opened it) and reopened:
		// the choice is still there.
		await page.keyboard.press("Escape");
		await expect(select).toBeHidden();
		await expect(opener).toBeFocused();
		backend.pushAcp(activity("solo", 3));
		await page.waitForTimeout(300);
		await app.openAgentSettings();
		await expect(select).toHaveValue(PROJECT_IDS.hz);
		await page.locator("#acp-chat .acp-chat-project button", { hasText: "Guardar" }).click();
		// The project now shows in the bar's "proyecto ↗" on a wide screen (a
		// phone's bar has no room for that subtitle).
		if (!info.project.use.isMobile)
			await expect(
				page.locator("#terminal-session-sub a:visible", { hasText: "Educación HZ ↗" }),
			).toBeVisible();
		expect(backend.acpAgents.find((a) => a.name === "solo")?.projectId).toBe(PROJECT_IDS.hz);
	});

	test("a link to a place of the app in an answer navigates there, in the same tab", async ({
		page,
		app,
		backend,
	}) => {
		backend.addAcpMessage({
			to_id: "solo",
			body: "¿dónde lo veo?",
			state: "done",
			result_text: `Mirá [el proyecto](#/projects/${PROJECT_IDS.hz}) o [afuera](https://example.com).`,
		});
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const answer = page.locator("#acp-chat .acp-msg-result", { hasText: "Mirá" });
		const internal = answer.getByRole("link", { name: "el proyecto" });
		await expect(internal).toHaveAttribute("href", `#/projects/${PROJECT_IDS.hz}`);
		await expect(internal).not.toHaveAttribute("target", /.+/);
		const external = answer.getByRole("link", { name: "afuera" });
		await expect(external).toHaveAttribute("target", "_blank");
		await expect(external).toHaveAttribute("rel", "noopener noreferrer nofollow");
		const pages = page.context().pages().length;
		await internal.click();
		await expect(page.locator("#pv-title")).toHaveText("Educación HZ");
		expect(page.url()).toContain(`#/projects/${PROJECT_IDS.hz}`);
		expect(page.context().pages()).toHaveLength(pages);
	});

	// Back after following a link: the chat is where it was being read.
	const longThread = (
		backend: {
			addAcpMessage: (m: Record<string, unknown> & { to_id: string; body: string }) => unknown;
		},
		to: string,
		link: string,
		project?: string,
	) => {
		for (let i = 1; i <= 30; i++)
			backend.addAcpMessage({
				to_id: to,
				body: `pregunta ${i}`,
				state: "done",
				result_text:
					i === 15
						? `Respuesta 15: mirá [el destino](${link}).`
						: `Respuesta ${i}.\n\nUna línea más para que ocupe lugar.\n\nY otra.`,
				...(project ? { project_id: project } : {}),
			});
	};
	const placeOf = (page: import("@playwright/test").Page, thread: string, text: string) =>
		page.evaluate(
			([thread, text]) => {
				const t = document.querySelector<HTMLElement>(thread)!;
				const row = [...t.querySelectorAll<HTMLElement>("[data-anchor]")].find((r) =>
					r.textContent?.includes(text),
				)!;
				return Math.round(row.getBoundingClientRect().top - t.getBoundingClientRect().top);
			},
			[thread, text] as const,
		);

	test("Back after a followed link puts the agent's chat where it was being read", async ({
		page,
		app,
		backend,
	}) => {
		longThread(backend, "solo", `#/projects/${PROJECT_IDS.hz}`);
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const thread = "#acp-chat .acp-chat-thread";
		const link = page.locator(thread).getByRole("link", { name: "el destino" });
		await link.scrollIntoViewIfNeeded();
		const before = await placeOf(page, thread, "Respuesta 15:");
		await link.click();
		await expect(page.locator("#pv-title")).toHaveText("Educación HZ");
		await page.goBack();
		await expect(link).toBeInViewport();
		expect(Math.abs((await placeOf(page, thread, "Respuesta 15:")) - before)).toBeLessThanOrEqual(
			2,
		);
	});

	test("Back after a link to ANOTHER agent's chat puts this chat where it was being read", async ({
		page,
		app,
		backend,
	}) => {
		// The same chat view, another source: the thread is emptied and read again on Back.
		longThread(backend, "solo", chatOf(PROJECT_SESSION_IDS.architect));
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const thread = "#acp-chat .acp-chat-thread";
		const link = page.locator(thread).getByRole("link", { name: "el destino" });
		await link.scrollIntoViewIfNeeded();
		const before = await placeOf(page, thread, "Respuesta 15:");
		await link.click();
		await expect(page.locator(thread).getByText("@arq revisá el diseño")).toBeVisible();
		await page.goBack();
		await expect(link).toBeInViewport();
		expect(Math.abs((await placeOf(page, thread, "Respuesta 15:")) - before)).toBeLessThanOrEqual(
			2,
		);
	});

	test("Back after a followed link puts Project Chat where it was being read", async ({
		page,
		app,
		backend,
	}) => {
		longThread(backend, "arq", chatOf(PROJECT_SESSION_IDS.scratch), PROJECT_IDS.hz);
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const thread = "#project-view .acp-chat-thread";
		const link = page.locator(thread).getByRole("link", { name: "el destino" });
		await link.scrollIntoViewIfNeeded();
		const before = await placeOf(page, thread, "Respuesta 15:");
		await link.click();
		await expect(page.locator("#acp-chat")).toBeVisible();
		await page.goBack();
		await expect(link).toBeInViewport();
		expect(Math.abs((await placeOf(page, thread, "Respuesta 15:")) - before)).toBeLessThanOrEqual(
			2,
		);
	});

	test("a reader at the end comes back to the end", async ({ page, app, backend }) => {
		longThread(backend, "solo", `#/projects/${PROJECT_IDS.hz}`);
		backend.addAcpMessage({
			to_id: "solo",
			body: "última",
			state: "done",
			result_text: `Al final: [ir](#/projects/${PROJECT_IDS.hz}).`,
		});
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const link = page.locator("#acp-chat .acp-chat-thread").getByRole("link", { name: "ir" });
		await expect(link).toBeInViewport();
		await link.click();
		await expect(page.locator("#pv-title")).toHaveText("Educación HZ");
		await page.goBack();
		await expect(link).toBeInViewport();
		expect(
			await page.evaluate(() => {
				const t = document.querySelector<HTMLElement>("#acp-chat .acp-chat-thread")!;
				return t.scrollHeight - t.scrollTop - t.clientHeight;
			}),
		).toBeLessThan(60);
	});

	test("on a wide screen both chats read in the same centred column, the message box with them", async ({
		page,
		app,
	}) => {
		test.skip(app.mobile, "the column applies above a phone's width");
		await page.setViewportSize({ width: 1920, height: 1080 });
		const column = async (root: string) => {
			await expect(page.locator(`${root} .acp-chat-thread .acp-msg`).first()).toBeVisible();
			return page.evaluate((r) => {
				const box = (sel: string) => document.querySelector(`${r} ${sel}`)!.getBoundingClientRect();
				const inner = (sel: string) => {
					const e = document.querySelector(`${r} ${sel}`)!;
					const b = e.getBoundingClientRect();
					const cs = getComputedStyle(e);
					return {
						left: b.left + Number.parseFloat(cs.paddingLeft),
						right: b.right - Number.parseFloat(cs.paddingRight),
					};
				};
				const out = box(".acp-out");
				const reply = box(".acp-in, .acp-sub");
				return {
					thread: inner(".acp-chat-thread"),
					composer: inner(".acp-chat-composer"),
					spread: Math.round(out.right - reply.left),
				};
			}, root);
		};
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		const solo = await column("#acp-chat");
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`);
		const project = await column(".acp-project");
		const colPx = 56 * 16;
		for (const c of [solo, project]) {
			// A request and its answer at most a column apart (was 1632 px on the solo chat).
			expect(c.spread).toBeLessThanOrEqual(colPx);
			expect(Math.round(c.thread.right - c.thread.left)).toBe(colPx);
			// The message box sits in the same column as the thread.
			expect(Math.abs(c.composer.left - c.thread.left)).toBeLessThan(1);
			expect(Math.abs(c.composer.right - c.thread.right)).toBeLessThan(1);
		}
		// And the same column in both chats.
		expect(Math.abs(solo.thread.left - project.thread.left)).toBeLessThan(1);
	});

	test("a re-read that fails keeps the history and says so in words, not the server's code", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const result = page.locator("#acp-chat .acp-msg-result");
		await expect(result.locator("h2")).toHaveText("Resumen");
		backend.override = async (method, path, route) => {
			if (method !== "GET" || !path.startsWith("/acp/agents/solo/feed")) return false;
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: '{"error":"internal"}',
			});
			return true;
		};
		// The live socket drops; its reconnect re-reads the feed, which now fails.
		backend.dropAcpSockets();
		const error = page.locator("#acp-chat .acp-chat-error");
		await expect(error).toHaveText("No se pudo actualizar el chat.");
		await expect(result.locator("h2")).toBeVisible();
	});

	test("a draft stays with its agent", async ({ page, app }) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const input = page.locator("#acp-chat .acp-chat-input");
		await input.fill("solo para @solo");
		await page.evaluate((h) => {
			location.hash = h;
		}, chatOf(PROJECT_SESSION_IDS.architect));
		await expect(page.locator("#acp-chat .acp-chat-title")).toContainText("@arq");
		await expect(input).toHaveValue("");
		await page.evaluate((h) => {
			location.hash = h;
		}, chatOf(PROJECT_SESSION_IDS.scratch));
		await expect(page.locator("#acp-chat .acp-chat-title")).toContainText("@solo");
		await expect(input).toHaveValue("solo para @solo");
	});

	test("Project Chat refuses an unknown leading mention, next to the field", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const input = page.locator("#project-view .acp-chat-input");
		await expect(page.locator("#project-view .acp-agents-group")).toHaveAccessibleName(
			/^Agentes del proyecto: 2\./,
		);
		await input.fill("@devv revisá con @arq");
		await page.locator("#project-view .acp-chat-send").click();
		const error = page.locator("#project-view .acp-chat-composer .acp-chat-error");
		await expect(error).toContainText("@devv");
		await expect(error).toBeInViewport();
		await expect(input).toHaveValue("@devv revisá con @arq");
		expect(
			backend.requests.filter((r) => r.method === "POST" && r.path === "/acp/messages"),
		).toEqual([]);
		// Fixed, it goes to exactly the named agent.
		await input.fill("@dev revisá con @arq");
		await page.locator("#project-view .acp-chat-send").click();
		await expect(input).toHaveValue("");
		await expect(error).toBeHidden();
		expect(backend.acpMessages.at(-1)).toMatchObject({ to_id: "dev", project_id: PROJECT_IDS.hz });
	});
});

test.describe("ACP model", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("creating an agent with Opus sends its model id; Sonnet stays the default", async ({
		page,
		app,
		backend,
	}) => {
		const created: Array<Record<string, unknown>> = [];
		backend.override = async (method, path, route) => {
			if (method !== "POST" || path !== "/sessions") return false;
			created.push(JSON.parse(route.request().postData() ?? "{}"));
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: '{"error":"stop here"}',
			});
			return true;
		};
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await page.fill("#new-session-input", "arquitectura");
		await page.fill("#new-session-acp-agent", "architect");
		const model = page.locator("#new-session-acp-model");
		await expect(model).toBeVisible();
		await expect(model).toHaveValue("claude-sonnet-5-5");
		expect(await model.locator("option").allTextContents()).toEqual([
			"Claude Sonnet 5.5",
			"Claude Opus 5.5",
			"Claude Fable 5.2",
		]);
		await model.selectOption({ label: "Claude Opus 5.5" });
		await page.click("#new-session-submit");
		await expect.poll(() => created.length).toBe(1);
		expect(created[0]?.acpAgent).toMatchObject({ name: "architect", model: "claude-opus-5-5" });
	});

	test("an existing agent's model changes from its chat, and reads pending until applied", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		await app.openAgentSettings();
		const select = page.locator("#acp-chat .acp-model-select");
		await expect(select).toHaveValue("");
		await select.selectOption({ label: "Claude Opus 5.5" });
		await page.locator("#acp-chat .acp-chat-model button", { hasText: "Cambiar modelo" }).click();
		await expect(page.locator("#acp-chat .acp-model-state")).toContainText(
			"Se aplica cuando @solo esté libre",
		);
		await expect(select).toHaveValue("claude-opus-5-5");
		expect(backend.acpAgents.find((a) => a.name === "solo")?.model).toBe("claude-opus-5-5");
		expect(
			backend.requests.filter((r) => r.method === "PATCH" && r.path === "/acp/agents/solo"),
		).toHaveLength(1);
	});
});

// The headers: the essentials on one row, the rest in a panel closed by default.
test.describe("ACP chat headers", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("the agent's header: the session bar; settings closed; a refused model flagged where they open", async ({
		page,
		app,
		backend,
	}, info) => {
		const solo = backend.acpAgents.find((a) => a.name === "solo")!;
		solo.projectId = PROJECT_IDS.hz;
		solo.model = "claude-opus-5-5";
		solo.modelApplied = {
			requested: "claude-opus-5-5",
			current: null,
			error: "modelo no disponible",
		};
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const header = page.locator("#acp-chat .acp-chat-header");
		await expect(page.locator("#acp-chat .acp-settings")).toBeHidden();
		// The bar names the agent (and its session) in either case.
		await expect(page.locator("#terminal-session-name")).toHaveText("@solo");
		await expect(page.locator("#terminal-toolbar")).toHaveAttribute("data-session-name", "scratch");
		await expect(header).toBeHidden();
		if (!info.project.use.isMobile)
			await expect(page.locator("#terminal-session-sub")).toHaveText(
				"sesión scratch · Educación HZ ↗",
			);
		// The privacy first on a phone (a long name cuts the end off).
		await expect(page.locator("#acp-chat .acp-chat-input")).toHaveAttribute(
			"placeholder",
			info.project.use.isMobile
				? "Privado · a @solo"
				: "Mensaje privado a @solo · Ctrl+Enter envía",
		);
		// The failure is on what opens the closed panel: visibly and by name.
		const more = page.locator("#session-menu-btn");
		await expect(more).toHaveAccessibleName("Session actions (el modelo no se aplicó)");
		await expect(more.locator(".bar-menu-flag")).toBeVisible();
		await app.openAgentSettings();
		await expect(page.locator("#acp-chat .acp-model-state")).toContainText("modelo no disponible");
	});

	test("Project Chat: title, the agents' group, ⋯ and × on ONE row; the manage panel is closed, open on an empty project", async ({
		page,
		app,
		backend,
	}, info) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const head = page.locator("#project-view .pv-header");
		await expect(page.locator("#project-view .acp-agents-group")).toBeVisible();
		// No second row of agents.
		await expect(page.locator("#project-view .acp-project-agents")).toBeHidden();
		const panel = page.locator("#project-view .acp-agents-panel");
		await expect(panel).toBeHidden();
		// One row (44-px controls, the padding and the line under it).
		const row = info.project.use.isMobile ? 60 : 56;
		expect((await head.boundingBox())!.height).toBeLessThanOrEqual(row);
		// The manage panel, from the menu; an agent picked (not added) survives live
		// updates and the panel closing and reopening.
		const menu = page.getByRole("button", { name: "Acciones del proyecto" });
		await menu.click();
		await page.getByRole("menuitem", { name: "Administrar agentes" }).click();
		await expect(panel).toBeVisible();
		const add = panel.locator(".acp-add-select");
		await add.selectOption("solo");
		backend.pushAcp(activity("dev", 1));
		await page.waitForTimeout(300);
		await page.keyboard.press("Escape");
		await expect(panel).toBeHidden();
		await expect(menu).toBeFocused();
		await menu.click();
		await page.getByRole("menuitem", { name: "Administrar agentes" }).click();
		await expect(add).toHaveValue("solo");
		await panel.getByRole("button", { name: "Agregar", exact: true }).click();
		await expect
			.poll(() => backend.acpAgents.find((a) => a.name === "solo")?.projectId)
			.toBe(PROJECT_IDS.hz);
	});

	test("a project without agents opens on the manage panel: it is all there is to do", async ({
		page,
		app,
		backend,
	}) => {
		for (const a of backend.acpAgents) a.projectId = null;
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const panel = page.locator("#project-view .acp-agents-panel");
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("button", { name: "+ Nueva sesión con agente" })).toBeVisible();
		await expect(panel).toContainText("todavía no tiene agentes");
	});

	test("on a short screen an open panel scrolls inside: the message box stays on screen, the thread keeps a strip", async ({
		page,
		app,
		backend,
	}) => {
		const vp = page.viewportSize()!;
		await page.setViewportSize({ width: Math.min(vp.width, 390), height: 450 });
		const inView = async (sel: string) => {
			const b = (await page.locator(sel).boundingBox())!;
			return b.y >= 0 && b.y + b.height <= 451;
		};
		// Project Chat with "Administrar agentes" open.
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await page.getByRole("button", { name: "Acciones del proyecto" }).click();
		await page.getByRole("menuitem", { name: "Administrar agentes" }).click();
		const panel = page.locator("#project-view .acp-agents-panel");
		await expect(panel).toBeVisible();
		expect(await inView("#project-view .acp-chat-composer"), "composer on screen").toBe(true);
		expect(await panel.evaluate((e) => e.scrollHeight > e.clientHeight + 1), "panel scrolls").toBe(
			true,
		);
		expect(await panel.evaluate((e) => getComputedStyle(e).overflowY)).toBe("auto");
		const strip = (await page.locator("#project-view .acp-chat-thread").boundingBox())!.height;
		expect(strip, "a readable strip of thread").toBeGreaterThanOrEqual(90);
		// Scrolled to its end, the panel's heading and × stay in view and take the tap.
		await panel.evaluate((e) => {
			e.scrollTop = e.scrollHeight;
		});
		const close = panel.locator(".acp-agents-panel-close");
		const pb = (await panel.boundingBox())!;
		const cb = (await close.boundingBox())!;
		expect(cb.y, "× inside the panel's visible box").toBeGreaterThanOrEqual(pb.y - 1);
		expect(
			await page.evaluate(
				([x, y]) => document.elementFromPoint(x!, y!)?.closest(".acp-agents-panel-close") !== null,
				[cb.x + cb.width / 2, cb.y + cb.height / 2],
			),
			"nothing covers the ×",
		).toBe(true);
		await close.click();
		await expect(panel).toBeHidden();
		await page.getByRole("button", { name: "Acciones del proyecto" }).click();
		await page.getByRole("menuitem", { name: "Administrar agentes" }).click();
		// Ajustes of an agent's chat, the same way.
		const solo = backend.acpAgents.find((a) => a.name === "solo")!;
		solo.projectId = PROJECT_IDS.hz;
		await page.evaluate((h) => {
			location.hash = h;
		}, chatOf(PROJECT_SESSION_IDS.scratch));
		await app.openAgentSettings();
		await expect(page.locator("#acp-chat .acp-settings")).toContainText(
			"Mensajes directos: privados entre vos y @solo",
		);
		expect(await inView("#acp-chat .acp-chat-composer"), "composer on screen").toBe(true);
		expect(
			(await page.locator("#acp-chat .acp-chat-thread").boundingBox())!.height,
		).toBeGreaterThanOrEqual(90);
	});

	test("Project Chat with a long history opens at its end, entered directly and coming back", async ({
		page,
		app,
		backend,
	}) => {
		for (let i = 0; i < 28; i++)
			backend.addAcpMessage({
				to_id: "arq",
				body: `@arq pregunta ${i}`,
				state: "done",
				result_text: `Respuesta ${i}.\n\nUna línea más.\n\nY otra.`,
				project_id: PROJECT_IDS.hz,
			});
		await page.setViewportSize({ width: 390, height: 844 });
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const thread = page.locator("#project-view .acp-chat-thread");
		await expect(thread).toContainText("Respuesta 27.");
		const gap = () =>
			thread.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));
		// The header is rebuilt once the project's name is read: the thread must stay put.
		await page.waitForTimeout(500);
		expect(await gap()).toBeLessThan(60);
		await page.evaluate(
			(h) => (location.hash = h),
			`#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`,
		);
		await expect(page.locator("#acp-chat .acp-chat-input")).toBeVisible();
		await page.goBack();
		await expect(thread).toBeVisible();
		await page.waitForTimeout(500);
		expect(await gap()).toBeLessThan(60);
	});

	test("the agents' group: 3 avatars on a phone, '+N'; an agent waiting in the '+N' is still marked and said; the list opens its chat", async ({
		page,
		app,
		backend,
	}) => {
		const base = backend.acpAgents.find((a) => a.name === "dev")!;
		for (let i = 0; i < 4; i++)
			backend.acpAgents.push({ ...base, name: `agente-${i}`, sessionId: `${base.sessionId}-${i}` });
		// Last in the list, and not busy: it would fall in the "+N" without its rank.
		Object.assign(backend.acpAgents.find((a) => a.name === "agente-3")!, { waitingInput: true });
		Object.assign(backend.acpAgents.find((a) => a.name === "agente-2")!, { authRequired: true });
		await page.setViewportSize({ width: 320, height: 568 });
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const group = page.locator("#project-view .acp-agents-group");
		await expect(group.locator(".acp-group-avatar")).toHaveCount(3);
		await expect(group.locator(".acp-group-more")).toHaveText("+3");
		await expect(group.locator(".acp-group-alert")).toHaveText("2 !");
		await expect(group).toHaveAccessibleName(
			"Agentes del proyecto: 6. @agente-2 necesita login. @agente-3 espera tu respuesta.",
		);
		// Title, group, ⋯ and × fit one row at 320.
		const head = page.locator("#project-view .pv-header");
		expect((await head.boundingBox())!.height).toBeLessThanOrEqual(60);
		// The full list: every agent, its long state, a link to its chat; Escape back to the button.
		await group.click();
		await expect(group).toHaveAttribute("aria-expanded", "true");
		const list = page.locator("#project-view .acp-agents-list");
		await expect(list.locator(".acp-agents-list-item")).toHaveCount(6);
		await expect(list).toContainText("@agente-3esperando tu respuesta");
		// The focus goes in, on the first agent's link (the one that needs you first).
		await expect(page.getByRole("link", { name: "Abrir su chat (@agente-2)" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(list).toBeHidden();
		await expect(group).toBeFocused();
		await group.click();
		await page.getByRole("link", { name: "Abrir su chat (@dev)" }).click();
		await expect(page.locator("#acp-chat .acp-chat-title")).toContainText("@dev");
	});
});

// The message box and the thread's scroll (shared by the individual chat and
// Project Chat): what a phone leaves for reading, and a reader's place.
test.describe("ACP chat composer and scroll", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		for (let i = 0; i < 14; i++)
			backend.addAcpMessage({
				to_id: "solo",
				body: `Relleno ${i}`,
				state: "done",
				result_text: `Hecho ${i}.\n\nUna segunda línea para que el hilo ocupe lugar.`,
			});
	});

	test("one row at rest on a phone, grows with the text up to a cap, back to one row after sending", async ({
		page,
		app,
	}, info) => {
		test.skip(!info.project.use.isMobile, "phone layout");
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const input = page.locator("#acp-chat .acp-chat-input");
		const send = page.locator("#acp-chat .acp-chat-send");
		const height = async (l: typeof input) => Math.round((await l.boundingBox())!.height);
		await expect(input).toBeVisible();
		// One surface of 44 px at rest: the field and Enviar side by side, the
		// arrow's target the whole 44 px (its cell plus the 1-px border band); no
		// line above it at rest.
		const surface = page.locator("#acp-chat .acp-chat-field");
		expect(await height(surface)).toBe(44);
		expect(await height(input)).toBeLessThanOrEqual(44);
		const s = (await surface.boundingBox())!;
		const b = (await send.boundingBox())!;
		const hits = await page.evaluate(
			([x, top, bottom]) =>
				[top, bottom].map(
					(y) => document.elementFromPoint(x!, y!)?.closest(".acp-chat-send") !== null,
				),
			[b.x + b.width / 2, s.y + 0.5, s.y + s.height - 0.5],
		);
		expect(hits).toEqual([true, true]);
		await expect(page.locator("#acp-chat .acp-chat-hint")).toBeHidden();
		expect(await height(page.locator("#acp-chat .acp-chat-composer"))).toBeLessThanOrEqual(64);

		await input.fill("uno\ndos\ntres");
		const three = await height(input);
		expect(three).toBeGreaterThan(70);
		await input.fill(Array.from({ length: 20 }, (_, i) => `línea ${i}`).join("\n"));
		const capped = await height(input);
		// A phone: up to 30 % of the visible height, and never past 8 lines of
		// 22 px plus padding — well under 20 lines.
		expect(capped).toBeLessThanOrEqual(Math.round(page.viewportSize()!.height * 0.3) + 1);
		expect(capped).toBeLessThanOrEqual(8 * 22 + 20);
		expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

		// A tap on Enviar keeps the focus in the field (no blur closing the keyboard).
		await send.tap();
		await expect(input).toHaveValue("");
		await expect(input).toBeFocused();
		await expect.poll(() => height(input)).toBeLessThanOrEqual(46);
	});

	test("a reader at the end stays there when the thread shrinks; one further up keeps their place and gets the end button", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const thread = page.locator("#acp-chat .acp-chat-thread");
		const input = page.locator("#acp-chat .acp-chat-input");
		await expect(thread).toContainText("Hecho 13.");
		const gap = () =>
			thread.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));
		await expect.poll(gap).toBeLessThan(4);
		// The field grows (no scroll event on the thread): still at the end.
		await input.fill(Array.from({ length: 8 }, (_, i) => `l${i}`).join("\n"));
		await expect.poll(gap, "the field grew, the end stays in view").toBeLessThan(4);
		const vp = page.viewportSize()!;
		await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.6) });
		await expect.poll(gap, "a shorter screen, the end stays in view").toBeLessThan(4);
		await page.setViewportSize(vp);
		await expect.poll(gap).toBeLessThan(4);

		// Reading further up: a new message does not move the reader.
		await thread.evaluate((el) => {
			el.scrollTop = 40;
			el.dispatchEvent(new Event("scroll"));
		});
		// Far from the end: the end button, the arrow alone (chat-scroll.spec.ts has its rules).
		const pill = page.locator("#acp-chat .chat-end");
		const count = pill.locator(".chat-end-count");
		await expect(pill).toBeVisible();
		await expect(count).toBeHidden();
		const row = backend.addAcpMessage({
			to_id: "solo",
			from_id: "arq",
			body: "Llegó mientras leías",
		});
		backend.pushAcp({ type: "message", message: row });
		await expect(thread).toContainText("Llegó mientras leías");
		await expect(count).toHaveText("1");
		expect(await thread.evaluate((el) => el.scrollTop)).toBe(40);
		await pill.click();
		await expect.poll(gap).toBeLessThan(4);
		await expect(pill).toBeHidden();
	});

	test("an answer to a row already shown counts in the end button; tapping it goes to the end", async ({
		page,
		app,
		backend,
	}) => {
		const asked = backend.addAcpMessage({ to_id: "solo", body: "¿Cómo seguimos?" });
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const thread = page.locator("#acp-chat .acp-chat-thread");
		await expect(thread).toContainText("¿Cómo seguimos?");
		const gap = () =>
			thread.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));
		await expect.poll(gap).toBeLessThan(4);
		await thread.evaluate((el) => {
			el.scrollTop = 40;
			el.dispatchEvent(new Event("scroll"));
		});
		const pill = page.locator("#acp-chat .chat-end");
		const count = pill.locator(".chat-end-count");
		// Live activity of the running message is not news.
		backend.updateAcpMessage(asked.id, { state: "running" });
		await page.waitForTimeout(300);
		await expect(count).toBeHidden();
		backend.updateAcpMessage(asked.id, {
			state: "done",
			result_text: Array.from({ length: 30 }, (_, i) => `Paso ${i + 1}.`).join("\n\n"),
		});
		await expect(thread).toContainText("Paso 30.");
		await expect(count).toHaveText("1");
		await expect(page.locator("#acp-chat .acp-thread-wrap [role=status]")).toHaveText(
			"1 mensaje nuevo más abajo",
		);
		expect(await thread.evaluate((el) => el.scrollTop)).toBe(40);
		await pill.click();
		await expect.poll(gap).toBeLessThan(4);
		await expect(pill).toBeHidden();
	});
});

// A phone: with the field focused, one tap on any control of
// the chat does what it says — the nav coming back must not move the layout
// between the tap's mousedown and its click.
test.describe("ACP chat: taps with the keyboard up", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		for (let i = 0; i < 14; i++)
			backend.addAcpMessage({
				to_id: "solo",
				body: `Relleno ${i}`,
				state: "done",
				result_text: `Hecho ${i}.\n\nUna segunda línea para que el hilo ocupe lugar.`,
			});
	});

	test("Recuperar el texto no enviado works on the first tap", async ({
		page,
		app,
		backend,
	}, info) => {
		test.skip(!info.project.use.isMobile, "phone");
		let fail = true;
		backend.override = async (method, path, route) => {
			if (method !== "POST" || path !== "/acp/messages" || !fail) return false;
			await new Promise((r) => setTimeout(r, 400));
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: '{"error":"caído"}',
			});
			return true;
		};
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const input = page.locator("#acp-chat .acp-chat-input");
		await input.fill("el primero");
		await page.locator("#acp-chat .acp-chat-send").tap();
		// Typed while the send was out: the failed text is offered, not written over this.
		await input.fill("otro borrador");
		const recover = page.locator("#acp-chat .acp-recover");
		await expect(recover).toBeVisible();
		fail = false;
		await input.focus();
		await expect(page.locator("#view-nav")).toBeHidden();
		await recover.tap();
		await expect(input).toHaveValue("otro borrador\n\nel primero");
	});

	test("an option of a question at the end of a long thread is chosen on the first tap", async ({
		page,
		app,
		backend,
	}, info) => {
		test.skip(!info.project.use.isMobile, "phone");
		const asking = backend.addAcpMessage({
			to_id: "solo",
			body: "elegí el proveedor",
			state: "running",
		});
		backend.acpQuestions = [
			{
				id: 1,
				agent: "solo",
				message_id: asking.id,
				request: JSON.stringify({
					message: "¿Qué proveedor usamos?",
					requestedSchema: {
						type: "object",
						properties: { p: { type: "string", title: "Proveedor", enum: ["GitHub", "Google"] } },
						required: ["p"],
					},
				}),
				state: "open",
				answer: null,
				created_at: "2026-10-31T10:29:30Z",
				answered_at: null,
				delivered_at: null,
				note: null,
			},
		];
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const option = page.locator("#acp-chat .acp-question-open .acp-option", { hasText: "Google" });
		await expect(option).toBeVisible();
		await page.locator("#acp-chat .acp-chat-input").focus();
		await expect(page.locator("#view-nav")).toBeHidden();
		await option.tap();
		await expect(option.locator("input")).toBeChecked();
	});
});
