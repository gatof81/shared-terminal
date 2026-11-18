import { describe, expect, it } from "vitest";
import {
	activityRows,
	agentStatus,
	authFromActivity,
	groupThread,
	parseMentions,
	recipientsOf,
	upsert,
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
			agentStatus({ ...base, runnerSeenAt: "2026-11-18T09:59:58Z", running: 7, pending: 2 }, now)
				.label,
		).toBe("trabajando en #7 · 2 en espera");
		expect(agentStatus({ ...base, runnerSeenAt: null }, now).tone).toBe("off");
		expect(agentStatus({ ...base, runnerSeenAt: null, authRequired: true }, now).label).toBe(
			"esperando login",
		);
	});
});
