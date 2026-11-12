import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	fetchProjectEvents: vi.fn(),
	fetchProjectMessage: vi.fn(async () => ({ ok: false, status: 404, code: "not-found" })),
	readConversationEvent: vi.fn(),
	openProjectSocket: vi.fn(),
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

describe("live over WS /ws/project (Appendix A)", () => {
	type Frame = { type: "event"; event: unknown } | { type: "resync"; fromSeq: number };
	function socket() {
		const h: { frame?: (f: Frame) => void; state?: (c: boolean, r?: boolean) => void } = {};
		const sock = { follow: vi.fn(), close: vi.fn() };
		api.openProjectSocket.mockImplementation(
			(_pid: string, frame: (f: Frame) => void, state: (c: boolean, r?: boolean) => void) => {
				h.frame = frame;
				h.state = state;
				return sock;
			},
		);
		return { h, sock };
	}

	it("starts only after the first page, follows from the newest seq, folds events as they arrive", async () => {
		serve(() => 3);
		const { h, sock } = socket();
		const s = new ProjectLogStore("p");
		s.startLive();
		expect(api.openProjectSocket).not.toHaveBeenCalled(); // nothing loaded yet
		await s.refresh();
		s.startLive();
		s.startLive(); // idempotent
		expect(api.openProjectSocket).toHaveBeenCalledTimes(1);
		h.state!(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(s.live).toBe(true);
		expect(sock.follow).toHaveBeenLastCalledWith(3);
		const seen = vi.fn();
		s.onChange(seen);
		h.frame!({ type: "event", event: ev(4) });
		expect(s.log.has("m4")).toBe(true);
		expect(seen).toHaveBeenCalledTimes(1);
		h.frame!({ type: "event", event: ev(4) }); // a duplicate changes nothing
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it("resync: re-read by GET, then follow again from what the log holds", async () => {
		let n = 3;
		serve(() => n);
		const { h, sock } = socket();
		const s = new ProjectLogStore("p");
		await s.refresh();
		s.startLive();
		h.state!(true);
		await new Promise((r) => setTimeout(r, 0));
		n = 7;
		h.frame!({ type: "resync", fromSeq: 3 });
		await new Promise((r) => setTimeout(r, 0));
		expect(s.log.has("m7")).toBe(true);
		expect(sock.follow).toHaveBeenLastCalledWith(7);
	});

	it("a dropped or refused socket is not live (the caller's poll takes over); logout closes it", async () => {
		serve(() => 3);
		const { h, sock } = socket();
		const s = new ProjectLogStore("p");
		await s.refresh();
		s.startLive();
		h.state!(true);
		await new Promise((r) => setTimeout(r, 0));
		h.state!(false, true);
		expect(s.live).toBe(false);
		s.reset();
		expect(sock.close).toHaveBeenCalled();
		// An answer for the reset store applies nothing.
		h.frame!({ type: "event", event: ev(9) });
		expect(s.log.has("m9")).toBe(false);
	});
});
