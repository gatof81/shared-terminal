// A topic's thread (acpThread.ts, source "conversation"): what the specs of
// the retired chats (acp-chat, chat-scroll, acp-recipients — removed in F5)
// proved of the thread every topic still draws, with the topic's selectors.
// What acp-topic.spec.ts, project-rail.spec.ts, acp-composer.spec.ts and
// keyboard.spec.ts already prove is not repeated here.

import type { Locator, Page } from "@playwright/test";
import { type App, expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const topic = (id: string) => `#/projects/${HZ}/c/${id}`;
const ROOT = "#project-view .ps-topic";
const THREAD = `${ROOT} .acp-chat-thread`;
const T0 = Date.parse("2026-10-31T10:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const field = (page: Page) => page.locator(`${ROOT} .acp-chat-input`);
const send = (page: Page) => page.locator(`${ROOT} .acp-chat-send`);
const endBtn = (page: Page) => page.locator(`${ROOT} .chat-end`);
const convRow = (page: Page, title: string) =>
	page
		.locator(".rail-body .rail-conv")
		.filter({ has: page.locator(".rail-row-title", { hasText: title }) });

const gap = (t: Locator) =>
	t.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));

/** Where the row holding `text` sits, relative to the thread's top edge. */
const rowTop = (t: Locator, text: string) =>
	t.evaluate((el, text) => {
		const row = [...el.children].find((c) => c.textContent?.includes(text));
		if (!row) return Number.NaN;
		return Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top);
	}, text);

const frame = (page: Page) =>
	page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

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
	await frame(page);
}

const scrollTo = (t: Locator, top: number) =>
	t.evaluate((el, top) => {
		el.style.scrollBehavior = "auto";
		el.scrollTop = top < 0 ? el.scrollHeight - el.clientHeight + top : top;
		el.style.scrollBehavior = "";
	}, top);

/** The row keeps its place: ±1 px of rounding. */
async function stays(t: Locator, text: string, top: number, what: string): Promise<void> {
	await expect.poll(() => rowTop(t, text), what).toBeGreaterThanOrEqual(top - 1);
	expect(await rowTop(t, text), what).toBeLessThanOrEqual(top + 1);
}

/**
 * `n` asks of the person to @dev in «Mejoras del backend», each answered;
 * `answer(i)` overrides an answer's text. All read: the topic opens at its end.
 */
function fill(
	backend: MockBackend,
	n: number,
	answer: (i: number) => string | undefined = () => undefined,
	conv = CONV_IDS.backend,
	from = 1,
): void {
	for (let i = from; i < from + n; i++)
		backend.addAcpMessage({
			to_id: "dev",
			body: `@dev pregunta ${i}`,
			state: "done",
			result_text: answer(i) ?? `Respuesta ${i}.\n\nUna línea más para que ocupe lugar.\n\nY otra.`,
			project_id: HZ,
			conversation_id: conv,
			created_at: at(i),
			finished_at: at(i),
		});
	backend.acpConversations.find((c) => c.id === conv)!.readAt = at(1799);
}

function inTopic(backend: MockBackend, m: Parameters<MockBackend["addAcpMessage"]>[0]) {
	const row = backend.addAcpMessage({
		project_id: HZ,
		conversation_id: CONV_IDS.backend,
		created_at: at(1790),
		...m,
	});
	backend.pushAcp({ type: "message", message: row });
	return row;
}

const question = (messageId: number, options: string[]) => ({
	id: 1,
	agent: "dev",
	message_id: messageId,
	request: JSON.stringify({
		message: "¿Qué proveedor usamos?",
		requestedSchema: {
			type: "object",
			properties: { p: { type: "string", title: "Proveedor", enum: options } },
			required: ["p"],
		},
	}),
	state: "open",
	answer: null,
	created_at: "2026-10-31T10:29:30Z",
	answered_at: null,
	delivered_at: null,
	note: null,
});

async function open(
	app: App,
	page: Page,
	conv = CONV_IDS.backend,
	last = "Respuesta",
): Promise<Locator> {
	await app.login("alice", topic(conv));
	const t = page.locator(THREAD);
	await expect(t).toContainText(last);
	return t;
}

test.beforeEach(({ backend }) => backend.enableConversations());

// ── 1 · Markdown and a live event ────────────────────────────────────────

test("1 · an answer reads as Markdown, and a live event keeps the reader's selection", async ({
	app,
	backend,
	page,
}) => {
	fill(
		backend,
		1,
		() => "## Resumen\n\nEl proyecto expone **dos** servicios:\n\n```ts\nconst x = 1;\n```",
	);
	await open(app, page, CONV_IDS.backend, "servicios");
	const result = page.locator(`${THREAD} .acp-msg-result`);
	await expect(result.locator("h2")).toHaveText("Resumen");
	await expect(result.locator("strong")).toHaveText("dos");
	await expect(result.locator(".chat-pre .chat-copy")).toHaveCount(1);
	await page.evaluate((sel) => {
		const r = document.createRange();
		r.selectNodeContents(document.querySelector(`${sel} .acp-msg-result h2`)!);
		getSelection()!.removeAllRanges();
		getSelection()!.addRange(r);
	}, THREAD);
	backend.pushAcp({
		type: "activity",
		agent: "dev",
		events: [{ seq: 1, at: "2026-10-31T10:29:59Z", messageId: null, kind: "turn" }],
	});
	inTopic(backend, { to_id: "dev", body: "@dev otra cosa" });
	await expect(page.locator(THREAD)).toContainText("otra cosa");
	expect(await page.evaluate(() => String(getSelection()))).toBe("Resumen");
	expect(app.errors).toEqual([]);
});

// ── 2 · Links in an answer ───────────────────────────────────────────────

test.describe("2 · a link in an answer", () => {
	// Another topic: the same thread object reads another source, and Back
	// must read this one again and put the reader back on its row.
	const LINK = topic(CONV_IDS.ci);
	const withLink = (i: number) =>
		i === 15
			? `Respuesta 15: mirá [el destino](${LINK}) o [afuera](https://example.com).`
			: undefined;

	test("an internal link navigates in the same tab; Back leaves the thread at the row being read", async ({
		app,
		backend,
		page,
	}) => {
		fill(backend, 30, withLink);
		const t = await open(app, page, CONV_IDS.backend, "Respuesta 30.");
		const answer = t.locator(".acp-msg-result", { hasText: "Respuesta 15:" });
		const internal = answer.getByRole("link", { name: "el destino" });
		await expect(internal).toHaveAttribute("href", LINK);
		await expect(internal).not.toHaveAttribute("target", /.+/);
		const external = answer.getByRole("link", { name: "afuera" });
		await expect(external).toHaveAttribute("target", "_blank");
		await expect(external).toHaveAttribute("rel", "noopener noreferrer nofollow");
		await readAt(page, t, "Respuesta 15:", 40);
		const before = await rowTop(t, "Respuesta 15:");
		const pages = page.context().pages().length;
		await internal.click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Optimización de CI");
		await expect(t).toContainText("el job de e2e tarda");
		expect(page.url()).toContain(LINK);
		expect(page.context().pages()).toHaveLength(pages);
		await page.goBack();
		await expect(page.locator("#ps-topic-title")).toHaveText("Mejoras del backend");
		await expect(internal).toBeInViewport();
		await stays(t, "Respuesta 15:", before, "Back after a followed link");
		expect(app.errors).toEqual([]);
	});

	test("followed in the same instant as a scroll, Back still puts the thread at that row", async ({
		app,
		backend,
		page,
	}) => {
		fill(backend, 30, withLink);
		const t = await open(app, page, CONV_IDS.backend, "Respuesta 30.");
		// Scrolled to the link's row and the link followed in ONE task: no
		// scroll event, no frame in between (a slow machine, a fast hand).
		const before = await t.evaluate((el) => {
			const row = [...el.children].find((c) =>
				c.textContent?.includes("Respuesta 15:"),
			) as HTMLElement;
			el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 30;
			const top = Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top);
			row.querySelector<HTMLAnchorElement>('a[href^="#"]')!.click();
			return top;
		});
		await expect(page.locator("#ps-topic-title")).toHaveText("Optimización de CI");
		await page.goBack();
		await expect(page.locator("#ps-topic-title")).toHaveText("Mejoras del backend");
		await stays(t, "Respuesta 15:", before, "Back after a link followed at once");
		expect(app.errors).toEqual([]);
	});
});

// ── 3 · A failed re-read ─────────────────────────────────────────────────

test("3 · a re-read that fails keeps the history and says so in words, not the server's code", async ({
	app,
	backend,
	page,
}) => {
	fill(backend, 3);
	const t = await open(app, page, CONV_IDS.backend, "Respuesta 3.");
	backend.override = async (method, path, route) => {
		if (method !== "GET" || !path.startsWith(`/acp/conversations/${CONV_IDS.backend}/feed`))
			return false;
		await route.fulfill({
			status: 500,
			contentType: "application/json",
			body: '{"error":"internal"}',
		});
		return true;
	};
	// The live socket drops; its reconnect re-reads the feed, which now fails.
	backend.dropAcpSockets();
	await expect(page.locator(`${ROOT} .acp-chat-error`)).toHaveText(
		"No se pudo actualizar el chat.",
	);
	await expect(t).toContainText("Respuesta 3.");
	await expect(t).toContainText("Respuesta 1.");
	await expect(page.locator(ROOT)).not.toContainText("internal");
});

// ── 4 · The composer on a phone ──────────────────────────────────────────

test("4 · phone: one row at rest, grows with the text up to its cap, back to one row after sending", async ({
	app,
	backend,
	page,
}) => {
	test.skip(!app.mobile, "phone layout");
	fill(backend, 14);
	backend.acpConversations.find((c) => c.id === CONV_IDS.backend)!.recipients = { agents: ["dev"] };
	await open(app, page, CONV_IDS.backend, "Respuesta 14.");
	const input = field(page);
	const height = async (l: Locator) => Math.round((await l.boundingBox())!.height);
	// One row at rest (44 px and the arrow's whole-height target are acp-composer.spec.ts's).
	expect(await height(input)).toBeLessThanOrEqual(44);
	await expect(page.locator(`${ROOT} .acp-chat-hint`)).toBeHidden();

	await input.fill("uno\ndos\ntres");
	expect(await height(input)).toBeGreaterThan(70);
	await input.fill(Array.from({ length: 20 }, (_, i) => `línea ${i}`).join("\n"));
	const capped = await height(input);
	// A phone: up to 30 % of the visible height, never past 8 lines of 22 px plus padding.
	expect(capped).toBeLessThanOrEqual(Math.round(page.viewportSize()!.height * 0.3) + 1);
	expect(capped).toBeLessThanOrEqual(8 * 22 + 20);
	expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

	// A tap on the arrow keeps the focus in the field (no blur closing the keyboard).
	await send(page).tap();
	await expect(input).toHaveValue("");
	await expect(input).toBeFocused();
	await expect.poll(() => height(input)).toBeLessThanOrEqual(46);
	expect(app.errors).toEqual([]);
});

// ── 5 · First taps with the keyboard up ──────────────────────────────────

test.describe("5 · phone, the field focused: the first tap does what it says", () => {
	test.skip(({ isMobile }) => !isMobile, "phone");

	test("«Recuperar el texto no enviado»", async ({ app, backend, page }) => {
		fill(backend, 14);
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
		await open(app, page, CONV_IDS.backend, "Respuesta 14.");
		const input = field(page);
		await input.fill("@dev el primero");
		await send(page).tap();
		// Typed while the send was out: the failed text is offered, not written over this.
		await input.fill("otro borrador");
		const recover = page.locator(`${ROOT} .acp-recover`);
		await expect(recover).toBeVisible();
		fail = false;
		await input.focus();
		await recover.tap();
		await expect(input).toHaveValue("otro borrador\n\n@dev el primero");
	});

	test("an option of a question at the end of a long thread", async ({ app, backend, page }) => {
		fill(backend, 14);
		const asking = backend.addAcpMessage({
			to_id: "dev",
			body: "@dev elegí el proveedor",
			state: "running",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
			created_at: at(100),
		});
		backend.acpQuestions = [question(asking.id, ["GitHub", "Google"])];
		await open(app, page, CONV_IDS.backend, "elegí el proveedor");
		const option = page.locator(`${ROOT} .acp-question-open .acp-option`, { hasText: "Google" });
		await expect(option).toBeVisible();
		await field(page).focus();
		await option.tap();
		await expect(option.locator("input")).toBeChecked();
	});
});

// ── 6 · Scroll ───────────────────────────────────────────────────────────

test.describe("6 · scroll", () => {
	// A topic keeps its reading place across visits in the same page
	// (project-rail.spec.ts «leaving a topic and coming back keeps the reading
	// place»), so the end is what an opening WITHOUT a place shows: a reload,
	// a topic not read yet in this page, a reader who left it at its end.
	test("an opening shows the end: a reload, the rail, a link; a reader at the end comes back to it", async ({
		app,
		backend,
		page,
	}) => {
		fill(backend, 30, (i) =>
			i === 30 ? `Respuesta 30: seguí en [CI](${topic(CONV_IDS.ci)}).` : undefined,
		);
		fill(
			backend,
			30,
			(i) => `CI ${i} resuelto.\n\nCon una segunda línea.\n\nY otra.`,
			CONV_IDS.ci,
			100,
		);
		const t = await open(app, page, CONV_IDS.backend, "Respuesta 30");
		await expect.poll(() => gap(t), "direct URL").toBeLessThan(4);

		// Read further up, then a reload: the end.
		await readAt(page, t, "pregunta 12");
		await page.reload();
		await expect(t).toContainText("Respuesta 30");
		await expect.poll(() => gap(t), "a reload").toBeLessThan(4);

		// A link to a topic not opened yet in this page: its end.
		await t.getByRole("link", { name: "CI" }).click();
		await expect(t).toContainText("CI 129 resuelto.");
		await expect.poll(() => gap(t), "a link").toBeLessThan(4);

		// Left at its end, back from the rail: the end again.
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Mejoras del backend").click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Mejoras del backend");
		await expect.poll(() => gap(t), "the rail, a reader left at the end").toBeLessThan(4);
		// Another topic opened from the rail for the first time: its end.
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Rediseño de UI/UX").click();
		await expect(t).toContainText("¿qué falta del prototipo?");
		await expect.poll(() => gap(t), "the rail, a topic not read yet").toBeLessThan(4);
		expect(app.errors).toEqual([]);
	});

	test("a reader further up is not moved: a message, live activity, a state change, a taller field, a shorter screen, an earlier page", async ({
		app,
		backend,
		page,
	}) => {
		// Enough for an earlier page (the feed's page is 100 messages).
		fill(backend, 110, (i) => `Respuesta ${i}.\n\nUna línea más para que ocupe lugar.`);
		const above = backend.acpMessages.find((m) => m.body === "@dev pregunta 95")!;
		const running = backend.addAcpMessage({
			to_id: "dev",
			body: "@dev pregunta en curso",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
			created_at: at(200),
		});
		const t = await open(app, page, CONV_IDS.backend, "pregunta en curso");
		await expect.poll(() => gap(t)).toBeLessThan(4);

		await readAt(page, t, "pregunta 100");
		const top = await rowTop(t, "pregunta 100");

		inTopic(backend, { from_id: "arq", to_id: "dev", body: "Llegó mientras leías" });
		await expect(t).toContainText("Llegó mientras leías");
		await stays(t, "pregunta 100", top, "a new message below");

		backend.updateAcpMessage(running.id, { state: "running", started_at: at(1795) });
		backend.pushAcp({
			type: "activity",
			agent: "dev",
			events: [
				{
					seq: 1,
					at: "2026-10-31T10:29:59Z",
					messageId: running.id,
					kind: "tool",
					toolCallId: "t1",
					title: "Read",
					detail:
						"una ruta larga que crece/con/muchos/segmentos/para/que/ocupe/más/de/una/línea.ts",
					status: "in_progress",
				},
			],
		});
		await expect(t).toContainText("que crece");
		await stays(t, "pregunta 100", top, "live activity below (a topic shows no partial text)");

		// A row ABOVE the one being read changes height: the row read does not move.
		backend.updateAcpMessage(above.id, {
			state: "failed",
			note: "Falló.\n\nCon una nota\n\nde varias líneas.",
		});
		await expect(t).toContainText("de varias líneas.");
		await stays(t, "pregunta 100", top, "a state change above");

		await field(page).fill(Array.from({ length: 6 }, (_, i) => `línea ${i}`).join("\n"));
		await stays(t, "pregunta 100", top, "the field grew");
		await field(page).fill("");

		const vp = page.viewportSize()!;
		await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.7) });
		await stays(t, "pregunta 100", top, "a shorter screen");
		await page.setViewportSize(vp);

		// At the top, the earlier page: the first row read stays where it is.
		await scrollTo(t, 0);
		await frame(page);
		const first = await rowTop(t, "pregunta 12");
		// By keyboard: a click may land under a transient toast, and Playwright
		// then scrolls the thread to retry — moving the reader before the page lands.
		await t.getByRole("button", { name: "Cargar anteriores" }).focus();
		await page.keyboard.press("Enter");
		await expect(t).toContainText("Respuesta 10.");
		await stays(t, "pregunta 12", first, "an earlier page");
		expect(app.errors).toEqual([]);
	});

	test("a scroll right after the topic opens is the reader's: it stays, and the button shows", async ({
		app,
		backend,
		page,
	}) => {
		fill(backend, 30);
		// Scrolls to the top in the same task the rows land in — before the
		// thread's ResizeObserver has had a frame to look at its box.
		await page.addInitScript((sel) => {
			new MutationObserver((_, obs) => {
				const t = document.querySelector<HTMLElement>(sel);
				if (!t?.textContent?.includes("Respuesta 30.")) return;
				obs.disconnect();
				queueMicrotask(() => {
					t.scrollTop = 0;
				});
			}).observe(document, { subtree: true, childList: true });
		}, THREAD);
		const t = await open(app, page, CONV_IDS.backend, "Respuesta 30.");
		await page.waitForTimeout(300);
		expect(await t.evaluate((e) => e.scrollTop)).toBeLessThan(50);
		await expect(endBtn(page)).toBeVisible();
	});

	test("the end button counts news, not live activity; a tap goes to the end and keeps the field", async ({
		app,
		backend,
		page,
	}) => {
		fill(backend, 30);
		const asked = backend.addAcpMessage({
			to_id: "dev",
			body: "@dev ¿Cómo seguimos?",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
			created_at: at(200),
		});
		const t = await open(app, page, CONV_IDS.backend, "¿Cómo seguimos?");
		const btn = endBtn(page);
		await expect.poll(() => gap(t)).toBeLessThan(4);
		await expect(btn).toBeHidden();
		// Far up: the arrow alone (its geometry and thresholds are the shared
		// chatScroll.ts button's; acp-topic/project-rail check its «N nuevos»).
		await scrollTo(t, 0);
		await expect(btn).toBeVisible();
		await expect(btn.locator(".chat-end-count")).toBeHidden();

		// Live activity and streamed text are not news.
		backend.updateAcpMessage(asked.id, { state: "running", started_at: at(1795) });
		backend.pushAcp({
			type: "activity",
			agent: "dev",
			events: [
				{
					seq: 1,
					at: "2026-10-31T10:29:59Z",
					messageId: asked.id,
					kind: "tool",
					toolCallId: "t1",
					title: "Read",
					detail: "pensando.ts",
					status: "in_progress",
				},
			],
		});
		await expect(t).toContainText("pensando.ts");
		await page.waitForTimeout(200);
		await expect(btn.locator(".chat-end-count")).toBeHidden();
		// Its answer is: one; a new message, two.
		backend.updateAcpMessage(asked.id, {
			state: "done",
			result_text: "Seguimos así.",
			finished_at: at(1796),
		});
		await expect(btn.locator(".chat-end-count")).toHaveText("1 nuevos");
		inTopic(backend, { from_id: "arq", to_id: "dev", body: "Otro" });
		await expect(btn.locator(".chat-end-count")).toHaveText("2 nuevos");
		expect(await t.evaluate((el) => el.scrollTop)).toBe(0);
		await field(page).focus();
		await btn.click();
		await expect(btn).toBeHidden();
		await expect.poll(() => gap(t)).toBeLessThan(4);
		await expect(field(page)).toBeFocused();
		await page.waitForTimeout(300);
		await expect(btn).toBeHidden();
	});

	test("phone, short screen, field focused: news never puts the button over a question's options", async ({
		app,
		backend,
		page,
	}) => {
		test.skip(!app.mobile, "phone");
		fill(backend, 8, (i) => `Respuesta ${i}.`);
		const asking = backend.addAcpMessage({
			to_id: "dev",
			body: "@dev elegí",
			state: "running",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
			created_at: at(100),
		});
		backend.acpQuestions = [question(asking.id, ["GitHub", "Google", "GitLab"])];
		await page.setViewportSize({ width: 390, height: 450 });
		const t = await open(app, page, CONV_IDS.backend, "elegí");
		const card = page.locator(`${ROOT} .acp-question-open`);
		await expect(card).toBeVisible();
		await field(page).focus();
		await scrollTo(t, -90);
		await frame(page);
		inTopic(backend, { from_id: "arq", to_id: "dev", body: "Llegó" });
		const btn = endBtn(page);
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

// ── 7 · «Para:»'s menu ───────────────────────────────────────────────────

test.describe("7 · «Para:»'s menu", () => {
	const menu = (page: Page) => page.getByRole("menu", { name: "Destinatarios" });
	const chipNames = (page: Page) => page.locator(`${ROOT} .acp-to-chips .acp-chip-name`);

	test("from the keyboard: arrows, Space, Escape back to the field", async ({ app, page }) => {
		await app.login("alice", topic(CONV_IDS.backend));
		const input = field(page);
		await input.fill("hola");
		const plus = page.locator(`${ROOT} .acp-pick-btn`);
		await plus.focus();
		await page.keyboard.press("Enter");
		const rows = page.getByRole("menuitemcheckbox");
		await expect(rows.first()).toBeFocused();
		// «Todo el equipo» first, then each agent.
		await page.keyboard.press("ArrowDown");
		await expect(rows.nth(1)).toBeFocused();
		await page.keyboard.press("Space");
		await expect(rows.nth(1)).toHaveAttribute("aria-checked", "true");
		await expect(rows.nth(1)).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Space");
		await expect(rows.nth(2)).toHaveAttribute("aria-checked", "true");
		await page.keyboard.press("ArrowUp");
		await expect(rows.nth(1)).toBeFocused();
		await expect(chipNames(page)).toHaveText(["@arq", "@dev"]);
		// The chips are the recipients: the text stays as it was typed.
		await expect(input).toHaveValue("hola");
		await page.keyboard.press("Escape");
		await expect(menu(page)).toBeHidden();
		await expect(input).toBeFocused();
		await expect(plus).toHaveAttribute("aria-expanded", "false");
	});

	test("phone: a tap on + and on a row leaves the focus (and keyboard) in the field", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "touch");
		await app.login("alice", topic(CONV_IDS.backend));
		const input = field(page);
		await input.tap();
		await input.fill("hola");
		await expect(input).toBeFocused();
		// A touch tap whose click arrives with detail 0, like a keyboard
		// activation's (measured on Chromium touch; this harness's taps say 1):
		// a pointer went down first, so it is not the keyboard.
		const plus = page.locator(`${ROOT} .acp-pick-btn`);
		await plus.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
		await plus.dispatchEvent("click", { detail: 0 });
		await expect(menu(page)).toBeVisible();
		await expect(input).toBeFocused();
		await page.getByRole("menuitemcheckbox", { name: /@arq/ }).tap();
		await expect(input).toBeFocused();
		await expect(chipNames(page)).toHaveText(["@arq"]);
		await expect(input).toHaveValue("hola");
		// A tap outside closes it.
		await page.locator(THREAD).tap();
		await expect(menu(page)).toBeHidden();
	});
});

// ── The visible band with the keyboard up (new, @qa) ─────────────────────

test.describe("a phone's visible band with the keyboard up", () => {
	test.skip(({ isMobile }) => !isMobile, "phone");

	// The keyboard as keyboard.spec.ts makes it: `visualViewport` replaced by
	// one whose height the test sets (Chromium cannot raise a real keyboard).
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			const target = new EventTarget() as EventTarget & Record<string, number>;
			Object.assign(target, {
				width: window.innerWidth,
				height: window.innerHeight,
				offsetTop: 0,
				offsetLeft: 0,
				pageTop: 0,
				pageLeft: 0,
				scale: 1,
			});
			Object.defineProperty(window, "visualViewport", { configurable: true, value: target });
			(window as unknown as { __kb: (h: number) => void }).__kb = (h) => {
				target.height = h;
				target.dispatchEvent(new Event("resize"));
				target.dispatchEvent(new Event("scroll"));
			};
		});
	});
	const keyboard = (page: Page, h: number) =>
		page.evaluate((h) => (window as unknown as { __kb: (h: number) => void }).__kb(h), h);

	test("360 × 390 with the box's notes and a long draft: the thread keeps room, and the row being read", async ({
		app,
		backend,
		page,
	}, info) => {
		fill(backend, 30);
		// @dev is busy in another topic: the box carries its note.
		backend.acpConversations.find((c) => c.id === CONV_IDS.backend)!.recipients = {
			agents: ["dev"],
		};
		await page.setViewportSize({ width: 390, height: 844 });
		const t = await open(app, page, CONV_IDS.backend, "Respuesta 30.");
		await expect(page.locator(`${ROOT} .acp-to-notes`)).toContainText("Le queda en cola a @dev");
		await readAt(page, t, "pregunta 20");
		const top = await rowTop(t, "pregunta 20");

		const input = field(page);
		await input.focus();
		await keyboard(page, 360);
		await expect(page.locator("html")).toHaveAttribute("data-kb", "open");
		await stays(t, "pregunta 20", top, "the keyboard opened");
		await input.fill(
			Array.from({ length: 12 }, (_, i) => `línea ${i} del borrador largo`).join("\n"),
		);
		await frame(page);
		const room = await t.evaluate((el) => el.clientHeight);
		const composer = (await page.locator(`${ROOT} .acp-chat-composer`).boundingBox())!;
		info.annotations.push({
			type: "thread-room",
			description: `${room} px of thread (composer ${Math.round(composer.height)} px) in a 360-px band`,
		});
		console.log(`[band 360×390] thread ${room} px, composer ${Math.round(composer.height)} px`);
		expect(composer.y + composer.height, "the box is inside the band").toBeLessThanOrEqual(361);
		// Useful room: at least ~3 lines of reading (a row's two lines and a bit).
		expect(room, "the thread keeps useful room").toBeGreaterThanOrEqual(80);
		await stays(t, "pregunta 20", top, "a long draft with the keyboard up");

		await keyboard(page, 844);
		await expect(page.locator("html")).not.toHaveAttribute("data-kb", "open");
		await input.fill("");
		await stays(t, "pregunta 20", top, "the keyboard closed");
		expect(app.errors).toEqual([]);
	});
});
