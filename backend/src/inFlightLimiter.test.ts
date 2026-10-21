import { EventEmitter } from "node:events";
import type { Response } from "express";
import { describe, expect, it } from "vitest";
import { InFlightLimiter } from "./inFlightLimiter.js";
import { holdSlotUntilResponseEnds } from "./routes/files.js";

describe("InFlightLimiter", () => {
	it("caps per key and releases idempotently", () => {
		const l = new InFlightLimiter(2, 10);
		const a = l.tryAcquire("u1");
		const b = l.tryAcquire("u1");
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(l.tryAcquire("u1")).toBeNull();
		a?.();
		a?.(); // double release must not free a second slot
		expect(l.inFlight("u1")).toBe(1);
		expect(l.tryAcquire("u1")).not.toBeNull();
		expect(l.tryAcquire("u1")).toBeNull();
	});

	it("caps the process-wide total across keys", () => {
		const l = new InFlightLimiter(5, 3);
		expect(l.tryAcquire("a")).not.toBeNull();
		expect(l.tryAcquire("b")).not.toBeNull();
		const c = l.tryAcquire("c");
		expect(l.tryAcquire("d")).toBeNull();
		c?.();
		expect(l.tryAcquire("d")).not.toBeNull();
		expect(l.inFlight()).toBe(3);
	});
});

describe("holdSlotUntilResponseEnds", () => {
	const fakeRes = () => new EventEmitter() as unknown as Response & EventEmitter;

	it("holds the slot until the response finishes, not when the handler returns", () => {
		const l = new InFlightLimiter(1, 10);
		const res = fakeRes();
		expect(holdSlotUntilResponseEnds(l, "u1", res)).toBe("held");
		// Handler returned, body queued (res.json) — still held.
		expect(l.inFlight("u1")).toBe(1);
		expect(holdSlotUntilResponseEnds(l, "u1", fakeRes())).toBe("busy");
		res.emit("finish");
		expect(l.inFlight("u1")).toBe(0);
		// finish followed by close must not double-release.
		res.emit("close");
		expect(l.inFlight()).toBe(0);
	});

	it("releases when the client goes away before the body is sent", () => {
		const l = new InFlightLimiter(1, 10);
		const res = fakeRes();
		holdSlotUntilResponseEnds(l, "u1", res);
		res.emit("close");
		expect(l.inFlight("u1")).toBe(0);
		expect(holdSlotUntilResponseEnds(l, "u1", fakeRes())).toBe("held");
	});

	it("doesn't acquire for a response that is already closed (client left during auth)", () => {
		const l = new InFlightLimiter(1, 10);
		for (const flag of ["destroyed", "writableEnded"] as const) {
			const res = fakeRes();
			Object.assign(res, { [flag]: true });
			expect(holdSlotUntilResponseEnds(l, "u1", res)).toBe("gone");
		}
		const res = fakeRes();
		Object.assign(res, { socket: { destroyed: true } });
		expect(holdSlotUntilResponseEnds(l, "u1", res)).toBe("gone");
		expect(l.inFlight()).toBe(0);
		// The pool is untouched: the next live request still gets its slot.
		expect(holdSlotUntilResponseEnds(l, "u1", fakeRes())).toBe("held");
	});
});
