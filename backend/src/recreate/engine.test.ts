/**
 * recreate/engine.ts against a fake Docker that can hold, fail or apply
 * late any request, a fake D1, and the REAL attempt store and lifecycle
 * lock (CONVERSATION.md §2.7.2–§2.7.4, §10 3.0d "Recreación").
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecreateAttemptStore, RecreateUnresolvedError } from "../recreateAttempt.js";
import { RecreationEngine } from "./engine.js";
import {
	CANONICAL,
	deferred,
	FAST,
	harness,
	httpError,
	IMG_N,
	O_ID,
	SID,
	stateOf,
} from "./engine.testutil.js";
import { LABEL_ATTEMPT, LABEL_SESSION, RESERVED_NAME_RE } from "./ports.js";

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

// ── Preconditions ──────────────────────────────────────────────────────────

describe("preconditions (§2.7.2): first failure ⇒ 409 with its code, no effects", () => {
	const cases: Array<[string, (h: H) => Promise<void> | void]> = [
		[
			"no-container",
			(h) => {
				h.d1.row.container_id = null;
			},
		],
		[
			"no-container",
			(h) => {
				h.d1.row.status = "terminated";
			},
		],
		["container-missing", (h) => void h.docker.containers.delete(O_ID)],
		[
			"running",
			(h) => {
				(h.docker.containers.get(O_ID) as { running: boolean }).running = true;
			},
		],
		[
			"image-changed",
			(h) => {
				h.docker.current = { imageId: "sha256:moved", relay2: true };
			},
		],
		[
			"image-changed",
			(h) => {
				h.docker.current = null;
			},
		],
		[
			"image-without-relay",
			(h) => {
				h.docker.current = { imageId: IMG_N, relay2: false };
			},
		],
		[
			"flag-off",
			(h) => {
				h.capture.enabled = false;
			},
		],
		[
			"not-requested",
			(h) => {
				h.d1.row.conversation_requested = 0;
			},
		],
		[
			"revoked",
			(h) => {
				h.capture.revocation = "session";
			},
		],
		[
			"layer-home",
			(h) =>
				void h.docker.changesOf.set(O_ID, [{ Path: "/home/developer/.bash_history", Kind: 1 }]),
		],
		[
			"layer-dotfiles",
			(h) => {
				h.d1.config.hasDotfiles = true;
			},
		],
		[
			"workspace-cli-missing",
			async (h) => fs.rm(path.join(h.root, SID, ".npm-global"), { recursive: true }),
		],
		[
			"workspace-legacy-layout",
			async (h) => {
				await fs.mkdir(path.join(h.root, SID, ".claude/projects"), { recursive: true });
			},
		],
		[
			"managed-skills-customized",
			(h) =>
				void h.workspaceSkills.set("delegate-task/SKILL.md", {
					kind: "file",
					data: Buffer.from("mine"),
				}),
		],
	];
	for (const [code, arrange] of cases) {
		it(code, async () => {
			const h = await setup();
			await arrange(h);
			const before = stateOf(h);
			const r = await h.engine.recreate(SID, IMG_N);
			expect(r).toMatchObject({ ok: false, status: 409, code });
			expect(h.docker.mutations()).toEqual([]);
			expect(h.capture.calls).toEqual([]);
			expect(await recordOf(h)).toBeNull();
			expect(stateOf(h)).toEqual(before);
		});
	}

	it("the preflight reports every blocker at once, with the same calculation and no effects", async () => {
		const h = await setup();
		h.d1.row.conversation_requested = 0;
		h.docker.changesOf.set(O_ID, [{ Path: "/home/developer/.bash_history", Kind: 1 }]);
		const p = await h.engine.preflight(SID);
		expect(p).toEqual({
			recreatable: false,
			blockers: [{ code: "not-requested" }, { code: "layer-home", count: 1 }],
			imageId: "sha256:imageO",
			currentImageId: IMG_N,
			captureAfter: false,
		});
		expect(h.docker.mutations()).toEqual([]);
		expect(await (await setup()).engine.preflight(SID)).toMatchObject({
			recreatable: true,
			blockers: [],
			captureAfter: true,
		});
	});

	it("tag moved between the preflight and the POST ⇒ image-changed", async () => {
		const h = await setup();
		const p = (await h.engine.preflight(SID)) as { currentImageId: string };
		h.docker.current = { imageId: "sha256:newer", relay2: true };
		expect(await h.engine.recreate(SID, p.currentImageId)).toMatchObject({ code: "image-changed" });
	});

	it("a hung Docker read before begin() ⇒ 503, still no effects and no record", async () => {
		const h = await setup({ preconditionMs: 30 });
		h.docker.hooks.set("changes", () => new Promise(() => {}));
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({ status: 503 });
		expect(await recordOf(h)).toBeNull();
	});

	it("O vanishing between its inspect and a later read ⇒ container-missing (409), not a raw error", async () => {
		for (const op of ["changes", "statPath", "readArchive"] as const) {
			const h = await setup();
			h.docker.hooks.set(op, () => {
				h.docker.containers.delete(O_ID);
				throw httpError(404);
			});
			expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({
				ok: false,
				status: 409,
				code: "container-missing",
			});
			expect(await h.engine.preflight(SID)).toMatchObject({
				recreatable: false,
				blockers: [{ code: "container-missing" }],
			});
			expect(h.docker.mutations()).toEqual([]);
			expect(await recordOf(h)).toBeNull();
		}
	});

	it("busy: another lifecycle op holds the lock ⇒ 409 busy without waiting or effects", async () => {
		const h = await setup();
		const hold = deferred();
		const holder = h.lock.run(SID, "stop", () => hold.promise);
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({ status: 409, code: "busy" });
		hold.resolve();
		await holder;
		expect(h.docker.mutations()).toEqual([]);
	});
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe("successful recreation (K1.3: the attempt acts under its own lock and epoch)", () => {
	it("commits N with H, completes step 6 and resolves committed", async () => {
		const h = await setup();
		h.docker.gitconfig.set(O_ID, "[user]\n\tname = Ada\n\temail = a@x\n");
		h.d1.config.gitIdentity = { name: "Ada", email: "a@x" };
		h.docker.changesOf.set(O_ID, [{ Path: "/home/developer/.gitconfig", Kind: 1 }]);
		h.d1.config.postStartCmd = "npm run dev";
		const r = await h.engine.recreate(SID, IMG_N);
		const nId = nIdOf(h) as string;
		expect(r).toMatchObject({
			ok: true,
			outcome: "committed",
			nContainerId: nId,
			cliVersion: "2.1.310",
			warnings: [],
			incomplete: [],
		});
		expect(r).not.toHaveProperty("unresolved");
		// D1: container and hash together; status running.
		expect(h.d1.row).toMatchObject({
			container_id: nId,
			ingest_token_hash: "H-new",
			status: "running",
		});
		// Docker: O removed, N canonical, created from the checked image ID, never O's name stolen.
		expect([...h.docker.containers.keys()]).toEqual([nId]);
		expect(h.docker.containers.get(nId)).toMatchObject({
			name: CANONICAL,
			running: true,
			imageId: IMG_N,
			labels: { [LABEL_SESSION]: SID, [LABEL_ATTEMPT]: (await recordOf(h))?.attemptId },
		});
		// Step 5 ran with the epoch open (no recreate-unresolved), seeding only in 6.2, once.
		expect(h.capture.calls).toEqual(["prepare", "authorize(epochOpen=true)", "removeDeferSeed"]);
		const seeds = h.docker.execs.filter((e) => e[1] === "/opt/st/seed-skills.sh");
		expect(seeds).toHaveLength(1);
		expect(h.capture.deferSeed).toBe(false);
		// gitIdentity re-applied; postStart launched detached.
		expect(h.docker.execs.some((e) => e.includes("user.email") && e.includes("a@x"))).toBe(true);
		expect(h.docker.execs.some((e) => e.includes("npm run dev"))).toBe(true);
		const rec = await recordOf(h);
		expect(rec).toMatchObject({
			state: "resolved",
			outcome: { kind: "committed", nContainerId: nId },
		});
		expect(JSON.stringify(rec)).not.toContain("H-new");
		expect(h.engine.unresolvedSessions()).toEqual([]);
	});

	it("a concurrent lifecycle op waits for the lock and then acts on the final state", async () => {
		const h = await setup();
		const startGate = deferred();
		h.docker.hooks.set("start", () => startGate.promise);
		const rec = h.engine.recreate(SID, IMG_N);
		await tick(20);
		let seen: string | null = null;
		const other = h.lock.run(SID, "stop", async () => {
			seen = h.d1.row.container_id;
		});
		await tick(20);
		expect(seen).toBeNull(); // waiting, not acting
		startGate.resolve();
		await rec;
		await other;
		expect(seen).toBe(nIdOf(h));
	});

	it("a CLI below the minimum is reported, capture stays active", async () => {
		const h = await setup();
		const exec = h.docker.exec.bind(h.docker);
		h.docker.exec = async (cid, cmd, t) =>
			cmd[0] === "claude" ? { exitCode: 0, stdout: "2.1.100\n" } : exec(cid, cmd, t);
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({
			ok: true,
			warnings: ["cli-below-minimum"],
		});
	});
});

// ── begin() ────────────────────────────────────────────────────────────────

describe("a refused begin() stops everything", () => {
	it("a disk error in begin(): no Docker effect, no capture prep, nothing to resolve but itself", async () => {
		const h = await setup();
		vi.spyOn(h.attempts, "begin").mockRejectedValueOnce(new Error("EIO"));
		const resolve = vi.spyOn(h.attempts, "resolve");
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ status: 500, step: "record" });
		expect(h.docker.mutations()).toEqual([]);
		expect(h.capture.calls).toEqual([]);
		// The only resolve() is the one for the attempt that issued nothing.
		expect(resolve.mock.calls.every((c) => c[2].kind === "rolled-back")).toBe(true);
	});
	it("an unreadable previous record ⇒ recreate-unresolved before any effect", async () => {
		const h = await setup();
		await fs.mkdir(path.dirname(h.attempts.recordPath(SID)), { recursive: true });
		await fs.writeFile(h.attempts.recordPath(SID), "{not json");
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({ code: "recreate-unresolved" });
		expect(h.docker.mutations()).toEqual([]);
	});
});

// ── Resolved rollbacks ─────────────────────────────────────────────────────

describe("resolved rollback: a definitive failure in steps 1–4 ⇒ the previous state exactly", () => {
	const failures: Array<[string, string, (h: H) => void]> = [
		[
			"create fails",
			"prepare",
			(h) => h.docker.hooks.set("create", () => Promise.reject(httpError(500))),
		],
		[
			"rename of O fails",
			"rename",
			(h) =>
				h.docker.hooks.set("rename", (a) => {
					if (a[0] === O_ID && String(a[1]).includes("-old-")) throw httpError(500);
				}),
		],
		[
			"rename of N fails",
			"rename",
			(h) =>
				h.docker.hooks.set("rename", (a) => {
					if (a[0] !== O_ID && a[1] === CANONICAL) throw httpError(500);
				}),
		],
		[
			"start of N fails",
			"start",
			(h) => h.docker.hooks.set("start", () => Promise.reject(httpError(500))),
		],
		[
			"N never ready",
			"start",
			(h) => {
				const exec = h.docker.exec.bind(h.docker);
				h.docker.exec = async (cid, cmd, t) =>
					cmd[0] === "test" ? { exitCode: 1, stdout: "" } : exec(cid, cmd, t);
			},
		],
		[
			"CAS matches 0 rows",
			"commit",
			(h) => {
				h.d1.casMode = "rejected";
			},
		],
		[
			"a disable flipped requested=0 before the CAS",
			"commit",
			(h) =>
				h.docker.hooks.set("start", () => {
					h.d1.row.conversation_requested = 0;
				}),
		],
	];
	for (const [label, step, arrange] of failures) {
		it(`${label} ⇒ 500 recreate-failed {step:${step}} without unresolved`, async () => {
			const h = await setup();
			arrange(h);
			const before = stateOf(h);
			const r = await h.engine.recreate(SID, IMG_N);
			expect(r).toEqual({ ok: false, status: 500, code: "recreate-failed", step });
			const after = stateOf(h);
			if (label.startsWith("a disable")) {
				expect(after).toEqual({ ...before, row: { ...before.row, conversation_requested: 0 } });
			} else {
				expect(after).toEqual(before);
			}
			expect(await recordOf(h)).toMatchObject({
				state: "resolved",
				outcome: { kind: "rolled-back" },
			});
			expect(h.engine.unresolvedSessions()).toEqual([]);
		});
	}

	it("`docker start` of O between steps 2 and 3 ⇒ rollback without ever starting N", async () => {
		const h = await setup();
		h.docker.hooks.set("rename", (a) => {
			if (a[1] === CANONICAL)
				(h.docker.containers.get(O_ID) as { running: boolean }).running = true;
		});
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ status: 500, step: "start" });
		expect(r).not.toHaveProperty("unresolved");
		expect(h.docker.log.some((l) => l.startsWith("start:"))).toBe(false);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
	});

	it("a collision only in N's image ⇒ blocked in step 1, rolled back, all skills untouched", async () => {
		const h = await setup();
		h.docker.skillsByImage.set(IMG_N, {
			"delegate-task/SKILL.md": "v2",
			"new-skill/SKILL.md": "n",
		});
		h.workspaceSkills.set("new-skill/SKILL.md", { kind: "file", data: Buffer.from("user's own") });
		const before = stateOf(h);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ status: 409, code: "managed-skills-collision", step: "prepare" });
		expect(stateOf(h)).toEqual(before);
		expect(h.docker.execs.filter((e) => e[1] === "/opt/st/seed-skills.sh")).toEqual([]);
	});

	it("an O created by 3.0d gets its marker and hooks file back; a disable meanwhile wins", async () => {
		for (const disable of [false, true]) {
			const h = await setup();
			(h.docker.containers.get(O_ID) as { mounts: string[] }).mounts.push("/etc/st-control");
			h.capture.marker = true;
			h.capture.hooksFile = true;
			h.d1.casMode = "rejected";
			if (disable) {
				h.docker.hooks.set("start", () => {
					h.capture.revocation = "session";
				});
			}
			await h.engine.recreate(SID, IMG_N);
			expect([h.capture.marker, h.capture.hooksFile]).toEqual(
				disable ? [false, false] : [true, true],
			);
		}
	});
});

// ── Unresolved rollbacks ───────────────────────────────────────────────────

describe("unresolved rollback ⇒ 500 {unresolved:true}, marker kept, session gated, resolved only on evidence", () => {
	it("remove(N) fails ⇒ unresolved; once it succeeds the retry resolves rolled-back", async () => {
		const h = await setup();
		h.d1.casMode = "rejected";
		let removable = false;
		h.docker.hooks.set("remove", () => {
			if (!removable) throw httpError(500, "device busy");
		});
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toEqual({
			ok: false,
			status: 500,
			code: "recreate-failed",
			step: "commit",
			unresolved: true,
		});
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		expect(h.capture.deferSeed).toBe(true);
		expect(h.d1.row.container_id).toBe(O_ID);
		// Gated: every lifecycle verb, a second recreate, and the preflight say so.
		for (const op of ["start", "stop", "kill", "delete"] as const) {
			await expect(h.lock.run(SID, op, async () => "ran")).rejects.toBeInstanceOf(
				RecreateUnresolvedError,
			);
		}
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({ code: "recreate-unresolved" });
		expect(await h.engine.preflight(SID)).toMatchObject({
			recreatable: false,
			blockers: expect.arrayContaining([{ code: "recreate-unresolved" }]),
		});
		removable = true;
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(await recordOf(h)).toMatchObject({ outcome: { kind: "rolled-back" } });
		expect(h.capture.deferSeed).toBe(false);
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect([...h.docker.containers.keys()]).toEqual([O_ID]);
	});

	it("remove(N) hangs ⇒ the lock is released at T_rb, unresolved until dockerd answers", async () => {
		const h = await setup();
		h.d1.casMode = "rejected";
		const gate = deferred();
		h.docker.hooks.set("remove", () => gate.promise);
		const t0 = Date.now();
		const r = await h.engine.recreate(SID, IMG_N);
		expect(Date.now() - t0).toBeLessThan((FAST.tRecMs as number) + (FAST.tRbMs as number) + 200);
		expect(r).toMatchObject({ unresolved: true });
		expect(h.lock.heldBy(SID)).toBeNull();
		await tick(100);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		gate.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(h.capture.deferSeed).toBe(false);
	});

	it("N still present after remove answered ⇒ not confirmed, keeps retrying", async () => {
		const h = await setup();
		h.d1.casMode = "rejected";
		const real = h.docker.remove.bind(h.docker);
		let lying = true;
		h.docker.remove = async (id) => {
			if (!lying) return real(id);
		};
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({ unresolved: true });
		await tick(150);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		expect(h.capture.deferSeed).toBe(true);
		lying = false;
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
	});
});

// ── Late answers (K1) ──────────────────────────────────────────────────────

describe("late answers: no write of the recreation after the epoch closed", () => {
	it("create answering after T_rec and T_rb ⇒ N found by label and removed; marker retired only then; never started", async () => {
		const h = await setup({ tRecMs: 100, tRbMs: 100 });
		const gate = deferred();
		h.docker.hooks.set("create", () => gate.promise);
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({
			step: "prepare",
			unresolved: true,
		});
		expect(h.capture.deferSeed).toBe(true);
		gate.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect([...h.docker.containers.keys()]).toEqual([O_ID]);
		expect(h.docker.log.some((l) => l.startsWith("start:") || l.startsWith("rename:"))).toBe(false);
		expect(h.capture.deferSeed).toBe(false);
	});

	it("rename applying late ⇒ the resolution uses the names it observes", async () => {
		const h = await setup({ tRecMs: 100, tRbMs: 100 });
		const gate = deferred();
		h.docker.hooks.set("rename", async (a) => {
			if (a[0] === O_ID && String(a[1]).includes("-old-")) await gate.promise;
		});
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({ step: "rename", unresolved: true });
		gate.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(h.docker.containers.get(O_ID)?.name).toBe(CANONICAL);
		expect([...h.docker.containers.keys()]).toEqual([O_ID]);
	});

	it("a hung step 3 closes the epoch; rollback once what was in flight answers", async () => {
		const h = await setup({ tRecMs: 120, tRbMs: 400 });
		const gate = deferred();
		h.docker.hooks.set("start", () => gate.promise);
		const p = h.engine.recreate(SID, IMG_N);
		await tick(200);
		gate.resolve(); // start applies late: N runs, but nothing continues from it
		const r = await p;
		expect(r).toEqual({ ok: false, status: 500, code: "recreate-failed", step: "start" });
		expect(h.d1.writes).not.toContain("cas");
		expect([...h.docker.containers.keys()]).toEqual([O_ID]);
	});

	it("CAS applied after the client timed out ⇒ N is never removed; after T_d1 it converges on N", async () => {
		const h = await setup();
		h.d1.casMode = "ambiguous-applied";
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toEqual({
			ok: false,
			status: 500,
			code: "recreate-failed",
			step: "commit",
			unresolved: true,
		});
		const nId = nIdOf(h) as string;
		expect(h.docker.containers.has(nId)).toBe(true);
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(await recordOf(h)).toMatchObject({ outcome: { kind: "committed", nContainerId: nId } });
		expect([...h.docker.containers.keys()]).toEqual([nId]);
		expect(h.d1.row).toMatchObject({ container_id: nId, status: "running" });
		expect(h.capture.deferSeed).toBe(false);
		expect(h.capture.calls).toContain("converge");
	});

	it("ambiguous CAS that did not apply ⇒ after T_d1, a resolved rollback", async () => {
		const h = await setup();
		h.d1.casMode = "ambiguous-not";
		await h.engine.recreate(SID, IMG_N);
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(await recordOf(h)).toMatchObject({ outcome: { kind: "rolled-back" } });
		expect(h.d1.row.container_id).toBe(O_ID);
		expect([...h.docker.containers.keys()]).toEqual([O_ID]);
	});

	it("a disable landing during an ambiguous CAS is never overwritten", async () => {
		const h = await setup();
		h.d1.casMode = "ambiguous-not";
		h.docker.hooks.set("start", () => {
			h.d1.row.conversation_requested = 0;
		});
		await h.engine.recreate(SID, IMG_N);
		h.d1.casMode = "normal";
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(h.d1.row).toMatchObject({ container_id: O_ID, conversation_requested: 0 });
	});

	it("hangs after the commit (probe, seed): abandoned at T_rec, no op waits longer, resolved committed on the answer", async () => {
		const h = await setup({ tRecMs: 250, tRbMs: 100 });
		const gate = deferred();
		h.docker.hooks.set("exec", async (a) => {
			if (String(a[1]).includes("seed-skills")) await gate.promise;
		});
		const t0 = Date.now();
		const r = await h.engine.recreate(SID, IMG_N);
		expect(Date.now() - t0).toBeLessThan(250 + 100 + 200);
		expect(r).toMatchObject({ ok: true, outcome: "committed", unresolved: true });
		expect((r as { incomplete: string[] }).incomplete).toEqual(
			expect.arrayContaining(["seed-skills", "remove O"]),
		);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		const execsAtTimeout = h.docker.execs.length;
		gate.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		expect(await recordOf(h)).toMatchObject({ outcome: { kind: "committed" } });
		// The late seed's continuation did nothing more (no gitIdentity, postStart, version, no O removal by it):
		// only the resolution's own O removal happened.
		expect(
			h.docker.execs.slice(execsAtTimeout).filter((e) => e[1] !== "/opt/st/seed-skills.sh"),
		).toEqual([]);
		expect(h.docker.containers.has(O_ID)).toBe(false);
	});

	it("dockerd never answering ⇒ uncertain indefinitely (no time-based resolution)", async () => {
		const h = await setup({ tRecMs: 80, tRbMs: 80 });
		h.docker.hooks.set("create", () => new Promise(() => {}));
		await h.engine.recreate(SID, IMG_N);
		await tick(400);
		expect(await recordOf(h)).toMatchObject({ state: "uncertain" });
		expect(h.capture.deferSeed).toBe(true);
		h.engine.stop();
	});
});

// ── Restart (D8) and the boot pass ─────────────────────────────────────────

describe("backend restart with an attempt open or uncertain (D8: fail-closed)", () => {
	it("stays recreate-unresolved; no scan, no time and no answer resolves it", async () => {
		const h = await setup({ tRecMs: 80, tRbMs: 80 });
		const gate = deferred<void>();
		h.docker.hooks.set("create", () => gate.promise);
		await h.engine.recreate(SID, IMG_N);
		h.engine.stop();
		// "Restart": a new store and engine over the same disk and Docker.
		const attempts = new RecreateAttemptStore(h.root);
		await attempts.recoverOnBoot();
		const lock = new (
			h.lock.constructor as typeof import("../sessionLifecycleLock.js").SessionLifecycleLock
		)();
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
		gate.resolve(); // the old create lands now: N appears, labelled
		await tick(50);
		await engine.bootPass();
		await tick(100);
		const rec = (await attempts.read(SID)) as {
			kind: "ok";
			record: { state: string; orphanedAt?: string };
		};
		expect(rec.record.state).toBe("uncertain");
		expect(rec.record.orphanedAt).toBeTruthy();
		expect(nIdOf(h)).not.toBeNull(); // N untouched
		expect(h.capture.deferSeed).toBe(true); // skill seeding stays deferred
		expect(h.d1.row.container_id).toBe(O_ID); // D1 on an existing container
		expect(await engine.recreate(SID, IMG_N)).toMatchObject({ code: "recreate-unresolved" });
		await expect(lock.run(SID, "start", async () => 1)).rejects.toBeInstanceOf(
			RecreateUnresolvedError,
		);
	});
});

describe("the boot pass", () => {
	it("the committed N is never a leftover, across restarts and stop/start; a real leftover is removed unstarted", async () => {
		const h = await setup();
		await h.engine.recreate(SID, IMG_N);
		const nId = nIdOf(h) as string;
		const attemptId = (await recordOf(h))?.attemptId as string;
		for (let i = 0; i < 3; i++) {
			await h.engine.bootPass();
			(h.docker.containers.get(nId) as { running: boolean }).running = i % 2 === 0;
		}
		expect(h.docker.containers.has(nId)).toBe(true);
		// A real leftover: same attempt label, another id, never started.
		h.docker.containers.set("x".repeat(64), {
			id: "x".repeat(64),
			name: `${CANONICAL}-new-1`,
			running: false,
			imageId: IMG_N,
			labels: { [LABEL_SESSION]: SID, [LABEL_ATTEMPT]: attemptId },
			mounts: [],
			starts: 0,
		});
		// One labelled by an attempt this session never resolved: not touched.
		h.docker.containers.set("y".repeat(64), {
			id: "y".repeat(64),
			name: "other",
			running: false,
			imageId: IMG_N,
			labels: { [LABEL_SESSION]: SID, [LABEL_ATTEMPT]: "unknown-attempt" },
			mounts: [],
			starts: 0,
		});
		await h.engine.bootPass();
		expect(h.docker.containers.has("x".repeat(64))).toBe(false);
		expect(h.docker.containers.has("y".repeat(64))).toBe(true);
		expect(h.docker.containers.has(nId)).toBe(true);
		expect(h.engine.stats.leftoversRemoved).toBe(1);
	});

	it("a residual defer-skill-seed of a committed attempt is retired, seeding a running N", async () => {
		const h = await setup();
		await h.engine.recreate(SID, IMG_N);
		h.capture.deferSeed = true;
		const seedsBefore = h.docker.execs.filter((e) => e[1] === "/opt/st/seed-skills.sh").length;
		await h.engine.bootPass();
		expect(h.capture.deferSeed).toBe(false);
		expect(h.docker.execs.filter((e) => e[1] === "/opt/st/seed-skills.sh").length).toBe(
			seedsBefore + 1,
		);
	});
});

describe("reserved names (§2.7.4)", () => {
	it("an -old- container of a D1 session is reviewed and left alone; non-matching names are ignored", async () => {
		const h = await setup();
		const c = (id: string, name: string) =>
			h.docker.containers.set(id, {
				id,
				name,
				running: false,
				imageId: IMG_N,
				labels: {},
				mounts: [],
				starts: 0,
			});
		c("p".repeat(64), `${CANONICAL}-old-123`);
		c("q".repeat(64), `${CANONICAL}-old-123x`);
		c("r".repeat(64), "st-ffffffff-fff-old-1");
		await h.engine.bootPass();
		expect(h.engine.stats.reservedNamesSeen).toBe(1);
		expect(h.docker.containers.size).toBe(4);
	});
	it("the pattern follows real names: the 12-char prefix keeps the UUID's dash", () => {
		expect(RESERVED_NAME_RE.test(`${CANONICAL}-new-1700000000000`)).toBe(true);
		expect(RESERVED_NAME_RE.test(`st-${"a".repeat(12)}-old-1`)).toBe(false);
	});
});
