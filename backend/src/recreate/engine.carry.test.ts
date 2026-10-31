/**
 * recreate/engine.ts — the carry-over mode (CONVERSATION.md §2.7.7, legacy
 * session activation): HOME and /tmp entries of O's layer streamed into N
 * before N starts, O retained until approval, a post-commit rollback to the
 * retained O, and the operator-driven D8 recovery — against the fake Docker
 * (held, failed or late requests), the fake D1 and the REAL attempt store
 * and lifecycle lock.
 */
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { RecreateAttemptStore } from "../recreateAttempt.js";
import { SessionLifecycleLock } from "../sessionLifecycleLock.js";
import { carryBudgetMs, planCarry, requiredFreeBytes } from "./carry.js";
import { RecreationEngine } from "./engine.js";
import {
	CANONICAL,
	deferred,
	dirtyLayer,
	FAST,
	harness,
	IMG_N,
	O_ID,
	SID,
} from "./engine.testutil.js";
import { LABEL_ATTEMPT } from "./ports.js";

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

const EXPECTED_ENTRIES = [
	"/home/developer/.bashrc",
	"/home/developer/.cache",
	"/home/developer/.config",
	"/home/developer/.local",
	"/home/developer/.npm",
	"/home/developer/dash-backup",
	"/tmp/build-cache",
];

// ── The plan (pure) ─────────────────────────────────────────────────────────

describe("planCarry (§2.7.7)", () => {
	it("carries the top-level HOME and /tmp entries, skips the entrypoint's and the CLI's runtime, blocks system changes and deletions", async () => {
		const h = await setup();
		dirtyLayer(h);
		const plan = await planCarry({
			changes: h.docker.changesOf.get(O_ID) as never,
			mounts: ["/home/developer/workspace", "/home/developer/uploads"],
			stat: (p) => h.docker.statPath(O_ID, p),
		});
		expect(plan.entries.map((e) => e.path)).toEqual(EXPECTED_ENTRIES);
		expect(plan.entries.find((e) => e.path.endsWith(".bashrc"))?.kind).toBe("file");
		expect(plan.blockers).toEqual([]);
		// Counts are per `docker diff` entry. entrypoint: its 5 top-level symlinks
		// (`.config/gh` sits under the carried `.config`), /tmp/.st-ready, the tmux
		// dir, the relay log; CLI runtime: cc-socks, its socket, claude-1000; one stale socket.
		expect(plan.skipped).toEqual({ entrypoint: 8, cliRuntime: 3, socket: 1 });
		const sys = await planCarry({
			changes: [
				{ Path: "/etc/apt", Kind: 0 },
				{ Path: "/etc/apt/sources.list", Kind: 1 },
				{ Path: "/home/developer/.profile", Kind: 2 },
			],
			mounts: [],
			stat: async () => null,
		});
		expect(sys.blockers).toEqual([
			{ code: "layer-deleted", count: 1 },
			{ code: "layer-system", count: 2 },
		]);
	});
	it("budget and disk arithmetic", () => {
		expect(carryBudgetMs(0, 300_000, 20 * 1024 ** 2, 3_600_000)).toBe(300_000);
		expect(carryBudgetMs(12 * 1024 ** 3, 300_000, 20 * 1024 ** 2, 3_600_000)).toBe(
			300_000 + 614_400,
		);
		expect(carryBudgetMs(1024 ** 4, 300_000, 20 * 1024 ** 2, 3_600_000)).toBe(3_600_000);
		expect(requiredFreeBytes(10 * 1024 ** 3)).toBe(Math.ceil(10 * 1024 ** 3 * 1.2) + 1024 ** 3);
	});
});

// ── Preflight and preconditions ─────────────────────────────────────────────

describe("preflight with preserve (§2.7.7)", () => {
	it("a dirty layer blocks the strict mode and is recreatable in carry-over mode, with the preview", async () => {
		const h = await setup();
		dirtyLayer(h, 5_000_000);
		const strict = await h.engine.preflight(SID);
		expect(strict).toMatchObject({ recreatable: false });
		expect((strict as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toContain(
			"layer-home",
		);
		const carry = await h.engine.preflight(SID, { preserve: true });
		expect(carry).toMatchObject({
			recreatable: true,
			blockers: [],
			carry: {
				entries: 7,
				bytes: 5_000_000,
				backupFresh: true,
				diskRequiredBytes: requiredFreeBytes(5_000_000),
			},
		});
		expect((carry as { retained?: unknown }).retained).toBeUndefined();
		expect(h.docker.mutations()).toEqual([]);
	});
	const cases: Array<[string, (h: H) => void]> = [
		[
			"disk-space",
			(h) => {
				h.disk.free = 1_000;
			},
		],
		[
			"disk-space",
			(h) => {
				h.disk.free = null;
			},
		],
		[
			"backup-stale",
			(h) => {
				h.backup.fresh = false;
			},
		],
		[
			"layer-size-unknown",
			(h) => {
				h.docker.sizeRwOf.set(O_ID, null);
			},
		],
		[
			"layer-system",
			(h) => {
				h.docker.changesOf.get(O_ID)?.push({ Path: "/etc/motd", Kind: 0 });
			},
		],
		[
			"layer-deleted",
			(h) => {
				h.docker.changesOf.get(O_ID)?.push({ Path: "/home/developer/.profile", Kind: 2 });
			},
		],
	];
	for (const [code, arrange] of cases) {
		it(`${code} ⇒ 409 with no effect`, async () => {
			const h = await setup();
			dirtyLayer(h);
			arrange(h);
			const r = await h.engine.recreate(SID, IMG_N, { preserve: true });
			expect(r).toMatchObject({ ok: false, status: 409, code });
			expect(h.docker.mutations()).toEqual([]);
			expect(await recordOf(h)).toBeNull();
			const pf = await h.engine.preflight(SID, { preserve: true });
			expect((pf as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toContain(
				code,
			);
		});
	}
});

// ── The carry-over itself ───────────────────────────────────────────────────

describe("carry-over recreation (§2.7.7)", () => {
	it("copies every planned entry in order before N starts, verifies it, commits, and keeps O stopped under its -old- name", async () => {
		const h = await setup();
		dirtyLayer(h);
		const order: string[] = [];
		h.docker.hooks.set("copyPath", async () => {
			order.push(h.docker.log.at(-1) as string);
			// N is not started yet when a copy goes out.
			const n = [...h.docker.containers.values()].find((c) => c.id !== O_ID);
			expect(n?.running).toBe(false);
		});
		const r = await h.engine.recreate(SID, IMG_N, { preserve: true });
		expect(r).toMatchObject({ ok: true, outcome: "committed", carried: { entries: 7 } });
		expect(h.docker.copies.map((c) => c.split("→")[0]?.split(":")[1])).toEqual(EXPECTED_ENTRIES);
		const nId = nIdOf(h) as string;
		expect(h.d1.row.container_id).toBe(nId);
		// N holds what O held.
		expect(h.docker.statsOf.get(nId)?.get("/home/developer/dash-backup/flows.json")).toEqual({
			kind: "file",
			size: 90_000,
		});
		expect(h.docker.statsOf.get(nId)?.get("/tmp/build-cache/a.o")).toEqual({
			kind: "file",
			size: 1_900_000,
		});
		expect(h.docker.statsOf.get(nId)?.has("/tmp/cc-socks/42.sock")).toBe(false);
		// O retained: present, stopped, -old- name; the record says so.
		const o = h.docker.containers.get(O_ID);
		expect(o?.running).toBe(false);
		expect(o?.name).toMatch(new RegExp(`^${CANONICAL}-old-\\d+$`));
		const rec = await recordOf(h);
		expect(rec).toMatchObject({
			state: "resolved",
			outcome: { kind: "committed", nContainerId: nId },
			preserve: { entries: 7, bytes: 5_000_000 },
		});
		expect(rec?.retained).toMatchObject({ containerId: O_ID, role: "O", name: o?.name });
		expect((r as { retained?: { containerId: string } }).retained?.containerId).toBe(O_ID);
		// Visible in the preflight, and the session is not gated.
		const pf = await h.engine.preflight(SID);
		expect((pf as { retained?: { containerId: string } }).retained?.containerId).toBe(O_ID);
		await expect(h.attempts.assertResolved(SID)).resolves.toBeUndefined();
	});

	it("a copy that does not land as planned fails the step before N is renamed or started: ordinary rollback, O canonical, N gone", async () => {
		const h = await setup();
		dirtyLayer(h);
		// The fake copies nothing for the second entry: its stat in N is missing.
		let n = 0;
		const real = h.docker.copyPath.bind(h.docker);
		h.docker.copyPath = async (from, p, to, dest, mayAct) => {
			n++;
			if (n === 2) return { bytes: 0 };
			return real(from, p, to, dest, mayAct);
		};
		const r = await h.engine.recreate(SID, IMG_N, { preserve: true });
		expect(r).toMatchObject({ ok: false, status: 409, code: "carry-verify", step: "prepare" });
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(nIdOf(h)).toBeNull();
		expect(h.d1.row.container_id).toBe(O_ID);
		expect(await recordOf(h)).toMatchObject({
			state: "resolved",
			outcome: { kind: "rolled-back" },
		});
		expect(h.docker.log.filter((l) => l.startsWith("start:"))).toEqual([]);
	});

	it("T_rec runs out during the copies: no further copy goes out, the rollback resolves, O canonical", async () => {
		const h = await setup({ tRecMs: 60, carryBytesPerSec: 1_000_000_000, carryCapMs: 60 });
		dirtyLayer(h, 10);
		let requested = 0;
		h.docker.hooks.set("copyPath", async () => {
			requested++;
			if (requested === 2) await tick(120); // the second copy answers after T_rec
		});
		const r = await h.engine.recreate(SID, IMG_N, { preserve: true });
		expect(r).toMatchObject({ ok: false, code: "recreate-failed", step: "prepare" });
		await tick(100);
		// Two copies requested; the second answered after the epoch closed, so
		// the port did not start it (nothing landed in N); the third was never requested.
		expect(requested).toBe(2);
		expect(h.docker.copies.length).toBe(1);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(h.d1.row.container_id).toBe(O_ID);
	});

	it("approve removes the retained O and clears the record; a running retained O is refused; approving twice says nothing-retained", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		h.docker.containers.get(O_ID)!.running = true;
		expect(await h.engine.approve(SID)).toMatchObject({
			ok: false,
			status: 409,
			code: "retained-running",
		});
		h.docker.containers.get(O_ID)!.running = false;
		expect(await h.engine.approve(SID)).toMatchObject({
			ok: true,
			body: { removed: true, containerId: O_ID, role: "O" },
		});
		expect(h.docker.containers.has(O_ID)).toBe(false);
		const rec = await recordOf(h);
		expect(rec?.retained).toBeUndefined();
		expect(rec?.approvedAt).toBeTruthy();
		expect(await h.engine.approve(SID)).toMatchObject({
			ok: false,
			status: 409,
			code: "nothing-retained",
		});
	});

	it("rollback to the retained O: N must be stopped; one D1 statement moves back; names swap; ports cleared; capture files withdrawn; N retained until approval", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		const nId = nIdOf(h) as string;
		expect(h.capture.marker && h.capture.hooksFile).toBe(true);
		expect(await h.engine.rollbackToRetained(SID)).toMatchObject({
			ok: false,
			status: 409,
			code: "running",
		});
		await h.docker.stop(nId);
		const r = await h.engine.rollbackToRetained(SID);
		expect(r).toMatchObject({
			ok: true,
			body: { outcome: "rolled-back-to-retained", containerId: O_ID },
		});
		expect(h.d1.row.container_id).toBe(O_ID);
		expect(h.d1.row.ingest_token_hash).toBeNull();
		expect(h.d1.row.status).toBe("stopped");
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(h.docker.containers.get(nId)?.name).toMatch(/-old-\d+$/);
		expect(h.docker.containers.has(nId)).toBe(true);
		expect(h.d1.mappings).toEqual([]);
		// O has no control mounts: no authorization ⇒ both capture files withdrawn.
		expect(h.capture.marker || h.capture.hooksFile).toBe(false);
		const rec = await recordOf(h);
		expect(rec).toMatchObject({
			state: "resolved",
			reverse: true,
			outcome: { kind: "committed", nContainerId: O_ID },
		});
		expect(rec?.retained).toMatchObject({ containerId: nId, role: "N" });
		expect(rec?.history[0]?.outcome).toMatchObject({ kind: "committed", nContainerId: nId });
		// The retained N goes only with approval.
		expect(await h.engine.approve(SID)).toMatchObject({
			ok: true,
			body: { removed: true, containerId: nId, role: "N" },
		});
		expect(h.docker.containers.has(nId)).toBe(false);
		await expect(h.attempts.assertResolved(SID)).resolves.toBeUndefined();
	});

	it("rollback whose D1 statement does not apply restores both names and resolves rolled-back; D1 stays on N", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		const nId = nIdOf(h) as string;
		await h.docker.stop(nId);
		h.d1.casMode = "rejected";
		const r = await h.engine.rollbackToRetained(SID);
		expect(r).toMatchObject({ ok: false, status: 409, code: "rollback-not-applied" });
		expect(h.d1.row.container_id).toBe(nId);
		expect(h.docker.containers.get(nId)?.name).toBe(CANONICAL);
		expect(h.docker.containers.get(O_ID)?.name).not.toBe(CANONICAL);
		expect(await recordOf(h)).toMatchObject({
			state: "resolved",
			reverse: true,
			outcome: { kind: "rolled-back" },
		});
		expect((await recordOf(h))?.retained).toMatchObject({ containerId: O_ID, role: "O" });
	});
});

// ── D8 recovery ─────────────────────────────────────────────────────────────

describe("operator recovery of an orphaned attempt (§2.7.7, D8)", () => {
	/**
	 * A second backend process over the same files: a new store (boot marks
	 * the orphan), a new in-process lock (the dead process's leases are gone
	 * with it) and a new engine.
	 */
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

	it("crash mid-copy: the next process finds the attempt orphaned and gated; recover removes the never-started N, O canonical, rolled-back", async () => {
		const h = await setup();
		dirtyLayer(h);
		const hang = deferred();
		h.docker.hooks.set("copyPath", async () => {
			if (h.docker.copies.length === 1) await hang.promise; // the second copy never answers in this process
		});
		const p = h.engine.recreate(SID, IMG_N, { preserve: true });
		await tick(30);
		h.engine.stop(); // the process dies (nothing else of it runs)
		const { attempts, engine } = await restart(h);
		await expect(attempts.assertResolved(SID)).rejects.toThrow(/uncertain|open/);
		expect(
			(await attempts.read(SID)).kind === "ok" &&
				((await attempts.read(SID)) as { record: { orphanedAt?: string } }).record.orphanedAt,
		).toBeTruthy();
		const nId = nIdOf(h) as string;
		expect(h.docker.containers.get(nId)?.running).toBe(false);
		const r = await engine.recover(SID);
		expect(r).toMatchObject({ ok: true, body: { outcome: { kind: "rolled-back" } } });
		expect(h.docker.containers.has(nId)).toBe(false);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(h.d1.row.container_id).toBe(O_ID);
		await expect(attempts.assertResolved(SID)).resolves.toBeUndefined();
		hang.resolve();
		await p.catch(() => undefined);
	});

	it("crash after the commit: recover requires N stopped, then converges on N and keeps the retained O", async () => {
		const h = await setup();
		dirtyLayer(h);
		const hang = deferred();
		const realStatus = h.d1.setStatus.bind(h.d1);
		h.d1.setStatus = async (sid, status) => {
			await hang.promise; // the process dies while step 6 waits on D1
			return realStatus(sid, status);
		};
		const p = h.engine.recreate(SID, IMG_N, { preserve: true });
		await tick(60);
		const nId = nIdOf(h) as string;
		expect(h.d1.row.container_id).toBe(nId); // committed
		h.engine.stop();
		h.d1.setStatus = realStatus;
		const { attempts, engine } = await restart(h);
		expect(await engine.recover(SID)).toMatchObject({ ok: false, status: 409, code: "running" });
		await h.docker.stop(nId);
		const r = await engine.recover(SID);
		expect(r).toMatchObject({
			ok: true,
			body: { outcome: { kind: "committed", nContainerId: nId } },
		});
		expect((r as { body: { retained: { containerId: string } } }).body.retained.containerId).toBe(
			O_ID,
		);
		expect(h.docker.containers.has(O_ID)).toBe(true);
		expect(h.d1.row.status).toBe("stopped");
		await expect(attempts.assertResolved(SID)).resolves.toBeUndefined();
		// The leftover label of N is the committed container: the boot pass leaves it alone.
		await engine.bootPass();
		expect(h.docker.containers.has(nId)).toBe(true);
		expect(h.docker.containers.get(nId)?.labels[LABEL_ATTEMPT]).toBeTruthy();
		hang.resolve();
		await p.catch(() => undefined);
	});

	it("recover refuses an attempt that is not orphaned, and one already resolved", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect(await h.engine.recover(SID)).toMatchObject({
			ok: false,
			status: 404,
			code: "no-attempt",
		});
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		expect(await h.engine.recover(SID)).toMatchObject({
			ok: false,
			status: 409,
			code: "already-resolved",
		});
	});
});
