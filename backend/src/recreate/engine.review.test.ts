/**
 * Regressions for Work's review of #459 at f514ddc (E1–E3, plus the D8
 * criterion after the CAS). Each one fails against f514ddc: there an exec
 * with an unknown exit counted as finished (E1), post-CAS work was not
 * bounded by T_rec (E2), and the resolution persisted `resolved` and let
 * other verbs in before converging, outside the session lock (E3).
 * E4 (disable during the rollback's restore) is in capturePort.test.ts.
 */

import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecreateAttemptStore, RecreateUnresolvedError } from "../recreateAttempt.js";
import { type LifecycleOp, SessionLifecycleLock } from "../sessionLifecycleLock.js";
import { RecreationEngine } from "./engine.js";
import { deferred, FAST, harness, IMG_N, O_ID, SID } from "./engine.testutil.js";

type H = Awaited<ReturnType<typeof harness>>;
const roots: string[] = [];
async function setup(config?: NonNullable<Parameters<typeof harness>[0]>["config"]): Promise<H> {
	const h = await harness({ config });
	roots.push(h.root);
	return h;
}
afterEach(async () => {
	for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

const recordOf = async (h: H) => {
	const r = await h.attempts.read(SID);
	return r.kind === "ok" ? r.record : null;
};
const nIdOf = (h: H) => [...h.docker.containers.keys()].find((id) => id !== O_ID) ?? null;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const SEED = "/opt/st/seed-skills.sh";
const INCOMPATIBLE: LifecycleOp[] = ["start", "stop", "delete"];

/** `recreate` answering at all: a hang shows as "hung" instead of a test timeout. */
async function recreateBounded(h: H, ms = 2000) {
	return Promise.race([h.engine.recreate(SID, IMG_N), tick(ms).then(() => "hung" as const)]);
}

async function expectIncompatibleRefused(h: H) {
	for (const op of INCOMPATIBLE) {
		const fn = vi.fn(async () => undefined);
		await expect(h.lock.run(SID, op, fn, { mode: "wait" })).rejects.toBeInstanceOf(
			RecreateUnresolvedError,
		);
		expect(fn).not.toHaveBeenCalled();
	}
}

// ── E1: unknown exec termination is not termination ────────────────────────

describe("E1 — an exec whose exit is unknown keeps the attempt uncertain", () => {
	it("seed after the commit with exit unknown ⇒ committed but unresolved, verbs refused; resolved only once the exec is seen ended", async () => {
		const h = await setup();
		h.docker.unknownExit.add(SEED);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
		expect((r as { pending: string[] }).pending).toEqual(
			expect.arrayContaining(["seed N (exit unknown)"]),
		);
		// Several re-observation periods: no evidence, no resolution.
		await tick(200);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		await expectIncompatibleRefused(h);
		// dockerd now reports the seed ended: that is the evidence.
		h.docker.endUnknownExecs(0);
		await vi.waitFor(
			async () =>
				expect(await recordOf(h)).toMatchObject({
					state: "resolved",
					outcome: { kind: "committed" },
				}),
			{ timeout: 2000 },
		);
		// The seed was never re-issued on top of the one still running.
		expect(h.docker.execs.filter((e) => e[1] === SEED)).toHaveLength(1);
	});

	it("late answer: the seed answers after T_rec, with its exit unknown ⇒ still uncertain, verbs refused", async () => {
		const h = await setup({ tRecMs: 250, tRbMs: 100 });
		const gate = deferred();
		h.docker.hooks.set("exec", async (a) => {
			if (String(a[1]).includes("seed-skills")) await gate.promise;
		});
		h.docker.unknownExit.add(SEED);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: true, unresolved: true });
		gate.resolve();
		await tick(200);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		await expectIncompatibleRefused(h);
		h.docker.endUnknownExecs(0);
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
	});

	it("the resolution's own seed with exit unknown (CAS applied late) ⇒ not resolved until it is seen ended", async () => {
		const h = await setup();
		h.d1.casMode = "ambiguous-applied";
		h.docker.unknownExit.add(SEED);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false, step: "commit", unresolved: true });
		await vi.waitFor(() =>
			expect(h.docker.execs.filter((e) => e[1] === SEED).length).toBeGreaterThan(0),
		);
		await tick(200);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		await expectIncompatibleRefused(h);
		h.docker.endUnknownExecs(0);
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
	});

	it("readiness with exit unknown before the commit ⇒ rollback; N's removal is the evidence it ended", async () => {
		const h = await setup({ readinessMs: 30 });
		h.docker.unknownExit.add("readiness");
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false, status: 500, step: "start" });
		expect(r).not.toHaveProperty("unresolved");
		expect(await recordOf(h)).toMatchObject({
			state: "resolved",
			outcome: { kind: "rolled-back" },
		});
		expect(nIdOf(h)).toBeNull();
	});
});

// ── E2: T_rec bounds everything after the CAS ──────────────────────────────

describe("E2 — T_rec covers authorization, file writes and D1 writes after the commit", () => {
	const hangs: Array<[string, (h: H, gate: Promise<void>) => void]> = [
		[
			"authorization (hooks file write)",
			(h, gate) => {
				const real = h.capture.authorizeImpl;
				h.capture.authorizeImpl = async (run) => {
					await gate;
					return real(run);
				};
			},
		],
		[
			"defer-skill-seed removal",
			(h, gate) => {
				const real = h.capture.removeDeferSeed.bind(h.capture);
				let first = true;
				h.capture.removeDeferSeed = async () => {
					if (first) {
						first = false;
						await gate;
					}
					return real();
				};
			},
		],
		[
			"setPorts",
			(h, gate) => {
				const real = h.d1.setPorts.bind(h.d1);
				let first = true;
				h.d1.setPorts = async (sid, ports) => {
					if (first) {
						first = false;
						await gate;
					}
					return real(sid, ports);
				};
			},
		],
		[
			"setStatus",
			(h, gate) => {
				const real = h.d1.setStatus.bind(h.d1);
				let first = true;
				h.d1.setStatus = async (sid, st) => {
					if (first) {
						first = false;
						await gate;
					}
					return real(sid, st);
				};
			},
		],
	];
	for (const [label, install] of hangs) {
		it(`${label} hanging ⇒ answered at T_rec, uncertain with it named; the late answer continues nothing; converges and resolves after`, async () => {
			const h = await setup({ tRecMs: 250, tRbMs: 100 });
			const gate = deferred();
			install(h, gate.promise);
			const t0 = Date.now();
			const r = await recreateBounded(h);
			expect(r).not.toBe("hung");
			expect(Date.now() - t0).toBeLessThan(250 + 100 + 200);
			expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
			expect((r as { pending: string[] }).pending.join(" ")).toMatch(/no answer yet/);
			expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
			await expectIncompatibleRefused(h);
			const execsBefore = h.docker.execs.length;
			gate.resolve();
			await vi.waitFor(
				async () =>
					expect(await recordOf(h)).toMatchObject({
						state: "resolved",
						outcome: { kind: "committed" },
					}),
				{ timeout: 2000 },
			);
			// Nothing of step 6 ran off the late answer: no gitIdentity,
			// postStart or version exec. Only the resolution's own seed.
			expect(
				h.docker.execs.slice(execsBefore).filter((e) => e[1] !== SEED && e[1] !== "test"),
			).toEqual([]);
			expect(h.d1.row).toMatchObject({ container_id: nIdOf(h), status: "running" });
			expect(h.capture.deferSeed).toBe(false);
			expect(h.docker.containers.has(O_ID)).toBe(false);
			expect(h.capture.calls).toContain("converge done");
		});
	}
});

describe("E2 — a seed still out at T_rec", () => {
	it("is never issued a second time by the resolution", async () => {
		const h = await setup({ tRecMs: 250, tRbMs: 100 });
		const gate = deferred();
		h.docker.hooks.set("exec", async (a) => {
			if (String(a[1]).includes("seed-skills")) await gate.promise;
		});
		const r = await recreateBounded(h);
		expect(r).toMatchObject({ ok: true, unresolved: true });
		gate.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(h.docker.execs.filter((e) => e[1] === SEED)).toHaveLength(1);
	});
});

// ── E3: resolve only after converging, under the lock ──────────────────────

describe("E3 — the resolution converges and checks before `resolved`, under the session lock", () => {
	for (const op of INCOMPATIBLE) {
		it(`a ${op} queued while the resolution converges waits for it, and runs only after \`resolved\``, async () => {
			const h = await setup();
			h.d1.casMode = "ambiguous-applied";
			const gate = deferred();
			const real = h.capture.convergeImpl;
			h.capture.convergeImpl = async () => {
				await gate.promise;
				return real();
			};
			await h.engine.recreate(SID, IMG_N);
			await vi.waitFor(() => expect(h.capture.calls).toContain("converge"), { timeout: 2000 });
			// Converging: not resolved yet, and the lock is the resolution's.
			expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
			expect(h.lock.heldBy(SID)).toBe("recreate-resolve");
			const events: string[] = [];
			const queued = h.lock.run(
				SID,
				op,
				async () => {
					events.push(`${op} ran; converge done=${h.capture.calls.includes("converge done")}`);
				},
				{ mode: "wait" },
			);
			await tick(100);
			expect(events).toEqual([]);
			gate.resolve();
			await queued;
			expect(events).toEqual([`${op} ran; converge done=true`]);
			expect(await recordOf(h)).toMatchObject({ state: "resolved" });
		});
	}

	it("a convergence that fails is not resolved; the next pass converges and only then resolves", async () => {
		const h = await setup();
		h.d1.casMode = "ambiguous-applied";
		let n = 0;
		const second = deferred();
		const real = h.capture.convergeImpl;
		h.capture.convergeImpl = async () => {
			if (++n === 1) throw new Error("hooks file write failed");
			await second.promise;
			return real();
		};
		await h.engine.recreate(SID, IMG_N);
		// The second pass is held inside its converge: the first pass's
		// verdict is observable without racing the retry timer.
		await vi.waitFor(() => expect(n).toBe(2), { timeout: 2000 });
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		second.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(n).toBe(2);
	});

	it("a status that does not stick is seen on the re-check: not resolved", async () => {
		const h = await setup();
		h.d1.casMode = "ambiguous-applied";
		let calls = 0;
		const second = deferred();
		const real = h.d1.setStatus.bind(h.d1);
		h.d1.setStatus = async (sid, st) => {
			calls++;
			// The second pass waits here, so the first pass's verdict is
			// observable without racing the retry timer.
			if (calls === 2) await second.promise;
			await real(sid, st);
			if (calls === 1) h.d1.row.status = "stopped"; // overwritten behind our back once
		};
		await h.engine.recreate(SID, IMG_N);
		await vi.waitFor(() => expect(calls).toBe(2), { timeout: 2000 });
		// The first pass saw the status not stick: it did not resolve.
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		second.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(h.d1.row.status).toBe("running");
	});

	it("rollback within T_rb resolves under the attempt's own lock (no self-deadlock)", async () => {
		const h = await setup();
		const heldAtRenameBack: Array<string | null> = [];
		h.docker.hooks.set("rename", (a) => {
			if (a[1] === h.d1.row.container_name && a[0] === O_ID)
				heldAtRenameBack.push(h.lock.heldBy(SID));
		});
		h.docker.hooks.set("start", () => {
			throw new Error("start refused");
		});
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false, status: 500, step: "start" });
		expect(r).not.toHaveProperty("unresolved");
		expect(heldAtRenameBack).toEqual(["recreate"]);
	});

	it("a rollback pass that outlives T_rb stops at its lease; the pass that finishes holds the lock itself", async () => {
		const h = await setup({ tRbMs: 80 });
		const gate = deferred();
		const heldAtRenameBack: Array<string | null> = [];
		h.docker.hooks.set("start", () => {
			throw new Error("start refused");
		});
		h.docker.hooks.set("remove", () => gate.promise);
		h.docker.hooks.set("rename", (a) => {
			if (a[0] === O_ID && a[1] === h.d1.row.container_name)
				heldAtRenameBack.push(h.lock.heldBy(SID));
		});
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false, step: "start", unresolved: true });
		expect(h.lock.heldBy(SID)).toBeNull();
		await expectIncompatibleRefused(h);
		h.docker.hooks.delete("remove");
		gate.resolve();
		await vi.waitFor(
			async () =>
				expect(await recordOf(h)).toMatchObject({
					state: "resolved",
					outcome: { kind: "rolled-back" },
				}),
			{ timeout: 2000 },
		);
		expect(heldAtRenameBack).toEqual(["recreate-resolve"]);
		expect(h.capture.deferSeed).toBe(false);
	});
});

// ── Point 8: no universal CLI compatibility ────────────────────────────────

describe("control-marker-incompatible — only a CLI /etc/st-control was validated with", () => {
	for (const version of ["2.1.309", "3.0.0", "2.1.307", null]) {
		it(`workspace CLI ${version ?? "unreadable"} ⇒ 409 control-marker-incompatible, no record, no effects; listed by the preflight`, async () => {
			const h = await setup();
			h.cli.version = version;
			const r = await h.engine.recreate(SID, IMG_N);
			expect(r).toMatchObject({ ok: false, status: 409, code: "control-marker-incompatible" });
			expect(h.docker.mutations()).toEqual([]);
			expect(await h.attempts.read(SID)).toMatchObject({ kind: "none" });
			expect(await h.engine.preflight(SID)).toMatchObject({
				recreatable: false,
				blockers: [{ code: "control-marker-incompatible" }],
			});
		});
	}

	it("the validated version passes", async () => {
		const h = await setup();
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({ ok: true, outcome: "committed" });
	});
});

// ── D8 after the CAS ───────────────────────────────────────────────────────

describe("D8 — a crash between the CAS and step 6.1 stays unresolved without evidence", () => {
	it("restart while authorizing on N ⇒ uncertain + orphaned, defer-skill-seed kept, nothing converges it", async () => {
		const h = await setup({ tRecMs: 200, tRbMs: 80 });
		const gate = deferred();
		const real = h.capture.authorizeImpl;
		h.capture.authorizeImpl = async (run) => {
			await gate.promise;
			return real(run);
		};
		const pending = h.engine.recreate(SID, IMG_N);
		await vi.waitFor(() => expect(h.d1.row.container_id).not.toBe(O_ID));
		h.engine.stop(); // the process goes away mid step 5
		const attempts = new RecreateAttemptStore(h.root);
		await attempts.recoverOnBoot();
		const lock = new SessionLifecycleLock();
		lock.setGuard((sid) => attempts.assertResolved(sid));
		const engine = new RecreationEngine({
			workspaceRoot: h.root,
			docker: h.docker,
			d1: h.d1,
			attempts,
			lock,
			capture: h.capture,
			config: FAST,
		});
		await engine.bootPass();
		gate.resolve();
		await pending;
		await tick(150);
		const rec = await attempts.read(SID);
		expect(rec).toMatchObject({ kind: "ok", record: { state: "uncertain" } });
		expect((rec as { record: { orphanedAt?: string } }).record.orphanedAt).toBeTruthy();
		expect(h.capture.deferSeed).toBe(true); // the boot pass did not retire it
		for (const op of INCOMPATIBLE) {
			await expect(lock.run(SID, op, async () => 1)).rejects.toBeInstanceOf(
				RecreateUnresolvedError,
			);
		}
	});
});
