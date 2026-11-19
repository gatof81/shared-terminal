// The runner watchdog: it acts on the runner loop's real liveness, never on
// silence, launches only what is proven dead, and never twice at once.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	holdUntilBootstrapped,
	onBootstrapReleased,
	releaseBootstrapHold,
} from "../bootstrapHold.js";

const row = {
	agent_id: "11111111-2222-3333-4444-555555555555",
	session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	owner_user_id: "u1",
	name: "developer",
	runtime: "claude-acp-0.108.0",
	model: "claude-sonnet-5-5",
	created_at: "2026-11-17 00:00:00",
};
vi.mock("../db.js", () => ({ d1Query: vi.fn(async () => ({ results: [row] })) }));

type Probe = { exitCode: number | null } | Error;

function fakeDocker(opts: { running: string | null; probe: Probe | (() => Promise<Probe>) }) {
	const calls = { probes: 0, launches: [] as string[][] };
	return {
		calls,
		docker: {
			runningContainerId: vi.fn(async () => opts.running),
			execCapture: vi.fn(async () => {
				calls.probes++;
				const p = typeof opts.probe === "function" ? await opts.probe() : opts.probe;
				if (p instanceof Error) throw p;
				return {
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
					exitCode: p.exitCode,
					truncated: false,
					timedOut: false,
				};
			}),
			execDetached: vi.fn(async (_id: string, cmd: string[]) => {
				calls.launches.push(cmd);
			}),
		},
	};
}

let AcpAgents: typeof import("./agents.js").AcpAgents;
let acpConfigFromEnv: typeof import("./agents.js").acpConfigFromEnv;
beforeAll(async () => {
	process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
	({ AcpAgents, acpConfigFromEnv } = await import("./agents.js"));
});

async function make(opts: Parameters<typeof fakeDocker>[0]) {
	const f = fakeDocker(opts);
	const acp = new AcpAgents(acpConfigFromEnv("/ws", 3001), f.docker as any);
	await acp.bySession(row.session_id); // the agent is known (as after boot/create)
	return { acp, calls: f.calls };
}

describe("ACP runner watchdog", () => {
	beforeEach(() => vi.clearAllMocks());

	it("a live loop is left alone, however silent the runner is", async () => {
		const { acp, calls } = await make({ running: "c1", probe: { exitCode: 0 } });
		await acp.watchdogTick();
		expect(calls.probes).toBe(1);
		expect(calls.launches).toHaveLength(0);
	});

	it("a loop proven dead is launched again, under the launch lock", async () => {
		const { acp, calls } = await make({ running: "c1", probe: { exitCode: 1 } });
		await acp.watchdogTick();
		expect(calls.launches).toHaveLength(1);
		expect(calls.launches[0].slice(0, 3)).toEqual(["flock", "-n", "/tmp/st-acp-runner.lock"]);
		expect(calls.launches[0].at(-1)).toBe("st-acp-runner-loop");
	});

	it("a runner alive without its loop is not doubled", async () => {
		const { acp, calls } = await make({ running: "c1", probe: { exitCode: 3 } });
		await acp.watchdogTick();
		await acp.watchdogTick();
		expect(calls.launches).toHaveLength(0);
	});

	it("an unanswered probe (error, timeout) launches nothing", async () => {
		for (const probe of [new Error("exec failed"), { exitCode: null }, { exitCode: 126 }]) {
			const { acp, calls } = await make({ running: "c1", probe });
			await acp.watchdogTick();
			expect(calls.launches).toHaveLength(0);
		}
	});

	it("a container that is not running is not probed", async () => {
		const { acp, calls } = await make({ running: null, probe: { exitCode: 1 } });
		await acp.watchdogTick();
		expect(calls.probes).toBe(0);
		expect(calls.launches).toHaveLength(0);
	});

	it("overlapping ticks check an agent once (single-flight)", async () => {
		let release!: () => void;
		const gate = new Promise<void>((ok) => {
			release = ok;
		});
		const { acp, calls } = await make({
			running: "c1",
			probe: async () => {
				await gate;
				return { exitCode: 1 };
			},
		});
		const a = acp.watchdogTick();
		const b = acp.watchdogTick();
		release();
		await Promise.all([a, b]);
		expect(calls.probes).toBe(1);
		expect(calls.launches).toHaveLength(1);
	});
});

// bootstrapHold.ts: the runner of a session whose creation bootstrap is
// still running is not launched by any path; it starts when the bootstrap
// ends. A session without a hold (no bootstrap, a restart) starts at once.
describe("ACP runner and the creation bootstrap", () => {
	beforeEach(() => vi.clearAllMocks());

	it("no path launches the runner while the bootstrap holds the session", async () => {
		const { acp, calls } = await make({ running: "c1", probe: { exitCode: 1 } });
		holdUntilBootstrapped(row.session_id);
		try {
			acp.hooks().onStarted(row.session_id, "c1");
			expect(await acp.ensureRunner(row.session_id, "c1")).toBe(false);
			await acp.watchdogTick();
			await acp.ensureAllRunning();
			expect(calls.probes).toBe(0);
			expect(calls.launches).toHaveLength(0);
		} finally {
			releaseBootstrapHold(row.session_id, false);
		}
	});

	it("the bootstrap's end launches it (through the probe: never a twin)", async () => {
		const { acp, calls } = await make({ running: "c1", probe: { exitCode: 1 } });
		holdUntilBootstrapped(row.session_id);
		const off = onBootstrapReleased((sid) => void acp.onBootstrapped(sid));
		releaseBootstrapHold(row.session_id, true);
		off();
		await vi.waitFor(() => expect(calls.launches).toHaveLength(1));
		expect(calls.probes).toBe(1);
	});

	it("without a hold (no bootstrap, a container restart) onStarted launches at once", async () => {
		const { acp, calls } = await make({ running: "c1", probe: { exitCode: 1 } });
		acp.hooks().onStarted(row.session_id, "c1");
		await vi.waitFor(() => expect(calls.launches).toHaveLength(1));
	});
});
