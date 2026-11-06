/**
 * dockerManager.sessionNetwork.test.ts — `inspectSessionNetworkWith`
 * (CONVERSATION.md §3.1.1): the identity and addresses come from inspecting
 * the container BY ID, only from the sessions network entry; a 404 is
 * `{exists:false}` and any other daemon error propagates (the verifier turns
 * it into a rejection).
 */

import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [] as unknown[], success: true as const, meta: {} })),
}));
vi.mock("./db.js", () => dbStubs);

import { inspectSessionNetworkWith } from "./dockerManager.js";

function docker(inspect: () => Promise<unknown>) {
	const getContainer = vi.fn(() => ({ inspect }));
	return { d: { getContainer } as unknown as Dockerode, getContainer };
}
const ID = "c".repeat(64);

describe("inspectSessionNetworkWith", () => {
	it("reads only the sessions network entry, by container id", async () => {
		const { d, getContainer } = docker(async () => ({
			Id: ID,
			State: { Running: true },
			NetworkSettings: {
				Networks: {
					"sessions-net": { IPAddress: "172.18.0.5", GlobalIPv6Address: "fd00::5" },
					bridge: { IPAddress: "172.17.0.2", GlobalIPv6Address: "" },
				},
			},
		}));
		expect(await inspectSessionNetworkWith(d, ID, "sessions-net")).toEqual({
			exists: true,
			id: ID,
			running: true,
			addresses: ["172.18.0.5", "fd00::5"],
		});
		expect(getContainer).toHaveBeenCalledWith(ID);
	});

	it("not on the sessions network ⇒ no addresses; stopped ⇒ running false", async () => {
		const { d } = docker(async () => ({
			Id: ID,
			State: { Running: false },
			NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.2" } } },
		}));
		expect(await inspectSessionNetworkWith(d, ID, "sessions-net")).toEqual({
			exists: true,
			id: ID,
			running: false,
			addresses: [],
		});
	});

	it("404 ⇒ exists:false; any other daemon error propagates", async () => {
		const gone = docker(async () => {
			throw Object.assign(new Error("no such container"), { statusCode: 404 });
		});
		expect(await inspectSessionNetworkWith(gone.d, ID, "sessions-net")).toEqual({ exists: false });
		const down = docker(async () => {
			throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
		});
		await expect(inspectSessionNetworkWith(down.d, ID, "sessions-net")).rejects.toThrow(
			"ECONNREFUSED",
		);
	});
});
