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

// ── C5 / C6: first-page failure, reading position across older pages ────────

/**
 * jsdom has no layout. This fakes the one the scroller needs: every direct
 * child of `.chat-scroll` is `row` px tall, the scroller shows `view` px, and
 * `scrollTop` clamps like a browser's. Returns the undo.
 */
function fakeLayout(row = 100, view = 500): () => void {
	const proto = Element.prototype;
	const isScroller = (e: Element) => e.classList.contains("chat-scroll");
	const saved = {
		rect: proto.getBoundingClientRect,
		scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight"),
		clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
		scrollTop: Object.getOwnPropertyDescriptor(proto, "scrollTop"),
	};
	const tops = new WeakMap<Element, number>();
	const rect = (top: number, height: number) =>
		({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
	Object.defineProperty(proto, "scrollHeight", {
		configurable: true,
		get(this: Element) {
			return isScroller(this) ? this.childElementCount * row : 0;
		},
	});
	Object.defineProperty(proto, "clientHeight", {
		configurable: true,
		get(this: Element) {
			return isScroller(this) ? view : 0;
		},
	});
	Object.defineProperty(proto, "scrollTop", {
		configurable: true,
		get(this: Element) {
			return tops.get(this) ?? 0;
		},
		set(this: Element, v: number) {
			const max = Math.max(0, this.scrollHeight - this.clientHeight);
			tops.set(this, Math.min(Math.max(0, v), max));
		},
	});
	proto.getBoundingClientRect = function (this: Element) {
		if (isScroller(this)) return rect(0, view);
		const p = this.parentElement;
		if (p && isScroller(p)) {
			const i = [...p.children].indexOf(this);
			return rect(i * row - p.scrollTop, row);
		}
		return rect(0, 0);
	};
	return () => {
		proto.getBoundingClientRect = saved.rect;
		for (const k of ["scrollHeight", "clientHeight", "scrollTop"] as const) {
			const d = saved[k];
			if (d) Object.defineProperty(proto, k, d);
			else delete (proto as unknown as Record<string, unknown>)[k];
		}
	};
}

describe("Chat overlay — first-page error (C5) and reading position (C6)", () => {
	let undoLayout = () => {};
	beforeEach(() => {
		undoLayout = fakeLayout();
		api.fetchConversations.mockResolvedValue({
			capture: { requested: true, effective: true, effectiveAfterRestart: true },
			conversations: [conv(), conv({ sessionId: "c2", title: "Second" })],
		});
	});
	afterEach(() => undoLayout());

	const thread = () => $("chat-thread");
	const scroller = () => thread().querySelector<HTMLElement>(".chat-scroll") as HTMLElement;
	const pill = () => thread().querySelector<HTMLButtonElement>(".chat-float") as HTMLButtonElement;
	const msg = (n: number, prompt = `m${n}`) => ({ ...ev("user_prompt", { prompt }), seq: n });
	const range = (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
	const page = (events: unknown[], hasMore: boolean) => ({ events, hasMore, firstRetainedSeq: 1 });
	const rows = () => document.querySelectorAll<HTMLButtonElement>(".chat-conv-row");
	/** The reader scrolls: the position plus the event the view listens to. */
	const scrollTo = (y: number) => {
		scroller().scrollTop = y;
		scroller().dispatchEvent(new Event("scroll"));
	};
	/** What the reader sees at the top: the first block in view and its offset. */
	const firstVisible = () => {
		const sc = scroller();
		for (const child of sc.children) {
			const seq = Number((child as HTMLElement).dataset.seq);
			if (!seq) continue;
			const r = child.getBoundingClientRect();
			if (r.bottom > 0) return { seq, offset: r.top };
		}
		return null;
	};
	/** Where a block's top edge sits relative to the scroller's (null when not in the window). */
	const topOf = (seq: number) => {
		const node = [...scroller().children].find(
			(c) => (c as HTMLElement).dataset.seq === String(seq),
		);
		return node ? node.getBoundingClientRect().top : null;
	};
	const texts = () =>
		[...thread().querySelectorAll(".chat-user .chat-text")].map((n) => n.textContent);

	it("C5: a failed first page shows the error and Retry, not the skeleton; Retry reloads; no stale error", async () => {
		await openChat();
		api.fetchConversationEvents.mockRejectedValueOnce(new Error("boom"));
		rows()[0]?.click();
		await flush();
		expect(thread().querySelector(".chat-skeleton")).toBeNull();
		expect(thread().querySelector(".chat-thread-error")?.textContent).toContain("boom");
		const retry = buttonNamed(thread(), "Retry");
		expect(retry).toBeDefined();
		// Retry: back to loading, then the conversation.
		let resolve: (v: unknown) => void = () => {};
		api.fetchConversationEvents.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		retry?.click();
		await flush();
		expect(thread().querySelector(".chat-skeleton")).toBeTruthy();
		expect(buttonNamed(thread(), "Retry")).toBeUndefined();
		resolve(page([msg(1, "recovered")], false));
		await flush();
		expect(texts()).toEqual(["recovered"]);
		expect(api.fetchConversationEvents).toHaveBeenCalledTimes(2);
		expect(api.fetchConversationEvents).toHaveBeenLastCalledWith("s1", "c1", { limit: 200 });
		// B fails; going back to A shows A, and B's error does not follow.
		api.fetchConversationEvents.mockRejectedValueOnce(new Error("second broke"));
		rows()[1]?.click();
		await flush();
		expect(thread().textContent).toContain("second broke");
		rows()[0]?.click();
		await flush();
		expect(thread().querySelector(".chat-thread-error")).toBeNull();
		expect(texts()).toEqual(["recovered"]);
		api.fetchConversationEvents.mockResolvedValueOnce(page([msg(5, "B fine now")], false));
		rows()[1]?.click();
		await flush();
		expect(thread().querySelector(".chat-thread-error")).toBeNull();
		expect(texts()).toEqual(["B fine now"]);
	});

	it("C6/1: an older page keeps the block the reader was looking at where it was", async () => {
		await openChat();
		await openThread(range(201, 400), true);
		expect(scroller().scrollTop).toBe(20100 - 500); // opened at the end, clamped
		scrollTo(150);
		expect(firstVisible()).toEqual({ seq: 201, offset: -50 });
		api.fetchConversationEvents.mockResolvedValueOnce(page(range(1, 200), false));
		buttonNamed(thread(), "Load earlier")?.click();
		await flush();
		expect(texts()).toHaveLength(400);
		expect(firstVisible()).toEqual({ seq: 201, offset: -50 });
		// Prepended history is not "new below the reader".
		expect(pill().hidden).toBe(true);
	});

	it("C6/2: crossing the 500-event window drops the newest end without moving the reader", async () => {
		await openChat();
		await openThread(range(301, 600), true);
		scrollTo(150);
		expect(firstVisible()).toEqual({ seq: 301, offset: -50 });
		api.fetchConversationEvents.mockResolvedValueOnce(page(range(1, 300), false));
		buttonNamed(thread(), "Load earlier")?.click();
		await flush();
		expect(texts()).toHaveLength(500);
		expect(texts()[0]).toBe("m1");
		expect(texts()[499]).toBe("m500");
		expect(firstVisible()).toEqual({ seq: 301, offset: -50 });
		expect(pill().hidden).toBe(false);
		expect(pill().textContent).toBe("100 newer events · Jump to latest");
	});

	it("C6/3: crossing the 8 MiB budget keeps the anchor; an anchor dropped by L8 lands at the window's end", async () => {
		const big = "x".repeat(1_600_000); // ≈ 3.2 MB per event in the window's accounting
		await openChat();
		await openThread([msg(50, big), ...range(51, 60), msg(61, big)], true);
		scrollTo(150);
		expect(firstVisible()).toEqual({ seq: 50, offset: -50 });
		api.fetchConversationEvents.mockResolvedValueOnce(page([msg(1, big), ...range(2, 49)], false));
		buttonNamed(thread(), "Load earlier")?.click();
		await flush();
		// Three big events do not fit: 61 was dropped from the newest end; 1..60 stay.
		expect(texts()).toHaveLength(60);
		expect(texts()[59]).toBe("m60");
		expect(firstVisible()).toEqual({ seq: 50, offset: -50 });
		expect(pill().textContent).toBe("1 newer event · Jump to latest");

		// Fallback: the page alone exceeds the budget, so the anchor itself is dropped.
		undoLayout();
		undoLayout = fakeLayout(100, 150);
		api.fetchConversationEvents.mockResolvedValueOnce(page([msg(10, big), msg(11, big)], true));
		rows()[1]?.click();
		await flush();
		api.fetchConversationEvents.mockResolvedValueOnce(
			page([msg(1, big), msg(2, big), msg(3, big)], false),
		);
		scrollTo(0); // auto-loads the page; the anchor is 10
		expect(firstVisible()?.seq).toBe(10);
		await flush();
		const seqs = [...scroller().children].map((c) => (c as HTMLElement).dataset.seq);
		expect(seqs).toEqual(["1", "2"]);
		expect(scroller().scrollTop).toBe(scroller().scrollHeight - scroller().clientHeight);
		expect(firstVisible()).toEqual({ seq: 1, offset: -50 });
		expect(pill().textContent).toBe("3 newer events · Jump to latest");
	});

	it("C6/4: three pages of 200 — the message in view stays the message in view (Work's repro)", async () => {
		await openChat();
		await openThread(range(401, 600), true);
		// Reading up to the top auto-loads the next page; the first block stays put.
		api.fetchConversationEvents.mockResolvedValueOnce(page(range(201, 400), true));
		scrollTo(0);
		expect(firstVisible()).toEqual({ seq: 401, offset: 100 });
		await flush();
		expect(texts()).toHaveLength(400);
		// 401 sits exactly where it was; the page landed above it (400 now fills the button's spot).
		expect(topOf(401)).toBe(100);
		expect(firstVisible()).toEqual({ seq: 400, offset: 0 });
		// The reader scrolls up to message 202 and asks for more.
		scrollTo(200);
		expect(firstVisible()).toEqual({ seq: 202, offset: 0 });
		api.fetchConversationEvents.mockResolvedValueOnce(page(range(1, 200), false));
		buttonNamed(thread(), "Load earlier")?.click();
		await flush();
		expect(texts()).toHaveLength(500);
		expect(firstVisible()).toEqual({ seq: 202, offset: 0 });
		expect(pill().textContent).toBe("100 newer events · Jump to latest");
	});

	it("C6/5: A → B → A comes back to each conversation's own reading position", async () => {
		await openChat();
		await openThread(range(1, 100), false);
		scrollTo(4200);
		expect(firstVisible()?.seq).toBe(43);
		api.fetchConversationEvents.mockResolvedValueOnce(page(range(201, 300), false));
		rows()[1]?.click();
		await flush();
		expect(scroller().scrollTop).toBe(9500); // a new thread opens at its end
		scrollTo(1300);
		rows()[0]?.click();
		await flush();
		expect(scroller().scrollTop).toBe(4200);
		expect(firstVisible()?.seq).toBe(43);
		rows()[1]?.click();
		await flush();
		expect(scroller().scrollTop).toBe(1300);
		expect(firstVisible()?.seq).toBe(214);
		expect(api.fetchConversationEvents).toHaveBeenCalledTimes(2);
	});

	it("C6/6: a live event during an older-page load is counted below the reader, who does not move", async () => {
		await openChat();
		await openThread(range(101, 200), true);
		scrollTo(150);
		expect(firstVisible()).toEqual({ seq: 101, offset: -50 });
		let resolve: (v: unknown) => void = () => {};
		api.fetchConversationEvents.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		buttonNamed(thread(), "Load earlier")?.click();
		await flush();
		sock.onFrame?.({ type: "event", conv: "c1", event: msg(201, "live") });
		await flush();
		expect(texts()).toHaveLength(101);
		expect(firstVisible()).toEqual({ seq: 101, offset: -50 });
		expect(pill().textContent).toBe("↓ 1 new");
		resolve(page(range(1, 100), false));
		await flush();
		expect(texts()).toHaveLength(201);
		expect(texts()[200]).toBe("live");
		expect(firstVisible()).toEqual({ seq: 101, offset: -50 });
		expect(pill().textContent).toBe("↓ 1 new");
		// Reaching the bottom clears it.
		scrollTo(scroller().scrollHeight);
		expect(pill().hidden).toBe(true);
	});
});

describe("Chat overlay — §4.2.1 internal notifications are not 'You'", () => {
	const AGENT_TOOL = "toolu_01NrcdMjX7yQ2bK9vTz3Lm4W";
	const AGENT = "afc95b2b37cb620a1";
	const RESULT = "the subagent's own report text";
	const notification = (toolUseId: string, taskId: string) =>
		`<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<result>\n${RESULT}\n</result>\n</task-notification>`;
	const run = (notice: Record<string, unknown>) => [
		ev("user_prompt", { prompt: "Run the audit with a subagent" }, { prompt_id: "p1" }),
		ev("tool_start", {
			tool_use_id: AGENT_TOOL,
			tool_name: "Agent",
			summary: { subagent_type: "Explore" },
		}),
		ev("agent_start", { agent_id: AGENT, agent_type: "Explore" }, { agent_id: AGENT }),
		ev(
			"agent_end",
			{ agent_id: AGENT, agent_type: "Explore", last_assistant_message: RESULT },
			{ agent_id: AGENT },
		),
		ev(String(notice.ev), notice.data as Record<string, unknown>, { prompt_id: "p2" }),
		ev(
			"assistant_delta",
			{ message_id: "m2", index: 0, final: true, delta: "Continuing." },
			{ prompt_id: "p2" },
		),
		ev("turn_end", { last_assistant_message: "Continuing." }, { prompt_id: "p2" }),
	];

	for (const [label, notice] of [
		[
			"a persisted internal_prompt",
			{
				ev: "internal_prompt",
				data: {
					notice: "task-notification",
					task_id: AGENT,
					tool_use_id: AGENT_TOOL,
					status: "completed",
					prompt_bytes: 180,
				},
			},
		],
		[
			"a legacy user_prompt that is a notification",
			{ ev: "user_prompt", data: { prompt: notification(AGENT_TOOL, AGENT) } },
		],
	] as const) {
		it(`${label}: one 'You', an internal marker tied to the agent, the result shown once (agents panel)`, async () => {
			await openChat();
			await openThread(run(notice));
			const thread = $("chat-thread");
			const users = [...thread.querySelectorAll(".chat-user")];
			expect(users).toHaveLength(1);
			expect(users[0].textContent).toContain("You");
			expect(users[0].textContent).toContain("Run the audit");
			const marker = thread.querySelector(".chat-marker.internal");
			expect(marker?.textContent).toContain("Explore agent finished · result delivered to Claude");
			expect(thread.textContent).not.toContain(RESULT);
			expect(thread.textContent).not.toContain("<task-notification>");
			// Claude's next turn is a report of its own, after the notification.
			expect(thread.querySelector(".chat-assistant.is-report")?.textContent).toContain(
				"Continuing.",
			);
			// Details opens the agent card, where the result lives once.
			buttonNamed(marker as HTMLElement, "Details")?.click();
			await flush();
			expect($("chat-agents").hidden).toBe(false);
			expect($("chat-agents").querySelector(`[data-agent="${AGENT}"]`)?.textContent).toContain(
				RESULT,
			);
		});
	}

	it("an unverifiable notification shape and an injected prompt are labelled, never 'You'", async () => {
		await openChat();
		await openThread([
			ev("user_prompt", { prompt: notification("call_123", AGENT) }),
			ev("user_prompt", { prompt: "from the lead", source: "system" }),
			ev("user_prompt", { prompt: "and I say <task-notification> is odd" }),
		]);
		const labels = [...$("chat-thread").querySelectorAll(".chat-user .chat-meta")].map((m) =>
			m.textContent?.replace(/\d{1,2}:\d{2}.*$/, "").trim(),
		);
		expect(labels).toEqual(["Prompt · origin unverified", "Injected · system", "You"]);
	});
});
