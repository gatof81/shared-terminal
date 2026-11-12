import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	fetchProjectEvents: vi.fn(),
	fetchProjectMessage: vi.fn(async () => ({ ok: false, status: 404, code: "not-found" })),
	readConversationEvent: vi.fn(),
}));
vi.mock("./api.js", () => api);

const { ProjectLogStore } = await import("./teamLog.js");

const ev = (seq: number) => ({
	seq,
	at: "2026-11-12T10:00:00Z",
	ev: "message",
	msg_id: `m${seq}`,
	kind: "owner",
	to: ["a"],
	text: `task ${seq}`,
});
/** A log of seqs 1..n; pages backward like §5 (ascending, oldestSeq, hasMore). */
function serve(n: () => number, failBefore = new Set<number>()) {
	api.fetchProjectEvents.mockImplementation(
		async (_pid: string, o: { before?: number; limit?: number }) => {
			if (o.before !== undefined && failBefore.has(o.before))
				return { ok: false, status: 0, code: "network" };
			const top = Math.min(o.before === undefined ? n() + 1 : o.before, n() + 1);
			const lim = o.limit ?? 200;
			const seqs = [];
			for (let s = Math.max(1, top - lim); s < top; s++) seqs.push(s);
			return {
				ok: true,
				status: 200,
				body: { events: seqs.map(ev), oldestSeq: seqs[0] ?? null, hasMore: (seqs[0] ?? 1) > 1 },
			};
		},
	);
}

beforeEach(() => vi.clearAllMocks());

describe("gap fill (review regression)", () => {
	it("a gap whose first read fails stays marked, and Load fills it", async () => {
		let n = 3;
		serve(() => n);
		const s = new ProjectLogStore("p");
		await s.refresh();
		expect([...s.log.messages.keys()].sort()).toEqual(["m1", "m2", "m3"]);
		// 300 events land while the tab slept: the newest page (200) leaves a gap, whose read fails.
		n = 303;
		const fail = new Set([104]);
		serve(() => n, fail);
		await s.refresh();
		expect(s.gapBefore).toBe(104);
		expect(s.log.has("m50")).toBe(false);
		// A later poll with nothing new keeps the gap visible (it is not forgotten).
		await s.refresh();
		expect(s.gapBefore).toBe(104);
		fail.clear();
		await s.loadGap();
		expect(s.gapBefore).toBeNull();
		for (const k of [4, 50, 103]) expect(s.log.has(`m${k}`)).toBe(true);
	});

	it("a no-op poll doesn't notify (no re-render)", async () => {
		serve(() => 3);
		const s = new ProjectLogStore("p");
		const seen = vi.fn();
		s.onChange(seen);
		await s.refresh();
		expect(seen).toHaveBeenCalledTimes(1);
		await s.refresh();
		expect(seen).toHaveBeenCalledTimes(1);
	});
});
