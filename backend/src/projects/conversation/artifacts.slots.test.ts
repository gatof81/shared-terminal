/**
 * The artifact registration's in-flight slots (routes/projectConversation.ts)
 * through the REAL route behind the REAL requireAuth: a slot is held until
 * the registration has SETTLED and the response has ended, never released
 * by the client going away. A registration keeps copying after its client
 * disconnects (or its HTTP request times out), so if `close` returned the
 * slot, a client that aborts in a loop would have unbounded registrations
 * (memory, I/O) in flight; the §6.2 byte budget is held by reservations.
 */

import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.JWT_SECRET ??= "artifacts-slots-test-secret-not-for-production";
});

import { AUTH_COOKIE_NAME, signCliToken, validateJwtSecret } from "../../auth.js";
import { registerProjectConversationRoutes } from "../../routes/projectConversation.js";
import type { RouteContext } from "../../routes/shared.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";

let server: ReturnType<express.Express["listen"]>;
let base: string;
/** Every register call, with the resolver that lets it settle. */
let calls: Array<() => void>;
let settled: number;

beforeEach(async () => {
	validateJwtSecret();
	calls = [];
	settled = 0;
	const art = {
		register: () =>
			new Promise<{ status: number; body: unknown }>((resolve) => {
				calls.push(() => {
					settled += 1;
					resolve({ status: 201, body: { replayed: false } });
				});
			}),
		content: async () => ({ status: 404, body: { error: "artifact-not-found" } }),
	};
	const api = {
		store: { unavailable: null },
		owns: async (owner: string, pid: string) => owner === OWNER && pid === PID,
	};
	const noLimit: express.RequestHandler = (_q, _s, next) => next();
	const ctx = {
		projects: {} as RouteContext["projects"],
		projectConversation: { api, artifacts: art },
		limiters: new Proxy({}, { get: () => noLimit }),
	} as unknown as RouteContext;
	const app = express();
	app.use(express.json());
	const router = express.Router();
	registerProjectConversationRoutes(router, ctx);
	app.use("/api", router);
	server = app.listen(0, "127.0.0.1");
	await new Promise<void>((r) => server.once("listening", () => r()));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterEach(async () => {
	for (const c of calls) c();
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
});

const post = (signal?: AbortSignal) =>
	fetch(`${base}/projects/${PID}/conversation/artifacts`, {
		method: "POST",
		headers: {
			cookie: `${AUTH_COOKIE_NAME}=${signCliToken(OWNER, OWNER)}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ agentId: "a", path: "x" }),
		signal,
	});
const until = async (cond: () => boolean) => {
	for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(cond()).toBe(true);
};

describe("artifact registration slots: held until the work settles", () => {
	it("a client that disconnects mid-register does not free its slot until the work settles", async () => {
		// Fill the per-user slots (2) with registrations whose clients then leave.
		const aborts = [new AbortController(), new AbortController()];
		const pending = aborts.map((a) => post(a.signal).catch(() => "aborted"));
		await until(() => calls.length === 2);
		for (const a of aborts) a.abort();
		expect(await Promise.all(pending)).toEqual(["aborted", "aborted"]);
		// Let the server see both sockets close.
		await new Promise((r) => setTimeout(r, 50));

		// Both registrations are still running: no third may start.
		const third = await post();
		expect(third.status).toBe(429);
		expect(await third.json()).toEqual({ error: "busy" });
		expect(calls).toHaveLength(2);

		// Further clients (each would be one more copy) cannot put more work in flight.
		for (let i = 0; i < 5; i++) {
			const a = new AbortController();
			const r = await post(a.signal);
			expect(r.status).toBe(429);
		}
		expect(calls).toHaveLength(2);

		// One settles ⇒ exactly one slot comes back.
		calls[0]?.();
		await until(() => settled === 1);
		const fourth = post();
		await until(() => calls.length === 3);
		const fifth = await post();
		expect(fifth.status).toBe(429);
		calls[2]?.();
		expect((await fourth).status).toBe(201);
	});
});
