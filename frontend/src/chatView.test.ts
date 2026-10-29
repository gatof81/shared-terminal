/**
 * chatView.test.ts — the Chat overlay (3.1) under jsdom with main.ts and
 * api.ts mocked: the terminal invariant, the capture banner, one tool per
 * tool_use_id, "Copy report" byte for byte, live frames deduplicated,
 * paging back with `before`, and the mobile one-pane layout.
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

const sock = vi.hoisted(() => ({
	onFrame: null as null | ((f: unknown) => void),
	onState: null as null | ((c: boolean) => void),
	follow: vi.fn(),
	close: vi.fn(),
}));
const api = vi.hoisted(() => ({
	fetchConversations: vi.fn(),
	fetchConversationEvents: vi.fn(),
	openConversationSocket: vi.fn(
		(_sid: string, onFrame: (f: unknown) => void, onState: (c: boolean) => void) => {
			sock.onFrame = onFrame;
			sock.onState = onState;
			return { follow: sock.follow, close: sock.close };
		},
	),
}));
vi.mock("./api.js", () => api);
vi.mock("./sessionCore.js", () => ({ refreshSessions: vi.fn(async () => {}) }));

type ViewSwitch = typeof import("./viewSwitch.js");
let vs: ViewSwitch;

const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const buttonNamed = (root: HTMLElement, label: string) =>
	[...root.querySelectorAll("button")].find((b) => b.textContent === label);

let seq = 0;
const ev = (
	name: string,
	data: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
) => ({
	seq: ++seq,
	ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
	ev: name,
	prompt_id: null,
	turn_id: null,
	agent_id: null,
	pane: null,
	data,
	...extra,
});
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
const REPORT = "## Done\n\nAll **green**.\n\u0001 exact bytes  \n";

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
	seq = 0;
	// The unread dots persist per viewer; tests must not inherit each other's.
	localStorage.clear();
	api.fetchConversations.mockReset().mockResolvedValue({
		capture: { requested: true, effective: true, effectiveAfterRestart: true },
		conversations: [conv()],
	});
	api.fetchConversationEvents.mockReset();
	api.openConversationSocket.mockClear();
	sock.follow.mockClear();
	sock.close.mockClear();
	mainState.currentTerminals = new Map([["t1", {}]]);
	mainState.showToast.mockClear();
});
afterEach(() => {
	mainState.activeSessionId = null;
	mainState.sessions = [];
	mainState.mobile = false;
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
async function openThread(events: unknown[], hasMore = false) {
	api.fetchConversationEvents.mockResolvedValueOnce({ events, hasMore, firstRetainedSeq: 1 });
	const row = document.querySelector<HTMLButtonElement>(".chat-conv-row");
	row?.click();
	await flush();
}

describe("Chat overlay", () => {
	it("overlays the terminal without touching it and makes it inert", async () => {
		const container = $("terminal-container");
		const before = container.innerHTML;
		await openChat();
		expect($("chat-view").hidden).toBe(false);
		expect($("terminal-container").hasAttribute("inert")).toBe(true);
		expect(container.innerHTML).toBe(before);
		vs.setView("terminal");
		expect($("terminal-container").hasAttribute("inert")).toBe(false);
	});

	it("lists conversations; a capture that is not effective shows a banner", async () => {
		api.fetchConversations.mockResolvedValueOnce({
			capture: {
				requested: true,
				effective: false,
				effectiveAfterRestart: false,
				pendingReasons: ["container-without-capture"],
			},
			conversations: [conv()],
		});
		await openChat();
		expect($("chat-list").textContent).toContain("Fix the build");
		expect($("chat-list").textContent).toContain("Waiting for input");
		expect($("chat-list").querySelector(".chat-banner")?.textContent).toContain(
			"container-without-capture",
		);
	});

	it("an empty session explains where conversations come from", async () => {
		api.fetchConversations.mockResolvedValueOnce({
			capture: { requested: true, effective: true, effectiveAfterRestart: true },
			conversations: [],
		});
		await openChat();
		expect($("chat-list").textContent).toContain("No conversations recorded yet");
	});

	it("renders the thread: prompt, Markdown answer, ONE failed tool, report; composer disabled", async () => {
		await openChat();
		await openThread([
			ev("user_prompt", { prompt: "run the tests" }),
			ev("tool_start", {
				tool_use_id: "t1",
				tool_name: "Bash",
				summary: { programs: ["npm"], command_bytes: 8 },
			}),
			ev("tool_failed", { tool_use_id: "t1", tool_name: "Bash", ok: false, duration_ms: 1200 }),
			ev("tool_end", { tool_use_id: "t1", tool_name: "Bash", ok: true, duration_ms: 1201 }),
			ev("assistant_delta", { message_id: "m1", index: 0, delta: "Tests **fail**", final: true }),
			ev("turn_end", { last_assistant_message: REPORT }),
		]);
		expect(api.fetchConversationEvents).toHaveBeenCalledWith("s1", "c1", { limit: 200 });
		const thread = $("chat-thread");
		expect(thread.querySelector(".chat-user")?.textContent).toContain("run the tests");
		expect(thread.querySelector(".chat-assistant strong")?.textContent).toBe("fail");
		const tools = thread.querySelectorAll(".chat-tool");
		expect(tools).toHaveLength(1);
		expect(tools[0].classList.contains("failed")).toBe(true);
		expect(tools[0].querySelector(".chat-tool-name")?.textContent).toBe("Bash");
		expect(tools[0].querySelector(".chat-tool-line")?.textContent).toBe("npm · 8 B");
		// The run of tools is one block whose header counts the failure.
		const block = thread.querySelector<HTMLDetailsElement>(".chat-tools");
		expect(block?.open).toBe(true);
		expect(block?.querySelector(".chat-tools-summary")?.textContent).toContain("1 failed");
		const ta = thread.querySelector<HTMLTextAreaElement>(".chat-composer textarea");
		expect(ta?.disabled).toBe(true);
		// Live socket follows from the newest seq loaded.
		expect(sock.follow).toHaveBeenCalledWith("c1", 6);
	});

	it("Copy report copies last_assistant_message byte for byte", async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		await openChat();
		await openThread([ev("turn_end", { last_assistant_message: REPORT })]);
		buttonNamed($("chat-thread"), "Copy report")?.click();
		await flush();
		expect(writeText).toHaveBeenCalledWith(REPORT);
		expect(mainState.showCopySuccessToast).toHaveBeenCalled();
	});

	it("a truncated report says so on the copy button", async () => {
		await openChat();
		await openThread([
			ev("turn_end", {
				last_assistant_message: "partial",
				truncated: true,
				original_bytes: 3_000_000,
			}),
		]);
		expect(buttonNamed($("chat-thread"), "Copy report (truncated)")).toBeTruthy();
		expect($("chat-thread").textContent).toContain("original 3 MiB");
	});

	it("live frames append in order and a duplicate is ignored", async () => {
		await openChat();
		await openThread([ev("user_prompt", { prompt: "one" })]);
		const two = ev("user_prompt", { prompt: "two" });
		sock.onFrame?.({ type: "event", conv: "c1", event: two });
		sock.onFrame?.({ type: "event", conv: "c1", event: two });
		sock.onFrame?.({
			type: "event",
			conv: "other",
			event: ev("user_prompt", { prompt: "elsewhere" }),
		});
		await flush();
		const texts = [...$("chat-thread").querySelectorAll(".chat-user .chat-text")].map(
			(n) => n.textContent,
		);
		expect(texts).toEqual(["one", "two"]);
		sock.onFrame?.({
			type: "status",
			conv: "c1",
			status: "running",
			evidence: "hook:UserPromptSubmit",
			at: new Date().toISOString(),
		});
		// Desktop: the status lives in the thread head (the header keeps the list summary).
		expect($("chat-thread").querySelector(".chat-thread-head")?.textContent).toContain("Working");
		expect($("chat-summary").textContent).toContain("1 active");
	});

	it("Load earlier asks for events before the first loaded seq", async () => {
		await openChat();
		seq = 100;
		await openThread([ev("user_prompt", { prompt: "late" })], true);
		api.fetchConversationEvents.mockResolvedValueOnce({
			events: [{ ...ev("user_prompt", { prompt: "early" }), seq: 50 }],
			hasMore: false,
			firstRetainedSeq: 1,
		});
		buttonNamed($("chat-thread"), "Load earlier")?.click();
		await flush();
		expect(api.fetchConversationEvents).toHaveBeenLastCalledWith("s1", "c1", {
			before: 101,
			limit: 200,
		});
		const texts = [...$("chat-thread").querySelectorAll(".chat-user .chat-text")].map(
			(n) => n.textContent,
		);
		expect(texts).toEqual(["early", "late"]);
		expect(buttonNamed($("chat-thread"), "Load earlier")).toBeUndefined();
	});

	it("a Load earlier still pending for A neither blocks B's nor touches B's thread (C4)", async () => {
		api.fetchConversations.mockResolvedValue({
			capture: { requested: true, effective: true, effectiveAfterRestart: true },
			conversations: [conv(), conv({ sessionId: "c2", title: "Second" })],
		});
		await openChat();
		seq = 100;
		await openThread([ev("user_prompt", { prompt: "A late" })], true);
		// A's older page stays pending.
		let resolveA: (v: unknown) => void = () => {};
		api.fetchConversationEvents.mockReturnValueOnce(new Promise((r) => (resolveA = r)));
		buttonNamed($("chat-thread"), "Load earlier")?.click();
		await flush();
		expect(buttonNamed($("chat-thread"), "Loading…")).toBeDefined();
		// Open B while A's request is in flight.
		seq = 300;
		api.fetchConversationEvents.mockResolvedValueOnce({
			events: [ev("user_prompt", { prompt: "B late" })],
			hasMore: true,
			firstRetainedSeq: 1,
		});
		document.querySelectorAll<HTMLButtonElement>(".chat-conv-row")[1]?.click();
		await flush();
		expect(api.fetchConversationEvents).toHaveBeenLastCalledWith("s1", "c2", { limit: 200 });
		// A completes now: its page must not land in B, nor clear B's state.
		resolveA({
			events: [{ ...ev("user_prompt", { prompt: "A early" }), seq: 50 }],
			hasMore: false,
			firstRetainedSeq: 1,
		});
		await flush();
		const texts = () =>
			[...$("chat-thread").querySelectorAll(".chat-user .chat-text")].map((n) => n.textContent);
		expect(texts()).toEqual(["B late"]);
		// B can load its own earlier events.
		api.fetchConversationEvents.mockResolvedValueOnce({
			events: [{ ...ev("user_prompt", { prompt: "B early" }), seq: 250 }],
			hasMore: false,
			firstRetainedSeq: 1,
		});
		buttonNamed($("chat-thread"), "Load earlier")?.click();
		await flush();
		expect(api.fetchConversationEvents).toHaveBeenLastCalledWith("s1", "c2", {
			before: 301,
			limit: 200,
		});
		expect(texts()).toEqual(["B early", "B late"]);
	});

	it("mobile: one pane at a time, with a back button to the list", async () => {
		mainState.mobile = true;
		await openChat();
		expect($("chat-body").classList.contains("show-thread")).toBe(false);
		await openThread([ev("user_prompt", { prompt: "hi" })]);
		expect($("chat-body").classList.contains("show-thread")).toBe(true);
		expect($("chat-back-btn").hidden).toBe(false);
		$("chat-back-btn").click();
		expect($("chat-body").classList.contains("show-thread")).toBe(false);
	});

	it("leaving the Chat view closes the live socket", async () => {
		await openChat();
		await openThread([ev("user_prompt", { prompt: "hi" })]);
		vs.setView("terminal");
		expect(sock.close).toHaveBeenCalled();
	});

	it("switching A → B → A reuses A's window and DOM: no refetch, re-follow from its seq", async () => {
		api.fetchConversations.mockResolvedValue({
			capture: { requested: true, effective: true, effectiveAfterRestart: true },
			conversations: [conv(), conv({ sessionId: "c2", title: "Second" })],
		});
		await openChat();
		seq = 10;
		await openThread([ev("user_prompt", { prompt: "A text" })]);
		const aNode = $("chat-thread").querySelector(".chat-user");
		expect(sock.follow).toHaveBeenLastCalledWith("c1", 11);
		seq = 20;
		api.fetchConversationEvents.mockResolvedValueOnce({
			events: [ev("user_prompt", { prompt: "B text" })],
			hasMore: false,
			firstRetainedSeq: 1,
		});
		document.querySelectorAll<HTMLButtonElement>(".chat-conv-row")[1]?.click();
		await flush();
		expect($("chat-thread").textContent).toContain("B text");
		expect(api.fetchConversationEvents).toHaveBeenCalledTimes(2);
		document.querySelectorAll<HTMLButtonElement>(".chat-conv-row")[0]?.click();
		await flush();
		expect(api.fetchConversationEvents).toHaveBeenCalledTimes(2);
		expect($("chat-thread").textContent).toContain("A text");
		// Same DOM node: the cached thread came back, not a rebuild.
		expect($("chat-thread").querySelector(".chat-user")).toBe(aNode);
		expect(sock.follow).toHaveBeenLastCalledWith("c1", 11);
	});

	it("the final answer is shown once, as the report, with Copy report; code blocks get Copy", async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const text = "Done.\n\n```sh\nnpm test\n```\n";
		await openChat();
		await openThread([
			ev("user_prompt", { prompt: "go" }),
			ev("assistant_delta", { message_id: "m1", index: 0, delta: text, final: true }),
			ev("turn_end", { last_assistant_message: text }),
		]);
		const thread = $("chat-thread");
		const msgs = thread.querySelectorAll(".chat-assistant");
		expect(msgs).toHaveLength(1);
		expect(msgs[0].classList.contains("is-report")).toBe(true);
		expect(buttonNamed(thread, "Copy report")).toBeTruthy();
		expect(buttonNamed(thread, "Copy Markdown")).toBeUndefined();
		const copyCode = thread.querySelector<HTMLButtonElement>(".chat-pre .chat-copy");
		expect(copyCode?.getAttribute("aria-label")).toBe("Copy code");
		copyCode?.click();
		await flush();
		expect(writeText).toHaveBeenCalledWith("npm test");
	});

	it("a run of tools is one block: collapsed when long and clean, open when something failed", async () => {
		await openChat();
		const events: unknown[] = [ev("user_prompt", { prompt: "go" })];
		for (let i = 0; i < 6; i++) {
			events.push(ev("tool_start", { tool_use_id: `t${i}`, tool_name: "Read", summary: {} }));
			events.push(ev("tool_end", { tool_use_id: `t${i}`, tool_name: "Read", ok: true }));
		}
		await openThread(events);
		const block = $("chat-thread").querySelector<HTMLDetailsElement>(".chat-tools");
		expect(block?.open).toBe(false);
		expect(block?.querySelectorAll(".chat-tool")).toHaveLength(6);
		expect(block?.querySelector(".chat-tools-summary")?.textContent).toContain("6 tool calls");
		// A failure arriving live opens the block (unless the reader toggled it).
		sock.onFrame?.({
			type: "event",
			conv: "c1",
			event: ev("tool_start", { tool_use_id: "t9", tool_name: "Bash", summary: {} }),
		});
		sock.onFrame?.({
			type: "event",
			conv: "c1",
			event: ev("tool_failed", { tool_use_id: "t9", tool_name: "Bash", ok: false }),
		});
		await flush();
		const after = $("chat-thread").querySelector<HTMLDetailsElement>(".chat-tools");
		expect(after).toBe(block);
		expect(after?.open).toBe(true);
		expect(after?.querySelectorAll(".chat-tool")).toHaveLength(7);
		expect(after?.querySelector(".chat-tools-failed")?.textContent).toBe("1 failed");
	});

	it("agents: inline markers in the thread, a panel with status, tools and result", async () => {
		await openChat();
		await openThread([
			ev("user_prompt", { prompt: "go" }),
			ev("agent_start", { agent_id: "a1", agent_type: "Explore" }, { agent_id: "a1" }),
			ev("tool_start", { tool_use_id: "x1", tool_name: "Grep", summary: {} }, { agent_id: "a1" }),
			ev(
				"agent_end",
				{ agent_id: "a1", agent_type: "Explore", last_assistant_message: "found **it**" },
				{ agent_id: "a1" },
			),
		]);
		const thread = $("chat-thread");
		expect(thread.querySelectorAll(".chat-marker.agent")).toHaveLength(2);
		expect(thread.textContent).toContain("Explore agent started");
		expect(thread.textContent).toContain("Explore agent finished");
		expect($("chat-agents").hidden).toBe(true);
		const btn = [...thread.querySelectorAll("button")].find((b) =>
			b.textContent?.startsWith("Agents 1"),
		);
		btn?.click();
		await flush();
		expect($("chat-agents").hidden).toBe(false);
		expect($("chat-body").classList.contains("show-agents")).toBe(true);
		const card = $("chat-agents").querySelector('[data-agent="a1"]');
		expect(card?.textContent).toContain("Explore");
		expect(card?.textContent).toContain("1 tool");
		expect(card?.querySelector(".chat-md strong")?.textContent).toBe("it");
		expect(buttonNamed($("chat-agents"), "Copy result")).toBeTruthy();
	});

	it("hello frames refresh the rows: a conversation that grew gets the unread dot", async () => {
		api.fetchConversations.mockResolvedValue({
			capture: { requested: true, effective: true, effectiveAfterRestart: true },
			conversations: [conv(), conv({ sessionId: "c2", title: "Second", lastSeq: 5 })],
		});
		await openChat();
		expect($("chat-list").querySelectorAll(".chat-conv-unread")).toHaveLength(0);
		await openThread([ev("user_prompt", { prompt: "hi" })]);
		sock.onFrame?.({
			type: "hello",
			conversations: [
				{ cid: "c1", lastSeq: 10, firstRetainedSeq: 1, status: "waiting_input" },
				{ cid: "c2", lastSeq: 9, firstRetainedSeq: 1, status: "running" },
			],
		});
		const rows = [...$("chat-list").querySelectorAll<HTMLElement>(".chat-conv-row")];
		const second = rows.find((r) => r.dataset.cid === "c2");
		expect(second?.querySelector(".chat-conv-unread")).toBeTruthy();
		expect(second?.textContent).toContain("Working");
		expect(rows.find((r) => r.dataset.cid === "c1")?.querySelector(".chat-conv-unread")).toBeNull();
	});

	it("the view nav is shown while an overlay is up and mirrors the active view", async () => {
		await openChat();
		expect($("view-nav").hidden).toBe(false);
		expect($("terminal-area").classList.contains("view-nav-on")).toBe(true);
		const pressed = () =>
			[...$("view-nav").querySelectorAll<HTMLButtonElement>("button")]
				.filter((b) => b.getAttribute("aria-pressed") === "true")
				.map((b) => b.dataset.view);
		expect(pressed()).toEqual(["chat"]);
		$("view-nav").querySelector<HTMLButtonElement>('[data-view="terminal"]')?.click();
		expect(vs.getView()).toBe("terminal");
		expect($("view-nav").hidden).toBe(true);
		expect($("terminal-area").classList.contains("view-nav-on")).toBe(false);
	});
});
