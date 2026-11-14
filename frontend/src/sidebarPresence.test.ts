import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsResponse, Presence } from "./api.js";
import {
	__setSidebarPresenceEnv,
	ANSWER_MAX_AGE_MS,
	clearSidebarPresence,
	noteProjectAgents,
	SIDEBAR_PRESENCE_POLL_MS,
	sidebarPresenceOf,
	sidebarPresenceVisible,
	startSidebarPresence,
	watchSidebarPresence,
} from "./sidebarPresence.js";

const T0 = Date.parse("2026-11-14T12:00:00Z");
let now = T0;
let visible = true;

function list(pid: string, presence: Presence, sessionId = `s-${pid}`): AgentsResponse {
	return {
		projectId: pid,
		generatedAt: new Date(now).toISOString(),
		agents: [
			{
				agentId: `a-${pid}`,
				handle: "dev",
				role: null,
				provider: "claude-code",
				template: null,
				binding: { bindingId: "b", epoch: 1, sessionId, state: "active" },
				presence,
			},
		],
		can: { createAgent: { allowed: true } },
	};
}

const working = (): Presence => ({
	value: "working",
	source: "hook",
	at: new Date(now - 5_000).toISOString(),
});

/** A loader like projectsView's: answers by feeding the module, counts what it is asked. */
function fakeLoader(answer: (pid: string) => Presence | null = () => working()) {
	const asked: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const load = async (pid: string) => {
		asked.push(pid);
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await Promise.resolve();
		inFlight--;
		const p = answer(pid);
		if (p) noteProjectAgents(pid, list(pid, p), now);
	};
	return { load, asked, max: () => maxInFlight };
}

const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
	clearSidebarPresence();
	now = T0;
	visible = true;
	__setSidebarPresenceEnv({ now: () => now, visible: () => visible });
});

describe("sidebarPresence", () => {
	it("reads only the expanded projects, once per 30 s, however often the tree renders", async () => {
		const l = fakeLoader();
		startSidebarPresence(l.load, () => {});
		watchSidebarPresence(["p1", "p2"], true);
		await settle();
		expect(l.asked).toEqual(["p1", "p2"]);
		// The 5 s heartbeat for 25 s: nothing is due.
		for (let i = 0; i < 5; i++) {
			now += 5_000;
			watchSidebarPresence(["p1", "p2"], true);
			await settle();
		}
		expect(l.asked).toEqual(["p1", "p2"]);
		now += 5_000;
		watchSidebarPresence(["p1", "p2"], true);
		await settle();
		expect(l.asked).toEqual(["p1", "p2", "p1", "p2"]);
		expect(SIDEBAR_PRESENCE_POLL_MS).toBe(30_000);
	});

	it("never has two requests in flight, with many projects expanded", async () => {
		const l = fakeLoader();
		startSidebarPresence(l.load, () => {});
		const many = Array.from({ length: 40 }, (_, i) => `p${i}`);
		watchSidebarPresence(many, true);
		watchSidebarPresence(many, true); // a second render during the round
		for (let i = 0; i < 20; i++) await settle();
		expect(l.asked).toEqual(many);
		expect(l.max()).toBe(1);
	});

	it("asks nothing while the page is hidden or the sidebar is off screen, and catches up when seen", async () => {
		const l = fakeLoader();
		startSidebarPresence(l.load, () => {});
		visible = false;
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(l.asked).toEqual([]);
		visible = true;
		watchSidebarPresence(["p1"], false); // a closed phone drawer
		await settle();
		expect(l.asked).toEqual([]);
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(l.asked).toEqual(["p1"]);
		// Hidden for five minutes, then back: one read, at once.
		visible = false;
		now += 5 * 60_000;
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(l.asked).toEqual(["p1"]);
		visible = true;
		sidebarPresenceVisible();
		await settle();
		expect(l.asked).toEqual(["p1", "p1"]);
	});

	it("reuses a list the project page read itself instead of asking again", async () => {
		const l = fakeLoader();
		startSidebarPresence(l.load, () => {});
		noteProjectAgents("p1", list("p1", working()), now);
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(l.asked).toEqual([]);
		expect(sidebarPresenceOf("p1", "a-p1", "s-p1")?.label).toBe("Working");
	});

	it("asks for a re-render when what the rows show changed, not on an identical answer", async () => {
		const changed = vi.fn();
		let p: Presence = working();
		const l = fakeLoader(() => p);
		startSidebarPresence(l.load, changed);
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(changed).toHaveBeenCalledTimes(1);
		now += 30_000;
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(changed).toHaveBeenCalledTimes(1);
		now += 30_000;
		p = {
			value: "needs_attention",
			detail: "waiting_permission",
			source: "hook",
			at: new Date(now).toISOString(),
		};
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(changed).toHaveBeenCalledTimes(2);
		expect(sidebarPresenceOf("p1", "a-p1", "s-p1")?.label).toBe("Needs you");
	});

	it("never shows a live state on evidence that can't carry it", async () => {
		const l = fakeLoader();
		startSidebarPresence(l.load, () => {});
		// Not asked yet: nothing to say.
		expect(sidebarPresenceOf("p1", "a-p1", "s-p1")).toBeNull();
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(sidebarPresenceOf("p1", "a-p1", "s-p1")?.tone).toBe("working");
		// The row's session is not the one the list binds this agent to.
		expect(sidebarPresenceOf("p1", "a-p1", "another-session")?.tone).toBe("unknown");
		expect(sidebarPresenceOf("p1", "a-gone", "s-p1")?.tone).toBe("unknown");
		// The evidence ages on its own: ≥ 10 min is not "Working"…
		expect(sidebarPresenceOf("p1", "a-p1", "s-p1", now + 60_000)?.tone).toBe("working");
		// …and an answer this module could not refresh proves nothing.
		const late = sidebarPresenceOf("p1", "a-p1", "s-p1", now + ANSWER_MAX_AGE_MS);
		expect(late).toMatchObject({ tone: "unknown", reason: "not refreshed for over a minute" });
	});

	it("a read that fails shows unknown and is retried at the same pace, not in a loop", async () => {
		const changed = vi.fn();
		const l = fakeLoader(() => null);
		startSidebarPresence(l.load, changed);
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(l.asked).toEqual(["p1"]);
		expect(sidebarPresenceOf("p1", "a-p1", "s-p1")).toMatchObject({
			tone: "unknown",
			reason: "the project's agents could not be read",
		});
		expect(changed).toHaveBeenCalled();
		now += 5_000;
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(l.asked).toEqual(["p1"]);
		now += 25_000;
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(l.asked).toEqual(["p1", "p1"]);
	});

	it("logout: nothing is kept and nothing more is asked", async () => {
		const l = fakeLoader();
		startSidebarPresence(l.load, () => {});
		watchSidebarPresence(["p1"], true);
		await settle();
		clearSidebarPresence();
		expect(sidebarPresenceOf("p1", "a-p1", "s-p1")).toBeNull();
		now += 60_000;
		watchSidebarPresence(["p1"], true);
		await settle();
		expect(l.asked).toEqual(["p1"]);
	});
});
