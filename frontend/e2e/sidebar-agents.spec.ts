import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const FRESH = "2026-10-31T10:29:58Z";

/**
 * The sidebar says which sessions are agents and what each one is doing
 * (acpModel.sidebarAgentStatus over the registry, acpStatusFeed.ts keeping it
 * current): "@name" and a mark + word, the full label in the tooltip and the
 * accessible name; the two states that ask something of the person show on
 * the project's heading too, folded or not. Traditional rows are unchanged.
 */
test.describe("sidebar: agents and their state", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		const set = (name: string, p: Record<string, unknown>) =>
			Object.assign(backend.acpAgents.find((a) => a.name === name)!, { runnerSeenAt: FRESH }, p);
		set("arq", {});
		set("dev", { running: 12 });
		set("solo", { waitingInput: true });
		const base = backend.acpAgents[0]!;
		backend.acpAgents.push({
			...base,
			name: "dis",
			sessionId: PROJECT_SESSION_IDS.designer,
			authRequired: true,
			runnerSeenAt: FRESH,
		});
	});

	test("each agent row shows its name and state; a traditional row stays as it was", async ({
		app,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		const state = (name: string) => app.sessionRow(name).locator(".session-agent-status");
		await expect(app.sessionRow("hz-architect").locator(".session-agent-tag")).toHaveText("@arq");
		await expect(state("hz-architect")).toHaveText("libre");
		await expect(state("hz-dev-2")).toHaveText("trabajando");
		await expect(state("hz-design")).toHaveText("login");
		await expect(state("scratch")).toHaveText("te espera");
		await expect(state("scratch")).toHaveClass(/asks/);
		await expect(state("hz-dev-2")).not.toHaveClass(/asks/);
		// The full label: tooltip and accessible name, which starts with the row's words.
		const select = app.sessionRow("hz-dev-2").locator(".session-select");
		await expect(select).toHaveAttribute("title", /Agente: trabajando en #12/);
		await expect(select).toHaveAttribute(
			"aria-label",
			/^hz-dev-2 @dev trabajando, session running, agente: trabajando en #12$/,
		);
		for (const name of ["hz-architect", "hz-dev-2", "hz-design", "scratch"])
			await expect(app.sessionRow(name).locator(".session-agent-line")).toBeVisible();
		// Traditional: no agent part, the same name as before.
		await expect(app.sessionRow("my-project").locator(".session-agent-line")).toHaveCount(0);
		await expect(app.sessionRow("my-project").locator(".session-select")).toHaveAttribute(
			"aria-label",
			"my-project, session running",
		);
	});

	test("a live event moves a row's state without opening its chat; a waiting agent shows on its folded project", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		const arq = app.sessionRow("hz-architect").locator(".session-agent-status");
		await expect(arq).toHaveText("libre");
		const row = backend.addAcpMessage({ to_id: "arq", body: "@arq revisá", state: "running" });
		backend.acpAgents.find((a) => a.name === "arq")!.running = row.id;
		backend.pushAcp({ type: "message", message: row });
		await expect(arq).toHaveText("trabajando");
		await expect(page.locator("#chat-view")).toBeHidden();

		// A question opens: "te espera", on the row and on the project's heading.
		const q = { id: 9, agent: "arq", message_id: row.id, state: "open" };
		backend.acpAgents.find((a) => a.name === "arq")!.waitingInput = true;
		backend.pushAcp({ type: "question", question: q });
		await expect(arq).toHaveText("te espera");
		const head = page.locator(`.sgroup[data-group="${PROJECT_IDS.hz}"] .sgroup-head`);
		await head.locator(".sgroup-toggle").click();
		await expect(app.sessionRow("hz-architect")).toBeHidden();
		const flag = head.locator(".sgroup-asks");
		await expect(flag).toHaveText("te espera");
		await expect(flag).toHaveAttribute(
			"aria-label",
			/agentes te esperan: .*@arq: esperando tu respuesta/,
		);
	});

	test("a stopped agent's session says it is stopped, not 'sin señal'", async ({
		app,
		backend,
	}) => {
		const s = backend.sessions.find((x) => x.sessionId === PROJECT_SESSION_IDS.scratch)!;
		s.status = "stopped";
		s.tabs = [];
		await app.login("alice");
		await app.openSidebar();
		const row = app.sessionRow("scratch");
		await expect(row.locator(".session-state")).toHaveText("Stopped");
		await expect(row.locator(".session-agent-tag")).toHaveText("@solo");
		await expect(row.locator(".session-agent-status")).toHaveCount(0);
	});
});

test.describe("sidebar: ACP off", () => {
	test("nothing new is read or shown", async ({ app, backend }) => {
		backend.enableProjects();
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("hz-architect")).toBeVisible();
		await expect(app.page.locator(".session-agent-line, .sgroup-asks")).toHaveCount(0);
		// The one read the projects page always made at start (main does the
		// same); nothing of the sidebar's: no periodic or event-driven re-read.
		await app.page.waitForTimeout(3500);
		expect(backend.requests.filter((r) => r.path === "/acp/agents")).toHaveLength(1);
	});
});
