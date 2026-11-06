/**
 * ingestOrigin.test.ts — §3.1.1 network-origin check (v1.8.6): address
 * normalization, and the verifier against the adversarial cases the owner
 * listed for PR-G3-1 — token of A sent from B, Tunnel/loopback, IPv4-mapped
 * IPv6, address reuse, recreation, stopped container, inspection failure,
 * concurrent identity change — plus the cost bound (one inspection per
 * container, single-flight, positive-only cache).
 */

import { describe, expect, it, vi } from "vitest";
import {
	IngestOriginVerifier,
	isLoopback,
	normalizeAddress,
	type SessionNetworkPort,
	type SessionNetworkView,
} from "./ingestOrigin.js";

const A_IP = "172.18.0.5";
const B_IP = "172.18.0.6";
const CID_A = "a".repeat(64);
const CID_N = "b".repeat(64);

function running(id: string, addresses: string[]): SessionNetworkView {
	return { exists: true, id, running: true, addresses };
}

/** A Docker view per container id, editable by the test. */
function fakePort(initial: Record<string, SessionNetworkView>) {
	const views = { ...initial };
	const port = {
		views,
		inspectSessionNetwork: vi.fn(async (cid: string): Promise<SessionNetworkView> => {
			const v = views[cid];
			if (v instanceof Error) throw v;
			return v ?? { exists: false };
		}),
	};
	return port as SessionNetworkPort & typeof port;
}

describe("normalizeAddress", () => {
	it.each([
		["172.18.0.5", "172.18.0.5"],
		[" 172.18.0.5 ", "172.18.0.5"],
		["::ffff:172.18.0.5", "172.18.0.5"],
		["::FFFF:172.18.0.5", "172.18.0.5"],
		["::ffff:ac12:5", "172.18.0.5"], // IPv4-mapped written in hex
		["0:0:0:0:0:ffff:ac12:0005", "172.18.0.5"],
		["2001:DB8::1", "2001:db8:0:0:0:0:0:1"],
		["2001:db8:0:0:0:0:0:1", "2001:db8:0:0:0:0:0:1"],
		["fe80::1%eth0", "fe80:0:0:0:0:0:0:1"],
		["[2001:db8::1]", "2001:db8:0:0:0:0:0:1"],
		["::1", "0:0:0:0:0:0:0:1"],
		["::", "0:0:0:0:0:0:0:0"],
	])("%s → %s", (raw, want) => {
		expect(normalizeAddress(raw)).toBe(want);
	});
	it.each([
		undefined,
		null,
		"",
		"localhost",
		"1.2.3",
		"1.2.3.256",
		":::",
		"2001:db8::1::2",
		"::ffff:1.2.3",
	])("rejects %s", (raw) => {
		expect(normalizeAddress(raw as string | null | undefined)).toBeNull();
	});
	it("an IPv4 and its mapped IPv6 form compare equal; other IPv6 spellings too", () => {
		expect(normalizeAddress("::ffff:10.0.0.1")).toBe(normalizeAddress("10.0.0.1"));
		expect(normalizeAddress("2001:0db8:0000::0001")).toBe(normalizeAddress("2001:db8::1"));
	});
	it("loopback covers 127/8, ::1 and mapped 127.x", () => {
		for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
			expect(isLoopback(normalizeAddress(a) as string)).toBe(true);
		}
		expect(isLoopback(normalizeAddress(A_IP) as string)).toBe(false);
	});
});

describe("IngestOriginVerifier", () => {
	it("accepts the session's current container, also as an IPv4-mapped peer", async () => {
		const port = fakePort({ [CID_A]: running(CID_A, [A_IP]) });
		const v = new IngestOriginVerifier(port);
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: true });
		expect(await v.verify("sA", CID_A, `::ffff:${A_IP}`)).toEqual({ ok: true });
	});

	it("token of A sent from B's container ⇒ mismatch", async () => {
		const port = fakePort({ [CID_A]: running(CID_A, [A_IP]) });
		const v = new IngestOriginVerifier(port);
		expect(await v.verify("sA", CID_A, B_IP)).toEqual({ ok: false, cause: "mismatch" });
	});

	it("Tunnel / host loopback ⇒ rejected before any inspection", async () => {
		const port = fakePort({ [CID_A]: running(CID_A, [A_IP]) });
		const v = new IngestOriginVerifier(port);
		for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
			expect(await v.verify("sA", CID_A, peer)).toEqual({ ok: false, cause: "loopback" });
		}
		expect(port.inspectSessionNetwork).not.toHaveBeenCalled();
	});

	it("no peer address, or not an IP ⇒ no_remote; no container in D1 ⇒ no_container", async () => {
		const port = fakePort({});
		const v = new IngestOriginVerifier(port);
		expect(await v.verify("sA", CID_A, undefined)).toEqual({ ok: false, cause: "no_remote" });
		expect(await v.verify("sA", CID_A, "evil.example")).toEqual({ ok: false, cause: "no_remote" });
		expect(await v.verify("sA", null, A_IP)).toEqual({ ok: false, cause: "no_container" });
		expect(port.inspectSessionNetwork).not.toHaveBeenCalled();
	});

	it("stopped, gone, replaced, address-less or unreadable container ⇒ rejected, nothing cached", async () => {
		const cases: Array<[SessionNetworkView | Error, string]> = [
			[{ exists: true, id: CID_A, running: false, addresses: [A_IP] }, "not_running"],
			[{ exists: false }, "container_gone"],
			[running(CID_N, [A_IP]), "container_replaced"],
			[running(CID_A, []), "no_address"],
			[running(CID_A, ["127.0.0.1"]), "no_address"],
			[new Error("daemon unreachable"), "inspect_failed"],
		];
		for (const [view, cause] of cases) {
			const port = fakePort({ [CID_A]: view as SessionNetworkView });
			const v = new IngestOriginVerifier(port);
			expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: false, cause });
			await v.verify("sA", CID_A, A_IP);
			expect(port.inspectSessionNetwork).toHaveBeenCalledTimes(2); // negative ⇒ not cached
		}
	});

	it("a container that just started is accepted on the next request (negatives are not cached)", async () => {
		const port = fakePort({ [CID_A]: { exists: true, id: CID_A, running: false, addresses: [] } });
		const v = new IngestOriginVerifier(port);
		expect((await v.verify("sA", CID_A, A_IP)).ok).toBe(false);
		port.views[CID_A] = running(CID_A, [A_IP]);
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: true });
	});

	it("address reuse: A stops (teardown invalidates), B gets A's old IP ⇒ A's token from it is refused", async () => {
		const port = fakePort({ [CID_A]: running(CID_A, [A_IP]) });
		const v = new IngestOriginVerifier(port);
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: true });
		// A goes down; the session teardown invalidates its identity.
		port.views[CID_A] = { exists: true, id: CID_A, running: false, addresses: [] };
		v.invalidate("sA");
		// The address now belongs to another session's container, which also has A's token.
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: false, cause: "not_running" });
	});

	it("without a teardown (crash), the positive view lives at most the TTL — the declared residual", async () => {
		let now = 0;
		const port = fakePort({ [CID_A]: running(CID_A, [A_IP]) });
		const v = new IngestOriginVerifier(port, { now: () => now, ttlMs: 10_000 });
		expect((await v.verify("sA", CID_A, A_IP)).ok).toBe(true);
		port.views[CID_A] = { exists: true, id: CID_A, running: false, addresses: [] };
		now = 9_999;
		expect((await v.verify("sA", CID_A, A_IP)).ok).toBe(true); // inside the window
		now = 10_001;
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: false, cause: "not_running" });
	});

	it("recreation: D1 now names N ⇒ only N's address passes; a stale O id finds O gone", async () => {
		const N_IP = "172.18.0.9";
		const port = fakePort({ [CID_A]: running(CID_A, [A_IP]) });
		const v = new IngestOriginVerifier(port);
		expect((await v.verify("sA", CID_A, A_IP)).ok).toBe(true);
		delete port.views[CID_A]; // O removed
		port.views[CID_N] = running(CID_N, [N_IP]);
		expect(await v.verify("sA", CID_N, A_IP)).toEqual({ ok: false, cause: "mismatch" });
		expect(await v.verify("sA", CID_N, N_IP)).toEqual({ ok: true });
		// A caller still holding O's id (stale token cache) is refused, not served from N's view.
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: false, cause: "container_gone" });
	});

	it("concurrent identity change: an inspection overtaken by invalidate does not count and caches nothing", async () => {
		let release: (view: SessionNetworkView) => void = () => undefined;
		const port: SessionNetworkPort & { calls: number } = {
			calls: 0,
			inspectSessionNetwork: async () => {
				port.calls++;
				return new Promise<SessionNetworkView>((r) => {
					release = r;
				});
			},
		};
		const v = new IngestOriginVerifier(port);
		const pending = v.verify("sA", CID_A, A_IP);
		await Promise.resolve();
		v.invalidate("sA"); // e.g. the container went down mid-inspection
		release(running(CID_A, [A_IP]));
		expect(await pending).toEqual({ ok: false, cause: "identity_changed" });
		// Nothing was cached: the next request inspects again.
		const again = v.verify("sA", CID_A, A_IP);
		await Promise.resolve();
		release(running(CID_A, [A_IP]));
		expect(await again).toEqual({ ok: true });
		expect(port.calls).toBe(2);
	});

	it("cost: one inspection for a burst (single-flight) and for repeats within the TTL", async () => {
		let now = 0;
		const port = fakePort({ [CID_A]: running(CID_A, [A_IP]) });
		const v = new IngestOriginVerifier(port, { now: () => now, ttlMs: 10_000 });
		const burst = await Promise.all(Array.from({ length: 50 }, () => v.verify("sA", CID_A, A_IP)));
		expect(burst.every((r) => r.ok)).toBe(true);
		for (let i = 0; i < 50; i++) await v.verify("sA", CID_A, A_IP);
		expect(port.inspectSessionNetwork).toHaveBeenCalledTimes(1);
		now = 10_001;
		await v.verify("sA", CID_A, A_IP);
		expect(port.inspectSessionNetwork).toHaveBeenCalledTimes(2);
	});

	it("sessions are independent: invalidating one never touches another's view", async () => {
		const port = fakePort({ [CID_A]: running(CID_A, [A_IP]), [CID_N]: running(CID_N, [B_IP]) });
		const v = new IngestOriginVerifier(port);
		await v.verify("sA", CID_A, A_IP);
		await v.verify("sB", CID_N, B_IP);
		v.invalidate("sA");
		await v.verify("sB", CID_N, B_IP);
		expect(port.inspectSessionNetwork).toHaveBeenCalledTimes(2);
		// and a session's view never answers for another session's container
		expect(await v.verify("sB", CID_N, A_IP)).toEqual({ ok: false, cause: "mismatch" });
	});
});

describe("IngestOriginVerifier — inspection deadline (fail-closed)", () => {
	/** An inspect that answers only when the test says so. */
	function controlledPort() {
		let settle: { ok: (v: SessionNetworkView) => void; err: (e: Error) => void } | null = null;
		const port = {
			calls: 0,
			inspectSessionNetwork: async () => {
				port.calls++;
				return new Promise<SessionNetworkView>((ok, err) => {
					settle = { ok, err };
				});
			},
			answer: (v: SessionNetworkView) => settle?.ok(v),
			fail: (e: Error) => settle?.err(e),
		};
		return port;
	}

	it("a hung inspection is refused at the deadline", async () => {
		const port = controlledPort();
		const v = new IngestOriginVerifier(port, { inspectTimeoutMs: 30 });
		const t0 = Date.now();
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: false, cause: "inspect_timeout" });
		expect(Date.now() - t0).toBeLessThan(500);
	});

	it("a late positive answer neither accredits nor caches", async () => {
		const port = controlledPort();
		const v = new IngestOriginVerifier(port, { inspectTimeoutMs: 30 });
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: false, cause: "inspect_timeout" });
		port.answer(running(CID_A, [A_IP])); // arrives after the deadline
		await new Promise((r) => setTimeout(r, 10));
		// Nothing was cached from it: the next request inspects again (and hangs ⇒ refused again).
		expect(await v.verify("sA", CID_A, A_IP)).toEqual({ ok: false, cause: "inspect_timeout" });
		expect(port.calls).toBe(2);
	});

	it("a late rejection is swallowed (no unhandled rejection)", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const port = controlledPort();
			const v = new IngestOriginVerifier(port, { inspectTimeoutMs: 20 });
			expect((await v.verify("sA", CID_A, A_IP)).ok).toBe(false);
			port.fail(new Error("daemon finally answered with an error"));
			await new Promise((r) => setTimeout(r, 20));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("a burst during a hang shares one inspection and one refusal", async () => {
		const port = controlledPort();
		const v = new IngestOriginVerifier(port, { inspectTimeoutMs: 30 });
		const all = await Promise.all(Array.from({ length: 20 }, () => v.verify("sA", CID_A, A_IP)));
		expect(all.every((r) => !r.ok && r.cause === "inspect_timeout")).toBe(true);
		expect(port.calls).toBe(1);
	});

	it("an answer inside the deadline still works", async () => {
		const port = controlledPort();
		const v = new IngestOriginVerifier(port, { inspectTimeoutMs: 200 });
		const pending = v.verify("sA", CID_A, A_IP);
		await new Promise((r) => setTimeout(r, 5));
		port.answer(running(CID_A, [A_IP]));
		expect(await pending).toEqual({ ok: true });
	});
});
