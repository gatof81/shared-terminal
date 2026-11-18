/**
 * acpLive.test.ts — the shared /ws/acp socket: a first connection that fails
 * before its hello must still tell the chats to poll over REST.
 */

import { describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(
	() =>
		[] as Array<{
			onclose: (() => void) | null;
			onmessage: unknown;
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
});
