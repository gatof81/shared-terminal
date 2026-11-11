import { describe, expect, it } from "vitest";
import type { Presence, SessionBinding } from "./api.js";
import {
	agentActiveDeleteText,
	bindableSessions,
	CreationAttempt,
	classifyCreation,
	evidenceText,
	groupSessionsByBinding,
	nextPollDelayMs,
	POLL_ACTIVE_MS,
	POLL_IDLE_MS,
	PROJECTS_REFRESH_MS,
	pageTitle,
	presenceSummary,
	presentPresence,
	projectErrorText,
	projectsRefreshDue,
	type ServerClock,
	serverNow,
	validateHandle,
	validateProjectName,
	validateRole,
} from "./projectModel.js";

const NOW = Date.parse("2026-11-10T14:02:45Z");
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
// The answer was generated at NOW (server clock) and received at NOW (a
// browser clock in step with it); `skewed` moves only the browser's clock.
const CLOCK: ServerClock = { generatedAt: new Date(NOW).toISOString(), receivedAt: NOW };
const pp = (p: Presence, clock: ServerClock | null = CLOCK, now = NOW) =>
	presentPresence(p, clock, now);

describe("presentPresence (rule 2: honest presence)", () => {
	it("working, with its evidence", () => {
		const v = pp({ value: "working", source: "hook", at: at(5) });
		expect(v).toMatchObject({ label: "Working", tone: "working" });
		expect(v.evidence).toBe("via hook · just now");
		expect(pp({ value: "working", source: "probe", at: at(5) }).tone).toBe("working");
	});

	it("working from a running session, the directory or 'capture' (no usable evidence) is not working", () => {
		for (const source of ["session", "directory", "capture", "", "constructor"]) {
			const v = pp({ value: "working", source, at: at(5) });
			expect(v.tone, source).toBe("unknown");
			expect(v.label).toBe("State unknown");
		}
	});

	it("working without a valid time is not working", () => {
		for (const t of [null, "nope", ""]) {
			const v = pp({ value: "working", source: "hook", at: t });
			expect(v).toMatchObject({ label: "No evidence", tone: "unknown" });
		}
	});

	it("working 11 min old is No recent activity; just under 10 min is still working", () => {
		const old = pp({ value: "working", source: "hook", at: at(11 * 60) });
		expect(old).toMatchObject({ label: "No recent activity", tone: "unknown" });
		expect(old.reason).toMatch(/10 min/);
		expect(pp({ value: "working", source: "hook", at: at(10 * 60) }).tone).toBe("unknown");
		expect(pp({ value: "working", source: "hook", at: at(10 * 60 - 1) }).tone).toBe("working");
	});

	it("the evidence ages with the time since the answer was received", () => {
		const p: Presence = { value: "working", source: "hook", at: at(9 * 60) };
		expect(pp(p, CLOCK, NOW).tone).toBe("working");
		// Same answer, shown 2 min later on the browser's clock: 11 min old.
		const later = pp(p, CLOCK, NOW + 2 * 60_000);
		expect(later.label).toBe("No recent activity");
		expect(later.evidence).toBe("via hook · 11 min ago");
	});

	it("without a server clock a live claim is never shown as live", () => {
		for (const p of [
			{ value: "working", source: "hook", at: at(5) },
			{ value: "waiting_input", source: "probe", at: at(5), verified: true },
			{ value: "needs_attention", detail: "waiting_permission", source: "hook", at: at(5) },
		] as Presence[]) {
			expect(pp(p, null).tone).toBe("unknown");
			expect(pp(p, { generatedAt: "nope", receivedAt: NOW }).tone).toBe("unknown");
		}
	});

	it("a client clock 1 h ahead or behind changes nothing", () => {
		const cases: Presence[] = [
			{ value: "working", source: "hook", at: at(5) },
			{ value: "working", source: "hook", at: at(11 * 60) },
			{ value: "waiting_input", source: "probe", at: at(34), verified: true },
			{ value: "waiting_input", source: "hook", at: at(12 * 60) },
			{ value: "needs_attention", detail: "waiting_permission", source: "hook", at: at(47) },
			{ value: "needs_attention", detail: "waiting_permission", source: "hook", at: at(15 * 60) },
			{ value: "unknown", detail: "stale", source: "hook", at: at(31 * 60) },
			{ value: "disconnected", detail: "session-stopped", source: "session", at: at(80) },
		];
		for (const skew of [3_600_000, -3_600_000]) {
			// The browser's clock is off by `skew`: it received the answer at
			// NOW+skew and reads now as NOW+skew (+ the same elapsed time).
			for (const elapsed of [0, 90_000]) {
				for (const p of cases) {
					const straight = pp(p, CLOCK, NOW + elapsed);
					const skewed = pp(p, { ...CLOCK, receivedAt: NOW + skew }, NOW + skew + elapsed);
					expect(skewed, `${skew} ${elapsed} ${JSON.stringify(p)}`).toEqual(straight);
				}
			}
		}
	});

	it("waiting_input is Ready only when a probe verified it; otherwise Ready (unverified)", () => {
		const verified = pp({ value: "waiting_input", source: "probe", at: at(34), verified: true });
		expect(verified).toMatchObject({ label: "Ready", tone: "ready", reason: null });
		for (const verifiedFlag of [false, undefined]) {
			const v = pp({ value: "waiting_input", source: "hook", at: at(34), verified: verifiedFlag });
			expect(v.label).toBe("Ready (unverified)");
			expect(v.tone).toBe("ready");
		}
	});

	it("waiting_input stale is No recent activity, not Ready", () => {
		const v = pp({ value: "waiting_input", source: "probe", at: at(12 * 60), verified: true });
		expect(v).toMatchObject({ label: "No recent activity", tone: "unknown" });
	});

	it("waiting_input is never 'needs you', fresh or not", () => {
		for (const t of [at(1), at(12 * 60), null]) {
			for (const verified of [true, false]) {
				const v = pp({ value: "waiting_input", source: "hook", at: t, verified });
				expect(v.tone).not.toBe("attention");
				expect(v.label).not.toMatch(/need/i);
			}
		}
	});

	it("needs_attention only with detail waiting_permission (attention rule, option A)", () => {
		expect(
			pp({ value: "needs_attention", detail: "waiting_permission", source: "hook", at: at(47) }),
		).toMatchObject({ label: "Needs you", tone: "attention" });
		const other = pp({
			value: "needs_attention",
			detail: "needs-terminal",
			source: "hook",
			at: at(47),
		});
		expect(other.tone).toBe("unknown");
		const bare = pp({ value: "needs_attention", source: "hook", at: at(47) });
		expect(bare.tone).toBe("unknown");
	});

	it("needs_attention stale or without a time is not Needs you", () => {
		const stale = pp({
			value: "needs_attention",
			detail: "waiting_permission",
			source: "hook",
			at: at(10 * 60),
		});
		expect(stale).toMatchObject({ label: "No recent activity", tone: "unknown" });
		const none = pp({
			value: "needs_attention",
			detail: "waiting_permission",
			source: "hook",
			at: null,
		});
		expect(none.tone).toBe("unknown");
	});

	it("needs_attention from a probe alone, the session or the directory is not Needs you", () => {
		for (const source of ["probe", "session", "directory"]) {
			const v = pp({
				value: "needs_attention",
				detail: "waiting_permission",
				source,
				at: at(5),
			});
			expect(v.tone, source).toBe("unknown");
			expect(v.label).not.toMatch(/need/i);
		}
	});

	it("unknown is never zero or idle: no evidence vs stale vs unreadable", () => {
		const none = pp({ value: "unknown", source: "capture", at: null });
		expect(none).toMatchObject({ label: "No evidence", tone: "unknown" });
		expect(none.evidence).toBe("no evidence");
		const stale = pp({ value: "unknown", detail: "stale", source: "hook", at: at(31 * 60) });
		expect(stale.label).toBe("No recent activity");
		expect(stale.reason).toMatch(/10 min/);
		expect(stale.evidence).toBe("via hook · 31 min ago");
		const unreadable = pp({
			value: "unknown",
			detail: "capture-unreadable",
			source: "capture",
			at: null,
		});
		expect(unreadable.label).toBe("State unknown");
		expect(unreadable.reason).toMatch(/could not be read/);
		for (const v of [none, stale, unreadable]) {
			expect(v.label).not.toMatch(/idle|0|zero|inactive/i);
		}
	});

	it("disconnected says why, from a Map (an odd detail is shown verbatim, never looked up on an object)", () => {
		const stopped = pp({
			value: "disconnected",
			detail: "session-stopped",
			source: "session",
			at: at(80),
		});
		expect(stopped).toMatchObject({
			label: "Disconnected",
			tone: "off",
			reason: "session stopped",
		});
		const removed = pp({
			value: "disconnected",
			detail: "agent-removed",
			source: "directory",
			at: at(60),
		});
		expect(removed.reason).toBe("agent removed");
		expect(removed.evidence).toBe("via directory · 1 min ago");
		const odd = pp({ value: "disconnected", detail: "constructor", source: "session", at: at(60) });
		expect(odd.reason).toBe("constructor");
	});

	it("a value of a later phase (no_channel, degraded) is shown as unknown, not invented", () => {
		const v = pp({ value: "degraded", source: "hook", at: at(1) } as unknown as Presence);
		expect(v).toMatchObject({ label: "State unknown", tone: "unknown" });
	});

	it("evidenceText: an unparsable time is no evidence", () => {
		expect(evidenceText({ source: "hook", at: "nope" }, NOW)).toBe("no evidence");
	});

	it("serverNow: generatedAt plus the browser's elapsed time; NaN without a clock", () => {
		expect(serverNow(CLOCK, NOW + 5000)).toBe(NOW + 5000);
		expect(serverNow({ ...CLOCK, receivedAt: 0 }, 5000)).toBe(NOW + 5000);
		expect(serverNow(null, NOW)).toBeNaN();
		expect(serverNow({ generatedAt: "x", receivedAt: NOW }, NOW)).toBeNaN();
	});
});

describe("presenceSummary: one count per displayed tone", () => {
	it("counts the views' tones, in a fixed order, without empty buckets", () => {
		const views = [
			pp({ value: "working", source: "hook", at: at(5) }),
			pp({ value: "working", source: "session", at: at(5) }),
			pp({ value: "working", source: "hook", at: at(11 * 60) }),
			pp({ value: "needs_attention", detail: "waiting_permission", source: "hook", at: at(5) }),
			pp({ value: "waiting_input", source: "probe", at: at(5), verified: true }),
			pp({ value: "disconnected", detail: "session-stopped", source: "session", at: at(5) }),
		];
		expect(presenceSummary(views)).toEqual([
			"1 needs you",
			"1 working",
			"1 ready",
			"1 disconnected",
			"2 no recent activity or unknown",
		]);
		expect(presenceSummary([])).toEqual([]);
		expect(presenceSummary([views[0]!, views[0]!])).toEqual(["2 working"]);
	});
});

describe("groupSessionsByBinding (rule 1: absent ≠ null)", () => {
	const b: SessionBinding = {
		projectId: "p1",
		agentId: "a1",
		handle: "developer-hz",
		bindingId: "b1",
		epoch: 1,
	};
	const rows = [
		{ sessionId: "s1", status: "running", binding: b },
		{ sessionId: "s2", status: "running", binding: null },
		{ sessionId: "s3", status: "running" },
		{ sessionId: "s4", status: "stopped", binding: null },
		{ sessionId: "s5", status: "terminated", binding: null },
	];

	it("object = bound, null = unassigned, key absent = unknown — server order kept", () => {
		const g = groupSessionsByBinding(rows);
		expect(g.bound.map((x) => x.session.sessionId)).toEqual(["s1"]);
		expect(g.bound[0]!.binding.handle).toBe("developer-hz");
		expect(g.unassigned.map((x) => x.sessionId)).toEqual(["s2", "s4", "s5"]);
		expect(g.unknown.map((x) => x.sessionId)).toEqual(["s3"]);
	});

	it("an explicit `binding: undefined` is not null either", () => {
		const g = groupSessionsByBinding([{ sessionId: "x", status: "running", binding: undefined }]);
		expect(g.unknown).toHaveLength(1);
		expect(g.unassigned).toHaveLength(0);
	});

	it("bindableSessions: only known-unassigned, never terminated, stopped allowed", () => {
		expect(bindableSessions(rows).map((s) => s.sessionId)).toEqual(["s2", "s4"]);
	});
});

describe("input rules", () => {
	it("handle follows ^[a-z][a-z0-9-]{1,31}$", () => {
		expect(validateHandle("developer-hz")).toBeNull();
		expect(validateHandle("qa")).toBeNull();
		for (const bad of ["", "a", "Dev", "1dev", "dev_hz", "@dev", `a${"b".repeat(32)}`]) {
			expect(validateHandle(bad), bad).not.toBeNull();
		}
	});

	it("project name: 1–80 after trim, no control characters", () => {
		expect(validateProjectName("Educación HZ")).toBeNull();
		expect(validateProjectName("   ")).not.toBeNull();
		expect(validateProjectName("x".repeat(81))).not.toBeNull();
		expect(validateProjectName("a\u0007b")).not.toBeNull();
	});

	it("role is optional, ≤ 60", () => {
		expect(validateRole("")).toBeNull();
		expect(validateRole("QA & Release")).toBeNull();
		expect(validateRole("r".repeat(61))).not.toBeNull();
	});
});

describe("projectErrorText (rule 5: by `error`, never `message`)", () => {
	it("maps the contract's codes", () => {
		expect(projectErrorText("session-taken", 409)).toMatch(/already belongs to another agent/);
		expect(projectErrorText("handle-taken", 409)).toMatch(/removed agents stay reserved/);
		expect(projectErrorText("agent-not-found", 404)).toBe("Not found.");
		expect(projectErrorText("agent-limit", 409)).toMatch(/32/);
		expect(projectErrorText("project-limit", 409)).toMatch(/50/);
		expect(projectErrorText("outcome-unknown", 503)).toMatch(/Retry/);
	});

	it("an unknown code is named, never looked up on a plain object", () => {
		expect(projectErrorText("constructor", 400)).toMatch(/constructor/);
		expect(projectErrorText("", 500)).toMatch(/500/);
		expect(projectErrorText("anything", 429)).toMatch(/Too many/);
	});
});

describe("classifyCreation", () => {
	it("201 (replayed or not) is created", () => {
		expect(classifyCreation({ ok: true, replayed: true })).toEqual({
			kind: "created",
			replayed: true,
		});
	});

	it("503, any 5xx, no answer and an unreadable 2xx prove nothing", () => {
		for (const a of [
			{ ok: false as const, status: 503, code: "outcome-unknown" },
			{ ok: false as const, status: 502, code: "" },
			{ ok: false as const, status: 500, code: "internal" },
			{ ok: false as const, status: 0, code: "network" },
			{ ok: false as const, status: 201, code: "bad-answer" },
		]) {
			expect(classifyCreation(a).kind, JSON.stringify(a)).toBe("unknown");
		}
	});

	it("a 4xx (incl. 429) is a refusal", () => {
		for (const status of [400, 404, 409, 429]) {
			expect(classifyCreation({ ok: false, status, code: "x" }).kind).toBe("refused");
		}
	});
});

describe("CreationAttempt (rule 4: one id per user action)", () => {
	const minter = () => {
		let n = 0;
		return () => `id-${++n}`;
	};

	it("a 503 keeps the id: the Retry re-sends the SAME one, and the inputs stay frozen", () => {
		const a = new CreationAttempt(minter());
		expect(a.inputsLocked).toBe(false);
		const first = a.send();
		expect(a.inputsLocked).toBe(true);
		const step = a.receive({ kind: "unknown", code: "outcome-unknown" });
		expect(step.phase).toBe("unknown");
		expect(step.message).toMatch(/could not be confirmed/);
		expect(a.inputsLocked).toBe(true);
		expect(a.send()).toBe(first);
		expect(a.receive({ kind: "created", replayed: true }).phase).toBe("done");
	});

	it("a refusal after a 503 asks for a reload BEFORE its message, and retires the id", () => {
		const a = new CreationAttempt(minter());
		const first = a.send();
		a.receive({ kind: "unknown", code: "network" });
		expect(a.send()).toBe(first);
		const step = a.receive({ kind: "refused", code: "session-taken", status: 409 });
		expect(step).toMatchObject({ phase: "editing", reloadFirst: true });
		expect(step.message).toMatch(/another agent/);
		expect(a.inputsLocked).toBe(false);
		expect(a.send()).not.toBe(first);
	});

	it("a 429 after a 503 keeps the id: the rate limiter proves nothing about the lost write", () => {
		const a = new CreationAttempt(minter());
		const first = a.send();
		a.receive({ kind: "unknown", code: "outcome-unknown" });
		expect(a.send()).toBe(first);
		const step = a.receive({ kind: "refused", code: "rate-limited", status: 429 });
		expect(step).toMatchObject({ phase: "unknown", reloadFirst: false });
		expect(step.message).toMatch(/Too many requests/);
		expect(a.inputsLocked).toBe(true);
		expect(a.send()).toBe(first);
		expect(a.receive({ kind: "created", replayed: true }).phase).toBe("done");
	});

	it("a 429 with no unknown outcome before it is an ordinary refusal", () => {
		const a = new CreationAttempt(minter());
		const first = a.send();
		const step = a.receive({ kind: "refused", code: "rate-limited", status: 429 });
		expect(step).toMatchObject({ phase: "editing", reloadFirst: false });
		expect(a.send()).not.toBe(first);
	});

	it("a refusal without a 503 before it needs no reload", () => {
		const a = new CreationAttempt(minter());
		a.send();
		expect(a.receive({ kind: "refused", code: "handle-taken", status: 409 }).reloadFirst).toBe(
			false,
		);
	});

	it("every new action (after a refusal) mints a new id; idempotency-conflict too", () => {
		const a = new CreationAttempt(minter());
		const ids = new Set<string>();
		for (let i = 0; i < 3; i++) {
			ids.add(a.send());
			a.receive({ kind: "refused", code: "idempotency-conflict", status: 409 });
		}
		expect(ids.size).toBe(3);
	});

	it("never two requests at once, nothing after done", () => {
		const a = new CreationAttempt(minter());
		a.send();
		expect(() => a.send()).toThrow();
		a.receive({ kind: "created", replayed: false });
		expect(() => a.send()).toThrow();
		expect(() => a.receive({ kind: "created", replayed: false })).toThrow();
	});

	it("abandon after an unknown outcome retires the id (a new action gets a new one)", () => {
		const a = new CreationAttempt(minter());
		const first = a.send();
		a.receive({ kind: "unknown", code: "outcome-unknown" });
		a.abandon();
		expect(a.inputsLocked).toBe(false);
		expect(a.send()).not.toBe(first);
	});
});

describe("pageTitle: names only", () => {
	it("project, or agent · project", () => {
		expect(pageTitle("Educación HZ", null)).toBe("Educación HZ");
		expect(pageTitle("Educación HZ", "developer-hz")).toBe("@developer-hz · Educación HZ");
		expect(pageTitle(null, null)).toBe("Project");
	});
});

describe("presentPresence: needs you only from the CLI's own hook", () => {
	it("a waiting_permission read by a probe or with no usable evidence ('capture') is not Needs you", () => {
		for (const source of ["probe", "capture"]) {
			const v = pp({ value: "needs_attention", detail: "waiting_permission", source, at: at(5) });
			expect(v.tone, source).not.toBe("attention");
		}
	});
});

describe("agentActiveDeleteText (409 agent-active on a hard delete)", () => {
	it("names the agent and its project, and what to do", () => {
		expect(
			agentActiveDeleteText("my-project", { handle: "dev", projectName: "Educación HZ" }, false),
		).toEqual({
			title: "Can't delete permanently",
			message:
				'"my-project" belongs to the agent @dev in Educación HZ. Remove the agent first; the session itself stays and can then be deleted.',
		});
	});

	it("without a known project name, the agent alone", () => {
		expect(agentActiveDeleteText("s", { handle: "dev", projectName: null }, false).message).toBe(
			'"s" belongs to the agent @dev. Remove the agent first; the session itself stays and can then be deleted.',
		);
	});

	it("no binding known: the generic sentence", () => {
		expect(agentActiveDeleteText("s", null, false).message).toBe(
			"This session belongs to a project agent. Remove the agent first (Projects), then delete it.",
		);
	});

	it("terminated by the refused attempt: one more paragraph", () => {
		const { message } = agentActiveDeleteText("s", null, true);
		expect(message.split("\n\n")).toEqual([
			"This session belongs to a project agent. Remove the agent first (Projects), then delete it.",
			"It was terminated; its files are kept. Delete it permanently after removing the agent.",
		]);
	});
});

describe("nextPollDelayMs (adaptive polling)", () => {
	const agent = (value: Presence["value"]) => ({ presence: { value } });
	it("is 5 s while any agent is working or needs attention", () => {
		expect(nextPollDelayMs([agent("working")])).toBe(POLL_ACTIVE_MS);
		expect(nextPollDelayMs([agent("waiting_input"), agent("needs_attention")])).toBe(
			POLL_ACTIVE_MS,
		);
		expect(POLL_ACTIVE_MS).toBe(5_000);
	});
	it("is 15 s when every agent is at rest, or there are none", () => {
		expect(nextPollDelayMs([agent("waiting_input"), agent("disconnected"), agent("unknown")])).toBe(
			POLL_IDLE_MS,
		);
		expect(nextPollDelayMs([])).toBe(POLL_IDLE_MS);
		expect(POLL_IDLE_MS).toBe(15_000);
	});
	it("stays fast while a page is shown and nothing is known yet", () => {
		expect(nextPollDelayMs(null)).toBe(POLL_ACTIVE_MS);
		expect(nextPollDelayMs(null, true)).toBe(POLL_ACTIVE_MS);
	});
	it("is slow with no page shown, whatever the agents say", () => {
		expect(nextPollDelayMs(null, false)).toBe(POLL_IDLE_MS);
		expect(nextPollDelayMs([agent("working")], false)).toBe(POLL_IDLE_MS);
	});
});

describe("projectsRefreshDue (60 s of elapsed time)", () => {
	it("is due only once 60 s have elapsed, whatever the tick cadence", () => {
		expect(PROJECTS_REFRESH_MS).toBe(60_000);
		expect(projectsRefreshDue(1_000, 1_000 + 59_999)).toBe(false);
		expect(projectsRefreshDue(1_000, 1_000 + 60_000)).toBe(true);
		// Three 15 s idle ticks are not enough; four are.
		expect(projectsRefreshDue(0, 45_000)).toBe(false);
		expect(projectsRefreshDue(0, 60_000)).toBe(true);
	});
	it("treats a clock that went backwards or a NaN as due", () => {
		expect(projectsRefreshDue(10_000, 5_000)).toBe(true);
		expect(projectsRefreshDue(Number.NaN, 5_000)).toBe(true);
	});
});
