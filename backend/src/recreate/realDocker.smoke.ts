/**
 * realDocker.smoke.ts — the recreation engine against a REAL dockerd and
 * the real session image (CONVERSATION.md §2.7, §10 3.0d). Run by the
 * Session Image workflow:
 *
 *   cd backend && npx tsx src/recreate/realDocker.smoke.ts <image>
 *
 * Isolated: a fresh session id, a temp WORKSPACE_ROOT, only containers it
 * creates (named `st-<sid12>…` and labelled with that id), all removed on
 * exit. D1 is an in-memory row; everything else is real — DockerManager's
 * recreation port, `docker diff`, archive reads, renames, the image's
 * entrypoint with `defer-skill-seed`, its relay supervisor and status
 * endpoint, `seed-skills.sh`, the attempt record and the lifecycle lock.
 *
 * What only a real daemon can show, and is checked here:
 *   - a clean boot's `docker diff` passes the layer check, and real user
 *     state (`~/.bash_history`, a foreign `~/.gitconfig`) blocks it;
 *   - archive stat/tar reads of a stopped container (skills, gitconfig);
 *   - N boots twice before the commit with `defer-skill-seed` and does not
 *     seed; a rollback leaves the skills byte for byte and no N behind;
 *   - a manual `docker start` of O between steps 2 and 3 aborts before N
 *     is started;
 *   - the full path: N from the checked image ID, the relay identified and
 *     the hooks file written (effective:true), seeding exactly once;
 *   - the committed N survives boot passes and stop/start; a real leftover
 *     is removed without being started.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Dockerode from "dockerode";

const IMAGE = process.argv[2] ?? "shared-terminal-session";
const SID = randomUUID();
const ROOT = path.join(os.tmpdir(), `st-recreate-smoke-${process.pid}`);
process.env.WORKSPACE_ROOT = ROOT;
process.env.SESSION_IMAGE = IMAGE;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

const docker = new Dockerode();
const CANONICAL = `st-${SID.slice(0, 12)}`;
const WS = path.join(ROOT, SID);
const UPLOADS = path.join(ROOT, ".uploads", SID);
const SKILL = path.join(WS, ".st/claude-state/skills/delegate-task/SKILL.md");
let failures = 0;

function check(what: string, ok: boolean, detail?: unknown): void {
	if (ok) console.log(`  ok: ${what}`);
	else {
		failures++;
		console.error(`  FAIL: ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
function phase(name: string): void {
	console.log(`\n── ${name} ──`);
}

async function exec(id: string, cmd: string): Promise<number> {
	const e = await docker.getContainer(id).exec({
		Cmd: ["bash", "-c", cmd],
		AttachStdout: true,
		AttachStderr: true,
	});
	const s = await e.start({});
	await new Promise<void>((r) => {
		s.on("end", () => r());
		s.on("close", () => r());
		s.resume();
	});
	return (await e.inspect()).ExitCode ?? -1;
}

async function waitReady(id: string): Promise<void> {
	for (let i = 0; i < 120; i++) {
		if ((await exec(id, "test -f /tmp/.st-ready")) === 0) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("container never became ready");
}

/** Stop, tolerating "already stopped" (304) so one failed check doesn't abort the rest. */
async function stopIfRunning(id: string): Promise<void> {
	await docker
		.getContainer(id)
		.stop()
		.catch((err: { statusCode?: number }) => {
			if (err.statusCode !== 304) throw err;
		});
}

async function withO<T>(oId: string, fn: () => Promise<T>): Promise<T> {
	await docker.getContainer(oId).start();
	await waitReady(oId);
	try {
		return await fn();
	} finally {
		await stopIfRunning(oId);
	}
}

async function exists(p: string): Promise<boolean> {
	return fs.lstat(p).then(
		() => true,
		() => false,
	);
}

async function cleanup(): Promise<void> {
	const mine = await docker.listContainers({ all: true });
	for (const c of mine) {
		const name = (c.Names?.[0] ?? "").replace(/^\//, "");
		if (name.startsWith(CANONICAL) || c.Labels?.["io.shared-terminal.session"] === SID) {
			await docker
				.getContainer(c.Id)
				.remove({ force: true })
				.catch(() => undefined);
		}
	}
	// uid-1000 files from the containers: remove them from a root container.
	await docker
		.run(IMAGE, ["bash", "-c", "rm -rf /t/* /t/.[!.]* 2>/dev/null; true"], process.stdout, {
			User: "0",
			Entrypoint: [],
			HostConfig: { Binds: [`${ROOT}:/t`], AutoRemove: true },
		})
		.catch(() => undefined);
	await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
}

async function main(): Promise<void> {
	// Imported after WORKSPACE_ROOT is set: these modules read it at load.
	const { DockerManager, buildContainerEnv } = await import("../dockerManager.js");
	const { RecreateAttemptStore } = await import("../recreateAttempt.js");
	const { SessionLifecycleLock } = await import("../sessionLifecycleLock.js");
	const { RecreationEngine } = await import("./engine.js");
	const activation = await import("../conversation/activation.js");
	const cap = await import("../conversation/captureAuth.js");
	const { checkRevocation } = await import("../conversation/revocation.js");
	const { LABEL_ATTEMPT, LABEL_SESSION } = await import("./ports.js");
	type SessionManager = import("../sessionManager.js").SessionManager;
	type RecreateCapturePort = import("./engine.js").RecreateCapturePort;
	type RecreateD1Port = import("./d1.js").RecreateD1Port;

	await fs.mkdir(WS, { recursive: true });
	await fs.chmod(WS, 0o777);
	await fs.mkdir(UPLOADS, { recursive: true });

	// ── O: an ordinary pre-3.0d session container ─────────────────────────
	phase("O: booted once, stopped");
	const o = await docker.createContainer({
		Image: IMAGE,
		name: CANONICAL,
		HostConfig: {
			Binds: [`${WS}:/home/developer/workspace`, `${UPLOADS}:/home/developer/uploads:ro`],
			Init: true,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges:true"],
		},
		OpenStdin: true,
		Tty: true,
	});
	const O = o.id;
	await withO(O, async () => undefined);
	check("O seeded the managed skill on its boot (W = I_O)", await exists(SKILL));

	// ── The engine over the real port, D1 in memory ──────────────────────
	const dm = new DockerManager({} as SessionManager);
	const real = dm.recreatePort();
	const imageId = (await docker.getImage(IMAGE).inspect()).Id;
	const row = {
		status: "stopped",
		container_id: O as string | null,
		container_name: CANONICAL,
		conversation_requested: 1,
		ingest_token_hash: null as string | null,
		ingest_token_hash_suspended: null as string | null,
		user_id: "u1",
	};
	let casMode: "normal" | "rejected" = "normal";
	let gitIdentity: { name: string; email: string } | null = null;
	const d1: RecreateD1Port = {
		getRow: async () => ({ ...row }),
		sessionIdByContainerName: async (name) => (name === CANONICAL ? SID : null),
		cas: async (_s, oId, nId, h) => {
			if (casMode === "rejected" || row.container_id !== oId || row.conversation_requested !== 1) {
				return "not-applied";
			}
			row.container_id = nId;
			row.ingest_token_hash = h;
			return "applied";
		},
		getConfig: async () => ({ ports: [], gitIdentity, hasDotfiles: false, postStartCmd: null }),
		setStatus: async (_s, st) => {
			row.status = st;
		},
		setPorts: async () => undefined,
	};
	const deps = { workspaceRoot: ROOT, enabled: true, port: 3001 };
	const captureDocker = {
		inspectCapture: (cid: string) => dm.inspectCapture(cid),
		currentImage: () => dm.currentSessionImage(),
		probeRelay: (s: string, cid: string) => dm.probeRelay(s, cid),
	};
	const capture: RecreateCapturePort = {
		enabled: true,
		checkRevocation: (s) => checkRevocation(ROOT, s),
		prepare: (s) => activation.prepareRecreateCapture(deps, s),
		snapshot: async () => ({ marker: false, hooksFile: false }),
		restore: async () => undefined,
		authorize: async (s, run) => {
			const authority = new cap.CaptureAuthority({
				workspaceRoot: ROOT,
				enabled: true,
				docker: {
					inspectCapture: (cid) => run.call("inspect N", () => captureDocker.inspectCapture(cid)),
					currentImage: () => run.call("image", () => captureDocker.currentImage()),
					probeRelay: (x, cid) => run.call("probe", () => captureDocker.probeRelay(x, cid)),
				},
				getRow: async () => ({ ...row }),
				checkRevocation: (x) => checkRevocation(ROOT, x),
				isRecreateUnresolved: async () => false,
				writeHooksFile: (x) => activation.writeHooksFile(deps, x),
				removeHooksFile: (x) => activation.removeHooksFile(ROOT, x),
				hooksFileExists: (x) => activation.hooksFileExists(ROOT, x),
				mayWrite: () => run.epochOpen,
			});
			const w = await authority.applyWriteDetailed(s);
			console.log(`  · step 5 write procedure: ${w.outcome}`);
			return authority.capture(s, { identified: w.identified });
		},
		converge: async () => undefined,
		deferSeedExists: (s) => cap.deferSeedExists(ROOT, s),
		removeDeferSeed: (s) => cap.removeDeferSeed(ROOT, s),
	};
	// N's create options: the same shape a spawn uses (asserted equal to the
	// spawn's in dockerManager.spawnConfig.test.ts); here without D1.
	const hooks: { afterRenameN?: () => Promise<void>; onReadiness?: (id: string) => Promise<void> } =
		{};
	const starts: string[] = [];
	const port = {
		...real,
		buildCreate: async (_s: string, spec: Parameters<typeof real.buildCreate>[1]) => ({
			Image: spec.imageId,
			name: spec.name,
			Labels: spec.labels,
			// The spawn's own env builder: SESSION_ID/SESSION_NAME plus the
			// capture entries (the relay refuses to start without SESSION_ID).
			Env: buildContainerEnv(SID, "recreate-smoke", [], spec.env),
			HostConfig: {
				Binds: [
					`${WS}:/home/developer/workspace`,
					`${UPLOADS}:/home/developer/uploads:ro`,
					...spec.binds,
				],
				Init: true,
				CapDrop: ["ALL"],
				SecurityOpt: ["no-new-privileges:true"],
			},
			OpenStdin: true,
			Tty: true,
		}),
		rename: async (id: string, name: string) => {
			await real.rename(id, name);
			if (name === CANONICAL && id !== O) await hooks.afterRenameN?.();
		},
		start: async (id: string) => {
			starts.push(id);
			await real.start(id);
		},
		exec: async (id: string, cmd: string[], t: number) => {
			if (cmd[0] === "test" && hooks.onReadiness) {
				const h = hooks.onReadiness;
				hooks.onReadiness = undefined;
				await h(id);
			}
			return real.exec(id, cmd, t);
		},
	};
	const attempts = new RecreateAttemptStore(ROOT);
	const lock = new SessionLifecycleLock();
	lock.setGuard((s) => attempts.assertResolved(s));
	const engine = new RecreationEngine({
		workspaceRoot: ROOT,
		docker: port,
		d1,
		attempts,
		lock,
		capture,
	});

	// ── Precondition 6 on a real layer ───────────────────────────────────
	phase("Preflight: the real docker diff of a clean boot");
	const clean = await engine.preflight(SID);
	check(
		"a clean boot is recreatable",
		(clean as { recreatable?: boolean }).recreatable === true,
		clean,
	);
	if ((clean as { recreatable?: boolean }).recreatable !== true) {
		console.error(JSON.stringify(await docker.getContainer(O).changes(), null, 1));
	}
	check(
		"the preflight compares the current image by ID",
		(clean as { currentImageId?: string }).currentImageId === imageId,
	);

	phase("Preflight: real user state in the layer blocks");
	await withO(O, () => exec(O, "echo ls >> ~/.bash_history"));
	const hist = (await engine.preflight(SID)) as { blockers: Array<{ code: string }> };
	check(
		"~/.bash_history ⇒ layer-home",
		hist.blockers?.some((b) => b.code === "layer-home"),
		hist,
	);
	await withO(O, () => exec(O, "rm -f ~/.bash_history"));
	await withO(O, () =>
		exec(O, "git config --global user.name Ada && git config --global user.email ada@x"),
	);
	gitIdentity = { name: "Ada", email: "ada@x" };
	check(
		"~/.gitconfig exactly the identity ⇒ allowed",
		((await engine.preflight(SID)) as { recreatable: boolean }).recreatable === true,
	);
	gitIdentity = { name: "Ada", email: "other@x" };
	const gc = (await engine.preflight(SID)) as { blockers: Array<{ code: string }> };
	check(
		"~/.gitconfig with another email ⇒ layer-gitconfig-modified",
		gc.blockers?.some((b) => b.code === "layer-gitconfig-modified"),
		gc,
	);
	await withO(O, () => exec(O, "rm -f ~/.gitconfig"));
	gitIdentity = null;

	phase("Preflight: a customized managed skill blocks");
	await withO(O, () => exec(O, "echo mine >> ~/.claude/skills/delegate-task/SKILL.md"));
	const cust = (await engine.preflight(SID)) as { blockers: Array<{ code: string }> };
	check(
		"W ≠ I_O ⇒ managed-skills-customized",
		cust.blockers?.some((b) => b.code === "managed-skills-customized"),
		cust,
	);
	// O's next boot re-seeds W from its image.
	await withO(O, async () => undefined);

	// ── A manual start of O between steps 2 and 3 ────────────────────────
	phase("Manual `docker start` of O between steps 2 and 3");
	hooks.afterRenameN = async () => {
		await docker.getContainer(O).start();
	};
	starts.length = 0;
	const manual = await engine.recreate(SID, imageId);
	hooks.afterRenameN = undefined;
	check(
		"rollback at step start, resolved",
		JSON.stringify(manual) ===
			JSON.stringify({ ok: false, status: 500, code: "recreate-failed", step: "start" }),
		manual,
	);
	check("N was never started", starts.length === 0, starts);
	check(
		"O has its canonical name back",
		(await docker.getContainer(O).inspect()).Name === `/${CANONICAL}`,
	);
	check("no N left", (await real.listByLabel(LABEL_SESSION, SID)).length === 0);
	await stopIfRunning(O);
	// O re-seeded on that start; make W absent so a seed is observable.
	await withO(O, () => exec(O, "rm -rf ~/.claude/skills/delegate-task"));
	check("W absent before the next attempts", !(await exists(SKILL)));

	// ── Rollback after N booted twice with defer-skill-seed ──────────────
	phase("N boots twice before the commit, then the commit fails");
	casMode = "rejected";
	hooks.onReadiness = async (nId) => {
		await waitReady(nId);
		await docker.getContainer(nId).restart();
	};
	const rb = await engine.recreate(SID, imageId);
	check(
		"500 recreate-failed {step: commit} without unresolved",
		JSON.stringify(rb) ===
			JSON.stringify({ ok: false, status: 500, code: "recreate-failed", step: "commit" }),
		rb,
	);
	check("N's boots did not seed (W still absent)", !(await exists(SKILL)));
	check(
		"no N left, O canonical and stopped",
		(await real.listByLabel(LABEL_SESSION, SID)).length === 0 &&
			!(await docker.getContainer(O).inspect()).State.Running,
	);
	check(
		"defer-skill-seed retired after the confirmed removal",
		!(await cap.deferSeedExists(ROOT, SID)),
	);
	check("D1 still on O", row.container_id === O);
	const rec1 = await attempts.read(SID);
	check(
		"record resolved rolled-back",
		rec1.kind === "ok" &&
			rec1.record.state === "resolved" &&
			rec1.record.outcome?.kind === "rolled-back",
		rec1,
	);

	// ── The full path ────────────────────────────────────────────────────
	phase("Successful recreation");
	casMode = "normal";
	const okr = await engine.recreate(SID, imageId);
	const nId = (okr as { nContainerId?: string }).nContainerId as string;
	check("committed", (okr as { ok?: boolean }).ok === true && !("unresolved" in okr), okr);
	const n = await docker.getContainer(nId).inspect();
	check(
		"N from the checked image ID, canonical name, running",
		n.Image === imageId && n.Name === `/${CANONICAL}` && n.State.Running,
	);
	check("O removed", (await real.inspect(O)) === null);
	check("D1 = N with H", row.container_id === nId && !!row.ingest_token_hash);
	check(
		"relay identified, hooks file written ⇒ effective:true",
		(okr as { capture?: { effective?: boolean } }).capture?.effective === true,
		(okr as { capture?: unknown }).capture,
	);
	check(
		"marker and hooks file on disk",
		(await cap.relayEnabledExists(ROOT, SID)) && (await activation.hooksFileExists(ROOT, SID)),
	);
	check("seeded in step 6.2 (W = I_N)", await exists(SKILL));
	check("defer-skill-seed gone", !(await cap.deferSeedExists(ROOT, SID)));

	// ── Boot passes and leftovers ────────────────────────────────────────
	phase("The committed N is never a leftover; a real one is");
	const rec2 = await attempts.read(SID);
	const attemptId = rec2.kind === "ok" ? rec2.record.attemptId : "";
	for (let i = 0; i < 2; i++) {
		await engine.bootPass();
		await docker.getContainer(nId).stop();
		await engine.bootPass();
		await docker.getContainer(nId).start();
	}
	check(
		"N kept, same id, across boot passes and stop/start",
		(await real.inspect(nId))?.running === true,
	);
	const leftover = await docker.createContainer({
		Image: IMAGE,
		name: `${CANONICAL}-new-1`,
		Labels: { [LABEL_SESSION]: SID, [LABEL_ATTEMPT]: attemptId },
	});
	await engine.bootPass();
	check(
		"a labelled, never-started, non-D1 container of a resolved attempt is removed",
		(await real.inspect(leftover.id)) === null,
	);
	check("N still there", (await real.inspect(nId)) !== null);
}

main()
	.catch((err) => {
		failures++;
		console.error(`  FAIL: ${(err as Error).stack ?? err}`);
	})
	.finally(async () => {
		await cleanup();
		console.log(
			failures === 0 ? "\nrecreation smoke: all ok" : `\nrecreation smoke: ${failures} failure(s)`,
		);
		process.exit(failures === 0 ? 0 : 1);
	});
