import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// projectsView.ts against a fake api (P3a). The module reads its DOM at
// import, so each test builds the markup first and imports a fresh copy.

const api = vi.hoisted(() => ({
	projectChatEnabled: vi.fn(() => true),
	// Projects v3 off here: these tests are the P3a page (teamView has its own).
	projectConversationEnabled: vi.fn(() => false),
	fetchProjectEvents: vi.fn(),
	fetchProjectMessage: vi.fn(),
	postProjectMessage: vi.fn(),
	postProjectAck: vi.fn(),
	readConversationEvent: vi.fn(),
	isLoggedIn: vi.fn(() => true),
	fetchProjects: vi.fn(),
	fetchProjectAgents: vi.fn(),
	fetchAgent: vi.fn(),
	createProject: vi.fn(),
	createAgent: vi.fn(),
	removeAgent: vi.fn(),
}));
const mainMock = vi.hoisted(() => ({ sessions: [] as Array<Record<string, unknown>> }));
const core = vi.hoisted(() => ({
	refreshSessions: vi.fn(async () => {}),
	renderSessionList: vi.fn(),
	sessionListLoaded: vi.fn(() => true),
	runSessionAction: vi.fn(async (_s: unknown, _id: string) => {}),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("./api.js", () => api);
vi.mock("./main.js", () => mainMock);
vi.mock("./sessionCore.js", () => core);
vi.mock("./components/toast.js", () => toast);

type View = typeof import("./projectsView.js");
type Router = typeof import("./router.js");

const PID = "6b1f2c3d-0000-4000-8000-000000000001";
const AID = "a0000000-0000-4000-8000-0000000000a2";
const SID = "aaaaaaaa-1111-4111-8111-111111111111";
const FREE = "01d00000-0000-4000-8000-000000000099";
const NOW = "2026-11-10T14:02:45.000Z";

const ok = <T>(body: T, status = 200) => ({ ok: true as const, status, body });
const fail = (status: number, code: string) => ({ ok: false as const, status, code });

const projectsBody = () =>
	ok({
		projects: [{ projectId: PID, name: "Educación HZ", createdAt: NOW, agentCount: 1 }],
		can: { createProject: { allowed: true } },
	});

const agentsBody = () =>
	ok({
		projectId: PID,
		generatedAt: NOW,
		agents: [
			{
				agentId: AID,
				handle: "developer-hz",
				role: "Developer",
				provider: "claude-code",
				template: null,
				binding: { bindingId: "b2", epoch: 1, sessionId: SID, state: "active", createdAt: NOW },
				presence: { value: "waiting_input", source: "hook", at: NOW },
			},
		],
		can: { createAgent: { allowed: true } },
	});

function markup(): void {
	document.body.innerHTML = `
		<div id="app-view"><main>
			<aside id="sidebar">
				<section id="project-section" hidden>
					<button id="new-project-btn" type="button">+</button>
					<div id="project-list"></div>
				</section>
				<div id="session-list"><div class="session-item"><button class="session-select">s</button></div></div>
			</aside>
			<section id="terminal-area">
				<div id="terminal-toolbar"><button id="view-files-btn">Files</button></div>
				<div id="terminal-container"><textarea id="xterm-input"></textarea></div>
				<div id="project-view" hidden></div>
			</section>
		</main></div>`;
}

let view: View;
let router: Router;

async function load(): Promise<void> {
	vi.resetModules();
	markup();
	router = await import("./router.js");
	router.resetForTests();
	router.start();
	view = await import("./projectsView.js");
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
};

const pageEl = () => document.getElementById("project-view")!;
const dialogEl = () => document.querySelector<HTMLElement>(".modal.open .pv-dialog");

beforeEach(() => {
	// jsdom has no CSS.escape; the ids here need none.
	if (typeof globalThis.CSS === "undefined")
		vi.stubGlobal("CSS", { escape: (s: string) => s.replace(/["\\]/g, "\\$&") });
	history.replaceState(null, "", "/");
	for (const f of Object.values(api)) f.mockReset();
	api.projectChatEnabled.mockReturnValue(true);
	api.isLoggedIn.mockReturnValue(true);
	api.fetchProjects.mockImplementation(async () => projectsBody());
	api.fetchProjectAgents.mockImplementation(async () => agentsBody());
	mainMock.sessions.length = 0;
	mainMock.sessions.push(
		{ sessionId: SID, name: "my-project", status: "running", binding: null },
		{ sessionId: FREE, name: "scratch", status: "stopped", binding: null },
		{ sessionId: "t", name: "old", status: "terminated", binding: null },
		{ sessionId: "u", name: "unknown-row", status: "running" },
	);
	mainMock.sessions[0]!.binding = {
		projectId: PID,
		agentId: AID,
		handle: "developer-hz",
		bindingId: "b2",
		epoch: 1,
	};
	core.refreshSessions.mockClear();
	core.renderSessionList.mockClear();
	core.sessionListLoaded.mockReset();
	core.sessionListLoaded.mockReturnValue(true);
	core.runSessionAction.mockReset();
	core.runSessionAction.mockImplementation(async () => {});
	toast.showToast.mockClear();
	localStorage.clear();
});

afterEach(() => {
	view?.resetProjects();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("feature absent", () => {
	it("renders nothing, requests nothing, and a project link shows nothing", async () => {
		api.projectChatEnabled.mockReturnValue(false);
		await load();
		history.replaceState(null, "", `/#/projects/${PID}`);
		view.startProjects();
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		await flush();
		expect(document.getElementById("project-section")!.hidden).toBe(true);
		expect(pageEl().hidden).toBe(true);
		expect(api.fetchProjects).not.toHaveBeenCalled();
		expect(api.fetchProjectAgents).not.toHaveBeenCalled();
		expect(document.body.classList.contains("project-page-on")).toBe(false);
		expect(core.renderSessionList).not.toHaveBeenCalled();
	});
});

describe("sidebar and pages", () => {
	it("lists projects with counts; a project link opens its page over the session", async () => {
		await load();
		view.startProjects();
		await flush();
		const item = document.querySelector<HTMLAnchorElement>("#project-list .project-item")!;
		expect(item.textContent).toContain("Educación HZ");
		expect(item.textContent).toContain("1 agent");
		const input = document.getElementById("xterm-input") as HTMLTextAreaElement;
		input.focus();
		item.click();
		await flush();
		expect(window.location.hash).toBe(`#/projects/${PID}`);
		expect(pageEl().hidden).toBe(false);
		expect(document.body.classList.contains("project-page-on")).toBe(true);
		// The covered terminal does not keep the keyboard.
		expect(document.activeElement).not.toBe(input);
		expect(pageEl().querySelector(".pv-title")!.textContent).toBe("Educación HZ");
		expect(pageEl().querySelector(".pv-presence")!.textContent).toBe("Ready (unverified)");
		expect(pageEl().querySelector(".pv-session-link")!.textContent).toContain("my-project");
		expect(document.title).toBe("Educación HZ — Shared Terminal");
		expect(
			document.querySelector("#project-list .project-item")!.getAttribute("aria-current"),
		).toBe("page");
	});

	it("a session row clicked while a page is up leaves it for the session (Back returns)", async () => {
		await load();
		router.navigate({ sessionId: SID, view: "terminal", detail: null }, { replace: true });
		view.startProjects();
		router.navigateProject({ projectId: PID, agentId: null });
		await flush();
		expect(pageEl().hidden).toBe(false);
		// The session's own replace-writes do not swap the page away…
		router.navigate({ sessionId: SID, view: "terminal", detail: "tab-2" }, { replace: true });
		expect(window.location.hash).toBe(`#/projects/${PID}`);
		// …a click on its row does.
		document.querySelector<HTMLButtonElement>(".session-select")!.click();
		expect(pageEl().hidden).toBe(true);
		expect(window.location.hash).toBe(`#/sessions/${SID}/terminal/tab-2`);
		history.back();
		await new Promise((r) => setTimeout(r, 30));
		expect(pageEl().hidden).toBe(false);
	});

	it("agent page: removed state, history, no Remove; 404 says not found", async () => {
		api.fetchAgent.mockImplementation(async () =>
			ok({
				...agentsBody().body.agents[0],
				binding: null,
				projectId: PID,
				createdAt: NOW,
				removedAt: NOW,
				capabilities: { capture: true, channels: false, directControl: true },
				bindings: [
					{
						bindingId: "b2",
						epoch: 1,
						sessionId: SID,
						state: "retired",
						createdAt: NOW,
						retiredAt: NOW,
						retireReason: "agent-removed",
					},
				],
				presence: { value: "disconnected", detail: "agent-removed", source: "directory", at: NOW },
				can: { remove: { allowed: false, reason: "agent-removed" } },
			}),
		);
		await load();
		history.replaceState(null, "", `/#/projects/${PID}/agents/${AID}`);
		view.startProjects();
		await flush();
		expect(pageEl().querySelector(".pv-banner")!.textContent).toContain("stays reserved");
		expect(pageEl().querySelector(".pv-history tbody tr")!.textContent).toContain("agent removed");
		expect(
			[...pageEl().querySelectorAll("button")].some((b) => b.textContent === "Remove agent"),
		).toBe(false);
		api.fetchAgent.mockImplementation(async () => fail(404, "agent-not-found"));
		router.navigateProject({ projectId: PID, agentId: "zzz" });
		await flush();
		expect(pageEl().textContent).toContain("Agent not found");
	});
});

describe("one tap to the agent's session", () => {
	const detailBody = (over: Record<string, unknown> = {}) =>
		ok({
			...agentsBody().body.agents[0],
			projectId: PID,
			createdAt: NOW,
			removedAt: null,
			capabilities: { capture: true, channels: false, directControl: true },
			bindings: [{ ...agentsBody().body.agents[0]!.binding, retiredAt: null, retireReason: null }],
			can: { remove: { allowed: true } },
			...over,
		});
	const stopped = {
		value: "disconnected",
		detail: "session-stopped",
		source: "session",
		at: NOW,
	};
	const card = () => pageEl().querySelector<HTMLElement>(`.pv-agent[data-agent-id="${AID}"]`)!;
	const startBtn = (root: HTMLElement) =>
		[...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
			/^Start/.test(b.textContent ?? ""),
		);

	it("a card links to the session's Chat and Terminal, and to the last conversation this browser opened", async () => {
		const policy = await import("./viewPolicy.js");
		policy.writeLastConversation(SID, "c-42");
		policy.writeLastConversationTitle(SID, "c-42", "Fix the login");
		await load();
		history.replaceState(null, "", `/#/projects/${PID}`);
		view.startProjects();
		await flush();
		const c = card();
		expect(c.querySelector<HTMLAnchorElement>(".pv-open-chat")!.getAttribute("href")).toBe(
			`#/sessions/${SID}/chat`,
		);
		expect(c.querySelector<HTMLAnchorElement>(".pv-open-terminal")!.getAttribute("href")).toBe(
			`#/sessions/${SID}/terminal`,
		);
		const last = c.querySelector<HTMLAnchorElement>(".pv-last-conv")!;
		expect(last.textContent).toBe("↳ Fix the login");
		expect(last.getAttribute("href")).toBe(`#/sessions/${SID}/chat/c-42`);
		// A running session: nothing to start.
		expect(startBtn(c)).toBeUndefined();
	});

	it("no last-conversation link without a remembered title; none for an unbound agent", async () => {
		api.fetchProjectAgents.mockImplementation(async () => {
			const b = agentsBody();
			b.body.agents.push({
				...b.body.agents[0]!,
				agentId: "a-free",
				handle: "loose",
				binding: null as never,
			});
			return b;
		});
		await load();
		history.replaceState(null, "", `/#/projects/${PID}`);
		view.startProjects();
		await flush();
		expect(card().querySelector(".pv-last-conv")).toBeNull();
		const loose = pageEl().querySelector<HTMLElement>('.pv-agent[data-agent-id="a-free"]')!;
		expect(loose.querySelector(".pv-session-actions")).toBeNull();
	});

	it("agent page: Chat and Terminal replace the duplicate workbench link", async () => {
		api.fetchAgent.mockImplementation(async () => detailBody());
		await load();
		history.replaceState(null, "", `/#/projects/${PID}/agents/${AID}`);
		view.startProjects();
		await flush();
		const row = pageEl().querySelector<HTMLElement>(".pv-session-row")!;
		expect(row.querySelectorAll(".pv-session-link")).toHaveLength(1);
		expect([...row.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
			expect.stringContaining("my-project"),
			"Chat",
			"Terminal",
		]);
		expect(pageEl().textContent).not.toContain("Open the workbench");
	});

	it("session-stopped: one Start button, disabled while in flight, the sidebar's verb; never automatic", async () => {
		mainMock.sessions[0]!.status = "stopped";
		api.fetchAgent.mockImplementation(async () => detailBody({ presence: stopped }));
		await load();
		history.replaceState(null, "", `/#/projects/${PID}/agents/${AID}`);
		view.startProjects();
		await flush();
		expect(core.runSessionAction).not.toHaveBeenCalled();
		let release: () => void = () => {};
		core.runSessionAction.mockImplementation(() => new Promise<void>((r) => (release = () => r())));
		const fetches = api.fetchAgent.mock.calls.length;
		startBtn(pageEl())!.click();
		await flush();
		const busy = startBtn(pageEl())!;
		expect(busy.disabled).toBe(true);
		expect(busy.textContent).toBe("Starting…");
		busy.click();
		expect(core.runSessionAction).toHaveBeenCalledTimes(1);
		expect(core.runSessionAction.mock.calls[0]![0]).toBe(mainMock.sessions[0]);
		expect(core.runSessionAction.mock.calls[0]![1]).toBe("start");
		// The session is running now; the presence follows on the re-read.
		mainMock.sessions[0]!.status = "running";
		api.fetchAgent.mockImplementation(async () => detailBody());
		release();
		await flush();
		expect(api.fetchAgent.mock.calls.length).toBeGreaterThan(fetches);
		expect(startBtn(pageEl())).toBeUndefined();
	});

	it("no Start for any other disconnected detail, nor when the row says it isn't stopped", async () => {
		mainMock.sessions[0]!.status = "stopped";
		api.fetchProjectAgents.mockImplementation(async () => {
			const b = agentsBody();
			b.body.agents[0]!.presence = {
				value: "disconnected",
				detail: "session-terminated",
				source: "session",
				at: NOW,
			} as never;
			return b;
		});
		await load();
		history.replaceState(null, "", `/#/projects/${PID}`);
		view.startProjects();
		await flush();
		expect(startBtn(card())).toBeUndefined();
		api.fetchProjectAgents.mockImplementation(async () => {
			const b = agentsBody();
			b.body.agents[0]!.presence = stopped as never;
			return b;
		});
		mainMock.sessions[0]!.status = "running";
		view.resetProjects();
		view.startProjects();
		await flush();
		expect(startBtn(card())).toBeUndefined();
		mainMock.sessions[0]!.status = "stopped";
		view.resetProjects();
		view.startProjects();
		await flush();
		expect(startBtn(card())!.textContent).toBe("Start session");
	});
});

describe("dead ends", () => {
	const emptyAgents = (allowed: boolean) =>
		ok({
			projectId: PID,
			generatedAt: NOW,
			agents: [],
			can: { createAgent: allowed ? { allowed: true } : { allowed: false, reason: "agent-limit" } },
		});

	it("empty project: + New agent in the empty state and the unassigned count", async () => {
		api.fetchProjectAgents.mockImplementation(async () => emptyAgents(true));
		await load();
		history.replaceState(null, "", `/#/projects/${PID}`);
		view.startProjects();
		await flush();
		const box = pageEl().querySelector<HTMLElement>(".files-state-empty")!;
		expect(box.textContent).toContain("You have 1 unassigned session.");
		const add = [...box.querySelectorAll("button")].find((b) => b.textContent === "+ New agent")!;
		add.click();
		expect(dialogEl()).not.toBeNull();
	});

	it("empty project: no button when creation is refused; no count when bindings are unknown", async () => {
		api.fetchProjectAgents.mockImplementation(async () => emptyAgents(false));
		for (const s of mainMock.sessions) delete s.binding;
		await load();
		history.replaceState(null, "", `/#/projects/${PID}`);
		view.startProjects();
		await flush();
		const box = pageEl().querySelector<HTMLElement>(".files-state-empty")!;
		expect(box.querySelector("button")).toBeNull();
		expect(box.textContent).not.toMatch(/unassigned session\b/);
		expect(box.querySelector(".pv-free-count")).toBeNull();
	});

	it("agent not found: a sentence and Back to the project", async () => {
		api.fetchAgent.mockImplementation(async () => fail(404, "agent-not-found"));
		await load();
		history.replaceState(null, "", `/#/projects/${PID}/agents/zzz`);
		view.startProjects();
		await flush();
		expect(pageEl().querySelector(".pv-title")!.textContent).toBe("Agent not found");
		expect(pageEl().textContent).toContain("There is no such agent in Educación HZ");
		expect(pageEl().textContent).not.toContain("Not found.");
		const back = [...pageEl().querySelectorAll("button")].find(
			(b) => b.textContent === "Back to Educación HZ",
		)!;
		back.click();
		await flush();
		expect(window.location.hash).toBe(`#/projects/${PID}`);
		expect(pageEl().querySelector(".pv-title")!.textContent).toBe("Educación HZ");
	});

	it("project not found: a sentence and Back to Projects (the sidebar list)", async () => {
		api.fetchProjectAgents.mockImplementation(async () => fail(404, "project-not-found"));
		await load();
		history.replaceState(null, "", "/#/projects/nope");
		view.startProjects();
		await flush();
		expect(pageEl().querySelector(".pv-title")!.textContent).toBe("Project not found");
		expect(pageEl().textContent).toContain("doesn't exist or isn't yours");
		[...pageEl().querySelectorAll("button")]
			.find((b) => b.textContent === "Back to Projects")!
			.click();
		await flush();
		expect(pageEl().hidden).toBe(true);
		expect(document.activeElement).toBe(document.querySelector("#project-list .project-item"));
		history.back();
		await new Promise((r) => setTimeout(r, 30));
		expect(pageEl().hidden).toBe(false);
	});
});

describe("sidebar rows name their project as soon as the list arrives", () => {
	it("the first list re-renders the loaded session rows; before they load, nothing", async () => {
		await load();
		view.startProjects();
		await flush();
		expect(core.renderSessionList).toHaveBeenCalledTimes(1);
		view.resetProjects();
		core.renderSessionList.mockClear();
		core.sessionListLoaded.mockReturnValue(false);
		view.startProjects();
		await flush();
		expect(api.fetchProjects).toHaveBeenCalledTimes(2);
		expect(core.renderSessionList).not.toHaveBeenCalled();
	});

	it("setProjects reports a change only when a name the rows show changed", async () => {
		const dir = await import("./projectDirectory.js");
		dir.clearProjects();
		const p = (name: string, agentCount = 1) => ({
			projectId: PID,
			name,
			createdAt: NOW,
			agentCount,
		});
		expect(dir.setProjects([p("A")])).toBe(true);
		expect(dir.setProjects([p("A", 2)])).toBe(false);
		expect(dir.setProjects([p("B", 2)])).toBe(true);
		expect(dir.setProjects([])).toBe(true);
		expect(dir.setProjects([])).toBe(false);
		dir.clearProjects();
		expect(dir.setProjects([])).toBe(true);
	});
});

describe("create agent (rule 4)", () => {
	async function openDialog(): Promise<HTMLElement> {
		await load();
		history.replaceState(null, "", `/#/projects/${PID}`);
		view.startProjects();
		await flush();
		const btn = [...pageEl().querySelectorAll("button")].find(
			(b) => b.textContent === "+ New agent",
		)!;
		btn.click();
		return dialogEl()!;
	}

	const submit = (d: HTMLElement) =>
		d.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));

	it("offers only known-unassigned, non-terminated sessions", async () => {
		const d = await openDialog();
		const options = [...d.querySelectorAll("option")].map((o) => o.value);
		expect(options).toEqual([FREE]);
	});

	it("503 → frozen inputs + Retry with the SAME id → replayed is success", async () => {
		const d = await openDialog();
		const inputs = d.querySelectorAll("input");
		inputs[0]!.value = "tester";
		api.createAgent
			.mockResolvedValueOnce(fail(503, "outcome-unknown"))
			.mockResolvedValueOnce(ok({ agentId: "a9", handle: "tester", replayed: true }, 201));
		submit(d);
		await flush();
		expect(d.querySelector(".pv-dialog-status")!.textContent).toMatch(/could not be confirmed/);
		expect(inputs[0]!.disabled).toBe(true);
		const btn = d.querySelector<HTMLButtonElement>("button[type=submit]")!;
		expect(btn.textContent).toBe("Retry");
		expect(api.createAgent).toHaveBeenCalledTimes(1);
		inputs[0]!.value = "edited-meanwhile";
		submit(d);
		await flush();
		expect(api.createAgent).toHaveBeenCalledTimes(2);
		const [first, second] = api.createAgent.mock.calls;
		expect(second![2]).toBe(first![2]);
		expect(second![1]).toEqual(first![1]);
		expect(first![1]).toEqual({ handle: "tester", role: null, sessionId: FREE });
		expect(dialogEl()).toBeNull();
		expect(toast.showToast).toHaveBeenCalledWith("@tester was already created");
	});

	it("a refusal after a 503 re-reads the agent list BEFORE showing the error", async () => {
		const d = await openDialog();
		d.querySelectorAll("input")[0]!.value = "tester";
		api.createAgent
			.mockResolvedValueOnce(fail(503, "outcome-unknown"))
			.mockResolvedValueOnce(fail(409, "session-taken"));
		submit(d);
		await flush();
		const order: string[] = [];
		api.fetchProjectAgents.mockImplementation(async () => {
			order.push(`reload (status: ${d.querySelector(".pv-dialog-status")!.textContent})`);
			return agentsBody();
		});
		submit(d);
		await flush();
		expect(order[0]).toBe("reload (status: Checking what happened…)");
		expect(d.querySelector(".pv-dialog-status")!.textContent).toBe(
			"That session already belongs to another agent.",
		);
		expect(core.refreshSessions).toHaveBeenCalled();
		// A new action gets a new id.
		api.createAgent.mockResolvedValueOnce(fail(409, "handle-taken"));
		submit(d);
		await flush();
		const ids = api.createAgent.mock.calls.map((c) => c[2]);
		expect(ids[1]).toBe(ids[0]);
		expect(ids[2]).not.toBe(ids[0]);
		expect(d.querySelector(".pv-dialog-status")!.textContent).toMatch(/stay reserved/);
	});

	it("closing after an unknown outcome reloads instead of retrying", async () => {
		const d = await openDialog();
		d.querySelectorAll("input")[0]!.value = "tester";
		api.createAgent.mockResolvedValueOnce(fail(0, "network"));
		submit(d);
		await flush();
		const calls = api.fetchProjectAgents.mock.calls.length;
		d.querySelector<HTMLButtonElement>(".dialog-cancel")!.click();
		await flush();
		expect(dialogEl()).toBeNull();
		expect(api.createAgent).toHaveBeenCalledTimes(1);
		expect(api.fetchProjectAgents.mock.calls.length).toBeGreaterThan(calls);
	});
});

describe("polling (rule 9)", () => {
	// flush() waits on a real setTimeout, which the fake clock below stops;
	// settle microtasks through the fake clock instead.
	const settle = () => vi.advanceTimersByTimeAsync(0);
	const agentsWith = (value: "working" | "waiting_input" | "needs_attention") => () => {
		const r = agentsBody();
		r.body.agents[0]!.presence.value = value;
		return r;
	};
	const start = async (body: () => ReturnType<typeof agentsBody>) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		api.fetchProjectAgents.mockImplementation(async () => body());
		history.replaceState(null, "", `/#/projects/${PID}`);
		await load();
		view.startProjects();
		await settle();
		return api.fetchProjectAgents.mock.calls.length;
	};

	it("every 5 s while an agent is working; one request in flight; hidden tab and no page: nothing", async () => {
		const base = await start(agentsWith("working"));
		let release: () => void = () => {};
		api.fetchProjectAgents.mockImplementation(
			() => new Promise((r) => (release = () => r(agentsWith("working")()))),
		);
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 1);
		release();
		await settle();
		api.fetchProjectAgents.mockImplementation(async () => agentsWith("working")());
		await vi.advanceTimersByTimeAsync(5_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 2);
		// Hidden tab: nothing.
		const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 2);
		hidden.mockRestore();
		// No page shown: nothing for the page.
		router.navigate({ sessionId: SID, view: null, detail: null });
		await settle();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 2);
	});

	it("every 5 s while an agent needs attention", async () => {
		const base = await start(agentsWith("needs_attention"));
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 2);
	});

	it("every 15 s when all agents are at rest, and 5 s again once one starts working", async () => {
		const base = await start(agentsWith("waiting_input"));
		await vi.advanceTimersByTimeAsync(14_999);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base);
		await vi.advanceTimersByTimeAsync(1);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 1);
		api.fetchProjectAgents.mockImplementation(async () => agentsWith("working")());
		await vi.advanceTimersByTimeAsync(15_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 2);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 3);
	});

	it("refreshes at once on returning to the tab", async () => {
		const base = await start(agentsWith("waiting_input"));
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 1);
	});

	it("refreshes the project list by elapsed time (60 s), not by tick count", async () => {
		await start(agentsWith("waiting_input"));
		const base = api.fetchProjects.mock.calls.length;
		await vi.advanceTimersByTimeAsync(45_000); // three idle ticks
		expect(api.fetchProjects.mock.calls.length).toBe(base);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(api.fetchProjects.mock.calls.length).toBe(base + 1);
	});

	it.each([
		"working",
		"waiting_input",
	] as const)("leaves no timer running after a logout (%s)", async (value) => {
		await start(agentsWith(value));
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		view.resetProjects();
		expect(vi.getTimerCount()).toBe(0);
		const calls = api.fetchProjectAgents.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(calls);
	});

	describe("a single agent's page paces itself on that agent's own presence", () => {
		const detailWith = (value: "working" | "waiting_input") => () => {
			const a = agentsBody().body.agents[0]!;
			return ok({
				...a,
				presence: { ...a.presence, value },
				projectId: PID,
				createdAt: NOW,
				removedAt: null,
				capabilities: { capture: true, channels: false, directControl: true },
				bindings: [{ ...a.binding, retiredAt: null, retireReason: null }],
				can: { remove: { allowed: true } },
			});
		};
		// The list and the detail deliberately disagree: only the detail is
		// re-read on this page, so only it may set the pace.
		const startAgentPage = async (
			list: "working" | "waiting_input",
			detail: () => ReturnType<ReturnType<typeof detailWith>>,
		) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			api.fetchProjectAgents.mockImplementation(async () => agentsWith(list)());
			api.fetchAgent.mockImplementation(async () => detail());
			history.replaceState(null, "", `/#/projects/${PID}/agents/${AID}`);
			await load();
			view.startProjects();
			await settle();
			return api.fetchAgent.mock.calls.length;
		};

		it("every 5 s while that agent works, even if the list says rest", async () => {
			const base = await startAgentPage("waiting_input", detailWith("working"));
			await vi.advanceTimersByTimeAsync(5_000);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(api.fetchAgent.mock.calls.length).toBe(base + 2);
		});

		it("every 15 s while that agent rests, even if the list says working", async () => {
			const base = await startAgentPage("working", detailWith("waiting_input"));
			await vi.advanceTimersByTimeAsync(14_999);
			expect(api.fetchAgent.mock.calls.length).toBe(base);
			await vi.advanceTimersByTimeAsync(1);
			expect(api.fetchAgent.mock.calls.length).toBe(base + 1);
		});

		it("speeds up to 5 s once the re-read detail shows the agent working", async () => {
			const base = await startAgentPage("waiting_input", detailWith("waiting_input"));
			api.fetchAgent.mockImplementation(async () => detailWith("working")());
			await vi.advanceTimersByTimeAsync(15_000);
			expect(api.fetchAgent.mock.calls.length).toBe(base + 1);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(api.fetchAgent.mock.calls.length).toBe(base + 2);
		});
	});

	it("polls every 15 s, not 5, when no page is shown", async () => {
		await start(agentsWith("working"));
		router.navigate({ sessionId: SID, view: null, detail: null });
		await settle();
		const base = api.fetchProjects.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(45_000);
		expect(api.fetchProjects.mock.calls.length).toBe(base + 1);
	});

	it("an answer landing after a logout is not applied", async () => {
		await load();
		view.startProjects();
		let release: () => void = () => {};
		api.fetchProjects.mockImplementation(
			() => new Promise((r) => (release = () => r(projectsBody()))),
		);
		await flush();
		view.resetProjects();
		release();
		await flush();
		expect(document.querySelector("#project-list .project-item")).toBeNull();
	});
});
