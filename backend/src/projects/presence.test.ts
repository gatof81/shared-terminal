import { describe, expect, it } from "vitest";
import { decidingConversation, derivePresence, PRESENCE_STALE_MS } from "./presence.js";

const NOW = Date.parse("2026-11-10T14:03:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base = { conversationsRead: true, readAt: ago(0), now: NOW };
const conv = (
	status: string,
	evidence: string,
	atMs: number,
	lastEventMs: number | null = null,
) => ({
	status,
	statusEvidence: evidence,
	statusAt: ago(atMs),
	lastEventAt: lastEventMs === null ? null : ago(lastEventMs),
});

describe("derivePresence", () => {
	it("the session row decides first: gone or not running ⇒ disconnected", () => {
		expect(
			derivePresence({ ...base, sessionStatus: null, conversation: conv("running", "hook:x", 0) }),
		).toMatchObject({
			value: "disconnected",
			detail: "session-gone",
			source: "session",
		});
		expect(
			derivePresence({
				...base,
				sessionStatus: "stopped",
				conversation: conv("running", "hook:x", 0),
			}),
		).toMatchObject({
			value: "disconnected",
			detail: "session-stopped",
		});
	});

	it("maps the capture's states (06 §5)", () => {
		const p = (status: string, ev = "hook:X") =>
			derivePresence({ ...base, sessionStatus: "running", conversation: conv(status, ev, 1000) });
		expect(p("running").value).toBe("working");
		expect(p("waiting_background").value).toBe("working");
		expect(p("waiting_permission")).toMatchObject({
			value: "needs_attention",
			detail: "waiting_permission",
		});
		expect(p("disconnected").value).toBe("disconnected");
		expect(p("ended").value).toBe("disconnected");
		for (const s of ["error", "ending", "unknown", "something-new"])
			expect(p(s).value).toBe("unknown");
	});

	it("waiting_input is verified only when a probe said so", () => {
		const p = (ev: string) =>
			derivePresence({
				...base,
				sessionStatus: "running",
				conversation: conv("waiting_input", ev, 1000),
			});
		expect(p("hook:Stop")).toMatchObject({
			value: "waiting_input",
			source: "hook",
			verified: false,
		});
		expect(p("probe:idle")).toMatchObject({
			value: "waiting_input",
			source: "probe",
			verified: true,
		});
	});

	it("a live claim with evidence ≥ 10 min old is unknown · stale; the newest of statusAt / lastEventAt counts", () => {
		const stale = derivePresence({
			...base,
			sessionStatus: "running",
			conversation: conv("running", "hook:X", PRESENCE_STALE_MS),
		});
		expect(stale).toMatchObject({ value: "unknown", detail: "stale" });
		const alive = derivePresence({
			...base,
			sessionStatus: "running",
			conversation: conv("running", "hook:X", PRESENCE_STALE_MS * 3, 5_000),
		});
		expect(alive).toMatchObject({ value: "working", at: ago(5_000) });
		// A terminal state is not a claim time can falsify.
		expect(
			derivePresence({
				...base,
				sessionStatus: "running",
				conversation: conv("ended", "hook:SessionEnd", PRESENCE_STALE_MS * 9),
			}).value,
		).toBe("disconnected");
		const garbage = derivePresence({
			...base,
			sessionStatus: "running",
			conversation: {
				status: "running",
				statusEvidence: "hook:X",
				statusAt: "nope",
				lastEventAt: null,
			},
		});
		expect(garbage).toMatchObject({ value: "unknown", detail: "stale", at: null });
	});

	it("#568: what keeps a claim fresh is activity or a re-asserting probe, never a probe that confirms nothing", () => {
		const MIN = 60_000;
		// A probe that CONFIRMS busy re-asserts the claim: statusAt moves ⇒ working.
		expect(
			derivePresence({
				...base,
				sessionStatus: "running",
				conversation: conv("running", "probe:busy", 0.5 * MIN, 0.5 * MIN),
			}),
		).toMatchObject({ value: "working", source: "probe" });
		// A long turn: the claim dates from the prompt, its tool hooks are recent activity ⇒ working.
		expect(
			derivePresence({
				...base,
				sessionStatus: "running",
				conversation: conv("running", "hook:UserPromptSubmit", 30 * MIN, 0.5 * MIN),
			}),
		).toMatchObject({ value: "working", source: "hook" });
		// An old claim whose last ACTIVITY is old: a later probe or gap record no longer moves
		// lastEventAt (store, CONVERSATION.md v1.9.1), so the row reads like this ⇒ stale.
		expect(
			derivePresence({
				...base,
				sessionStatus: "running",
				conversation: conv("running", "hook:UserPromptSubmit", 30 * MIN, 30 * MIN),
			}),
		).toMatchObject({ value: "unknown", detail: "stale" });
	});

	it("no conversation, or an unreadable capture, is unknown — never zero, never a guess", () => {
		expect(derivePresence({ ...base, sessionStatus: "running", conversation: null })).toEqual({
			value: "unknown",
			source: "capture",
			at: null,
		});
		expect(
			derivePresence({
				...base,
				conversationsRead: false,
				sessionStatus: "running",
				conversation: null,
			}),
		).toMatchObject({
			value: "unknown",
			detail: "capture-unreadable",
		});
	});
});

describe("decidingConversation", () => {
	it("only bound panes; the newest evidence wins", () => {
		const rows = [
			{ ...conv("ended", "hook:SessionEnd", 0), paneId: null },
			{ ...conv("waiting_input", "hook:Stop", 60_000), paneId: "%1" },
			{ ...conv("running", "hook:X", 120_000, 1_000), paneId: "%2" },
		];
		expect(decidingConversation(rows)?.paneId).toBe("%2");
		expect(decidingConversation([rows[0]])).toBeNull();
	});
});
