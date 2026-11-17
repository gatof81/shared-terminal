import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "./conversationModel.js";

// teamView.ts against a fake api: the workspace renders the log and the
// directory, and the composer sends exactly what the person chose.

const api = vi.hoisted(() => ({
	fetchProjectEvents: vi.fn(),
	fetchProjectMessage: vi.fn(),
	postProjectMessage: vi.fn(),
	postProjectAck: vi.fn(),
	openProjectSocket: vi.fn((_pid: string, _frame: unknown, _state: unknown) => ({
		follow: vi.fn(),
		close: vi.fn(),
	})),
	readConversationEvent: vi.fn(),
	// §3.6
	projectQueueEnabled: vi.fn(() => false),
	cancelQueuedProjectMessage: vi.fn(),
	// D3
	projectRelayEnabled: vi.fn(() => false),
	postGrantAction: vi.fn(),
	// D2
	projectArtifactsEnabled: vi.fn(() => false),
	registerProjectArtifact: vi.fn(),
	fetchProjectArtifactText: vi.fn(),
	listWorkspaceDir: vi.fn(),
	WorkspaceFsError: class extends Error {
		constructor(
			m: string,
			readonly status: number,
		) {
			super(m);
		}
	},
}));
vi.mock("./api.js", () => api);

type View = typeof import("./teamView.js");

const PID = "p1";
const DEV = "a-dev";
const QA = "a-qa";
const ASK = "a-ask";
const NOW = "2026-11-11T12:30:00.000Z";
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const agent = (agentId: string, handle: string, presence: Record<string, unknown>) => ({
	agentId,
	handle,
	role: "Developer",
	provider: "claude",
	template: null,
	binding: { bindingId: `b-${agentId}`, epoch: 1, sessionId: `s-${agentId}`, state: "active" },
	presence,
});
const agents = [
	agent(DEV, "dev-pilot", { value: "working", source: "hook", at: "2026-11-11T12:29:40.000Z" }),
	agent(QA, "qa-pilor", {
		value: "waiting_input",
		source: "probe",
		at: "2026-11-11T12:29:00.000Z",
		verified: true,
	}),
	agent(ASK, "infra-pilot", {
		value: "needs_attention",
		detail: "waiting_permission",
		source: "hook",
		at: "2026-11-11T12:28:00.000Z",
	}),
];

const REPLY = "Done: adaptive cadence. 628 tests pass.";
const log = [
	{
		seq: 1,
		at: NOW,
		ev: "message",
		msg_id: "t1",
		kind: "owner",
		to: [DEV],
		text: "Adaptive polling\nbody",
	},
	{ seq: 2, at: NOW, ev: "delivery", msg_id: "t1", agent_id: DEV, state: "delivered" },
	{ seq: 3, at: NOW, ev: "message", msg_id: "t2", kind: "owner", to: [QA], text: "Release notes" },
	{ seq: 4, at: NOW, ev: "delivery", msg_id: "t2", agent_id: QA, state: "refused", reason: "busy" },
	{
		seq: 5,
		at: NOW,
		ev: "reply_ref",
		msg_id: "t1",
		agent_id: DEV,
		sid: "s-dev",
		cid: "c-dev",
		prompt_id: "p1",
		turn_end_seq: 77,
		report_sha256: sha(REPLY),
		report_bytes: 40,
		truncated: false,
		attribution: "exact",
	},
];

let view: View;
let header: HTMLElement;

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(panel: Parameters<View["teamWorkspace"]>[0]["panel"], list: unknown[] = agents) {
	const root = view.teamWorkspace({
		projectId: PID,
		panel,
		agents: list as never,
		clock: { generatedAt: NOW, receivedAt: Date.now() },
		header,
	});
	if (!root.isConnected) document.body.append(root);
	return root;
}

beforeEach(async () => {
	vi.resetModules();
	document.body.replaceChildren();
	header = document.createElement("div");
	api.fetchProjectEvents.mockResolvedValue({
		ok: true,
		status: 200,
		body: { events: log, hasMore: false },
	});
	api.fetchProjectMessage.mockResolvedValue({ ok: false, status: 404, code: "not-found" });
	api.readConversationEvent.mockResolvedValue({
		ok: true,
		event: { seq: 77, ts: NOW, ev: "turn_end", data: { last_assistant_message: REPLY } },
	});
	api.postProjectMessage.mockResolvedValue({
		ok: true,
		status: 202,
		body: { msgId: "m-new", deliveries: [{ agentId: QA, state: "delivered" }] },
	});
	view = await import("./teamView.js");
});

afterEach(() => {
	view.resetWorkspaces();
	vi.clearAllMocks();
});

describe("Now", () => {
	it("shows the agents, For you by kind (permission from presence first) and the threads", async () => {
		const root = mount(null);
		await flush();
		const names = [...root.querySelectorAll(".tw-agent-name")].map((n) => n.textContent);
		expect(names).toEqual(["dev-pilot", "qa-pilor", "infra-pilot"]);
		const side = root.querySelector(".tw-foryou-inline")!;
		const titles = [...side.querySelectorAll(".tw-card b")].map((n) => n.textContent);
		expect(titles).toEqual([
			"@infra-pilot is asking for permission",
			"@dev-pilot replied to you",
			"Not delivered to @qa-pilor",
		]);
		// The reply's first line, verified against the log's hash.
		expect(side.querySelector(".tw-card-replied .tw-card-quote")?.textContent).toBe(REPLY);
		const rows = [...root.querySelectorAll(".tw-thread-row b")].map((n) => n.textContent);
		expect(rows).toEqual(["Adaptive polling", "Release notes"]);
	});

	it("never shows a reply whose text doesn't hash to the record", async () => {
		api.readConversationEvent.mockResolvedValue({
			ok: true,
			event: { seq: 77, ts: NOW, ev: "turn_end", data: { last_assistant_message: "tampered" } },
		});
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		const tl = root.querySelector(".tw-timeline")!;
		expect(tl.textContent).toContain("doesn't match what was recorded");
		expect(tl.textContent).not.toContain("tampered");
	});

	it("says the reply is no longer retained when the capture answers 404", async () => {
		api.readConversationEvent.mockResolvedValue({ ok: false, status: 404 });
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		expect(root.querySelector(".tw-timeline")?.textContent).toContain("Reply no longer retained");
	});
});

describe("Done", () => {
	it("writes an owner_ack for exactly that item; the card goes only when the log shows it", async () => {
		let events: unknown[] = [...log];
		api.fetchProjectEvents.mockImplementation(async () => ({
			ok: true,
			status: 200,
			body: { events, oldestSeq: 1, hasMore: false },
		}));
		api.postProjectAck.mockResolvedValueOnce({ ok: false, status: 0, code: "network" });
		const root = mount(null);
		await flush();
		const card = () => root.querySelector(".tw-foryou-inline .tw-card-replied");
		const done = () =>
			[...(card()?.querySelectorAll("button") ?? [])].find((b) =>
				/Done|Check/.test(b.textContent ?? ""),
			)!;
		done().click();
		await flush();
		expect(card()?.textContent).toContain("it may or may not be marked");
		const first = api.postProjectAck.mock.calls[0]![1];
		expect(first.target).toEqual({ msgId: "t1", agentId: DEV, reportSha256: sha(REPLY) });
		// Check: the same clientAckId again (the server answers from the log).
		api.postProjectAck.mockResolvedValueOnce({
			ok: true,
			status: 201,
			body: { ackId: "k1", replayed: false },
		});
		done().click();
		await flush();
		expect(api.postProjectAck.mock.calls[1]![1].clientAckId).toBe(first.clientAckId);
		// The log doesn't show the ack yet: the card stays, marking.
		expect(card()?.textContent).toContain("Marking…");
		// Now it does (as any other device would read it): the card is gone; the refusal stays.
		events = [
			...log,
			{
				seq: 6,
				at: NOW,
				ev: "owner_ack",
				ack_id: "k1",
				client_ack_id: first.clientAckId,
				by: "u",
				target: { msg_id: "t1", agent_id: DEV, report_sha256: sha(REPLY) },
			},
		];
		// The next poll (any device's) reads it.
		const { logStore } = await import("./teamLog.js");
		await logStore(PID).refresh();
		await flush();
		expect(card()).toBeNull();
		expect(root.querySelector(".tw-foryou-inline .tw-card-not-delivered")).not.toBeNull();
	});
});

describe("composer", () => {
	it("@ opens the picker; picking adds the chip; only chips are sent; the agent at a prompt can't be chosen", async () => {
		const root = mount({ kind: "new" });
		await flush();
		const text = root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!;
		text.value = "Review it @";
		text.setSelectionRange(text.value.length, text.value.length);
		text.dispatchEvent(new Event("input"));
		const options = [...root.querySelectorAll<HTMLButtonElement>(".tw-option")];
		expect(options.map((o) => o.querySelector("b")?.textContent)).toEqual([
			"@dev-pilot",
			"@qa-pilor",
			"@infra-pilot",
		]);
		expect(options[2]!.disabled).toBe(true);
		options[1]!.click();
		expect(text.value).toBe("Review it @qa-pilor ");
		// Typed but not picked: text only.
		text.value += "and ask @dev-pilot later";
		text.dispatchEvent(new Event("input"));
		expect(root.querySelector(".tw-hint")?.textContent).toBe("Only @qa-pilor will receive this.");
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		const body = api.postProjectMessage.mock.calls[0]![1];
		expect(body.to).toEqual([QA]);
		expect(body).not.toHaveProperty("inReplyTo");
		expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("an accepted send lists each recipient's own result — a 202 isn't everyone's receipt", async () => {
		api.postProjectMessage.mockResolvedValueOnce({
			ok: true,
			status: 202,
			body: {
				msgId: "m-mixed",
				replayed: false,
				deliveries: [
					{ agentId: DEV, state: "delivered" },
					{ agentId: QA, state: "refused", reason: "busy" },
				],
			},
		});
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		for (const i of [0, 0]) {
			root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
			root.querySelectorAll<HTMLButtonElement>(".tw-option:not(:disabled)")[i]!.click();
		}
		root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "both of you";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		const status = root.querySelector(".tw-send-status")!;
		expect(status.querySelector(".tw-partial")?.textContent).toBe(
			"Not every agent received this: 1 of 2 received it, 1 not delivered.",
		);
		expect([...status.querySelectorAll(".tw-results li")].map((l) => l.textContent)).toEqual([
			"@dev-pilot · Delivered ✓",
			"@qa-pilor · Not delivered: it was busy",
		]);
	});

	it("keeps focus and draft across a poll (the composer is never re-inserted)", async () => {
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		const text = root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!;
		text.focus();
		text.value = "half-typed";
		mount({ kind: "thread", msgId: "t1" }); // the project page's 5 s re-render
		await flush();
		expect(root.querySelector(".tw-composer textarea")).toBe(text);
		expect(document.activeElement).toBe(text);
		expect(text.value).toBe("half-typed");
	});

	it("Check answered by an error stays UNKNOWN (never 'nothing was sent'); the draft stays locked", async () => {
		api.postProjectMessage
			.mockResolvedValueOnce({ ok: false, status: 0, code: "network" })
			.mockResolvedValueOnce({ ok: false, status: 503, code: "project-writer-unavailable" });
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		const text = root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!;
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		root.querySelectorAll<HTMLButtonElement>(".tw-option")[0]!.click();
		text.value = "ship it";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		const check = () =>
			[...root.querySelectorAll<HTMLButtonElement>(".tw-send-status button")].find(
				(b) => b.textContent === "Check",
			)!;
		check().click();
		await flush();
		const status = root.querySelector(".tw-send-status")!.textContent ?? "";
		expect(status).toContain("may or may not have been sent");
		expect(status).toContain("couldn't answer the check");
		expect(status).not.toContain("Nothing was sent");
		expect(text.readOnly).toBe(true);
		expect(check()).toBeDefined();
		const ids = api.postProjectMessage.mock.calls.map((c) => c[1].clientMessageId);
		expect(new Set(ids).size).toBe(1);
	});

	it("a poll keeps the keyboard place: the focused Reply… is the same control after a re-render", async () => {
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		const reply = [...root.querySelectorAll<HTMLButtonElement>(".tw-timeline button")].find(
			(b) => b.textContent === "Reply…",
		)!;
		reply.focus();
		const { logStore } = await import("./teamLog.js");
		// Nothing new: no re-render at all (same node keeps focus).
		await logStore(PID).refresh();
		await flush();
		expect(document.activeElement).toBe(reply);
		// Something new: the timeline is rebuilt, focus lands on the same control by key.
		api.fetchProjectEvents.mockResolvedValue({
			ok: true,
			status: 200,
			body: {
				events: [
					...log,
					{ seq: 6, at: NOW, ev: "delivery", msg_id: "t2", agent_id: QA, state: "refused" },
				],
				oldestSeq: 1,
				hasMore: false,
			},
		});
		await logStore(PID).refresh();
		await flush();
		const now = document.activeElement as HTMLElement;
		expect(now.textContent).toBe("Reply…");
		expect(now.dataset.key).toBe(reply.dataset.key);
	});

	it("the project page's own re-render (agent poll) leaves an unchanged thread's DOM untouched", async () => {
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		const bubble = root.querySelector(".tw-bubble-agent")!;
		const card = root.querySelector(".tw-foryou-inline .tw-card")!;
		const sel = document.getSelection()!;
		sel.selectAllChildren(bubble);
		mount({ kind: "thread", msgId: "t1" }); // what projectsView does on every 5–15 s agent poll
		await flush();
		expect(root.querySelector(".tw-bubble-agent")).toBe(bubble);
		expect(root.querySelector(".tw-foryou-inline .tw-card")).toBe(card);
		expect(sel.toString()).toBe(REPLY);
	});

	it("results after a 202 follow the log once the message is folded (a 'sending' that ends later)", async () => {
		api.postProjectMessage.mockResolvedValueOnce({
			ok: true,
			status: 202,
			body: { msgId: "m7", replayed: false, deliveries: [{ agentId: QA, state: "sending" }] },
		});
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		[...root.querySelectorAll<HTMLButtonElement>(".tw-option")]
			.find((o) => o.textContent?.includes("qa-pilor"))!
			.click();
		root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "late one";
		api.fetchProjectEvents.mockResolvedValue({
			ok: true,
			status: 200,
			body: {
				events: [
					...log,
					{
						seq: 6,
						at: NOW,
						ev: "message",
						msg_id: "m7",
						kind: "owner",
						to: [QA],
						text: "late one",
						in_reply_to: "t1",
					},
					{ seq: 7, at: NOW, ev: "delivery", msg_id: "m7", agent_id: QA, state: "delivered" },
				],
				oldestSeq: 1,
				hasMore: false,
			},
		});
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		expect(
			[...root.querySelectorAll(".tw-send-status .tw-results li")].map((l) => l.textContent),
		).toEqual(["@qa-pilor · Delivered ✓"]);
	});

	it("Reply… quotes exactly that reply and answers its message", async () => {
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		[...root.querySelectorAll<HTMLButtonElement>(".tw-timeline button")]
			.find((b) => b.textContent === "Reply…")!
			.click();
		const text = root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!;
		text.value = "thanks";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		expect(api.postProjectMessage.mock.calls[0]![1]).toMatchObject({
			to: [DEV],
			inReplyTo: "t1",
			quoteRef: { msgId: "t1", agentId: DEV, promptId: "p1", reportSha256: sha(REPLY) },
		});
	});

	it("a lost answer offers Check, which repeats the SAME id; a refusal keeps the draft", async () => {
		api.postProjectMessage.mockResolvedValueOnce({ ok: false, status: 0, code: "network" });
		const root = mount({ kind: "thread", msgId: "t1" });
		await flush();
		const text = root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!;
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		root.querySelectorAll<HTMLButtonElement>(".tw-option")[0]!.click();
		text.value = "ship it";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		const status = root.querySelector(".tw-send-status")!;
		expect(status.textContent).toContain("may or may not have been sent");
		[...status.querySelectorAll("button")].find((b) => b.textContent === "Check")!.click();
		await flush();
		const [a, b] = api.postProjectMessage.mock.calls.map((c) => c[1]);
		expect(b.clientMessageId).toBe(a.clientMessageId);
		expect(text.value).toBe("");

		api.postProjectMessage.mockResolvedValueOnce({
			ok: false,
			status: 409,
			code: "project-log-full",
		});
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		root.querySelectorAll<HTMLButtonElement>(".tw-option")[0]!.click();
		text.value = "second";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		expect(root.querySelector(".tw-send-status")?.textContent).toContain("conversation is full");
		expect(text.value).toBe("second");
	});
});

describe("live mode recovery (independent review of #599)", () => {
	it("a first load that failed starts the socket once a later poll succeeds", async () => {
		vi.useFakeTimers();
		try {
			api.fetchProjectEvents
				.mockResolvedValueOnce({ ok: false, status: 0, code: "network" })
				.mockResolvedValue({
					ok: true,
					status: 200,
					body: { events: log, oldestSeq: 1, hasMore: false },
				});
			mount(null);
			await vi.advanceTimersByTimeAsync(10);
			expect(api.openProjectSocket).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(5_100); // the 5 s poll
			expect(api.openProjectSocket).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("when the socket drops, the 5 s poll resumes at once (not after the 30 s safety timer)", async () => {
		vi.useFakeTimers();
		try {
			let state: ((c: boolean, r?: boolean) => void) | undefined;
			api.openProjectSocket.mockImplementation((_p: string, _f: unknown, st: unknown) => {
				state = st as (c: boolean, r?: boolean) => void;
				return { follow: vi.fn(), close: vi.fn() };
			});
			mount(null);
			await vi.advanceTimersByTimeAsync(10);
			state!(true); // live: the poll re-arms at 30 s
			await vi.advanceTimersByTimeAsync(10);
			const calls = api.fetchProjectEvents.mock.calls.length;
			state!(false, true); // refused
			await vi.advanceTimersByTimeAsync(5_100);
			expect(api.fetchProjectEvents.mock.calls.length).toBeGreaterThan(calls);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("attachments (D2)", () => {
	const DIFF = "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
	const FIX = { sha256: sha(DIFF), name: "fix.diff", bytes: DIFF.length };
	const withFile = [
		...log,
		{
			seq: 6,
			at: NOW,
			ev: "artifact",
			sha256: FIX.sha256,
			name: FIX.name,
			bytes: FIX.bytes,
			source: { kind: "owner", sid: "s-a-dev", path: "out/fix.diff", agent_id: DEV },
			by: "u1",
		},
		{
			seq: 7,
			at: NOW,
			ev: "message",
			msg_id: "t3",
			kind: "owner",
			to: [QA],
			text: "Apply this",
			artifacts: [FIX],
		},
		{
			seq: 8,
			at: NOW,
			ev: "delivery",
			msg_id: "t3",
			agent_id: QA,
			state: "placing",
			artifacts: [FIX],
		},
		{
			seq: 9,
			at: NOW,
			ev: "delivery",
			msg_id: "t3",
			agent_id: QA,
			state: "uncertain",
			reason: "uncertain{restored}",
			files_possibly_placed: true,
		},
	];

	it("flag off: no attach control, a message's files are names only, and nothing is requested", async () => {
		api.fetchProjectEvents.mockResolvedValue({
			ok: true,
			status: 200,
			body: { events: withFile, hasMore: false },
		});
		const root = mount({ kind: "thread", msgId: "t3" });
		await flush();
		expect(root.querySelector(".tw-attach")).toBeNull();
		expect(root.querySelector(".tw-msg-files")?.textContent).toBe("fix.diff · 48 B");
		expect(root.querySelector(".tw-file-open")).toBeNull();
		expect(api.fetchProjectArtifactText).not.toHaveBeenCalled();
		expect(api.registerProjectArtifact).not.toHaveBeenCalled();
	});

	it("uncertain after placing warns that files may already be in the inbox (restore, §8)", async () => {
		api.fetchProjectEvents.mockResolvedValue({
			ok: true,
			status: 200,
			body: { events: withFile, hasMore: false },
		});
		const root = mount({ kind: "thread", msgId: "t3" });
		await flush();
		expect(root.querySelector(".tw-deliveries")?.textContent).toBe(
			"@qa-pilor · Not sure it arrived. Some files may already be in its inbox.",
		);
	});

	it("flag on: a file opens as a verified diff in place and stays open across a poll", async () => {
		api.projectArtifactsEnabled.mockReturnValue(true);
		api.fetchProjectEvents.mockResolvedValue({
			ok: true,
			status: 200,
			body: { events: withFile, hasMore: false },
		});
		api.fetchProjectArtifactText.mockResolvedValue({ ok: true, text: DIFF });
		const root = mount({ kind: "thread", msgId: "t3" });
		await flush();
		root.querySelector<HTMLButtonElement>(".tw-file-open")!.click();
		await flush();
		expect(api.fetchProjectArtifactText).toHaveBeenCalledWith(PID, FIX.sha256);
		expect(root.querySelectorAll(".tw-file-body .git-diff-row.kind-add")).toHaveLength(1);
		mount({ kind: "thread", msgId: "t3" });
		await flush();
		expect(root.querySelector(".tw-file-body")).not.toBeNull();
		expect(api.fetchProjectArtifactText).toHaveBeenCalledTimes(1);
	});

	it("a file whose bytes don't match its hash is never shown", async () => {
		api.projectArtifactsEnabled.mockReturnValue(true);
		api.fetchProjectEvents.mockResolvedValue({
			ok: true,
			status: 200,
			body: { events: withFile, hasMore: false },
		});
		api.fetchProjectArtifactText.mockResolvedValue({
			ok: false,
			status: 200,
			code: "hash-mismatch",
		});
		const root = mount({ kind: "thread", msgId: "t3" });
		await flush();
		root.querySelector<HTMLButtonElement>(".tw-file-open")!.click();
		await flush();
		expect(root.querySelector(".tw-file-body")?.textContent).toBe(
			"The stored file doesn't match its hash; it isn't shown.",
		);
	});

	it("attach: browse the agent's session, register the file, send its sha256; a refusal attaches nothing", async () => {
		api.projectArtifactsEnabled.mockReturnValue(true);
		api.listWorkspaceDir.mockImplementation(async (_sid: string, path: string) =>
			path === ""
				? {
						path: "",
						truncated: false,
						entries: [
							{ name: "out", type: "dir", size: null, mtime: null, restricted: false },
							{ name: ".env", type: "file", size: 10, mtime: null, restricted: true },
							{ name: "big.log", type: "file", size: 2_000_000, mtime: null, restricted: false },
							{ name: "bin.dat", type: "file", size: 10, mtime: null, restricted: false },
						],
					}
				: {
						path: "out",
						truncated: false,
						entries: [{ name: "fix.diff", type: "file", size: 75, mtime: null, restricted: false }],
					},
		);
		api.registerProjectArtifact
			.mockResolvedValueOnce({ ok: false, status: 415, code: "artifact-not-text" })
			.mockResolvedValueOnce({ ok: true, status: 201, body: { ...FIX, replayed: false } });
		const root = mount({ kind: "new" });
		await flush();
		root.querySelector<HTMLButtonElement>(".tw-attach-btn")!.click();
		const agentsBtns = [...root.querySelectorAll<HTMLButtonElement>(".tw-attach-agent")];
		agentsBtns[0]!.click(); // @dev-pilot
		await flush();
		expect(api.listWorkspaceDir).toHaveBeenCalledWith("s-a-dev", "");
		const entries = () => [...root.querySelectorAll<HTMLButtonElement>(".tw-attach-entry")];
		expect(entries().map((b) => [b.textContent, b.disabled])).toEqual([
			["out/Folder", false],
			[".envprotected", true],
			["big.logbigger than 1 MiB", true],
			["bin.dat10 B", false],
		]);
		entries()[3]!.click();
		await flush();
		expect(api.registerProjectArtifact).toHaveBeenLastCalledWith(PID, {
			agentId: DEV,
			path: "bin.dat",
		});
		expect(root.querySelector(".tw-attach-note")?.textContent).toBe(
			"Only text files can be attached (no binaries, no empty files).",
		);
		expect(root.querySelector(".tw-files")?.childElementCount).toBe(0);
		entries()[0]!.click();
		await flush();
		entries()[1]!.click(); // out/fix.diff (entry 0 is "..")
		await flush();
		expect(api.registerProjectArtifact).toHaveBeenLastCalledWith(PID, {
			agentId: DEV,
			path: "out/fix.diff",
		});
		expect(root.querySelector(".tw-files")?.textContent).toBe("fix.diff48 B×");
		// Recipient + text, then send: the body carries the sha256.
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		root.querySelectorAll<HTMLButtonElement>(".tw-option:not(:disabled)")[1]!.click(); // @qa-pilor
		root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "Apply this";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		expect(api.postProjectMessage.mock.calls[0]![1].artifacts).toEqual([FIX.sha256]);
		expect(root.querySelector(".tw-files")?.childElementCount).toBe(0);
	});

	it("a delivery answered not-sent after placing says so in the send's results", async () => {
		api.projectArtifactsEnabled.mockReturnValue(true);
		api.postProjectMessage.mockResolvedValueOnce({
			ok: true,
			status: 202,
			body: {
				msgId: "m-x",
				deliveries: [
					{ agentId: QA, state: "not-sent", reason: "binding-changed", filesPossiblyPlaced: true },
				],
			},
		});
		const root = mount({ kind: "new" });
		await flush();
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		root.querySelectorAll<HTMLButtonElement>(".tw-option:not(:disabled)")[1]!.click();
		root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "x";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		expect(root.querySelector(".tw-results")?.textContent).toBe(
			"@qa-pilor · Not delivered: its session changed. Some files may already be in its inbox.",
		);
	});

	describe("late register answers never edit the current draft (review of #603)", () => {
		const FILE = { name: "fix.diff", type: "file", size: 48, mtime: null, restricted: false };
		const OTHER = { name: "notes.md", type: "file", size: 12, mtime: null, restricted: false };
		const ok = (f: typeof FIX) => ({ ok: true, status: 201, body: { ...f, replayed: false } });
		const deferred = () => {
			let resolve!: (v: unknown) => void;
			const promise = new Promise((r) => {
				resolve = r;
			});
			return { promise, resolve };
		};
		let root: HTMLElement;
		const entries = () => [...root.querySelectorAll<HTMLButtonElement>(".tw-attach-entry")];
		const fromAgent = async (i: number) => {
			root.querySelectorAll<HTMLButtonElement>(".tw-attach-agent")[i]!.click();
			await flush();
		};
		const chips = () => root.querySelector(".tw-files")!.childElementCount;
		const note = () => root.querySelector(".tw-attach-note")?.textContent;

		beforeEach(async () => {
			api.projectArtifactsEnabled.mockReturnValue(true);
			api.listWorkspaceDir.mockImplementation(async (sid: string) => ({
				path: "",
				truncated: false,
				entries: sid === "s-a-dev" ? [FILE] : [OTHER],
			}));
			root = mount({ kind: "new" });
			await flush();
			root.querySelector<HTMLButtonElement>(".tw-attach-btn")!.click();
			await fromAgent(0); // @dev-pilot
		});

		it("another agent chosen while pending: the old answer adds nothing", async () => {
			const d = deferred();
			api.registerProjectArtifact.mockReturnValueOnce(d.promise);
			entries()[0]!.click();
			await fromAgent(1); // @qa-pilor
			d.resolve(ok(FIX));
			await flush();
			expect(chips()).toBe(0);
			expect(note()).toBe(
				"fix.diff was not attached: the choice changed while it was being registered.",
			);
			// The new choice is fully usable.
			expect(entries()[0]!.disabled).toBe(false);
		});

		it("panel closed while pending: the old answer adds nothing", async () => {
			const d = deferred();
			api.registerProjectArtifact.mockReturnValueOnce(d.promise);
			entries()[0]!.click();
			root.querySelector<HTMLButtonElement>(".tw-attach-btn")!.click(); // close
			d.resolve(ok(FIX));
			await flush();
			expect(chips()).toBe(0);
		});

		it("the agent's binding moved to another session while pending: the old answer adds nothing", async () => {
			const d = deferred();
			api.registerProjectArtifact.mockReturnValueOnce(d.promise);
			entries()[0]!.click();
			const moved = agents.map((a) =>
				a.agentId === DEV ? { ...a, binding: { ...a.binding, epoch: 2, sessionId: "s-new" } } : a,
			);
			mount({ kind: "new" }, moved); // the project page's poll brings the new directory
			await flush();
			d.resolve(ok(FIX));
			await flush();
			expect(chips()).toBe(0);
		});

		it("draft sent while pending: the answer never joins the next draft", async () => {
			const d = deferred();
			api.registerProjectArtifact.mockReturnValueOnce(d.promise);
			entries()[0]!.click();
			root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
			root.querySelectorAll<HTMLButtonElement>(".tw-option:not(:disabled)")[1]!.click();
			root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "no file yet";
			root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
			await flush();
			expect(api.postProjectMessage.mock.calls[0]![1]).not.toHaveProperty("artifacts");
			d.resolve(ok(FIX));
			await flush();
			expect(chips()).toBe(0);
			// The next send carries nothing it didn't attach itself.
			root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
			root.querySelectorAll<HTMLButtonElement>(".tw-option:not(:disabled)")[1]!.click();
			root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "next";
			root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
			await flush();
			expect(api.postProjectMessage.mock.calls[1]![1]).not.toHaveProperty("artifacts");
		});

		it("a stale answer neither adds its file nor touches a newer registration in flight", async () => {
			const first = deferred();
			const second = deferred();
			const NOTES = { sha256: sha("notes"), name: "notes.md", bytes: 12 };
			api.registerProjectArtifact
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise);
			entries()[0]!.click(); // dev: fix.diff
			await fromAgent(1);
			entries()[0]!.click(); // qa: notes.md
			first.resolve(ok(FIX));
			await flush();
			expect(chips()).toBe(0);
			expect(note()).toBe("Attaching notes.md…");
			second.resolve(ok(NOTES));
			await flush();
			expect(root.querySelector(".tw-files")?.textContent).toBe("notes.md12 B×");
		});
	});

	describe("independent review of #603", () => {
		beforeEach(() => {
			api.projectArtifactsEnabled.mockReturnValue(true);
		});

		it("an open picker survives a re-render: same nodes, focus kept", async () => {
			api.listWorkspaceDir.mockResolvedValue({
				path: "",
				truncated: false,
				entries: [{ name: "a.txt", type: "file", size: 3, mtime: null, restricted: false }],
			});
			const root = mount({ kind: "new" });
			await flush();
			root.querySelector<HTMLButtonElement>(".tw-attach-btn")!.click();
			root.querySelectorAll<HTMLButtonElement>(".tw-attach-agent")[0]!.click();
			await flush();
			const entry = root.querySelector<HTMLButtonElement>(".tw-attach-entry")!;
			entry.focus();
			mount({ kind: "new" }); // the project page's poll / a live event
			await flush();
			expect(root.querySelector(".tw-attach-entry")).toBe(entry);
			expect(document.activeElement).toBe(entry);
		});

		it("a kept node never acts on a stale path: a/ inside a/ goes to a/a", async () => {
			api.listWorkspaceDir.mockImplementation(async (_sid: string, path: string) => ({
				path,
				truncated: false,
				entries: [{ name: "a", type: "dir", size: null, mtime: null, restricted: false }],
			}));
			const root = mount({ kind: "new" });
			await flush();
			root.querySelector<HTMLButtonElement>(".tw-attach-btn")!.click();
			root.querySelectorAll<HTMLButtonElement>(".tw-attach-agent")[0]!.click();
			await flush();
			const dirIn = () =>
				[...root.querySelectorAll<HTMLButtonElement>(".tw-attach-entry")].find(
					(b) => b.querySelector(".tw-file-name")?.textContent === "a/",
				)!;
			// "a" and "a/a" list identically (.. and a/): only the path in each
			// button's key keeps the kept node from replaying the previous level.
			for (let i = 0; i < 3; i++) {
				dirIn().click();
				await flush();
			}
			expect(api.listWorkspaceDir.mock.calls.map((c) => c[1])).toEqual(["", "a", "a/a", "a/a/a"]);
		});

		it("a failed read ends in a retryable error, never a stuck Loading…", async () => {
			api.fetchProjectEvents.mockResolvedValue({
				ok: true,
				status: 200,
				body: { events: withFile, hasMore: false },
			});
			api.fetchProjectArtifactText
				.mockResolvedValueOnce({ ok: false, status: 200, code: "network" })
				.mockResolvedValueOnce({ ok: true, text: DIFF });
			const root = mount({ kind: "thread", msgId: "t3" });
			await flush();
			const open = () => root.querySelector<HTMLButtonElement>(".tw-file-open")!.click();
			open();
			await flush();
			expect(root.querySelector(".tw-file-body")?.textContent).toBe(
				"Couldn't load this file. Open it again to retry.",
			);
			open(); // close
			open(); // open again: retried
			await flush();
			expect(api.fetchProjectArtifactText).toHaveBeenCalledTimes(2);
			expect(root.querySelectorAll(".tw-file-body .git-diff-row.kind-add")).toHaveLength(1);
		});

		it("the send's results take artifact_error from the log once it is folded", async () => {
			const MX = "m-x";
			api.postProjectMessage.mockResolvedValueOnce({
				ok: true,
				status: 202,
				body: {
					msgId: MX,
					deliveries: [
						{
							agentId: QA,
							state: "not-sent",
							reason: "artifact-failed",
							filesPossiblyPlaced: true,
						},
					],
				},
			});
			const root = mount({ kind: "thread", msgId: "t1" });
			await flush();
			root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
			root.querySelectorAll<HTMLButtonElement>(".tw-option:not(:disabled)")[1]!.click();
			root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "x";
			api.fetchProjectEvents.mockResolvedValue({
				ok: true,
				status: 200,
				body: {
					events: [
						...log,
						{
							seq: 10,
							at: NOW,
							ev: "message",
							msg_id: MX,
							kind: "owner",
							to: [QA],
							text: "x",
							in_reply_to: "t1",
						},
						{
							seq: 11,
							at: NOW,
							ev: "delivery",
							msg_id: MX,
							agent_id: QA,
							state: "not-sent",
							reason: "artifact-failed",
							artifact_error: "exists-different",
							files_possibly_placed: true,
						},
					],
					hasMore: false,
				},
			});
			root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
			await flush();
			mount({ kind: "thread", msgId: "t1" });
			await flush();
			expect(root.querySelector(".tw-results")?.textContent).toBe(
				"@qa-pilor · Not delivered: a file couldn't be placed: a different file already has that name in its inbox. Some files may already be in its inbox.",
			);
		});
	});
});

describe("consults between two agents (D3)", () => {
	const G = "c-0123456789ab";
	const at = (m: number) => `2026-11-11T12:${String(m).padStart(2, "0")}:00.000Z`;
	const from = (agent: string) => ({
		agent_id: agent,
		binding_id: `b-${agent}`,
		epoch: 1,
		sid: `s-${agent}`,
		cid: `c-${agent}`,
	});
	const consult = [
		{
			seq: 20,
			at: at(31),
			ev: "message",
			msg_id: "k1",
			kind: "owner",
			to: [DEV],
			text: "Ask QA about naming",
			collab: { grant_id: G },
		},
		{ seq: 21, at: at(31), ev: "delivery", msg_id: "k1", agent_id: DEV, state: "delivered" },
		{
			seq: 22,
			at: at(31),
			ev: "grant",
			grant_id: G,
			event: "created",
			mode: "ask",
			task_msg_id: "k1",
			initiator: DEV,
			with: QA,
			max_messages: 2,
			max_wait_min: 60,
			expires_at: "2026-11-11T14:31:00.000Z",
			by: "u1",
		},
		{
			seq: 23,
			at: at(32),
			ev: "outbox",
			grant_id: G,
			event: "rejected",
			from: from(DEV),
			path: ".st-outbox/bad.md",
			origin: "match",
			reason: "header-invalid",
		},
		{
			seq: 24,
			at: at(33),
			ev: "outbox",
			grant_id: G,
			event: "accepted",
			from: from(DEV),
			path: ".st-outbox/ask.md",
			origin: "match",
			kind: "ask",
			msg_id: "r1",
		},
		{
			seq: 25,
			at: at(33),
			ev: "message",
			msg_id: "r1",
			kind: "relay",
			from: DEV,
			to: [QA],
			text: "<b>Which naming?</b>",
			relay: { grant_id: G, n: 1, kind: "ask", file_sha256: "a".repeat(64) },
		},
		{
			seq: 26,
			at: at(33),
			ev: "delivery",
			msg_id: "r1",
			agent_id: QA,
			state: "queued",
			authorized_by: `collab:${G}`,
		},
	];
	const withLog = (extra: unknown[] = []) =>
		api.fetchProjectEvents.mockResolvedValue({
			ok: true,
			status: 200,
			body: { events: [...log, ...consult, ...extra], hasMore: false },
		});
	/** The view's own clock format (locale-dependent), for a minute of the fixture's hour. */
	const hhmm = (m: number) => clock(at(m));
	const texts = (root: Element, sel: string) =>
		[...root.querySelectorAll(sel)].map((n) => n.textContent);

	afterEach(() => {
		api.projectRelayEnabled.mockReturnValue(false);
		api.postGrantAction.mockReset();
	});

	it("flag off: nothing of D3 is rendered or requested — the thread and New task are as before", async () => {
		withLog();
		const root = mount({ kind: "thread", msgId: "k1" });
		await flush();
		// The relay is the one-line DATA row it always was; its text is not shown.
		const relay = root.querySelector(".tw-row-relay")!;
		expect(relay.className).toBe("tw-row tw-row-relay");
		expect(relay.textContent).toBe("DATAPassed to @qa-pilor as information");
		for (const sel of [".tw-grant", ".tw-row-event", ".tw-row-relay-text", ".tw-consult"])
			expect(root.querySelector(sel)).toBeNull();
		expect(root.textContent).not.toContain("Which naming?");
		mount({ kind: "new" });
		await flush();
		expect(root.querySelector(".tw-consult")).toBeNull();
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		root.querySelector<HTMLButtonElement>(".tw-option:not(:disabled)")!.click();
		root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "plain task";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		expect(api.postProjectMessage.mock.calls[0]![1]).not.toHaveProperty("collab");
		expect(api.postGrantAction).not.toHaveBeenCalled();
	});

	describe("flag on", () => {
		beforeEach(() => api.projectRelayEnabled.mockReturnValue(true));

		it("New task: the consult is offered with exactly one recipient and sends `collab`", async () => {
			const root = mount({ kind: "new" });
			await flush();
			const box = root.querySelector<HTMLElement>(".tw-consult")!;
			expect(box.hidden).toBe(true);
			const pickFirst = () => {
				root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
				root.querySelector<HTMLButtonElement>(".tw-option:not(:disabled)")!.click();
			};
			pickFirst(); // @dev-pilot
			expect(box.hidden).toBe(false);
			const check = box.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
			expect(box.querySelector(`label[for="${check.id}"]`)?.textContent).toBe(
				"Let @dev-pilot consult another agent",
			);
			expect(box.querySelector<HTMLElement>(".tw-consult-opts")!.hidden).toBe(true);
			check.click();
			expect(box.querySelector<HTMLElement>(".tw-consult-opts")!.hidden).toBe(false);
			const [withSel, count] = [...box.querySelectorAll<HTMLSelectElement>("select")];
			// Every select has its label; the recipient itself is never offered.
			for (const sel of [withSel!, count!])
				expect(box.querySelector(`label[for="${sel.id}"]`)?.textContent).toBeTruthy();
			expect([...withSel!.options].map((o) => o.textContent)).toEqual([
				"Choose an agent…",
				"@qa-pilor",
				"@infra-pilot",
			]);
			expect([...count!.options].map((o) => o.value)).toEqual(["2", "3", "4", "5", "6"]);
			expect(count!.value).toBe("2");
			const text = root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!;
			text.value = "Ask QA";
			// Checked but nobody chosen to consult: explained, nothing sent, draft kept.
			root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
			await flush();
			expect(api.postProjectMessage).not.toHaveBeenCalled();
			expect(root.querySelector(".tw-send-status")?.textContent).toBe(
				"Choose which agent it may consult.",
			);
			expect(text.value).toBe("Ask QA");
			withSel!.value = QA;
			count!.value = "4";
			root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
			await flush();
			const body = api.postProjectMessage.mock.calls[0]![1];
			expect(body.to).toEqual([DEV]);
			expect(body.collab).toEqual({ mode: "ask", with: QA, maxMessages: 4 });
		});

		it("New task: a second recipient hides the control and switches it off; an unchecked one sends no collab", async () => {
			const root = mount({ kind: "new" });
			await flush();
			const add = () => {
				root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
				root.querySelector<HTMLButtonElement>(".tw-option:not(:disabled)")!.click();
			};
			add();
			const box = root.querySelector<HTMLElement>(".tw-consult")!;
			const check = box.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
			check.click();
			add(); // two recipients now
			expect(box.hidden).toBe(true);
			expect(check.checked).toBe(false);
			root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "both";
			root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
			await flush();
			expect(api.postProjectMessage.mock.calls[0]![1]).not.toHaveProperty("collab");
		});

		it("New task: a refused consult is explained in words and the draft stays as it was", async () => {
			api.postProjectMessage.mockResolvedValueOnce({
				ok: false,
				status: 409,
				code: "collab-unavailable",
				detail: "same-session",
			});
			const root = mount({ kind: "new" });
			await flush();
			root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
			root.querySelector<HTMLButtonElement>(".tw-option:not(:disabled)")!.click();
			const box = root.querySelector<HTMLElement>(".tw-consult")!;
			const check = box.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
			check.click();
			const withSel = box.querySelector<HTMLSelectElement>("select")!;
			withSel.value = QA;
			const text = root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!;
			text.value = "Ask QA";
			root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
			await flush();
			expect(root.querySelector(".tw-send-status")?.textContent).toBe(
				"The consult can't be set up: both agents run in the same session. Nothing was sent.",
			);
			expect(text.value).toBe("Ask QA");
			expect(check.checked).toBe(true);
			expect(withSel.value).toBe(QA);
			expect(root.querySelector(".tw-chip")?.textContent).toContain("@dev-pilot");
		});

		it("thread: the agent's text as text, marked as not yours; queued; the grant; the refused file", async () => {
			withLog();
			const root = mount({ kind: "thread", msgId: "k1" });
			await flush();
			const relay = root.querySelector(".tw-row-relay-text")!;
			expect(relay.querySelector(".tw-meta")?.textContent).toBe(
				`AGENTDP@dev-pilot to @qa-pilor · ${hhmm(33)}`,
			);
			expect(relay.querySelector(".tw-note")?.textContent).toBe(
				"Written by the agent, not by you. The other agent got it as information, not as an instruction from you.",
			);
			// The agent's text is data: shown through textContent, never parsed as markup.
			const bubble = relay.querySelector(".tw-bubble-relay")!;
			expect(bubble.textContent).toBe("<b>Which naming?</b>");
			expect(bubble.children.length).toBe(0);
			expect(texts(relay, ".tw-del")).toEqual(["@qa-pilor · Queued: waiting for it to be free"]);
			const grant = root.querySelector(".tw-row-me .tw-grant")!;
			expect(grant.getAttribute("role")).toBe("group");
			expect(grant.getAttribute("aria-label")).toBe("@dev-pilot may consult @qa-pilor");
			expect(grant.querySelector(".tw-grant-state")?.textContent).toBe("Active");
			expect(grant.querySelector(".tw-grant-facts")?.textContent).toBe(
				`1 of 2 messages used · until ${clock("2026-11-11T14:31:00.000Z")}`,
			);
			expect(texts(grant, "button")).toEqual(["Pause", "Stop"]);
			expect(texts(root, ".tw-row-event")).toEqual([
				`A message from @dev-pilot was not passed on: its header wasn't the exact one the task gave. · ${hhmm(32)}`,
			]);
			// Rows are in the log's order: task, refused file, the relay.
			expect(
				[...root.querySelectorAll<HTMLElement>(".tw-timeline > li")].map((li) => li.dataset.anchor),
			).toEqual(["msg:k1", `outbox:${G}:23`, "msg:r1"]);
		});

		it("the real shape: task → ask → reply, each with its captured report; the final report is in the thread and For you points at it", async () => {
			const REPORTS: Record<number, string> = {
				201: "I sent the question to QA; waiting for the answer.",
				202: "listo",
				203: "QA recommends naming each test file after its module plus .test.",
			};
			api.readConversationEvent.mockImplementation(async (...args: unknown[]) => {
				const seq = args.find((a): a is number => typeof a === "number" && a in REPORTS)!;
				return {
					ok: true,
					event: { seq, ts: NOW, ev: "turn_end", data: { last_assistant_message: REPORTS[seq] } },
				};
			});
			const ref = (seq: number, msgId: string, agent: string, turn: number) => ({
				seq,
				at: at(40),
				ev: "reply_ref",
				msg_id: msgId,
				agent_id: agent,
				sid: `s-${agent}`,
				cid: `c-${agent}`,
				prompt_id: `p-${seq}`,
				turn_end_seq: turn,
				report_sha256: sha(REPORTS[turn]!),
				report_bytes: REPORTS[turn]!.length,
				truncated: false,
				attribution: "exact",
			});
			const del = (seq: number, msgId: string, agent: string, state: string) => ({
				seq,
				at: at(34),
				ev: "delivery",
				msg_id: msgId,
				agent_id: agent,
				state,
				authorized_by: `collab:${G}`,
			});
			withLog([
				del(27, "r1", QA, "delivered"),
				ref(28, "k1", DEV, 201), // the initiator's turn after the task: it asked
				ref(29, "r1", QA, 202), // the consulted agent's turn after reading the ask
				{
					seq: 30,
					at: at(35),
					ev: "message",
					msg_id: "r2",
					kind: "relay",
					from: QA,
					to: [DEV],
					text: "Module name plus .test",
					in_reply_to: "r1",
					relay: { grant_id: G, n: 2, kind: "reply", file_sha256: "c".repeat(64) },
				},
				del(31, "r2", DEV, "queued"),
				del(32, "r2", DEV, "delivered"),
				{
					seq: 33,
					at: at(36),
					ev: "grant",
					grant_id: G,
					event: "ended",
					reason: "budget",
					by: "system",
				},
				ref(34, "r2", DEV, 203), // the initiator's turn after the reply: the task's result
			]);
			const root = mount({ kind: "thread", msgId: "k1" });
			await flush();
			const anchors = [...root.querySelectorAll<HTMLElement>(".tw-timeline > li")].map(
				(li) => li.dataset.anchor,
			);
			// Every delivery's report sits under its own message, the final one last.
			expect(anchors.filter((a) => a?.startsWith("reply:"))).toEqual([
				`reply:k1:${DEV}:p-28`,
				`reply:r1:${QA}:p-29`,
				`reply:r2:${DEV}:p-34`,
			]);
			expect(anchors.at(-1)).toBe(`reply:r2:${DEV}:p-34`);
			expect(texts(root, ".tw-row-agent .tw-bubble-agent")).toEqual([
				REPORTS[201],
				REPORTS[202],
				REPORTS[203],
			]);
			expect(root.querySelector(".tw-grant-facts")?.textContent).toBe("2 of 2 messages used");
			// For you's "replied" items each name a row the thread really renders.
			const { forYou, ProjectLog, parseLogEvent } = await import("./teamModel.js");
			const page = (await api.fetchProjectEvents.mock.results.at(-1)!.value) as {
				body: { events: unknown[] };
			};
			const model = new ProjectLog();
			model.add(page.body.events.map(parseLogEvent).filter((e) => e !== null));
			const replied = forYou(model).filter((i) => i.kind === "replied" && i.rootId === "k1");
			expect(replied.map((i) => i.msgId).sort()).toEqual(["k1", "r1", "r2"]);
			for (const i of replied)
				expect(anchors).toContain(`reply:${i.msgId}:${i.agentId}:${i.reply!.promptId}`);
			// And the cards are on the page, with the final report's text.
			expect(texts(root, ".tw-card").join("\n")).toContain(REPORTS[203]);
		});

		it("a relay that was delivered and not yet reported on shows the usual waiting row", async () => {
			withLog([
				{
					seq: 27,
					at: at(34),
					ev: "delivery",
					msg_id: "r1",
					agent_id: QA,
					state: "delivered",
					authorized_by: `collab:${G}`,
				},
			]);
			const root = mount({ kind: "thread", msgId: "k1" });
			await flush();
			expect(texts(root, ".tw-row-waiting")).toEqual(["QPWaiting for @qa-pilor's reply"]);
		});

		it("thread: each pause with its cause, an unverified file, an owner request, the end", async () => {
			withLog([
				{
					seq: 27,
					at: at(34),
					ev: "outbox",
					grant_id: G,
					event: "unverified",
					from: from(QA),
					path: ".st-outbox/x.md",
					origin: "none",
				},
				{
					seq: 28,
					at: at(35),
					ev: "grant",
					grant_id: G,
					event: "paused",
					reason: "write-observed",
					by: "system",
					detail: { tool: "Edit", cid: "c" },
				},
				{ seq: 29, at: at(36), ev: "grant", grant_id: G, event: "resumed", by: "u1" },
				{
					seq: 30,
					at: at(37),
					ev: "message",
					msg_id: "r2",
					kind: "relay",
					from: QA,
					to: [],
					text: "I need a decision",
					relay: { grant_id: G, n: 0, kind: "owner", file_sha256: "b".repeat(64) },
				},
				{
					seq: 31,
					at: at(37),
					ev: "grant",
					grant_id: G,
					event: "paused",
					reason: "needs-owner",
					by: "system",
				},
			]);
			const root = mount({ kind: "thread", msgId: "k1" });
			await flush();
			expect(texts(root, ".tw-row-event")).toEqual([
				`A message from @dev-pilot was not passed on: its header wasn't the exact one the task gave. · ${hhmm(32)}`,
				`A message file from @qa-pilor couldn't be verified as written by its own session. It was not passed on. · ${hhmm(34)}`,
				`Consult paused: the consulted agent started changing files (Edit) · ${hhmm(35)}`,
				`You resumed the consult · ${hhmm(36)}`,
				`Consult paused: an agent asked for you · ${hhmm(37)}`,
			]);
			const ask = [...root.querySelectorAll(".tw-row-relay-text")].at(-1)!;
			expect(ask.querySelector(".tw-meta")?.textContent).toBe(
				`AGENTQP@qa-pilor asks for you · ${hhmm(37)}`,
			);
			expect(ask.querySelector(".tw-note")?.textContent).toBe("Written by the agent, not by you.");
			expect(ask.querySelector(".tw-deliveries")).toBeNull();
			const grant = root.querySelector(".tw-grant")!;
			expect(grant.className).toBe("tw-grant tw-grant-paused");
			expect(grant.querySelector(".tw-grant-state")?.textContent).toBe(
				"Paused: an agent asked for you",
			);
			expect(texts(grant, "button")).toEqual(["Resume", "Stop"]);
		});

		it("Pause: one request, its buttons off while it is in flight, and the state shown is the log's", async () => {
			withLog();
			let answer!: (v: unknown) => void;
			api.postGrantAction.mockReturnValueOnce(new Promise((r) => (answer = r)));
			const root = mount({ kind: "thread", msgId: "k1" });
			await flush();
			const btn = (label: string) =>
				[...root.querySelectorAll<HTMLButtonElement>(".tw-grant button")].find(
					(b) => b.textContent === label,
				)!;
			btn("Pause").click();
			await flush();
			expect(api.postGrantAction).toHaveBeenCalledWith(PID, G, "pause");
			expect(texts(root, ".tw-grant button:disabled")).toEqual(["Pause", "Stop"]);
			// A second press while in flight sends nothing.
			btn("Pause").click();
			btn("Stop").click();
			expect(api.postGrantAction).toHaveBeenCalledTimes(1);
			// Still "Active": the answer alone never paints a state.
			expect(root.querySelector(".tw-grant-state")?.textContent).toBe("Active");
			withLog([
				{
					seq: 27,
					at: at(34),
					ev: "grant",
					grant_id: G,
					event: "paused",
					reason: "owner",
					by: "u1",
				},
			]);
			answer({ ok: true, status: 200, body: { grantId: G, state: "paused", reason: "owner" } });
			await flush();
			expect(root.querySelector(".tw-grant-state")?.textContent).toBe("Paused: you paused it");
			expect(texts(root, ".tw-grant button")).toEqual(["Resume", "Stop"]);
			expect(texts(root, ".tw-grant button:disabled")).toEqual([]);
			// Focus stays on the consult (the pressed button no longer exists).
			expect((document.activeElement as HTMLElement | null)?.dataset.key).toMatch(
				new RegExp(`^grant:${G}:`),
			);
			api.postGrantAction.mockResolvedValueOnce({
				ok: true,
				status: 200,
				body: { grantId: G, state: "live" },
			});
			btn("Resume").click();
			await flush();
			expect(api.postGrantAction).toHaveBeenLastCalledWith(PID, G, "resume");
		});

		it("Stop asks first; Keep it sends nothing; Stop it revokes and the ended grant has no controls", async () => {
			withLog();
			const root = mount({ kind: "thread", msgId: "k1" });
			await flush();
			const btn = (label: string) =>
				[...root.querySelectorAll<HTMLButtonElement>(".tw-grant button")].find(
					(b) => b.textContent === label,
				)!;
			btn("Stop").click();
			expect(root.querySelector(".tw-grant-ask")?.textContent).toBe(
				"Stop this consult for good? What is waiting won't be sent, and it can't be resumed.",
			);
			expect(texts(root, ".tw-grant button")).toEqual(["Stop it", "Keep it"]);
			// The question replaced the pressed button: focus is on the answer that changes nothing.
			expect(document.activeElement?.textContent).toBe("Keep it");
			btn("Keep it").click();
			expect(texts(root, ".tw-grant button")).toEqual(["Pause", "Stop"]);
			expect(document.activeElement?.textContent).toBe("Stop");
			expect(api.postGrantAction).not.toHaveBeenCalled();
			btn("Stop").click();
			api.postGrantAction.mockResolvedValueOnce({
				ok: true,
				status: 200,
				body: { grantId: G, state: "ended", reason: "revoked" },
			});
			withLog([
				{
					seq: 27,
					at: at(34),
					ev: "delivery",
					msg_id: "r1",
					agent_id: QA,
					state: "not-sent",
					reason: "grant-inactive",
					authorized_by: `collab:${G}`,
				},
				{ seq: 28, at: at(34), ev: "grant", grant_id: G, event: "revoked", by: "u1" },
			]);
			btn("Stop it").click();
			await flush();
			expect(api.postGrantAction).toHaveBeenCalledWith(PID, G, "revoke");
			const grant = root.querySelector(".tw-grant")!;
			expect(grant.querySelector(".tw-grant-state")?.textContent).toBe("Ended: you stopped it");
			expect(grant.querySelector(".tw-grant-facts")?.textContent).toBe("1 of 2 messages used");
			expect(grant.querySelector("button")).toBeNull();
			expect(texts(root, ".tw-row-relay-text .tw-del")).toEqual([
				"@qa-pilor · Not delivered: the handoffs had stopped",
			]);
			expect(texts(root, ".tw-row-event").at(-1)).toBe(`You stopped the consult · ${hhmm(34)}`);
		});

		it("a refused action says so and changes nothing; the controls come back", async () => {
			withLog();
			api.postGrantAction.mockResolvedValueOnce({ ok: false, status: 0, code: "network" });
			const root = mount({ kind: "thread", msgId: "k1" });
			await flush();
			root.querySelector<HTMLButtonElement>(".tw-grant button")!.click();
			await flush();
			const msg = root.querySelector(".tw-grant-msg")!;
			expect(msg.getAttribute("role")).toBe("status");
			expect(msg.textContent).toBe(
				"No answer from the server. Look at the consult's state before trying again.",
			);
			expect(root.querySelector(".tw-grant-state")?.textContent).toBe("Active");
			expect(texts(root, ".tw-grant button:disabled")).toEqual([]);
		});
	});
});

describe("§3.6: a message waits for a busy agent", () => {
	// The log only grows: what happened after `queued` is a later line.
	const queuedLog = (after?: Record<string, unknown>) => [
		{ seq: 1, at: NOW, ev: "message", msg_id: "q1", kind: "owner", to: [DEV], text: "Later\nbody" },
		{ seq: 2, at: NOW, ev: "delivery", msg_id: "q1", agent_id: DEV, state: "queued" },
		...(after ? [{ seq: 3, at: NOW, ev: "delivery", msg_id: "q1", agent_id: DEV, ...after }] : []),
	];
	const serve = (events: unknown[]) =>
		api.fetchProjectEvents.mockResolvedValue({
			ok: true,
			status: 200,
			body: { events, hasMore: false },
		});
	const send = async (root: HTMLElement) => {
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		root.querySelector<HTMLButtonElement>(".tw-option:not(:disabled)")!.click();
		root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "do it";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
	};
	afterEach(() => {
		api.projectQueueEnabled.mockReturnValue(false);
		api.projectRelayEnabled.mockReturnValue(false);
		api.cancelQueuedProjectMessage.mockReset();
	});

	it("backend without the queue: the body has no whenFree and a queued delivery offers no Cancel", async () => {
		serve(queuedLog());
		const root = mount({ kind: "thread", msgId: "q1" });
		await flush();
		expect(root.querySelector(".tw-queued")).toBeNull();
		mount({ kind: "new" });
		await flush();
		await send(root);
		expect(api.postProjectMessage.mock.calls[0]![1]).not.toHaveProperty("whenFree");
	});

	it("with the queue: every send asks to wait when busy — except one that sets up a consult", async () => {
		api.projectQueueEnabled.mockReturnValue(true);
		api.projectRelayEnabled.mockReturnValue(true);
		const root = mount({ kind: "new" });
		await flush();
		await send(root);
		expect(api.postProjectMessage.mock.calls[0]![1].whenFree).toBe(true);
		mount({ kind: "new" });
		await flush();
		root.querySelector<HTMLButtonElement>(".tw-chip-add")!.click();
		root.querySelector<HTMLButtonElement>(".tw-option:not(:disabled)")!.click();
		const box = root.querySelector<HTMLElement>(".tw-consult")!;
		box.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
		box.querySelectorAll<HTMLSelectElement>("select")[0]!.value = QA;
		root.querySelector<HTMLTextAreaElement>(".tw-composer textarea")!.value = "ask QA";
		root.querySelector<HTMLFormElement>(".tw-composer")!.requestSubmit();
		await flush();
		const body = api.postProjectMessage.mock.calls[1]![1];
		expect(body.collab).toBeTruthy();
		expect(body).not.toHaveProperty("whenFree");
	});

	it("a queued message says so and can be cancelled; the log decides what is shown after", async () => {
		api.projectQueueEnabled.mockReturnValue(true);
		serve(queuedLog());
		const root = mount({ kind: "thread", msgId: "q1" });
		await flush();
		expect(root.querySelector(".tw-del")?.textContent).toBe(
			"@dev-pilot · Queued: waiting for it to be free",
		);
		const cancel = root.querySelector<HTMLButtonElement>(".tw-queued button")!;
		expect(cancel.textContent).toBe("Cancel");
		expect(cancel.getAttribute("aria-label")).toBe("Cancel this message while it waits");
		api.cancelQueuedProjectMessage.mockResolvedValue({ ok: true, status: 200, body: {} });
		serve(queuedLog({ state: "not-sent", reason: "cancelled" }));
		cancel.click();
		await flush();
		expect(api.cancelQueuedProjectMessage).toHaveBeenCalledWith(PID, "q1");
		expect(root.querySelector(".tw-queued")).toBeNull();
		expect(root.querySelector(".tw-del")?.textContent).toBe(
			"@dev-pilot · Not delivered: you cancelled it while it was queued",
		);
	});

	it("a cancel that loses to the send shows what happened, not an error", async () => {
		api.projectQueueEnabled.mockReturnValue(true);
		serve(queuedLog());
		const root = mount({ kind: "thread", msgId: "q1" });
		await flush();
		api.cancelQueuedProjectMessage.mockResolvedValue({ ok: true, status: 200, body: {} });
		serve(queuedLog({ state: "delivered" }));
		root.querySelector<HTMLButtonElement>(".tw-queued button")!.click();
		await flush();
		expect(root.querySelector(".tw-queued")).toBeNull();
		expect(root.querySelector(".tw-del")?.textContent).toBe("@dev-pilot · Delivered ✓");
	});

	it("a cancel the server couldn't answer says so and leaves the message as the log has it", async () => {
		api.projectQueueEnabled.mockReturnValue(true);
		serve(queuedLog());
		const root = mount({ kind: "thread", msgId: "q1" });
		await flush();
		api.cancelQueuedProjectMessage.mockResolvedValue({ ok: false, status: 503, code: "" });
		root.querySelector<HTMLButtonElement>(".tw-queued button")!.click();
		await flush();
		expect(root.querySelector(".tw-queued .tw-partial")?.textContent).toBe(
			"The server couldn't cancel it (503). It is still shown as the log has it.",
		);
		expect(root.querySelector(".tw-queued button")?.textContent).toBe("Cancel");
	});
});
