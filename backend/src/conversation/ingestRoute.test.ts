/**
 * ingestRoute.test.ts — `POST /ingest/claude/hook` over a real HTTP
 * server (docs/CONVERSATION.md §3.1): every branch answers 204 with an
 * empty body; Content-Length is required and capped at L5; invalid JSON,
 * the G2 gate and the rate buckets all degrade into counters/gaps; a
 * valid event is persisted after the response.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INGEST_PATH } from "./activation.js";
import { createIngestHandler } from "./ingestRoute.js";
import { LargeBodyGate } from "./rateLimit.js";
import type { ConversationService } from "./service.js";

function fakeService() {
	const svc = {
		largeBodies: new LargeBodyGate(1),
		authorize: vi.fn(async () => ({ ok: true as const, stSessionId: "s1" })),
		takeRate: vi.fn(() => ({ ok: true as const })),
		noteUnparseable: vi.fn(async () => undefined),
		noteBackpressure: vi.fn(),
		ingest: vi.fn(async () => ({ accepted: true as const, cid: "c1" })),
	};
	return svc as unknown as ConversationService & typeof svc;
}

let server: http.Server;
let base: string;
let svc: ReturnType<typeof fakeService>;

beforeEach(async () => {
	svc = fakeService();
	const handler = createIngestHandler({ service: svc, maxBodyBytes: 1024 });
	server = http.createServer((req, res) => {
		void handler(req, res, () => {
			res.statusCode = 404;
			res.end("fallthrough");
		});
	});
	await new Promise<void>((r) => server.listen(0, r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function post(
	body: string | Buffer,
	headers: Record<string, string> = {},
	path = INGEST_PATH,
) {
	const res = await fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
	return { status: res.status, text: await res.text() };
}

describe("ingest route", () => {
	it("passes non-matching requests through", async () => {
		const res = await fetch(`${base}/other`, { method: "POST", body: "{}" });
		expect(res.status).toBe(404);
		const get = await fetch(base + INGEST_PATH);
		expect(get.status).toBe(404);
	});
	it("answers 204 with an empty body on a valid event and persists it afterwards", async () => {
		const r = await post(JSON.stringify({ hook_event_name: "Stop", session_id: "c1" }), {
			authorization: "Bearer x",
			"x-st-session": "s1",
			"x-st-tmux-pane": "%3",
		});
		expect(r).toEqual({ status: 204, text: "" });
		await vi.waitFor(() => expect(svc.ingest).toHaveBeenCalledTimes(1));
		expect(svc.ingest).toHaveBeenCalledWith("s1", "%3", {
			hook_event_name: "Stop",
			session_id: "c1",
		});
		expect(svc.takeRate).toHaveBeenCalledWith(
			"s1",
			Buffer.byteLength('{"hook_event_name":"Stop","session_id":"c1"}'),
		);
	});
	it("rejected auth still answers 204 and never reads the body into ingest", async () => {
		svc.authorize.mockResolvedValueOnce({ accepted: false, reason: "bad_token" } as never);
		const r = await post("{}", { authorization: "Bearer nope", "x-st-session": "s1" });
		expect(r).toEqual({ status: 204, text: "" });
		expect(svc.ingest).not.toHaveBeenCalled();
	});
	it("a body over the cap → 204 + too_large, nothing ingested", async () => {
		const r = await post(JSON.stringify({ pad: "x".repeat(2000) }), {
			authorization: "Bearer x",
			"x-st-session": "s1",
		});
		expect(r.status).toBe(204);
		await vi.waitFor(() =>
			expect(svc.noteUnparseable).toHaveBeenCalledWith("s1", undefined, "too_large"),
		);
		expect(svc.ingest).not.toHaveBeenCalled();
	});
	it("a chunked body with no Content-Length → 204 + too_large", async () => {
		await new Promise<void>((resolve) => {
			const req = http.request(
				`${base}${INGEST_PATH}`,
				{
					method: "POST",
					headers: {
						authorization: "Bearer x",
						"x-st-session": "s1",
						"transfer-encoding": "chunked",
					},
				},
				(res) => {
					expect(res.statusCode).toBe(204);
					res.resume();
					res.on("end", resolve);
				},
			);
			req.write("{}");
			req.end();
		});
		await vi.waitFor(() =>
			expect(svc.noteUnparseable).toHaveBeenCalledWith("s1", undefined, "too_large"),
		);
	});
	it("invalid JSON → 204 + invalid_json", async () => {
		const r = await post("{not json", { authorization: "Bearer x", "x-st-session": "s1" });
		expect(r.status).toBe(204);
		await vi.waitFor(() =>
			expect(svc.noteUnparseable).toHaveBeenCalledWith("s1", undefined, "invalid_json"),
		);
	});
	it("rate refusal → 204, body drained, nothing ingested", async () => {
		svc.takeRate.mockReturnValueOnce({ accepted: false, reason: "rate_limited" } as never);
		const r = await post("{}", { authorization: "Bearer x", "x-st-session": "s1" });
		expect(r.status).toBe(204);
		expect(svc.ingest).not.toHaveBeenCalled();
	});
	it("G2: a large body past the gate → 204 + backpressure(ingest); the gate is released after the read", async () => {
		const gate = svc.largeBodies as LargeBodyGate;
		vi.spyOn(gate, "isLarge").mockReturnValue(true);
		const hold = gate.acquire();
		const r = await post("{}", {
			authorization: "Bearer x",
			"x-st-session": "s1",
			"x-st-tmux-pane": "%1",
		});
		expect(r.status).toBe(204);
		expect(svc.noteBackpressure).toHaveBeenCalledWith("s1", "%1", "ingest");
		hold?.();
		const r2 = await post("{}", { authorization: "Bearer x", "x-st-session": "s1" });
		expect(r2.status).toBe(204);
		await vi.waitFor(() => expect(svc.ingest).toHaveBeenCalledTimes(1));
		expect(gate.current()).toBe(0);
	});
	it("an unexpected service failure still answers 204", async () => {
		svc.ingest.mockRejectedValueOnce(new Error("boom"));
		const r = await post("{}", { authorization: "Bearer x", "x-st-session": "s1" });
		expect(r.status).toBe(204);
	});
	it("sanitises the pane header", async () => {
		await post("{}", {
			authorization: "Bearer x",
			"x-st-session": "s1",
			"x-st-tmux-pane": "evil; rm -rf",
		});
		await vi.waitFor(() => expect(svc.ingest).toHaveBeenCalledWith("s1", undefined, {}));
	});
});
