/**
 * recreate/capturePort.ts — step 1's capture prep and step 5's write
 * procedure on N, bound to the attempt's epoch (CONVERSATION.md §2.7.2,
 * §2.7.4 "a late positive probe writes no conversation.json").
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	sessions: new Map<string, Record<string, unknown>>(),
	writes: [] as string[],
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql)) {
			const row = dbStubs.sessions.get(String(params[0]));
			return { results: row ? [{ ...row }] : [], success: true, meta: {} };
		}
		dbStubs.writes.push(sql);
		// The disable statements (registry.ts): requested goes to 0.
		if (/^UPDATE sessions SET .*conversation_requested = 0 WHERE session_id/.test(sql)) {
			const row = dbStubs.sessions.get(String(params[0]));
			if (row) {
				row.conversation_requested = 0;
				row.ingest_token_hash = null;
			}
		}
		return { results: [], success: true, meta: { changes: 0 } };
	}),
	D1StatementError: class extends Error {},
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import {
	disableSession,
	hooksFileExists,
	hooksFilePath,
	writeHooksFile,
} from "../conversation/activation.js";
import {
	type ContainerView,
	deferSeedExists,
	relayEnabledExists,
	writeRelayEnabled,
} from "../conversation/captureAuth.js";
import { hashIngestToken } from "../conversation/registry.js";
import { checkRevocation, writeSessionRevocation } from "../conversation/revocation.js";
import type { ConversationService } from "../conversation/service.js";
import { conversationRecreatePort } from "./capturePort.js";
import { AttemptRun, EpochClosedError } from "./run.js";

const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const N = "n".repeat(64);
let root: string;
let token: string;

function port(probe: () => Promise<boolean>, opts: { running?: boolean } = {}) {
	const converge = vi.fn(async () => "kept");
	const view = (): ContainerView => ({
		exists: true,
		running: opts.running ?? true,
		token,
		managedMount: true,
		controlMount: true,
		imageId: "sha256:n",
		imageRelay2: true,
	});
	const probeRelay = vi.fn(probe);
	const service = {
		activationDeps: { workspaceRoot: root, enabled: true, port: 3001 },
		captureDocker: {
			inspectCapture: async () => view(),
			currentImage: async () => ({ imageId: "sha256:n", relay2: true }),
			probeRelay,
		},
		authority: { converge },
	} as unknown as ConversationService;
	return { p: conversationRecreatePort(service), probeRelay, converge };
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-rcap-"));
	dbStubs.sessions.clear();
	dbStubs.writes.length = 0;
	token = "t".repeat(64);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** D1 after the commit: N with H. */
function committedRow() {
	dbStubs.sessions.set(SID, {
		status: "stopped",
		conversation_requested: 1,
		ingest_token_hash: hashIngestToken(token),
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: N,
	});
}

describe("prepare (step 1)", () => {
	it("defer-skill-seed written, leftover marker and hooks file removed, N's token and H, nothing to D1", async () => {
		const { p } = port(async () => true);
		await writeRelayEnabled(root, SID);
		await writeHooksFile({ workspaceRoot: root, enabled: true, port: 3001 }, SID);
		const prep = await p.prepare(SID, () => true);
		expect(await deferSeedExists(root, SID)).toBe(true);
		expect(await relayEnabledExists(root, SID)).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
		const t = prep.env.find((e) => e.startsWith("ST_INGEST_TOKEN="))?.split("=")[1] as string;
		expect(prep.hash).toBe(hashIngestToken(t));
		expect(prep.binds).toEqual([
			expect.stringMatching(/:\/etc\/claude-code\/managed-settings\.d:ro$/),
			expect.stringMatching(/:\/etc\/st-control:ro$/),
		]);
		expect(dbStubs.writes).toEqual([]);
	});

	it("stops between effects once mayAct says no: a late continuation writes nothing more (#459 E2)", async () => {
		const { p } = port(async () => true);
		await writeHooksFile({ workspaceRoot: root, enabled: true, port: 3001 }, SID);
		let calls = 0;
		// Open for the two directory creations, closed from then on.
		await expect(p.prepare(SID, () => ++calls <= 2)).rejects.toThrow(/stopped/);
		expect(await deferSeedExists(root, SID)).toBe(false);
		// Nothing past the stop: not even the leftover removal.
		expect(await hooksFileExists(root, SID)).toBe(true);
	});
});

describe("authorize (step 5) inside the attempt's epoch", () => {
	it("open epoch: marker → identified → hooks file, effective:true, every Docker read an attempt request", async () => {
		committedRow();
		const { p } = port(async () => true);
		const run = new AttemptRun(Date.now() + 10_000);
		const c = await p.authorize(SID, run);
		expect(c).toMatchObject({ effective: true, pendingReasons: [] });
		expect(await relayEnabledExists(root, SID)).toBe(true);
		expect(await hooksFileExists(root, SID)).toBe(true);
		expect(run.evidence.map((e) => e.label)).toEqual(
			expect.arrayContaining(["inspect N (capture)", "probe N relay"]),
		);
	});

	it("the gate is not consulted: the attempt itself is the actor (no circular block)", async () => {
		committedRow();
		const { p } = port(async () => true);
		expect(await p.authorize(SID, new AttemptRun(Date.now() + 10_000))).toMatchObject({
			effective: true,
		});
	});

	it("closed epoch: nothing written, and the refusal reaches the engine (E6)", async () => {
		committedRow();
		const { p } = port(async () => true);
		const run = new AttemptRun(Date.now() + 10_000);
		run.close("T_rec");
		await expect(p.authorize(SID, run)).rejects.toBeInstanceOf(EpochClosedError);
		expect(await relayEnabledExists(root, SID)).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
	});

	it("a positive probe after T_rec: no conversation.json, and the marker is retired", async () => {
		committedRow();
		let release!: () => void;
		const late = new Promise<boolean>((r) => {
			release = () => r(true);
		});
		const { p } = port(() => late);
		const run = new AttemptRun(Date.now() + 120);
		const pending = p.authorize(SID, run);
		await new Promise((r) => setTimeout(r, 200));
		release();
		const c = await pending;
		await run.settled();
		expect(c?.effective).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
		expect(await relayEnabledExists(root, SID)).toBe(false);
	});
});

const O = "o".repeat(64);

/** D1 before the commit / after a rollback: O, stopped, with O's token hash. */
function rowOnO() {
	dbStubs.sessions.set(SID, {
		status: "stopped",
		conversation_requested: 1,
		ingest_token_hash: hashIngestToken(token),
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: O,
	});
}

const PAIR = { marker: true, hooksFile: true };

describe("restore (rollback of an O created by 3.0d; owner decision, point 2)", () => {
	it("puts back the pair while RETAIN authorization holds for O", async () => {
		rowOnO();
		const { p } = port(async () => true, { running: false });
		await p.restore(SID, PAIR, O, () => true);
		expect(await relayEnabledExists(root, SID)).toBe(true);
		expect(await fs.readFile(hooksFilePath(root, SID), "utf8")).toContain("hooks");
	});

	it("nothing without authorization: revoked, not requested, D1 not on O, O running, half a pair", async () => {
		const { p } = port(async () => true, { running: false });
		const cases: Array<[string, () => Promise<void>, typeof PAIR]> = [
			["revoked", () => writeSessionRevocation(root, SID, { at: "t", by: "cli" }), PAIR],
			[
				"not requested",
				async () => {
					(dbStubs.sessions.get(SID) as Record<string, unknown>).conversation_requested = 0;
				},
				PAIR,
			],
			[
				"D1 on another container",
				async () => {
					(dbStubs.sessions.get(SID) as Record<string, unknown>).container_id = N;
				},
				PAIR,
			],
			["half a pair", async () => undefined, { marker: true, hooksFile: false }],
		];
		for (const [label, setup, snap] of cases) {
			await fs.rm(path.join(root, ".conversations"), { recursive: true, force: true });
			await fs.rm(path.join(root, ".st-control"), { recursive: true, force: true });
			rowOnO();
			await setup();
			await p.restore(SID, snap, O, () => true);
			expect([label, await relayEnabledExists(root, SID)]).toEqual([label, false]);
			expect([label, await hooksFileExists(root, SID)]).toEqual([label, false]);
		}
		rowOnO();
		const running = port(async () => true, { running: true });
		expect(await running.p.restore(SID, PAIR, O, () => true)).toBe("not-authorized");
		expect(await relayEnabledExists(root, SID)).toBe(false);
	});

	/**
	 * E4: the disable runs to completion in the middle of one of the two
	 * writes — after restore decided to write, before (or right after) its
	 * file lands. Whatever the interleaving, the final state is revoked:
	 * revocation marker present, no marker, no hooks file.
	 */
	describe("a disable during the writes always wins (E4)", () => {
		const deps = () => ({ workspaceRoot: root, enabled: true, port: 3001 });
		for (const by of ["api", "cli"] as const) {
			for (const during of ["relay.enabled", "conversation.json"] as const) {
				for (const when of ["before the write lands", "right after it lands"] as const) {
					it(`${by} disable ${when}: ${during}`, async () => {
						rowOnO();
						const { p } = port(async () => true, { running: false });
						const rename = fs.rename.bind(fs);
						let fired = false;
						const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
							const hit = !fired && String(to).endsWith(`/${during}`);
							if (hit && when === "before the write lands") {
								fired = true;
								await disableSession(deps(), SID, by);
							}
							await rename(from, to);
							if (hit && when === "right after it lands") {
								fired = true;
								await disableSession(deps(), SID, by);
							}
						});
						try {
							await p.restore(SID, PAIR, O, () => true);
						} finally {
							spy.mockRestore();
						}
						expect(fired).toBe(true);
						expect(await checkRevocation(root, SID)).toBe("session");
						expect(await relayEnabledExists(root, SID)).toBe(false);
						expect(await hooksFileExists(root, SID)).toBe(false);
						expect(dbStubs.sessions.get(SID)?.conversation_requested).toBe(0);
					});
				}
			}
		}
	});
});

/**
 * E5 (#459, second review): the resolution's restore and convergence act
 * through the owner authority with the pass's `mayAct` (its lease, the
 * engine not shut down). Once it says no, nothing more is written, and
 * what was written is withdrawn.
 */
describe("the owner authority stops when the pass may no longer act (E5)", () => {
	it("restore: lease already gone ⇒ nothing written", async () => {
		rowOnO();
		const { p } = port(async () => true, { running: false });
		expect(await p.restore(SID, PAIR, O, () => false)).toBe("not-authorized");
		expect(await relayEnabledExists(root, SID)).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
	});

	it("restore: lease lost while the marker is written ⇒ no hooks file, marker withdrawn", async () => {
		rowOnO();
		const { p } = port(async () => true, { running: false });
		let allowed = true;
		const rename = fs.rename.bind(fs);
		const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			if (String(to).endsWith("/relay.enabled")) allowed = false;
		});
		try {
			expect(await p.restore(SID, PAIR, O, () => allowed)).toBe("revoked-meanwhile");
		} finally {
			spy.mockRestore();
		}
		expect(await relayEnabledExists(root, SID)).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
	});

	it("converge: stopped while the probe is out ⇒ the late positive writes no hooks file", async () => {
		committedRow();
		const answer = deferred<boolean>();
		const asked = deferred();
		const { p } = port(() => {
			asked.resolve();
			return answer.promise;
		});
		let allowed = true;
		const c = p.converge(SID, () => allowed);
		await asked.promise;
		expect(await relayEnabledExists(root, SID)).toBe(true);
		allowed = false;
		answer.resolve(true);
		await c;
		expect(await hooksFileExists(root, SID)).toBe(false);
		expect(await relayEnabledExists(root, SID)).toBe(false);
	});
});

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
