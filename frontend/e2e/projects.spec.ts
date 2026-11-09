import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import {
	AGENT_IDS,
	type MockBackend,
	PROJECT_IDS,
	PROJECT_SESSION_IDS,
	SESSION_IDS,
} from "./mockBackend.js";

/**
 * Projects & Agents, P3a (docs/PROJECTS.md; design 16 §4). The mock's
 * directory is OFF unless a test calls `backend.enableProjects()` — which is
 * also what keeps every other spec and the screenshot baselines unchanged.
 */

const PID = PROJECT_IDS.hz;
const projectHash = `#/projects/${PID}`;
const agentHash = (aid: string) => `${projectHash}/agents/${aid}`;

const projectRequests = (backend: MockBackend) =>
	backend.requests.filter((r) => r.path.startsWith("/projects"));

/** The sidebar's session rows by group heading (DOM order), visible or not (mobile drawer). */
function sidebarGroups(page: Page): Promise<Record<string, string[]>> {
	return page.locator("#session-list").evaluate((list) => {
		const out: Record<string, string[]> = {};
		let cur = "(none)";
		for (const c of Array.from(list.children)) {
			if (c.matches(".session-group-title")) {
				cur = c.textContent ?? "";
				out[cur] = [];
			} else if (c.matches(".session-item")) {
				if (!out[cur]) out[cur] = [];
				out[cur].push(c.querySelector(".session-name")?.textContent ?? "");
			}
		}
		return out;
	});
}

const pageTitle = (page: Page) => page.locator("#project-view .pv-title");

function card(page: Page, handle: string) {
	return page.locator("#project-view .pv-agent", {
		has: page.locator(".pv-agent-handle", { hasText: new RegExp(`^@${handle}$`) }),
	});
}

function dialog(page: Page) {
	return page.locator(".modal.open .pv-dialog");
}

/** Every visible match of each selector is a ≥ 44 × 44 px box (the phone touch-target rule). */
async function expectTouchTargets(page: Page, selectors: string[]): Promise<void> {
	for (const sel of selectors) {
		const found = page.locator(sel).filter({ visible: true });
		await expect(found.first(), sel).toBeVisible();
		for (const loc of await found.all()) {
			const box = await loc.boundingBox();
			expect(box, sel).not.toBeNull();
			expect(box!.height, `${sel} height`).toBeGreaterThanOrEqual(44);
			expect(box!.width, `${sel} width`).toBeGreaterThanOrEqual(44);
		}
	}
}

test.describe("projects — feature off", () => {
	test("no Projects UI, no project request, and a project link changes nothing", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", projectHash);
		await app.openSidebar();
		await expect(app.sessionRow("my-project")).toBeVisible();
		await expect(page.locator("#project-section")).toBeHidden();
		await expect(page.locator("#session-list .session-group-title")).toHaveCount(0);
		await expect(page.locator(".session-agent-link")).toHaveCount(0);
		await expect(page.locator("#project-view")).toBeHidden();
		await expect(page.locator("#empty-state")).toBeVisible();
		await app.openSession("my-project");
		await app.expectTerminalReady();
		// The session route is written as before (nothing holds the address).
		expect(new URL(page.url()).hash).toMatch(new RegExp(`^#/sessions/${SESSION_IDS.running}`));
		await page.waitForTimeout(600);
		expect(projectRequests(backend)).toEqual([]);
		// The status answer had no `features`, the rows no `binding`.
		const rows = await page.evaluate(async () => (await fetch("/api/sessions")).json());
		expect(rows.every((r: object) => !("binding" in r))).toBe(true);
	});
});

test.describe("projects — feature on", () => {
	test.beforeEach(({ backend }) => {
		backend.enableProjects();
	});

	test("sidebar: projects with agent counts; sessions grouped by binding with their agent", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		const item = page.locator("#project-list .project-item", { hasText: "Educación HZ" });
		await expect(item).toContainText("5 agents");
		await expect
			.poll(() => sidebarGroups(page))
			.toEqual({
				"Agent sessions": ["my-project", "docs", "hz-architect", "hz-dev-2", "hz-design"],
				"Unassigned sessions": ["scratch"],
			});
		await expect(app.sessionRow("my-project").locator(".session-agent-link")).toHaveText(
			"@developer-hz · Educación HZ",
		);
		await expect(app.sessionRow("scratch").locator(".session-agent-link")).toHaveCount(0);
		// The agent link goes to the agent's page — by id, not by @handle.
		await app.sessionRow("my-project").locator(".session-agent-link").click();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		expect(new URL(page.url()).hash).toBe(agentHash(AGENT_IDS.developer));
	});

	test("binding unknown (key absent) is never shown as unassigned, nor offered", async ({
		app,
		backend,
		page,
	}) => {
		backend.bindingReadFails = true;
		await app.login("alice", projectHash);
		await expect
			.poll(() => sidebarGroups(page))
			.toEqual({
				"Assignment unknown": [
					"my-project",
					"docs",
					"hz-architect",
					"hz-dev-2",
					"hz-design",
					"scratch",
				],
			});
		await expect(page.locator(".session-agent-link")).toHaveCount(0);
		await page.locator("#project-view button", { hasText: "+ New agent" }).click();
		await expect(dialog(page).locator("select option")).toHaveText(["No unassigned session"]);
		await expect(dialog(page).locator(".pv-dialog-status")).toContainText(
			"Couldn't tell which sessions are free",
		);
		await expect(dialog(page).locator("button[type=submit]")).toBeDisabled();
	});

	test("project page: the directory with honest presence, evidence and session links", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await page.locator("#project-list .project-item", { hasText: "Educación HZ" }).click();
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		expect(new URL(page.url()).hash).toBe(projectHash);
		await expect(page).toHaveTitle("Educación HZ — Shared Terminal");
		await expect(page.locator("#project-view .pv-agent")).toHaveCount(5);

		const architect = card(page, "architect-hz");
		await expect(architect.locator(".pv-presence")).toHaveText("Ready");
		await expect(architect.locator(".pv-evidence")).toHaveText("via probe · just now");
		await expect(architect.locator(".pv-role")).toHaveText("Architect");
		await expect(card(page, "developer-hz").locator(".pv-presence")).toHaveText("Working");
		await expect(card(page, "developer-hz").locator(".pv-session-link")).toContainText(
			"my-project",
		);
		const stale = card(page, "developer-hz-2");
		await expect(stale.locator(".pv-presence")).toHaveText("State unknown");
		await expect(stale.locator(".pv-evidence")).toContainText("more than 10 min old");
		await expect(stale.locator(".pv-evidence")).toContainText("via hook · 31 min ago");
		const qa = card(page, "qa-hz");
		await expect(qa.locator(".pv-presence")).toHaveText("Disconnected");
		await expect(qa.locator(".pv-evidence")).toContainText("session stopped");
		await expect(qa.locator(".pv-session-link")).toContainText("docs");
		await expect(card(page, "designer-hz").locator(".pv-presence")).toHaveText("Needs you");
		// The removed agent is not in the directory.
		await expect(card(page, "designer-old")).toHaveCount(0);
		await expect(page.locator("#project-view button", { hasText: "+ New agent" })).toBeEnabled();

		// waiting_input without a probe is "Ready (unverified)", never "needs you".
		backend.agent(AGENT_IDS.architect).presence.verified = false;
		backend.agent(AGENT_IDS.architect).presence.source = "hook";
		await page.locator("#project-view .pv-tools button[aria-label='Refresh']").click();
		await expect(architect.locator(".pv-presence")).toHaveText("Ready (unverified)");
	});

	test("agent page: identity, presence, capabilities, history; the workbench link opens the session", async ({
		app,
		page,
	}) => {
		await app.login("alice", agentHash(AGENT_IDS.developer));
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		await expect(page).toHaveTitle("@developer-hz · Educación HZ — Shared Terminal");
		const view = page.locator("#project-view");
		await expect(view.locator(".pv-sub")).toContainText("Developer · Claude Code");
		await expect(view.locator(".pv-presence")).toHaveText("Working");
		await expect(view.locator(".pv-caps")).toContainText("Conversation capture: yes");
		await expect(view.locator(".pv-caps")).toContainText("Channels: no");
		await expect(view.locator(".pv-history tbody tr")).toHaveCount(1);
		await expect(view.locator(".pv-history tbody tr").first()).toContainText("active");
		await expect(view.locator("button", { hasText: "Remove agent" })).toBeVisible();

		await view.locator("a", { hasText: "Open the workbench" }).click();
		await expect(view).toBeHidden();
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		expect(new URL(page.url()).hash).toMatch(new RegExp(`^#/sessions/${SESSION_IDS.running}`));
		// Back returns to the agent's page; the session stays open underneath.
		await page.goBack();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
	});

	test("a removed agent keeps its page and its history", async ({ app, page }) => {
		await app.login("alice", agentHash(AGENT_IDS.removed));
		const view = page.locator("#project-view");
		await expect(pageTitle(page)).toHaveText("@designer-old");
		await expect(view.locator(".pv-banner")).toContainText("Removed");
		await expect(view.locator(".pv-banner")).toContainText("stays reserved");
		await expect(view.locator("button", { hasText: "Remove agent" })).toHaveCount(0);
		await expect(view.locator(".pv-presence")).toHaveText("Disconnected");
		await expect(view.locator(".pv-evidence")).toContainText("agent removed");
		const row = view.locator(".pv-history tbody tr").first();
		await expect(row).toContainText("retired");
		await expect(row).toContainText("agent removed");
	});

	test("create project: a 503 offers Retry with the SAME id; the replay is success", async ({
		app,
		backend,
		page,
	}) => {
		backend.failNextProjectWrite = { status: 503, error: "outcome-unknown", apply: true };
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-project-btn");
		const d = dialog(page);
		await d.locator("input").fill("Tienda");
		await d.locator("button[type=submit]").click();
		await expect(d.locator(".pv-dialog-status")).toContainText("could not be confirmed");
		await expect(d.locator("input")).toBeDisabled();
		await expect(d.locator("button[type=submit]")).toHaveText("Retry");
		// Never retried on its own.
		await page.waitForTimeout(500);
		expect(backend.projectWrites).toHaveLength(1);
		await d.locator("button[type=submit]").click();
		await expect(page.locator(".pv-dialog")).toHaveCount(0);
		await expect(app.toast(/was already created/)).toBeVisible();
		const ids = backend.projectWrites.map((w) => w.body?.clientRequestId);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(ids[1]).toBe(ids[0]);
		await expect(pageTitle(page)).toHaveText("Tienda");
		expect(new URL(page.url()).hash).toMatch(/^#\/projects\/6b1f2c3d-/);
		await app.openSidebar();
		await expect(page.locator("#project-list .project-item", { hasText: "Tienda" })).toContainText(
			"0 agents",
		);
	});

	test("create agent: only unassigned sessions are offered; success binds the session", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", projectHash);
		await page.locator("#project-view button", { hasText: "+ New agent" }).click();
		const d = dialog(page);
		// Bound sessions are not offered; nor are terminated ones.
		await expect(d.locator("select option")).toHaveText(["scratch · running"]);
		await d.locator("input").nth(0).fill("Bad Handle");
		await d.locator("button[type=submit]").click();
		await expect(d.locator(".modal-field-error").first()).toContainText("lowercase");
		expect(backend.projectWrites).toHaveLength(0);
		await d.locator("input").nth(0).fill("tester");
		await d.locator("input").nth(1).fill("QA");
		await d.locator("button[type=submit]").click();
		await expect(page.locator(".pv-dialog")).toHaveCount(0);
		await expect(app.toast("Agent @tester created")).toBeVisible();
		await expect(card(page, "tester").locator(".pv-role")).toHaveText("QA");
		await expect(card(page, "tester").locator(".pv-session-link")).toContainText("scratch");
		expect(backend.projectWrites[0]!.body).toMatchObject({
			handle: "tester",
			role: "QA",
			sessionId: PROJECT_SESSION_IDS.scratch,
		});
		await expect
			.poll(() => sidebarGroups(page))
			.toEqual({
				"Agent sessions": [
					"my-project",
					"docs",
					"hz-architect",
					"hz-dev-2",
					"hz-design",
					"scratch",
				],
			});
		await expect(app.sessionRow("scratch").locator(".session-agent-link")).toHaveText(
			"@tester · Educación HZ",
		);
	});

	test("create agent: 409 session-taken is explained and the form stays editable", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", projectHash);
		await page.locator("#project-view button", { hasText: "+ New agent" }).click();
		const d = dialog(page);
		await expect(d.locator("select option")).toHaveText(["scratch · running"]);
		// Another tab binds the session meanwhile.
		backend.takeSession(PROJECT_SESSION_IDS.scratch);
		await d.locator("input").nth(0).fill("tester");
		await d.locator("button[type=submit]").click();
		await expect(d.locator(".pv-dialog-status")).toHaveText(
			"That session already belongs to another agent.",
		);
		await expect(d.locator("input").nth(0)).toBeEnabled();
		await expect(d.locator("button[type=submit]")).toHaveText("Create agent");
		// The offer is refreshed: nothing is unassigned any more.
		await expect(d.locator("select option")).toHaveText(["No unassigned session"]);
	});

	test("create agent: after a 503, a refusal is shown only once the agent list was re-read", async ({
		app,
		backend,
		page,
	}) => {
		backend.failNextProjectWrite = { status: 503, error: "outcome-unknown", apply: false };
		await app.login("alice", projectHash);
		await page.locator("#project-view button", { hasText: "+ New agent" }).click();
		const d = dialog(page);
		await d.locator("input").nth(0).fill("tester");
		await d.locator("button[type=submit]").click();
		await expect(d.locator("button[type=submit]")).toHaveText("Retry");
		await expect(d.locator("select")).toBeDisabled();
		backend.takeSession(PROJECT_SESSION_IDS.scratch);
		const from = backend.requests.length;
		await d.locator("button[type=submit]").click();
		await expect(d.locator(".pv-dialog-status")).toHaveText(
			"That session already belongs to another agent.",
		);
		const after = backend.requests.slice(from);
		const post = after.findIndex((r) => r.method === "POST");
		const reread = after.findIndex(
			(r, i) => i > post && r.method === "GET" && r.path === `/projects/${PID}/agents`,
		);
		expect(post).toBeGreaterThanOrEqual(0);
		expect(reread).toBeGreaterThan(post);
		const ids = backend.projectWrites.map((w) => w.body?.clientRequestId);
		expect(ids).toHaveLength(2);
		expect(ids[1]).toBe(ids[0]);
		// The next action is a new one: a new id.
		await d.locator("input").nth(0).fill("tester-2");
		await d.locator("button[type=submit]").click();
		await expect(d.locator(".modal-field-error").last()).toContainText("Pick a session");
	});

	test("remove agent: confirmed, its page stays (removed), its session is unassigned again", async ({
		app,
		page,
	}) => {
		await app.login("alice", agentHash(AGENT_IDS.qa));
		const view = page.locator("#project-view");
		await expect(pageTitle(page)).toHaveText("@qa-hz");
		await view.locator("button", { hasText: "Remove agent" }).click();
		await page.locator(".modal.open .modal-danger-action").click();
		await expect(app.toast("Removed @qa-hz")).toBeVisible();
		await expect(view.locator(".pv-banner")).toContainText("Removed");
		await expect(view.locator("button", { hasText: "Remove agent" })).toHaveCount(0);
		await expect(view.locator(".pv-history tbody tr").first()).toContainText("agent removed");
		await expect
			.poll(async () => (await sidebarGroups(page))["Unassigned sessions"])
			.toEqual(["docs", "scratch"]);
	});

	test("terminal invariant: a trip to a project page and back opens no socket and sends no resize", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sockets = backend.terminalSockets.length;
		const sock = backend.terminalSockets[0]!;
		const frames = sock.sent.length;

		await app.openSidebar();
		await page.locator("#project-list .project-item", { hasText: "Educación HZ" }).click();
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		await expect(page.locator("#terminal-container")).toBeHidden();
		await card(page, "developer-hz").locator(".pv-agent-handle").click();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		await page.locator("#project-view .pv-close").click();
		await expect(page.locator("#project-view")).toBeHidden();
		await expect(page.locator("#terminal-container .tab-pane.active .xterm")).toBeVisible();
		await page.goBack();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		await page.goForward();
		await expect(page.locator("#project-view")).toBeHidden();
		await page.waitForTimeout(400);

		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(
			sock.sent.slice(frames).filter((f) => f.type === "resize"),
			"no resize",
		).toEqual([]);
		expect(sock.sent.length - frames, "no frame of any kind").toBe(0);
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
	});

	test("phones: every Projects control is a 44-px touch target", async ({ app, page }) => {
		test.skip(!app.mobile, "the narrow-screen rule");
		await app.login("alice");
		await app.openSidebar();
		await expectTouchTargets(page, [
			"#new-project-btn",
			"#project-list .project-item",
			"#session-list .session-agent-link",
		]);
		await page.locator("#project-list .project-item", { hasText: "Educación HZ" }).click();
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		await expect(page.locator("#project-view .pv-agent")).toHaveCount(5);
		await expectTouchTargets(page, [
			"#project-view .pv-agent-handle",
			"#project-view .pv-session-link",
			"#project-view .pv-btn",
			"#project-view .pv-close",
		]);
		await page.locator("#project-view button", { hasText: "+ New agent" }).click();
		await expect(dialog(page)).toBeVisible();
		await expectTouchTargets(page, [".modal.open .pv-dialog .modal-close"]);
		await dialog(page).locator(".modal-close").click();
		await expect(dialog(page)).toHaveCount(0);
		await card(page, "developer-hz").locator(".pv-agent-handle").click();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		await expectTouchTargets(page, [
			"#project-view .pv-back",
			"#project-view .pv-btn",
			"#project-view .pv-close",
		]);
	});

	test("the focused page title draws no ring; a control reached by keyboard does", async ({
		app,
		page,
	}) => {
		test.skip(app.mobile, "keyboard focus");
		await app.login("alice");
		await page.locator("#project-list .project-item", { hasText: "Educación HZ" }).focus();
		await page.keyboard.press("Enter");
		await expect(pageTitle(page)).toBeFocused();
		await expect(pageTitle(page)).toHaveCSS("outline-style", "none");
		await page.keyboard.press("Tab");
		const focused = page.locator("#project-view :focus");
		await expect(focused).toHaveCount(1);
		await expect(focused).toHaveCSS("outline-style", "solid");
	});

	test("v2 phone: the bar's view tabs and ⋯ menu are out of reach under a project page, the terminal box unchanged", async ({
		app,
		backend,
		page,
	}) => {
		test.skip(!(app.mobile && app.shell === "v2"), "the merged v2 bar");
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sock = backend.terminalSockets[0]!;
		const frames = sock.sent.length;
		const boxOf = (sel: string) =>
			page.locator(sel).evaluate((el) => {
				const r = el.getBoundingClientRect();
				return { top: r.top, height: r.height, width: r.width };
			});
		const terminalBefore = await boxOf("#terminal-container");
		const headerBefore = await boxOf("header");
		const filesTab = (await page.locator("#view-files-btn").boundingBox())!;
		const menuBtn = (await page.locator("#session-menu-btn").boundingBox())!;

		await app.openSidebar();
		await page.locator("#project-list .project-item", { hasText: "Educación HZ" }).click();
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		await expect(page.locator("#view-switch")).toBeHidden();
		await expect(page.locator("#session-menu-btn")).toBeHidden();
		expect(await boxOf("#terminal-container"), "the terminal's box").toEqual(terminalBefore);
		expect(await boxOf("header"), "the header's box").toEqual(headerBefore);
		// Nothing of the bar answers a tap where its buttons were.
		for (const b of [filesTab, menuBtn]) {
			const hit = await page.evaluate(
				([px, py]) =>
					document.elementFromPoint(px!, py!)?.closest("#view-switch, #session-menu-btn")?.id ??
					null,
				[b.x + b.width / 2, b.y + b.height / 2],
			);
			expect(hit, "a bar control under the tap").toBeNull();
		}
		// A tap on the bar gives the page way to the session (projectsView.ts),
		// but the hidden Files tab under it switched nothing and no menu opened.
		await page.mouse.click(filesTab.x + filesTab.width / 2, filesTab.y + filesTab.height / 2);
		await expect(page.locator("[role='menu'].action-menu")).toHaveCount(0);
		await expect(page.locator("#files-view")).toBeHidden();
		await expect(page.locator("#view-terminal-btn")).toHaveAttribute("aria-pressed", "true");

		await app.openSidebar();
		await page.locator("#project-list .project-item", { hasText: "Educación HZ" }).click();
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		await page.locator("#project-view .pv-close").click();
		await expect(page.locator("#project-view")).toBeHidden();
		await expect(page.locator("#view-switch")).toBeVisible();
		await expect(page.locator("#session-menu-btn")).toBeVisible();
		await page.waitForTimeout(400);
		expect(await boxOf("#terminal-container")).toEqual(terminalBefore);
		expect(
			sock.sent.slice(frames).filter((f) => f.type === "resize"),
			"no resize",
		).toEqual([]);
		expect(sock.sent.length - frames, "no frame of any kind").toBe(0);
	});
});
