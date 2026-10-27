/**
 * recreateAudit.smoke.ts — the 3.0d integral audit's smoke extension
 * (docs/design/phase3-3.0d-audit.md §10), against a REAL dockerd, the real
 * session image, its real relay and the backend's real capture authority
 * and recreation engine. Run by the Session Image workflow:
 *
 *   cd backend && npx tsx src/recreate/recreateAudit.smoke.ts <image>
 *
 * Isolated like realDocker.smoke.ts: every scenario gets its OWN fresh
 * session id, a temp WORKSPACE_ROOT, and only containers it creates (named
 * `st-<sid12>…`, labelled with that id), all removed on exit. D1 is an
 * in-memory row per session. Secrets are compared by hash, never printed.
 *
 * Scenarios:
 *   S1  a full recreation with data: workspace (repo, transcript, blob)
 *       byte-identical, git identity and history, a secret env var and a
 *       declared port in N, capture effective;
 *   S2  the backend interrupted between steps 2 and 4, and after the commit:
 *       D8 — unresolved and orphaned after a restart, nothing resolves it,
 *       every lifecycle verb refused, D1 on an existing container, no
 *       container removed, workspace and skills intact;
 *   S3  the relay unavailable during activation (its port occupied when
 *       step 5 runs): no hooks file, no marker, the record pending; once
 *       the port is free the resolution converges and capture is effective;
 *   S4  the relay killed (-9) after activation: the first capture query
 *       says relay-unavailable, effective again within the contract's 3 s;
 *   S5  data, marks and authorizations kept across stop/start of N:
 *       retained marker + hooks file, effectiveAfterRestart, effective after
 *       the start, D1's hash = the hash of N's own token, no revocation.
 * The CLI-level halves (hook errors with the real CLI in S3/S4) are in
 * session-image/conversation-smoke.sh, Phase 12.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Dockerode from "dockerode";

const IMAGE = process.argv[2] ?? "shared-terminal-session";
const ROOT = path.join(os.tmpdir(), `st-recreate-audit-${process.pid}`);
process.env.WORKSPACE_ROOT = ROOT;
process.env.SESSION_IMAGE = IMAGE;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

const docker = new Dockerode();
const sids: string[] = [];
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A hung interrupted request must fail the smoke, not stall the job. */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, rej) =>
			setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms),
		),
	]);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Exit code of `bash -c cmd` as the developer user; stdout returned (never printed). */
async function sh(id: string, cmd: string, user?: string): Promise<{ code: number; out: string }> {
	const e = await docker.getContainer(id).exec({
		Cmd: ["bash", "-c", cmd],
		AttachStdout: true,
		AttachStderr: true,
		...(user ? { User: user } : {}),
	});
	const s = await e.start({});
	const chunks: Buffer[] = [];
	await new Promise<void>((r) => {
		docker.modem.demuxStream(
			s,
			{ write: (c: Buffer) => chunks.push(c) } as unknown as NodeJS.WritableStream,
			{ write: () => true } as unknown as NodeJS.WritableStream,
		);
		s.on("end", () => r());
		s.on("close", () => r());
	});
	return { code: (await e.inspect()).ExitCode ?? -1, out: Buffer.concat(chunks).toString("utf8") };
}
async function waitReady(id: string): Promise<void> {
	for (let i = 0; i < 120; i++) {
		if ((await sh(id, "test -f /tmp/.st-ready")).code === 0) return;
		await sleep(500);
	}
	throw new Error("container never became ready");
}
async function stopIfRunning(id: string): Promise<void> {
	await docker
		.getContainer(id)
		.stop()
		.catch((err: { statusCode?: number }) => {
			if (err.statusCode !== 304) throw err;
		});
}
async function inspectOrNull(id: string) {
	return docker
		.getContainer(id)
		.inspect()
		.catch(() => null);
}

/** sha256 over the sorted (relative path, bytes) of every regular file under `dir`. */
async function treeHash(dir: string): Promise<string> {
	const out: string[] = [];
	async function walk(d: string): Promise<void> {
		for (const e of await fs.readdir(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else if (e.isFile())
				out.push(`${path.relative(dir, p)}\0${sha((await fs.readFile(p)).toString("base64"))}`);
			else if (e.isSymbolicLink()) out.push(`${path.relative(dir, p)}\0->${await fs.readlink(p)}`);
		}
	}
	await walk(dir);
	return sha(out.sort().join("\n"));
}

async function cleanup(): Promise<void> {
	const all = await docker.listContainers({ all: true });
	for (const c of all) {
		const name = (c.Names?.[0] ?? "").replace(/^\//, "");
		const sid = c.Labels?.["io.shared-terminal.session"];
		if (sids.some((s) => name.startsWith(`st-${s.slice(0, 12)}`) || sid === s)) {
			// Failure context for the job log: each container's own output.
			// Never `inspect`: its Env holds the ingest token and the secret.
			if (failures > 0) {
				const log = await docker
					.getContainer(c.Id)
					.logs({ stdout: true, stderr: true, tail: 300 })
					.catch((err: Error) => Buffer.from(`(logs unavailable: ${err.message})`));
				console.error(`\n── docker logs ${name} (${c.State}) ──\n${log.toString("utf8")}`);
			}
			await docker
				.getContainer(c.Id)
				.remove({ force: true })
				.catch(() => undefined);
		}
	}
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
	const { DockerManager, buildContainerEnv } = await import("../dockerManager.js");
	const { RecreateAttemptStore, RecreateUnresolvedError } = await import("../recreateAttempt.js");
	const { SessionLifecycleLock } = await import("../sessionLifecycleLock.js");
	const { RecreationEngine } = await import("./engine.js");
	const activation = await import("../conversation/activation.js");
	const cap = await import("../conversation/captureAuth.js");
	const { captureFilesConverged } = await import("./capturePort.js");
	const { checkRevocation } = await import("../conversation/revocation.js");
	const { hashIngestToken } = await import("../conversation/registry.js");
	type SessionManager = import("../sessionManager.js").SessionManager;
	type RecreateCapturePort = import("./engine.js").RecreateCapturePort;
	type RecreateD1Port = import("./d1.js").RecreateD1Port;
	type Ports = Array<{ container: number; public: boolean }>;

	const dm = new DockerManager({} as SessionManager);
	const real = dm.recreatePort();
	const imageId = (await docker.getImage(IMAGE).inspect()).Id;
	const deps = { workspaceRoot: ROOT, enabled: true, port: 3001 };
	const captureDocker = {
		inspectCapture: (cid: string) => dm.inspectCapture(cid),
		currentImage: () => dm.currentSessionImage(),
		probeRelay: (s: string, cid: string) => dm.probeRelay(s, cid),
	};

	/** One isolated session: O booted once and stopped, D1 in memory, its own engine. */
	async function session(
		label: string,
		opts: { gitIdentity?: { name: string; email: string }; ports?: Ports; secret?: string } = {},
	) {
		const sid = randomUUID();
		sids.push(sid);
		const canonical = `st-${sid.slice(0, 12)}`;
		const ws = path.join(ROOT, sid);
		const uploads = path.join(ROOT, ".uploads", sid);
		await fs.mkdir(ws, { recursive: true });
		await fs.chmod(ws, 0o777);
		await fs.mkdir(uploads, { recursive: true });
		const userEnv = opts.secret ? [`ST_SMOKE_SECRET=${opts.secret}`] : [];
		const hostConfig = (binds: string[]) => ({
			Binds: [`${ws}:/home/developer/workspace`, `${uploads}:/home/developer/uploads:ro`, ...binds],
			Init: true,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges:true"],
		});
		const o = await docker.createContainer({
			Image: IMAGE,
			name: canonical,
			Env: buildContainerEnv(sid, label, userEnv),
			HostConfig: hostConfig([]),
			OpenStdin: true,
			Tty: true,
		});
		const row = {
			status: "stopped",
			container_id: o.id as string | null,
			container_name: canonical,
			conversation_requested: 1,
			ingest_token_hash: null as string | null,
			ingest_token_hash_suspended: null as string | null,
			user_id: "u1",
		};
		const state = {
			mappings: [] as Ports,
			casHook: undefined as undefined | (() => Promise<void>),
		};
		const config = {
			ports: opts.ports ?? [],
			gitIdentity: opts.gitIdentity ?? null,
			hasDotfiles: false,
			postStartCmd: null,
		};
		const d1: RecreateD1Port = {
			getRow: async () => ({ ...row }),
			sessionIdByContainerName: async (name) => (name === canonical ? sid : null),
			cas: async (_s, oId, nId, h) => {
				if (row.container_id !== oId || row.conversation_requested !== 1) return "not-applied";
				row.container_id = nId;
				row.ingest_token_hash = h;
				await state.casHook?.();
				return "applied";
			},
			getConfig: async () => config,
			setStatus: async (_s, st) => {
				row.status = st;
			},
			setPorts: async (_s, ports) => {
				state.mappings = ports.map((p) => ({ ...p }));
			},
		};
		const authority = (mayAct: () => boolean = () => true) =>
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
				const a = new cap.CaptureAuthority({
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
				const w = await a.applyWriteDetailed(s);
				return a.capture(s, { identified: w.identified });
			},
			converge: (s, mayAct) => authority(mayAct).converge(s),
			converged: (s) => captureFilesConverged(authority(), ROOT, s),
			deferSeedExists: (s) => cap.deferSeedExists(ROOT, s),
			removeDeferSeed: (s) => cap.removeDeferSeed(ROOT, s),
		};
		const hooks: {
			afterRenameN?: () => Promise<void>;
			onReadiness?: (id: string) => Promise<void>;
		} = {};
		const starts: string[] = [];
		const port = {
			...real,
			buildCreate: async (_s: string, spec: Parameters<typeof real.buildCreate>[1]) => ({
				Image: spec.imageId,
				name: spec.name,
				Labels: spec.labels,
				Env: buildContainerEnv(sid, label, userEnv, spec.env),
				HostConfig: hostConfig(spec.binds),
				OpenStdin: true,
				Tty: true,
			}),
			rename: async (id: string, name: string) => {
				await real.rename(id, name);
				if (name === canonical && id !== o.id) await hooks.afterRenameN?.();
			},
			start: async (id: string) => {
				starts.push(id);
				await real.start(id);
			},
			exec: async (id: string, cmd: string[], t: number, mayAct?: () => boolean) => {
				if (cmd[0] === "test" && hooks.onReadiness) {
					const h = hooks.onReadiness;
					hooks.onReadiness = undefined;
					await h(id);
				}
				return real.exec(id, cmd, t, mayAct);
			},
		};
		const make = () => {
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
				config: { resolveRetryMs: 1_500 },
			});
			return { attempts, lock, engine };
		};
		return { sid, canonical, ws, O: o.id, row, d1, state, config, authority, hooks, starts, make };
	}

	async function bootOnce(id: string, fn: () => Promise<unknown> = async () => undefined) {
		await docker.getContainer(id).start();
		await waitReady(id);
		try {
			await fn();
		} finally {
			await stopIfRunning(id);
		}
	}

	/** User data an ordinary session would have: a git repo, a transcript, a blob. */
	async function seedUserData(id: string) {
		const r = await sh(
			id,
			[
				"set -e",
				"mkdir -p ~/workspace/project ~/workspace/data ~/.claude/projects/-home-developer-workspace",
				"cd ~/workspace/project && git init -q && echo hola > README && git add README",
				"git -c user.name=Seed -c user.email=seed@x commit -qm first",
				"head -c 1048576 /dev/urandom > ~/workspace/data/blob.bin",
				'echo \'{"type":"user","message":"hola"}\' > ~/.claude/projects/-home-developer-workspace/conv.jsonl',
			].join("\n"),
		);
		check("user data written in O", r.code === 0, r.code);
	}
	/** The part of the workspace that belongs to the user (not what a boot seeds or chmods). */
	const userTree = async (ws: string) =>
		[
			await treeHash(path.join(ws, "project")),
			await treeHash(path.join(ws, "data")),
			await treeHash(path.join(ws, ".st/claude-state/projects")),
		].join(":");

	async function relayPid(id: string): Promise<string> {
		return (
			await sh(
				id,
				'for p in /proc/[0-9]*; do c=$(tr "\\0" " " <"$p/cmdline" 2>/dev/null); case "$c" in "python3 -IS /opt/st/hooks/relay.py"*) basename "$p";; esac; done | head -n 1',
				"0",
			)
		).out.trim();
	}

	// ── S1 ────────────────────────────────────────────────────────────────
	phase("S1: full recreation with workspace, git, secret and port");
	const secret = randomUUID();
	const s1 = await session("s1", {
		gitIdentity: { name: "Ada", email: "ada@example.test" },
		ports: [{ container: 8080, public: false }],
		secret,
	});
	await bootOnce(s1.O, async () => {
		await seedUserData(s1.O);
		await sh(
			s1.O,
			"git config --global user.name Ada && git config --global user.email ada@example.test",
		);
	});
	const s1Before = await userTree(s1.ws);
	const e1 = s1.make();
	const pre1 = await e1.engine.preflight(s1.sid);
	check("preflight: recreatable", (pre1 as { recreatable?: boolean }).recreatable === true, pre1);
	const r1 = await e1.engine.recreate(s1.sid, imageId);
	const n1 = (r1 as { nContainerId?: string }).nContainerId as string;
	check(
		"committed, resolved in the request",
		(r1 as { ok?: boolean }).ok === true && !("unresolved" in r1),
		r1,
	);
	check(
		"capture effective",
		(r1 as { capture?: { effective?: boolean } }).capture?.effective === true,
	);
	check(
		"workspace user data byte-identical (repo, transcript, blob)",
		(await userTree(s1.ws)) === s1Before,
	);
	check(
		"git history intact in N",
		(await sh(n1, "git -C ~/workspace/project log --oneline | wc -l")).out.trim() === "1",
	);
	check(
		"git identity re-applied in N",
		(await sh(n1, "git config --global user.email")).out.trim() === "ada@example.test",
	);
	check(
		"the secret env var reaches N (compared by hash)",
		(await sh(n1, 'printf %s "$ST_SMOKE_SECRET" | sha256sum | cut -d" " -f1')).out.trim() ===
			sha(secret),
	);
	check(
		"declared port: dispatcher mappings = config",
		JSON.stringify(s1.state.mappings) === JSON.stringify(s1.config.ports),
		s1.state.mappings,
	);
	check(
		"the transcript is where claude --resume reads it",
		(await sh(n1, "test -s ~/.claude/projects/-home-developer-workspace/conv.jsonl")).code === 0,
	);
	check("O removed", (await inspectOrNull(s1.O)) === null);

	// ── S4 (on S1's N, capture active) ────────────────────────────────────
	phase("S4: relay killed (-9) after activation");
	const pid = await relayPid(n1);
	check("the relay runs in N", pid !== "", pid);
	await sh(n1, `kill -KILL ${pid}`, "0");
	const firstAfter = await s1.authority().capture(s1.sid);
	check(
		"the first capture query after the kill: not effective, relay-unavailable",
		firstAfter.effective === false && firstAfter.pendingReasons.includes("relay-unavailable"),
		firstAfter,
	);
	const t0 = Date.now();
	let backMs = -1;
	while (Date.now() - t0 < 10_000) {
		if ((await s1.authority().capture(s1.sid)).effective) {
			backMs = Date.now() - t0;
			break;
		}
		await sleep(200);
	}
	check(
		`effective again within 3 s of the first query (${backMs} ms)`,
		backMs >= 0 && backMs <= 3_000,
		backMs,
	);
	check(
		"the marker and the hooks file were never touched by the crash",
		(await cap.relayEnabledExists(ROOT, s1.sid)) &&
			(await activation.hooksFileExists(ROOT, s1.sid)),
	);

	// ── S5 (S1's N across stop/start) ──────────────────────────────────────
	phase("S5: data, marks and authorizations across stop/start of N");
	await stopIfRunning(n1);
	const stopped = await s1.authority().capture(s1.sid);
	check(
		"stopped: marker and hooks file kept",
		(await cap.relayEnabledExists(ROOT, s1.sid)) &&
			(await activation.hooksFileExists(ROOT, s1.sid)),
	);
	check("stopped: effectiveAfterRestart true", stopped.effectiveAfterRestart === true, stopped);
	await docker.getContainer(n1).start();
	await waitReady(n1);
	let effectiveAfterStart = false;
	for (let i = 0; i < 25 && !effectiveAfterStart; i++) {
		effectiveAfterStart = (await s1.authority().capture(s1.sid)).effective;
		if (!effectiveAfterStart) await sleep(200);
	}
	check("started again: effective without PATCH or recreation", effectiveAfterStart);
	const nEnv = ((await docker.getContainer(n1).inspect()).Config.Env ?? []).find((e) =>
		e.startsWith("ST_INGEST_TOKEN="),
	);
	check(
		"D1's hash is the hash of N's own token",
		!!nEnv && hashIngestToken(nEnv.slice("ST_INGEST_TOKEN=".length)) === s1.row.ingest_token_hash,
	);
	check("no revocation in effect", (await checkRevocation(ROOT, s1.sid)) === "none");
	check("workspace user data still identical", (await userTree(s1.ws)) === s1Before);

	// ── S2 ────────────────────────────────────────────────────────────────
	for (const cut of ["between steps 2 and 4", "after the commit, before step 6.1"] as const) {
		phase(`S2: backend interrupted ${cut} (D8)`);
		const s = await session(`s2-${cut.length}`);
		await bootOnce(s.O, () => seedUserData(s.O));
		const skillBefore = await treeHash(path.join(s.ws, ".st/claude-state/skills"));
		const userBefore = await userTree(s.ws);
		const first = s.make();
		if (cut === "between steps 2 and 4") {
			s.hooks.afterRenameN = async () => {
				first.engine.stop(); // the process goes away after the renames
			};
		} else {
			s.state.casHook = async () => {
				first.engine.stop(); // … right after the commit applied
			};
		}
		const r = await within(120_000, "interrupted recreate", first.engine.recreate(s.sid, imageId));
		check(
			"the interrupted request answers unresolved",
			JSON.stringify(r).includes('"unresolved":true'),
			r,
		);
		// The next process: boot recovery, then its boot pass.
		const next = s.make();
		await next.attempts.recoverOnBoot();
		await next.engine.bootPass();
		await sleep(2_000); // longer than resolveRetryMs: nothing resolves it anyway
		const rec = await next.attempts.read(s.sid);
		check(
			"record uncertain and orphaned after the restart",
			rec.kind === "ok" && rec.record.state === "uncertain" && !!rec.record.orphanedAt,
			rec,
		);
		for (const op of ["start", "stop", "delete"] as const) {
			const refused = await next.lock
				.run(s.sid, op, async () => "ran")
				.then(
					() => false,
					(e) => e instanceof RecreateUnresolvedError,
				);
			check(`${op} refused (recreate-unresolved)`, refused);
		}
		const d1Container = s.row.container_id as string;
		check(
			"D1 names a container that exists",
			(await inspectOrNull(d1Container)) !== null,
			d1Container,
		);
		check(
			cut === "between steps 2 and 4" ? "D1 still on O" : "D1 on N (the commit applied)",
			cut === "between steps 2 and 4" ? d1Container === s.O : d1Container !== s.O,
		);
		check("O was not removed", (await inspectOrNull(s.O)) !== null);
		check("defer-skill-seed kept", await cap.deferSeedExists(ROOT, s.sid));
		check(
			"skills untouched",
			(await treeHash(path.join(s.ws, ".st/claude-state/skills"))) === skillBefore,
		);
		check("workspace user data intact", (await userTree(s.ws)) === userBefore);
		if (cut === "between steps 2 and 4")
			check("N was never started", s.starts.length === 0, s.starts);
		next.engine.stop();
	}

	// ── S3 ────────────────────────────────────────────────────────────────
	phase("S3: relay unavailable during activation (port occupied at step 5)");
	const s3 = await session("s3");
	await bootOnce(s3.O);
	const occupant =
		"setsid nohup python3 -c 'import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((\"127.0.0.1\",47613));s.listen();time.sleep(900)' st-occupant >/dev/null 2>&1 &";
	s3.hooks.onReadiness = async (nId) => {
		await waitReady(nId);
		await sh(nId, occupant);
	};
	const e3 = s3.make();
	const r3 = await e3.engine.recreate(s3.sid, imageId);
	const n3 = (r3 as { nContainerId?: string }).nContainerId as string;
	check(
		"committed but unresolved, authorize pending",
		(r3 as { ok?: boolean }).ok === true &&
			(r3 as { unresolved?: boolean }).unresolved === true &&
			((r3 as { pending?: string[] }).pending ?? []).some((p) => p.startsWith("authorize")),
		r3,
	);
	const c3 = (r3 as { capture?: { effective: boolean; pendingReasons: string[] } }).capture;
	check(
		"capture not effective with its reason",
		!!c3 && !c3.effective && c3.pendingReasons.length > 0,
		c3,
	);
	check("no hooks file written", !(await activation.hooksFileExists(ROOT, s3.sid)));
	check("no marker left", !(await cap.relayEnabledExists(ROOT, s3.sid)));
	check(
		"the record is not resolved",
		(await e3.attempts.read(s3.sid)).kind === "ok" &&
			((await e3.attempts.read(s3.sid)) as { record: { state: string } }).record.state !==
				"resolved",
	);
	// The port becomes free: the resolution converges on its own.
	// The bracket keeps pkill from matching this very `bash -c`.
	await sh(n3, "pkill -f 'st-occupan[t]' || true", "0");
	let resolved = false;
	// The supervisor backs off while the relay keeps dying on the taken port
	// (1, 2, 4 … 32 s), so the next launch can be half a minute away.
	for (let i = 0; i < 180 && !resolved; i++) {
		const rec = await e3.attempts.read(s3.sid);
		resolved = rec.kind === "ok" && rec.record.state === "resolved";
		if (!resolved) await sleep(500);
	}
	check("resolved once the relay could identify itself", resolved);
	check(
		"then: marker and hooks file",
		(await cap.relayEnabledExists(ROOT, s3.sid)) &&
			(await activation.hooksFileExists(ROOT, s3.sid)),
	);
	check("then: capture effective", (await s3.authority().capture(s3.sid)).effective);
	e3.engine.stop();
	e1.engine.stop();
}

main()
	.catch((err) => {
		failures++;
		console.error(`  FAIL: ${(err as Error).stack ?? err}`);
	})
	.finally(async () => {
		await cleanup();
		console.log(
			failures === 0
				? "\nrecreation audit smoke: all ok"
				: `\nrecreation audit smoke: ${failures} failure(s)`,
		);
		process.exit(failures === 0 ? 0 : 1);
	});
