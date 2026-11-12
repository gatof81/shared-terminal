import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// openProjectSocket's reconnect policy (independent review of #599): the
// server completes the handshake before it authorizes, so an immediate close
// after `open` (1011 store unavailable) must back off, not loop at 500 ms.

class FakeWs {
	static OPEN = 1;
	static all: FakeWs[] = [];
	readyState = 0;
	sent: string[] = [];
	private l = new Map<string, Array<(e: unknown) => void>>();
	constructor(readonly url: string) {
		FakeWs.all.push(this);
	}
	addEventListener(t: string, f: (e: unknown) => void) {
		this.l.set(t, [...(this.l.get(t) ?? []), f]);
	}
	send(d: string) {
		this.sent.push(d);
	}
	close() {}
	emit(t: string, e: unknown = {}) {
		if (t === "open") this.readyState = 1;
		for (const f of this.l.get(t) ?? []) f(e);
	}
}

let api: typeof import("./api.js");

beforeEach(async () => {
	vi.useFakeTimers();
	FakeWs.all = [];
	vi.stubGlobal("WebSocket", FakeWs);
	vi.resetModules();
	api = await import("./api.js");
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** Open the current socket and close it right away (what a 1011 after the handshake looks like). */
function openThenClose(code = 1011) {
	const s = FakeWs.all.at(-1)!;
	s.emit("open");
	s.emit("close", { code });
}

describe("openProjectSocket reconnect", () => {
	it("an accept-then-close loop backs off (500, 1000, 2000 … ≤ 15 s), never stays at 500 ms", () => {
		api.openProjectSocket("p", () => {});
		const delays: number[] = [];
		for (let i = 0; i < 7; i++) {
			const before = FakeWs.all.length;
			openThenClose();
			let waited = 0;
			while (FakeWs.all.length === before) {
				vi.advanceTimersByTime(100);
				waited += 100;
			}
			delays.push(waited);
		}
		expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
	});

	it("a socket that stayed open > 10 s earns the fast backoff again", () => {
		api.openProjectSocket("p", () => {});
		openThenClose();
		vi.advanceTimersByTime(500);
		openThenClose();
		vi.advanceTimersByTime(1000); // backoff is now 2000
		const s = FakeWs.all.at(-1)!;
		s.emit("open");
		vi.advanceTimersByTime(11_000); // a useful connection
		const before = FakeWs.all.length;
		s.emit("close", { code: 1006 });
		vi.advanceTimersByTime(500);
		expect(FakeWs.all.length).toBe(before + 1);
	});

	it("1008 (refused) never reconnects", () => {
		api.openProjectSocket("p", () => {});
		openThenClose(1008);
		vi.advanceTimersByTime(60_000);
		expect(FakeWs.all.length).toBe(1);
	});

	it("subscribes from the cursor on open, and drops a frame at or below it", () => {
		const frames: unknown[] = [];
		const sock = api.openProjectSocket("p", (f) => frames.push(f));
		sock.follow(5);
		const s = FakeWs.all.at(-1)!;
		s.emit("open");
		expect(s.sent).toEqual([JSON.stringify({ type: "subscribe", after: 5 })]);
		s.emit("message", { data: JSON.stringify({ type: "event", event: { seq: 5 } }) });
		s.emit("message", { data: JSON.stringify({ type: "event", event: { seq: 6 } }) });
		expect(frames).toEqual([{ type: "event", event: { seq: 6 } }]);
	});
});
