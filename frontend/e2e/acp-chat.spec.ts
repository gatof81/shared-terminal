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
	}) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const select = page.locator("#acp-chat .acp-project-select");
		await select.selectOption({ label: "Educación HZ" });
		await select.focus();
		backend.pushAcp(activity("solo", 1));
		backend.pushAcp(activity("solo", 2));
		await page.waitForTimeout(300);
		await expect(select).toHaveValue(PROJECT_IDS.hz);
		await expect(select).toBeFocused();
		await page.locator("#acp-chat .acp-chat-project button", { hasText: "Guardar" }).click();
		await expect(
			page.locator("#acp-chat .acp-link", { hasText: "Abrir Project Chat" }),
		).toBeVisible();
		expect(backend.acpAgents.find((a) => a.name === "solo")?.projectId).toBe(PROJECT_IDS.hz);
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
		await expect(page.locator("#project-view .acp-agent-chip")).toHaveCount(2);
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
		// One row: the field and Enviar side by side, 44 px; no hint row at rest.
		expect(await height(input)).toBeLessThanOrEqual(46);
		expect(await height(send)).toBeGreaterThanOrEqual(44);
		expect(Math.abs((await input.boundingBox())!.y - (await send.boundingBox())!.y)).toBeLessThan(
			2,
		);
		await expect(page.locator("#acp-chat .acp-chat-hint")).toBeHidden();
		expect(await height(page.locator("#acp-chat .acp-chat-composer"))).toBeLessThanOrEqual(64);

		await input.fill("uno\ndos\ntres");
		const three = await height(input);
		expect(three).toBeGreaterThan(70);
		await input.fill(Array.from({ length: 20 }, (_, i) => `línea ${i}`).join("\n"));
		const capped = await height(input);
		// 6 lines of 16 px × 1.4 plus padding, well under 20 lines.
		expect(capped).toBeLessThanOrEqual(160);
		expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

		// A tap on Enviar keeps the focus in the field (no blur closing the keyboard).
		await send.tap();
		await expect(input).toHaveValue("");
		await expect(input).toBeFocused();
		await expect.poll(() => height(input)).toBeLessThanOrEqual(46);
	});

	test("a reader at the end stays there when the thread shrinks; one further up keeps their place and gets a pill", async ({
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
		const pill = page.locator("#acp-chat .acp-new-pill");
		await expect(pill).toBeHidden();
		const row = backend.addAcpMessage({
			to_id: "solo",
			from_id: "arq",
			body: "Llegó mientras leías",
		});
		backend.pushAcp({ type: "message", message: row });
		await expect(thread).toContainText("Llegó mientras leías");
		await expect(pill).toHaveText("↓ 1 nuevo");
		expect(await thread.evaluate((el) => el.scrollTop)).toBe(40);
		await pill.click();
		await expect.poll(gap).toBeLessThan(4);
		await expect(pill).toBeHidden();
	});
});
