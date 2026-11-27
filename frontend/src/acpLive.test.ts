/**
 * acpLive.test.ts — the shared /ws/acp socket: a first connection that fails
 * before its hello must still tell the chats to poll over REST, and one that
 * is slow must not hold their first load more than ~1 s.
 */

import { describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(
	() =>
		[] as Array<{
			onclose: (() => void) | null;
			onmessage: ((e: { data: string }) => void) | null;
			onerror: unknown;
			close: () => void;
		}>,
);
vi.mock("./api.js", () => ({
	openAcpSocket: () => {
		const s = { onclose: null, onmessage: null, onerror: null, close: () => {} };
		sockets.push(s);
		return s;
	},
}));

const { subscribeAcp } = await import("./acpLive.js");

describe("acpLive", () => {
	it("announces 'down' when the first connection closes before its hello", async () => {
		const events: string[] = [];
		const stop = subscribeAcp((ev) => events.push(ev.type));
		expect(sockets).toHaveLength(1);
		sockets[0]!.onclose?.();
		expect(events).toEqual(["down"]);
		// A chat opened during the outage is told too (it starts its poll).
		const late: string[] = [];
		const stop2 = subscribeAcp((ev) => late.push(ev.type));
		await Promise.resolve();
		expect(late).toEqual(["down"]);
		stop();
		stop2();
	});

	it("a first connection without a hello after 1 s: 'slow', then its hello is an 'open'", async () => {
		vi.useFakeTimers();
		vi.resetModules();
		sockets.length = 0;
		const live = await import("./acpLive.js");
		const events: string[] = [];
		const stop = live.subscribeAcp((ev) => events.push(ev.type));
		vi.advanceTimersByTime(999);
		expect(events).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(events).toEqual(["slow"]);
		sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "hello" }) });
		expect(events).toEqual(["slow", "open"]);
		stop();
		vi.useRealTimers();
	});

	it("a hello within 1 s: only 'open' (one first load)", async () => {
		vi.useFakeTimers();
		vi.resetModules();
		sockets.length = 0;
		const live = await import("./acpLive.js");
		const events: string[] = [];
		const stop = live.subscribeAcp((ev) => events.push(ev.type));
		vi.advanceTimersByTime(600);
		// Joining the connection on its way: it waits only for what is left of the second.
		const late: string[] = [];
		const stop2 = live.subscribeAcp((ev) => late.push(ev.type));
		vi.advanceTimersByTime(300);
		sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "hello" }) });
		vi.advanceTimersByTime(5_000);
		expect(events).toEqual(["open"]);
		expect(late).toEqual(["open"]);
		stop();
		stop2();
		vi.useRealTimers();
	});
});
