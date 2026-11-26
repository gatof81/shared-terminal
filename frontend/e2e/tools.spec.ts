// Herramientas (3B F4): an agent's Files, Git and Terminal from a topic —
// the agent's menu (its face in the thread, the topic's ⋯, Equipo), a work's
// chip and its row in the rail; the strip that always says the branch and
// the directory of the workspace on screen («Sesión completa» with
// Terminal); a work read only through `work=<id>`, a cleaned one as a state;
// and the way back: «‹ Tema» and Back to the topic at the same place, then
// to the project (the phone's stack).

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const RAIL = `#/projects/${HZ}`;
const topic = (id: string) => `#/projects/${HZ}/c/${id}`;
const toolsAt = (from: string | null, agent: string, ws: string, tool: string) =>
	`#/projects/${HZ}${from ? `/c/${from}` : ""}/tools/${agent}/${ws}/${tool}`;
const THREAD = "#project-view .ps-topic .acp-chat-thread";
const T0 = Date.parse("2026-10-31T10:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const strip = (page: Page) => page.locator("#tools-strip");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const urlEnds = (hash: string) => new RegExp(`${escapeRe(hash)}$`);

/** `n` answered requests to @arq in «Rediseño de UI/UX»: a thread that scrolls. */
function longThread(backend: MockBackend, n: number): void {
	for (let i = 0; i < n; i++)
		backend.addAcpMessage({
			to_id: "arq",
			body: `@arq punto ${i}: revisá esta parte del prototipo.\n\nCon detalle, línea por línea.`,
			state: "done",
			result_text: `Revisado el punto ${i}.\n\nTodo bien salvo un detalle de espaciado en el borde.`,
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
			created_at: at(610 + i),
			finished_at: at(1000 + i * 10),
		});
}

/** Every /api URL the page asked for (query included). */
function apiUrls(page: Page): string[] {
	const urls: string[] = [];
	page.on("request", (r) => {
		if (r.url().includes("/api/")) urls.push(decodeURIComponent(r.url()));
	});
	return urls;
}

test.describe("Herramientas", () => {
	test.beforeEach(({ backend }) => {
		backend.enableConversations();
		backend.enableWorks();
	});

	test("an agent's menu opens its tools; the strip says branch and directory; Terminal is the whole session", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", topic(CONV_IDS.ci));
		await expect(page.locator("#ps-topic-title")).toHaveText("Optimización de CI");
		await page.locator(`${THREAD} .acp-agent-id[data-agent="dev"]`).first().click();
		const menu = page.locator('[role="menu"].action-menu');
		await expect(menu).toContainText("@dev · trabajando aquí");
		await expect(menu.getByRole("menuitem", { name: /^⎇ ci-cache/ })).toBeVisible();
		await menu.getByRole("menuitem", { name: /^Files · principal/ }).click();

		await expect(page).toHaveURL(urlEnds(toolsAt(CONV_IDS.ci, "dev", "~", "files")));
		await app.expectView("files");
		await expect(page.locator(".tools-agent")).toHaveValue("dev");
		await expect(page.locator(".tools-ws")).toBeEnabled();
		await expect(page.locator(".tools-ws option:checked")).toHaveText("Principal");
		await expect(strip(page)).toContainText("Workspace principal");
		await expect(strip(page)).toContainText("rama main");
		await expect(strip(page)).toContainText("dir ~/workspace");
		await expect(page.locator("#files-tree")).toContainText("README.md");

		await page.click("#view-git-btn");
		await expect(page).toHaveURL(urlEnds(toolsAt(CONV_IDS.ci, "dev", "~", "git")));
		await expect(page.locator("#git-view #tools-strip")).toContainText("rama main");
		await expect(page.locator("#git-view #tools-strip")).toContainText("dir ~/workspace");

		// Terminal: the session's, whatever the workspace — no select to make.
		await page.click("#view-terminal-btn");
		await expect(page).toHaveURL(
			new RegExp(`${escapeRe(toolsAt(CONV_IDS.ci, "dev", "~", "terminal"))}(/tab-1)?$`),
		);
		const note = page.locator("#tab-tools .tools-term-note");
		if (app.mobile) {
			// A phone's workspace select is the strip's first line, which
			// Terminal does not have: the note says it.
			await expect(note).toHaveText("Sesión completa");
		} else {
			// Wide, the select stays in the bar, disabled, and says it once.
			await expect(page.locator(".tools-ws")).toBeDisabled();
			await expect(page.locator(".tools-ws option:checked")).toHaveText("Sesión completa");
			await expect(note).toHaveText("se abre en ~/workspace");
		}
		await expect(strip(page)).toHaveCount(0);
		await app.expectTerminalReady();
		// The principal workspace never names a work.
		expect(backend.workReads).toEqual([]);

		// «‹ Tema»: the topic again.
		await page.locator(".tools-back").click();
		await expect(page).toHaveURL(urlEnds(topic(CONV_IDS.ci)));
		await expect(page.locator(THREAD)).toBeVisible();
		await expect(page.locator(".tools-bar")).toHaveCount(0);
		expect(app.errors).toEqual([]);
	});

	test("a work: from its chip and its row; Files and Git only through work=<id>", async ({
		app,
		backend,
		page,
	}) => {
		const urls = apiUrls(page);
		await app.login("alice", topic(CONV_IDS.ci));
		await page.locator(`${THREAD} .acp-work-chip`, { hasText: "⎇ ci-cache" }).first().click();
		await expect(page).toHaveURL(urlEnds(toolsAt(CONV_IDS.ci, "dev", "ci-cache", "git")));
		await app.expectView("git");
		await expect(page.locator(".tools-ws")).toHaveValue("ci-cache");
		const s = strip(page);
		await expect(s).toContainText("Trabajo ci-cache");
		await expect(s).toContainText("rama work/ci-cache");
		await expect(s).toContainText("dir ~/workspace/.st/ctx/ci-cache");
		await expect(s).toContainText("base 3bda155");
		await expect(s).toContainText("puertos 20000–20099");
		await expect(s).toContainText("@dev trabajando aquí");
		await expect(s.getByRole("link", { name: "tema «Optimización de CI»" })).toHaveAttribute(
			"href",
			topic(CONV_IDS.ci),
		);
		await expect(page.locator("#git-list")).toContainText("ci.yml");
		// Its change, as a diff.
		await page.locator("#git-list .git-row", { hasText: "ci.yml" }).click();
		await expect(page.locator("#git-diff")).toContainText("actions/cache@v4");
		await expect(page.locator("#git-diff")).not.toContainText("No differences");

		await page.click("#view-files-btn");
		await expect(page).toHaveURL(urlEnds(toolsAt(CONV_IDS.ci, "dev", "ci-cache", "files")));
		await expect(page.locator("#files-tree")).toContainText(".github");
		await page.locator("#files-tree .files-row", { hasText: ".github" }).click();
		await page.locator("#files-tree .files-row", { hasText: "workflows" }).click();
		await page.locator("#files-tree .files-row", { hasText: "ci.yml" }).click();
		await expect(page.locator("#files-preview")).toContainText("actions/cache@v4");

		// Every read of the work named it by id — and nothing ever asked for a path under .st/.
		expect(backend.workReads.length).toBeGreaterThan(3);
		for (const r of backend.workReads) expect(r).toMatch(/\?work=ci-cache$/);
		expect(urls.filter((u) => u.includes(".st/"))).toEqual([]);

		// The principal workspace again: the same session, no work.
		const before = backend.workReads.length;
		await page.locator(".tools-ws").selectOption("");
		await expect(page).toHaveURL(urlEnds(toolsAt(CONV_IDS.ci, "dev", "~", "files")));
		await expect(page.locator("#files-tree")).not.toContainText(".github");
		await expect(strip(page)).toContainText("Workspace principal");
		expect(backend.workReads.length).toBe(before);

		// Its row in the rail. A phone's project screen has no topic: «‹» names
		// the project; wide, the project opened a topic, which «‹» names.
		await page.goto(`/${RAIL}`);
		await page.locator(".rail-body .rail-work", { hasText: "ci-cache" }).click();
		await expect(page).toHaveURL(new RegExp(`#/projects/${HZ}(/c/[^/]+)?/tools/dev/ci-cache/git$`));
		if (app.mobile) {
			await expect(page).toHaveURL(urlEnds(toolsAt(null, "dev", "ci-cache", "git")));
			await expect(page.locator(".tools-back-label")).toHaveText("Educación HZ");
		}
		await expect(strip(page)).toContainText("Trabajo ci-cache");
		expect(app.errors).toEqual([]);
	});

	test("a cleaned work is a state: no retry, no other path", async ({ app, backend, page }) => {
		await app.login("alice", toolsAt(null, "dev", "old-try", "files"));
		// One state over the whole view: no tree, no preview, no ↻.
		const gone = (view: string) => page.locator(`#${view}-view .tools-gone-state`);
		await expect(gone("files")).toContainText("Este trabajo ya no está disponible.");
		await expect(
			gone("files").getByRole("button", { name: "Ver workspace principal" }),
		).toBeVisible();
		for (const id of ["#files-header", "#files-tree", "#files-preview", "#files-refresh-btn"])
			await expect(page.locator(id)).toBeHidden();
		await expect(strip(page)).toContainText("Trabajo old-try");
		await expect(strip(page)).toContainText("ya no está disponible");
		await expect(strip(page)).toContainText("puertos —");
		// The header as in all of Herramientas: on a phone only ‹ (no ☰), and
		// the agent's name whole.
		await expect(page.locator(".tools-back")).toBeVisible();
		await expect(page.locator(".tools-agent")).toHaveValue("dev");
		if (app.mobile) await expect(page.locator("#sidebar-toggle")).toBeHidden();
		const agentBox = await page.locator(".tools-agent").boundingBox();
		expect(agentBox?.width ?? 0).toBeGreaterThan(56);
		await page.click("#view-git-btn");
		await expect(gone("git")).toContainText("Este trabajo ya no está disponible.");
		for (const id of ["#git-header", "#git-list", "#git-diff"])
			await expect(page.locator(id)).toBeHidden();
		await page.waitForTimeout(300);
		expect(backend.workReads).toEqual([
			"/fs/list?work=old-try",
			"/git/status?work=old-try",
			"/git/log?work=old-try",
		]);
		// «Ver workspace principal»: the same agent and tool, no work.
		await gone("git").getByRole("button", { name: "Ver workspace principal" }).click();
		await expect(page).toHaveURL(urlEnds(toolsAt(null, "dev", "~", "git")));
		await expect(gone("git")).toHaveCount(0);
		await expect(page.locator("#git-list")).toContainText("auth.ts");
		await expect(strip(page)).toContainText("Workspace principal");
		expect(backend.workReads).toHaveLength(3);
		expect(app.errors).toEqual([]);
	});

	test("a work's subfolder that answers 404 is that folder's error, not the work's", async ({
		app,
		page,
	}) => {
		await app.login("alice", toolsAt(CONV_IDS.ci, "dev", "ci-cache", "files"));
		await expect(page.locator("#files-tree")).toContainText(".github");
		// Deleted since its parent was listed.
		await page.route(/\/fs\/list\?.*path=\.github/, (route) =>
			route.fulfill({
				status: 404,
				contentType: "application/json",
				body: '{"error":"Not found"}',
			}),
		);
		await page.locator("#files-tree .files-row", { hasText: ".github" }).click();
		await expect(page.locator("#files-tree .files-tree-note.error")).toContainText("Not found");
		await expect(page.locator("#files-tree")).toContainText("README.md");
		await expect(page.locator(".tools-gone-state")).toHaveCount(0);
		await expect(strip(page)).not.toContainText("ya no está disponible");
		expect(app.errors).toEqual([]);
	});

	test("a deep link is the same Herramientas: on a phone only ‹, the agent named whole", async ({
		app,
		page,
	}) => {
		await app.login("alice", toolsAt(CONV_IDS.ci, "dev", "ci-cache", "git"));
		await expect(strip(page)).toContainText("Trabajo ci-cache");
		await expect(page.locator(".tools-back")).toBeVisible();
		if (app.mobile) await expect(page.locator("#sidebar-toggle")).toBeHidden();
		const agentBox = await page.locator(".tools-agent").boundingBox();
		expect(agentBox?.width ?? 0).toBeGreaterThan(56);
		// The tool tabs: icons only on a phone, each named (aria-label and title).
		for (const name of ["Terminal", "Files", "Git"]) {
			const tab = page.locator("#view-switch").getByRole("button", { name, exact: true });
			await expect(tab).toBeVisible();
			await expect(tab).toHaveAttribute("title", name);
		}
		expect(app.errors).toEqual([]);
	});

	test("a work is asked of its agent's session only, never of the one on screen", async ({
		app,
		backend,
		page,
	}) => {
		const urls = apiUrls(page);
		const dev = backend.acpAgents.find((a) => a.name === "dev")?.sessionId;
		await app.login("alice", topic(CONV_IDS.ui));
		// Another agent's session under the page: @arq's Files.
		await page.locator(".ps-topic-head .pv-menu-btn").click();
		await page.getByRole("menuitem", { name: /^Herramientas de @arq/ }).click();
		await app.expectView("files");
		await expect(page.locator("#files-tree")).toContainText("README.md");
		// Then a work of @dev's, straight from the address.
		await page.evaluate(
			(h) => {
				location.hash = h;
			},
			toolsAt(CONV_IDS.ui, "dev", "ci-cache", "files"),
		);
		await expect(strip(page)).toContainText("Trabajo ci-cache");
		await expect(page.locator("#files-tree")).toContainText(".github");
		await page.waitForTimeout(300);
		const workUrls = urls.filter((u) => u.includes("work="));
		expect(workUrls.length).toBeGreaterThan(0);
		for (const u of workUrls) expect(u).toContain(`/sessions/${dev}/`);
		await expect(page.locator(".tools-gone-state")).toHaveCount(0);
		expect(app.errors).toEqual([]);
	});

	test("Back: Herramientas → the topic where it was being read → the project", async ({
		app,
		backend,
		page,
	}) => {
		longThread(backend, 12);
		await app.login("alice", RAIL);
		await page.locator(".rail-body .rail-conv", { hasText: "Rediseño de UI/UX" }).click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Rediseño de UI/UX");
		const thread = page.locator(THREAD);
		await expect(thread).toContainText("punto 11");
		await thread.evaluate((t) => {
			t.scrollTop = 300;
			t.dispatchEvent(new Event("scroll"));
		});
		await page.waitForTimeout(300);
		const top = await thread.evaluate((t) => t.scrollTop);
		expect(top).toBeGreaterThan(0);

		// The topic's ⋯: the agents' tools (the thread is not touched to get there).
		await page.locator(".ps-topic-head .pv-menu-btn").click();
		await page.getByRole("menuitem", { name: /^Herramientas de @arq/ }).click();
		await expect(page).toHaveURL(urlEnds(toolsAt(CONV_IDS.ui, "arq", "~", "files")));
		await app.expectView("files");
		// A file opened in Herramientas is a step of its own.
		await page.locator("#files-tree .files-row", { hasText: "README.md" }).click();
		await expect(page).toHaveURL(urlEnds(`${toolsAt(CONV_IDS.ui, "arq", "~", "files")}/README.md`));

		// «‹ Tema» goes past it, to the topic, where it was being read.
		await page.locator(".tools-back").click();
		await expect(page).toHaveURL(urlEnds(topic(CONV_IDS.ui)));
		await expect(thread).toBeVisible();
		expect(await thread.evaluate((t) => t.scrollTop)).toBe(top);

		// Forward to the tools, and the browser's Back walks the same stack.
		await page.goForward();
		await expect(page).toHaveURL(urlEnds(toolsAt(CONV_IDS.ui, "arq", "~", "files")));
		await page.goBack();
		await expect(page).toHaveURL(urlEnds(topic(CONV_IDS.ui)));
		await expect(thread).toBeVisible();
		expect(await thread.evaluate((t) => t.scrollTop)).toBe(top);
		// The phone's stack: the project's screen next. (Wide, entering the
		// project opened a topic in its place, so there is no rail-only entry.)
		if (app.mobile) {
			await page.goBack();
			await expect(page).toHaveURL(urlEnds(RAIL));
			await expect(page.locator(".rail-body")).toBeVisible();
		}
		expect(app.errors).toEqual([]);
	});

	test("Equipo: an agent's row opens its Terminal; its ⋯ the rest of the menu", async ({
		app,
		page,
	}) => {
		await app.login("alice", RAIL);
		// (Wide, the project opened its last topic: Herramientas comes from it.)
		const fromTopic = (agent: string, tool: string) =>
			new RegExp(`#/projects/${HZ}(/c/[^/]+)?/tools/${agent}/~/${tool}$`);
		const row = page.locator(".rail-body .rail-agent", { hasText: "@arq" });
		await expect(row).toHaveAccessibleName(/^@arq .* — abrir Terminal$/);
		const before = page.url();
		await row.click();
		await expect(page).toHaveURL(fromTopic("arq", "terminal"));
		await app.expectView("terminal");
		await expect(page.locator("#terminal-toolbar")).toHaveAttribute(
			"data-session-name",
			"hz-architect",
		);
		// The project's page stayed under it: Back is where it was.
		await page.goBack();
		await expect(page).toHaveURL(before);
		await expect(page.locator(".rail-body")).toBeVisible();

		// The ⋯ beside the row (a sibling, not inside it): no Terminal there.
		const more = page.getByRole("button", { name: "Más acciones de @arq" });
		await expect(row.locator(".rail-agent-more")).toHaveCount(0);
		await more.click();
		const menu = page.locator('[role="menu"].action-menu');
		await expect(menu.getByRole("menuitem")).toHaveText([
			/^Files · principal/,
			/^Git · principal/,
			/^Ajustes del agente/,
		]);
		await expect(menu.locator(".action-menu-sep")).toHaveCount(1);
		await menu.getByRole("menuitem", { name: /^Git · principal/ }).click();
		await expect(page).toHaveURL(fromTopic("arq", "git"));
		await app.expectView("git");
		await expect(strip(page)).toContainText("rama main");
		// Another agent from the selector: its session, its principal workspace.
		await page.locator(".tools-agent").selectOption("dev");
		await expect(page).toHaveURL(fromTopic("dev", "git"));
		await expect(page.locator("#terminal-toolbar")).toHaveAttribute(
			"data-session-name",
			"hz-dev-2",
		);
		expect(app.errors).toEqual([]);
	});
});
