/**
 * dockerManager.capturePort.test.ts — DockerManager's side of 3.0d capture
 * authorization (CONVERSATION.md §2.7.5–§2.7.6): what `inspectCapture`
 * reads from a container (its token, both mounts, its own image's relay
 * label), the current session image by ID, and the relay identification
 * probe — true only for a 204 carrying `X-ST-Relay: 1`.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [] as unknown[], meta: { changes: 0 } })),
}));
vi.mock("./db.js", () => dbStubs);

import {
	CaptureAuthority,
	relayEnabledExists,
	writeRelayEnabled,
} from "./conversation/captureAuth.js";
import { DockerManager } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

function dm(opts: {
	container?: Record<string, unknown> | Error;
	images?: Record<string, Record<string, string> | Error>;
}) {
	const m = new DockerManager({} as SessionManager);
	const imageInspect = vi.fn(async (id: string) => {
		const labels = opts.images?.[id];
		if (labels instanceof Error) throw labels;
		if (!labels) throw Object.assign(new Error("no such image"), { statusCode: 404 });
		return { Id: id.startsWith("sha256:") ? id : `sha256:${id}`, Config: { Labels: labels } };
	});
	(m as unknown as { docker: unknown }).docker = {
		getContainer: () => ({
			inspect: async () => {
				if (opts.container instanceof Error) throw opts.container;
				return opts.container;
			},
		}),
		getImage: (id: string) => ({ inspect: () => imageInspect(id) }),
	};
	return { m, imageInspect };
}

const TOKEN = "d".repeat(64);
const base = {
	State: { Running: true },
	Image: "sha256:aaa",
	Config: { Env: ["PATH=/usr/bin", `ST_INGEST_TOKEN=${TOKEN}`, "SESSION_ID=x"] },
	Mounts: [
		{ Destination: "/home/developer/workspace" },
		{ Destination: "/etc/claude-code/managed-settings.d" },
		{ Destination: "/etc/st-control" },
	],
};

describe("inspectCapture", () => {
	it("reads running, the env token, both mounts and the container's own image label", async () => {
		const { m } = dm({
			container: base,
			images: { "sha256:aaa": { "io.shared-terminal.conversation-relay": "2" } },
		});
		expect(await m.inspectCapture("cid")).toEqual({
			exists: true,
			running: true,
			token: TOKEN,
			managedMount: true,
			controlMount: true,
			imageId: "sha256:aaa",
			imageRelay2: true,
		});
	});
	it("3.0c-style container: no control mount; an image without the label; no token", async () => {
		const { m } = dm({
			container: {
				...base,
				Config: { Env: ["PATH=/usr/bin"] },
				Mounts: [{ Destination: "/etc/claude-code/managed-settings.d" }],
			},
			images: { "sha256:aaa": {} },
		});
		expect(await m.inspectCapture("cid")).toMatchObject({
			token: null,
			managedMount: true,
			controlMount: false,
			imageRelay2: false,
		});
	});
	it('label value other than "2" does not count', async () => {
		const { m } = dm({
			container: base,
			images: { "sha256:aaa": { "io.shared-terminal.conversation-relay": "1" } },
		});
		expect((await m.inspectCapture("cid")) as { imageRelay2: boolean }).toMatchObject({
			imageRelay2: false,
		});
	});
	it("404 ⇒ {exists:false}; any other daemon error propagates (fail-closed)", async () => {
		expect(
			await dm({
				container: Object.assign(new Error("gone"), { statusCode: 404 }),
			}).m.inspectCapture("cid"),
		).toEqual({
			exists: false,
		});
		await expect(
			dm({ container: new Error("ECONNREFUSED") }).m.inspectCapture("cid"),
		).rejects.toThrow("ECONNREFUSED");
	});
	it("labels are cached per immutable image ID", async () => {
		const { m, imageInspect } = dm({
			container: base,
			images: { "sha256:aaa": { "io.shared-terminal.conversation-relay": "2" } },
		});
		await m.inspectCapture("cid");
		await m.inspectCapture("cid");
		expect(imageInspect).toHaveBeenCalledTimes(1);
	});
});

describe("currentSessionImage", () => {
	it("resolves the tag to its ID and reports the label on that ID; missing image ⇒ null", async () => {
		const { m } = dm({
			images: {
				"shared-terminal-session": { "io.shared-terminal.conversation-relay": "2" },
				"sha256:shared-terminal-session": { "io.shared-terminal.conversation-relay": "2" },
			},
		});
		expect(await m.currentSessionImage()).toEqual({
			imageId: "sha256:shared-terminal-session",
			relay2: true,
		});
		expect(await dm({ images: {} }).m.currentSessionImage()).toBeNull();
	});
});

describe("probeRelay", () => {
	function withExec(result: { stdout: string; exitCode: number | null }) {
		const { m } = dm({});
		const exec = vi.spyOn(m, "execCapture").mockResolvedValue({
			stdout: Buffer.from(result.stdout, "latin1"),
			stderr: Buffer.alloc(0),
			exitCode: result.exitCode,
			truncated: false,
			timedOut: false,
		} as never);
		return { m, exec };
	}
	it("204 + X-ST-Relay: 1 ⇒ true; the exec is bounded and targets the loopback status URL", async () => {
		const { m, exec } = withExec({
			stdout:
				"HTTP/1.1 204 No Content\r\nX-ST-Relay: 1\r\nX-ST-Relay-Generation: 0\r\nConnection: close\r\n\r\n",
			exitCode: 0,
		});
		expect(await m.probeRelay("s1", "cid")).toBe(true);
		const [sid, argv, opts] = exec.mock.calls[0];
		expect(sid).toBe("s1");
		expect(argv).toContain("http://127.0.0.1:47613/st-relay/status");
		expect(argv).toEqual(expect.arrayContaining(["-m", "2", "--noproxy", "*"]));
		expect(opts).toMatchObject({ containerId: "cid", timeoutMs: 2500 });
	});
	for (const [label, stdout, exitCode] of [
		["another process on the port (no X-ST-Relay)", "HTTP/1.1 204 No Content\r\n\r\n", 0],
		["a 404", "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n", 0],
		["X-ST-Relay with another value", "HTTP/1.1 204 No Content\r\nX-ST-Relay: 0\r\n\r\n", 0],
		["curl failed (connection refused / timeout)", "", 7],
		["unknown exit", "HTTP/1.1 204 No Content\r\nX-ST-Relay: 1\r\n\r\n", null],
	] as const) {
		it(`${label} ⇒ false`, async () => {
			expect(await withExec({ stdout, exitCode }).m.probeRelay("s1", "cid")).toBe(false);
		});
	}
});

// ── V2: the authority bounds every stage of the real probe ─────────────────

describe("probeRelay through CaptureAuthority: every Docker stage bounded (V2)", () => {
	const OK = "HTTP/1.1 204 No Content\r\nX-ST-Relay: 1\r\n\r\n";
	const frame = (s: string) => {
		const body = Buffer.from(s, "latin1");
		const head = Buffer.alloc(8);
		head[0] = 1;
		head.writeUInt32BE(body.length, 4);
		return Buffer.concat([head, body]);
	};
	type Stage = "create" | "start" | "stream" | "inspect";
	/** A Docker whose exec hangs at `stage` until `release()`; then answers 204 + X-ST-Relay: 1. */
	function hangingDocker(stage: Stage) {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const at = async (s: Stage) => {
			if (s === stage) await gate;
		};
		const execCreate = vi.fn(async () => {
			await at("create");
			return {
				start: async () => {
					await at("start");
					const stream = new PassThrough();
					void at("stream").then(() => {
						stream.write(frame(OK));
						stream.end();
					});
					return stream;
				},
				inspect: async () => {
					await at("inspect");
					return { ExitCode: 0 };
				},
			};
		});
		const { m } = dm({});
		(m as unknown as { docker: unknown }).docker = {
			getContainer: () => ({ exec: execCreate }),
		};
		return { m, release, execCreate };
	}

	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "st-v2-"));
		await writeRelayEnabled(root, "s1");
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function authority(m: DockerManager) {
		const writeHooks = vi.fn(async () => undefined);
		const a = new CaptureAuthority({
			workspaceRoot: root,
			enabled: true,
			docker: {
				inspectCapture: async () => ({
					exists: true,
					running: true,
					token: TOKEN,
					managedMount: true,
					controlMount: true,
					imageId: "sha256:aaa",
					imageRelay2: true,
				}),
				currentImage: async () => ({ imageId: "sha256:aaa", relay2: true }),
				probeRelay: (sid, cid) => m.probeRelay(sid, cid),
			},
			getRow: async () => ({
				status: "running",
				conversation_requested: 1,
				ingest_token_hash: createHash("sha256").update(TOKEN).digest("hex"),
				ingest_token_hash_suspended: null,
				user_id: "u1",
				container_id: "cid",
			}),
			checkRevocation: async () => "none",
			isRecreateUnresolved: async () => false,
			writeHooksFile: writeHooks,
			removeHooksFile: async () => undefined,
			hooksFileExists: async () => true,
			probeBudgetMs: 100,
			identifyWaitMs: 300,
		});
		return { a, writeHooks };
	}

	for (const stage of ["create", "start", "stream", "inspect"] as const) {
		it(`exec ${stage} hangs: capture() answers effective:false within the budget, repeated queries don't start another exec, a late positive writes nothing`, async () => {
			const { m, release, execCreate } = hangingDocker(stage);
			const { a, writeHooks } = authority(m);
			const t0 = Date.now();
			const c = await a.capture("s1");
			expect(Date.now() - t0).toBeLessThan(1000);
			expect(c.effective).toBe(false);
			expect(c.pendingReasons).toContain("relay-unavailable");
			// Still hung: neither a new query nor a whole write procedure
			// (several polls inside 300 ms) multiplies the exec.
			expect((await a.capture("s1")).effective).toBe(false);
			const t1 = Date.now();
			expect(await a.applyWrite("s1")).toBe("relay-unavailable");
			expect(Date.now() - t1).toBeLessThan(1000);
			expect(execCreate).toHaveBeenCalledTimes(1);
			expect(writeHooks).not.toHaveBeenCalled();
			// relay-unavailable withdraws: no marker is left for a relay to start on.
			expect(await relayEnabledExists(root, "s1")).toBe(false);
			// The positive arrives late: nothing is written retroactively,
			// and the next query is a fresh exec that identifies.
			release();
			await new Promise((r) => setTimeout(r, 20));
			expect(writeHooks).not.toHaveBeenCalled();
			await writeRelayEnabled(root, "s1"); // configured again for the fresh query
			expect((await a.capture("s1")).effective).toBe(true);
			expect(execCreate).toHaveBeenCalledTimes(2);
		});
	}
});
