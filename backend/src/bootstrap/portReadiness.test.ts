import { describe, expect, it, vi } from "vitest";
import type { PortEntry } from "../sessionConfig.js";
import { runPortReadinessProbes } from "./portReadiness.js";

// ── Harness ────────────────────────────────────────────────────────────────
//
// All tests inject `fetchImpl` + a tiny `pollIntervalMs` so the retry loop
// runs in wall-clock milliseconds, and use short `timeoutSec` budgets so a
// never-ready probe exhausts its budget within the test timeout.

function port(container: number, readiness?: { path: string; timeoutSec: number }): PortEntry {
	return { container, public: false, ...(readiness ? { readiness } : {}) };
}

function collectOutput(): { onOutput: (chunk: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { onOutput: (chunk) => lines.push(chunk), lines };
}

const ok = () => ({ status: 200 }) as Response;
const notFound = () => ({ status: 404 }) as Response;

describe("runPortReadinessProbes", () => {
	it("returns immediately (no fetch, no output) when no port has readiness", async () => {
		const { onOutput, lines } = collectOutput();
		const fetchImpl = vi.fn();
		await runPortReadinessProbes({
			containerName: "st-abc",
			ports: [port(3000), port(8080)],
			onOutput,
			signal: new AbortController().signal,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			pollIntervalMs: 1,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(lines).toEqual([]);
	});

	it("emits the waiting line then the ready line on an immediate 2xx", async () => {
		const { onOutput, lines } = collectOutput();
		const fetchImpl = vi.fn(async () => ok());
		await runPortReadinessProbes({
			containerName: "st-abc",
			ports: [port(3000, { path: "/health", timeoutSec: 5 })],
			onOutput,
			signal: new AbortController().signal,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			pollIntervalMs: 1,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// The probe target is the container name over the shared network
		// (the #190 direct-proxy topology), not a host port.
		expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://st-abc:3000/health");
		expect(lines[0]).toBe("[readiness] waiting on port 3000 (GET /health, up to 5s)…\n");
		expect(lines[1]).toMatch(/^\[readiness\] port 3000 ready after \d+\.\ds\n$/);
	});

	it("keeps polling through failures / non-2xx and reports ready on the eventual 2xx", async () => {
		const { onOutput, lines } = collectOutput();
		const fetchImpl = vi
			.fn<() => Promise<Response>>()
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValueOnce(notFound())
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValue(ok());
		await runPortReadinessProbes({
			containerName: "st-abc",
			ports: [port(3000, { path: "/", timeoutSec: 30 })],
			onOutput,
			signal: new AbortController().signal,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			pollIntervalMs: 1,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(lines.at(-1)).toMatch(/^\[readiness\] port 3000 ready after /);
	});

	it("emits the advisory WARN line and RESOLVES when the budget is exhausted", async () => {
		const { onOutput, lines } = collectOutput();
		const fetchImpl = vi.fn(async () => notFound());
		// timeoutSec: 1 with a 5 ms poll → a handful of attempts, then WARN.
		await expect(
			runPortReadinessProbes({
				containerName: "st-abc",
				ports: [port(3000, { path: "/health", timeoutSec: 1 })],
				onOutput,
				signal: new AbortController().signal,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				pollIntervalMs: 5,
			}),
		).resolves.toBeUndefined();
		expect(lines.at(-1)).toBe(
			"[readiness] WARN: port 3000 not ready after 1s — continuing (readiness is advisory)\n",
		);
	}, 10_000);

	it("resolves with a single abort line when the outer signal fires", async () => {
		const { onOutput, lines } = collectOutput();
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => {
			// Abort mid-flight: the request "fails", the loop-top check
			// sees the aborted signal and bails with one line instead of
			// burning the rest of the budget.
			controller.abort();
			throw new Error("aborted");
		});
		await expect(
			runPortReadinessProbes({
				containerName: "st-abc",
				ports: [port(3000, { path: "/health", timeoutSec: 60 })],
				onOutput,
				signal: controller.signal,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				pollIntervalMs: 1,
			}),
		).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(lines.at(-1)).toBe(
			"[readiness] aborted while waiting on port 3000 — continuing (readiness is advisory)\n",
		);
	});

	it("probes multiple readiness ports in parallel and skips the plain ones", async () => {
		const { onOutput, lines } = collectOutput();
		const inFlight = new Set<string>();
		let sawBothInFlight = false;
		const fetchImpl = vi.fn(async (url: string) => {
			inFlight.add(url);
			if (inFlight.size === 2) sawBothInFlight = true;
			// Hold every request across a macrotask so the two probes'
			// first attempts demonstrably overlap — a sequential runner
			// could never have both URLs in flight at once.
			await new Promise((r) => setTimeout(r, 5));
			inFlight.delete(url);
			return ok();
		});
		await runPortReadinessProbes({
			containerName: "st-abc",
			ports: [
				port(3000, { path: "/a", timeoutSec: 5 }),
				port(9999),
				port(8080, { path: "/b", timeoutSec: 5 }),
			],
			onOutput,
			signal: new AbortController().signal,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			pollIntervalMs: 1,
		});
		expect(sawBothInFlight).toBe(true);
		const urls = fetchImpl.mock.calls.map((c) => c[0]);
		expect(urls).toContain("http://st-abc:3000/a");
		expect(urls).toContain("http://st-abc:8080/b");
		expect(urls.every((u) => !String(u).includes(":9999"))).toBe(true);
		expect(lines.filter((l) => l.includes("ready after"))).toHaveLength(2);
	});

	it("never rejects, even when fetchImpl throws synchronously", async () => {
		const { onOutput, lines } = collectOutput();
		const fetchImpl = vi.fn(() => {
			throw new Error("hostile fetch");
		});
		await expect(
			runPortReadinessProbes({
				containerName: "st-abc",
				ports: [port(3000, { path: "/health", timeoutSec: 1 })],
				onOutput,
				signal: new AbortController().signal,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				pollIntervalMs: 5,
			}),
		).resolves.toBeUndefined();
		// Sync throws land in the same not-ready-yet bucket as rejections,
		// so the budget still runs out into the advisory WARN.
		expect(lines.at(-1)).toMatch(/WARN: port 3000 not ready after 1s/);
	}, 10_000);

	it("discards the response body so the poll loop can't leak sockets", async () => {
		const cancel = vi.fn(async () => undefined);
		const fetchImpl = vi.fn(async () => ({ status: 200, body: { cancel } }) as unknown as Response);
		const { onOutput } = collectOutput();
		await runPortReadinessProbes({
			containerName: "st-abc",
			ports: [port(3000, { path: "/health", timeoutSec: 5 })],
			onOutput,
			signal: new AbortController().signal,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			pollIntervalMs: 1,
		});
		expect(cancel).toHaveBeenCalledTimes(1);
	});
});
