import { describe, expect, it } from "vitest";
import { AttemptRun, EpochClosedError } from "./run.js";

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("AttemptRun (§2.7.4: evidence, not time)", () => {
	it("an answer inside the epoch is handed back and recorded", async () => {
		const run = new AttemptRun(Date.now() + 1000);
		expect(await run.call("x", async () => 42)).toBe(42);
		await expect(run.call("y", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
			"boom",
		);
		expect(run.evidence.map((e) => [e.label, e.ok, e.late])).toEqual([
			["x", true, false],
			["y", false, false],
		]);
	});

	it("the deadline closes the epoch and stops the WAITING, never the request", async () => {
		const run = new AttemptRun(Date.now() + 30);
		const d = deferred<string>();
		let continued = false;
		const p = run
			.call("create", () => d.promise)
			.then(() => {
				continued = true;
			});
		await expect(p).rejects.toBeInstanceOf(EpochClosedError);
		expect(run.epochOpen).toBe(false);
		expect(run.inflightLabels()).toEqual(["create"]);
		// dockerd answers late: recorded as evidence, the continuation never runs.
		d.resolve("n-id");
		await run.settled();
		expect(continued).toBe(false);
		expect(run.evidence).toEqual([
			expect.objectContaining({ label: "create", ok: true, late: true }),
		]);
	});

	it("after the epoch closed nothing new starts", async () => {
		const run = new AttemptRun(Date.now() + 1000);
		run.close("rollback");
		let started = false;
		await expect(
			run.call("rename", async () => {
				started = true;
			}),
		).rejects.toBeInstanceOf(EpochClosedError);
		expect(started).toBe(false);
	});

	it("an answer arriving after someone else closed the epoch is not handed back", async () => {
		const run = new AttemptRun(Date.now() + 1000);
		const d = deferred<void>();
		const p = run.call("start", () => d.promise);
		run.close("rollback");
		d.resolve();
		await expect(p).rejects.toBeInstanceOf(EpochClosedError);
	});

	it("settled() waits for every request, untimed ones included; a hung one keeps it pending", async () => {
		const run = new AttemptRun(Date.now() + 1000);
		const a = deferred<void>();
		const b = deferred<void>();
		void run.call("a", () => a.promise).catch(() => undefined);
		void run.untimed("b", () => b.promise);
		let settled = false;
		void run.settled().then(() => {
			settled = true;
		});
		a.resolve();
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);
		b.reject(new Error("dockerd said no"));
		await new Promise((r) => setTimeout(r, 0));
		expect(settled).toBe(true);
	});

	it("a synchronous throw is an answer like any other", async () => {
		const run = new AttemptRun(Date.now() + 1000);
		await expect(
			run.call("x", () => {
				throw new Error("sync");
			}),
		).rejects.toThrow("sync");
		await run.settled();
	});
});
