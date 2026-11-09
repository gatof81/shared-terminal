import { describe, expect, it } from "vitest";
import type { Presence, SessionBinding } from "./api.js";
import {
	bindableSessions,
	CreationAttempt,
	classifyCreation,
	evidenceText,
	groupSessionsByBinding,
	pageTitle,
	presentPresence,
	projectErrorText,
	validateHandle,
	validateProjectName,
	validateRole,
} from "./projectModel.js";

const NOW = Date.parse("2026-11-10T14:02:45Z");
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();

describe("presentPresence (rule 2: honest presence)", () => {
	it("working, with its evidence", () => {
		const v = presentPresence({ value: "working", source: "hook", at: at(5) }, NOW);
		expect(v).toMatchObject({ label: "Working", tone: "working" });
		expect(v.evidence).toBe("via hook · just now");
	});

	it("waiting_input is Ready only when a probe verified it; otherwise Ready (unverified)", () => {
		const verified = presentPresence(
			{ value: "waiting_input", source: "probe", at: at(34), verified: true },
			NOW,
		);
		expect(verified).toMatchObject({ label: "Ready", tone: "ready", reason: null });
		for (const verifiedFlag of [false, undefined]) {
			const v = presentPresence(
				{ value: "waiting_input", source: "hook", at: at(34), verified: verifiedFlag },
				NOW,
			);
			expect(v.label).toBe("Ready (unverified)");
			expect(v.tone).toBe("ready");
		}
	});

	it("waiting_input is never 'needs you'", () => {
		const v = presentPresence({ value: "waiting_input", source: "hook", at: at(1) }, NOW);
		expect(v.tone).not.toBe("attention");
		expect(v.label).not.toMatch(/need/i);
	});

	it("needs_attention only with detail waiting_permission (attention rule, option A)", () => {
		expect(
			presentPresence(
				{ value: "needs_attention", detail: "waiting_permission", source: "hook", at: at(47) },
				NOW,
			),
		).toMatchObject({ label: "Needs you", tone: "attention" });
		const other = presentPresence(
			{ value: "needs_attention", detail: "needs-terminal", source: "hook", at: at(47) },
			NOW,
		);
		expect(other.tone).toBe("unknown");
		const bare = presentPresence({ value: "needs_attention", source: "hook", at: at(47) }, NOW);
		expect(bare.tone).toBe("unknown");
	});

	it("unknown is never zero or idle: no evidence vs stale vs unreadable", () => {
		const none = presentPresence({ value: "unknown", source: "capture", at: null }, NOW);
		expect(none).toMatchObject({ label: "No evidence", tone: "unknown" });
		expect(none.evidence).toBe("no evidence");
		const stale = presentPresence(
			{ value: "unknown", detail: "stale", source: "hook", at: at(31 * 60) },
			NOW,
		);
		expect(stale.label).toBe("State unknown");
		expect(stale.reason).toMatch(/10 min/);
		expect(stale.evidence).toBe("via hook · 31 min ago");
		const unreadable = presentPresence(
			{ value: "unknown", detail: "capture-unreadable", source: "capture", at: null },
			NOW,
		);
		expect(unreadable.reason).toMatch(/could not be read/);
		for (const v of [none, stale, unreadable]) {
			expect(v.label).not.toMatch(/idle|0|zero|inactive/i);
		}
	});

	it("disconnected says why, from a Map (an odd detail is shown verbatim, never looked up on an object)", () => {
		const stopped = presentPresence(
			{ value: "disconnected", detail: "session-stopped", source: "session", at: at(80) },
			NOW,
		);
		expect(stopped).toMatchObject({
			label: "Disconnected",
			tone: "off",
			reason: "session stopped",
		});
		const removed = presentPresence(
			{ value: "disconnected", detail: "agent-removed", source: "directory", at: at(60) },
			NOW,
		);
		expect(removed.reason).toBe("agent removed");
		expect(removed.evidence).toBe("via directory · 1 min ago");
		const odd = presentPresence(
			{ value: "disconnected", detail: "constructor", source: "session", at: at(60) },
			NOW,
		);
		expect(odd.reason).toBe("constructor");
	});

	it("a value of a later phase (no_channel, degraded) is shown as unknown, not invented", () => {
		const v = presentPresence(
			{ value: "degraded", source: "x", at: at(1) } as unknown as Presence,
			NOW,
		);
		expect(v).toMatchObject({ label: "State unknown", tone: "unknown" });
	});

	it("evidenceText: an unparsable time is no evidence", () => {
		expect(evidenceText({ source: "hook", at: "nope" }, NOW)).toBe("no evidence");
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
