import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import {
	clearPortMappings,
	getPortMappings,
	type PortMapping,
	parseInspectPorts,
	setPortMappings,
} from "./portMappings.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockImplementation(async () => ({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
});

// ── parseInspectPorts ────────────────────────────────────────────────────

describe("parseInspectPorts", () => {
	it("returns [] for undefined / null / empty", () => {
		expect(parseInspectPorts(undefined)).toEqual([]);
		expect(parseInspectPorts(null)).toEqual([]);
		expect(parseInspectPorts({})).toEqual([]);
	});

	it("extracts container_port:host_port from the standard tcp shape", () => {
		const got = parseInspectPorts({
			"3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }],
			"5500/tcp": [{ HostIp: "0.0.0.0", HostPort: "32769" }],
		});
		// Order is `Object.entries` order, which JS preserves for
		// non-integer-string keys; `3000/tcp` comes before `5500/tcp`.
		expect(got).toEqual([
			{ containerPort: 3000, hostPort: 32768 },
			{ containerPort: 5500, hostPort: 32769 },
		]);
	});

	it("takes the FIRST binding when Docker emits IPv4 and IPv6 entries", () => {
		// Real Docker output has two entries per port — same HostPort.
		// Taking [0] is sufficient (we don't care which IP family bound).
		const got = parseInspectPorts({
			"3000/tcp": [
				{ HostIp: "0.0.0.0", HostPort: "32768" },
				{ HostIp: "::", HostPort: "32768" },
			],
		});
		expect(got).toEqual([{ containerPort: 3000, hostPort: 32768 }]);
	});

	it("skips ports with null bindings (exposed but unpublished)", () => {
		const got = parseInspectPorts({
			"3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }],
			"5500/tcp": null,
		});
		expect(got).toEqual([{ containerPort: 3000, hostPort: 32768 }]);
	});

	it("skips ports with empty binding arrays", () => {
		const got = parseInspectPorts({
			"3000/tcp": [],
			"5500/tcp": [{ HostIp: "0.0.0.0", HostPort: "32769" }],
		});
		expect(got).toEqual([{ containerPort: 5500, hostPort: 32769 }]);
	});

	it("accepts a key without the /proto suffix (defensive)", () => {
		expect(parseInspectPorts({ "3000": [{ HostPort: "32768" }] })).toEqual([
			{ containerPort: 3000, hostPort: 32768 },
		]);
	});

	it("skips malformed entries without crashing the spawn path", () => {
		// All four shapes are unreachable today (Docker's API enforces the
		// shape) but a future API change shouldn't hard-fail the spawn.
		const got = parseInspectPorts({
			"not-a-port": [{ HostPort: "32768" }],
			"3000/tcp": [{ HostPort: "not-a-number" }],
			"-1/tcp": [{ HostPort: "32768" }],
			"4000/tcp": [{ HostPort: "0" }],
		});
		expect(got).toEqual([]);
	});
});

// ── setPortMappings ──────────────────────────────────────────────────────

describe("setPortMappings", () => {
	it("issues DELETE-then-INSERT in order, one INSERT per mapping", async () => {
		const mappings: PortMapping[] = [
			{ containerPort: 3000, hostPort: 32768 },
			{ containerPort: 5500, hostPort: 32769 },
		];
		await setPortMappings("sess-1", mappings);

		expect(dbStubs.d1Query).toHaveBeenCalledTimes(3);
		expect(dbStubs.d1Query.mock.calls[0]?.[0]).toMatch(
			/DELETE FROM sessions_port_mappings WHERE session_id/,
		);
		expect(dbStubs.d1Query.mock.calls[0]?.[1]).toEqual(["sess-1"]);
		expect(dbStubs.d1Query.mock.calls[1]?.[0]).toMatch(/INSERT INTO sessions_port_mappings/);
		expect(dbStubs.d1Query.mock.calls[1]?.[1]).toEqual(["sess-1", 3000, 32768]);
		expect(dbStubs.d1Query.mock.calls[2]?.[1]).toEqual(["sess-1", 5500, 32769]);
	});

	it("issues only the DELETE when the mapping list is empty", async () => {
		// Spawning with no declared ports must still clear any stale
		// rows from a previous container life — `setPortMappings(s, [])`
		// is the one-call entry point for that.
		await setPortMappings("sess-empty", []);
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		expect(dbStubs.d1Query.mock.calls[0]?.[0]).toMatch(/DELETE/);
	});
});

// ── getPortMappings ──────────────────────────────────────────────────────

describe("getPortMappings", () => {
	it("returns [] when no rows exist for the session", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(getPortMappings("sess-x")).resolves.toEqual([]);
	});

	it("rehydrates D1 rows into the typed shape", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{ container_port: 3000, host_port: 32768 },
				{ container_port: 5500, host_port: 32769 },
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(getPortMappings("sess-y")).resolves.toEqual([
			{ containerPort: 3000, hostPort: 32768 },
			{ containerPort: 5500, hostPort: 32769 },
		]);
	});
});

// ── clearPortMappings ────────────────────────────────────────────────────

describe("clearPortMappings", () => {
	it("issues a single DELETE bound to the session id", async () => {
		await clearPortMappings("sess-z");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/DELETE FROM sessions_port_mappings WHERE session_id/);
		expect(params).toEqual(["sess-z"]);
	});
});
