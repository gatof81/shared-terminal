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
 *     is removed without being started;
 *   - O after real use of the CLI 2.1.308 (`claude -p`, an interactive tab
 *     with a subagent, against the scripted model) stays recreatable, its
 *     deep-link handler file in HOME holding exactly the pinned bytes; any
 *     other shape under /tmp or ~/.local still blocks; N carries none of
 *     those artifacts, the workspace, a Git repo, a secret, a key, the git
 *     identity and the CLI state are preserved (fingerprints only), the
 *     transcripts keep their size and mtime (they are never read,
 *     CONVERSATION.md §1.1), `claude --resume` on N continues the
 *     conversation O started, and N's own first interactive turn writes the
 *     handler file again byte for byte.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import Dockerode from "dockerode";
import { CLI_URL_HANDLER, CLI_URL_HANDLER_BYTES } from "./layer.js";
import { parseTar } from "./tar.js";

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
// The scripted model (session-image/test/mock-anthropic.mjs) on a private
// network, so the real CLI runs in O and N without an API key or egress.
const REPO = path.resolve(path.dirname(path.resolve(process.argv[1])), "../../..");
const NET = `${CANONICAL}-net`;
const OUT = path.join(ROOT, ".smoke-out");
const API_KEY = `sk-ant-api03-smoke-${randomBytes(12).toString("hex")}`;
const CLI_ENV = [
	"ANTHROPIC_BASE_URL=http://mock-api:8080",
	`ANTHROPIC_API_KEY=${API_KEY}`,
	"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
	"DISABLE_AUTOUPDATER=1",
];
const MOCK_REPLY = "Hello from the mock.\nSecond line.";
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

/** Exit code and stdout of `bash -c cmd` (as the image's user, developer). */
async function execOut(id: string, cmd: string): Promise<{ code: number; out: string }> {
	const e = await docker.getContainer(id).exec({
		Cmd: ["bash", "-c", cmd],
		AttachStdout: true,
		AttachStderr: true,
		WorkingDir: "/home/developer/workspace",
	});
	const s = await e.start({});
	const out: Buffer[] = [];
	await new Promise<void>((r) => {
		docker.modem.demuxStream(
			s,
			{ write: (c: Buffer) => out.push(c) } as unknown as NodeJS.WritableStream,
			{ write: () => true } as unknown as NodeJS.WritableStream,
		);
		s.on("end", () => r());
		s.on("close", () => r());
	});
	return { code: (await e.inspect()).ExitCode ?? -1, out: Buffer.concat(out).toString("utf8") };
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
	await docker
		.getNetwork(NET)
		.remove()
		.catch(() => undefined);
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
	const { captureFilesConverged } = await import("./capturePort.js");
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
	await fs.mkdir(OUT, { recursive: true });
	await fs.chmod(OUT, 0o777);
	await docker.createNetwork({ Name: NET });
	// Named under CANONICAL so cleanup() removes it with the session's containers.
	const mock = await docker.createContainer({
		Image: IMAGE,
		name: `${CANONICAL}-mockapi`,
		Entrypoint: ["node"],
		Cmd: ["/t/mock-anthropic.mjs", "8080", "/out/model-requests.jsonl"],
		HostConfig: { Binds: [`${REPO}/session-image/test:/t:ro`, `${OUT}:/out`], NetworkMode: NET },
		NetworkingConfig: { EndpointsConfig: { [NET]: { Aliases: ["mock-api"] } } },
	});
	await mock.start();
	const o = await docker.createContainer({
		Image: IMAGE,
		name: CANONICAL,
		Env: [`SESSION_ID=${SID}`, ...CLI_ENV],
		HostConfig: {
			Binds: [`${WS}:/home/developer/workspace`, `${UPLOADS}:/home/developer/uploads:ro`],
			Init: true,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges:true"],
			NetworkMode: NET,
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
		// §2.7.7 rollback: one statement back to the retained container, hashes cleared.
		casBack: async (_s, fromId, toId) => {
			if (casMode === "rejected" || row.container_id !== fromId) return "not-applied";
			row.container_id = toId;
			row.ingest_token_hash = null;
			row.ingest_token_hash_suspended = null;
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
	// The attempt's own authority for the resolution's convergence (gate
	// not consulted, as in capturePort.ts).
	const ownerAuthority = (mayAct: () => boolean) =>
		new cap.CaptureAuthority({
			workspaceRoot: ROOT,
			enabled: true,
			docker: captureDocker,
			getRow: async () => ({ ...row }),
			checkRevocation: (x) => checkRevocation(ROOT, x),
			isRecreateUnresolved: async () => false,
			writeHooksFile: (x) => activation.writeHooksFile(deps, x),
			removeHooksFile: (x) => activation.removeHooksFile(ROOT, x),
			hooksFileExists: (x) => activation.hooksFileExists(ROOT, x),
			mayWrite: mayAct,
		});
	const capture: RecreateCapturePort = {
		enabled: true,
		checkRevocation: (s) => checkRevocation(ROOT, s),
		prepare: (s, mayAct) => activation.prepareRecreateCapture(deps, s, mayAct),
		snapshot: async () => ({ marker: false, hooksFile: false }),
		restore: async () => "not-authorized",
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
		converge: (s, mayAct) => ownerAuthority(mayAct).converge(s),
		converged: (s) =>
			captureFilesConverged(
				ownerAuthority(() => true),
				ROOT,
				s,
			),
		deferSeedExists: (s) => cap.deferSeedExists(ROOT, s),
		removeDeferSeed: (s) => cap.removeDeferSeed(ROOT, s),
	};
	// N's create options: the same shape a spawn uses (asserted equal to the
	// spawn's in dockerManager.spawnConfig.test.ts); here without D1.
	const hooks: {
		afterRenameN?: () => Promise<void>;
		onReadiness?: (id: string) => Promise<void>;
		beforeCopy?: (p: string) => Promise<void>;
	} = {};
	const starts: string[] = [];
	const port = {
		...real,
		buildCreate: async (_s: string, spec: Parameters<typeof real.buildCreate>[1]) => ({
			Image: spec.imageId,
			name: spec.name,
			Labels: spec.labels,
			// The spawn's own env builder: SESSION_ID/SESSION_NAME plus the
			// capture entries (the relay refuses to start without SESSION_ID).
			Env: buildContainerEnv(SID, "recreate-smoke", CLI_ENV, spec.env),
			HostConfig: {
				Binds: [
					`${WS}:/home/developer/workspace`,
					`${UPLOADS}:/home/developer/uploads:ro`,
					...spec.binds,
				],
				Init: true,
				CapDrop: ["ALL"],
				SecurityOpt: ["no-new-privileges:true"],
				NetworkMode: NET,
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
		copyPath: async (from: string, p: string, to: string, dest: string, mayAct: () => boolean) => {
			if (hooks.beforeCopy) await hooks.beforeCopy(p);
			return real.copyPath(from, p, to, dest, mayAct);
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
		dockerFsPath: ROOT, // the runner's docker root and tmp share one filesystem
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

	// ── The real CLI's runtime artifacts in /tmp (CONVERSATION.md §2.7.1) ──
	phase("Preflight: O after real use of the CLI 2.1.308");
	let convId = "";
	await withO(O, async () => {
		const p = await execOut(
			O,
			"timeout 120 claude -p 'layer probe: first prompt' --output-format json </dev/null",
		);
		try {
			convId =
				(JSON.parse(p.out.trim().split("\n").pop() ?? "{}") as { session_id?: string })
					.session_id ?? "";
		} catch {}
		check(
			"claude -p in O answers with a conversation id",
			p.code === 0 && /^[0-9a-f-]{36}$/.test(convId),
			p.code,
		);
	});
	const afterP = await engine.preflight(SID);
	check(
		"O after claude -p (cc-socks, claude-1000, fswatch probes) is recreatable",
		(afterP as { recreatable?: boolean }).recreatable === true,
		afterP,
	);
	await withO(O, async () => {
		// An interactive tab with a subagent turn: the shape that leaves a
		// task link under /tmp/claude-1000 (cli-tmp-evidence.sh, case C).
		await execOut(
			O,
			`f=~/.claude.json; [ -s "$f" ] || echo "{}" > "$f"
jq --arg k "${API_KEY.slice(-20)}" '. + {hasCompletedOnboarding: true, theme: "dark",
	customApiKeyResponses: {approved: [$k], rejected: []},
	projects: {"/home/developer/workspace": {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}}}' "$f" > ~/workspace/.cj && cat ~/workspace/.cj > "$f" && rm -f ~/workspace/.cj
mkdir -p ~/.claude && printf '{"skipDangerousModePermissionPrompt": true, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo stop >> /home/developer/workspace/.turns"}]}]}}' > ~/.claude/settings.json`,
		);
		await execOut(
			O,
			'tmux new-session -d -s t -x 200 -y 50 -c /home/developer/workspace "claude --dangerously-skip-permissions"',
		);
		let ready = false;
		for (let i = 0; i < 60 && !ready; i++) {
			ready = /for shortcuts|bypass permissions on/.test(
				(await execOut(O, "tmux capture-pane -p -t t")).out,
			);
			if (!ready) await new Promise((r) => setTimeout(r, 500));
		}
		check("interactive tab in O reached its prompt", ready);
		await execOut(O, "tmux send-keys -t t 'ST_SCENARIO=agent' Enter");
		let done = false;
		for (let i = 0; i < 300 && !done; i++) {
			done = (await execOut(O, "test -s ~/workspace/.turns")).code === 0;
			if (!done) await new Promise((r) => setTimeout(r, 100));
		}
		check("the subagent turn finished", done);
		await execOut(O, "tmux send-keys -t t '/exit' Enter; sleep 3; rm -f ~/workspace/.turns");
	});
	const tmpLayer = ((await docker.getContainer(O).changes()) as Array<{ Path: string }>)
		.map((c) => c.Path)
		.filter((p) => p.startsWith("/tmp/"));
	console.log(`  · O's layer under /tmp: ${JSON.stringify(tmpLayer)}`);
	const homeLayer = (
		(await docker.getContainer(O).changes()) as Array<{ Path: string; Kind: number }>
	)
		.filter(
			(c) =>
				c.Path.startsWith("/home/developer/") && !c.Path.startsWith("/home/developer/workspace"),
		)
		.map((c) => `${c.Kind} ${c.Path}`);
	console.log(`  · O's layer under HOME (Kind Path): ${JSON.stringify(homeLayer)}`);
	for (const p of tmpLayer.filter((x) => x.endsWith(".output"))) {
		console.log(`  · archive stat of ${p}: ${JSON.stringify(await real.statPath(O, p))}`);
	}
	check(
		"the run left the observed shapes: fswatch probes and a subagent task link",
		tmpLayer.some((p) => /\/fswatch-probe-[A-Za-z0-9]{6}\/probe$/.test(p)) &&
			tmpLayer.some((p) => /\/tasks\/a[0-9a-f]{16}\.output$/.test(p)),
		tmpLayer,
	);
	const afterCli = (await engine.preflight(SID)) as {
		recreatable?: boolean;
		blockers?: Array<{ code: string }>;
	};
	check(
		"after an interactive tab with a subagent: nothing under /tmp blocks (the task link included)",
		!afterCli.blockers?.some((b) => b.code === "layer-tmp"),
		afterCli,
	);
	// The interactive CLI also writes its deep-link handler registration in
	// HOME (layer.ts CLI_URL_HANDLER, owner decision 2026-10-28): allowed only
	// with the pinned bytes, so the bytes this real CLI wrote are compared too.
	check(
		"the interactive CLI wrote ~/.local/share/applications/claude-code-url-handler.desktop",
		homeLayer.includes(`1 ${CLI_URL_HANDLER}`),
		homeLayer,
	);
	const handlerTar = await real.readArchive(O, CLI_URL_HANDLER, 64 * 1024);
	const handler = handlerTar ? parseTar(handlerTar, { maxEntries: 2, maxFileBytes: 4096 }) : [];
	const handlerBytes = handler[0]?.data ?? Buffer.alloc(0);
	console.log(
		`  · ${CLI_URL_HANDLER}: ${handlerBytes.length} bytes, sha256 ${createHash("sha256").update(handlerBytes).digest("hex")}`,
	);
	check(
		"its bytes are exactly the pinned ones (no user data, nothing dynamic)",
		handler.length === 1 && handlerBytes.equals(CLI_URL_HANDLER_BYTES),
		handlerBytes.toString("utf8"),
	);
	check(
		"after claude -p and an interactive tab with a subagent, O is recreatable",
		afterCli.recreatable === true,
		afterCli,
	);
	// Any other shape under ~/.local still blocks. Each variant is undone from a
	// copy kept in the workspace (the bind mount, not the layer).
	const H = "~/.local/share/applications/claude-code-url-handler.desktop";
	await withO(O, () => execOut(O, `cp ${H} ~/workspace/.handler.orig`));
	for (const [label, plant, undo] of [
		[
			"the file modified, same size",
			`sed -i 's/%u/%U/' ${H}`,
			`cat ~/workspace/.handler.orig > ${H}`,
		],
		["the file with another size", `echo >> ${H}`, `cat ~/workspace/.handler.orig > ${H}`],
		[
			"the file replaced by a symlink",
			`rm ${H} && ln -s /home/developer/workspace/.handler.orig ${H}`,
			`rm ${H} && cp ~/workspace/.handler.orig ${H}`,
		],
		[
			"another file next to it",
			"echo x > ~/.local/share/applications/mimeapps.list",
			"rm ~/.local/share/applications/mimeapps.list",
		],
		["a symlink under ~/.local", "ln -s /etc/passwd ~/.local/share/x", "rm ~/.local/share/x"],
		["a user file in ~/.local", "echo notes > ~/.local/notes", "rm ~/.local/notes"],
	] as const) {
		const planted = await withO(O, () => execOut(O, plant));
		const v = (await engine.preflight(SID)) as {
			recreatable?: boolean;
			blockers?: Array<{ code: string }>;
		};
		check(
			`${label} ⇒ layer-home`,
			planted.code === 0 &&
				v.recreatable === false &&
				v.blockers?.some((b) => b.code === "layer-home") === true,
			{ planted: planted.code, v },
		);
		await withO(O, () => execOut(O, undo));
	}
	await withO(O, () => execOut(O, "rm -f ~/workspace/.handler.orig"));
	check(
		"with every HOME variant undone, O is recreatable again",
		((await engine.preflight(SID)) as { recreatable?: boolean }).recreatable === true,
	);
	const taskDir = "$(ls -d /tmp/claude-1000/-home-developer-workspace/*/tasks | head -n 1)";
	for (const [label, plant] of [
		[
			"a regular file in tasks/ (a background task's output)",
			`echo out > ${taskDir}/b0123456789abcdef.output`,
		],
		["a task link to /etc/passwd", `ln -s /etc/passwd ${taskDir}/a0123456789abcdef.output`],
		[
			"a 2-byte probe",
			"mkdir /tmp/claude-1000/fswatch-probe-zzzzzz && printf 12 > /tmp/claude-1000/fswatch-probe-zzzzzz/probe",
		],
		["a user file in /tmp/claude-1000", "echo notes > /tmp/claude-1000/notes"],
		["a regular file in /tmp/cc-socks", "echo x > /tmp/cc-socks/99.sock"],
	] as const) {
		const planted = await withO(O, () => execOut(O, plant));
		const v = (await engine.preflight(SID)) as { blockers?: Array<{ code: string }> };
		check(
			`planted ${label} ⇒ layer-tmp`,
			planted.code === 0 && v.blockers?.some((b) => b.code === "layer-tmp") === true,
			{ planted: planted.code, v },
		);
		await withO(O, () =>
			execOut(
				O,
				`rm -rf ${taskDir}/b0123456789abcdef.output ${taskDir}/a0123456789abcdef.output /tmp/claude-1000/fswatch-probe-zzzzzz /tmp/claude-1000/notes /tmp/cc-socks/99.sock`,
			),
		);
	}
	// A planted entry removed from O's layer is a deletion Docker still lists
	// only if it existed in the image — these never did, so O is clean again.
	check(
		"with the planted entries removed, O is recreatable again",
		((await engine.preflight(SID)) as { recreatable?: boolean }).recreatable === true,
	);
	// Read-only listings of the workspace from a root container (its files are
	// uid 1000, some mode 0600); an empty or failed listing throws, so no
	// comparison below can pass vacuously.
	const inWorkspace = async (cmd: string): Promise<string> => {
		const out = new PassThrough();
		const chunks: Buffer[] = [];
		out.on("data", (c: Buffer) => chunks.push(c));
		const [res] = (await docker.run(IMAGE, ["bash", "-c", cmd], out, {
			User: "0",
			Entrypoint: [],
			Tty: true,
			HostConfig: { Binds: [`${WS}:/w:ro`], AutoRemove: true },
		})) as [{ StatusCode: number }];
		const text = Buffer.concat(chunks).toString("utf8").replace(/\r/g, "").trim();
		if (res.StatusCode !== 0 || text === "")
			throw new Error(`workspace listing failed (exit ${res.StatusCode}): ${cmd}`);
		return text;
	};
	// Transcript metadata only (path, size, mtime): never their content (§1.1).
	const transcripts = () =>
		inWorkspace("cd /w/.st/claude-state/projects && find . -type f -printf '%P %s %T@\\n' | sort");
	const transcriptsBefore = await transcripts();
	check(
		"O's transcripts exist (the conversation and the subagent's)",
		transcriptsBefore.includes(`${convId}.jsonl`) &&
			/subagents\/agent-a[0-9a-f]{16}\.jsonl/.test(transcriptsBefore),
	);
	// Preservation: a Git repo with a commit, a secret (`.env`) and a key under
	// ~/.ssh (both 0600), the git identity in ~/.gitconfig, and the CLI's own
	// state (~/.claude.json, ~/.claude/settings.json). Fingerprints only —
	// hashes, modes, the HEAD — so the secret is never printed.
	gitIdentity = { name: "Ada", email: "ada@x" };
	const seeded = await withO(O, () =>
		execOut(
			O,
			`set -e
git config --global user.name Ada && git config --global user.email ada@x
mkdir -p ~/workspace/proj && cd ~/workspace/proj && git init -q && echo hi > a && git add a && git commit -qm init
umask 077 && printf 'TOKEN=%s\\n' "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')" > ~/workspace/.env
mkdir -p ~/.ssh && head -c 64 /dev/urandom | base64 > ~/.ssh/id_smoke && chmod 600 ~/.ssh/id_smoke`,
		),
	);
	check("O: repo, secret, key and git identity in place", seeded.code === 0, seeded);
	const preserved = () =>
		inWorkspace(
			`cd /w && sha256sum .env .st/ssh/id_smoke .st/claude.json .st/claude-state/settings.json proj/a &&
stat -c '%n %a %u' .env .st/ssh/id_smoke &&
git -c safe.directory='*' -C proj rev-parse HEAD && git -c safe.directory='*' -C proj status --porcelain`,
		);
	const preservedBefore = await preserved();
	check(
		"with them, O is still recreatable (~/.gitconfig = the identity)",
		((await engine.preflight(SID)) as { recreatable?: boolean }).recreatable === true,
	);

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
	check("record resolved committed", (await attempts.read(SID)).kind === "ok");

	phase(
		"N after O's real CLI use: no runtime artifacts carried, transcripts intact, --resume continues",
	);
	check(
		"none of O's /tmp runtime artifacts is in N",
		(await execOut(nId, "test ! -e /tmp/cc-socks && test ! -e /tmp/claude-1000")).code === 0,
	);
	check(
		"the transcripts' paths, sizes and mtimes are unchanged",
		(await transcripts()) === transcriptsBefore,
	);
	check(
		"workspace, Git, secret, key and CLI state unchanged before any CLI runs in N (hashes, modes, HEAD)",
		(await preserved()) === preservedBefore,
	);
	const resumed = await execOut(
		nId,
		`timeout 120 claude -p --resume ${convId} 'layer probe: after recreation' --output-format json </dev/null`,
	);
	let resumedJson: { result?: string; session_id?: string } = {};
	try {
		resumedJson = JSON.parse(resumed.out.trim().split("\n").pop() ?? "{}");
	} catch {}
	check(
		"N: claude -p --resume answers in the same conversation",
		resumed.code === 0 &&
			resumedJson.result?.trim() === MOCK_REPLY &&
			resumedJson.session_id === convId,
		{ code: resumed.code, sameId: resumedJson.session_id === convId },
	);
	const modelSaw = (await fs.readFile(path.join(OUT, "model-requests.jsonl"), "utf8"))
		.split("\n")
		.filter((l) => l.includes("layer probe: after recreation"))
		.pop();
	check(
		"the model was sent O's earlier turn with the resumed prompt",
		!!modelSaw && modelSaw.includes("layer probe: first prompt"),
	);
	check(
		"N: the git identity re-applied",
		(await execOut(nId, "git config --global user.email")).out.trim() === "ada@x",
	);
	check(
		"N: O's ~/.local was not carried over",
		(await execOut(nId, "test ! -e ~/.local")).code === 0,
	);
	// Reproducibility: N's own interactive CLI (prompt reached, one turn, exit)
	// writes the same file again.
	await execOut(
		nId,
		'rm -f ~/workspace/.turns; tmux new-session -d -s t -x 200 -y 50 -c /home/developer/workspace "claude --dangerously-skip-permissions"',
	);
	let nReady = false;
	for (let i = 0; i < 60 && !nReady; i++) {
		nReady = /for shortcuts|bypass permissions on/.test(
			(await execOut(nId, "tmux capture-pane -p -t t")).out,
		);
		if (!nReady) await new Promise((r) => setTimeout(r, 500));
	}
	check("N: interactive tab reached its prompt", nReady);
	const nHash = async () =>
		(await execOut(nId, `sha256sum < ${H} 2>/dev/null | cut -d' ' -f1`)).out.trim();
	let nHandler = "";
	for (let i = 0; i < 20 && !nHandler; i++) {
		nHandler = await nHash();
		if (!nHandler) await new Promise((r) => setTimeout(r, 500));
	}
	console.log(`  · N's handler file at its prompt: ${nHandler || "absent"}`);
	await execOut(nId, "tmux send-keys -t t 'layer probe: N tab' Enter");
	for (let i = 0; i < 300; i++) {
		if ((await execOut(nId, "test -s ~/workspace/.turns")).code === 0) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	await execOut(nId, "tmux send-keys -t t '/exit' Enter; sleep 3; rm -f ~/workspace/.turns");
	nHandler = await nHash();
	check(
		"N: its interactive CLI writes the handler file again, byte for byte",
		nHandler === createHash("sha256").update(CLI_URL_HANDLER_BYTES).digest("hex"),
		nHandler || "absent",
	);

	// ── The recreation's exec: the exit comes from dockerd, by exec id ───
	phase("Exec termination evidence (real dockerd)");
	const ex = await real.exec(nId, ["sh", "-c", "echo out; exit 7"], 5_000);
	check("a finished exec reports its exit and id", ex.exitCode === 7 && !!ex.execId, ex);
	check("its output", ex.stdout === "out\n", ex.stdout);
	const st = await real.execState(ex.execId as string);
	check("execState: ended, with the same exit", st?.running === false && st.exitCode === 7, st);
	const to = await real.exec(nId, ["sleep", "30"], 1_000);
	check("the in-container timeout fired: a known exit (124), not unknown", to.exitCode === 124, to);
	check("an unknown exec id ⇒ null", (await real.execState("0".repeat(64))) === null);

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

	// ── §2.7.7: carry-over, retention, rollback, approve, D8 recovery ────
	phase("Carry-over (§2.7.7): a legacy-shaped layer travels into the new container");
	// N is the current container, running. Dirty its layer the way the three
	// pre-3.0d sessions of 2026-10-31 are: npm cache, ~/.local, ~/.cache, a
	// hand-made HOME dir, an edited ~/.bashrc, a build cache under /tmp.
	const DIRTY = [
		"~/.npm/_cacache/blob",
		"~/.bashrc",
		"~/.local/share/thing/config.json",
		"~/.cache/x/data",
		"/tmp/build-cache/a.o",
		"~/dash-backup/flows.json",
		"~/dash-backup/secret.key", // 0600
		"~/.private/notes.txt", // in a 0700 dir
		"~/dash-backup/hardlink-b", // hardlink of flows.json
		"~/'dash-backup/ñandú ☃ informe.txt'", // unicode name
	];
	// Metadata the carry must keep (mode uid gid type links; readlink for symlinks; one inode for the hardlink pair).
	const META_PATHS =
		"~/dash-backup/secret.key ~/.private ~/.private/notes.txt ~/dash-backup/flows.json ~/dash-backup/hardlink-b ~/dash-backup/link-abs ~/dash-backup/link-dangling ~/dash-backup/fifo ~/'dash-backup/ñandú ☃ informe.txt' /tmp/build-cache/a.o";
	await execOut(
		nId,
		`mkdir -p ~/.npm/_cacache ~/.local/share/thing ~/.cache/x /tmp/build-cache ~/dash-backup
head -c 3000000 /dev/urandom > ~/.npm/_cacache/blob
echo 'export LEGACY=1' >> ~/.bashrc
echo '{"cfg":true}' > ~/.local/share/thing/config.json
head -c 200000 /dev/urandom > ~/.cache/x/data
head -c 1500000 /dev/urandom > /tmp/build-cache/a.o
echo '{"flows":1}' > ~/dash-backup/flows.json
(umask 077; echo 'k=1' > ~/dash-backup/secret.key)
mkdir -m 700 ~/.private && echo notes > ~/.private/notes.txt
ln ~/dash-backup/flows.json ~/dash-backup/hardlink-b
ln -s /home/developer/workspace/.st ~/dash-backup/link-abs
ln -s /nonexistent/target ~/dash-backup/link-dangling
mkfifo ~/dash-backup/fifo
echo 'informe' > ~/'dash-backup/ñandú ☃ informe.txt'`,
	);
	const sums = async (id: string) =>
		(
			await execOut(id, `sha256sum ${DIRTY.join(" ")} 2>&1 | cut -d' ' -f1 | tr '\\n' ' '`)
		).out.trim();
	const meta = async (id: string) =>
		(
			await execOut(
				id,
				`stat -c '%n %a %u %g %F %h' ${META_PATHS} 2>&1; readlink ~/dash-backup/link-abs ~/dash-backup/link-dangling; stat -c %i ~/dash-backup/flows.json ~/dash-backup/hardlink-b | uniq | wc -l`,
			)
		).out.trim();
	const dirtySums = await sums(nId);
	const dirtyMeta = await meta(nId);
	check(
		"the dirty files exist in the current container",
		dirtySums.split(" ").length === DIRTY.length && /^[0-9a-f ]+$/.test(dirtySums),
		dirtySums,
	);
	check(
		"fixture metadata as intended: 600 file, 700 dir, uid 1000, hardlink pair (one inode), symlinks, fifo",
		/secret\.key 600 1000 1000 regular file 1\b/.test(dirtyMeta) &&
			/\.private 700 1000 1000 directory/.test(dirtyMeta) &&
			/flows\.json 644 1000 1000 regular file 2\b/.test(dirtyMeta) &&
			/fifo 644 1000 1000 fifo/.test(dirtyMeta) &&
			dirtyMeta.includes("/home/developer/workspace/.st\n/nonexistent/target") &&
			dirtyMeta.endsWith("1"),
		dirtyMeta,
	);
	await docker.getContainer(nId).stop();
	row.status = "stopped";
	const strictPf = (await engine.preflight(SID)) as {
		recreatable: boolean;
		blockers: Array<{ code: string }>;
	};
	check(
		"strict preflight refuses the dirty layer",
		strictPf.recreatable === false && strictPf.blockers.some((b) => b.code === "layer-home"),
		strictPf.blockers,
	);
	// A backup manifest as backup.ts writes it — the precondition reads only
	// `createdAt` and the `workspaces` keys.
	const backupDir = path.join(ROOT, ".backups", "smoke");
	const writeManifest = async () => {
		await fs.mkdir(backupDir, { recursive: true });
		await fs.writeFile(
			path.join(backupDir, "manifest.json"),
			JSON.stringify({ createdAt: new Date().toISOString(), workspaces: { [SID]: {} } }),
		);
	};
	type CarryPf = {
		recreatable: boolean;
		blockers: Array<{ code: string }>;
		carry?: { entries: number; bytes: number; backupFresh: boolean; diskFreeBytes: number | null };
		retained?: { containerId: string };
	};
	let carryPf = (await engine.preflight(SID, { preserve: true })) as CarryPf;
	check(
		"without a fresh backup the carry-over is refused (backup-stale)",
		carryPf.recreatable === false && carryPf.blockers.some((b) => b.code === "backup-stale"),
		carryPf.blockers,
	);
	await writeManifest();
	// R3: real content where N's entrypoint symlinks (a pre-symlink image, or
	// a failed `ln`): refused before any effect, nothing lost.
	await docker.getContainer(nId).start();
	await waitReady(nId);
	await execOut(nId, "rm ~/.ssh && mkdir -m 700 ~/.ssh && echo k > ~/.ssh/id_test");
	await docker.getContainer(nId).stop();
	await writeManifest();
	const r3 = (await engine.preflight(SID, { preserve: true })) as CarryPf;
	check(
		"R3: a real ~/.ssh directory in O ⇒ layer-entrypoint-unexpected, not recreatable",
		r3.recreatable === false && r3.blockers.some((b) => b.code === "layer-entrypoint-unexpected"),
		r3.blockers,
	);
	const r3post = (await engine.recreate(SID, imageId, { preserve: true })) as {
		ok?: boolean;
		code?: string;
	};
	check(
		"R3: the POST refuses with the same code and no container was created",
		r3post.ok === false &&
			r3post.code === "layer-entrypoint-unexpected" &&
			(await real.listByLabel(LABEL_SESSION, SID)).every((c) => c.id === nId),
		r3post,
	);
	await docker.getContainer(nId).start();
	await waitReady(nId);
	await execOut(nId, "rm -rf ~/.ssh && ln -s /home/developer/workspace/.st/ssh ~/.ssh");
	await docker.getContainer(nId).stop();
	await writeManifest();
	carryPf = (await engine.preflight(SID, { preserve: true })) as CarryPf;
	check(
		"carry-over preflight: recreatable, the entries and bytes of the real layer, disk known",
		carryPf.recreatable === true &&
			(carryPf.carry?.entries ?? 0) >= 5 &&
			(carryPf.carry?.bytes ?? 0) > 4_000_000 &&
			carryPf.carry?.backupFresh === true &&
			typeof carryPf.carry?.diskFreeBytes === "number",
		carryPf,
	);
	type CarryResult = {
		ok?: boolean;
		unresolved?: boolean;
		nContainerId?: string;
		carried?: { entries: number; bytes: number };
		retained?: { containerId: string; name: string; role: string };
		capture?: { effective?: boolean };
	};
	const carried = (await engine.recreate(SID, imageId, { preserve: true })) as CarryResult;
	const n2 = carried.nContainerId as string;
	check(
		"committed with the carry-over",
		carried.ok === true && !carried.unresolved && (carried.carried?.entries ?? 0) >= 5,
		carried,
	);
	const n2i = await docker.getContainer(n2).inspect();
	check(
		"N2 from the checked image ID, canonical name, running",
		n2i.Image === imageId && n2i.Name === `/${CANONICAL}` && n2i.State.Running,
	);
	const prev = await real.inspect(nId);
	check(
		"the previous container is retained: present, stopped, under its -old- name",
		!!prev && !prev.running && /-old-\d+$/.test(prev.name) && carried.retained?.containerId === nId,
		{ prev, retained: carried.retained },
	);
	check("D1 = N2 with H", row.container_id === n2 && !!row.ingest_token_hash);
	check(
		"every dirty file identical in N2 (sha256)",
		(await sums(n2)) === dirtySums,
		await sums(n2),
	);
	check(
		"modes, uid/gid, types, hardlink pair, symlink targets and the fifo identical in N2",
		(await meta(n2)) === dirtyMeta,
		{ before: dirtyMeta, after: await meta(n2) },
	);
	check(
		"~/.bashrc in N2 keeps the appended line",
		(await execOut(n2, "grep -c 'export LEGACY=1' ~/.bashrc")).out.trim() === "1",
	);
	check(
		"N2's entrypoint symlinks are intact although ~/.config was carried",
		(await execOut(n2, "readlink ~/.config/gh")).out.trim() ===
			"/home/developer/workspace/.config/gh" &&
			(await execOut(n2, "test -L ~/.npm-global && test -L ~/.claude")).code === 0,
	);
	const ver = await execOut(n2, "claude --version");
	check(
		"the workspace CLI runs in N2",
		ver.code === 0 && /^\d+\.\d+\.\d+/.test(ver.out.trim()),
		ver,
	);
	// ST_CLI_PIN (the cli-variants job): N2 runs exactly the version under validation.
	if (process.env.ST_CLI_PIN) {
		check(
			`N2's CLI is the version under validation (${process.env.ST_CLI_PIN})`,
			ver.out.trim().startsWith(`${process.env.ST_CLI_PIN} `) ||
				ver.out.trim() === process.env.ST_CLI_PIN,
			ver.out.trim(),
		);
	}
	check(
		"relay identified on N2 ⇒ capture effective",
		carried.capture?.effective === true,
		carried.capture,
	);
	const recC = await attempts.read(SID);
	check(
		"record resolved committed, naming the retained container",
		recC.kind === "ok" &&
			recC.record.state === "resolved" &&
			recC.record.retained?.containerId === nId &&
			recC.record.preserve?.entries === carried.carried?.entries,
		recC,
	);
	check(
		"the plain preflight shows the retained container",
		((await engine.preflight(SID)) as CarryPf).retained?.containerId === nId,
	);

	phase("Rollback to the retained container (§2.7.7)");
	type Op = { ok: boolean; code?: string; body?: Record<string, unknown> };
	const rbRunning = (await engine.rollbackToRetained(SID)) as Op;
	check(
		"refused while N2 runs (409 running)",
		!rbRunning.ok && rbRunning.code === "running",
		rbRunning,
	);
	await docker.getContainer(n2).stop();
	row.status = "stopped";
	const rbRes = (await engine.rollbackToRetained(SID)) as Op;
	check(
		"rolled back to the retained container",
		rbRes.ok === true && rbRes.body?.containerId === nId,
		rbRes,
	);
	check("D1 back on it, hash cleared", row.container_id === nId && row.ingest_token_hash === null);
	const prevAfter = await real.inspect(nId);
	const n2After = await real.inspect(n2);
	check(
		"names: the previous container canonical again, N2 under -old-, both present and stopped",
		prevAfter?.name === CANONICAL &&
			!prevAfter.running &&
			!!n2After &&
			/-old-\d+$/.test(n2After.name) &&
			!n2After.running,
		{ prevAfter, n2After },
	);
	check(
		"capture files withdrawn (the hash no longer matches the token)",
		!(await cap.relayEnabledExists(ROOT, SID)) && !(await activation.hooksFileExists(ROOT, SID)),
	);
	await docker.getContainer(nId).start();
	await waitReady(nId);
	check(
		"the previous container boots again with its files intact",
		(await sums(nId)) === dirtySums,
	);
	await docker.getContainer(nId).stop();
	const recR = await attempts.read(SID);
	check(
		"rollback record: reverse, committed on the previous container, N2 retained, the carry-over in history",
		recR.kind === "ok" &&
			recR.record.reverse === true &&
			recR.record.outcome?.kind === "committed" &&
			recR.record.outcome.nContainerId === nId &&
			recR.record.retained?.containerId === n2 &&
			recR.record.history.some(
				(e) => e.outcome.kind === "committed" && e.outcome.nContainerId === n2,
			),
		recR,
	);
	const ap = (await engine.approve(SID)) as Op;
	check("approve removes the retained N2", ap.ok === true && (await real.inspect(n2)) === null, ap);
	const recA = await attempts.read(SID);
	check(
		"the record no longer names a retained container",
		recA.kind === "ok" && recA.record.retained === undefined && !!recA.record.approvedAt,
	);

	phase("D8 recovery of a carry-over interrupted mid-copy (§2.7.7)");
	// This process "dies" after the first copy landed: the engine is stopped
	// and the second copy never answers here (no Docker request is made for
	// it). Everything the next process can see is on disk and in dockerd.
	let copies = 0;
	hooks.beforeCopy = async () => {
		copies++;
		if (copies === 2) {
			engine.stop();
			await new Promise<never>(() => {});
		}
	};
	// The container was stopped again after the rollback check: the backup
	// must postdate THAT stop (§2.7.7 backup-stale), as the runbook orders.
	await writeManifest();
	void engine
		.recreate(SID, imageId, { preserve: true })
		.then((r) => console.log(`  · the interrupted recreate answered: ${JSON.stringify(r)}`))
		.catch(() => undefined);
	for (let i = 0; i < 600 && copies < 2; i++) await new Promise((r) => setTimeout(r, 100));
	check("the crash point was reached: one copy done, the second never answered", copies === 2);
	hooks.beforeCopy = undefined;
	const attempts2 = new RecreateAttemptStore(ROOT);
	const boot = await attempts2.recoverOnBoot();
	const gated = await attempts2.assertResolved(SID).then(
		() => false,
		() => true,
	);
	check(
		"the next process finds the attempt orphaned and the session gated",
		boot.uncertain.includes(SID) && gated,
		boot,
	);
	const n3 = (await real.listByLabel(LABEL_SESSION, SID)).find((c) => c.id !== nId);
	check("N3 exists, never started", !!n3 && !n3.running, n3);
	const lock2 = new SessionLifecycleLock();
	lock2.setGuard((s) => attempts2.assertResolved(s));
	const engine2 = new RecreationEngine({
		workspaceRoot: ROOT,
		docker: port,
		d1,
		attempts: attempts2,
		lock: lock2,
		capture,
		dockerFsPath: ROOT,
	});
	const recovered = (await engine2.recover(SID)) as Op;
	check(
		"recover: rolled back by evidence",
		recovered.ok === true &&
			(recovered.body?.outcome as { kind?: string } | undefined)?.kind === "rolled-back",
		recovered,
	);
	check(
		"N3 removed, the previous container canonical, D1 unchanged",
		!!n3 &&
			(await real.inspect(n3.id)) === null &&
			(await real.inspect(nId))?.name === CANONICAL &&
			row.container_id === nId,
	);
	check(
		"the session is no longer gated",
		await attempts2.assertResolved(SID).then(
			() => true,
			() => false,
		),
	);
	await docker.getContainer(nId).start();
	await waitReady(nId);
	check("its files are still intact after the recovery", (await sums(nId)) === dirtySums);
	await docker.getContainer(nId).stop();
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
