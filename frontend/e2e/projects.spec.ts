import type { Page } from "@playwright/test";
import { expect, FIXED_NOW, test } from "./fixtures.js";
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

/** The sidebar tree's session rows by group heading (DOM order), visible or not (mobile drawer, folded group). */
function sidebarGroups(page: Page): Promise<Record<string, string[]>> {
	return page.locator("#session-list").evaluate((list) => {
		const out: Record<string, string[]> = {};
		for (const g of Array.from(list.querySelectorAll(".sgroup"))) {
			const title = g.querySelector(".sgroup-name")?.textContent ?? "";
			out[title] = Array.from(g.querySelectorAll(".session-item .session-name")).map(
				(n) => n.textContent ?? "",
			);
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
		await expect(page.locator("#session-list .sgroup")).toHaveCount(0);
		await expect(page.locator(".session-agent-link")).toHaveCount(0);
		await expect(page.locator("#project-view")).toBeHidden();
		await expect(page.locator("#empty-state")).toBeVisible();
		await app.openSession("my-project");
		await app.expectTerminalReady();
		// The session route is written as before (nothing holds the address).
		expect(new URL(page.url()).hash).toMatch(new RegExp(`^#/sessions/${SESSION_IDS.running}`));
		await page.waitForTimeout(600);
		expect(projectRequests(backend)).toEqual([]);
		// No agent identity in the session bar: the element is never created.
		await expect(page.locator("#terminal-session-agent")).toHaveCount(0);
		// The status answer had no `features`, the rows no `binding`.
		const rows = await page.evaluate(async () => (await fetch("/api/sessions")).json());
		expect(rows.every((r: object) => !("binding" in r))).toBe(true);
	});
});

test.describe("projects — feature on", () => {
	test.beforeEach(({ backend }) => {
		backend.enableProjects();
	});

	test("sidebar: projects with agent counts; sessions grouped by PROJECT with their agent", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		const item = page.locator("#session-list .project-item", { hasText: "Educación HZ" });
		// The heading: the project's name (its page), and how many sessions hang from it.
		await expect(item).toHaveAttribute("title", "Open Educación HZ · 5 agents");
		await expect(
			page.locator("#session-list .sgroup", { hasText: "Educación HZ" }).locator(".sgroup-count"),
		).toHaveText("5");
		await expect
			.poll(() => sidebarGroups(page))
			.toEqual({
				"Educación HZ": ["my-project", "docs", "hz-architect", "hz-dev-2", "hz-design"],
				Unassigned: ["scratch"],
			});
		// The project is the group's heading; the row names its agent.
		await expect(app.sessionRow("my-project").locator(".session-agent-link")).toHaveText(
			"@developer-hz",
		);
		await expect(app.sessionRow("scratch").locator(".session-agent-link")).toHaveCount(0);
		// Phones show the agent as a word in the row (no room for a link there);
		// the link — to the agent's page, by id, not by @handle — is desktop's.
		if (app.mobile) {
			await expect(app.sessionRow("my-project").locator(".session-agent-tag")).toHaveText(
				"@developer-hz",
			);
			return;
		}
		await app.sessionRow("my-project").locator(".session-agent-link").click();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		expect(new URL(page.url()).hash).toBe(agentHash(AGENT_IDS.developer));
	});

	test("tree: a project folds on its chevron, stays folded after a reload, and its name still opens it", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		const group = page.locator("#session-list .sgroup", { hasText: "Educación HZ" });
		const toggle = group.locator(".sgroup-toggle");
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(app.sessionRow("hz-architect")).toBeVisible();
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(toggle).toHaveAttribute("aria-label", "Expand Educación HZ");
		// Folded: its rows are off screen, the heading keeps the count, and the
		// keyboard stays on the control that was used.
		await expect(app.sessionRow("hz-architect")).toBeHidden();
		await expect(group.locator(".sgroup-count")).toHaveText("5");
		await expect(toggle).toBeFocused();
		// The other groups are untouched.
		await expect(app.sessionRow("scratch")).toBeVisible();
		// The 5 s list poll re-renders the tree: still folded, focus kept.
		await page.waitForTimeout(5_500);
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(toggle).toBeFocused();

		await page.reload();
		await app.openSidebar();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(app.sessionRow("hz-architect")).toBeHidden();
		// The name is the project's page, folded or not — and marks it current.
		await group.locator(".project-item").click();
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		await app.openSidebar();
		await expect(group.locator(".project-item")).toHaveAttribute("aria-current", "page");
		await toggle.click();
		await expect(app.sessionRow("hz-architect")).toBeVisible();
	});

	test("tree: ↓ / ↑ walk the rows on screen and skip a folded group's", async ({ app, page }) => {
		test.skip(app.mobile, "arrow keys: a keyboard");
		await app.login("alice");
		await page.locator("#session-list .sgroup", { hasText: "Unassigned" }).waitFor();
		const names = () =>
			page.evaluate(
				() =>
					document.activeElement?.closest(".session-item")?.querySelector(".session-name")
						?.textContent ?? null,
			);
		await app.sessionRow("hz-design").locator(".session-select").focus();
		await page.keyboard.press("ArrowDown");
		expect(await names()).toBe("scratch");
		await page
			.locator("#session-list .sgroup", { hasText: "Educación HZ" })
			.locator(".sgroup-toggle")
			.click();
		await app.sessionRow("scratch").locator(".session-select").focus();
		await page.keyboard.press("ArrowUp");
		// Nothing above it is on screen: it stays where it is.
		expect(await names()).toBe("scratch");
	});

	test("tree rows: the agent on the row, usage in the tooltip, no CPU / memory lines", async ({
		app,
		backend,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		const row = app.sessionRow("my-project");
		await expect(row.locator(".session-usage-wide, .session-usage-compact")).toHaveCount(0);
		await expect(row.locator(".session-select")).toHaveAttribute(
			"title",
			/^my-project\nCPU 0\.13 cores \(12\.5%\) · Mem 256 MiB \(13%\)$/,
		);
		await expect(row.locator(".session-usage-hot")).toHaveCount(0);
		// Memory running hot is the one usage fact worth a place on the row.
		backend.session(SESSION_IDS.running)!.memPercent = 91;
		await expect(row.locator(".session-usage-hot")).toHaveText("Mem 91%", { timeout: 8_000 });
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
				// The project is still a heading (its page is one click away);
				// which sessions are its agents' is what couldn't be read.
				"Educación HZ": [],
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
		await page.locator("#session-list .project-item", { hasText: "Educación HZ" }).click();
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
		await expect(stale.locator(".pv-presence")).toHaveText("No recent activity");
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

	test("agent page: identity, presence, capabilities, history; Terminal opens the session", async ({
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
		// One named link to the session, then its views — no duplicate.
		const row = view.locator(".pv-session-row");
		await expect(row.locator(".pv-session-link")).toHaveCount(1);
		await expect(row.locator(".pv-session-actions a")).toHaveText(["Chat", "Terminal"]);
		await expect(view.getByText("Open the workbench")).toHaveCount(0);
		await expect(view.locator("button", { hasText: "Start session" })).toHaveCount(0);

		await row.locator("a", { hasText: "Terminal" }).click();
		await expect(view).toBeHidden();
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await app.expectTerminalReady();
		expect(new URL(page.url()).hash).toMatch(
			new RegExp(`^#/sessions/${SESSION_IDS.running}/terminal`),
		);
		// Back returns to the agent's page; the session stays open underneath.
		await page.goBack();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
	});

	test("agent → Chat in one click, from the card and from the agent page; Back returns to each", async ({
		app,
		page,
	}) => {
		await app.login("alice", projectHash);
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		await card(page, "developer-hz")
			.locator("a", { hasText: /^Chat$/ })
			.click();
		await expect(page.locator("#project-view")).toBeHidden();
		expect(new URL(page.url()).hash).toBe(`#/sessions/${SESSION_IDS.running}/chat`);
		await expect(page.locator("#chat-view")).toBeVisible();
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await page.goBack();
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		expect(new URL(page.url()).hash).toBe(projectHash);

		await card(page, "developer-hz").locator(".pv-agent-handle").click();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		await page.locator("#project-view .pv-session-row a", { hasText: /^Chat$/ }).click();
		await expect(page.locator("#chat-view")).toBeVisible();
		expect(new URL(page.url()).hash).toBe(`#/sessions/${SESSION_IDS.running}/chat`);
		await page.goBack();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		expect(new URL(page.url()).hash).toBe(agentHash(AGENT_IDS.developer));
	});

	test("the last conversation this browser opened is one tap away from the agent", async ({
		app,
		page,
	}) => {
		const sid = SESSION_IDS.running;
		await page.addInitScript((sid) => {
			localStorage.setItem(`st.chat.last.${sid}`, "c-remembered");
			localStorage.setItem(`st.chat.lastTitle.${sid}`, "c-remembered\nFix the login flow");
		}, sid);
		await app.login("alice", projectHash);
		const last = card(page, "developer-hz").locator(".pv-last-conv");
		await expect(last).toHaveText("↳ Fix the login flow");
		await expect(last).toHaveAttribute("href", `#/sessions/${sid}/chat/c-remembered`);
		await expect(card(page, "architect-hz").locator(".pv-last-conv")).toHaveCount(0);
	});

	test("session stopped: only that agent offers Start session, which starts it once on a click", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", projectHash);
		await expect(page.locator("#project-view .pv-agent")).toHaveCount(5);
		const startButtons = page.locator("#project-view button", { hasText: "Start session" });
		await expect(startButtons).toHaveCount(1);
		const qa = card(page, "qa-hz");
		await expect(qa.locator("button", { hasText: "Start session" })).toBeVisible();
		// Never on its own.
		await page.waitForTimeout(500);
		const starts = () =>
			backend.requests.filter(
				(r) => r.method === "POST" && r.path === `/sessions/${SESSION_IDS.stopped}/start`,
			);
		expect(starts()).toHaveLength(0);
		await qa.locator("button", { hasText: "Start session" }).click();
		await expect(app.toast(/Starting "docs"/)).toBeVisible();
		// The row now says running: no Start offered any more.
		await expect(startButtons).toHaveCount(0);
		expect(starts()).toHaveLength(1);
		// Its views stay one tap away.
		await expect(qa.locator(".pv-session-actions a")).toHaveText(["Chat", "Terminal"]);
	});

	test("sidebar groups take their project's name as soon as the project list arrives", async ({
		app,
		backend,
		page,
	}) => {
		backend.delays.projects = 1_000;
		await app.login("alice");
		await app.openSidebar();
		const link = app.sessionRow("my-project").locator(".session-agent-link");
		await expect(link).toHaveText("@developer-hz");
		// The group heading reads "Agent sessions" until the project list lands —
		// then the project's name (not on the session list's next poll, 5 s).
		await expect.poll(async () => Object.keys(await sidebarGroups(page))[0]).toBe("Agent sessions");
		await expect
			.poll(async () => Object.keys(await sidebarGroups(page))[0], { timeout: 3_000 })
			.toBe("Educación HZ");
	});

	test("empty project: + New agent in the empty state and how many sessions are unassigned", async ({
		app,
		backend,
		page,
	}) => {
		backend.projects.push({
			projectId: "6b1f2c3d-0000-4000-8000-0000000000ee",
			ownerUserId: "u-alice",
			name: "Tienda",
			createdAt: new Date().toISOString(),
		});
		await app.login("alice", "#/projects/6b1f2c3d-0000-4000-8000-0000000000ee");
		await expect(pageTitle(page)).toHaveText("Tienda");
		const empty = page.locator("#project-view .files-state-empty");
		await expect(empty).toContainText("No agents yet");
		await expect(empty).toContainText("You have 1 unassigned session.");
		await empty.locator("button", { hasText: "+ New agent" }).click();
		await expect(dialog(page).locator("select option")).toHaveText(["scratch · running"]);
	});

	test("not found: a sentence and a way back, never a bare error", async ({ app, page }) => {
		await app.login("alice", agentHash("a0000000-0000-4000-8000-0000000000ff"));
		const view = page.locator("#project-view");
		await expect(pageTitle(page)).toHaveText("Agent not found");
		await expect(view).toContainText("There is no such agent in Educación HZ");
		await expect(view).not.toContainText("Not found.");
		await view.locator("button", { hasText: "Back to Educación HZ" }).click();
		await expect(pageTitle(page)).toHaveText("Educación HZ");
		expect(new URL(page.url()).hash).toBe(projectHash);

		await page.evaluate(() => {
			window.location.hash = "#/projects/6b1f2c3d-0000-4000-8000-0000000000ff";
		});
		await expect(pageTitle(page)).toHaveText("Project not found");
		await expect(view).toContainText("doesn't exist or isn't yours");
		await view.locator("button", { hasText: "Back to Projects" }).click();
		await expect(view).toBeHidden();
		await expect(page.locator("#session-list .project-item").first()).toBeFocused();
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
		// A project without a session is still a heading of the tree.
		await expect(
			page.locator("#session-list .project-item", { hasText: "Tienda" }),
		).toHaveAttribute("title", "Open Tienda · 0 agents");
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
				"Educación HZ": ["my-project", "docs", "hz-architect", "hz-dev-2", "hz-design", "scratch"],
			});
		await expect(app.sessionRow("scratch").locator(".session-agent-link")).toHaveText("@tester");
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
			.poll(async () => (await sidebarGroups(page)).Unassigned)
			.toEqual(["docs", "scratch"]);
	});

	test("delete permanently on a bound session: explained before any request, with a way to its agent", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await app.sessionRow("my-project").locator(".session-menu-btn").click();
		await page.locator('[role="menuitem"][data-action="delete"]').click();
		const d = page.locator(".modal.open .dialog-card");
		await expect(d.locator("h2")).toHaveText("Can't delete permanently");
		await expect(d).toContainText(
			'"my-project" belongs to the agent @developer-hz in Educación HZ. Remove the agent first; the session itself stays and can then be deleted.',
		);
		// No name to type: nothing here deletes.
		await expect(d.locator("input")).toHaveCount(0);
		await d.locator("button", { hasText: "Open @developer-hz" }).click();
		await expect(pageTitle(page)).toHaveText("@developer-hz");
		expect(new URL(page.url()).hash).toBe(agentHash(AGENT_IDS.developer));
		expect(backend.requests.filter((r) => r.method === "DELETE")).toEqual([]);
	});

	test("delete permanently refused by the server (binding unknown here): the explanation after the request", async ({
		app,
		backend,
		page,
	}) => {
		backend.bindingReadFails = true;
		await app.login("alice");
		await app.openSidebar();
		await app.sessionRow("my-project").locator(".session-menu-btn").click();
		await page.locator('[role="menuitem"][data-action="delete"]').click();
		const confirm = page.locator('[role="alertdialog"]');
		await confirm.locator("input").fill("my-project");
		await confirm.locator(".modal-danger-action").click();
		const d = page.locator(".modal.open .dialog-card");
		await expect(d.locator("h2")).toHaveText("Can't delete permanently");
		await expect(d).toContainText(
			"This session belongs to a project agent. Remove the agent first (Projects), then delete it.",
		);
		await expect(d).not.toContainText("It was terminated");
		expect(backend.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
			`/sessions/${SESSION_IDS.running}?hard=true`,
		]);
		await expect(app.toast("Failed to delete session")).toHaveCount(0);
		await d.locator("button", { hasText: "Close" }).click();
		await expect(d).toHaveCount(0);
		await expect(app.sessionRow("my-project")).toBeVisible();
	});

	test("refused at the server's second check: the session was terminated, its files kept — said so", async ({
		app,
		backend,
		page,
	}) => {
		backend.bindingReadFails = true;
		backend.hardDeleteRefusedAfterSoftDelete = true;
		await app.login("alice");
		await app.openSidebar();
		await app.sessionRow("my-project").locator(".session-menu-btn").click();
		await page.locator('[role="menuitem"][data-action="delete"]').click();
		const confirm = page.locator('[role="alertdialog"]');
		await confirm.locator("input").fill("my-project");
		await confirm.locator(".modal-danger-action").click();
		const d = page.locator(".modal.open .dialog-card");
		await expect(d).toContainText(
			"It was terminated; its files are kept. Delete it permanently after removing the agent.",
		);
		expect(backend.session(SESSION_IDS.running)?.status).toBe("terminated");
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
		await page.locator("#session-list .project-item", { hasText: "Educación HZ" }).click();
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

	test("phones: a session is one row, the agent named on it (owner review 2026-11-13)", async ({
		app,
	}) => {
		test.skip(!app.mobile, "the narrow-screen layout");
		await app.login("alice");
		await app.openSidebar();
		const row = app.sessionRow("my-project");
		await expect(row.locator(".session-agent-tag")).toBeVisible();
		await expect(row.locator(".session-agent-tag")).toHaveText("@developer-hz");
		// No separate agent row: each session used to take ~115 px (name, CPU,
		// Mem, then a 44-px agent link row below a gap).
		await expect(row.locator(".session-agent-link")).toBeHidden();
		const r = (await row.boundingBox())!;
		expect(r.height).toBeLessThanOrEqual(56);
		// The second line is the agent alone: CPU / memory moved to the tooltip
		// (they truncated to "0.13 cores · 256 Mi…" and squeezed the agent).
		await expect(row.locator(".session-usage-compact, .session-usage-wide")).toHaveCount(0);
		// Screen readers get the agent in the row's name (the link is hidden here).
		await expect(row.locator(".session-select")).toHaveAttribute(
			"aria-label",
			/^my-project, running, agent @developer-hz/,
		);
		// The row opens the session (the tag is part of its button).
		await expect(row.locator(".session-select .session-agent-tag")).toHaveCount(1);
	});

	test("phones: every Projects control is a 44-px touch target", async ({ app, page }) => {
		test.skip(!app.mobile, "the narrow-screen rule");
		await app.login("alice");
		await app.openSidebar();
		// (Phones name a session's agent inside its row: no separate link there.)
		await expectTouchTargets(page, [
			"#new-project-btn",
			"#session-list .project-item",
			"#session-list .sgroup-toggle",
		]);
		await page.locator("#session-list .project-item", { hasText: "Educación HZ" }).click();
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
		await page.locator("#session-list .project-item", { hasText: "Educación HZ" }).focus();
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
		await page.locator("#session-list .project-item", { hasText: "Educación HZ" }).click();
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
		await page.locator("#session-list .project-item", { hasText: "Educación HZ" }).click();
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
	test("presence summary: one count per displayed state; nothing live without fresh agent evidence", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", projectHash);
		const summary = page.locator("#project-view .pv-summary");
		await expect(summary).toHaveText(
			"1 needs you · 1 working · 1 ready · 1 disconnected · 1 no recent activity or unknown",
		);
		await expect(page.locator("#project-view .pv-sub")).toHaveText("5 agents · as of just now");
		// Only the card that needs the person carries the accent.
		await expect(page.locator("#project-view .pv-agent.pv-agent-attention")).toHaveCount(1);
		await expect(card(page, "designer-hz")).toHaveClass(/pv-agent-attention/);
		const order = () => page.locator("#project-view .pv-agent-handle").allTextContents();
		const before = await order();

		const ago = (sec: number) => new Date(Date.parse(FIXED_NOW) - sec * 1000).toISOString();
		// A running session alone is not a working Claude.
		backend.agent(AGENT_IDS.architect).presence = {
			value: "working",
			source: "session",
			at: ago(5),
		};
		// Working, but the last evidence is 11 min old.
		backend.agent(AGENT_IDS.developer).presence = {
			value: "working",
			source: "hook",
			at: ago(660),
		};
		// A permission prompt seen only by a probe is not "needs you".
		backend.agent(AGENT_IDS.designer).presence = {
			value: "needs_attention",
			detail: "waiting_permission",
			source: "probe",
			at: ago(5),
		};
		await page.locator("#project-view .pv-tools button[aria-label='Refresh']").click();
		await expect(summary).toHaveText("1 disconnected · 4 no recent activity or unknown");
		await expect(card(page, "architect-hz").locator(".pv-presence")).toHaveText("State unknown");
		await expect(card(page, "developer-hz").locator(".pv-presence")).toHaveText(
			"No recent activity",
		);
		await expect(card(page, "designer-hz").locator(".pv-presence")).toHaveText("State unknown");
		await expect(page.locator("#project-view .pv-agent.pv-agent-attention")).toHaveCount(0);
		// A stale ready and a stale "needs you" are no recent activity, too.
		backend.agent(AGENT_IDS.architect).presence = {
			value: "waiting_input",
			source: "probe",
			at: ago(700),
			verified: true,
		};
		backend.agent(AGENT_IDS.designer).presence = {
			value: "needs_attention",
			detail: "waiting_permission",
			source: "hook",
			at: ago(600),
		};
		await page.locator("#project-view .pv-tools button[aria-label='Refresh']").click();
		await expect(card(page, "architect-hz").locator(".pv-presence")).toHaveText(
			"No recent activity",
		);
		await expect(card(page, "designer-hz").locator(".pv-presence")).toHaveText(
			"No recent activity",
		);
		await expect(summary).toHaveText("1 disconnected · 4 no recent activity or unknown");
		// The cards never moved: creation order, whatever their state.
		expect(await order()).toEqual(before);
	});

	test("presence is judged on the server's clock: a browser 1 h ahead or behind sees the same", async ({
		app,
		page,
	}) => {
		const expected =
			"1 needs you · 1 working · 1 ready · 1 disconnected · 1 no recent activity or unknown";
		for (const skewMs of [3_600_000, -3_600_000]) {
			await page.clock.setFixedTime(Date.parse(FIXED_NOW) + skewMs);
			await app.login("alice", projectHash);
			await expect(page.locator("#project-view .pv-summary")).toHaveText(expected);
			await expect(card(page, "developer-hz").locator(".pv-evidence")).toHaveText(
				"via hook · just now",
			);
			await expect(page.locator("#project-view .pv-sub")).toHaveText("5 agents · as of just now");
		}
		// The agent page has no generatedAt of its own (§4.5): it ages its
		// evidence on the server clock of the project's list.
		await app.login("alice", agentHash(AGENT_IDS.designer));
		await expect(page.locator("#project-view .pv-presence")).toHaveText("Needs you");
	});

	test("session bar: @handle · project for a bound session, nothing for unassigned or unknown", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		const identity = page.locator("#terminal-session-agent");
		await expect(identity).toHaveText("@developer-hz · Educación HZ");
		await expect(identity).toHaveAttribute("href", agentHash(AGENT_IDS.developer));
		if (app.mobile) {
			// No room on a phone's bar: left out rather than wrapped.
			await expect(identity).toBeHidden();
		} else {
			await expect(identity).toBeVisible();
			await identity.click();
			await expect(pageTitle(page)).toHaveText("@developer-hz");
			expect(new URL(page.url()).hash).toBe(agentHash(AGENT_IDS.developer));
			await page.locator("#project-view .pv-close").click();
			await expect(page.locator("#project-view")).toBeHidden();
		}
		await app.openSession("scratch");
		await expect(identity).toHaveCount(0);

		// The binding key absent (directory read failed): unknown, nothing shown.
		backend.bindingReadFails = true;
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await expect(identity).toHaveCount(0);
	});

	test("session bar identity appearing changes neither the bar's height nor the terminal's box, and sends no resize", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("scratch");
		await app.expectTerminalReady();
		// v1 phone: the bar lives in the chrome drawer — measure it shown.
		await app.openChrome();
		await page.waitForTimeout(400);
		const sock = backend.terminalSockets.find((s) => !s.closed)!;
		const frames = sock.sent.length;
		const box = (sel: string) =>
			page.locator(sel).evaluate((el) => {
				const r = el.getBoundingClientRect();
				return { x: r.x, y: r.y, width: r.width, height: r.height };
			});
		const toolbarBefore = await box("#terminal-toolbar");
		const terminalBefore = await box("#terminal-container");
		const xtermBefore = await box("#terminal-container .tab-pane.active .xterm-screen");
		await expect(page.locator("#terminal-session-agent")).toHaveCount(0);

		// Another tab binds this session to an agent; the next session poll shows it.
		backend.takeSession(PROJECT_SESSION_IDS.scratch, "scratch-agent-with-a-rather-long-handle");
		await expect(page.locator("#terminal-session-agent")).toHaveText(
			"@scratch-agent-with-a-rather-long-handle · Educación HZ",
			{ timeout: 12_000 },
		);
		if (!app.mobile) {
			const id = await box("#terminal-session-agent");
			expect(id.height, "one line").toBeLessThanOrEqual(toolbarBefore.height);
		}
		await page.waitForTimeout(400);
		expect(await box("#terminal-toolbar"), "the bar's box").toEqual(toolbarBefore);
		expect(await box("#terminal-container"), "the terminal's box").toEqual(terminalBefore);
		expect(await box("#terminal-container .tab-pane.active .xterm-screen")).toEqual(xtermBefore);
		expect(
			sock.sent.slice(frames).filter((f) => f.type === "resize"),
			"no resize",
		).toEqual([]);
		expect(sock.sent.length - frames, "no frame of any kind").toBe(0);
	});
});
