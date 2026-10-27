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
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	/** Every statement, in the order issued. */
	sql: [] as string[],
	/** Held before the first port-mapping DELETE answers, when set. */
	holdFirstDelete: null as Promise<void> | null,
	/** The capture row the real authority reads (CONVERSATION.md §2.7.5). */
	captureRow: null as (() => Record<string, unknown>) | null,
	/** `conversation_requested` as the disable statements leave it. */
	requested: 1,
}));
vi.mock("../db.js", () => ({
	d1Query: vi.fn(async (sql: string) => {
		db.sql.push(sql);
		if (/^DELETE FROM sessions_port_mappings/.test(sql) && db.holdFirstDelete) {
			const hold = db.holdFirstDelete;
			db.holdFirstDelete = null;
			await hold;
		}
		// The disable / emergency statements (registry.ts): requested goes to 0.
		if (/^UPDATE sessions SET .*conversation_requested = 0/.test(sql)) db.requested = 0;
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql) && db.captureRow) {
			return { results: [db.captureRow()], success: true, meta: {} };
		}
		return { results: [], success: true, meta: { changes: 0 } };
	}),
	D1StatementError: class extends Error {},
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));

import * as activation from "../conversation/activation.js";
import { disableSession, hooksFileExists } from "../conversation/activation.js";
import { relayEnabledExists } from "../conversation/captureAuth.js";
import { hashIngestToken } from "../conversation/registry.js";
import { checkRevocation } from "../conversation/revocation.js";
import type { ConversationService } from "../conversation/service.js";
import { RecreateAttemptStore, RecreateUnresolvedError } from "../recreateAttempt.js";
import { type LifecycleOp, SessionLifecycleLock } from "../sessionLifecycleLock.js";
import { conversationRecreatePort } from "./capturePort.js";
import { d1RecreatePort } from "./d1.js";
import { deferred, harness, IMG_N, O_ID, SID } from "./engine.testutil.js";

type H = Awaited<ReturnType<typeof harness>>;
const made: H[] = [];
async function setup(config?: NonNullable<Parameters<typeof harness>[0]>["config"]): Promise<H> {
	const h = await harness({ config });
	made.push(h);
	return h;
}
afterEach(async () => {
	for (const h of made.splice(0)) {
		// A resolution still retrying would keep writing under the root.
		h.engine.stop();
		await fs.rm(h.root, { recursive: true, force: true, maxRetries: 3 });
	}
	db.sql.length = 0;
	db.holdFirstDelete = null;
	db.captureRow = null;
	db.requested = 1;
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
		h.capture.converged = (sid) => real.converged(sid);

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

// ── Work's third review (21eaff4): no durable `resolved` after stop() ──────

describe("E5 — engine.stop() while the resolution waits for its last evidence", () => {
	it("a late numeric exit after stop() writes no `resolved`; a new store's boot recovery keeps it blocked", async () => {
		const h = await setup();
		h.docker.unknownExit.add(SEED);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
		// The next pass's exec-state read is held: that is its last evidence.
		const answer = deferred();
		const asked = deferred();
		h.docker.hooks.set("execState", async () => {
			asked.resolve();
			await answer.promise;
		});
		await asked.promise;
		h.engine.stop();
		h.docker.endUnknownExecs(0); // the held read answers {running:false, exitCode:0}
		answer.resolve();
		await tick(150);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });

		// The next process: boot recovery on a fresh store inherits the block (D8).
		const attempts = new RecreateAttemptStore(h.root);
		await attempts.recoverOnBoot();
		const rec = await attempts.read(SID);
		expect(rec).toMatchObject({ kind: "ok", record: { state: "uncertain" } });
		expect((rec as { record: { orphanedAt?: string } }).record.orphanedAt).toBeTruthy();
		const lock = new SessionLifecycleLock();
		lock.setGuard((sid) => attempts.assertResolved(sid));
		for (const op of INCOMPATIBLE) {
			await expect(lock.run(SID, op, async () => 1)).rejects.toBeInstanceOf(
				RecreateUnresolvedError,
			);
		}
	});
});

// ── Work's fourth review (7ca3871): E6, an incomplete authorization ────────

/**
 * The real capture port in the engine: step 5's write procedure, the
 * resolution's convergence and the convergence check all act on the real
 * files under `h.root`, against a running N whose token matches D1.
 */
function realCapture(h: H) {
	const token = "t".repeat(64);
	db.captureRow = () => ({
		status: h.d1.row.status,
		conversation_requested: db.requested,
		ingest_token_hash: db.requested ? hashIngestToken(token) : null,
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: h.d1.row.container_id,
	});
	const ctl = { probe: async (): Promise<boolean> => true };
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
			probeRelay: () => ctl.probe(),
		},
	} as unknown as ConversationService;
	const real = conversationRecreatePort(service);
	h.capture.authorize = (sid, run) => real.authorize(sid, run);
	h.capture.converge = (sid, mayAct) => real.converge(sid, mayAct);
	h.capture.converged = (sid) => real.converged(sid);
	const files = async () => ({
		marker: await relayEnabledExists(h.root, SID),
		hooksFile: await hooksFileExists(h.root, SID),
	});
	return { ctl, files };
}

const seeds = (h: H) => h.docker.execs.filter((e) => e[1] === SEED).length;

describe("E6 — an authorization that did not complete is pending, never `resolved`", () => {
	it("hooks file write fails ⇒ uncertain with `authorize` pending; the next pass repairs it and only then resolves", async () => {
		const h = await setup();
		const { files } = realCapture(h);
		let failing = true;
		const write = activation.writeHooksFile;
		const spy = vi.spyOn(activation, "writeHooksFile").mockImplementation(async (deps, sid) => {
			if (failing) throw new Error("ENOSPC");
			return write(deps, sid);
		});
		try {
			const r = await h.engine.recreate(SID, IMG_N);
			expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
			expect((r as { pending: string[] }).pending).toContain("authorize (not done)");
			expect(await files()).toEqual({ marker: false, hooksFile: false });
			await tick(150); // several passes, every one failing the same write
			expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
			await expectIncompatibleRefused(h);
			failing = false;
			await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
				timeout: 2000,
			});
			expect(await files()).toEqual({ marker: true, hooksFile: true });
			expect(seeds(h)).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("hooks write fails AND the marker cannot be removed ⇒ the half pair keeps it uncertain until it is repaired", async () => {
		const h = await setup();
		const { files } = realCapture(h);
		const ctlDir = path.join(h.root, ".st-control", SID);
		let failing = true;
		const write = activation.writeHooksFile;
		const spy = vi.spyOn(activation, "writeHooksFile").mockImplementation(async (deps, sid) => {
			if (failing) {
				await fs.chmod(ctlDir, 0o555); // relay.enabled can no longer be removed
				throw new Error("ENOSPC");
			}
			return write(deps, sid);
		});
		try {
			const r = await h.engine.recreate(SID, IMG_N);
			expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
			expect((r as { pending: string[] }).pending).toContain("authorize (not done)");
			expect(await files()).toEqual({ marker: true, hooksFile: false });
			await tick(150);
			expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
			await expectIncompatibleRefused(h);
			// The disk recovers.
			failing = false;
			await fs.chmod(ctlDir, 0o755);
			await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
				timeout: 2000,
			});
			expect(await files()).toEqual({ marker: true, hooksFile: true });
			expect(seeds(h)).toBe(1);
		} finally {
			spy.mockRestore();
			await fs.chmod(ctlDir, 0o755).catch(() => undefined);
		}
	});

	it("relay unavailable ⇒ still authorized but not configured: uncertain until it identifies itself, no availability promised", async () => {
		const h = await setup();
		const { ctl, files } = realCapture(h);
		let identified = false;
		ctl.probe = async () => identified;
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
		// Identification may use up what is left of T_rec, so step 5 may end
		// on the epoch rather than with a capture block: pending either way.
		expect((r as { pending: string[] }).pending).toContain("authorize (not done)");
		expect(await files()).toEqual({ marker: false, hooksFile: false });
		await tick(150);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		await expectIncompatibleRefused(h);
		identified = true;
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 15_000,
		});
		expect(await files()).toEqual({ marker: true, hooksFile: true });
		expect(seeds(h)).toBe(1);
	}, 30_000);

	for (const by of ["api", "cli"] as const) {
		it(`${by} disable during the repair ⇒ both files withdrawn and seen gone, then resolved (revoked)`, async () => {
			const h = await setup();
			const { ctl, files } = realCapture(h);
			// Step 5 finds no relay; the resolution's repair then waits on its probe.
			let phase: "forward" | "repair" = "forward";
			const asked = deferred();
			const answer = deferred<boolean>();
			ctl.probe = async () => {
				if (phase === "forward") return false;
				asked.resolve();
				return answer.promise;
			};
			const r = await h.engine.recreate(SID, IMG_N);
			phase = "repair";
			expect(r).toMatchObject({ ok: true, unresolved: true });
			await asked.promise;
			expect((await files()).marker).toBe(true); // the repair's marker is down
			await disableSession({ workspaceRoot: h.root, enabled: true, port: 3001 }, SID, by);
			answer.resolve(true); // a positive that arrives after the disable
			await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
				timeout: 2000,
			});
			expect(await files()).toEqual({ marker: false, hooksFile: false });
			expect(await checkRevocation(h.root, SID)).toBe("session");
			expect(db.requested).toBe(0);
			expect(seeds(h)).toBe(1);
		});
	}
});
