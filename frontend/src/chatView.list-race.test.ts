/**
 * chatView.list-race.test.ts — hypothesis F: two `fetchConversations`
 * requests for the SAME session in flight (refresh click + poll, or two
 * refresh clicks) answering out of order. `loadList` guards only on the
 * per-session `generation`, so an older answer can overwrite a newer list
 * and leave `writeHistoryHint` with a stale value. Controlled promises.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mainState = vi.hoisted(() => ({
	activeSessionId: null as string | null,
	sessions: [] as { sessionId: string; name: string; status: string }[],
	currentTerminals: new Map<string, unknown>(),
	mobile: false,
	showToast: vi.fn(),
	showCopySuccessToast: vi.fn(),
	setChromeOpen: vi.fn(),
}));
vi.mock("./main.js", () => ({
	get activeSessionId() {
		return mainState.activeSessionId;
	},
	get sessions() {
		return mainState.sessions;
	},
	get currentTerminals() {
		return mainState.currentTerminals;
	},
	getActiveTerminal: () => ({ focus: vi.fn() }),
	isMobile: () => mainState.mobile,
	setChromeOpen: mainState.setChromeOpen,
	showToast: mainState.showToast,
	showCopySuccessToast: mainState.showCopySuccessToast,
	updateChromeToggle: vi.fn(),
}));

const api = vi.hoisted(() => ({
	fetchConversations: vi.fn(),
	fetchConversationEvents: vi.fn(),
	sendConversationMessage: vi.fn(),
	openConversationSocket: vi.fn(() => ({ follow: vi.fn(), close: vi.fn() })),
}));
vi.mock("./api.js", () => api);
vi.mock("./sessionCore.js", () => ({ refreshSessions: vi.fn(async () => {}) }));

type ViewSwitch = typeof import("./viewSwitch.js");
let vs: ViewSwitch;

const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const capture = { requested: true, effective: true, effectiveAfterRestart: true };
const conv = (over: Record<string, unknown> = {}) => ({
	sessionId: "c1",
	kind: "interactive",
	title: "Fix the build",
	status: "waiting_input",
	statusEvidence: "hook:Stop",
	statusAt: new Date().toISOString(),
	tabId: null,
	startedAt: new Date().toISOString(),
	endedAt: null,
	lastEventAt: new Date().toISOString(),
	lastSeq: 10,
	firstRetainedSeq: 1,
	eventsCount: 10,
	gapsCount: 0,
	claudeVersion: "2.1.308",
	canSendInput: false,
	...over,
});

beforeAll(async () => {
	document.body.innerHTML = `
		<section id="terminal-area">
			<div id="terminal-toolbar">
				<button id="font-size-btn"></button>
				<input id="terminal-search-input" />
				<button id="terminal-search-btn"></button>
				<div id="view-switch" hidden>
					<button id="view-terminal-btn"></button>
					<button id="view-files-btn"></button>
					<button id="view-git-btn"></button>
					<button id="view-chat-btn"></button>
				</div>
			</div>
			<div id="terminal-tabs"></div>
			<div id="terminal-container" style="display: block"><div class="tab-pane active"><textarea id="xterm-input"></textarea></div></div>
			<div id="key-bar"></div>
			<div id="files-view" hidden><button id="files-to-terminal-btn"></button></div>
			<div id="git-view" hidden>
				<button id="git-to-terminal-btn"></button>
				<div id="git-summary"></div>
				<button id="git-refresh-btn"></button>
				<div id="git-body"><div id="git-list"></div><div id="git-diff"></div></div>
			</div>
			<div id="chat-view" hidden>
				<button id="chat-to-terminal-btn"></button>
				<button id="chat-back-btn" hidden></button>
				<div id="chat-summary"></div>
				<button id="chat-refresh-btn"></button>
				<div id="chat-body">
					<div id="chat-list"></div>
					<div id="chat-thread"></div>
					<aside id="chat-agents" hidden></aside>
				</div>
				<div id="chat-announcer"></div>
			</div>
			<nav id="view-nav" hidden>
				<button data-view="chat"></button>
				<button data-view="terminal"></button>
				<button data-view="files"></button>
				<button data-view="git"></button>
			</nav>
		</section>`;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
	vs = await import("./viewSwitch.js");
	await import("./chatView.js");
});

beforeEach(() => {
	localStorage.clear();
	api.fetchConversations.mockReset().mockResolvedValue({ capture, conversations: [conv()] });
	api.fetchConversationEvents.mockReset();
	mainState.currentTerminals = new Map([["t1", {}]]);
});
afterEach(() => {
	mainState.activeSessionId = null;
	mainState.sessions = [];
	vs.syncSessionViews();
	vs.setView("terminal");
});

async function openChat(id = "s1") {
	mainState.activeSessionId = id;
	mainState.sessions = [{ sessionId: id, name: id, status: "running" }];
	vs.syncSessionViews();
	$("view-chat-btn").click();
	await flush();
}

describe("F: two list requests for the same session answering out of order", () => {
	it("the older answer must not replace the newer list nor the history hint", async () => {
		await openChat();
		expect($("chat-list").textContent).toContain("Fix the build");
		expect(localStorage.getItem("st.chat.hist.s1")).toBe("1");

		const older = deferred<unknown>();
		const newer = deferred<unknown>();
		api.fetchConversations.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
		// Two loads of the same session in flight (a refresh click and the
		// 15 s poll have the same shape: both run loadList with the same `generation`).
		$("chat-refresh-btn").click();
		$("chat-refresh-btn").click();
		expect(api.fetchConversations).toHaveBeenCalledTimes(3);

		// The newer request answers first: a conversation exists now.
		newer.resolve({ capture, conversations: [conv({ title: "Newest conversation" })] });
		await flush();
		expect($("chat-list").textContent).toContain("Newest conversation");
		expect(localStorage.getItem("st.chat.hist.s1")).toBe("1");

		// The older request answers last, from before the conversation existed.
		older.resolve({ capture, conversations: [] });
		await flush();

		expect($("chat-list").textContent, "an older answer replaced the newer list").toContain(
			"Newest conversation",
		);
		expect(
			localStorage.getItem("st.chat.hist.s1"),
			"the history hint was left stale by the older answer",
		).toBe("1");
	});
});
