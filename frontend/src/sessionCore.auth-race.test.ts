/**
 * sessionCore.auth-race.test.ts — hypotheses A and D, sessionCore under
 * jsdom with main.ts / api.ts mocked (the chatView.test.ts style):
 *
 *   A. a `refreshSessions()` that answers after logout, or after another
 *      account's list already landed, must not render the old account's
 *      sessions;
 *   D. a deep link on a load whose first GET /sessions FAILS must not be
 *      concluded "Session not found" and cleared from the address.
 *
 * Controlled promises only — no timers, no sleeps.
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
	isLoggedIn: vi.fn(() => true),
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
type Router = typeof import("./router.js");
let core: Core;
let vs: ViewSwitch;
let router: Router;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const names = () =>
	[...$("session-list").querySelectorAll(".session-name")].map((n) => n.textContent);

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

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
	router = await import("./router.js");
	core = await import("./sessionCore.js");
});

beforeEach(() => {
	localStorage.clear();
	history.replaceState(null, "", "/");
	router.resetForTests();
	document.documentElement.dataset.shell = "v1";
	mainState.sessions = [];
	mainState.activeSessionId = null;
	mainState.currentTabs = [];
	mainState.currentActiveTabId = null;
	mainState.currentTerminals.clear();
	mainState.showToast.mockClear();
	api.listSessions.mockReset();
	api.listTabs.mockReset();
	api.fetchConversations.mockReset();
	api.isLoggedIn.mockReset().mockReturnValue(true);
	// What main.ts handleLogout() does between accounts: every list request
	// in flight is retired and "the list has loaded" is forgotten.
	core.invalidateSessionList();
	core.renderSessionList();
	core.updateToolbar();
});
afterEach(() => {
	mainState.activeSessionId = null;
	mainState.sessions = [];
	vs.syncSessionViews();
	vs.setView("terminal");
});

describe("A: refreshSessions across logout / another login", () => {
	it("a session list that answers after logout is not rendered", async () => {
		const held = deferred<Sess[]>();
		api.listSessions.mockReturnValueOnce(held.promise);
		const pending = core.refreshSessions();

		// main.ts handleLogout(): auth mirror off, list emptied and re-rendered.
		api.isLoggedIn.mockReturnValue(false);
		mainState.sessions = [];
		core.renderSessionList();
		expect(names()).toEqual([]);

		// Account A's answer lands now, behind the login view.
		held.resolve([{ sessionId: "a1", name: "alice-project", status: "running" }]);
		await pending;

		expect(names(), "the previous account's rows were rendered after logout").toEqual([]);
		expect(mainState.sessions).toEqual([]);
	});

	it("account A's late list answer does not replace account B's list", async () => {
		const heldA = deferred<Sess[]>();
		api.listSessions.mockReturnValueOnce(heldA.promise);
		const pendingA = core.refreshSessions();

		// Logout, then B logs in: showApp() → refreshSessions() for B lands first.
		mainState.sessions = [];
		core.renderSessionList();
		api.listSessions.mockResolvedValueOnce([
			{ sessionId: "b1", name: "bob-api", status: "running" },
		]);
		await core.refreshSessions();
		expect(names()).toEqual(["bob-api"]);

		// A's answer (sent with A's cookie, before the logout) lands last.
		heldA.resolve([{ sessionId: "a1", name: "alice-project", status: "running" }]);
		await pendingA;

		expect(names(), "account A's sessions shown in account B's sidebar").toEqual(["bob-api"]);
		expect(mainState.sessions.map((s) => s.sessionId)).toEqual(["b1"]);
	});
});

describe("D: deep link while the first session list fails", () => {
	it("keeps the address and does not report 'Session not found' when the list never loaded", async () => {
		const hash = "#/sessions/s1/files";
		history.replaceState(null, "", `/${hash}`);
		api.listSessions.mockRejectedValueOnce(new Error("Failed to list sessions"));

		// main.ts showApp(): refreshSessions().then(() => applyRoute(readRoute()))
		await core.refreshSessions();
		expect(mainState.showToast).toHaveBeenCalledWith("Failed to list sessions", true);
		await core.applyRoute(router.readRoute());

		expect(
			window.location.hash,
			"a valid deep link was cleared because the list failed to load",
		).toBe(hash);
		expect(mainState.showToast).not.toHaveBeenCalledWith("Session not found", true);
	});
});
