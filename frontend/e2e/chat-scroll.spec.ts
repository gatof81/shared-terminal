import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * Scroll and navigation inside the three chats (ACP agent chat, Project Chat,
 * capture Chat): an opening shows the end, Back / Forward puts the reading
 * row back, a reader further up is never moved, and one "go to the end"
 * button (chatScroll.ts) for all three. The Back cases after a followed
 * link are in acp-chat.spec.ts; the keyboard cases in keyboard.spec.ts.
 */

const chatOf = (sid: string) => `#/sessions/${sid}/chat`;
const AGENT = "#acp-chat .acp-chat-thread";
const PROJECT = "#project-view .acp-chat-thread";

const gap = (t: Locator) =>
	t.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));

/** Where the row holding `text` sits, relative to the thread's top edge. */
const rowTop = (t: Locator, text: string) =>
	t.evaluate((el, text) => {
		const row = [...el.children].find((c) => c.textContent?.includes(text));
		if (!row) return Number.NaN;
		return Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top);
	}, text);

/** Reads further up: the row holding `text` at the top of the thread, `dy` px below its edge. */
async function readAt(page: Page, t: Locator, text: string, dy = 20): Promise<void> {
	await t.evaluate(
		(el, [text, dy]) => {
			const row = [...el.children].find((c) => c.textContent?.includes(text as string))!;
			el.style.scrollBehavior = "auto";
			el.scrollTop +=
				row.getBoundingClientRect().top - el.getBoundingClientRect().top - (dy as number);
			el.style.scrollBehavior = "";
		},
		[text, dy] as const,
	);
	// The thread's own scroll listener runs before anything else is asked of it.
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

const scrollBy = (t: Locator, top: number) =>
	t.evaluate((el, top) => {
		el.style.scrollBehavior = "auto";
		el.scrollTop = top < 0 ? el.scrollHeight - el.clientHeight + top : top;
		el.style.scrollBehavior = "";
	}, top);

/** Its entry transition (fade + 8 px) over: measured where it rests. */
const settled = (btn: Locator) =>
	btn.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));

/** The row keeps its place: ±1 px of rounding. */
async function stays(t: Locator, text: string, top: number, what: string): Promise<void> {
	await expect.poll(() => rowTop(t, text), what).toBeGreaterThanOrEqual(top - 1);
	expect(await rowTop(t, text), what).toBeLessThanOrEqual(top + 1);
}

test.describe("chat scroll: ACP chats", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		for (let i = 1; i <= 30; i++) {
			backend.addAcpMessage({
				to_id: "solo",
				body: `pregunta ${i}`,
				state: "done",
				result_text: `Respuesta ${i}.\n\nUna línea más para que ocupe lugar.\n\nY otra.`,
			});
			backend.addAcpMessage({
				to_id: "arq",
				body: `@arq tema ${i}`,
				state: "done",
				result_text: `Tema ${i} resuelto.\n\nCon una segunda línea.`,
				project_id: PROJECT_IDS.hz,
			});
		}
	});

	test("an opening shows the end: direct URL, the sidebar, another chat and back, Project Chat, a link, a reload", async ({
		app,
		backend,
		page,
	}) => {
		backend.addAcpMessage({
			to_id: "solo",
			body: "¿Dónde sigue?",
			state: "done",
			result_text: `En [el proyecto](#/projects/${PROJECT_IDS.hz}).`,
		});
		const agent = page.locator(AGENT);
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		await expect(agent).toContainText("Respuesta 30.");
		await expect.poll(() => gap(agent), "direct URL").toBeLessThan(4);

		// Reading further up, then another chat from the sidebar: its end.
		await readAt(page, agent, "pregunta 12");
		await app.openSession("hz-architect");
		await expect(agent).toContainText("Tema 30 resuelto.");
		await expect.poll(() => gap(agent), "another agent from the sidebar").toBeLessThan(4);
		// Back to the first one from the sidebar: an opening too — its end, not where it was left.
		await app.openSession("scratch");
		await expect(agent).toContainText("Respuesta 30.");
		await expect.poll(() => gap(agent), "the first agent again, from the sidebar").toBeLessThan(4);

		// Project Chat from its heading in the sidebar.
		await app.openSidebar();
		await page.locator(`.sgroup[data-group="${PROJECT_IDS.hz}"] a.sgroup-title`).click();
		const project = page.locator(PROJECT);
		await expect(project).toContainText("Tema 30 resuelto.");
		await expect.poll(() => gap(project), "Project Chat").toBeLessThan(4);

		// A link to it from another chat, read further up before: the end
		// (a followed link is a fragment navigation, not Back).
		await readAt(page, project, "tema 8");
		await app.openSession("scratch");
		await page.locator(AGENT).getByRole("link", { name: "el proyecto" }).click();
		await expect(project).toContainText("Tema 30 resuelto.");
		await expect.poll(() => gap(project), "a link").toBeLessThan(4);

		// A reload, read further up before it: the end.
		await readAt(page, project, "tema 8");
		await page.reload();
		await expect(project).toContainText("Tema 30 resuelto.");
		await expect.poll(() => gap(project), "a reload").toBeLessThan(4);
	});

	test("a reader further up is not moved: a message, an answer streaming, a state change, a taller field, a shorter screen, an earlier page", async ({
		app,
		backend,
		page,
	}) => {
		// Enough for an earlier page (the feed's page is 100 messages).
		for (let i = 31; i <= 110; i++)
			backend.addAcpMessage({
				to_id: "solo",
				body: `pregunta ${i}`,
				state: "done",
				result_text: `Respuesta ${i}.\n\nUna línea más para que ocupe lugar.`,
			});
		const above = backend.acpMessages.find((m) => m.body === "pregunta 95")!;
		const running = backend.addAcpMessage({ to_id: "solo", body: "pregunta en curso" });
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const t = page.locator(AGENT);
		const input = page.locator("#acp-chat .acp-chat-input");
		await expect(t).toContainText("pregunta en curso");
		await expect.poll(() => gap(t)).toBeLessThan(4);

		await readAt(page, t, "pregunta 100");
		const top = await rowTop(t, "pregunta 100");

		const row = backend.addAcpMessage({
			to_id: "solo",
			from_id: "arq",
			body: "Llegó mientras leías",
		});
		backend.pushAcp({ type: "message", message: row });
		await expect(t).toContainText("Llegó mientras leías");
		await stays(t, "pregunta 100", top, "a new message below");

		backend.updateAcpMessage(running.id, { state: "running" });
		backend.pushAcp({
			type: "activity",
			agent: "solo",
			events: [
				{
					seq: 1,
					at: "2026-10-31T10:29:59Z",
					messageId: running.id,
					kind: "text",
					text: "Escribiendo una respuesta\n\nlarga\n\nque crece",
				},
			],
		});
		await expect(t).toContainText("que crece");
		await stays(t, "pregunta 100", top, "an answer streaming below");

		// A row ABOVE the one being read changes height: the row read does not move.
		backend.updateAcpMessage(above.id, {
			state: "failed",
			note: "Falló.\n\nCon una nota\n\nde varias líneas.",
		});
		await expect(t).toContainText("de varias líneas.");
		await stays(t, "pregunta 100", top, "a state change above");

		await input.fill(Array.from({ length: 6 }, (_, i) => `línea ${i}`).join("\n"));
		await stays(t, "pregunta 100", top, "the field grew");
		await input.fill("");

		const vp = page.viewportSize()!;
		await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.7) });
		await stays(t, "pregunta 100", top, "a shorter screen");
		await page.setViewportSize(vp);

		// At the top (the button whole in view: a click on a cut one scrolls
		// it in first), the earlier page: the first row read stays where it is.
		await scrollBy(t, 0);
		const first = await rowTop(t, "pregunta 12");
		await t.getByRole("button", { name: "Cargar anteriores" }).click();
		await expect(t).toContainText("pregunta 11");
		await stays(t, "pregunta 12", first, "an earlier page");
	});

	test("the end button: by distance without a count, with a count for news, not for streaming; a tap goes to the end and keeps the field", async ({
		app,
		backend,
		page,
	}) => {
		const asked = backend.addAcpMessage({ to_id: "solo", body: "¿Cómo seguimos?" });
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const t = page.locator(AGENT);
		const btn = page.locator("#acp-chat .chat-end");
		const input = page.locator("#acp-chat .acp-chat-input");
		await expect(t).toContainText("¿Cómo seguimos?");
		await expect.poll(() => gap(t)).toBeLessThan(4);
		await expect(btn).toBeHidden();

		// A little way up: no button (under max(240 px, a screen)).
		await scrollBy(t, -150);
		await page.waitForTimeout(100);
		await expect(btn).toBeHidden();
		// Far up: the arrow alone.
		await scrollBy(t, 0);
		await expect(btn).toBeVisible();
		await expect(btn).toHaveAccessibleName("Ir al final");
		await expect(btn.locator(".chat-end-count")).toBeHidden();
		// The arrow alone: a 36-px circle, centred on the thread, 12 px above the message box.
		await settled(btn);
		const solo = (await btn.boundingBox())!;
		expect([Math.round(solo.width), Math.round(solo.height)]).toEqual([36, 36]);
		const composer = (await page.locator("#acp-chat .acp-chat-composer").boundingBox())!;
		expect(Math.round(composer.y - (solo.y + solo.height))).toBe(12);
		const col = (await t.boundingBox())!;
		expect(Math.abs(solo.x + solo.width / 2 - (col.x + col.width / 2))).toBeLessThanOrEqual(1);
		// Back near the end (but not at it): still up — no blinking around the threshold.
		await scrollBy(t, -150);
		await page.waitForTimeout(100);
		await expect(btn).toBeVisible();

		// Live activity and streamed text are not news.
		backend.updateAcpMessage(asked.id, { state: "running" });
		backend.pushAcp({
			type: "activity",
			agent: "solo",
			events: [
				{ seq: 1, at: "2026-10-31T10:29:59Z", messageId: asked.id, kind: "text", text: "Pensando" },
			],
		});
		await expect(t).toContainText("Pensando");
		await expect(btn.locator(".chat-end-count")).toBeHidden();
		// Its answer is: one; a new message, two.
		backend.updateAcpMessage(asked.id, { state: "done", result_text: "Seguimos así." });
		await expect(btn.locator(".chat-end-count")).toHaveText("1");
		await expect(btn).toHaveAccessibleName("Ir al final, 1 mensaje nuevo");
		const row = backend.addAcpMessage({ to_id: "solo", from_id: "arq", body: "Otro" });
		backend.pushAcp({ type: "message", message: row });
		await expect(btn.locator(".chat-end-count")).toHaveText("2");
		await expect(btn).toHaveAccessibleName("Ir al final, 2 mensajes nuevos");
		await expect(page.locator("#acp-chat .acp-thread-wrap [role=status]")).toHaveText(
			"2 mensajes nuevos más abajo",
		);

		// A 32-px pill with a 44-px target: 5 px outside its edges is still the button.
		await settled(btn);
		const box = (await btn.boundingBox())!;
		expect(Math.round(box.height)).toBe(32);
		const hits = await page.evaluate(
			({ x, y, w, h }) =>
				[
					[x + w / 2, y - 5],
					[x + w / 2, y + h + 5],
					[x - 5, y + h / 2],
					[x + w + 5, y + h / 2],
				].map(([px, py]) => document.elementFromPoint(px!, py!)?.classList.contains("chat-end")),
			{ x: box.x, y: box.y, w: box.width, h: box.height },
		);
		expect(hits).toEqual([true, true, true, true]);
		const target = await btn.evaluate((e) => {
			const c = getComputedStyle(e, "::before");
			return [Math.round(Number.parseFloat(c.width)), Math.round(Number.parseFloat(c.height))];
		});
		expect(target[1]).toBe(44);
		expect(target[0]).toBeGreaterThanOrEqual(44);
		await input.focus();
		await btn.click();
		await expect(btn).toBeHidden();
		await expect.poll(() => gap(t)).toBeLessThan(4);
		await expect(input).toBeFocused();
		// Arrived: nothing comes back by itself.
		await page.waitForTimeout(300);
		await expect(btn).toBeHidden();
	});
});

test.describe("chat scroll: the end button and an open question", () => {
	test("on a short phone screen with the field focused, news never puts the button over a question's options", async ({
		app,
		backend,
		page,
	}, info) => {
		test.skip(!info.project.use.isMobile, "phone");
		backend.enableAcp();
		for (let i = 1; i <= 8; i++)
			backend.addAcpMessage({
				to_id: "solo",
				body: `pregunta ${i}`,
				state: "done",
				result_text: `Respuesta ${i}.`,
			});
		const asking = backend.addAcpMessage({ to_id: "solo", body: "elegí", state: "running" });
		backend.acpQuestions = [
			{
				id: 1,
				agent: "solo",
				message_id: asking.id,
				request: JSON.stringify({
					message: "¿Qué proveedor usamos?",
					requestedSchema: {
						type: "object",
						properties: {
							p: { type: "string", title: "Proveedor", enum: ["GitHub", "Google", "GitLab"] },
						},
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
		await page.setViewportSize({ width: 390, height: 450 });
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		const t = page.locator(AGENT);
		const card = page.locator("#acp-chat .acp-question-open");
		await expect(card).toBeVisible();
		await page.locator("#acp-chat .acp-chat-input").focus();
		await scrollBy(t, -90);
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
		const row = backend.addAcpMessage({ to_id: "solo", from_id: "arq", body: "Llegó" });
		backend.pushAcp({ type: "message", message: row });
		const btn = page.locator("#acp-chat .chat-end");
		await expect(t).toContainText("Llegó");
		await page.waitForTimeout(300);
		if (await btn.isVisible()) {
			await btn.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
			const b = (await btn.boundingBox())!;
			// The button with its 44-px touch target (7 px past the pill).
			const hit = {
				top: b.y - 7,
				bottom: b.y + b.height + 7,
				left: b.x - 7,
				right: b.x + b.width + 7,
			};
			for (const o of await card.locator(".acp-option").all()) {
				const r = (await o.boundingBox())!;
				const overlaps =
					r.y < hit.bottom &&
					r.y + r.height > hit.top &&
					r.x < hit.right &&
					r.x + r.width > hit.left;
				expect(overlaps, `the button over "${await o.textContent()}"`).toBe(false);
			}
		}
	});
});

test.describe("chat scroll: capture Chat", () => {
	test.beforeEach(({ backend }) => {
		// More than one page (200 events) in the first conversation.
		const conv = backend.conversations[0]!;
		for (let i = 0; i < 260; i++)
			conv.events.push({
				seq: (conv.events.at(-1)?.seq ?? 0) + 1,
				ts: conv.events.at(-1)!.ts,
				ev: "assistant_delta",
				prompt_id: `p-f${i}`,
				turn_id: `t-f${i}`,
				agent_id: null,
				pane: "%1",
				data: { message_id: `mf${i}`, index: 0, delta: `Filler message ${i}`, final: true },
			});
	});

	const open = async (page: Page, title: string, mobile: boolean) => {
		if (mobile && (await page.locator("#chat-back-btn").isVisible()))
			await page.locator("#chat-back-btn").click();
		await page.locator("#chat-list .chat-conv-row", { hasText: title }).click();
	};

	test("an opening shows the end; Back puts the row back; reopening from the list or the view tab shows the end", async ({
		app,
		page,
		isMobile,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await open(page, "Refactor auth flow", isMobile);
		const sc = page.locator("#chat-thread .chat-scroll");
		await expect(sc).toContainText("Filler message 259");
		await expect.poll(() => gap(sc), "opened from the list").toBeLessThan(4);

		// Another view, then Back: the conversation, where it was being read.
		await readAt(page, sc, "Filler message 240");
		const top = await rowTop(sc, "Filler message 240");
		await app.switchView("terminal");
		await page.goBack();
		await app.expectView("chat");
		await stays(sc, "Filler message 240", top, "Back");

		// Another conversation and this one again, from the list: its end.
		await open(page, "Fix tests", isMobile);
		await expect(sc).toContainText("All green now.");
		await open(page, "Refactor auth flow", isMobile);
		await expect(sc).toContainText("Filler message 259");
		await expect.poll(() => gap(sc), "reopened from the list").toBeLessThan(4);

		// Another view and back by its tab: the end too.
		await readAt(page, sc, "Filler message 240");
		await app.switchView("terminal");
		await app.switchView("chat");
		await expect.poll(() => gap(sc), "the view shown again").toBeLessThan(4);
	});

	test("a reader further up is not moved by a new event or an earlier page; the end button counts and goes down", async ({
		app,
		backend,
		page,
		isMobile,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await open(page, "Refactor auth flow", isMobile);
		const sc = page.locator("#chat-thread .chat-scroll");
		const btn = page.locator("#chat-thread .chat-end");
		await expect(sc).toContainText("Filler message 259");
		await expect.poll(() => gap(sc)).toBeLessThan(4);
		await expect(btn).toBeHidden();

		await readAt(page, sc, "Filler message 230");
		const top = await rowTop(sc, "Filler message 230");
		await expect(btn).toBeVisible();
		await expect(btn).toHaveAccessibleName("Jump to latest");
		backend.pushConversationEvent("conv-1", {
			ts: new Date().toISOString(),
			ev: "assistant_delta",
			prompt_id: "p-new",
			turn_id: "t-new",
			agent_id: null,
			pane: "%1",
			data: { message_id: "m-new", index: 0, delta: "Arrived while reading", final: true },
		});
		await expect(sc).toContainText("Arrived while reading");
		await stays(sc, "Filler message 230", top, "a new event below");
		await expect(btn.locator(".chat-end-count")).toHaveText("1");
		await expect(btn).toHaveAccessibleName("Jump to latest, 1 new");

		await btn.click();
		await expect(btn).toBeHidden();
		await expect.poll(() => gap(sc)).toBeLessThan(4);

		// Reading up to the top: the earlier page (held until the row is
		// measured) lands without moving the row read.
		let release: (() => void) | null = null;
		backend.override = async (_method, path) => {
			if (!/\/events\?.*before=/.test(path)) return false;
			await new Promise<void>((r) => (release = r));
			return false;
		};
		await scrollBy(sc, 40);
		await expect.poll(() => release !== null, "the earlier page was asked for").toBe(true);
		const firstAt = await rowTop(sc, "Filler message 62");
		release!();
		await expect(sc).toContainText("Refactor the auth flow");
		await stays(sc, "Filler message 62", firstAt, "an earlier page");
	});
});
