import { describe, expect, it } from "vitest";
import { PROBE_ARGV, parseAgentsJson } from "./probe.js";

describe("parseAgentsJson", () => {
	it("reads the documented fields and ignores the rest", () => {
		const out = parseAgentsJson(
			JSON.stringify([
				{
					pid: 1,
					cwd: "/w",
					kind: "interactive",
					startedAt: 1,
					sessionId: "c1",
					name: "n",
					status: "waiting",
					waitingFor: "input needed",
					extra: true,
				},
				{ sessionId: "c2", status: "nonsense" },
				{ nope: 1 },
				"junk",
			]),
		);
		expect(out).toEqual([
			{
				sessionId: "c1",
				kind: "interactive",
				pid: 1,
				status: "waiting",
				waitingFor: "input needed",
				name: "n",
				cwd: "/w",
			},
			{ sessionId: "c2", kind: "interactive" },
		]);
	});
	it("returns null for non-JSON or non-array output", () => {
		expect(parseAgentsJson("not json")).toBeNull();
		expect(parseAgentsJson('{"a":1}')).toBeNull();
	});
	it("pins the exact argv (never a shell string)", () => {
		expect(PROBE_ARGV).toEqual(["claude", "agents", "--json"]);
	});
});
