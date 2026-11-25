// A topic's recipients and their states, Pendientes and the review of an
// interruption (3B F2 + F3; HANDOFF-3B §4 criteria 1–5): the chips of
// «Para:» (`@` and "+", «Todo el equipo»), the queue said before and after
// sending, one row per recipient that advances on its own, a late answer to
// a consult nested with only a reference at the end, the global inbox, and
// an interruption that is never requeued by one tap. Plus a long thread
// that keeps the reader's place.

import type { Page } from "@playwright/test";
import { type App, expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const topic = (id: string) => `#/projects/${HZ}/c/${id}`;
const THREAD = "#project-view .ps-topic .acp-chat-thread";
const T0 = Date.parse("2026-10-31T10:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const SHOTS = process.env.ACP_SHOTS;

const field = (page: Page) => page.locator("#project-view .acp-chat-input");
const chips = (page: Page) => page.locator("#project-view .acp-to-chips");
const notes = (page: Page) => page.locator("#project-view .acp-to-notes");
const convRow = (page: Page, title: string) =>
	page
		.locator(".rail-body .rail-conv")
		.filter({ has: page.locator(".rail-row-title", { hasText: title }) });

/** A third agent in the project: @qa (the designer's session). */
function addQa(backend: MockBackend): void {
	const dev = backend.acpAgents.find((a) => a.name === "dev")!;
	backend.acpAgents.push({
		...dev,
		name: "qa",
		sessionId: PROJECT_SESSION_IDS.designer,
		running: [],
		pending: 0,
		runningIn: [],
		queue: [],
	});
}

async function shot(page: Page, name: string, project: string): Promise<void> {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${project}-${name}.png` });
}

function posts(page: Page) {
	return page.waitForRequest((r) => r.url().endsWith("/api/acp/messages") && r.method() === "POST");
}

test.describe("a topic's recipients and their states", () => {
	test.beforeEach(({ backend }) => backend.enableConversations());

	test("1 · busy elsewhere: the queue and its reason before and after sending", async ({
		app,
		page,
	}, info) => {
		await app.login("alice", topic(CONV_IDS.ui));
		await expect(page.locator(THREAD)).toContainText("¿qué falta del prototipo?");
		// The topic's earlier message to @dev already says why it waits.
		const earlier = page.locator(`${THREAD} .acp-post`, { hasText: "revisá los tokens" });
		await expect(earlier.locator('.acp-rs[data-agent="dev"]')).toContainText(
			"en cola — ocupado en «Optimización de CI»",
		);
		// `@de` + Enter: a chip, and the typed mention leaves the text.
		await expect(chips(page)).toHaveText("Elegí a quién con + o @");
		await field(page).click();
		await field(page).pressSequentially("@de");
		await expect(page.locator("#project-view .acp-mention-menu")).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(chips(page).locator(".acp-chip")).toHaveCount(1);
		await expect(chips(page)).toContainText("@dev");
		await expect(field(page)).toHaveValue("");
		// Before sending: who will queue it, and why (the agents' real state).
		await expect(notes(page)).toHaveText(
			"Le queda en cola a @dev (ocupado en «Optimización de CI»).",
		);
		await shot(page, "1-before", info.project.name);
		await field(page).fill("revisá el contraste de los chips");
		const req = posts(page);
		await page.locator("#project-view .acp-chat-send").click();
		expect((await req).postDataJSON()).toMatchObject({
			conversationId: CONV_IDS.ui,
			to: ["dev"],
			body: "revisá el contraste de los chips",
		});
		// After: the message's own row says the same.
		const mine = page.locator(`${THREAD} .acp-post`, { hasText: "revisá el contraste" });
		await expect(mine.locator(".acp-msg-who")).toHaveText("Vos → @dev");
		await expect(mine.locator('.acp-rs[data-agent="dev"]')).toContainText(
			"en cola — ocupado en «Optimización de CI»",
		);
		// The chip stays: it is the topic's recipient now.
		await expect(chips(page)).toContainText("@dev");
		await shot(page, "1-after", info.project.name);
		expect(app.errors).toEqual([]);
	});

	test("2 · three recipients, three rows that advance on their own; «Todo el equipo»", async ({
		app,
		backend,
		page,
	}, info) => {
		addQa(backend);
		await app.login("alice", topic(CONV_IDS.backend));
		await expect(page.locator(THREAD)).toContainText("Sin mensajes en esta conversación");
		await page.locator("#project-view .acp-pick-btn").click();
		await page.getByRole("menuitemcheckbox", { name: /Todo el equipo · 3/ }).click();
		await page.keyboard.press("Escape");
		await expect(chips(page)).toContainText("Todo el equipo · 3");
		await expect(notes(page)).toContainText("Llega a @arq, @dev, @qa, a cada uno por separado.");
		await field(page).fill("¿Qué bloquea la entrega?");
		const req = posts(page);
		await page.locator("#project-view .acp-chat-send").click();
		const body = (await req).postDataJSON() as Record<string, unknown>;
		expect(body).toMatchObject({ conversationId: CONV_IDS.backend, team: true });
		expect(body.to).toBeUndefined();
		const post = page.locator(`${THREAD} .acp-post`, { hasText: "¿Qué bloquea la entrega?" });
		const team = post.locator(".acp-team-to");
		await expect(team).toHaveText("→ Todo el equipo (3)");
		await expect(team).toHaveAttribute("title", "@arq, @dev, @qa");
		await expect(post.locator(".acp-rs")).toHaveCount(3);
		const rows = backend.acpMessages.filter((m) => m.body === "¿Qué bloquea la entrega?");
		const row = (name: string) => rows.find((m) => m.to_id === name)!;
		// @qa answers, @arq starts: each row on its own, @dev's untouched.
		backend.updateAcpMessage(row("arq").id, { state: "running", started_at: at(1790) });
		backend.updateAcpMessage(row("qa").id, {
			state: "done",
			result_text: "De mi lado nada: los criterios están listos.",
			finished_at: at(1795),
		});
		const rs = (name: string) => post.locator(`.acp-rs[data-agent="${name}"]`);
		await expect(rs("qa")).toContainText("respondió · ver");
		await expect(rs("arq")).toContainText("trabajando");
		await expect(rs("dev")).toContainText("en cola — ocupado en «Optimización de CI»");
		await shot(page, "2-rows", info.project.name);
		// «ver» leads to the answer's own item.
		await rs("qa").getByRole("button", { name: "Ver la respuesta de @qa" }).click();
		const answer = page.locator(`${THREAD} > [data-result="${row("qa").id}"]`);
		await expect(answer).toBeInViewport();
		await expect(answer).toContainText("los criterios están listos");
		// Everyone answered: the compact line, each mark to its answer.
		for (const n of ["arq", "dev"])
			backend.updateAcpMessage(row(n).id, {
				state: "done",
				result_text: `Respuesta de @${n}.`,
				finished_at: at(1796),
			});
		await expect(post.locator(".acp-rs-all")).toHaveText("✓ @arq✓ @dev✓ @qa");
		await expect(post.locator(".acp-rs")).toHaveCount(0);
		expect(app.errors).toEqual([]);
	});

	test("3 · a new topic starts empty; a topic keeps its chips across a switch", async ({
		app,
		backend,
		page,
	}) => {
		// What the server keeps for a topic is what its composer shows, on any device.
		backend.acpConversations.find((c) => c.id === CONV_IDS.backend)!.recipients = {
			agents: ["dev"],
		};
		await app.login("alice", topic(CONV_IDS.ci));
		await expect(page.locator(THREAD)).toContainText("el job de e2e tarda");
		await expect(chips(page)).toHaveText("Elegí a quién con + o @");
		await page.locator("#project-view .acp-pick-btn").click();
		await page.getByRole("menuitemcheckbox", { name: /@arq/ }).click();
		await page.keyboard.press("Escape");
		await expect(chips(page)).toContainText("@arq");
		// Another topic: its own (none); then the server's for «Mejoras del backend».
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Rediseño de UI/UX").click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Rediseño de UI/UX");
		await expect(chips(page)).toHaveText("Elegí a quién con + o @");
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Mejoras del backend").click();
		await expect(chips(page).locator(".acp-chip-name")).toHaveText(["@dev"]);
		// Back: @arq is still there.
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Optimización de CI").click();
		await expect(chips(page).locator(".acp-chip-name")).toHaveText(["@arq"]);
		// Removing it leaves nothing; nothing leaves without a recipient.
		await chips(page).getByRole("button", { name: "Quitar a @arq" }).click();
		await expect(chips(page)).toHaveText("Elegí a quién con + o @");
		await field(page).fill("¿sigue?");
		await page.locator("#project-view .acp-chat-send").click();
		await expect(page.locator("#project-view .acp-chat-error")).toHaveText(
			"Elegí a quién con + o @",
		);
		await expect(field(page)).toHaveValue("¿sigue?");
		// A new topic: empty.
		if (app.mobile) await page.locator(".ps-back").click();
		await page.locator(".rail-body").getByRole("button", { name: "Nueva conversación" }).click();
		await page.locator(".modal.open input").fill("Accesibilidad");
		await page.locator(".modal.open").getByRole("button", { name: "Crear" }).click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Accesibilidad");
		await expect(chips(page)).toHaveText("Elegí a quién con + o @");
		expect(app.errors).toEqual([]);
	});

	test("4 · a late answer to a consult stays nested; the end only refers to it", async ({
		app,
		backend,
		page,
	}, info) => {
		const answer = "Sí: el token de la caché cambia con el lockfile.";
		const consult = backend.addAcpMessage({
			from_id: "arq",
			to_id: "dev",
			body: "¿La clave de la caché depende del lockfile?",
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
			depth: 1,
			state: "done",
			result_text: answer,
			created_at: at(1000),
			finished_at: at(1500),
		});
		backend.addAcpMessage({
			to_id: "arq",
			body: "@arq ¿y los tokens de color?",
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
			created_at: at(1200),
		});
		backend.addAcpMessage({
			from_id: "dev",
			to_id: "arq",
			kind: "reply",
			reply_to: consult.id,
			body: answer,
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
			depth: 1,
			created_at: at(1500),
		});
		await app.login("alice", topic(CONV_IDS.ui));
		const card = page.locator(`${THREAD} .acp-topic-consult`);
		await expect(card.locator(".acp-msg-to").first()).toHaveText("consulta a @dev");
		const nested = card.locator(`[data-answer="${consult.id}"]`);
		await expect(nested).toContainText(answer);
		// The reference: who answered whom, when the consult was made — not the text.
		const late = page.locator(`${THREAD} .acp-late`);
		await expect(late).toContainText(
			/^↳ @dev respondió la consulta de @arq \(.+\) · Ir a la respuesta$/,
		);
		await expect(late).not.toContainText("lockfile");
		await expect(page.locator(THREAD).getByText(answer)).toHaveCount(1);
		await page.locator(THREAD).evaluate((t) => {
			t.scrollTop = t.scrollHeight;
		});
		await late.getByRole("button", { name: "Ir a la respuesta" }).click();
		await expect(nested).toBeInViewport();
		await expect(nested).toHaveClass(/acp-msg-flash/);
		await shot(page, "4-late", info.project.name);
		expect(app.errors).toEqual([]);
	});
});

test.describe("Pendientes and the review of an interruption", () => {
	test.beforeEach(({ backend }) => {
		backend.enableConversations();
		// Two interrupted runs (the badge counts 2) and one unseen answer.
		const cut = backend.addAcpMessage({
			to_id: "arq",
			body: "@arq medí también la variante sin shards.",
			project_id: HZ,
			conversation_id: CONV_IDS.ci,
			state: "uncertain",
			note: "se reinició el runner de @arq",
			created_at: at(1100),
			finished_at: at(1150),
		});
		backend.addAcpMessage({
			from_id: "system",
			to_id: "arq",
			body: "Tu ejecución anterior se interrumpió: informá de solo lectura qué quedó hecho.",
			project_id: HZ,
			conversation_id: CONV_IDS.ci,
			recovery_of: cut.id,
			state: "done",
			result_text: "Llegué a lanzar 1 corrida; no hice commits ni cambié archivos.",
			created_at: at(1160),
			finished_at: at(1170),
		});
		backend.addAcpMessage({
			to_id: "dev",
			body: "@dev subí el informe de tiempos",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
			state: "uncertain",
			note: "el contenedor se detuvo",
			created_at: at(1200),
			finished_at: at(1210),
		});
	});

	test("5 · requeue locked until acknowledged; «Dar por revisada» lowers the count, sends nothing", async ({
		app,
		backend,
		page,
	}, info) => {
		await app.login("alice", topic(CONV_IDS.ci));
		const inbox = page.locator("#inbox-btn");
		await expect(inbox).toHaveAttribute("aria-label", "Pendientes: 2 te esperan");
		await expect(inbox.locator(".inbox-count")).toHaveText("2");
		await inbox.click();
		const panel = page.locator(".acp-inbox-card");
		await expect(panel.locator(".acp-inbox-sec")).toHaveText([
			"Requieren tu acción",
			"Resultados sin ver",
		]);
		const item = panel.locator(".acp-ib-item.is-interrupted", { hasText: "variante sin shards" });
		await expect(item).toContainText("Se interrumpió tu mensaje a @arq");
		await expect(item.locator(".acp-ib-where")).toHaveText("Educación HZ › Optimización de CI");
		await shot(page, "5-inbox", info.project.name);
		await item.getByRole("button", { name: "Revisar interrupción" }).click();
		const review = page.locator(".acp-review-card");
		await expect(review).toContainText("se reinició el runner de @arq");
		await expect(review).toContainText("Nada se reenvía solo.");
		await expect(review.locator(".acp-review-report")).toContainText("no hice commits");
		// Requeue: folded, and locked until the acknowledgement.
		await review.getByText("Reencolar el mensaje original…").click();
		const requeue = review.getByRole("button", { name: "Reencolar", exact: true });
		await expect(requeue).toBeDisabled();
		await review.getByLabel("Revisé el estado y acepto que puede repetir operaciones.").check();
		await expect(requeue).toBeEnabled();
		await shot(page, "5-review", info.project.name);
		const sent: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && r.url().endsWith("/api/acp/messages")) sent.push(r.url());
		});
		await review.getByRole("button", { name: "Dar por revisada, sin reencolar" }).click();
		await expect(review).toBeHidden();
		await expect(inbox).toHaveAttribute("aria-label", "Pendientes: 1 te espera");
		await expect(panel.locator(".acp-ib-item.is-interrupted")).toHaveCount(1);
		expect(backend.reviewCalls.map((c) => c.verb)).toEqual(["review"]);
		expect(sent).toEqual([]);
		expect(backend.acpMessages.find((m) => m.body.includes("sin shards"))!.state).toBe("uncertain");
		// In its topic the message reads as reviewed.
		await page.keyboard.press("Escape");
		await expect(panel).toBeHidden();
		const row = page.locator(`${THREAD} .acp-post`, { hasText: "sin shards" });
		await expect(row.locator(".acp-rs")).toContainText("interrumpida · revisada, no reencolada");
		expect(app.errors).toEqual([]);
	});

	test("«Ver en el tema» opens the topic at the message; a review opens from the thread too", async ({
		app,
		page,
	}) => {
		await app.login("alice", topic(CONV_IDS.ci));
		await page.locator("#inbox-btn").click();
		const panel = page.locator(".acp-inbox-card");
		// The unseen answer of «Rediseño de UI/UX», apart and not counted.
		const result = panel.locator(".acp-ib-item.is-result");
		await expect(result).toContainText("@arq: Faltan los estados del equipo");
		await result.getByRole("button", { name: "Ver en el tema" }).click();
		await expect(panel).toBeHidden();
		await expect(page.locator("#ps-topic-title")).toHaveText("Rediseño de UI/UX");
		const answer = page.locator(`${THREAD} > [data-result]`, { hasText: "Faltan los estados" });
		await expect(answer).toBeInViewport();
		await expect(answer).toHaveClass(/acp-msg-flash/);
		// The other interruption, from its own row in its topic.
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Mejoras del backend").click();
		const row = page.locator(`${THREAD} .acp-post`, { hasText: "informe de tiempos" });
		await row.getByRole("button", { name: "Revisar interrupción" }).click();
		const review = page.locator(".acp-review-card");
		await expect(review).toContainText("el contenedor se detuvo");
		// «Escribirle un mensaje nuevo»: the topic with that agent as its recipient.
		await review.getByRole("button", { name: "Escribirle un mensaje nuevo" }).click();
		await expect(review).toBeHidden();
		await expect(chips(page).locator(".acp-chip-name")).toHaveText(["@dev"]);
		await expect(field(page)).toBeFocused();
		expect(app.errors).toEqual([]);
	});

	test("a question is answered from Pendientes", async ({ app, backend, page }) => {
		const asking = backend.addAcpMessage({
			to_id: "arq",
			body: "@arq elegí el proveedor",
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
			state: "running",
		});
		backend.acpQuestions = [
			{
				id: 7,
				agent: "arq",
				message_id: asking.id,
				request: JSON.stringify({
					message: "¿Qué proveedor usamos?",
					requestedSchema: {
						type: "object",
						properties: { p: { type: "string", title: "Proveedor", enum: ["GitHub", "Google"] } },
					},
				}),
				state: "open",
				answer: null,
				created_at: at(1300),
				answered_at: null,
				delivered_at: null,
				note: null,
			},
		];
		await app.login("alice", topic(CONV_IDS.ci));
		await expect(page.locator("#inbox-btn")).toHaveAttribute(
			"aria-label",
			"Pendientes: 3 te esperan",
		);
		await page.locator("#inbox-btn").click();
		const q = page.locator(".acp-inbox-card .acp-ib-item.is-question");
		await expect(q.locator(".acp-ib-where")).toHaveText("Educación HZ › Rediseño de UI/UX");
		await q.getByLabel("GitHub").check();
		await q.getByRole("button", { name: "Responder" }).click();
		await expect(page.locator("#inbox-btn")).toHaveAttribute(
			"aria-label",
			"Pendientes: 2 te esperan",
		);
		await expect(page.locator(".acp-inbox-card .acp-ib-item.is-question")).toHaveCount(0);
		expect(app.errors).toEqual([]);
	});

	test("Pendientes is empty: «Nada pendiente»", async ({ app, backend, page }) => {
		for (const m of backend.acpMessages) if (m.state === "uncertain") m.reviewed_at = at(1);
		for (const c of backend.acpConversations) c.readAt = at(1799);
		await app.login("alice", topic(CONV_IDS.ci));
		await page.locator("#inbox-btn").click();
		await expect(page.locator(".acp-inbox-body")).toHaveText("Requieren tu acciónNada pendiente");
		await expect(page.locator("#inbox-btn .inbox-count")).toBeHidden();
	});
});

test.describe("a long topic", () => {
	test("300 messages: the reading place survives a visit elsewhere and new rows", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableConversations();
		for (let i = 0; i < 300; i++)
			backend.addAcpMessage({
				to_id: i % 2 ? "arq" : "dev",
				body: `@${i % 2 ? "arq" : "dev"} punto ${i}: revisá esta parte.`,
				state: "done",
				result_text: `Revisado el punto ${i}.`,
				project_id: HZ,
				conversation_id: CONV_IDS.backend,
				created_at: at(i),
				finished_at: at(i + 1),
			});
		backend.acpConversations.find((c) => c.id === CONV_IDS.backend)!.readAt = at(1799);
		await app.login("alice", topic(CONV_IDS.backend));
		const thread = page.locator(THREAD);
		await expect(thread).toContainText("Revisado el punto 299.");
		// Further up, by the reader's own scroll.
		await thread.evaluate((t) => {
			t.scrollTop = Math.round(t.scrollHeight * 0.4);
			t.dispatchEvent(new Event("scroll"));
		});
		await page.waitForTimeout(300);
		const place = () =>
			thread.evaluate((t) => {
				const top = t.getBoundingClientRect().top;
				const row = [...t.querySelectorAll<HTMLElement>(":scope > [data-anchor]")].find(
					(r) => r.getBoundingClientRect().bottom > top,
				)!;
				return {
					anchor: row.dataset.anchor,
					offset: Math.round(row.getBoundingClientRect().top - top),
				};
			});
		const before = await place();
		// A new answer below never moves the reader.
		backend.addAcpMessage({
			from_id: "dev",
			to_id: "arq",
			body: "Consulta nueva",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
			created_at: at(1795),
		});
		backend.pushAcp({ type: "message", message: backend.acpMessages.at(-1) });
		await expect(page.locator("#project-view .ps-topic .chat-end")).toContainText("1 nuevos");
		expect(await place()).toEqual(before);
		// Another topic and back: the same place.
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Optimización de CI").click();
		await expect(thread).toContainText("el job de e2e tarda");
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Mejoras del backend").click();
		// Same row, same offset (a sub-pixel of rounding aside).
		await expect
			.poll(async () => {
				const p = await place();
				return p.anchor === before.anchor && Math.abs(p.offset - before.offset) <= 1;
			})
			.toBe(true);
		expect(app.errors).toEqual([]);
	});
});

// A row can grow after the render that placed it, with no scroll and no box
// change: in CI the person's posts (monospace) re-wrapped when their font
// arrived after the topic's second load (the one `/ws/acp` triggers on
// connect), and the phone was left ~30 px short of the end for good. A font
// swap's size depends on the fallback each machine has, so the re-wrap is
// made here by a style that lands once both loads are on screen: the posts
// grow, nothing renders, nothing scrolls. "At the end" is measured to the
// pixel: END_SLACK (60) would call those 30 px the end too.
test.describe("a topic whose rows grow after they were placed", () => {
	const FEED = `/acp/conversations/${CONV_IDS.backend}/feed`;

	const frames = (page: Page) =>
		page.evaluate(
			() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
		);
	const gap = (page: Page) =>
		page.locator(THREAD).evaluate((t) => Math.round(t.scrollHeight - t.scrollTop - t.clientHeight));

	async function open(app: App, backend: MockBackend, page: Page): Promise<void> {
		backend.enableConversations();
		for (let i = 0; i < 12; i++)
			backend.addAcpMessage({
				to_id: "dev",
				body: `@dev punto ${i}: revisá el esquema de sesiones y la clave por tema.`,
				state: "done",
				result_text: `Revisado el punto ${i}.`,
				project_id: HZ,
				conversation_id: CONV_IDS.backend,
				created_at: at(i * 10),
				finished_at: at(i * 10 + 5),
			});
		// All read: the topic opens at its end, not at «Nuevos desde tu última visita».
		backend.acpConversations.find((c) => c.id === CONV_IDS.backend)!.readAt = at(200);
		await app.login("alice", topic(CONV_IDS.backend));
		await expect(page.locator(THREAD)).toContainText("Revisado el punto 11.");
		await expect.poll(() => backend.requests.filter((r) => r.path === FEED).length).toBe(2);
		await frames(page);
	}

	async function grow(page: Page): Promise<void> {
		const thread = page.locator(THREAD);
		const before = await thread.evaluate((t) => t.scrollHeight);
		await page.addStyleTag({ content: "pre.acp-msg-body { padding-bottom: 24px; }" });
		await frames(page);
		expect(await thread.evaluate((t) => t.scrollHeight)).toBeGreaterThan(before + 100);
	}

	test("a reader at the end stays at the end", async ({ app, backend, page }) => {
		await open(app, backend, page);
		expect(await gap(page)).toBeLessThan(2);
		await grow(page);
		expect(await gap(page)).toBeLessThan(2);
		expect(app.errors).toEqual([]);
	});

	test("a reader further up is not moved", async ({ app, backend, page }) => {
		await open(app, backend, page);
		const thread = page.locator(THREAD);
		const rowTop = () =>
			thread.evaluate((t) => {
				const row = [...t.children].find((c) => c.textContent?.includes("punto 3:"))!;
				return Math.round(row.getBoundingClientRect().top - t.getBoundingClientRect().top);
			});
		// Reads «punto 3» near the top, by their own scroll.
		await thread.evaluate(
			(t, dy) => {
				t.scrollTop += dy - 20;
			},
			await rowTop(),
		);
		await frames(page);
		const top = await rowTop();
		await grow(page);
		expect(Math.abs((await rowTop()) - top)).toBeLessThanOrEqual(1);
		expect(await gap(page)).toBeGreaterThan(60);
		expect(app.errors).toEqual([]);
	});
});
