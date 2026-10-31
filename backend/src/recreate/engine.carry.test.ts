/**
 * recreate/engine.ts — the carry-over mode (CONVERSATION.md §2.7.7, legacy
 * session activation): HOME and /tmp entries of O's layer streamed into N
 * before N starts, O retained until approval, a post-commit rollback to the
 * retained O, and the operator-driven D8 recovery — against the fake Docker
 * (held, failed or late requests), the fake D1 and the REAL attempt store
 * and lifecycle lock.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecreateAttemptStore } from "../recreateAttempt.js";
import { SessionLifecycleLock } from "../sessionLifecycleLock.js";
import { carryBudgetMs, planCarry, requiredFreeBytes } from "./carry.js";
import { backupFreshIn, RecreationEngine } from "./engine.js";
import {
	CANONICAL,
	cleanChanges,
	deferred,
	dirtyLayer,
	FAST,
	harness,
	httpError,
	IMG_N,
	O_ID,
	SID,
} from "./engine.testutil.js";
import type { PathStat } from "./layer.js";
import { LABEL_ATTEMPT, RESERVED_NAME_RE } from "./ports.js";

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
			"disk-space-unknown",
			(h) => {
				h.disk.free = null; // RECREATE_DOCKER_FS_PATH unset or statfs failed: fail closed
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

	it("T_rec runs out during the copies: the copy in flight still lands in N, no further copy goes out, N is removed only after it answered", async () => {
		const h = await setup({ tRecMs: 60, carryBytesPerSec: 1_000_000_000, carryCapMs: 60 });
		dirtyLayer(h, 10);
		let requested = 0;
		let copyDoneAt = -1;
		h.docker.hooks.set("copyPath", async () => {
			requested++;
			if (requested === 2) {
				await tick(120); // Docker answers the second copy after T_rec
				copyDoneAt = h.docker.log.length;
			}
		});
		const r = await h.engine.recreate(SID, IMG_N, { preserve: true });
		// The resolution waited for the late answer (120 ms < T_rb): resolved, no `unresolved`.
		expect(r).toEqual({ ok: false, status: 500, code: "recreate-failed", step: "prepare" });
		// Two copies requested, both landed (putArchive is never aborted); the third never went out.
		expect(requested).toBe(2);
		expect(h.docker.copies.length).toBe(2);
		// `remove N` was issued only after the late copy had answered.
		const removeAt = h.docker.log.findIndex((l) => l.startsWith("remove:"));
		expect(removeAt).toBeGreaterThan(copyDoneAt);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(nIdOf(h)).toBeNull();
		expect(h.d1.row.container_id).toBe(O_ID);
	});

	it("a copy that outlasts T_rb too: 500 {unresolved:true}, the record uncertain, N untouched while the copy may still write, resolved by evidence once it answered", async () => {
		const h = await setup({
			tRecMs: 60,
			tRbMs: 100,
			carryBytesPerSec: 1_000_000_000,
			carryCapMs: 60,
		});
		dirtyLayer(h, 10);
		let requested = 0;
		const late = deferred();
		h.docker.hooks.set("copyPath", async () => {
			requested++;
			if (requested === 2) await late.promise;
		});
		const r = await h.engine.recreate(SID, IMG_N, { preserve: true });
		expect(r).toEqual({
			ok: false,
			status: 500,
			code: "recreate-failed",
			step: "prepare",
			unresolved: true,
		});
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		await expect(h.attempts.assertResolved(SID)).rejects.toThrow();
		// Nothing acted on N while its copy could still be writing.
		expect(h.docker.log.some((l) => l.startsWith("remove:"))).toBe(false);
		expect(nIdOf(h)).not.toBeNull();
		late.resolve();
		for (let i = 0; i < 50 && (await recordOf(h))?.state !== "resolved"; i++) await tick(20);
		expect(await recordOf(h)).toMatchObject({
			state: "resolved",
			outcome: { kind: "rolled-back" },
		});
		expect(nIdOf(h)).toBeNull();
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(h.docker.copies.length).toBe(2);
	});

	it("R3: real content where N's entrypoint puts its symlinks (~/.ssh dir, ~/.claude.json file, ~/.config/gh dir) blocks before any effect", async () => {
		const h = await setup();
		dirtyLayer(h);
		const HOME = "/home/developer";
		const changes = h.docker.changesOf.get(O_ID) as Array<{ Path: string; Kind: number }>;
		changes.push(
			{ Path: `${HOME}/.ssh/id_ed25519`, Kind: 1 },
			{ Path: `${HOME}/.config/gh/hosts.yml`, Kind: 1 },
		);
		const st = h.docker.statsOf.get(O_ID) as Map<string, PathStat>;
		st.set(`${HOME}/.ssh`, { kind: "dir" }); // a real dir, not the entrypoint's symlink
		st.set(`${HOME}/.ssh/id_ed25519`, { kind: "file", size: 400 });
		st.set(`${HOME}/.claude.json`, { kind: "file", size: 900 }); // real file where a symlink is expected
		st.set(`${HOME}/.config/gh`, { kind: "dir" }); // inside the carried ~/.config: N's entrypoint would rm -rf it
		st.set(`${HOME}/.config/gh/hosts.yml`, { kind: "file", size: 120 });
		const plan = await planCarry({
			changes: changes as never,
			mounts: ["/home/developer/workspace", "/home/developer/uploads"],
			stat: (p) => h.docker.statPath(O_ID, p),
		});
		expect(plan.blockers).toEqual([{ code: "layer-entrypoint-unexpected", count: 3 }]);
		expect(plan.entries.map((e) => e.path)).not.toContain(`${HOME}/.ssh`);
		const pf = await h.engine.preflight(SID, { preserve: true });
		expect(pf).toMatchObject({ recreatable: false });
		expect((pf as { blockers: Array<{ code: string }> }).blockers).toEqual([
			{ code: "layer-entrypoint-unexpected", count: 3 },
		]);
		const r = await h.engine.recreate(SID, IMG_N, { preserve: true });
		expect(r).toMatchObject({ ok: false, status: 409, code: "layer-entrypoint-unexpected" });
		expect(h.docker.mutations()).toEqual([]);
		expect(h.docker.copies).toEqual([]);
		expect(await recordOf(h)).toBeNull();
	});

	it("retained-pending: while a container is retained, a further recreation (strict or carry-over) is refused with no effect; after approve it is allowed", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		const nId = nIdOf(h) as string;
		await h.docker.stop(nId);
		h.docker.changesOf.set(nId, cleanChanges());
		for (const preserve of [false, true]) {
			const r = await h.engine.recreate(SID, IMG_N, { preserve });
			expect(r).toMatchObject({ ok: false, status: 409, code: "retained-pending" });
			const pf = await h.engine.preflight(SID, { preserve });
			expect((pf as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toContain(
				"retained-pending",
			);
		}
		expect(h.docker.containers.has(O_ID)).toBe(true);
		expect([...h.docker.containers.keys()].length).toBe(2);
		expect((await h.engine.approve(SID)).ok).toBe(true);
		expect((await h.engine.recreate(SID, IMG_N)).ok).toBe(true);
	});

	it("a rollback that fails transiently (rename refused once) resolves rolled-back with O still retained under a reserved -old- name, and the next rollback succeeds", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		const nId = nIdOf(h) as string;
		await h.docker.stop(nId);
		let refused = 0;
		h.docker.hooks.set("rename", async ([, name]) => {
			if (refused === 0 && name === CANONICAL) {
				refused++;
				throw httpError(500, "daemon hiccup"); // the second rename (O → canonical) fails once
			}
		});
		const first = await h.engine.rollbackToRetained(SID);
		expect(first).toMatchObject({
			ok: false,
			status: 500,
			code: "recreate-failed",
			detail: "rename",
		});
		for (let i = 0; i < 50 && (await recordOf(h))?.state !== "resolved"; i++) await tick(20);
		const rec = await recordOf(h);
		expect(rec).toMatchObject({
			state: "resolved",
			reverse: true,
			outcome: { kind: "rolled-back" },
		});
		expect(rec?.retained).toMatchObject({ containerId: O_ID, role: "O" });
		// Names restored: N canonical, O under a reserved name the boot pass recognises.
		expect(h.docker.containers.get(nId)?.name).toBe(CANONICAL);
		expect(h.docker.containers.get(O_ID)?.name).toMatch(RESERVED_NAME_RE);
		expect(h.d1.row.container_id).toBe(nId);
		h.docker.hooks.delete("rename");
		const second = await h.engine.rollbackToRetained(SID);
		expect(second).toMatchObject({
			ok: true,
			body: { outcome: "rolled-back-to-retained", containerId: O_ID },
		});
		expect(h.d1.row.container_id).toBe(O_ID);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
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

	it("R1: the process dies after the rollback's casBack applied ⇒ recover resolves committed on the retained O by its recorded id; idempotent", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		const nId = nIdOf(h) as string;
		await h.docker.stop(nId);
		const hang = deferred();
		const realStatus = h.d1.setStatus.bind(h.d1);
		h.d1.setStatus = async (sid, status) => {
			await hang.promise; // dies while the resolution writes status
			return realStatus(sid, status);
		};
		const p = h.engine.rollbackToRetained(SID);
		await tick(60);
		expect(h.d1.row.container_id).toBe(O_ID); // casBack applied
		h.engine.stop();
		h.d1.setStatus = realStatus;
		const { attempts, engine } = await restart(h);
		await expect(attempts.assertResolved(SID)).rejects.toThrow();
		const rec0 = (await attempts.read(SID)) as {
			record: { retainedContainerId?: string; nTempName: string };
		};
		expect(rec0.record.retainedContainerId).toBe(O_ID);
		// The recorded name no longer exists (the rollback renamed O to canonical): the id is what counts.
		expect(h.docker.byRef(rec0.record.nTempName)).toBeUndefined();
		const r = await engine.recover(SID);
		expect(r).toMatchObject({
			ok: true,
			body: {
				outcome: { kind: "committed", nContainerId: O_ID },
				retained: { containerId: nId, role: "N" },
			},
		});
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(h.docker.containers.get(nId)?.name).toMatch(/-old-\d+$/);
		expect(h.d1.row.status).toBe("stopped");
		expect(h.d1.mappings).toEqual([]);
		await expect(attempts.assertResolved(SID)).resolves.toBeUndefined();
		expect(await engine.recover(SID)).toMatchObject({
			ok: false,
			status: 409,
			code: "already-resolved",
		});
		hang.resolve();
		await p.catch(() => undefined);
	});

	it("R2: the process dies between the rollback's renames and its casBack ⇒ recover restores the names (O off canonical first) and resolves rolled-back, O still retained", async () => {
		const h = await setup();
		dirtyLayer(h);
		expect((await h.engine.recreate(SID, IMG_N, { preserve: true })).ok).toBe(true);
		const nId = nIdOf(h) as string;
		await h.docker.stop(nId);
		const hang = deferred();
		const realCasBack = h.d1.casBack.bind(h.d1);
		h.d1.casBack = async (...args) => {
			await hang.promise; // dies with both renames done and the CAS never sent
			return realCasBack(...args);
		};
		const p = h.engine.rollbackToRetained(SID);
		await tick(60);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect(h.docker.containers.get(nId)?.name).toMatch(/-old-\d+$/);
		expect(h.d1.row.container_id).toBe(nId);
		h.engine.stop();
		h.d1.casBack = realCasBack;
		const { attempts, engine } = await restart(h);
		const r = await engine.recover(SID);
		expect(r).toMatchObject({
			ok: true,
			body: { outcome: { kind: "rolled-back" }, retained: { containerId: O_ID, role: "O" } },
		});
		expect(h.docker.containers.get(nId)?.name).toBe(CANONICAL);
		expect(h.docker.containers.get(O_ID)?.name).toMatch(RESERVED_NAME_RE);
		expect(h.d1.row.container_id).toBe(nId);
		expect(h.docker.containers.has(O_ID)).toBe(true);
		await expect(attempts.assertResolved(SID)).resolves.toBeUndefined();
		// The way back is still open.
		expect((await engine.rollbackToRetained(SID)).ok).toBe(true);
		expect(h.d1.row.container_id).toBe(O_ID);
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

// ── backupFreshIn: a consistent recovery point ─────────────────────────────

describe("backupFreshIn (§2.7.7 backup-stale)", () => {
	const manifest = async (root: string, name: string, m: Record<string, unknown>) => {
		await fs.mkdir(path.join(root, ".backups", name), { recursive: true });
		await fs.writeFile(path.join(root, ".backups", name, "manifest.json"), JSON.stringify(m));
	};
	it("fresh, after the stop, without concurrent changes ⇒ true; otherwise false", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "st-bk-"));
		roots.push(root);
		const now = Date.parse("2026-10-31T12:00:00Z");
		const at = (iso: string) => ({
			createdAt: iso,
			workspaces: { [SID]: { fileCount: 1, tarBytes: 1 } },
		});
		const stoppedAt = "2026-10-31T11:00:00Z";
		expect(await backupFreshIn(root, SID, 86_400_000, () => now, stoppedAt)).toBe(false); // nothing
		await manifest(root, "old", at("2026-10-29T12:00:00Z")); // > 24 h
		await manifest(root, "before-stop", at("2026-10-31T10:59:00Z")); // taken while O ran
		await manifest(root, "other", { createdAt: "2026-10-31T11:30:00Z", workspaces: { other: {} } });
		await manifest(root, "concurrent", {
			createdAt: "2026-10-31T11:40:00Z",
			workspaces: {
				[SID]: { fileCount: 1, tarBytes: 1, concurrentChanges: { count: 2, paths: [] } },
			},
		});
		await manifest(root, "garbage", { createdAt: 5 });
		await fs.writeFile(path.join(root, ".backups", "not-a-dir"), "x");
		expect(await backupFreshIn(root, SID, 86_400_000, () => now, stoppedAt)).toBe(false);
		await manifest(root, "good", at("2026-10-31T11:05:00Z"));
		expect(await backupFreshIn(root, SID, 86_400_000, () => now, stoppedAt)).toBe(true);
		// Without a stop time (O never ran), only age and consistency count.
		expect(await backupFreshIn(root, SID, 86_400_000, () => now, null)).toBe(true);
	});
});
