import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// projectsView.ts against a fake api (P3a). The module reads its DOM at
// import, so each test builds the markup first and imports a fresh copy.

const api = vi.hoisted(() => ({
	projectChatEnabled: vi.fn(() => true),
	isLoggedIn: vi.fn(() => true),
	fetchProjects: vi.fn(),
	fetchProjectAgents: vi.fn(),
	fetchAgent: vi.fn(),
	createProject: vi.fn(),
	createAgent: vi.fn(),
	removeAgent: vi.fn(),
}));
const mainMock = vi.hoisted(() => ({ sessions: [] as Array<Record<string, unknown>> }));
const core = vi.hoisted(() => ({ refreshSessions: vi.fn(async () => {}) }));
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
	toast.showToast.mockClear();
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
	it("≤ every 5 s while a page is shown and the tab visible; one request in flight", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		await load();
		history.replaceState(null, "", `/#/projects/${PID}`);
		view.startProjects();
		await flush();
		const base = api.fetchProjectAgents.mock.calls.length;
		let release: () => void = () => {};
		api.fetchProjectAgents.mockImplementation(
			() => new Promise((r) => (release = () => r(agentsBody()))),
		);
		vi.advanceTimersByTime(5_000);
		vi.advanceTimersByTime(5_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 1);
		release();
		await flush();
		vi.advanceTimersByTime(5_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 2);
		release();
		await flush();
		// Hidden tab: nothing.
		const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		vi.advanceTimersByTime(15_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 2);
		hidden.mockRestore();
		// No page shown: nothing for the page.
		router.navigate({ sessionId: SID, view: null, detail: null });
		await flush();
		vi.advanceTimersByTime(5_000);
		expect(api.fetchProjectAgents.mock.calls.length).toBe(base + 2);
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
