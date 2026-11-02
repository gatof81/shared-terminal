/**
 * sessionCore.landing-race.test.ts — hypotheses C and E (shell v2 landing
 * policy), sessionCore + viewSwitch under jsdom with main.ts / api.ts
 * mocked. Controlled promises only.
 *
 *   C. a click on the already-active Terminal tab while `decideLanding`
 *      is pending must count as the person's choice;
 *   E. two overlapping `openSession()` calls share one `landingPending`
 *      boolean: the first's late `endLanding()` clears the second's
 *      pending landing (false too early), and a first open abandoned at
 *      the identity check never ends its landing (stuck true).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface Sess {
	sessionId: string;
	name: string;
	status: string;
}
interface Tab {
	tabId: string;
	label: string;
	createdAt: number;
}

const mainState = vi.hoisted(() => ({
	sessions: [] as Sess[],
	activeSessionId: null as string | null,
	currentTabs: [] as Tab[],
	currentActiveTabId: null as string | null,
	currentTerminals: new Map<string, unknown>(),
	closingTabs: new Set<string>(),
	showToast: vi.fn(),
}));
vi.mock("./main.js", () => ({
	get sessions() {
		return mainState.sessions;
	},
	get activeSessionId() {
		return mainState.activeSessionId;
	},
	get currentTabs() {
		return mainState.currentTabs;
	},
	get currentActiveTabId() {
		return mainState.currentActiveTabId;
	},
	get currentTerminals() {
		return mainState.currentTerminals;
	},
	get closingTabs() {
		return mainState.closingTabs;
	},
	setSessions: (v: Sess[]) => {
		mainState.sessions = v;
	},
	setActiveSessionId: (v: string | null) => {
		mainState.activeSessionId = v;
	},
	setCurrentTabs: (v: Tab[]) => {
		mainState.currentTabs = v;
	},
	setCurrentActiveTabId: (v: string | null) => {
		mainState.currentActiveTabId = v;
	},
	disposeAllCurrentTerminals: () => {
		mainState.currentTerminals.clear();
		mainState.currentTabs = [];
		mainState.currentActiveTabId = null;
	},
	getActiveTerminal: () => null,
	isMobile: () => false,
	maybeInjectSelectionHint: vi.fn(),
	setChromeOpen: vi.fn(),
	showCopySuccessToast: vi.fn(),
	showToast: mainState.showToast,
	updateChromeToggle: vi.fn(),
}));

const api = vi.hoisted(() => ({
	listSessions: vi.fn(),
	listTabs: vi.fn(),
	fetchConversations: vi.fn(),
	getSession: vi.fn(),
	fetchAdminSessions: vi.fn(),
	createTab: vi.fn(),
	deleteTab: vi.fn(),
	deleteSession: vi.fn(),
	startSession: vi.fn(),
	stopSession: vi.fn(),
	isAdmin: () => false,
	isLead: () => false,
	isLoggedIn: () => true,
	TabNotFoundError: class extends Error {},
}));
vi.mock("./api.js", () => api);
vi.mock("./admin.js", () => ({ openObserversModalFor: vi.fn() }));
vi.mock("./components/actionMenu.js", () => ({ openActionMenu: vi.fn() }));
vi.mock("./components/dialog.js", () => ({ confirmDialog: vi.fn() }));
vi.mock("./keyBar.js", () => ({ transformKeyInput: (s: string) => s }));
vi.mock("./myGroups.js", () => ({ renderSidebarObservables: vi.fn() }));
vi.mock("./newSession.js", () => ({ openBootstrapLogModal: vi.fn() }));
vi.mock("./observeModal.js", () => ({ openObserveModalFor: vi.fn() }));
vi.mock("./ports.js", () => ({ openPortsModalFor: vi.fn() }));
vi.mock("./terminal.js", () => ({ openTerminalSession: vi.fn() }));

type Core = typeof import("./sessionCore.js");
type ViewSwitch = typeof import("./viewSwitch.js");
let core: Core;
let vs: ViewSwitch;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const withHistory = { capture: null, conversations: [{ sessionId: "c1" }] };
const noHistory = { capture: null, conversations: [] };

beforeAll(async () => {
	document.body.innerHTML = `
		<aside id="sidebar">
			<input id="show-terminated-toggle" type="checkbox" />
			<div id="session-list"></div>
		</aside>
		<section id="terminal-area">
			<div id="terminal-toolbar">
				<span id="terminal-session-name"></span><span id="terminal-status-badge"></span>
				<button id="font-size-btn"></button>
				<input id="terminal-search-input" /><button id="terminal-search-btn"></button>
				<div id="view-switch" hidden>
					<button id="view-terminal-btn"></button><button id="view-files-btn"></button>
					<button id="view-git-btn"></button><button id="view-chat-btn"></button>
				</div>
			</div>
			<div id="empty-state"></div>
			<div id="terminal-state" hidden></div>
			<div id="terminal-tabs"><div id="tab-strip"></div></div>
			<div id="terminal-container"></div>
			<div id="key-bar"></div>
			<div id="files-view" hidden></div><div id="git-view" hidden></div><div id="chat-view" hidden></div>
			<nav id="view-nav" hidden></nav>
		</section>`;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vs = await import("./viewSwitch.js");
	core = await import("./sessionCore.js");
});

beforeEach(() => {
	localStorage.clear();
	history.replaceState(null, "", "/");
	// Shell v2: the landing policy (viewPolicy.ts) is in force.
	document.documentElement.dataset.shell = "v2";
	mainState.sessions = [];
	mainState.activeSessionId = null;
	mainState.currentTabs = [];
	mainState.currentActiveTabId = null;
	mainState.currentTerminals.clear();
	mainState.showToast.mockClear();
	api.listTabs.mockReset();
	api.fetchConversations.mockReset();
	core.renderSessionList();
	core.updateToolbar();
	vs.setView("terminal");
});
afterEach(() => {
	mainState.activeSessionId = null;
	mainState.sessions = [];
	vs.syncSessionViews();
	vs.setView("terminal");
});

describe("C: the already-active Terminal tab clicked while the landing is deciding", () => {
	it("counts as the person's choice: the landing must not move them to Chat afterwards", async () => {
		mainState.sessions = [{ sessionId: "s1", name: "s1", status: "running" }];
		const history = deferred<typeof withHistory>();
		const tabs = deferred<Tab[]>();
		api.fetchConversations.mockReturnValueOnce(history.promise);
		api.listTabs.mockReturnValueOnce(tabs.promise);

		const open = core.openSession("s1");
		await flush();
		expect(vs.getView()).toBe("terminal");
		expect(api.fetchConversations).toHaveBeenCalledWith("s1", { capture: false });

		// The person confirms "Terminal" (the tab already pressed) while the
		// "has history" answer is still on its way.
		$("view-terminal-btn").click();

		history.resolve(withHistory);
		tabs.resolve([]);
		await open;
		await flush();

		expect(vs.getView(), "the landing moved the person off the Terminal they just confirmed").toBe(
			"terminal",
		);
		expect(
			localStorage.getItem("st.view.s1"),
			"the click on the active tab was not remembered as the person's choice",
		).toBe("terminal");
	});
});

describe("E: overlapping openSession() calls share one landingPending flag", () => {
	it("false too early: the first open's late endLanding() lets a fallback land while the second is still deciding", async () => {
		mainState.sessions = [
			{ sessionId: "s1", name: "s1", status: "stopped" },
			{ sessionId: "s2", name: "s2", status: "stopped" },
		];
		const h1 = deferred<typeof noHistory>();
		const h2 = deferred<typeof withHistory>();
		api.fetchConversations.mockImplementation((sid: string) =>
			sid === "s1" ? h1.promise : h2.promise,
		);
		const landed: string[] = [];
		vs.onViewChange((next) => landed.push(next));

		const open1 = core.openSession("s1");
		await flush();
		const open2 = core.openSession("s2");
		await flush();
		expect(vs.getView(), "both landings pending: nothing landed yet").toBe("terminal");

		// s1's answer arrives after the switch: its continuation does nothing
		// for the screen, but ends the (shared) landing.
		h1.resolve(noHistory);
		await open1;
		await flush();

		// Any toolbar sync in this window (a status change, a tab event) …
		core.updateToolbar();
		expect(
			vs.getView(),
			"s2's landing is still pending, yet the sync landed its own fallback",
		).toBe("terminal");

		h2.resolve(withHistory);
		await open2;
		await flush();
		expect(vs.getView()).toBe("chat");
		expect(landed, "the person saw two views").toEqual(["chat"]);
	});

	it("stuck true: a first open abandoned at the identity check never ends its landing, so the sync never lands fallbacks", async () => {
		mainState.sessions = [
			{ sessionId: "s1", name: "s1", status: "running" },
			{ sessionId: "s2", name: "s2", status: "stopped" },
		];
		const h1 = deferred<typeof noHistory>();
		const t1 = deferred<Tab[]>();
		api.fetchConversations.mockReturnValueOnce(h1.promise);
		api.listTabs.mockReturnValueOnce(t1.promise);

		const open1 = core.openSession("s1");
		await flush();
		// A route with an explicit view selects s2 (applyRoute: openSession
		// with `view`, then applyRouteView) — no landing of its own.
		await core.openSession("s2", { view: "terminal" });
		vs.applyRouteView("terminal", null);
		await flush();
		expect(vs.getView()).toBe("terminal");

		// s1's tabs and history land after the switch: openSession(s1)
		// returns at `activeSessionId !== sessionId` without endLanding().
		t1.resolve([]);
		h1.resolve(noHistory);
		await open1;
		await flush();

		// s2 is stopped and on Terminal: the sync's designed fallback
		// (viewSwitch.ts syncSessionViews → landView(files, forced)) must run.
		core.updateToolbar();
		expect(
			vs.getView(),
			"landingPending is stuck true: syncSessionViews returns before its fallback",
		).toBe("files");
	});
});
