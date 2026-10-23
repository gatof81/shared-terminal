/**
 * ingestRoute.test.ts — `POST /ingest/claude/hook` over a real HTTP
 * server (docs/CONVERSATION.md §3.1): every branch answers 204 with an
 * empty body; Content-Length is required and capped at L5; invalid JSON,
 * the G2 gate and the rate buckets all degrade into counters/gaps; a
 * valid event is persisted after the response. The handler matches the
 * pathname exactly (a query string does not change the route), and no
 * failure inside the endpoint escapes the middleware as a rejection.
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
/** Settlement of every handler invocation: a rejection would be unhandled in production. */
let outcomes: Promise<"fulfilled" | "rejected">[];

beforeEach(async () => {
	svc = fakeService();
	outcomes = [];
	const handler = createIngestHandler({ service: svc, maxBodyBytes: 1024 });
	server = http.createServer((req, res) => {
		outcomes.push(
			handler(req, res, () => {
				res.statusCode = 404;
				res.end("fallthrough");
			}).then(
				() => "fulfilled" as const,
				() => "rejected" as const,
			),
		);
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

const AUTH = { authorization: "Bearer x", "x-st-session": "s1" };
async function allSettled() {
	return Promise.all(outcomes);
}

describe("ingest route — pathname without the query string", () => {
	it("POST with a query string → 204 empty through the same handler as without it", async () => {
		const body = JSON.stringify({ hook_event_name: "Stop", session_id: "c1" });
		const r = await post(body, { ...AUTH, "x-st-tmux-pane": "%2" }, `${INGEST_PATH}?x=1`);
		expect(r).toEqual({ status: 204, text: "" });
		await vi.waitFor(() => expect(svc.ingest).toHaveBeenCalledTimes(1));
		expect(svc.authorize).toHaveBeenCalledWith({
			authorization: "Bearer x",
			stSession: "s1",
			tmuxPane: "%2",
		});
		expect(svc.takeRate).toHaveBeenCalledWith("s1", Buffer.byteLength(body));
		expect(svc.ingest).toHaveBeenCalledWith("s1", "%2", {
			hook_event_name: "Stop",
			session_id: "c1",
		});
	});
	it("the query-string route applies the same validations: auth, L5 cap, JSON", async () => {
		svc.authorize.mockResolvedValueOnce({ accepted: false, reason: "bad_token" } as never);
		expect(await post("{}", AUTH, `${INGEST_PATH}?a=b`)).toEqual({ status: 204, text: "" });
		expect(svc.ingest).not.toHaveBeenCalled();

		const big = JSON.stringify({ pad: "x".repeat(2000) });
		expect(await post(big, AUTH, `${INGEST_PATH}?`)).toEqual({ status: 204, text: "" });
		await vi.waitFor(() =>
			expect(svc.noteUnparseable).toHaveBeenCalledWith("s1", undefined, "too_large"),
		);

		expect(await post("{bad", AUTH, `${INGEST_PATH}?x=1&y=2`)).toEqual({ status: 204, text: "" });
		await vi.waitFor(() =>
			expect(svc.noteUnparseable).toHaveBeenCalledWith("s1", undefined, "invalid_json"),
		);
		expect(svc.ingest).not.toHaveBeenCalled();
	});
	it("other paths (including prefix look-alikes) and other methods still pass through", async () => {
		for (const p of [
			`${INGEST_PATH}/`,
			`${INGEST_PATH}x`,
			`${INGEST_PATH}/x?y=1`,
			`${INGEST_PATH}x?y=1`,
			"/ingest/claude",
			`/other?next=${INGEST_PATH}`,
		]) {
			expect(await post("{}", AUTH, p)).toEqual({ status: 404, text: "fallthrough" });
		}
		for (const method of ["GET", "PUT", "DELETE"]) {
			const res = await fetch(`${base}${INGEST_PATH}?x=1`, {
				method,
				...(method === "GET" ? {} : { body: "{}" }),
			});
			expect({ status: res.status, text: await res.text() }).toEqual({
				status: 404,
				text: "fallthrough",
			});
		}
		expect(svc.authorize).not.toHaveBeenCalled();
	});
});

describe("ingest route — no rejection escapes the middleware", () => {
	const largeGate = () => {
		const gate = svc.largeBodies as LargeBodyGate;
		vi.spyOn(gate, "isLarge").mockReturnValue(true);
		return gate;
	};

	it("authorize rejects → 204 empty, body drained, handler settles, nothing retained", async () => {
		const gate = largeGate();
		svc.authorize.mockRejectedValueOnce(new Error("d1 down"));
		expect(await post(JSON.stringify({ pad: "x".repeat(900) }), AUTH)).toEqual({
			status: 204,
			text: "",
		});
		expect(await allSettled()).toEqual(["fulfilled"]);
		expect(svc.ingest).not.toHaveBeenCalled();
		expect(gate.current()).toBe(0);
		// The connection is still usable: the next request goes through normally.
		expect(await post("{}", AUTH)).toEqual({ status: 204, text: "" });
		await vi.waitFor(() => expect(svc.ingest).toHaveBeenCalledTimes(1));
	});
	it("noteUnparseable rejects on too_large → 204 empty, handler settles", async () => {
		svc.noteUnparseable.mockRejectedValueOnce(new Error("disk"));
		expect(await post(JSON.stringify({ pad: "x".repeat(2000) }), AUTH)).toEqual({
			status: 204,
			text: "",
		});
		await vi.waitFor(() => expect(svc.noteUnparseable).toHaveBeenCalledTimes(1));
		expect(await allSettled()).toEqual(["fulfilled"]);
	});
	it("noteUnparseable rejects on invalid_json with the G2 slot held → slot released", async () => {
		const gate = largeGate();
		svc.noteUnparseable.mockRejectedValueOnce(new Error("disk"));
		expect(await post("{bad", AUTH)).toEqual({ status: 204, text: "" });
		expect(await allSettled()).toEqual(["fulfilled"]);
		expect(svc.noteUnparseable).toHaveBeenCalledWith("s1", undefined, "invalid_json");
		expect(gate.current()).toBe(0);
	});
	it("ingest rejects with the G2 slot held → 204 empty, handler settles, slot released", async () => {
		const gate = largeGate();
		svc.ingest.mockRejectedValueOnce(new Error("boom"));
		expect(await post("{}", AUTH)).toEqual({ status: 204, text: "" });
		expect(await allSettled()).toEqual(["fulfilled"]);
		expect(svc.ingest).toHaveBeenCalledTimes(1);
		expect(gate.current()).toBe(0);
		// The slot is genuinely free: a second large body is admitted, not refused as backpressure.
		expect(await post("{}", AUTH)).toEqual({ status: 204, text: "" });
		await vi.waitFor(() => expect(svc.ingest).toHaveBeenCalledTimes(2));
		expect(svc.noteBackpressure).not.toHaveBeenCalled();
	});
});
