/**
 * Test-only harness for recreate/engine.ts: a stateful fake Docker whose
 * every request can be held, failed or applied late; a fake D1 row with a
 * configurable CAS; a fake capture port; the REAL attempt store (on a temp
 * WORKSPACE_ROOT) and the REAL lifecycle lock with the unresolved gate.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CaptureBlock } from "../conversation/captureAuth.js";
import { RecreateAttemptStore } from "../recreateAttempt.js";
import { SessionLifecycleLock } from "../sessionLifecycleLock.js";
import type { CasResult, RecreateD1Port, RecreateSessionConfig, RecreateSessionRow } from "./d1.js";
import { type RecreateCapturePort, type RecreateConfig, RecreationEngine } from "./engine.js";
import { ENTRYPOINT_SYMLINKS, type LayerChange, type PathStat } from "./layer.js";
import type {
	ExecResult,
	RecreateContainer,
	RecreateCreateSpec,
	RecreateDockerPort,
} from "./ports.js";
import type { AttemptRun } from "./run.js";
import { SKILLS_IMAGE_DIR, type WorkspaceSkill } from "./skills.js";
import { buildTar } from "./tarBuilder.testutil.js";

export const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const CANONICAL = `st-${SID.slice(0, 12)}`;
export const O_ID = "o".repeat(64);
export const IMG_O = "sha256:imageO";
export const IMG_N = "sha256:imageN";

export type Op =
	| "inspect"
	| "changes"
	| "statPath"
	| "readArchive"
	| "currentImage"
	| "create"
	| "rename"
	| "start"
	| "stop"
	| "remove"
	| "listByLabel"
	| "listByName"
	| "exec"
	| "execState";

/** Runs before the op applies; may await (late answer), throw (refused, nothing applied). */
export type Hook = (args: unknown[]) => Promise<void> | void;

interface FC extends RecreateContainer {
	starts: number;
}

export function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function httpError(statusCode: number, msg = `HTTP ${statusCode}`) {
	return Object.assign(new Error(msg), { statusCode });
}

export class FakeDocker implements RecreateDockerPort {
	readonly containers = new Map<string, FC>();
	readonly log: string[] = [];
	readonly hooks = new Map<Op, Hook>();
	/** Called on every removal: lets a test assert D1 never points at what goes. */
	onRemove: (id: string) => void = () => {};
	current: { imageId: string; relay2: boolean } | null = { imageId: IMG_N, relay2: true };
	readonly skillsByImage = new Map<string, Record<string, string> | null>([
		[IMG_O, { "delegate-task/SKILL.md": "v1" }],
		[IMG_N, { "delegate-task/SKILL.md": "v2" }],
	]);
	readonly gitconfig = new Map<string, string>();
	readonly changesOf = new Map<string, LayerChange[]>();
	private seq = 0;

	constructor() {
		this.containers.set(O_ID, {
			id: O_ID,
			name: CANONICAL,
			running: false,
			imageId: IMG_O,
			labels: {},
			mounts: ["/home/developer/workspace", "/home/developer/uploads"],
			starts: 1,
		});
	}

	byRef(ref: string): FC | undefined {
		return this.containers.get(ref) ?? [...this.containers.values()].find((c) => c.name === ref);
	}

	private async gate(op: Op, args: unknown[]) {
		this.log.push(
			`${op}:${args.map((a) => (typeof a === "string" ? a.slice(0, 16) : "…")).join(",")}`,
		);
		const h = this.hooks.get(op);
		if (h) await h(args);
	}

	private view(c: FC): RecreateContainer {
		const { starts: _s, ...v } = c;
		return { ...v, labels: { ...v.labels }, mounts: [...v.mounts] };
	}

	async inspect(ref: string) {
		await this.gate("inspect", [ref]);
		const c = this.byRef(ref);
		return c ? this.view(c) : null;
	}
	async changes(id: string) {
		await this.gate("changes", [id]);
		return this.changesOf.get(id) ?? cleanChanges();
	}
	async statPath(id: string, p: string): Promise<PathStat | null> {
		await this.gate("statPath", [id, p]);
		return cleanStats().get(p) ?? null;
	}
	async readArchive(id: string, p: string) {
		await this.gate("readArchive", [id, p]);
		const c = this.byRef(id);
		if (!c) throw httpError(404);
		if (p === SKILLS_IMAGE_DIR) {
			const skills = this.skillsByImage.get(c.imageId);
			if (!skills) return null;
			return buildTar([
				{ path: "session-skills/", type: "dir" },
				...Object.entries(skills).map(([rel, data]) => ({ path: `session-skills/${rel}`, data })),
			]);
		}
		const g = this.gitconfig.get(id);
		return g === undefined ? null : buildTar([{ path: ".gitconfig", data: g }]);
	}
	async currentImage() {
		await this.gate("currentImage", []);
		return this.current;
	}
	async buildCreate(_sid: string, spec: RecreateCreateSpec) {
		return { spec };
	}
	async create(options: object) {
		const { spec } = options as { spec: RecreateCreateSpec };
		await this.gate("create", [spec.name]);
		if (this.byRef(spec.name)) throw httpError(409, "name in use");
		const id = `n${++this.seq}`.padEnd(64, "0");
		this.containers.set(id, {
			id,
			name: spec.name,
			running: false,
			imageId: spec.imageId,
			labels: { ...spec.labels },
			mounts: [
				"/home/developer/workspace",
				"/home/developer/uploads",
				"/etc/claude-code/managed-settings.d",
				"/etc/st-control",
			],
			starts: 0,
		});
		return id;
	}
	async rename(id: string, name: string) {
		await this.gate("rename", [id, name]);
		const c = this.byRef(id);
		if (!c) throw httpError(404);
		const holder = this.byRef(name);
		if (holder && holder.id !== c.id) throw httpError(409, "name in use");
		c.name = name;
	}
	async start(id: string) {
		await this.gate("start", [id]);
		const c = this.byRef(id);
		if (!c) throw httpError(404);
		c.running = true;
		c.starts++;
	}
	async stop(id: string) {
		await this.gate("stop", [id]);
		const c = this.byRef(id);
		if (!c) throw httpError(404);
		c.running = false;
	}
	async remove(id: string) {
		await this.gate("remove", [id]);
		const c = this.byRef(id);
		if (!c) throw httpError(404);
		if (c.running) throw httpError(409, "running");
		this.onRemove(c.id);
		this.containers.delete(c.id);
	}
	async listByLabel(key: string, value?: string) {
		await this.gate("listByLabel", [key, value ?? ""]);
		return [...this.containers.values()]
			.filter((c) => key in c.labels && (value === undefined || c.labels[key] === value))
			.map((c) => this.view(c));
	}
	async listByName(fragment: string) {
		await this.gate("listByName", [fragment]);
		return [...this.containers.values()]
			.filter((c) => c.name.includes(fragment))
			.map((c) => this.view(c));
	}
	readonly execs: string[][] = [];
	/**
	 * Per exec: what dockerd reports now. A test that makes an exec's exit
	 * unknown (`unknownExit`) flips its entry to ended when it wants the
	 * evidence to appear.
	 */
	readonly execStates = new Map<string, { running: boolean; exitCode: number | null }>();
	/** Commands (first argv word, or "readiness" for `test -f`) whose exit is reported unknown. */
	readonly unknownExit = new Set<string>();
	private execSeq = 0;
	async exec(
		containerId: string,
		cmd: string[],
		_timeoutMs?: number,
		mayAct?: () => boolean,
	): Promise<ExecResult> {
		await this.gate("exec", [containerId, cmd.join(" ")]);
		// As the real port: a create answered too late starts nothing.
		if (mayAct && !mayAct()) throw new Error("exec not started: the caller may no longer act");
		this.execs.push([containerId, ...cmd]);
		const execId = `exec-${++this.execSeq}`;
		const c = this.byRef(containerId);
		const key = cmd[0] === "test" ? "readiness" : (cmd[0] as string);
		if (c?.running && this.unknownExit.has(key)) {
			this.execStates.set(execId, { running: true, exitCode: null });
			return { exitCode: null, stdout: "", execId };
		}
		const exitCode = c?.running ? 0 : 1;
		this.execStates.set(execId, { running: false, exitCode });
		if (!c?.running) return { exitCode: 1, stdout: "", execId };
		if (cmd[0] === "claude") return { exitCode: 0, stdout: "2.1.310 (Claude Code)\n", execId };
		return { exitCode: 0, stdout: "", execId };
	}
	async execState(execId: string) {
		await this.gate("execState", [execId]);
		return this.execStates.get(execId) ?? null;
	}
	/**
	 * Every exec whose exit was unknown now reports it ended — or, with
	 * `null`, reports `Running: false` without an exit code (still unknown).
	 */
	endUnknownExecs(exitCode: number | null = 0) {
		for (const [id, st] of this.execStates) {
			if (st.running || st.exitCode === null) this.execStates.set(id, { running: false, exitCode });
		}
	}

	/** Effectful requests (what a refused begin() must never reach). */
	mutations(): string[] {
		return this.log.filter((l) => /^(create|rename|start|stop|remove|exec):/.test(l));
	}
}

export function cleanStats(): Map<string, PathStat> {
	const m = new Map<string, PathStat>();
	for (const [link, target] of ENTRYPOINT_SYMLINKS)
		m.set(link, { kind: "symlink", linkTarget: target });
	for (const d of ["/home", "/home/developer", "/tmp", "/home/developer/.config"]) {
		m.set(d, { kind: "dir" });
	}
	m.set("/tmp/.st-ready", { kind: "file" });
	return m;
}

export function cleanChanges(): LayerChange[] {
	return [
		{ Path: "/home", Kind: 0 },
		{ Path: "/home/developer", Kind: 0 },
		...[...ENTRYPOINT_SYMLINKS.keys()].map((p) => ({ Path: p, Kind: 1 })),
		{ Path: "/home/developer/.config", Kind: 1 },
		{ Path: "/tmp", Kind: 0 },
		{ Path: "/tmp/.st-ready", Kind: 1 },
	];
}

export class FakeD1 implements RecreateD1Port {
	row: RecreateSessionRow & { ingest_token_hash: string | null } = {
		status: "stopped",
		container_id: O_ID,
		container_name: CANONICAL,
		conversation_requested: 1,
		ingest_token_hash: "H-old",
	};
	config: RecreateSessionConfig = {
		ports: [{ container: 3000, public: false }],
		gitIdentity: null,
		hasDotfiles: false,
		postStartCmd: null,
	};
	casMode: "normal" | "ambiguous-applied" | "ambiguous-not" | "rejected" = "normal";
	readonly writes: string[] = [];
	async getRow() {
		const { ingest_token_hash: _h, ...r } = this.row;
		return { ...r };
	}
	async sessionIdByContainerName(name: string) {
		return name === this.row.container_name ? SID : null;
	}
	async cas(_sid: string, o: string, n: string, hash: string): Promise<CasResult> {
		this.writes.push("cas");
		if (this.casMode === "rejected") return "not-applied";
		const applies = this.row.container_id === o && this.row.conversation_requested === 1;
		if (this.casMode === "ambiguous-not") return "ambiguous";
		if (applies) {
			this.row.container_id = n;
			this.row.ingest_token_hash = hash;
		}
		if (this.casMode === "ambiguous-applied") return "ambiguous";
		return applies ? "applied" : "not-applied";
	}
	async getConfig() {
		return this.config;
	}
	async setStatus(_sid: string, status: "running" | "stopped") {
		this.writes.push(`status=${status}`);
		this.row.status = status;
	}
	async setPorts(_sid: string, ports: RecreateSessionConfig["ports"]) {
		this.writes.push(`ports=${ports.length}`);
	}
}

export class FakeCapture implements RecreateCapturePort {
	enabled = true;
	revocation: "none" | "session" | "global" = "none";
	deferSeed = false;
	marker = false;
	hooksFile = false;
	readonly calls: string[] = [];
	/** Runs inside authorize, with the attempt's run (to hang a probe etc.). */
	authorizeImpl: (run: AttemptRun) => Promise<CaptureBlock | null> = async (run) => {
		if (run.epochOpen) {
			this.marker = true;
			this.hooksFile = true;
		}
		return {
			requested: true,
			effective: run.epochOpen,
			effectiveAfterRestart: true,
			requiresRecreate: false,
			pendingReasons: [],
			checkedAt: new Date().toISOString(),
		};
	};
	constructor(private readonly d1: FakeD1) {}
	async checkRevocation() {
		return this.revocation;
	}
	async prepare() {
		this.calls.push("prepare");
		this.deferSeed = true;
		this.marker = false;
		this.hooksFile = false;
		return {
			env: ["ST_INGEST_TOKEN=t"],
			binds: ["m:/etc/claude-code/managed-settings.d:ro"],
			hash: "H-new",
		};
	}
	async snapshot() {
		return { marker: this.marker, hooksFile: this.hooksFile };
	}
	async restore(_sid: string, snap: { marker: boolean; hooksFile: boolean }) {
		this.calls.push("restore");
		if (!snap.marker || !snap.hooksFile) return "not-authorized";
		if (this.d1.row.conversation_requested !== 1 || this.revocation !== "none") {
			return "not-authorized";
		}
		this.marker = true;
		this.hooksFile = true;
		return "restored";
	}
	async authorize(_sid: string, run: AttemptRun) {
		this.calls.push(`authorize(epochOpen=${run.epochOpen})`);
		return this.authorizeImpl(run);
	}
	/** Runs inside converge (to hold it, or fail it). */
	convergeImpl: () => Promise<string> = async () => "kept";
	async converge() {
		this.calls.push("converge");
		const r = await this.convergeImpl();
		this.calls.push("converge done");
		return r;
	}
	async deferSeedExists() {
		return this.deferSeed;
	}
	async removeDeferSeed() {
		this.calls.push("removeDeferSeed");
		this.deferSeed = false;
	}
}

export const FAST: Partial<RecreateConfig> = {
	tRecMs: 600,
	tRbMs: 300,
	tD1Ms: 80,
	readinessMs: 200,
	readinessPollMs: 5,
	preconditionMs: 300,
	resolveRetryMs: 40,
};

export async function harness(opts: { config?: Partial<RecreateConfig>; root?: string } = {}) {
	const root = opts.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "st-recreate-")));
	await fs.mkdir(path.join(root, SID, ".npm-global"), { recursive: true });
	const docker = new FakeDocker();
	const d1 = new FakeD1();
	const capture = new FakeCapture(d1);
	const attempts = new RecreateAttemptStore(root);
	const lock = new SessionLifecycleLock();
	lock.setGuard((sid) => attempts.assertResolved(sid));
	const workspaceSkills = new Map<string, WorkspaceSkill>();
	/** The workspace CLI N would run (control-marker-incompatible). */
	const cli: { version: string | null } = { version: "2.1.308" };
	docker.onRemove = (id) => {
		if (d1.row.container_id === id) throw new Error(`removed the container D1 points at (${id})`);
	};
	const engine = new RecreationEngine({
		workspaceRoot: root,
		docker,
		d1,
		attempts,
		lock,
		capture,
		readWorkspaceSkill: async (_sid, rel) => workspaceSkills.get(rel) ?? { kind: "absent" },
		readCliVersion: async () => cli.version,
		config: { ...FAST, ...opts.config },
	});
	return { root, docker, d1, capture, attempts, lock, engine, workspaceSkills, cli };
}

/** What "identical to the previous state" compares (§10: D1, names, hash, files, markers, ports). */
export function stateOf(h: Awaited<ReturnType<typeof harness>>) {
	return {
		row: { ...h.d1.row },
		containers: [...h.docker.containers.values()]
			.map((c) => `${c.id.slice(0, 4)}:${c.name}:${c.running ? "up" : "down"}`)
			.sort(),
		deferSeed: h.capture.deferSeed,
		marker: h.capture.marker,
		hooksFile: h.capture.hooksFile,
		portWrites: h.d1.writes.filter((w) => w.startsWith("ports")),
	};
}
