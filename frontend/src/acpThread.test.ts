/**
 * acpThread.test.ts — the ACP thread's races under jsdom, with the network
 * (api.ts) and the live socket (acpLive.ts) mocked: a send is reserved before
 * any await, drafts belong to their topic, a late page never undoes a newer
 * live row, a late answer lands only in the topic it was asked from, a
 * re-render keeps the elements that did not change — and an Archive chat
 * writes nothing.
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
	acpConversationFeed: vi.fn(),
	acpReadConversation: vi.fn(() => new Promise(() => {})),
	acpPost: vi.fn(),
	acpSend: vi.fn(),
	acpRequeue: vi.fn(),
	acpReview: vi.fn(),
	acpInbox: vi.fn(() => new Promise(() => {})),
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
/** A topic of project p1 whose recipients are `to` (its server-kept «Para:»). */
const conv = (id: string, to: string[] = ["solo"]) => ({
	id,
	projectId: "p1",
	title: id,
	createdAt: "2026-11-18T10:00:00Z",
	lastActivityAt: "2026-11-18T10:00:00Z",
	archivedAt: null,
	readAt: null,
	recipients: { agents: to },
});
const topic = (id: string) => ({
	kind: "conversation" as const,
	conversationId: id,
	projectId: "p1",
});
/** The feed of topic `id`, its agents `names` (in p1). */
const topicFeed = (id: string, names: string[], over: Partial<AcpFeed> = {}) =>
	feed({
		conversation: conv(id, names.slice(0, 1)) as AcpFeed["conversation"],
		agents: names.map((n) => agent(n, "p1")),
		...over,
	});
/** Each topic answers with its own feed: A = «solo», B = «arq». */
function twoTopics(over: Partial<AcpFeed> = {}) {
	api.acpConversationFeed.mockImplementation(async (id: string) =>
		topicFeed(id, id === "A" ? ["solo"] : ["arq"], over),
	);
}
const inTopic = (m: AcpMessage, cid: string) => ({ ...m, conversation_id: cid, project_id: "p1" });
const submit = (t: InstanceType<typeof AcpThread>) =>
	t.root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));

describe("sending", () => {
	it("two quick submits of the same draft send once, even while the page is still loading", async () => {
		const page = deferred<AcpFeed>();
		api.acpConversationFeed.mockReturnValueOnce(page.promise);
		api.acpPost.mockResolvedValue({ messages: [inTopic(msg(9, { to_id: "solo" }), "A")] });
		const t = mount();
		t.open(topic("A"));
		t.input.value = "hacé X";
		api.acpConversationFeed.mockResolvedValue(topicFeed("A", ["solo"]));
		submit(t);
		submit(t);
		page.resolve(topicFeed("A", ["solo"]));
		await flush();
		await flush();
		expect(api.acpPost).toHaveBeenCalledTimes(1);
		// A second, different message while the first one is pending is a new send.
		t.input.value = "y también Y";
		submit(t);
		await flush();
		expect(api.acpPost).toHaveBeenCalledTimes(2);
		expect(api.acpPost.mock.calls[0]![3]).not.toBe(api.acpPost.mock.calls[1]![3]);
	});

	it("every message goes into its topic: one post, never a send without conversation", async () => {
		api.acpConversationFeed.mockResolvedValue(topicFeed("A", ["solo"]));
		api.acpPost.mockResolvedValue({ messages: [] });
		const t = mount();
		t.open(topic("A"));
		await flush();
		t.input.value = "hola";
		submit(t);
		await flush();
		await flush();
		expect(api.acpPost).toHaveBeenCalledWith("A", ["solo"], "hola", expect.any(String));
		expect(api.acpSend).not.toHaveBeenCalled();
	});

	it("a retry of a long message reuses its id AND the exact body (no second upload)", async () => {
		api.acpConversationFeed.mockResolvedValue(topicFeed("A", ["solo"], { maxMessageBytes: 8 }));
		api.uploadSessionFiles.mockResolvedValue({ paths: ["/home/developer/uploads/m.md"] });
		api.acpSend.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce(msg(4));
		const t = mount();
		t.open(topic("A"));
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
		expect(second![2]).toEqual(first![2]);
		expect(first![2].conversationId).toBe("A");
	});

	it("an unknown leading mention sends nothing and keeps the text", async () => {
		api.acpConversationFeed.mockResolvedValue(topicFeed("A", ["dev", "qa"]));
		const t = mount();
		t.open(topic("A"));
		await flush();
		t.input.value = "@devv revisá con @qa";
		submit(t);
		await flush();
		await flush();
		expect(api.acpPost).not.toHaveBeenCalled();
		expect(t.input.value).toBe("@devv revisá con @qa");
		expect(t.root.querySelector(".acp-chat-error")?.textContent).toContain("@devv");
	});
});

describe("drafts", () => {
	it("each topic keeps its own draft; none follows the person into another topic", async () => {
		twoTopics();
		const t = mount();
		t.open(topic("A"));
		t.input.value = "para A";
		t.open(topic("B"));
		expect(t.input.value).toBe("");
		t.open(topic("A"));
		expect(t.input.value).toBe("para A");
	});

	it("a failed send gives the text back to its own topic, not to the one on screen", async () => {
		twoTopics();
		let fail!: (e: Error) => void;
		api.acpPost.mockReturnValueOnce(
			new Promise((_, rej) => {
				fail = rej;
			}),
		);
		const t = mount();
		t.open(topic("A"));
		await flush();
		t.input.value = "importante";
		submit(t);
		await flush();
		t.open(topic("B"));
		fail(new Error("503"));
		await flush();
		await flush();
		expect(t.input.value).toBe("");
		t.open(topic("A"));
		expect(t.input.value).toBe("importante");
	});
});

describe("a send that fails while the person is elsewhere", () => {
	function pendingSend() {
		let fail!: (e: Error) => void;
		api.acpPost.mockReturnValueOnce(
			new Promise((_, rej) => {
				fail = rej;
			}),
		);
		return (e: Error) => fail(e);
	}
	async function sendInA(t: InstanceType<typeof AcpThread>, text: string) {
		t.open(topic("A"));
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

	it("a refusal the person can act on says why, in fixed words; any other stays plain", async () => {
		twoTopics();
		let fail = pendingSend();
		const t = mount();
		await sendInA(t, "importante");
		fail(Object.assign(new Error("bad"), { status: 400, code: "not-in-project" }));
		await settle();
		expect(errorText(t)).toBe("No se envió a @solo (ya no está en este proyecto).");
		t.input.value = "";
		fail = pendingSend();
		await sendInA(t, "otro");
		fail(Object.assign(new Error("internal"), { status: 500, code: "internal" }));
		await settle();
		expect(errorText(t)).toBe("No se envió a @solo.");
	});

	it("A → B → A: nothing of A shows in B; back in A, the text and the error are there", async () => {
		twoTopics();
		const fail = pendingSend();
		const t = mount();
		await sendInA(t, "importante");
		t.open(topic("B"));
		fail(new Error("503"));
		await settle();
		expect(t.input.value).toBe("");
		expect(errorText(t)).toBe("");
		t.open(topic("A"));
		await settle();
		expect(t.input.value).toBe("importante");
		// Fixed words: who it did not reach, never the server's answer.
		expect(errorText(t)).toBe("No se envió a @solo.");
	});

	it("over another draft of A the text is offered, never written over it", async () => {
		twoTopics();
		const fail = pendingSend();
		const t = mount();
		await sendInA(t, "importante");
		t.input.value = "otro borrador";
		t.open(topic("B"));
		fail(new Error("503"));
		await settle();
		t.open(topic("A"));
		await settle();
		expect(t.input.value).toBe("otro borrador");
		expect(recoverBtn(t).hidden).toBe(false);
		recoverBtn(t).click();
		expect(t.input.value).toBe("otro borrador\n\nimportante");
		await settle();
		expect(recoverBtn(t).hidden).toBe(true);
	});

	it("the retry after coming back keeps the client id (an ambiguous failure is not duplicated)", async () => {
		twoTopics();
		const fail = pendingSend();
		const t = mount();
		await sendInA(t, "importante");
		t.open(topic("B"));
		fail(new Error("timeout"));
		await settle();
		t.open(topic("A"));
		await settle();
		api.acpPost.mockResolvedValueOnce({ messages: [] });
		submit(t);
		await settle();
		const [first, retry] = api.acpPost.mock.calls;
		expect(retry![3]).toBe(first![3]);
		expect(errorText(t)).toBe("");
	});
});

describe("consistency", () => {
	it("a late page does not undo a newer row that arrived live", async () => {
		const page = deferred<AcpFeed>();
		api.acpConversationFeed.mockReturnValueOnce(page.promise);
		const t = mount();
		t.open(topic("A"));
		live.listener!({
			type: "message",
			message: inTopic(msg(5, { to_id: "solo", state: "done", result_text: "ok" }), "A"),
		});
		// The page was read before #5 finished.
		page.resolve(
			topicFeed("A", ["solo"], {
				messages: [inTopic(msg(5, { to_id: "solo", state: "running" }), "A")],
			}),
		);
		await flush();
		await flush();
		expect(t.root.querySelector(".acp-result .acp-msg-result")?.textContent).toBe("ok");
	});

	it("a requeue (from the review, after acknowledging) answered after switching topics changes nothing on screen", async () => {
		api.acpConversationFeed.mockResolvedValueOnce(
			topicFeed("A", ["solo"], {
				messages: [inTopic(msg(3, { to_id: "solo", state: "uncertain" }), "A")],
			}),
		);
		const requeue = deferred<AcpMessage>();
		api.acpRequeue.mockReturnValueOnce(requeue.promise);
		const t = mount();
		t.open(topic("A"));
		await flush();
		await flush();
		// Never a one-tap retry: the review's requeue is locked until acknowledged.
		[...t.root.querySelectorAll("button")]
			.find((b) => b.textContent === "Revisar interrupción")!
			.click();
		const dialog = document.querySelector(".acp-review")!;
		const again = dialog.querySelector<HTMLButtonElement>(".acp-review-requeue-btn")!;
		expect(again.disabled).toBe(true);
		const ack = dialog.querySelector<HTMLInputElement>(".acp-review-ack input")!;
		ack.checked = true;
		ack.dispatchEvent(new Event("change"));
		expect(again.disabled).toBe(false);
		again.click();
		expect(api.acpRequeue).toHaveBeenCalledWith(3);
		api.acpConversationFeed.mockResolvedValueOnce(topicFeed("B", ["arq"]));
		t.open(topic("B"));
		await flush();
		requeue.resolve(inTopic(msg(3, { to_id: "solo", state: "pending" }), "A"));
		await flush();
		await flush();
		expect(t.root.querySelectorAll(".acp-msg")).toHaveLength(0);
	});

	it("a live event re-renders without replacing the messages that did not change", async () => {
		api.acpConversationFeed.mockResolvedValueOnce(
			topicFeed("A", ["solo"], {
				messages: [
					inTopic(msg(1, { to_id: "solo", state: "done", result_text: "## Hecho\n\n`x`" }), "A"),
				],
			}),
		);
		const t = mount();
		t.open(topic("A"));
		await flush();
		await flush();
		const before = t.root.querySelector(".acp-msg");
		expect(t.root.querySelector(".acp-msg-result h2")?.textContent).toBe("Hecho");
		live.listener!({ type: "message", message: inTopic(msg(2, { to_id: "solo" }), "A") });
		await flush();
		await flush();
		expect(t.root.querySelectorAll(".acp-post")).toHaveLength(2);
		expect(t.root.querySelector(".acp-msg")).toBe(before);
	});
});

describe("an Archive chat", () => {
	const archive = (agent: string | null) => ({ kind: "archive" as const, projectId: "p1", agent });

	it("writes nothing: no message box, its interruption is reviewed in Pendientes", async () => {
		api.acpProjectFeed.mockResolvedValue(
			feed({
				project: { id: "p1", name: "P" },
				agents: [agent("solo", "p1")],
				messages: [msg(3, { to_id: "solo", state: "uncertain", project_id: "p1" })],
			}),
		);
		const t = mount();
		t.setComposer("off");
		t.open(archive(null));
		await flush();
		await flush();
		expect(t.root.querySelector("form")!.classList.contains("acp-composer-off")).toBe(true);
		const buttons = [...t.root.querySelectorAll("button")].map((b) => b.textContent);
		expect(buttons).not.toContain("Revisar interrupción");
		expect(t.root.textContent).toContain("revisala en Pendientes");
		t.input.value = "algo";
		submit(t);
		await flush();
		expect(api.acpPost).not.toHaveBeenCalled();
		expect(api.acpSend).not.toHaveBeenCalled();
	});

	it("an agent's chat is its direct part only; «Cargar anteriores» goes past a page without any", async () => {
		const page = (from: number, direct: boolean) =>
			Array.from({ length: 100 }, (_, i) =>
				msg(from + i, { to_id: "solo", project_id: direct && i === 99 ? null : "p1" }),
			);
		api.acpFeed
			.mockResolvedValueOnce(feed({ agent: agent("solo", "p1"), messages: page(201, true) }))
			.mockResolvedValueOnce(feed({ agent: agent("solo", "p1"), messages: page(101, false) }))
			.mockResolvedValueOnce(
				feed({ agent: agent("solo", "p1"), messages: [msg(50, { to_id: "solo" })] }),
			);
		const t = mount();
		t.open(archive("solo"));
		await flush();
		await flush();
		expect(t.root.querySelectorAll(".acp-post")).toHaveLength(1);
		const more = () => t.root.querySelector<HTMLButtonElement>(".acp-more")!;
		more().click();
		await flush();
		await flush();
		expect(api.acpFeed).toHaveBeenLastCalledWith("solo", 201);
		more().click();
		await flush();
		await flush();
		expect(api.acpFeed).toHaveBeenLastCalledWith("solo", 101);
		await flush();
		expect(t.root.querySelectorAll(".acp-post")).toHaveLength(2);
		expect(t.root.querySelector(".acp-more")).toBeNull();
	});
});
