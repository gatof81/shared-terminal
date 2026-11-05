import { describe, expect, it } from "vitest";
import { type AgentEntry, agentName, agentsLine, atAGlance } from "./agentsSummary.js";

const a = (over: Partial<AgentEntry>): AgentEntry => ({
	agentId: "a1b2c3d4e5f6a7b8",
	agentType: "Explore",
	status: "running",
	startedSeq: 1,
	toolCount: 0,
	hasResult: false,
	...over,
});

describe("agentsSummary", () => {
	it("working first, newest start first; finished counted", () => {
		const g = atAGlance([
			a({ agentId: "x", startedSeq: 3 }),
			a({ agentId: "y", status: "done", startedSeq: 2 }),
			a({ agentId: "z", startedSeq: 9 }),
		]);
		expect(g.working.map((w) => w.agentId)).toEqual(["z", "x"]);
		expect(g).toMatchObject({ done: 1, total: 3 });
	});
	it("says what there is, in words", () => {
		expect(agentsLine(atAGlance([]))).toBe("");
		expect(agentsLine(atAGlance([a({})]))).toBe("1 agent working");
		expect(agentsLine(atAGlance([a({}), a({ status: "done" }), a({ status: "done" })]))).toBe(
			"1 agent working · 2 done",
		);
		expect(agentsLine(atAGlance([a({ status: "done" })]))).toBe("1 agent done");
	});
	it("names an agent by its type, or a short id", () => {
		expect(agentName(a({ agentType: "general-purpose" }))).toBe("general-purpose");
		expect(agentName(a({ agentType: " " }))).toBe("agent a1b2c3d4");
	});
});
