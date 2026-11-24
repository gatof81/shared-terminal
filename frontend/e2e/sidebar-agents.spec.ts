import { expect, FIXED_NOW, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const FRESH = "2026-10-31T10:29:58Z";

/**
 * The sidebar says which sessions are agents and what each one is doing
 * (acpModel.sidebarAgentStatus over the registry, acpStatusFeed.ts keeping it
 * current): in the tree an agent's row is its face, "@name" and ONE chip —
 * the agent's state word — with the session's name and the full label in the
 * tooltip and the accessible name; the two states that ask something of the
 * person show on the project's heading too ("●N"), folded or not.
 * Traditional rows are unchanged.
 */
test.describe("sidebar: agents and their state", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		const set = (name: string, p: Record<string, unknown>) =>
			Object.assign(backend.acpAgents.find((a) => a.name === name)!, { runnerSeenAt: FRESH }, p);
		set("arq", {});
		set("dev", { running: [12] });
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
		// The full label: tooltip and accessible name, which starts with the
		// row's words; the session's name is said there, not shown.
		const select = app.sessionRow("hz-dev-2").locator(".session-select");
		await expect(select).toHaveAttribute("title", /^hz-dev-2\n[\s\S]*Agente: trabajando en #12/);
		await expect(select).toHaveAttribute(
			"aria-label",
			/^@dev trabajando, session hz-dev-2 running, agente: trabajando en #12$/,
		);
		await expect(app.sessionRow("hz-dev-2").locator(".session-name")).toHaveText("@dev");
		// One indicator per agent row: its face and the agent's chip, no session dot.
		for (const name of ["hz-architect", "hz-dev-2", "hz-design", "scratch"]) {
			const row = app.sessionRow(name);
			await expect(row.locator(".session-avatar")).toBeVisible();
			await expect(row.locator(".session-agent-status")).toHaveClass(/\bchip\b/);
			await expect(row.locator(".session-dot")).toHaveCount(0);
		}
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
		backend.acpAgents.find((a) => a.name === "arq")!.running = [row.id];
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
		// How many wait, then who (for a screen reader, through aria-describedby).
		await expect(flag).toHaveText(/^●2 — 2 agentes te esperan: .*@arq: esperando tu respuesta/);
		// The folded heading's controls say it to a screen reader (Tab through headings).
		for (const control of [head.locator(".sgroup-toggle"), head.locator("a.sgroup-title")])
			await expect(control).toHaveAccessibleDescription(
				/agentes te esperan: .*@arq: esperando tu respuesta/,
			);
	});

	test("a just-started session whose runner has not connected says 'iniciando', not 'sin señal'", async ({
		app,
		backend,
	}) => {
		// Created 30 s before the page's clock (FIXED_NOW 10:30:00); its runner never reported.
		const sid = "7c1f2c3d-0000-4000-8000-0000000000cc";
		backend.sessions.push({
			sessionId: sid,
			ownerUserId: "u-alice",
			name: "recien",
			status: "running",
			tabs: [],
			createdAt: "2026-10-31T10:29:30Z",
		});
		backend.acpAgents.push({
			...backend.acpAgents[0]!,
			name: "recien",
			sessionId: sid,
			runnerSeenAt: null,
		});
		// An older session whose runner never reported: past the grace, "sin señal".
		Object.assign(backend.acpAgents.find((a) => a.name === "arq")!, { runnerSeenAt: null });
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("recien").locator(".session-agent-status")).toHaveText("iniciando");
		await expect(app.sessionRow("hz-architect").locator(".session-agent-status")).toHaveText(
			"sin señal",
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

/**
 * The feed's reads with the page's clock RUNNING: the fixture freezes
 * `Date.now()` (setFixedTime), which would freeze every age the feed judges
 * by — no period would ever be due and "read recently" would always be true.
 */
test.describe("sidebar: agent state re-reads (clock running)", { tag: "@any-viewport" }, () => {
	test.beforeEach(async ({ backend, page }) => {
		backend.enableAcp();
		for (const a of backend.acpAgents) a.runnerSeenAt = FRESH;
		await page.clock.install({ time: new Date(FIXED_NOW) });
	});
	const reads = (backend: { requests: Array<{ path: string }> }) =>
		backend.requests.filter((r) => r.path === "/acp/agents").length;

	test("a question answered right after a read: 'libre' within 4 s", async ({ app, backend }) => {
		backend.acpAgents.find((a) => a.name === "arq")!.waitingInput = true;
		await app.login("alice");
		await app.openSidebar();
		const arq = app.sessionRow("hz-architect").locator(".session-agent-status");
		await expect(arq).toHaveText("te espera");
		await expect.poll(() => reads(backend)).toBeGreaterThanOrEqual(1);
		// Closed less than 3 s after that read (and with the socket's
		// (re)connect re-read still pending): only a read after it can say so.
		backend.acpAgents.find((a) => a.name === "arq")!.waitingInput = false;
		backend.pushAcp({ type: "question", question: { id: 9, agent: "arq", state: "answered" } });
		await expect(arq).toHaveText("libre", { timeout: 4_000 });
	});

	test("a read in flight when the question closes does not count: one more read follows", async ({
		app,
		backend,
		page,
	}) => {
		backend.acpAgents.find((a) => a.name === "arq")!.waitingInput = true;
		await app.login("alice");
		await app.openSidebar();
		const arq = app.sessionRow("hz-architect").locator(".session-agent-status");
		await expect(arq).toHaveText("te espera");
		// Let the start's re-reads settle, then hold the next read's answer:
		// it carries the list as it was when the request arrived.
		await page.waitForTimeout(4_000);
		let release: (() => void) | null = null;
		backend.override = async (method, path, route) => {
			if (method !== "GET" || path !== "/acp/agents" || release) return false;
			const body = JSON.stringify(backend.acpAgents);
			await new Promise<void>((r) => (release = r));
			await route.fulfill({ status: 200, contentType: "application/json", body });
			return true;
		};
		const before = reads(backend);
		backend.pushAcp({ type: "agents" });
		await expect.poll(() => release !== null, { timeout: 5_000 }).toBe(true);
		// The question closes while that read is out; its answer lands after.
		backend.acpAgents.find((a) => a.name === "arq")!.waitingInput = false;
		backend.pushAcp({ type: "question", question: { id: 9, agent: "arq", state: "answered" } });
		await page.waitForTimeout(300);
		release!();
		await expect(arq).toHaveText("libre", { timeout: 4_000 });
		expect(reads(backend)).toBe(before + 2);
	});

	test("the budget: idle ≤ 2 reads/min, a burst of events = 1 read, hidden = 0, a chat open ≤ 4", async ({
		app,
		backend,
		page,
	}) => {
		backend.acpAgents.find((a) => a.name === "dev")!.running = [12];
		await app.login("alice");
		await app.openSidebar();
		await expect(app.sessionRow("hz-dev-2").locator(".session-agent-status")).toHaveText(
			"trabajando",
		);
		// Past the start's reads (landing, socket connect).
		await page.waitForTimeout(4_000);
		const minute = async () => {
			const at = reads(backend);
			// One simulated minute, in steps the page's fetches can answer between.
			for (let i = 0; i < 60; i++) {
				await page.clock.runFor(1_000);
				await page.waitForTimeout(15);
			}
			return reads(backend) - at;
		};
		expect(await minute(), "idle, an agent working").toBeLessThanOrEqual(2);

		// A burst: five events that need a read, one read.
		let at = reads(backend);
		for (let i = 0; i < 5; i++) backend.pushAcp({ type: "agents" });
		backend.pushAcp({ type: "question", question: { id: 3, agent: "arq", state: "withdrawn" } });
		await page.clock.runFor(3_500);
		await expect.poll(() => reads(backend)).toBe(at + 1);
		await page.clock.runFor(5_000);
		await page.waitForTimeout(200);
		expect(reads(backend), "one read for the burst").toBe(at + 1);

		// Hidden: nothing, even with a re-read asked for meanwhile.
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		backend.pushAcp({ type: "agents" });
		expect(await minute(), "hidden").toBe(0);
		at = reads(backend);
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => reads(backend)).toBe(at + 1);
		await page.waitForTimeout(300);
		expect(reads(backend), "one read on showing").toBe(at + 1);

		// A chat open: its own status poll, and the feed adds nothing.
		await page.evaluate(
			(sid) => (location.hash = `#/sessions/${sid}/chat`),
			PROJECT_SESSION_IDS.scratch,
		);
		await expect(page.locator("#acp-chat")).toBeVisible();
		await page.clock.runFor(2_000);
		await page.waitForTimeout(200);
		expect(await minute(), "a chat open").toBeLessThanOrEqual(4);
	});
});
