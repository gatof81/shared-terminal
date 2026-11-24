import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * Screenshot baselines of the main screens, per project (desktop / mobile).
 * The terminal canvas is masked: its glyphs come from xterm's own renderer
 * (WebGL or DOM, GPU-dependent), and the mock's prompt text is asserted in
 * the functional specs anyway. Toasts are hidden (timing-dependent).
 * Regenerate with `npm run test:e2e:update` after an intended visual change
 * (it runs `--update-snapshots=all`: the default "changed" mode keeps any
 * baseline that still passes the comparison, stale toast included).
 */
const at = (sec: number) => new Date(Date.parse("2026-10-31T10:00:00Z") + sec * 1000).toISOString();

/**
 * «Mejoras del backend» with what a topic shows (3B F2): a post to the
 * whole team with one row per recipient in three states, a consult whose
 * answer came late (nested, and only referred to at the end), and an
 * interrupted message; @qa joins the project for a team of three.
 */
function topicStates(backend: MockBackend): void {
	backend.enableConversations();
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
	const c = CONV_IDS.backend;
	const hz = PROJECT_IDS.hz;
	const consult = backend.addAcpMessage({
		from_id: "arq",
		to_id: "dev",
		body: "¿El esquema de sesiones admite una por tema?",
		project_id: hz,
		conversation_id: c,
		depth: 1,
		state: "done",
		result_text: "Sí: la clave pasa a ser (agente, tema); los trabajos no cambian.",
		created_at: at(1000),
		finished_at: at(1400),
	});
	for (const [to, state, result] of [
		["arq", "running", null],
		["dev", "pending", null],
		["qa", "done", "Corrí la suite 3 veces: verde."],
	] as const)
		backend.addAcpMessage({
			to_id: to,
			body: "Mañana reviso el prototipo con ustedes: anoten acá lo que los bloquea.",
			client_id: "team-post",
			team: 1,
			project_id: hz,
			conversation_id: c,
			state,
			result_text: result,
			created_at: at(1100),
			finished_at: result ? at(1300) : null,
		});
	backend.addAcpMessage({
		from_id: "dev",
		to_id: "arq",
		kind: "reply",
		reply_to: consult.id,
		body: "Sí: la clave pasa a ser (agente, tema); los trabajos no cambian.",
		project_id: hz,
		conversation_id: c,
		depth: 1,
		created_at: at(1400),
	});
	const cut = backend.addAcpMessage({
		to_id: "qa",
		body: "@qa medí también la variante sin shards.",
		project_id: hz,
		conversation_id: c,
		state: "uncertain",
		note: "se reinició el runner de @qa",
		created_at: at(1500),
		finished_at: at(1550),
	});
	// What the review shows besides the cut: its last activity and the report.
	backend.acpActivity = {
		qa: [
			{
				seq: 1,
				at: at(1540),
				messageId: cut.id,
				kind: "tool",
				toolCallId: "t1",
				title: "Bash",
				detail: "npm run test:e2e -- --shard=1/1",
				status: "in_progress",
			},
		],
	};
	backend.addAcpMessage({
		from_id: "system",
		to_id: "qa",
		body: "Tu ejecución anterior se interrumpió: informá de solo lectura qué quedó hecho.",
		project_id: hz,
		conversation_id: c,
		recovery_of: cut.id,
		state: "done",
		result_text: "Llegué a lanzar 1 corrida sin shards; no hice commits ni cambié archivos.",
		created_at: at(1560),
		finished_at: at(1580),
	});
	const conv = backend.acpConversations.find((x) => x.id === c)!;
	conv.readAt = at(1799);
	conv.recipients = { team: true };
}

async function shot(page: Page, name: string): Promise<void> {
	// The overlays sit absolutely over the terminal's box, so masking the
	// terminal would paint over Files / Git / Chat too: mask it only when it
	// is the view on screen.
	const terminalShown = !(await page
		.locator("#files-view, #git-view, #chat-view")
		.filter({ visible: true })
		.count());
	const mask = terminalShown ? [page.locator("#terminal-container")] : [];
	await expect(page).toHaveScreenshot(`${name}.png`, {
		mask,
		fullPage: false,
		// Toasts are timing-dependent (the GPU-fallback notice, a copy chip):
		// hidden rather than masked, so no block covers what sits under them.
		stylePath: fileURLToPath(new URL("./screenshot.css", import.meta.url)),
	});
}

test.describe("visual", () => {
	test("login", async ({ app, page }) => {
		await page.goto("/");
		await expect(page.locator("#auth-view")).toBeVisible();
		await shot(page, "login");
		void app;
	});

	test("terminal", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await shot(page, "terminal");
	});

	test("files", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("files");
		await page.locator("#files-tree .files-row", { hasText: "README.md" }).click();
		await expect(page.locator("#files-preview")).toContainText("sample workspace");
		await shot(page, "files");
	});

	test("git", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("git");
		await page.locator("#git-list .git-row", { hasText: "auth.ts" }).click();
		await expect(page.locator("#git-diff")).toContainText("cookie === null");
		await shot(page, "git");
	});

	test("terminal stopped state", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("docs");
		await app.switchView("terminal");
		await expect(page.locator("#terminal-state")).toContainText("stopped");
		await shot(page, "terminal-stopped");
	});

	test("project rail", async ({ app, backend, page }) => {
		backend.enableConversations();
		// Wide, the rail beside a topic («Optimización de CI», so «Rediseño»
		// keeps its unread: entering bare would open the most recent and read it).
		await app.login(
			"alice",
			`#/projects/${PROJECT_IDS.hz}${app.mobile ? "" : `/c/${CONV_IDS.ci}`}`,
		);
		await expect(page.locator(".rail-body .rail-agent")).toHaveCount(2);
		await expect(page.locator(".rail-body .rail-unread")).toHaveText("1");
		await shot(page, "project-rail");
	});

	test("topic with unread", async ({ app, backend, page }) => {
		backend.enableConversations();
		backend.addAcpMessage({
			from_id: "dev",
			to_id: "arq",
			body: "¿Los tokens nuevos ya están en `tokens.css`?",
			project_id: PROJECT_IDS.hz,
			conversation_id: CONV_IDS.ui,
		});
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.ui}`);
		await expect(page.locator("#project-view .acp-divider")).toBeVisible();
		await expect(page.locator("#ps-topic-title")).toHaveText("Rediseño de UI/UX");
		// What was on screen is marked read: the open topic's count goes (wide,
		// where the rail shows), at a time the read mark's answer decides.
		await expect(page.locator(".rail-conv[aria-current] .rail-unread")).toHaveCount(0);
		// …and its answer leaves «Resultados sin ver»: no attention row is left.
		await expect(page.locator(".rail-attention")).toBeHidden();
		await shot(page, "project-topic");
	});

	test("topic: recipients and their states", async ({ app, backend, page }) => {
		topicStates(backend);
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.backend}`);
		await expect(page.locator("#project-view .acp-post .acp-rs")).toHaveCount(4);
		await expect(page.locator("#project-view .acp-late")).toBeVisible();
		await expect(page.locator("#project-view .acp-to-chips")).toContainText("Todo el equipo · 3");
		await shot(page, "topic-states");
	});

	test("Pendientes", async ({ app, backend, page }) => {
		topicStates(backend);
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.backend}`);
		await expect(page.locator("#inbox-btn .inbox-count")).toHaveText("1");
		await page.locator("#inbox-btn").click();
		await expect(page.locator(".acp-inbox-card .acp-ib-item")).toHaveCount(2);
		await shot(page, "inbox");
	});

	test("review of an interruption", async ({ app, backend, page }) => {
		topicStates(backend);
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.backend}`);
		await page.getByRole("button", { name: "Revisar interrupción" }).click();
		const review = page.locator(".acp-review-card");
		await expect(review.locator(".acp-review-facts")).toContainText("Última actividad");
		await expect(review.locator(".acp-review-report")).toContainText("no hice commits");
		await review.getByText("Reencolar el mensaje original…").click();
		await expect(review.getByRole("button", { name: "Reencolar", exact: true })).toBeDisabled();
		await shot(page, "review");
	});

	test("new session dialog", async ({ app, page }) => {
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await expect(page.locator("#new-session-modal")).toHaveClass(/open/);
		await shot(page, "new-session");
	});
});
