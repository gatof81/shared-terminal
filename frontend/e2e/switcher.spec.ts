import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

/**
 * switcher.spec.ts — "Go to a conversation": every conversation of the
 * person's running projects, the ones that need them first; a stale wait is
 * never "needs you"; a failed project says so (and can be retried) while the
 * others stay navigable; opening only navigates (GETs only, terminal
 * untouched); Ctrl/⌘+K never fires while typing.
 */

async function openSwitcher(
	app: import("./fixtures.js").App,
	page: import("@playwright/test").Page,
): Promise<void> {
	if (app.mobile) {
		await app.openSidebar();
		await page.click("#sidebar-switcher-btn");
	} else {
		await page.click("#switcher-btn");
	}
	await expect(page.locator(".switcher-card")).toBeVisible();
	await expect(page.locator("#switcher-input")).toBeFocused();
}

const option = (page: import("@playwright/test").Page, title: string) =>
	page.locator(".switcher-option", { hasText: title });

test.describe("conversation switcher", () => {
	test("lists conversations by what they need, and Enter opens one in Chat without touching the session", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		const sock = backend.terminalSockets.find((s) => !s.closed)!;
		const sentBefore = sock.sent.length;
		const reqBefore = backend.requests.length;

		await openSwitcher(app, page);
		const groups = page.locator(".switcher-group-title");
		await expect(groups).toHaveText(["Needs you", "Recent"]);
		await expect(option(page, "Refactor auth flow")).toContainText("my-project");
		await expect(option(page, "Refactor auth flow")).toContainText("Waiting for input");
		await expect(option(page, "Fix tests")).toContainText("Ended");
		// Only running projects are asked ("docs" is stopped).
		expect(
			backend.requests
				.slice(reqBefore)
				.filter((r) => r.path.includes(SESSION_IDS.stopped) && r.path.includes("/conversations")),
		).toEqual([]);

		// The first option is active; Enter opens it in Chat.
		await expect(option(page, "Refactor auth flow")).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("Enter");
		await expect(page.locator(".switcher-card")).toHaveCount(0);
		await expect(page).toHaveURL(new RegExp(`#/sessions/${SESSION_IDS.running}/chat/conv-1$`));
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("cookie check");

		// The light, polling-safe list form (no relay probe).
		expect(
			backend.requests
				.slice(reqBefore)
				.some((r) => r.path.endsWith(`${SESSION_IDS.running}/conversations?capture=0`)),
		).toBe(true);
		// Navigation only: GETs, no input or resize to the terminal.
		expect(backend.requests.slice(reqBefore).filter((r) => r.method !== "GET")).toEqual([]);
		expect(
			sock.sent.slice(sentBefore).filter((f) => f.type === "input" || f.type === "resize"),
		).toEqual([]);
	});

	test("a stale wait is not 'Needs you': it is listed as no recent activity", async ({
		app,
		backend,
		page,
	}) => {
		const c1 = backend.conversations.find((c) => c.cid === "conv-1")!;
		c1.status = "waiting_permission";
		c1.statusAt = "2026-10-31T09:00:00Z";
		for (const e of c1.events) e.ts = "2026-10-31T09:00:00Z";
		await app.login("alice");
		await openSwitcher(app, page);
		await expect(page.locator(".switcher-group-title")).toHaveText([
			"Recent",
			"Unknown or no recent activity",
		]);
		await expect(option(page, "Refactor auth flow")).toContainText("No recent activity");
	});

	test("search narrows by conversation or project, and says when nothing matches", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await openSwitcher(app, page);
		await page.fill("#switcher-input", "fix");
		await expect(page.locator(".switcher-option")).toHaveCount(1);
		await expect(option(page, "Fix tests")).toBeVisible();
		await page.fill("#switcher-input", "my-project refactor");
		await expect(page.locator(".switcher-option")).toHaveCount(1);
		await page.fill("#switcher-input", "nothing-like-this");
		await expect(page.locator(".switcher-option")).toHaveCount(0);
		await expect(page.locator(".switcher-empty")).toContainText("No conversation matches");
		await page.keyboard.press("Escape");
		await expect(page.locator(".switcher-card")).toHaveCount(0);
	});

	test("a project that fails says so and can be retried; the others stay navigable", async ({
		app,
		backend,
		page,
	}) => {
		const docs = backend.sessions.find((s) => s.sessionId === SESSION_IDS.stopped)!;
		docs.status = "running";
		backend.override = async (method, path, route) => {
			if (method === "GET" && path.includes(`${SESSION_IDS.stopped}/conversations`)) {
				await route.fulfill({ status: 429, body: JSON.stringify({ error: "Too many requests" }) });
				return true;
			}
			return false;
		};
		await app.login("alice");
		await openSwitcher(app, page);
		const err = page.locator(".switcher-error");
		await expect(err).toContainText("docs");
		await expect(err).toContainText("Too many requests");
		// The other project's conversations are there, not an empty list.
		await expect(page.locator(".switcher-option").first()).toBeVisible();
		await expect(page.locator(".switcher-empty")).toHaveCount(0);

		backend.override = null;
		await err.locator("button", { hasText: "Retry" }).click();
		await expect(page.locator(".switcher-error")).toHaveCount(0);
		await expect(page.locator(".switcher-option", { hasText: "docs" }).first()).toBeVisible();
	});

	test("no running project: says so instead of an empty list", async ({ app, backend, page }) => {
		for (const s of backend.sessions) if (s.status === "running") s.status = "stopped";
		await app.login("alice");
		await openSwitcher(app, page);
		await expect(page.locator(".switcher-empty")).toContainText("No running projects");
	});

	test("Ctrl+K opens it from the page but never while typing in the composer", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		const ta = page.locator(".chat-composer textarea");
		await ta.click();
		await page.keyboard.press("Control+k");
		await expect(page.locator(".switcher-card")).toHaveCount(0);
		await page.locator("#chat-thread .chat-assistant").first().click();
		await page.keyboard.press("Control+k");
		await expect(page.locator(".switcher-card")).toBeVisible();
	});

	test("opens a conversation of ANOTHER project: the project, Chat and the thread", async ({
		app,
		backend,
		page,
	}) => {
		backend.sessions.find((x) => x.sessionId === SESSION_IDS.stopped)!.status = "running";
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await openSwitcher(app, page);
		await page.fill("#switcher-input", "docs refactor");
		await expect(page.locator(".switcher-option")).toHaveCount(1);
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(new RegExp(`#/sessions/${SESSION_IDS.stopped}/chat/conv-1$`));
		await expect(page.locator("#terminal-session-name")).toContainText("docs");
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("cookie check");
	});

	test("Ctrl+K inside the terminal stays the shell's (kill-line)", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.locator(".tab-pane.active .xterm-helper-textarea").focus();
		await page.keyboard.press("Control+k");
		await expect(page.locator(".switcher-card")).toHaveCount(0);
	});

	test("names/archive unavailable: the project says its titles are the automatic ones", async ({
		app,
		backend,
		page,
	}) => {
		backend.metaUnavailable = true;
		await app.login("alice");
		await openSwitcher(app, page);
		await expect(page.locator(".switcher-note")).toContainText(
			"names and archive state unavailable",
		);
		await expect(page.locator(".switcher-option").first()).toBeVisible();
	});

	test("a session that expires while it loads closes it before the login view shows", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		backend.override = async (method, path, route) => {
			if (method === "GET" && path.includes("/conversations")) {
				await route.fulfill({ status: 401, body: JSON.stringify({ error: "Unauthorized" }) });
				return true;
			}
			return false;
		};
		await openSwitcher(app, page).catch(() => undefined);
		await expect(page.locator("#auth-view")).toBeVisible();
		await expect(page.locator(".switcher-card")).toHaveCount(0);
	});

	test("subagents with no end yet are rows of their own under a running conversation; choosing one opens Chat on that agent", async ({
		app,
		backend,
		page,
	}) => {
		const c1 = backend.conversations.find((c) => c.cid === "conv-1")!;
		c1.status = "running";
		const last = c1.events[c1.events.length - 1]!;
		const ev = (seq: number, name: string, agentId: string, type: string) => ({
			...last,
			seq,
			ev: name,
			agent_id: null,
			data: { agent_id: agentId, agent_type: type },
		});
		c1.events.push(
			ev(last.seq + 1, "agent_start", "agentaaaa1111", "Explore"),
			ev(last.seq + 2, "agent_start", "agentbbbb2222", "general-purpose"),
			ev(last.seq + 3, "agent_end", "agentbbbb2222", "general-purpose"),
		);
		c1.agents = [
			{
				agentId: "agentaaaa1111",
				agentType: "Explore",
				status: "running",
				startedSeq: last.seq + 1,
				toolCount: 2,
				hasResult: false,
			},
			{
				agentId: "agentbbbb2222",
				agentType: "general-purpose",
				status: "done",
				startedSeq: last.seq + 2,
				endedSeq: last.seq + 3,
				toolCount: 1,
				hasResult: true,
			},
		];
		await app.login("alice");
		await openSwitcher(app, page);
		await expect(option(page, "Refactor auth flow")).toContainText(
			"1 agent started, no end yet · 1 done",
		);
		const agentRow = page.locator(".switcher-agent", { hasText: "Explore" });
		await expect(agentRow).toContainText("started, no end yet");
		await expect(agentRow).not.toContainText("working");
		await expect(page.locator(".switcher-agent", { hasText: "general-purpose" })).toHaveCount(0);
		await agentRow.click();
		await expect(page).toHaveURL(new RegExp(`#/sessions/${SESSION_IDS.running}/chat/conv-1$`));
		await expect(
			page.locator('#chat-agents .chat-agent.focused[data-agent="agentaaaa1111"]'),
		).toBeVisible();
	});

	test("subagents are not asked for when the conversation's evidence is stale, nor when its turn ended (waiting for input)", async ({
		app,
		backend,
		page,
	}) => {
		const agentsOne = [
			{
				agentId: "agentaaaa1111",
				agentType: "Explore",
				status: "running" as const,
				startedSeq: 1,
				toolCount: 0,
				hasResult: false,
			},
		];
		// conv-1: a live claim gone stale. conv-2 (reused as a fresh one): waiting for input.
		const c1 = backend.conversations.find((c) => c.cid === "conv-1")!;
		c1.status = "running";
		c1.statusAt = "2026-10-31T09:00:00Z";
		for (const e of c1.events) e.ts = "2026-10-31T09:00:00Z";
		c1.agents = agentsOne;
		const c2 = backend.conversations.find((c) => c.cid === "conv-2")!;
		c2.status = "waiting_input";
		c2.agents = agentsOne;
		// Positive control: a fresh RUNNING conversation whose agents ARE asked for.
		backend.conversations.push({
			...backend.conversations.find((c) => c.cid === "conv-1")!,
			cid: "conv-3",
			title: "Live one",
			status: "running",
			statusAt: undefined,
			events: backend.conversations
				.find((c) => c.cid === "conv-2")!
				.events.map((e) => ({ ...e, ts: "2026-10-31T10:29:00Z" })),
			agents: agentsOne,
			gapsCount: 1,
		});
		await app.login("alice");
		await openSwitcher(app, page);
		await expect
			.poll(() => backend.requests.some((r) => r.path.endsWith("/conversations/conv-3/agents")))
			.toBe(true);
		expect(backend.requests.some((r) => r.path.endsWith("/conversations/conv-1/agents"))).toBe(
			false,
		);
		expect(backend.requests.some((r) => r.path.endsWith("/conversations/conv-2/agents"))).toBe(
			false,
		);
		await expect(option(page, "Refactor auth flow")).toContainText("No recent activity");
		await expect(page.locator(".switcher-agent")).toHaveCount(1);
		// Lost events in that conversation: the agents line says ends may be missing.
		await expect(option(page, "Live one")).toContainText("ends may be missing");
	});

	test("an agent list that fails leaves the conversation row as it is", async ({
		app,
		backend,
		page,
	}) => {
		backend.override = async (method, path, route) => {
			if (method === "GET" && path.endsWith("/agents")) {
				await route.fulfill({ status: 500, body: JSON.stringify({ error: "boom" }) });
				return true;
			}
			return false;
		};
		await app.login("alice");
		await openSwitcher(app, page);
		await expect(option(page, "Refactor auth flow")).toContainText("Waiting for input");
		await expect(page.locator(".switcher-option-agents")).toHaveCount(0);
		await expect(page.locator(".switcher-error")).toHaveCount(0);
	});
});
