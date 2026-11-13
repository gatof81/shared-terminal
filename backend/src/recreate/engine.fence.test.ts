/**
 * recreate/engine.ts — the commit fence (CONVERSATION.md §2.7.4/§2.7.7,
 * v1.9.4, #627): a commit statement (`cas`, or the rollback's `casBack`)
 * that a dead process left in flight must never land after a recovery
 * removed the container it names. Against the fake Docker and D1 of
 * engine.testutil.ts (whose statements honour the fence) and the REAL
 * attempt store and lifecycle lock. A "dead" process here is an engine
 * whose D1 statement never answers: the statement is held and lands later,
 * at the moment each test chooses, through the adapter itself.
 */
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { RecreateAttemptStore } from "../recreateAttempt.js";
import { SessionLifecycleLock } from "../sessionLifecycleLock.js";
import { RecreationEngine } from "./engine.js";
import {
	CANONICAL,
	deferred,
	dirtyLayer,
	FAST,
	harness,
	httpError,
	IMG_N,
	O_ID,
	SID,
} from "./engine.testutil.js";
import { RESERVED_NAME_RE } from "./ports.js";

type H = Awaited<ReturnType<typeof harness>>;
const roots: string[] = [];
async function setup(): Promise<H> {
	const h = await harness();
	roots.push(h.root);
	return h;
}
afterEach(async () => {
	for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
const nIdOf = (h: H) => [...h.docker.containers.keys()].find((id) => id !== O_ID) ?? null;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A second backend process over the same files, D1 and Docker (as engine.carry.test.ts). */
async function restart(h: H) {
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
		readWorkspaceSkill: async () => ({ kind: "absent" }),
		readCliVersion: async () => "2.1.308",
		diskFree: async () => h.disk.free,
		backupFresh: async () => h.backup.fresh,
		config: FAST,
	});
	return { attempts, engine };
}

/**
 * The commit statement is sent and its answer never comes back to the
 * process that sent it. `land()` runs it against the row later — once; the
 * outcome is what D1 would answer, but nobody in the dead process hears it.
 * `landLegacy()` runs it as a backend before v1.9.4 sent it: no fence.
 */
function hold(h: H, which: "cas" | "casBack") {
	const real = (which === "cas" ? h.d1.cas : h.d1.casBack).bind(h.d1) as (
		...a: unknown[]
	) => Promise<string>;
	const sent = deferred<unknown[]>();
	let landed: Promise<string> | null = null;
	const held = (...args: unknown[]) => {
		h.d1.writes.push(`${which} sent`);
		sent.resolve(args);
		// Only the dead process's statement is held; later ones are ordinary.
		if (which === "cas") h.d1.cas = real as never;
		else h.d1.casBack = real as never;
		return new Promise<never>(() => {});
	};
	if (which === "cas") h.d1.cas = held as never;
	else h.d1.casBack = held as never;
	const run = (legacy: boolean) => {
		if (!landed) {
			landed = sent.promise.then((args) => real(...(legacy ? args.slice(0, -1) : args)));
		}
		return landed;
	};
	return {
		sent: sent.promise,
		land: () => run(false),
		landLegacy: () => run(true),
		get landedYet() {
			return landed !== null;
		},
	};
}

/** The invariant of §2.7.2: D1 never points at a container that does not exist. */
function d1PointsAtAnExistingContainer(h: H) {
	expect(h.d1.row.container_id).not.toBeNull();
	expect(h.docker.containers.has(h.d1.row.container_id as string)).toBe(true);
}

/** A strict recreation whose step-4 CAS is in flight when the process dies; N stopped by the operator. */
async function diedWithCasInFlight() {
	const h = await setup();
	const cas = hold(h, "cas");
	void h.engine.recreate(SID, IMG_N);
	await cas.sent;
	const nId = nIdOf(h) as string;
	expect(h.d1.row.container_id).toBe(O_ID); // not landed yet
	h.engine.stop(); // the process dies
	const next = await restart(h);
	const rec = await next.attempts.read(SID);
	expect(rec.kind === "ok" && rec.record.commit?.fence).toBe(0);
	expect(rec.kind === "ok" && rec.record.orphanedAt).toBeTruthy();
	await h.docker.stop(nId); // recover requires every container stopped
	return { h, cas, nId, ...next };
}

// ── Forward commit (step 4) ────────────────────────────────────────────────

describe("the commit fence: a CAS left in flight by a dead process (#627)", () => {
	it("the CAS lands BEFORE the fence ⇒ recovery keeps N (D1's container) and resolves committed on it", async () => {
		const { h, cas, nId, engine } = await diedWithCasInFlight();
		h.d1.beforeFence = async () => {
			expect(await cas.land()).toBe("applied");
		};
		const r = await engine.recover(SID);
		expect(r).toMatchObject({
			ok: true,
			body: { outcome: { kind: "committed", nContainerId: nId } },
		});
		expect(cas.landedYet).toBe(true);
		expect(h.d1.row.container_id).toBe(nId);
		expect(h.docker.containers.has(nId)).toBe(true);
		expect(h.docker.containers.has(O_ID)).toBe(false); // strict mode: O removed after the commit
		expect(h.d1.row.recreate_fence).toBe(1); // consumed by the CAS; the fence matched 0 rows
		d1PointsAtAnExistingContainer(h);
	});

	it("the CAS lands AFTER the fence (right before N is removed) ⇒ 0 rows; rolled back, D1 never on a removed container", async () => {
		const { h, cas, nId, engine, attempts } = await diedWithCasInFlight();
		let late: string | null = null;
		h.docker.hooks.set("remove", async (args) => {
			if (args[0] === nId && !cas.landedYet) late = await cas.land();
		});
		const r = await engine.recover(SID);
		expect(r).toMatchObject({ ok: true, body: { outcome: { kind: "rolled-back" } } });
		expect(late).toBe("not-applied");
		expect(h.d1.row.container_id).toBe(O_ID);
		expect(h.d1.row.ingest_token_hash).toBe("H-old");
		expect(h.docker.containers.has(nId)).toBe(false);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(h.d1.writes).toContain("fence(0)");
		await expect(attempts.assertResolved(SID)).resolves.toBeUndefined();
		d1PointsAtAnExistingContainer(h);
	});

	for (const mode of ["ambiguous-not", "rejected"] as const) {
		it(`the fence update is ${mode === "rejected" ? "refused by D1" : "a timeout that never ran"} ⇒ unresolved, nothing removed; the CAS can still land, on a container that exists`, async () => {
			const { h, cas, nId, engine, attempts } = await diedWithCasInFlight();
			h.d1.fenceMode = mode;
			const removesBefore = h.docker.log.filter((l) => l.startsWith("remove:")).length;
			const r = await engine.recover(SID);
			expect(r).toMatchObject({ ok: false, status: 409, code: "recover-retry" });
			expect(h.docker.log.filter((l) => l.startsWith("remove:")).length).toBe(removesBefore);
			expect(h.docker.containers.has(nId)).toBe(true);
			expect(h.docker.containers.has(O_ID)).toBe(true);
			expect(h.d1.row.recreate_fence).toBe(0);
			await expect(attempts.assertResolved(SID)).rejects.toThrow(/uncertain/);
			// Exactly why N had to stay: the statement may still land.
			expect(await cas.land()).toBe("applied");
			d1PointsAtAnExistingContainer(h);
			// The next recover finds D1 on N and converges on it.
			h.d1.fenceMode = "normal";
			expect(await engine.recover(SID)).toMatchObject({
				ok: true,
				body: { outcome: { kind: "committed", nContainerId: nId } },
			});
			d1PointsAtAnExistingContainer(h);
		});
	}

	it("a fence whose answer is lost but which did land counts: the re-read proves it", async () => {
		const { h, cas, nId, engine } = await diedWithCasInFlight();
		h.d1.fenceMode = "ambiguous-applied";
		expect(await engine.recover(SID)).toMatchObject({
			ok: true,
			body: { outcome: { kind: "rolled-back" } },
		});
		expect(h.d1.row.recreate_fence).toBe(1);
		expect(h.docker.containers.has(nId)).toBe(false);
		expect(await cas.land()).toBe("not-applied");
		d1PointsAtAnExistingContainer(h);
	});

	it("restart between the durable commit intent and the CAS: the fence applies, N goes, rolled back, no CAS ever sent", async () => {
		const h = await setup();
		const recorded = deferred();
		const real = h.attempts.recordCommitIntent.bind(h.attempts);
		h.attempts.recordCommitIntent = async (...args) => {
			await real(...args);
			recorded.resolve();
			return new Promise<never>(() => {}); // the process dies right after the fsync
		};
		void h.engine.recreate(SID, IMG_N);
		await recorded.promise;
		const nId = nIdOf(h) as string;
		h.engine.stop();
		const { engine } = await restart(h);
		await h.docker.stop(nId);
		expect(await engine.recover(SID)).toMatchObject({
			ok: true,
			body: { outcome: { kind: "rolled-back" } },
		});
		expect(h.d1.writes.filter((w) => w.startsWith("cas"))).toEqual([]);
		expect(h.d1.writes).toContain("fence(0)");
		expect(h.d1.row).toMatchObject({ container_id: O_ID, recreate_fence: 1 });
		expect(h.docker.containers.has(nId)).toBe(false);
	});

	it("restart mid-recovery after the fence, before the resolution: the next recover proves the fence from D1 and resolves; the late CAS lands on nothing", async () => {
		const { h, cas, nId, engine } = await diedWithCasInFlight();
		h.docker.hooks.set("remove", (args) => {
			if (args[0] === nId) throw httpError(500, "daemon hiccup");
		});
		expect(await engine.recover(SID)).toMatchObject({
			ok: false,
			status: 409,
			code: "recover-retry",
		});
		expect(h.d1.row.recreate_fence).toBe(1); // the fence landed
		expect(h.docker.containers.has(nId)).toBe(true);
		h.docker.hooks.delete("remove");
		const again = await restart(h); // the recovering process dies too
		await expect(again.attempts.assertResolved(SID)).rejects.toThrow(/uncertain/);
		expect(await again.engine.recover(SID)).toMatchObject({
			ok: true,
			body: { outcome: { kind: "rolled-back" } },
		});
		// Its own fence matched 0 rows; the read showed the generation already past.
		expect(h.d1.writes.filter((w) => w === "fence(0)")).toHaveLength(2);
		expect(h.d1.row.recreate_fence).toBe(1);
		expect(h.docker.containers.has(nId)).toBe(false);
		expect(await cas.land()).toBe("not-applied");
		d1PointsAtAnExistingContainer(h);
	});

	it("live process, ambiguous CAS whose statement lands late: the resolution fences before removing N", async () => {
		const h = await setup();
		const real = h.d1.cas.bind(h.d1);
		let args: Parameters<typeof real> | null = null;
		h.d1.cas = async (...a) => {
			args = a;
			return "ambiguous"; // the answer is lost; the statement has not run yet
		};
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false, step: "commit", unresolved: true });
		for (let i = 0; i < 100; i++) {
			const rec = await h.attempts.read(SID);
			if (rec.kind === "ok" && rec.record.state === "resolved") break;
			await tick(20);
		}
		await expect(h.attempts.assertResolved(SID)).resolves.toBeUndefined();
		expect(h.d1.writes).toContain("fence(0)");
		expect(nIdOf(h)).toBeNull();
		expect(await real(...(args as unknown as Parameters<typeof real>))).toBe("not-applied");
		expect(h.d1.row.container_id).toBe(O_ID);
		d1PointsAtAnExistingContainer(h);
	});
});

// ── Reverse commit (`casBack`, §2.7.7) ──────────────────────────────────────

describe("the commit fence: a rollback's casBack left in flight (#627)", () => {
	/** A committed carry-over (O retained), then a rollback whose casBack never answers. */
	async function diedWithCasBackInFlight() {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		const nId = nIdOf(h) as string;
		expect(h.d1.row).toMatchObject({ container_id: nId, recreate_fence: 1 });
		await h.docker.stop(nId);
		const back = hold(h, "casBack");
		void h.engine.rollbackToRetained(SID);
		await back.sent;
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL); // both renames done
		h.engine.stop();
		const next = await restart(h);
		const rec = await next.attempts.read(SID);
		expect(rec.kind === "ok" && rec.record.commit?.fence).toBe(1);
		return { h, back, nId, ...next };
	}

	it("casBack lands BEFORE the fence ⇒ recovery resolves committed on the retained O, N retained", async () => {
		const { h, back, nId, engine } = await diedWithCasBackInFlight();
		h.d1.beforeFence = async () => {
			expect(await back.land()).toBe("applied");
		};
		expect(await engine.recover(SID)).toMatchObject({
			ok: true,
			body: {
				outcome: { kind: "committed", nContainerId: O_ID },
				retained: { containerId: nId, role: "N" },
			},
		});
		expect(h.d1.row.container_id).toBe(O_ID);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(h.docker.containers.get(nId)?.name).toMatch(/-old-\d+$/);
		d1PointsAtAnExistingContainer(h);
	});

	it("casBack lands AFTER the fence ⇒ 0 rows: D1 stays on N, names restored, O still retained, rollback still possible", async () => {
		const { h, back, nId, engine } = await diedWithCasBackInFlight();
		expect(await engine.recover(SID)).toMatchObject({
			ok: true,
			body: { outcome: { kind: "rolled-back" }, retained: { containerId: O_ID, role: "O" } },
		});
		expect(h.d1.row).toMatchObject({ container_id: nId, recreate_fence: 2 });
		expect(await back.land()).toBe("not-applied");
		expect(h.d1.row.container_id).toBe(nId);
		expect(h.docker.containers.get(nId)?.name).toBe(CANONICAL);
		expect(h.docker.containers.get(O_ID)?.name).toMatch(RESERVED_NAME_RE);
		d1PointsAtAnExistingContainer(h);
		// The way back stays open, on the current generation.
		expect((await engine.rollbackToRetained(SID)).ok).toBe(true);
		expect(h.d1.row).toMatchObject({ container_id: O_ID, recreate_fence: 3 });
	});
});

// ── Records from before the fence (§2.7.7, `commit-unknown-legacy`) ─────────

describe("a record written before the fence (#627)", () => {
	async function makeLegacy(h: H) {
		const file = (await import("node:path")).join(
			h.root,
			".st-control",
			SID,
			"recreate-attempt.json",
		);
		const rec = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		delete rec.commitFence;
		delete rec.commit;
		await fs.writeFile(file, JSON.stringify(rec));
		return file;
	}

	it("D1 on O proves nothing ⇒ 409 commit-unknown-legacy, no effect; D1 already on N is evidence ⇒ recovers committed", async () => {
		const { h, cas, nId, engine } = await diedWithCasInFlight();
		const file = await makeLegacy(h);
		const before = await fs.readFile(file, "utf8");
		const docker0 = h.docker.mutations().length;
		expect(await engine.recover(SID)).toMatchObject({
			ok: false,
			status: 409,
			code: "commit-unknown-legacy",
		});
		expect(await fs.readFile(file, "utf8")).toBe(before); // not even adopted
		expect(h.docker.mutations().length).toBe(docker0);
		expect(h.d1.writes.some((w) => w.startsWith("fence"))).toBe(false);
		// A fence would not have helped: the old statement does not carry one.
		expect(await cas.landLegacy()).toBe("applied");
		d1PointsAtAnExistingContainer(h);
		expect(await engine.recover(SID)).toMatchObject({
			ok: true,
			body: { outcome: { kind: "committed", nContainerId: nId } },
		});
		d1PointsAtAnExistingContainer(h);
	});

	it("a legacy rollback attempt with D1 still on the replaced container ⇒ blocked the same way", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		const nId = nIdOf(h) as string;
		await h.docker.stop(nId);
		const back = hold(h, "casBack");
		void h.engine.rollbackToRetained(SID);
		await back.sent;
		h.engine.stop();
		const { engine } = await restart(h);
		await makeLegacy(h);
		expect(await engine.recover(SID)).toMatchObject({
			ok: false,
			status: 409,
			code: "commit-unknown-legacy",
		});
		expect(h.d1.row.container_id).toBe(nId);
		expect(h.docker.containers.has(O_ID)).toBe(true);
	});
});
