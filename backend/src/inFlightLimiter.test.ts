import { describe, expect, it } from "vitest";
import { InFlightLimiter } from "./inFlightLimiter.js";

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
