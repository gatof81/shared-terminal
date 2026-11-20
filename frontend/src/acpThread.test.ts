/**
 * acpThread.test.ts — the ACP thread's races under jsdom, with the network
 * (api.ts) and the live socket (acpLive.ts) mocked: a send is reserved before
 * any await, drafts belong to their chat, a late page never undoes a newer
 * live row, a late answer lands only in the chat it was asked from, and a
 * re-render keeps the elements that did not change.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpFeed, AcpMessage } from "./api.js";

const live = vi.hoisted(() => ({
	listener: null as null | ((ev: unknown) => void),
}));
vi.mock("./acpLive.js", () => ({
	acpLiveUp: () => false,
	subscribeAcp: (fn: (ev: unknown) => void) => {
		live.listener = fn;
		return () => {
			live.listener = null;
		};
	},
}));
vi.mock("./main.js", () => ({ showCopySuccessToast: vi.fn(), showToast: vi.fn() }));

const api = vi.hoisted(() => ({
	acpFeed: vi.fn(),
	acpProjectFeed: vi.fn(),
	acpSend: vi.fn(),
	acpRequeue: vi.fn(),
	acpAnswer: vi.fn(),
	acpListAgents: vi.fn(),
	uploadSessionFiles: vi.fn(),
}));
vi.mock("./api.js", () => api);

const { AcpThread } = await import("./acpThread.js");

const msg = (id: number, over: Partial<AcpMessage> = {}): AcpMessage => ({
	id,
	from_id: "owner",
	to_id: "dev",
	kind: "request",
	reply_to: null,
	body: `m${id}`,
	state: "pending",
	attempts: 0,
	created_at: "2026-11-18T10:00:00Z",
	started_at: null,
	finished_at: null,
	result_text: null,
	stop_reason: null,
	note: null,
	project_id: null,
	...over,
});
const agent = (name: string, projectId: string | null = null) => ({
	name,
	sessionId: `s-${name}`,
	runtime: "claude-acp",
	model: null,
	projectId,
	runnerSeenAt: null,
});
const feed = (over: Partial<AcpFeed> = {}): AcpFeed => ({
	maxMessageBytes: 262144,
	messages: [],
	questions: [],
	activity: {},
	activitySeq: 0,
	...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	for (const f of Object.values(api)) f.mockReset();
	api.acpListAgents.mockResolvedValue([]);
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
});

function mount() {
	const t = new AcpThread();
	document.body.replaceChildren(t.root);
	return t;
}
const submit = (t: InstanceType<typeof AcpThread>) =>
	t.root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));

describe("sending", () => {
	it("two quick submits of the same draft send once, even while the page is still loading", async () => {
		const page = deferred<AcpFeed>();
		api.acpFeed.mockReturnValueOnce(page.promise);
		api.acpSend.mockResolvedValue(msg(9, { to_id: "dev" }));
		const t = mount();
		t.open({ kind: "agent", name: "dev" });
		t.input.value = "hacé X";
		api.acpFeed.mockResolvedValue(feed({ agent: agent("dev") }));
		submit(t);
		submit(t);
		page.resolve(feed({ agent: agent("dev") }));
		await flush();
		await flush();
		expect(api.acpSend).toHaveBeenCalledTimes(1);
		// A second, different message while the first one is pending is a new send.
		t.input.value = "y también Y";
		submit(t);
		await flush();
		expect(api.acpSend).toHaveBeenCalledTimes(2);
		expect(api.acpSend.mock.calls[0]![2].clientId).not.toBe(api.acpSend.mock.calls[1]![2].clientId);
	});

	it("a retry of a long message reuses its id AND the exact body (no second upload)", async () => {
		api.acpFeed.mockResolvedValue(feed({ agent: agent("dev"), maxMessageBytes: 8 }));
		api.uploadSessionFiles.mockResolvedValue({ paths: ["/home/developer/uploads/m.md"] });
		api.acpSend.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce(msg(4));
		const t = mount();
		t.open({ kind: "agent", name: "dev" });
		await flush();
		t.input.value = "un mensaje largo";
		submit(t);
		await flush();
		await flush();
		expect(t.input.value).toBe("un mensaje largo");
		submit(t);
		await flush();
		await flush();
		expect(api.uploadSessionFiles).toHaveBeenCalledTimes(1);
		const [first, second] = api.acpSend.mock.calls;
		expect(second![1]).toBe(first![1]);
		expect(second![2].clientId).toBe(first![2].clientId);
	});

	it("an unknown leading mention sends nothing and keeps the text", async () => {
		api.acpProjectFeed.mockResolvedValue(
			feed({ project: { id: "p1", name: "P" }, agents: [agent("dev", "p1"), agent("qa", "p1")] }),
		);
		const t = mount();
		t.open({ kind: "project", projectId: "p1" });
		await flush();
		t.input.value = "@devv revisá con @qa";
		submit(t);
		await flush();
		await flush();
		expect(api.acpSend).not.toHaveBeenCalled();
		expect(t.input.value).toBe("@devv revisá con @qa");
		expect(t.root.querySelector(".acp-chat-error")?.textContent).toContain("@devv");
	});
});

describe("drafts", () => {
	it("each chat keeps its own draft; none follows the person into another chat", async () => {
		api.acpFeed.mockResolvedValue(feed());
		api.acpProjectFeed.mockResolvedValue(feed({ project: { id: "p1", name: "P" } }));
		const t = mount();
		t.open({ kind: "agent", name: "solo" });
		t.input.value = "para solo";
		t.open({ kind: "agent", name: "arq" });
		expect(t.input.value).toBe("");
		t.open({ kind: "project", projectId: "p1" });
		expect(t.input.value).toBe("");
		t.open({ kind: "agent", name: "solo" });
		expect(t.input.value).toBe("para solo");
	});

	it("a failed send gives the text back to its own chat, not to the one on screen", async () => {
		api.acpFeed.mockResolvedValue(feed({ agent: agent("solo") }));
		let fail!: (e: Error) => void;
		api.acpSend.mockReturnValueOnce(
			new Promise<AcpMessage>((_, rej) => {
				fail = rej;
			}),
		);
		const t = mount();
		t.open({ kind: "agent", name: "solo" });
		await flush();
		t.input.value = "importante";
		submit(t);
		await flush();
		t.open({ kind: "agent", name: "arq" });
		fail(new Error("503"));
		await flush();
		await flush();
		expect(t.input.value).toBe("");
		t.open({ kind: "agent", name: "solo" });
		expect(t.input.value).toBe("importante");
	});
});

describe("leaving and coming back", () => {
	it("a send that fails after A → B → A returns its text to A's field, with the error", async () => {
		api.acpFeed.mockResolvedValue(feed({ agent: agent("solo") }));
		let fail!: (e: Error) => void;
		api.acpSend.mockReturnValueOnce(
			new Promise<AcpMessage>((_, rej) => {
				fail = rej;
			}),
		);
		const t = mount();
		t.open({ kind: "agent", name: "solo" });
		await flush();
		t.input.value = "importante";
		submit(t);
		await flush();
		t.open({ kind: "agent", name: "arq" });
		t.open({ kind: "agent", name: "solo" });
		fail(new Error("503"));
		await flush();
		await flush();
		await flush();
		expect(t.input.value).toBe("importante");
		// Fixed words: who it did not reach, never the server's answer.
		expect(t.root.querySelector(".acp-chat-error")?.textContent).toBe("No se envió a @solo.");
	});
});

describe("a send that fails while the person is elsewhere", () => {
	function pendingSend() {
		let fail!: (e: Error) => void;
		api.acpSend.mockReturnValueOnce(
			new Promise<AcpMessage>((_, rej) => {
				fail = rej;
			}),
		);
		return (e: Error) => fail(e);
	}
	async function sendInSolo(t: InstanceType<typeof AcpThread>, text: string) {
		t.open({ kind: "agent", name: "solo" });
		await flush();
		t.input.value = text;
		submit(t);
		await flush();
	}
	const settle = async () => {
		for (let i = 0; i < 4; i++) await flush();
	};
	const errorText = (t: InstanceType<typeof AcpThread>) => {
		const e = t.root.querySelector<HTMLElement>(".acp-chat-error")!;
		return e.hidden ? "" : (e.textContent ?? "");
	};
	const recoverBtn = (t: InstanceType<typeof AcpThread>) =>
		t.root.querySelector<HTMLButtonElement>(".acp-recover")!;

	it("A → B: nothing of A shows in B; back in A, the text and the error are there", async () => {
		api.acpFeed.mockResolvedValue(feed({ agent: agent("solo") }));
		const fail = pendingSend();
		const t = mount();
		await sendInSolo(t, "importante");
		t.open({ kind: "agent", name: "arq" });
		fail(new Error("503"));
		await settle();
		expect(t.input.value).toBe("");
		expect(errorText(t)).toBe("");
		t.open({ kind: "agent", name: "solo" });
		await settle();
		expect(t.input.value).toBe("importante");
		expect(errorText(t)).toBe("No se envió a @solo.");
	});

	it("over another draft of A the text is offered, never written over it", async () => {
		api.acpFeed.mockResolvedValue(feed({ agent: agent("solo") }));
		const fail = pendingSend();
		const t = mount();
		await sendInSolo(t, "importante");
		t.input.value = "otro borrador";
		t.open({ kind: "agent", name: "arq" });
		fail(new Error("503"));
		await settle();
		t.open({ kind: "agent", name: "solo" });
		await settle();
		expect(t.input.value).toBe("otro borrador");
		expect(recoverBtn(t).hidden).toBe(false);
		recoverBtn(t).click();
		expect(t.input.value).toBe("otro borrador\n\nimportante");
		await settle();
		expect(recoverBtn(t).hidden).toBe(true);
	});

	it("the retry after coming back keeps the client id (an ambiguous failure is not duplicated)", async () => {
		api.acpFeed.mockResolvedValue(feed({ agent: agent("solo") }));
		const fail = pendingSend();
		const t = mount();
		await sendInSolo(t, "importante");
		t.open({ kind: "agent", name: "arq" });
		fail(new Error("timeout"));
		await settle();
		t.open({ kind: "agent", name: "solo" });
		await settle();
		api.acpSend.mockResolvedValueOnce(msg(7, { to_id: "solo" }));
		submit(t);
		await settle();
		const [first, retry] = api.acpSend.mock.calls;
		expect(retry![2].clientId).toBe(first![2].clientId);
		expect(errorText(t)).toBe("");
	});
});

describe("consistency", () => {
	it("a late page does not undo a newer row that arrived live", async () => {
		const page = deferred<AcpFeed>();
		api.acpFeed.mockReturnValueOnce(page.promise);
		const t = mount();
		t.open({ kind: "agent", name: "dev" });
		live.listener!({ type: "message", message: msg(5, { state: "done", result_text: "ok" }) });
		// The page was read before #5 finished.
		page.resolve(feed({ agent: agent("dev"), messages: [msg(5, { state: "running" })] }));
		await flush();
		await flush();
		expect(t.root.querySelector(".acp-badge")?.textContent).toBe("hecho");
	});

	it("a requeue answered after switching chats changes nothing in the chat on screen", async () => {
		api.acpFeed.mockResolvedValueOnce(
			feed({ agent: agent("dev"), messages: [msg(3, { state: "uncertain" })] }),
		);
		const requeue = deferred<AcpMessage>();
		api.acpRequeue.mockReturnValueOnce(requeue.promise);
		const t = mount();
		t.open({ kind: "agent", name: "dev" });
		await flush();
		await flush();
		const again = [...t.root.querySelectorAll("button")].find(
			(b) => b.textContent === "Volver a encolar",
		)!;
		again.click();
		api.acpFeed.mockResolvedValueOnce(feed({ agent: agent("qa"), messages: [] }));
		t.open({ kind: "agent", name: "qa" });
		await flush();
		requeue.resolve(msg(3, { state: "pending" }));
		await flush();
		await flush();
		expect(t.root.querySelectorAll(".acp-msg")).toHaveLength(0);
	});

	it("a live event re-renders without replacing the messages that did not change", async () => {
		api.acpFeed.mockResolvedValueOnce(
			feed({
				agent: agent("dev"),
				messages: [msg(1, { state: "done", result_text: "## Hecho\n\n`x`" })],
			}),
		);
		const t = mount();
		t.open({ kind: "agent", name: "dev" });
		await flush();
		await flush();
		const before = t.root.querySelector(".acp-msg");
		expect(before?.querySelector(".acp-msg-result h2")?.textContent).toBe("Hecho");
		live.listener!({ type: "message", message: msg(2) });
		await flush();
		await flush();
		expect(t.root.querySelectorAll(".acp-msg")).toHaveLength(2);
		expect(t.root.querySelector(".acp-msg")).toBe(before);
	});
});
