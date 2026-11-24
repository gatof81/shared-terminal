import { describe, expect, it } from "vitest";
import {
	activityRows,
	agentStatus,
	answerText,
	applyEdits,
	authFromActivity,
	effortLabel,
	effortState,
	groupThread,
	mapThroughEdits,
	modelLabel,
	modelState,
	parseMentions,
	questionForm,
	recipientRow,
	recipientsOf,
	setRecipient,
	sidebarAgentStatus,
	upsert,
	workTag,
} from "./acpModel.js";
import type { AcpActivity, AcpMessage } from "./api.js";

const msg = (id: number, over: Partial<AcpMessage> = {}): AcpMessage => ({
	id,
	from_id: "owner",
	to_id: "dev",
	kind: "request",
	reply_to: null,
	body: "x",
	state: "pending",
	attempts: 0,
	created_at: "",
	started_at: null,
	finished_at: null,
	result_text: null,
	stop_reason: null,
	note: null,
	...over,
});

describe("mentions", () => {
	const names = ["arquitecto", "dev", "qa-1"];
	it("finds known agents in order, once, not inside emails or longer names", () => {
		expect(parseMentions("@dev y @arquitecto, de nuevo @dev", names)).toEqual([
			"dev",
			"arquitecto",
		]);
		expect(parseMentions("mail a x@dev.com y @devops", names)).toEqual([]);
		expect(parseMentions("(@qa-1)\n@dev:", names)).toEqual(["qa-1", "dev"]);
		expect(parseMentions("```\n@dev\n```", names)).toEqual(["dev"]);
	});
	it("a post with no mention goes to the only agent, else asks for one", () => {
		expect(recipientsOf("hola", ["dev"])).toEqual({ to: ["dev"], error: null });
		expect(recipientsOf("hola", names).error).toContain("@arquitecto");
		expect(recipientsOf("hola", []).error).toContain("no tiene agentes");
		expect(recipientsOf("@qa-1 mirá", names).to).toEqual(["qa-1"]);
		// Leading mentions are the recipients; one inside the text is part of the instruction.
		expect(recipientsOf("@arquitecto consultá a @dev: ¿listo?", names).to).toEqual(["arquitecto"]);
		expect(recipientsOf("@arquitecto @dev, revisen esto", names).to).toEqual(["arquitecto", "dev"]);
		expect(recipientsOf("Revisá esto @dev", names).to).toEqual(["dev"]);
		expect(recipientsOf("que @dev hable con @arquitecto", names).error).toContain("Empezá");
	});
	it("an unknown leading mention refuses the whole post (no partial send, no fallback)", () => {
		const typo = recipientsOf("@devv revisá con @qa-1", names);
		expect(typo.to).toEqual([]);
		expect(typo.error).toContain("@devv");
		expect(recipientsOf("@arquitecto @devv, revisen", names).to).toEqual([]);
		expect(recipientsOf("@Dev hola", names).to).toEqual([]);
		expect(recipientsOf("@todos hola", ["dev"]).error).toContain("@todos");
	});
});

describe("thread", () => {
	it("upsert replaces by id and keeps order", () => {
		let l = [msg(1), msg(3)];
		l = upsert(l, msg(2));
		l = upsert(l, msg(3, { state: "done" }));
		expect(l.map((m) => [m.id, m.state])).toEqual([
			[1, "pending"],
			[2, "pending"],
			[3, "done"],
		]);
	});
	it("one post to several agents is one bubble; everything else stays single", () => {
		const items = groupThread([
			msg(1, { client_id: "c1", body: "@a @b hola", to_id: "a" }),
			msg(2, { client_id: "c1", body: "@a @b hola", to_id: "b" }),
			msg(3, { from_id: "a", to_id: "b", depth: 1 }),
			msg(4, { client_id: "c2", body: "solo", to_id: "a" }),
		]);
		expect(items.map((i) => i.kind)).toEqual(["post", "single", "single"]);
		expect(items[0]!.kind === "post" && items[0]!.messages.map((m) => m.to_id)).toEqual(["a", "b"]);
	});
});

const ev = (seq: number, e: Partial<AcpActivity>): AcpActivity => ({
	seq,
	at: "",
	messageId: 1,
	kind: "tool",
	...e,
});

describe("activity", () => {
	it("one row per tool/task with its latest state and command", () => {
		const rows = activityRows([
			ev(1, { kind: "tool", toolCallId: "t1", title: "Terminal", status: "pending" }),
			ev(2, { kind: "tool", toolCallId: "t1", status: "completed", detail: "npm test" }),
			ev(3, { kind: "task", taskId: "b1", taskType: "shell", name: "server", state: "running" }),
			ev(4, { kind: "text", text: "..." }),
		]);
		expect(rows).toEqual([
			{ key: "tool:t1", label: "Terminal", state: "completed", detail: "npm test" },
			{ key: "task:b1", label: "segundo plano · server", state: "running", detail: "" },
		]);
	});
	it("login state follows the last auth event or answered turn", () => {
		expect(authFromActivity([ev(1, { kind: "auth", state: "required" })], false)).toBe(true);
		expect(
			authFromActivity(
				[ev(1, { kind: "auth", state: "required" }), ev(2, { kind: "turn", phase: "answered" })],
				false,
			),
		).toBe(false);
	});
	it("agent status words", () => {
		const now = Date.parse("2026-11-18T10:00:00Z");
		const base = { name: "a", sessionId: "s", runtime: "r", model: null };
		expect(agentStatus({ ...base, runnerSeenAt: "2026-11-18T09:59:58Z" }, now).label).toBe("libre");
		expect(
			agentStatus({ ...base, runnerSeenAt: "2026-11-18T09:59:58Z", running: [7], pending: 2 }, now)
				.label,
		).toBe("trabajando en #7 · 2 en espera");
		// An agent with slots works on several at once: all of them, oldest first.
		expect(
			agentStatus({ ...base, runnerSeenAt: "2026-11-18T09:59:58Z", running: [7, 9] }, now).label,
		).toBe("trabajando en #7 y #9");
		expect(agentStatus({ ...base, runnerSeenAt: null }, now).tone).toBe("off");
		expect(agentStatus({ ...base, runnerSeenAt: null, authRequired: true }, now).label).toBe(
			"esperando login",
		);
	});
	it("the sidebar's short form: the same states, one word each; the two that ask stand out", () => {
		const now = Date.parse("2026-11-18T10:00:00Z");
		const fresh = "2026-11-18T09:59:58Z";
		const short = (a: Parameters<typeof sidebarAgentStatus>[0]) => {
			const st = sidebarAgentStatus(a, now);
			return [st.word, st.tone, st.asks, st.label];
		};
		expect(short({ runnerSeenAt: fresh })).toEqual(["libre", "ok", false, "libre"]);
		expect(short({ runnerSeenAt: fresh, running: [7] })).toEqual([
			"trabajando",
			"busy",
			false,
			"trabajando en #7",
		]);
		expect(short({ runnerSeenAt: fresh, running: [7], waitingInput: true })).toEqual([
			"te espera",
			"warn",
			true,
			"esperando tu respuesta",
		]);
		expect(short({ runnerSeenAt: null, authRequired: true })).toEqual([
			"login",
			"warn",
			true,
			"esperando login",
		]);
		expect(short({ runnerSeenAt: "2026-11-18T09:58:00Z" })).toEqual([
			"sin señal",
			"off",
			false,
			"runner sin señal",
		]);
		// A runner not connected yet on a session that just started: starting,
		// then — past the grace — "sin señal".
		expect(sidebarAgentStatus({ runnerSeenAt: null }, now, now - 30_000).word).toBe("iniciando");
		expect(sidebarAgentStatus({ runnerSeenAt: null }, now, now - 200_000).word).toBe("sin señal");
		expect(sidebarAgentStatus({ runnerSeenAt: null }, now).word).toBe("sin señal");
		// A restart seen by this page: the backend still has the previous run's
		// seenAt (before the start) — the new runner has not reported yet.
		const stale = "2026-11-18T09:58:00Z";
		expect(sidebarAgentStatus({ runnerSeenAt: stale }, now, now - 30_000).word).toBe("iniciando");
		expect(sidebarAgentStatus({ runnerSeenAt: stale }, now, now - 200_000).word).toBe("sin señal");
		// A restart this page did not see (no start): no grace.
		expect(sidebarAgentStatus({ runnerSeenAt: stale }, now).word).toBe("sin señal");
		// A runner that did report after the start and then went quiet is not "starting".
		expect(
			sidebarAgentStatus({ runnerSeenAt: stale }, now, Date.parse("2026-11-18T09:57:30Z")).word,
		).toBe("sin señal");
		// A fresh report after the start: the ordinary state.
		expect(sidebarAgentStatus({ runnerSeenAt: fresh }, now, now - 30_000).word).toBe("libre");
		// Queued but idle: still the "libre" word, the queue in the full label.
		expect(short({ runnerSeenAt: fresh, pending: 2 })).toEqual([
			"libre",
			"ok",
			false,
			"2 en espera",
		]);
	});
});

describe("questions", () => {
	// The form claude-agent-acp 0.108.0 builds from AskUserQuestion (one single-select question).
	const ask = JSON.stringify({
		mode: "form",
		message: "¿Qué base de datos?",
		requestedSchema: {
			type: "object",
			properties: {
				question_0: {
					type: "string",
					title: "DB",
					oneOf: [
						{ const: "SQLite", title: "SQLite", description: "simple" },
						{ const: "Postgres", title: "Postgres" },
					],
				},
				question_0_custom: { type: "string", title: "Other" },
				question_1: {
					type: "array",
					description: "Extras",
					items: { anyOf: [{ const: "a", title: "A" }] },
				},
			},
		},
	});
	it("reads choices with their 'Other' companion, multi-select and text", () => {
		const f = questionForm(ask);
		expect(f.message).toBe("¿Qué base de datos?");
		expect(f.fields.map((x) => [x.key, x.kind, x.custom ?? null, x.options.length])).toEqual([
			["question_0", "single", "question_0_custom", 2],
			["question_1", "multi", null, 1],
		]);
		expect(questionForm("not json").fields).toEqual([]);
	});
	it("says the answer in words", () => {
		const f = questionForm(ask);
		expect(
			answerText(
				f,
				JSON.stringify({
					action: "accept",
					content: { question_0: "SQLite", question_0_custom: "por ahora" },
				}),
			),
		).toContain("SQLite — por ahora");
		expect(answerText(f, JSON.stringify({ action: "decline" }))).toBe("(omitida)");
		expect(answerText(f, null)).toBe("");
	});
	it("an agent waiting for the person says so", () => {
		expect(
			agentStatus(
				{
					name: "a",
					sessionId: "s",
					runtime: "r",
					model: null,
					runnerSeenAt: null,
					waitingInput: true,
				},
				0,
			).label,
		).toBe("esperando tu respuesta");
	});
});

describe("model", () => {
	it("labels known ids and shows unknown ones as they are", () => {
		expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
		expect(modelLabel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
		expect(modelLabel("claude-fable-5-2")).toBe("Claude Fable 5.2");
		expect(modelLabel("otro-modelo")).toBe("otro-modelo");
		expect(modelLabel(null)).toBe("modelo por defecto");
	});
	it("a change is pending until the runner reports that same model, then applied or failed", () => {
		const opus = "claude-opus-5-5";
		expect(modelState({ model: opus, modelApplied: null })).toBe("pending");
		expect(
			modelState({
				model: opus,
				modelApplied: { requested: "claude-sonnet-5-5", current: "x", error: null },
			}),
		).toBe("pending");
		expect(
			modelState({ model: opus, modelApplied: { requested: opus, current: opus, error: null } }),
		).toBe("applied");
		expect(
			modelState({ model: opus, modelApplied: { requested: opus, current: null, error: "no" } }),
		).toBe("failed");
		expect(modelState({ model: null, modelApplied: null })).toBe("unknown");
	});
});

describe("effort", () => {
	const ap = (requested: string, error: string | null = null) => ({
		model: "claude-opus-5-5",
		requested,
		current: error ? null : requested,
		levels: ["low", "high"],
		error,
	});
	it("labels levels: default and words split on _ or -", () => {
		expect(effortLabel(null)).toBe("Default");
		expect(effortLabel("default")).toBe("Default");
		expect(effortLabel("high")).toBe("High");
		expect(effortLabel("extra_high")).toBe("Extra High");
		expect(effortLabel("x-max")).toBe("X Max");
	});
	it("is pending until the runner reports that same level (null = default), then applied or failed", () => {
		expect(effortState({ effort: "high", effortApplied: null })).toBe("pending");
		// Nothing chosen, nothing reported (a backend restart): not flagged.
		expect(effortState({ effort: null })).toBe("unknown");
		expect(effortState({ effort: "high", effortApplied: ap("low") })).toBe("pending");
		expect(effortState({ effort: "high", effortApplied: ap("high") })).toBe("applied");
		expect(effortState({ effort: null, effortApplied: ap("default") })).toBe("applied");
		expect(effortState({ effort: "high", effortApplied: ap("high", "no") })).toBe("failed");
		// A report made for another model is stale until the runner re-reports.
		expect(
			effortState({
				model: "claude-sonnet-5-5",
				effort: "high",
				effortApplied: { ...ap("high"), model: "claude-opus-5-5" },
			}),
		).toBe("pending");
		expect(
			effortState({
				model: "claude-opus-5-5",
				effort: "high",
				effortApplied: { ...ap("high"), model: "claude-opus-5-5" },
			}),
		).toBe("applied");
	});
});

describe("recipients from the menu: the leading mentions of the text", () => {
	const names = ["arq", "dev", "qa", "dis"];
	const edit = (text: string, name: string, on: boolean) =>
		applyEdits(text, setRecipient(text, names, name, on));

	it("checking adds after the leading group, keeping its punctuation and the body", () => {
		expect(edit("", "arq", true)).toBe("@arq ");
		expect(edit("hola", "arq", true)).toBe("@arq hola");
		expect(edit("@arq hola", "dev", true)).toBe("@arq @dev hola");
		expect(edit("@arq, @dev: mirá esto", "qa", true)).toBe("@arq, @dev @qa: mirá esto");
		expect(edit("  @arq hola", "dev", true)).toBe("  @arq @dev hola");
		// Already a leading recipient: nothing.
		expect(setRecipient("@arq hola", names, "arq", true)).toEqual([]);
	});

	it("an implicit recipient becomes explicit with the one checked", () => {
		// "revisá con @qa" goes to @qa (one mention inside): checking @dev keeps @qa.
		expect(recipientsOf("revisá con @qa", names).to).toEqual(["qa"]);
		const next = edit("revisá con @qa", "dev", true);
		expect(next).toBe("@qa @dev revisá con @qa");
		expect(recipientsOf(next, names).to).toEqual(["qa", "dev"]);
	});

	it("unchecking removes only that leading mention, the body untouched", () => {
		expect(edit("@arq @dev hola", "arq", false)).toBe("@dev hola");
		expect(edit("@arq @dev hola", "dev", false)).toBe("@arq hola");
		expect(edit("@arq, @dev: hola @dev", "dev", false)).toBe("@arq: hola @dev");
		expect(edit("@arq @dev @qa hola", "dev", false)).toBe("@arq @qa hola");
		expect(edit("@arq hola", "arq", false)).toBe("hola");
		expect(edit("@arq @dev @dev hola", "dev", false)).toBe("@arq hola");
		// Not a recipient: nothing.
		expect(setRecipient("@arq hola", names, "qa", false)).toEqual([]);
	});

	it("an implicit recipient cannot be unchecked (it is in the body): no edit, the row says why", () => {
		expect(setRecipient("revisá con @qa", names, "qa", false)).toEqual([]);
		expect(recipientRow("revisá con @qa", names, "qa")).toEqual({ checked: true, implicit: true });
		expect(recipientRow("@qa revisá", names, "qa")).toEqual({ checked: true, implicit: false });
	});

	it("an unknown leading mention: nobody checked; checking adds, the unknown stays (its error too)", () => {
		expect(names.map((n) => recipientRow("@devv revisá", names, n).checked)).toEqual([
			false,
			false,
			false,
			false,
		]);
		const next = edit("@devv revisá", "arq", true);
		expect(next).toBe("@devv @arq revisá");
		expect(recipientsOf(next, names).error).toMatch(/@devv no es un agente/);
		expect(recipientsOf(next, names).to).toEqual([]);
	});

	it("checked == recipientsOf(text).to, for every text and agent (the menu's only source)", () => {
		const texts = [
			"",
			"hola",
			"@arq hola",
			"@arq @dev hola",
			"@arq, @dev: hola @qa",
			"revisá con @qa",
			"@qa y @dev revisen",
			"@devv revisá",
			"hola @arq y @dev",
			"   @dis",
			"@dis@arq pegados",
		];
		for (const text of texts)
			for (const n of names) {
				expect(recipientRow(text, names, n).checked, `${text} / ${n}`).toBe(
					recipientsOf(text, names).to.includes(n),
				);
				// …and after any toggle, still the same rule.
				for (const on of [true, false]) {
					const after = edit(text, n, on);
					for (const m of names)
						expect(recipientRow(after, names, m).checked).toBe(
							recipientsOf(after, names).to.includes(m),
						);
				}
			}
	});

	it("checking then unchecking someone restores the text when nothing else changed", () => {
		for (const text of ["@arq hola", "@arq, @dev: hola", "  @arq hola"])
			expect(edit(edit(text, "qa", true), "qa", false)).toBe(text);
	});

	it("the caret and selection keep their place in the text", () => {
		const text = "@arq hola mundo";
		const caret = text.indexOf("mundo");
		const edits = setRecipient(text, names, "dev", true);
		const next = applyEdits(text, edits);
		expect(next.slice(mapThroughEdits(caret, edits))).toBe("mundo");
		const off = setRecipient(next, names, "arq", false);
		const back = applyEdits(next, off);
		expect(back.slice(mapThroughEdits(next.indexOf("mundo"), off))).toBe("mundo");
		// Empty field: the caret goes after the inserted mention.
		const e0 = setRecipient("", names, "arq", true);
		expect(mapThroughEdits(0, e0)).toBe("@arq ".length);
	});
});

describe("workTag", () => {
	it("tags a work's message and leaves the default context alone", () => {
		expect(workTag({ context: "e2-work-tag" })).toBe("trabajo e2-work-tag");
		expect(workTag({ context: null })).toBeNull();
		expect(workTag({})).toBeNull();
	});
});
