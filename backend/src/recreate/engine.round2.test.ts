/**
 * Regressions for Work's second review of #459 (at 1ccd18f): E1 (an exec
 * reported `Running: false` without an exit code is not evidence it
 * ended), E2 (a composite write — the real `setPorts` — starts nothing
 * after the epoch closed) and E5 (a convergence already inside the real
 * owner authority writes no hooks file after `engine.stop()`). Each fails
 * against 1ccd18f. `db.js` is stubbed so the real D1 adapter and the real
 * capture authority run inside the engine.
 */

import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	/** Every statement, in the order issued. */
	sql: [] as string[],
	/** Held before the first port-mapping DELETE answers, when set. */
	holdFirstDelete: null as Promise<void> | null,
	/** The capture row the real authority reads (CONVERSATION.md §2.7.5). */
	captureRow: null as (() => Record<string, unknown>) | null,
}));
vi.mock("../db.js", () => ({
	d1Query: vi.fn(async (sql: string) => {
		db.sql.push(sql);
		if (/^DELETE FROM sessions_port_mappings/.test(sql) && db.holdFirstDelete) {
			const hold = db.holdFirstDelete;
			db.holdFirstDelete = null;
			await hold;
		}
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql) && db.captureRow) {
			return { results: [db.captureRow()], success: true, meta: {} };
		}
		return { results: [], success: true, meta: { changes: 0 } };
	}),
	D1StatementError: class extends Error {},
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));

import { hooksFileExists } from "../conversation/activation.js";
import { relayEnabledExists } from "../conversation/captureAuth.js";
import { hashIngestToken } from "../conversation/registry.js";
import type { ConversationService } from "../conversation/service.js";
import { RecreateUnresolvedError } from "../recreateAttempt.js";
import type { LifecycleOp } from "../sessionLifecycleLock.js";
import { conversationRecreatePort } from "./capturePort.js";
import { d1RecreatePort } from "./d1.js";
import { deferred, harness, IMG_N, O_ID, SID } from "./engine.testutil.js";

type H = Awaited<ReturnType<typeof harness>>;
const roots: string[] = [];
async function setup(config?: NonNullable<Parameters<typeof harness>[0]>["config"]): Promise<H> {
	const h = await harness({ config });
	roots.push(h.root);
	return h;
}
afterEach(async () => {
	for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
	db.sql.length = 0;
	db.holdFirstDelete = null;
	db.captureRow = null;
});

const recordOf = async (h: H) => {
	const r = await h.attempts.read(SID);
	return r.kind === "ok" ? r.record : null;
};
const nIdOf = (h: H) => [...h.docker.containers.keys()].find((id) => id !== O_ID) ?? null;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const SEED = "/opt/st/seed-skills.sh";
const INCOMPATIBLE: LifecycleOp[] = ["start", "stop", "delete"];

async function expectIncompatibleRefused(h: H) {
	for (const op of INCOMPATIBLE) {
		const fn = vi.fn(async () => undefined);
		await expect(h.lock.run(SID, op, fn, { mode: "wait" })).rejects.toBeInstanceOf(
			RecreateUnresolvedError,
		);
		expect(fn).not.toHaveBeenCalled();
	}
}

// ── E1: Running:false without an exit code is still unknown ────────────────

describe("E1 — `Running: false` without an exit code does not end a pending exec", () => {
	it("stays uncertain and blocked; an exit code is the evidence that resolves it", async () => {
		const h = await setup();
		h.docker.unknownExit.add(SEED);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
		h.docker.endUnknownExecs(null);
		// Several re-observation periods, every one answered {running:false, exitCode:null}.
		await tick(200);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		expect(h.docker.log.filter((l) => l.startsWith("execState")).length).toBeGreaterThan(1);
		await expectIncompatibleRefused(h);
		h.docker.endUnknownExecs(0);
		await vi.waitFor(
			async () =>
				expect(await recordOf(h)).toMatchObject({
					state: "resolved",
					outcome: { kind: "committed" },
				}),
			{ timeout: 2000 },
		);
	});

	it("stays uncertain and blocked; N confirmed stopped is the evidence that resolves it", async () => {
		const h = await setup();
		h.docker.unknownExit.add(SEED);
		await h.engine.recreate(SID, IMG_N);
		h.docker.endUnknownExecs(null);
		await tick(200);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		await expectIncompatibleRefused(h);
		const n = h.docker.containers.get(nIdOf(h) as string);
		if (!n) throw new Error("no N");
		n.running = false; // stopped outside the attempt: no process outlives it
		await vi.waitFor(
			async () =>
				expect(await recordOf(h)).toMatchObject({
					state: "resolved",
					outcome: { kind: "committed" },
				}),
			{ timeout: 2000 },
		);
		expect(h.d1.row.status).toBe("stopped");
	});
});

// ── E2: the real setPorts issues nothing after the epoch closed ────────────

describe("E2 — the real setPorts: DELETE out at T_rec, late answer ⇒ no new INSERT", () => {
	it("the late continuation stops; only the resolution rewrites the mappings", async () => {
		const h = await setup({ tRecMs: 250, tRbMs: 100 });
		h.d1.config = {
			...h.d1.config,
			ports: [
				{ container: 3000, public: false },
				{ container: 5500, public: true },
			],
		};
		h.d1.setPorts = (sid, ports, mayAct) => d1RecreatePort.setPorts(sid, ports, mayAct);
		const hold = deferred();
		db.holdFirstDelete = hold.promise;
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
		expect((r as { pending: string[] }).pending.join(" ")).toMatch(/d1 ports/);
		const ports = () => db.sql.filter((s) => /sessions_port_mappings/.test(s));
		expect(ports()).toEqual([expect.stringMatching(/^DELETE/)]);
		await expectIncompatibleRefused(h);
		// The DELETE answers after the epoch closed.
		hold.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		// Nothing between the late DELETE and the resolution's own rewrite.
		const seq = ports().map((s) => s.split(" ")[0]);
		expect(seq).toEqual(["DELETE", "DELETE", "INSERT", "INSERT"]);
	});
});

// ── E5: shutdown reaches into the real convergence ─────────────────────────

describe("E5 — engine.stop() while the real convergence waits for its probe", () => {
	it("the late positive probe writes no hooks file; the record stays unresolved", async () => {
		const h = await setup();
		h.d1.casMode = "ambiguous-applied";
		const token = "t".repeat(64);
		db.captureRow = () => ({
			status: h.d1.row.status,
			conversation_requested: 1,
			ingest_token_hash: hashIngestToken(token),
			ingest_token_hash_suspended: null,
			user_id: "u1",
			container_id: h.d1.row.container_id,
		});
		const probe = deferred<boolean>();
		const probing = deferred();
		const service = {
			activationDeps: { workspaceRoot: h.root, enabled: true, port: 3001 },
			captureDocker: {
				inspectCapture: async () => ({
					exists: true,
					running: true,
					token,
					managedMount: true,
					controlMount: true,
					imageId: IMG_N,
					imageRelay2: true,
				}),
				currentImage: async () => ({ imageId: IMG_N, relay2: true }),
				probeRelay: () => {
					probing.resolve();
					return probe.promise;
				},
			},
		} as unknown as ConversationService;
		const real = conversationRecreatePort(service);
		h.capture.converge = (sid, mayAct) => real.converge(sid, mayAct);

		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false, step: "commit", unresolved: true });
		// The resolution's convergence is inside the authority, its marker
		// written, waiting for the relay to identify itself.
		await probing.promise;
		expect(await relayEnabledExists(h.root, SID)).toBe(true);
		h.engine.stop();
		probe.resolve(true);
		await tick(100);
		expect(await hooksFileExists(h.root, SID)).toBe(false);
		// And what it wrote before the stop is withdrawn.
		expect(await relayEnabledExists(h.root, SID)).toBe(false);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
	});
});

// ── Review bot on 4aa7640: the seed follows the marker's removal ───────────

describe("step 6 seeds only once `defer-skill-seed` is gone", () => {
	it("a failed removal skips the seed; the resolution removes it and seeds exactly once", async () => {
		const h = await setup();
		const real = h.capture.removeDeferSeed.bind(h.capture);
		let first = true;
		h.capture.removeDeferSeed = async () => {
			if (first) {
				first = false;
				throw new Error("EIO");
			}
			return real();
		};
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(h.capture.deferSeed).toBe(false);
		expect(h.docker.execs.filter((e) => e[1] === SEED)).toHaveLength(1);
	});
});
