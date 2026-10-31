/**
 * recreate/engine.ts — administrative recreation of a stopped session's
 * container (CONVERSATION.md §2.7, contract v1.6; owner decisions D1–D8).
 *
 * The shape, in one paragraph: under the session's lifecycle lock
 * (`recreate` never waits), check every precondition without effects;
 * write the durable `open` attempt record BEFORE the first effect (a
 * refused `begin()` ends the operation there); prepare N without starting
 * it; swap the names; re-check that O is still stopped and start N; then
 * commit with ONE D1 statement that moves `container_id` and the
 * authorized hash together. Before that commit any failure rolls back to
 * exactly the previous state; after it nothing is reverted and everything
 * converges on N.
 *
 * What makes it safe is not the happy path but the rules around time
 * (§2.7.4), implemented by `AttemptRun`:
 *   - Docker requests are never aborted. Deadlines (T_rec, T_rb) only stop
 *     the waiting and close the epoch; a late answer is recorded as
 *     evidence and its continuation does nothing.
 *   - An attempt is `resolved` only on evidence: every Docker request it
 *     made has answered, D1 is definitive (T_d1 after an ambiguous CAS),
 *     and the final action of the resolution table was done and observed
 *     again. Otherwise it is `uncertain`, and every incompatible lifecycle
 *     verb answers `recreate-unresolved` through the lock's guard.
 *   - Only the process that began an attempt can resolve it. After a
 *     backend restart nothing resolves it automatically (D8): the boot
 *     pass here only removes leftovers of RESOLVED attempts.
 *   - Nothing ever removes the container D1 points at.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RecreateCapturePrep } from "../conversation/activation.js";
import { type CaptureBlock, CONTROL_MOUNT_TARGET } from "../conversation/captureAuth.js";
import type { RevocationState } from "../conversation/revocation.js";
import { logger } from "../logger.js";
import {
	type AttemptOutcome,
	type RecreateAttemptStore,
	RecreateUnresolvedError,
	type RetainedContainer,
	SESSION_ID_RE,
} from "../recreateAttempt.js";
import { SessionBusyError, type SessionLifecycleLock } from "../sessionLifecycleLock.js";
import {
	type CarryPlan,
	carryBudgetMs,
	carryDestination,
	planCarry,
	requiredFreeBytes,
} from "./carry.js";
import { CONTROL_MARKER_VALIDATED_CLI, readWorkspaceCliVersion } from "./cliCompat.js";
import type { RecreateD1Port, RecreateSessionConfig, RecreateSessionRow } from "./d1.js";
import {
	CLI_URL_HANDLER,
	CLI_URL_HANDLER_BYTES,
	classifyLayer,
	GITCONFIG,
	GITCONFIG_MAX_BYTES,
	type LayerVerdict,
} from "./layer.js";
import {
	type ExecResult,
	isNotFound,
	LABEL_ATTEMPT,
	LABEL_RECREATE_OF,
	LABEL_SESSION,
	RESERVED_NAME_RE,
	type RecreateContainer,
	type RecreateDockerPort,
} from "./ports.js";
import { AttemptRun, EpochClosedError } from "./run.js";
import {
	compareSkills,
	readWorkspaceSkill,
	SKILLS_ARCHIVE_MAX_BYTES,
	SKILLS_IMAGE_DIR,
	type SkillSet,
	skillSetFromTar,
	type WorkspaceSkill,
} from "./skills.js";
import { parseTar } from "./tar.js";

// ── Configuration ───────────────────────────────────────────────────────────

export interface RecreateConfig {
	/** From the lock to the end of step 6, post-commit steps included. */
	tRecMs: number;
	/** Rollback budget. T_rec + T_rb is the lock's wait cap (6 min). */
	tRbMs: number;
	/** After an ambiguous CAS: when a re-read of the row is definitive (D1 only). */
	tD1Ms: number;
	readinessMs: number;
	readinessPollMs: number;
	/** How long the effect-free precondition reads may take before 503. */
	preconditionMs: number;
	/** Re-observation interval of an in-process resolution that could not confirm yet. */
	resolveRetryMs: number;
	/** Carry-over (§2.7.7): throughput assumed for the copy's time budget, and the budget's cap. */
	carryBytesPerSec: number;
	carryCapMs: number;
	/** A carry-over needs a backup of the session's workspace newer than this. */
	backupMaxAgeMs: number;
}

/**
 * T_d1: the D1 client cuts a statement at 10 s (db.ts) and Cloudflare
 * documents 30 s as the longest a D1 query may run, so 60 s after sending,
 * a statement can no longer apply and a re-read is final.
 */
export const DEFAULT_RECREATE_CONFIG: RecreateConfig = {
	tRecMs: 5 * 60_000,
	tRbMs: 60_000,
	tD1Ms: 60_000,
	readinessMs: 60_000,
	readinessPollMs: 500,
	preconditionMs: 30_000,
	resolveRetryMs: 30_000,
	carryBytesPerSec: 20 * 1024 * 1024,
	carryCapMs: 60 * 60_000,
	backupMaxAgeMs: 24 * 60 * 60_000,
};

export const CLI_MIN_VERSION = "2.1.308";
// Blockers that end a preflight before the expensive checks (6–8): see
// the comment at their use in evaluate(). recreate-unresolved is passed in
// separately (the D8 gate is read before evaluate).
const PREFLIGHT_TERMINAL_BLOCKERS: ReadonlySet<string> = new Set([
	"no-container",
	"running",
	"flag-off",
]);

const SEED_SCRIPT = "/opt/st/seed-skills.sh";
const READY_SENTINEL = "/tmp/.st-ready";

// ── Public shapes ───────────────────────────────────────────────────────────

export type RecreateStep = "prepare" | "rename" | "start" | "commit";

export interface Blocker {
	code: string;
	count?: number;
}

export interface CarryPreview {
	entries: number;
	/** O's writable-layer size (what the copy is budgeted on), null when the daemon does not report it. */
	bytes: number | null;
	skipped: CarryPlan["skipped"];
	/** Free bytes on the Docker data-root filesystem (`diskMeasuredAt`), null when not measurable. */
	diskFreeBytes: number | null;
	/** The path that was measured (`RECREATE_DOCKER_FS_PATH`), null when unset. */
	diskMeasuredAt: string | null;
	diskRequiredBytes: number | null;
	backupFresh: boolean | null;
}

export interface PreflightResult {
	recreatable: boolean;
	blockers: Blocker[];
	/** O's image. */
	imageId: string | null;
	/** What a recreation would use now (inspect of the session image tag). */
	currentImageId: string | null;
	/** Capture would be requested-and-allowed on N (preconditions 4 and 5). */
	captureAfter: boolean;
	/** With `preserve`: what the carry-over would copy and the resources it needs (§2.7.7). */
	carry?: CarryPreview;
	/** A container kept by the last committed carry-over or rollback, awaiting approval. */
	retained?: RetainedContainer;
}

export type RecreateResult =
	| {
			ok: true;
			outcome: "committed";
			nContainerId: string;
			capture: CaptureBlock | null;
			cliVersion: string | null;
			warnings: string[];
			/** Step-6 items not done (failed, or abandoned when T_rec ran out). */
			incomplete: string[];
			/**
			 * Not converged yet: requests still in flight, execs whose exit is
			 * unknown, or step-6 convergence left to do. The record stays
			 * uncertain until the resolution has done and checked it.
			 */
			unresolved?: true;
			/** What the record is waiting on, by name. */
			pending?: string[];
			/** Carry-over (§2.7.7): what was copied, and the container kept until approval. */
			carried?: { entries: number; bytes: number };
			retained?: RetainedContainer;
	  }
	| { ok: false; status: 404; code: "not-found" }
	| { ok: false; status: 409; code: string; blockers?: Blocker[]; step?: RecreateStep }
	| {
			ok: false;
			status: 500;
			code: "recreate-failed";
			step: RecreateStep | "record";
			unresolved?: true;
	  }
	| { ok: false; status: 503; code: "docker-unavailable" };

/** `approve`, `rollback` and `recover` (§2.7.7) answer with one of these. */
export type AdminOpResult =
	| { ok: true; status: 200; body: Record<string, unknown> }
	| { ok: false; status: 404 | 409 | 500 | 503; code: string; detail?: string };

export interface RecreateCapturePort {
	enabled: boolean;
	checkRevocation(sessionId: string): Promise<RevocationState>;
	/**
	 * Every operation below with more than one effect takes `mayAct`: it is
	 * asked before each effect, so a continuation that outlives the epoch
	 * or the resolution's lease (or the engine's shutdown) starts nothing
	 * new. What was already issued stays tracked by the caller.
	 *
	 * Step 1's capture side: token, H, defer-skill-seed, leftovers removed.
	 */
	prepare(sessionId: string, mayAct: () => boolean): Promise<RecreateCapturePrep>;
	/** Which capture files exist now (to restore them on a rollback). */
	snapshot(sessionId: string): Promise<{ marker: boolean; hooksFile: boolean }>;
	/**
	 * Rollback of an O created by 3.0d: put back the pair `snapshot` saw,
	 * only while RETAIN authorization still holds for O, rechecking after
	 * each write (a disable during either write wins).
	 */
	restore(
		sessionId: string,
		snap: { marker: boolean; hooksFile: boolean },
		oContainerId: string,
		mayAct: () => boolean,
	): Promise<string>;
	/** Step 5 on N, bound to the attempt's epoch; returns the `capture` block. */
	authorize(sessionId: string, run: AttemptRun): Promise<CaptureBlock | null>;
	/**
	 * The §2.7.5 convergence on N, on behalf of the attempt (the gate is
	 * not consulted: it runs BEFORE the record is resolved, under the
	 * session's lock). Throws when it could not be done.
	 */
	converge(sessionId: string, mayAct: () => boolean): Promise<string>;
	/**
	 * Whether the capture files match what authorization allows NOW: both
	 * on a running container with write authorization, both or neither on
	 * a stopped one with retain authorization, neither otherwise. Read-only;
	 * checked before `resolved` (E6) — `converge`'s answer is not enough.
	 */
	converged(sessionId: string): Promise<boolean>;
	deferSeedExists(sessionId: string): Promise<boolean>;
	removeDeferSeed(sessionId: string): Promise<void>;
}

export interface RecreationDeps {
	workspaceRoot: string;
	docker: RecreateDockerPort;
	d1: RecreateD1Port;
	attempts: RecreateAttemptStore;
	lock: SessionLifecycleLock;
	capture: RecreateCapturePort;
	readWorkspaceSkill?: (sessionId: string, rel: string) => Promise<WorkspaceSkill>;
	/** The workspace CLI's version (cliCompat.ts); null when unreadable. */
	readCliVersion?: (sessionId: string) => Promise<string | null>;
	/** Free bytes of the filesystem holding Docker's layers (default: statfs of the workspace root — same disk on the deployment). */
	/**
	 * Free bytes on the filesystem that holds Docker's data root (where N's
	 * layer is written). Default: `statfs(dockerFsPath)`; null when unknown
	 * — which blocks a carry-over (`disk-space-unknown`, fail closed).
	 */
	diskFree?: () => Promise<number | null>;
	/**
	 * A path inside this process's filesystem view that lives on the SAME
	 * filesystem as `DockerRootDir` (`RECREATE_DOCKER_FS_PATH`): the
	 * workspace root when both share a device (VM100: one `/dev/sda1`), or a
	 * read-only bind of a probe directory beside the data root otherwise.
	 * The workspace root is NOT assumed: it is a bind mount that can live
	 * anywhere. Unset ⇒ `diskFree` answers null.
	 */
	dockerFsPath?: string | null;
	/** A backup of this session's workspace newer than `maxAgeMs` exists (default: a `manifest.json` under `<root>/.backups/<dir>/`). */
	/**
	 * A consistent recovery point exists for the session: a backup manifest
	 * younger than `maxAgeMs`, taken at or after `notBefore` (O's stop, so
	 * the tarball saw no concurrent writes) and without `concurrentChanges`
	 * for the session. Default: `backupFreshIn` over `<root>/.backups`.
	 */
	backupFresh?: (sessionId: string, maxAgeMs: number, notBefore: string | null) => Promise<boolean>;
	config?: Partial<RecreateConfig>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

// ── Internals ───────────────────────────────────────────────────────────────

class DockerUnavailableError extends Error {
	constructor(cause: string) {
		super(`docker unavailable: ${cause}`);
		this.name = "DockerUnavailableError";
	}
}

/**
 * A precondition read of O answered 404: O disappeared after it was first
 * inspected. That is precondition 3 failing, not a Docker outage.
 */
class ContainerVanishedError extends Error {
	constructor(label: string) {
		super(`${label}: container gone`);
		this.name = "ContainerVanishedError";
	}
}

class StepFailure extends Error {
	constructor(
		readonly step: RecreateStep,
		readonly reason: string,
		/** A precondition repeated after effects (precondition 8 against I_N). */
		readonly blockers?: Blocker[],
	) {
		super(`step ${step}: ${reason}`);
		this.name = "StepFailure";
	}
}

/**
 * Whether the code running now holds the session's lifecycle lock. A
 * resolution pass started inside `recreate` holds it through the attempt's
 * own lock; when T_rb lets that lock go the pass loses its lease and
 * stops before its next action, and a later pass takes the lock itself
 * (`recreate-resolve`). Every action of a pass checks it, so no lifecycle
 * verb ever interleaves with the resolution's mutations.
 */
interface Lease {
	held: boolean;
}

class LeaseLostError extends Error {
	constructor() {
		super("resolution no longer holds the session lock");
		this.name = "LeaseLostError";
	}
}

/** An exec whose termination is not known (E1): pending evidence. */
interface UnknownExec {
	label: string;
	containerId: string;
	execId?: string;
}

/** Step-6 items whose absence leaves the session not converged on N. */
const CONVERGENCE_ITEMS = new Set(["authorize", "defer-skill-seed", "ports", "status", "remove O"]);

interface Facts {
	row: RecreateSessionRow;
	o: RecreateContainer;
	image: { imageId: string; relay2: boolean };
	config: RecreateSessionConfig;
	layer: LayerVerdict;
	imageOSkills: SkillSet | null;
	/** Carry-over mode: the plan, and O's layer size the budget was computed on. */
	carry: CarryPlan | null;
	sizeRw: number;
}

/** A carry-over attempt copies before N starts; after the commit O is retained (§2.7.7). */
interface CarryState {
	plan: CarryPlan;
	bytes: number;
	/** Per entry, once its copy answered. */
	carried: Array<{ path: string; bytes: number }>;
}

/** One attempt, from `begin()` to `resolved`. */
interface Attempt {
	sessionId: string;
	attemptId: string;
	oId: string;
	canonical: string;
	run: AttemptRun;
	snapshot: { marker: boolean; hooksFile: boolean };
	/** Set as soon as Docker answers the create, even after the epoch closed. */
	nId: string | null;
	casSentAt: number | null;
	cas: "applied" | "not-applied" | "ambiguous" | null;
	state: "open" | "uncertain" | "resolved";
	/** Record writes of this attempt run one at a time, in order. */
	recordChain: Promise<unknown>;
	resolving: Promise<"resolved" | "pending"> | null;
	retryTimer: ReturnType<typeof setTimeout> | null;
	/** The lock held by `recreate` itself; lost when it returns. */
	lease: Lease;
	unknownExecs: UnknownExec[];
	/** O's `-old-` name (the retained container's name after a committed carry-over). */
	oOldName: string;
	/** Carry-over mode (§2.7.7); null for a strict recreation. */
	carry: CarryState | null;
	/** A post-commit rollback: O and N exchange roles (§2.7.7). */
	reverse: boolean;
	/**
	 * `defer-skill-seed` is gone but no seed exec was issued for N yet: the
	 * resolution seeds (with the marker gone, `deferSeedExists` can't say).
	 */
	seedPending: boolean;
}

type ResolveStep = "resolved" | "retry" | "stuck";

/**
 * One action of a resolution pass (tracked, lease-checked). `mayAct` is the
 * same check, for an action with several effects to ask between them.
 */
type Act = (<T>(label: string, fn: () => Promise<T>) => Promise<T>) & { mayAct: () => boolean };

/**
 * A `manifest.json` under `<root>/.backups/<dir>/` written within `maxAgeMs`
 * whose `workspaces` list this session (the host backup tool, backup.ts).
 * Unreadable or malformed manifests count as absent.
 */
export async function backupFreshIn(
	root: string,
	sessionId: string,
	maxAgeMs: number,
	now: () => number,
	notBefore: string | null = null,
): Promise<boolean> {
	const dir = path.join(root, ".backups");
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return false;
	}
	const floor = notBefore ? Date.parse(notBefore) : Number.NaN;
	for (const n of names) {
		try {
			const raw = await fs.readFile(path.join(dir, n, "manifest.json"), "utf8");
			const m = JSON.parse(raw) as {
				createdAt?: unknown;
				workspaces?: Record<string, { concurrentChanges?: unknown } | undefined>;
			};
			if (typeof m.createdAt !== "string" || !m.workspaces) continue;
			const at = Date.parse(m.createdAt);
			if (Number.isNaN(at) || now() - at > maxAgeMs) continue;
			// Taken while O still ran (before its stop) or with tar reporting
			// concurrent changes: a recovery point, not a consistent snapshot
			// (backup.ts) — not what the one operation that touches a real
			// session may rely on.
			if (!Number.isNaN(floor) && at < floor) continue;
			const entry = m.workspaces[sessionId];
			if (!entry) continue;
			if (entry.concurrentChanges) continue;
			return true;
		} catch {
			// not a backup dir, or unreadable: counts as absent
		}
	}
	return false;
}

function semverLess(a: string, b: string): boolean {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
	}
	return false;
}

export class RecreationEngine {
	private readonly cfg: RecreateConfig;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly readW: (sessionId: string, rel: string) => Promise<WorkspaceSkill>;
	private readonly readCli: (sessionId: string) => Promise<string | null>;
	private readonly diskFree: () => Promise<number | null>;
	private readonly dockerFsPath: string | null;
	private readonly backupFresh: (
		sessionId: string,
		maxAgeMs: number,
		notBefore: string | null,
	) => Promise<boolean>;
	/** Attempts of this process run that are not resolved yet. */
	private readonly attempts = new Map<string, Attempt>();
	private stopped = false;
	readonly stats = { recreateOrphans: 0, leftoversRemoved: 0, reservedNamesSeen: 0 };

	constructor(private readonly deps: RecreationDeps) {
		this.cfg = { ...DEFAULT_RECREATE_CONFIG, ...deps.config };
		this.now = deps.now ?? Date.now;
		this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.readW = deps.readWorkspaceSkill ?? readWorkspaceSkill;
		this.readCli = deps.readCliVersion ?? readWorkspaceCliVersion;
		this.dockerFsPath = deps.dockerFsPath ?? null;
		this.diskFree =
			deps.diskFree ??
			(async () => {
				if (!this.dockerFsPath) return null;
				try {
					const st = await fs.statfs(this.dockerFsPath);
					return Number(st.bavail) * Number(st.bsize);
				} catch {
					return null;
				}
			});
		this.backupFresh =
			deps.backupFresh ??
			((sid, maxAge, notBefore) =>
				backupFreshIn(deps.workspaceRoot, sid, maxAge, this.now, notBefore));
	}

	/** Sessions whose attempt in this process is still unresolved. For stats and tests. */
	unresolvedSessions(): string[] {
		return [...this.attempts.keys()];
	}

	/**
	 * Shutdown: no further resolution acts or is scheduled, and every open
	 * epoch closes — an attempt mid-way does nothing more forward either
	 * (the late answer of its pending request continues nothing). Records
	 * stay as they are; the next process finds them unresolved (D8).
	 */
	stop(): void {
		this.stopped = true;
		for (const a of this.attempts.values()) {
			a.run.close("shutdown");
			if (a.retryTimer) clearTimeout(a.retryTimer);
		}
	}

	// ── Preflight (GET) ─────────────────────────────────────────────────────

	async preflight(
		sessionId: string,
		opts: { preserve?: boolean } = {},
	): Promise<PreflightResult | { status: 404 } | { status: 503 }> {
		try {
			const unresolved = await this.deps.attempts
				.assertResolved(sessionId)
				.then(() => false)
				.catch((err) => {
					if (err instanceof RecreateUnresolvedError) return true;
					throw err;
				});
			const r = await this.evaluate(sessionId, null, "all", unresolved, !!opts.preserve);
			if (r === "not-found") return { status: 404 };
			const blockers = unresolved ? [{ code: "recreate-unresolved" }, ...r.blockers] : r.blockers;
			const rec = await this.deps.attempts.read(sessionId);
			const retained =
				rec.kind === "ok" && rec.record.state === "resolved" ? (rec.record.retained ?? null) : null;
			return {
				recreatable: blockers.length === 0,
				blockers,
				imageId: r.imageId,
				currentImageId: r.currentImageId,
				captureAfter: r.captureAfter,
				...(r.carry ? { carry: r.carry } : {}),
				...(retained ? { retained } : {}),
			};
		} catch (err) {
			if (err instanceof DockerUnavailableError) return { status: 503 };
			if (err instanceof ContainerVanishedError) {
				return {
					recreatable: false,
					blockers: [{ code: "container-missing" }],
					imageId: null,
					currentImageId: null,
					captureAfter: false,
				};
			}
			throw err;
		}
	}

	// ── Recreate (POST) ─────────────────────────────────────────────────────

	/**
	 * `beforeEffects` runs under the lock once every precondition passed,
	 * before the durable record — the first effect. The admin route's
	 * cross-user `operate` audit row goes there (§2.7.2): fail-closed (a
	 * throw aborts with nothing done), and a refused request leaves none.
	 */
	async recreate(
		sessionId: string,
		expectImageId: string,
		opts: { beforeEffects?: () => Promise<void>; preserve?: boolean } = {},
	): Promise<RecreateResult> {
		try {
			const lease: Lease = { held: true };
			return await this.deps.lock.run(
				sessionId,
				"recreate",
				async () => {
					try {
						return await this.recreateLocked(
							sessionId,
							expectImageId,
							this.now(),
							lease,
							opts.beforeEffects,
							!!opts.preserve,
						);
					} finally {
						// Before the lock is released: a pass still running on this
						// lease stops before its next action.
						lease.held = false;
					}
				},
				{ mode: "fail" },
			);
		} catch (err) {
			if (err instanceof SessionBusyError) return { ok: false, status: 409, code: "busy" };
			if (err instanceof RecreateUnresolvedError) {
				return { ok: false, status: 409, code: "recreate-unresolved" };
			}
			throw err;
		}
	}

	private async recreateLocked(
		sessionId: string,
		expectImageId: string,
		lockedAt: number,
		lease: Lease,
		beforeEffects?: () => Promise<void>,
		preserve = false,
	): Promise<RecreateResult> {
		// ── Preconditions 2–8, first failure wins, no effects ──
		let facts: Facts;
		try {
			const r = await this.evaluate(sessionId, expectImageId, "first", false, preserve);
			if (r === "not-found") return { ok: false, status: 404, code: "not-found" };
			if (r.blockers.length > 0) {
				const first = r.blockers[0] as Blocker;
				return { ok: false, status: 409, code: first.code, blockers: [first] };
			}
			facts = r.facts as Facts;
		} catch (err) {
			if (err instanceof DockerUnavailableError) {
				return { ok: false, status: 503, code: "docker-unavailable" };
			}
			if (err instanceof ContainerVanishedError) {
				return {
					ok: false,
					status: 409,
					code: "container-missing",
					blockers: [{ code: "container-missing" }],
				};
			}
			throw err;
		}

		// Carry-over (§2.7.7): the copy gets its own time, budgeted on O's
		// layer size at a conservative throughput, inside this attempt's T_rec.
		const tRecMs = facts.carry
			? carryBudgetMs(facts.sizeRw, this.cfg.tRecMs, this.cfg.carryBytesPerSec, this.cfg.carryCapMs)
			: this.cfg.tRecMs;

		// Still nothing done: a throw here propagates with no record and no effect.
		if (beforeEffects) await beforeEffects();
		// The wait above (the route's audit row) is invisible to `stop()`: no
		// attempt exists yet to close. A late answer must not start a
		// recreation after a shutdown, past T_rec, or without the lock (#464 R2).
		const notNow = this.stopped
			? "shutting down"
			: !lease.held
				? "lock lost"
				: this.now() >= lockedAt + tRecMs
					? "T_rec expired"
					: null;
		if (notNow) {
			logger.warn(`[recreate] ${sessionId}: not started (${notNow}); nothing done`);
			return { ok: false, status: 500, code: "recreate-failed", step: "prepare" };
		}

		// ── The durable record, before the first effect ──
		const attemptId = randomUUID();
		const ts = String(this.now());
		const canonical = facts.row.container_name;
		const identity = {
			attemptId,
			oContainerId: facts.o.id,
			oCanonicalName: canonical,
			oOldName: `${canonical}-old-${ts}`,
			nTempName: `${canonical}-new-${ts}`,
		};
		try {
			await this.deps.attempts.begin(
				sessionId,
				identity,
				facts.carry
					? { preserve: { entries: facts.carry.entries.length, bytes: facts.sizeRw } }
					: {},
			);
		} catch (err) {
			// A refused begin() stops everything: not one effect has been
			// issued. If the write failed after its rename, an `open` record
			// owned by this process may be on disk; having done nothing is
			// the evidence that lets it be resolved as rolled back — unless
			// the engine is shutting down: no durable transition starts after
			// `stop()` (E5); the next process finds the record and D8 applies.
			logger.error(`[recreate] ${sessionId}: begin refused: ${(err as Error).message}`);
			if (err instanceof RecreateUnresolvedError) {
				return { ok: false, status: 409, code: "recreate-unresolved" };
			}
			if (!this.stopped) {
				await this.deps.attempts
					.resolve(sessionId, attemptId, { kind: "rolled-back" }, "begin failed; no effects")
					.catch(() => undefined);
			}
			// The answer says `unresolved` unless it is CONFIRMED that this
			// attempt left no record or that its record is resolved: an `open`
			// one (always the case after a shutdown, which writes nothing more)
			// gates the session like any unresolved attempt (#464 R2). Reading
			// is not a transition, so it is allowed after `stop()` too.
			const settled = await this.deps.attempts.read(sessionId).then(
				(r) => r.kind === "none" || (r.kind === "ok" && r.record.state === "resolved"),
				() => false,
			);
			return settled
				? { ok: false, status: 500, code: "recreate-failed", step: "record" }
				: { ok: false, status: 500, code: "recreate-failed", step: "record", unresolved: true };
		}

		const a: Attempt = {
			sessionId,
			attemptId,
			oId: facts.o.id,
			canonical,
			run: new AttemptRun(lockedAt + tRecMs, { now: this.now }),
			snapshot: { marker: false, hooksFile: false },
			nId: null,
			casSentAt: null,
			cas: null,
			state: "open",
			recordChain: Promise.resolve(),
			resolving: null,
			retryTimer: null,
			lease,
			unknownExecs: [],
			seedPending: false,
			oOldName: identity.oOldName,
			carry: facts.carry ? { plan: facts.carry, bytes: facts.sizeRw, carried: [] } : null,
			reverse: false,
		};
		this.attempts.set(sessionId, a);
		logger.info(
			`[recreate] ${sessionId}: attempt ${attemptId} open (O ${facts.o.id.slice(0, 12)}` +
				(a.carry
					? `, carry-over of ${a.carry.plan.entries.length} entries, ${a.carry.bytes} B`
					: "") +
				")",
		);
		if (this.stopped) {
			// `stop()` ran while the record was being written, so it could not
			// close this epoch. Nothing is issued: no Docker request, and no
			// further record write — the `open` record stays as the durable
			// truth and the next process treats it as D8 says (fail-closed).
			a.run.close("shutdown");
			logger.warn(`[recreate] ${sessionId}: shut down while opening the attempt; nothing done`);
			return { ok: false, status: 500, code: "recreate-failed", step: "prepare", unresolved: true };
		}

		// ── Steps 1–4; any failure before the commit rolls back ──
		let hash: string;
		try {
			hash = await this.prepare(a, facts, identity.nTempName);
			await this.swapNames(a, identity.oOldName);
			await this.startN(a);
		} catch (err) {
			return this.rollback(a, err);
		}

		// ── Step 4: commit, one statement ──
		const nId = a.nId as string;
		if (!a.run.epochOpen || a.run.remaining() <= 0) {
			a.run.close("T_rec");
			return this.rollback(a, new StepFailure("commit", "T_rec expired before the commit"));
		}
		a.casSentAt = this.now();
		// D1's own rule (§2.7.4): the client cuts the statement at 10 s and
		// the outcome is classified, never waited on past that. Tracked so
		// no resolution pass runs while it is out.
		a.cas = await a.run.untimed("d1 commit", () => this.deps.d1.cas(sessionId, a.oId, nId, hash));
		if (a.cas === "not-applied") {
			return this.rollback(a, new StepFailure("commit", "CAS matched 0 rows"));
		}
		if (a.cas === "ambiguous") {
			// The statement may still apply. No rollback may remove N: the
			// row is re-read only once it can no longer change (T_d1).
			a.run.close("ambiguous commit");
			await this.markUncertain(a, "ambiguous commit; D1 re-read after T_d1");
			void this.runResolution(a);
			return { ok: false, status: 500, code: "recreate-failed", step: "commit", unresolved: true };
		}

		// ── Point of no return: everything below converges on N ──
		return this.complete(a, facts, nId);
	}

	// ── Preconditions ───────────────────────────────────────────────────────

	private async bounded<T>(label: string, p: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				p.catch((err) => {
					if (isNotFound(err)) throw new ContainerVanishedError(label);
					throw new DockerUnavailableError(`${label}: ${(err as Error).message}`);
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new DockerUnavailableError(`${label}: no answer`)),
						this.cfg.preconditionMs,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async evaluate(
		sessionId: string,
		expectImageId: string | null,
		mode: "first" | "all",
		unresolved = false,
		preserve = false,
	): Promise<
		| "not-found"
		| {
				blockers: Blocker[];
				facts?: Facts;
				imageId: string | null;
				currentImageId: string | null;
				captureAfter: boolean;
				carry?: CarryPreview;
		  }
	> {
		const blockers: Blocker[] = [];
		const done = () => mode === "first" && blockers.length > 0;
		const row = await this.deps.d1.getRow(sessionId);
		if (!row) return "not-found";
		const out = (extra: Partial<{ imageId: string | null; currentImageId: string | null }>) => ({
			blockers,
			imageId: extra.imageId ?? null,
			currentImageId: extra.currentImageId ?? null,
			captureAfter: false,
		});

		// 2. The session and its container id.
		if (row.status === "failed" || row.status === "terminated" || !row.container_id) {
			blockers.push({ code: "no-container" });
			if (done() || !row.container_id) return out({});
		}
		// 3. O exists and is stopped.
		const o = await this.bounded("inspect O", this.deps.docker.inspect(row.container_id as string));
		if (!o) {
			blockers.push({ code: "container-missing" });
			return out({});
		}
		// 3b. No container retained by the previous carry-over or rollback
		// (§2.7.7): a further attempt would make the record forget it —
		// an unreferenced 4–12 GB container and no way back. `approve`
		// first (or `rollback`, then `approve`).
		const prev = await this.deps.attempts.read(sessionId);
		if (prev.kind === "ok" && prev.record.state === "resolved" && prev.record.retained) {
			blockers.push({ code: "retained-pending" });
			if (done()) return out({ imageId: o.imageId });
		}
		if (o.running) {
			blockers.push({ code: "running" });
			if (done()) return out({ imageId: o.imageId });
		}
		// 4. The image, by immutable ID (D6).
		const image = await this.bounded("inspect image", this.deps.docker.currentImage());
		if (!image || (expectImageId !== null && image.imageId !== expectImageId)) {
			blockers.push({ code: "image-changed" });
		} else if (!image.relay2) {
			blockers.push({ code: "image-without-relay" });
		}
		if (done()) return out({ imageId: o.imageId, currentImageId: image?.imageId ?? null });
		// 5. Capture.
		const revocation = await this.deps.capture.checkRevocation(sessionId);
		const captureBlockers: Blocker[] = [];
		if (!this.deps.capture.enabled) captureBlockers.push({ code: "flag-off" });
		if (row.conversation_requested !== 1) captureBlockers.push({ code: "not-requested" });
		if (revocation !== "none") captureBlockers.push({ code: "revoked" });
		blockers.push(...captureBlockers);
		const captureAfter = captureBlockers.length === 0 && !!image?.relay2;
		let carryPreview: CarryPreview | undefined;
		const result = (facts?: Facts) => ({
			blockers,
			facts,
			imageId: o.imageId,
			currentImageId: image?.imageId ?? null,
			captureAfter,
			...(carryPreview ? { carry: carryPreview } : {}),
		});
		if (done()) return result();
		// Preflight of a session that cannot become recreatable without an
		// operator first changing something outside it (stop it, turn the
		// flag on, resolve D8): the cheap blockers above are the answer, and
		// 6–8 are skipped. They are what is slow on a RUNNING container — one
		// sequential Docker stat per changed layer path, thousands with a
		// live CLI — and the POST evaluates them anyway, in full, once these
		// clear. Fixable blockers (not-requested, revoked, image-*) still get
		// the full list, so a stopped candidate shows everything at once.
		if (
			mode === "all" &&
			(unresolved || blockers.some((b) => PREFLIGHT_TERMINAL_BLOCKERS.has(b.code)))
		) {
			return result();
		}
		// 6. The layer.
		const config = await this.deps.d1.getConfig(sessionId);
		const changes = await this.bounded("changes O", this.deps.docker.changes(o.id));
		let layer: LayerVerdict;
		let carry: CarryPlan | null = null;
		let sizeRw = 0;
		if (preserve) {
			// Carry-over (§2.7.7): HOME and /tmp entries are copied instead of
			// blocking; only system changes and deletions block. The copy's
			// resources are preconditions too: free disk and a fresh backup.
			carry = await planCarry({
				changes,
				mounts: o.mounts,
				stat: (p) => this.bounded("stat O", this.deps.docker.statPath(o.id, p)),
			});
			layer = { blockers: [], reapplyGitIdentity: false };
			blockers.push(...carry.blockers);
			const size = await this.bounded("size O", this.deps.docker.sizeRw(o.id));
			sizeRw = size ?? 0;
			// `SizeRw` is the apparent size of O's upper dir; the copy lands as
			// a new upper dir on the Docker data-root filesystem, so what must
			// be free is there — never assumed to be the workspace's device.
			// Unknown free space is a blocker of its own (fail closed).
			const free = await this.diskFree();
			const required = size === null ? null : requiredFreeBytes(size);
			if (size === null) blockers.push({ code: "layer-size-unknown" });
			else if (free === null) blockers.push({ code: "disk-space-unknown" });
			else if (free < (required as number)) blockers.push({ code: "disk-space" });
			const fresh = await this.backupFresh(sessionId, this.cfg.backupMaxAgeMs, o.finishedAt);
			if (!fresh) blockers.push({ code: "backup-stale" });
			carryPreview = {
				entries: carry.entries.length,
				bytes: size,
				skipped: carry.skipped,
				diskFreeBytes: free,
				diskMeasuredAt: this.dockerFsPath,
				diskRequiredBytes: required,
				backupFresh: fresh,
			};
		} else {
			layer = await classifyLayer({
				changes,
				stat: (p) => this.bounded("stat O", this.deps.docker.statPath(o.id, p)),
				mounts: o.mounts,
				gitconfig: () =>
					this.readLayerFile("archive gitconfig", o.id, GITCONFIG, GITCONFIG_MAX_BYTES),
				urlHandler: () =>
					this.readLayerFile(
						"archive url handler",
						o.id,
						CLI_URL_HANDLER,
						CLI_URL_HANDLER_BYTES.length,
					),
				identity: config.gitIdentity,
				hasDotfiles: config.hasDotfiles,
			});
			blockers.push(...layer.blockers);
		}
		if (done()) return result();
		// 7. The workspace (host lstat, no symlinks followed).
		blockers.push(...(await this.workspaceBlockers(sessionId)));
		if (done()) return result();
		// 8. Managed skills, against I_O (step 1 repeats it against I_N).
		const tar = await this.bounded(
			"archive O skills",
			this.deps.docker.readArchive(o.id, SKILLS_IMAGE_DIR, SKILLS_ARCHIVE_MAX_BYTES),
		);
		let imageOSkills: SkillSet | null;
		try {
			imageOSkills = tar ? skillSetFromTar(tar) : null;
		} catch {
			blockers.push({ code: "managed-skills-collision" });
			return result();
		}
		blockers.push(
			...(await compareSkills(imageOSkills ?? new Map(), imageOSkills, (rel) =>
				this.readW(sessionId, rel),
			)),
		);
		if (done()) return result();
		// §2.7.5: N mounts /etc/st-control and runs the workspace's CLI. Only
		// a version that directory was validated with may run it (cliCompat.ts).
		const cli = await this.readCli(sessionId);
		if (cli === null || !CONTROL_MARKER_VALIDATED_CLI.has(cli)) {
			blockers.push({ code: "control-marker-incompatible" });
		}
		if (blockers.length > 0 || !image) return result();
		return result({ row, o, image, config, layer, imageOSkills, carry, sizeRw });
	}

	/** One small regular file of O's layer; "unreadable" over `maxBytes` or not exactly one file. */
	private async readLayerFile(
		label: string,
		oId: string,
		file: string,
		maxBytes: number,
	): Promise<Buffer | null | "unreadable"> {
		const tar = await this.bounded(label, this.deps.docker.readArchive(oId, file, 64 * 1024));
		if (!tar) return null;
		try {
			const [entry, ...rest] = parseTar(tar, { maxEntries: 2, maxFileBytes: maxBytes });
			if (!entry || rest.length > 0 || entry.type !== "file" || !entry.data) return "unreadable";
			return entry.data;
		} catch {
			return "unreadable";
		}
	}

	private async workspaceBlockers(sessionId: string): Promise<Blocker[]> {
		const ws = path.join(this.deps.workspaceRoot, sessionId);
		const lst = (p: string) =>
			fs.lstat(path.join(ws, p)).catch((err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT") return null;
				throw err;
			});
		const exists = (p: string) =>
			fs.stat(path.join(ws, p)).then(
				() => true,
				() => false,
			);
		const out: Blocker[] = [];
		const npm = await lst(".npm-global");
		if (!npm?.isDirectory()) out.push({ code: "workspace-cli-missing" });
		// The entrypoint's #371 migration, which N's image would run before
		// the commit: a real `.claude` dir carrying CLI-state markers, or a
		// real `.claude.json`, with the new location missing. Markers are
		// looked at with lstat (whatever is there counts), and "missing"
		// follows symlinks like the entrypoint's `[ ! -e ]`: fail-closed.
		const legacyDir = await lst(".claude");
		const legacyDirMoves =
			!!legacyDir?.isDirectory() &&
			(!!(await lst(".claude/.credentials.json")) || !!(await lst(".claude/projects"))) &&
			!(await exists(".st/claude-state"));
		const legacyJson = await lst(".claude.json");
		const legacyJsonMoves = !!legacyJson?.isFile() && !(await exists(".st/claude.json"));
		if (legacyDirMoves || legacyJsonMoves) out.push({ code: "workspace-legacy-layout" });
		return out;
	}

	// ── Steps 1–3 ───────────────────────────────────────────────────────────

	/**
	 * An exec of the attempt. `exitCode: null` is termination UNKNOWN (E1):
	 * the process may still be running in N, so it is kept as pending
	 * evidence and the attempt is never resolved until an exit is observed
	 * (`execsEnded`). Recorded inside the tracked request, so a late answer
	 * — whose continuation does nothing — is recorded all the same.
	 */
	private execIn(
		a: Attempt,
		label: string,
		containerId: string,
		cmd: string[],
		timeoutMs: number,
		via: "call" | "untimed",
		/**
		 * `issued` runs when the request goes out; `refused` when no process
		 * was started. `mayAct` gates the start after the exec is created
		 * (default: the epoch for "call", not shut down for "untimed").
		 */
		on: { issued?: () => void; refused?: () => void; mayAct?: () => boolean } = {},
	): Promise<ExecResult> {
		const mayAct = on.mayAct ?? (via === "call" ? () => a.run.epochOpen : () => !this.stopped);
		const fn = () => {
			on.issued?.();
			return this.deps.docker.exec(containerId, cmd, timeoutMs, mayAct).then(
				(r) => {
					if (r.exitCode === null) {
						a.unknownExecs.push({ label, containerId, execId: r.execId });
						logger.warn(`[recreate] ${a.sessionId}: ${label}: exit unknown; kept as pending`);
					}
					return r;
				},
				(err: unknown) => {
					// The port throws only when no process could have started.
					on.refused?.();
					throw err;
				},
			);
		};
		return via === "call" ? a.run.call(label, fn) : a.run.untimed(label, fn);
	}

	/**
	 * Each unknown exec ended? Evidence is the exec reporting it is no
	 * longer running WITH a numeric exit code, or its container not running
	 * (no process outlives its container's stop) or gone. `Running: false`
	 * without an exit code is the same "termination unknown" `recreateExec`
	 * reports (E1): it keeps the exec pending.
	 */
	private async execsEnded(a: Attempt, act: Act): Promise<boolean> {
		const still: UnknownExec[] = [];
		for (const e of a.unknownExecs) {
			const c = await act("inspect (exec evidence)", () => this.deps.docker.inspect(e.containerId));
			if (!c?.running) continue;
			const st = e.execId
				? await act("exec state", () => this.deps.docker.execState(e.execId as string))
				: null;
			if (st && !st.running && typeof st.exitCode === "number") {
				logger.info(`[recreate] ${a.sessionId}: ${e.label} ended (exit ${st.exitCode})`);
				continue;
			}
			still.push(e);
		}
		a.unknownExecs = still;
		return still.length === 0;
	}

	/** Step 1: N created, not started; precondition 8 again, against I_N. Returns H. */
	private async prepare(a: Attempt, facts: Facts, nTempName: string): Promise<string> {
		const { run, sessionId } = a;
		try {
			// Restored on a rollback only for an O that mounts the control
			// dir (created by 3.0d): those files are part of its state. A
			// 3.0c O never mounted it, and §2.7.5 retires its files anyway.
			if (facts.o.mounts.includes(CONTROL_MOUNT_TARGET)) {
				a.snapshot = await run.call("capture snapshot", () =>
					this.deps.capture.snapshot(sessionId),
				);
			}
			const prep = await run.call("capture prepare", () =>
				this.deps.capture.prepare(sessionId, () => run.epochOpen),
			);
			const options = await run.call("build N options", () =>
				this.deps.docker.buildCreate(sessionId, {
					name: nTempName,
					imageId: facts.image.imageId,
					env: prep.env,
					binds: prep.binds,
					labels: {
						[LABEL_SESSION]: sessionId,
						[LABEL_RECREATE_OF]: a.oId,
						[LABEL_ATTEMPT]: a.attemptId,
					},
				}),
			);
			await run.call("create N", () =>
				this.deps.docker.create(options).then((id) => {
					// Kept whatever the epoch: the resolution must know N.
					a.nId = id;
					return id;
				}),
			);
			const nId = a.nId as string;
			const tar = await run.call("archive N skills", () =>
				this.deps.docker.readArchive(nId, SKILLS_IMAGE_DIR, SKILLS_ARCHIVE_MAX_BYTES),
			);
			let imageN: SkillSet;
			try {
				imageN = tar ? skillSetFromTar(tar) : new Map();
			} catch {
				throw new StepFailure("prepare", "N's skills archive unreadable", [
					{ code: "managed-skills-collision" },
				]);
			}
			const skills = await compareSkills(imageN, facts.imageOSkills, (rel) =>
				this.readW(sessionId, rel),
			);
			if (skills.length > 0) throw new StepFailure("prepare", "managed skills vs I_N", skills);
			if (a.carry) await this.carryOver(a, nId);
			return prep.hash;
		} catch (err) {
			throw this.asStep("prepare", err);
		}
	}

	/**
	 * Step 1b (§2.7.7): every planned entry streamed from O into N, in the
	 * plan's order, each copy a request of the attempt (`mayAct` before it
	 * goes out: nothing is copied after the epoch closed). Then each entry is
	 * stat'ed in N and must have O's kind (and size, for a regular file): a
	 * copy that did not land as planned fails the step — before N starts and
	 * before anything is renamed, so the rollback is the ordinary one.
	 */
	private async carryOver(a: Attempt, nId: string): Promise<void> {
		const carry = a.carry as CarryState;
		const { run } = a;
		for (const [i, e] of carry.plan.entries.entries()) {
			const r = await run.call(`copy #${i + 1}`, () =>
				this.deps.docker.copyPath(
					a.oId,
					e.path,
					nId,
					carryDestination(e.path),
					() => run.epochOpen,
				),
			);
			carry.carried.push({ path: e.path, bytes: r.bytes });
		}
		let mismatched = 0;
		for (const e of carry.plan.entries) {
			const inO = await run.call("stat O (carry)", () => this.deps.docker.statPath(a.oId, e.path));
			const inN = await run.call("stat N (carry)", () => this.deps.docker.statPath(nId, e.path));
			if (!inN || inN.kind !== e.kind || (inO?.kind === "file" && inO.size !== inN.size))
				mismatched++;
		}
		if (mismatched > 0) {
			throw new StepFailure("prepare", "carry-over verification failed", [
				{ code: "carry-verify", count: mismatched },
			]);
		}
		logger.info(
			`[recreate] ${a.sessionId}: carried ${carry.carried.length} entries, ${carry.carried.reduce((s, c) => s + c.bytes, 0)} B`,
		);
	}

	/** Step 2: O → -old-, N → canonical. */
	private async swapNames(a: Attempt, oOldName: string): Promise<void> {
		try {
			await a.run.call("rename O", () => this.deps.docker.rename(a.oId, oOldName));
			await a.run.call("rename N", () => this.deps.docker.rename(a.nId as string, a.canonical));
		} catch (err) {
			throw this.asStep("rename", err);
		}
	}

	/** Step 3: O still stopped (a manual `docker start` aborts here), N started and ready. */
	private async startN(a: Attempt): Promise<void> {
		const { run } = a;
		const nId = a.nId as string;
		try {
			const o = await run.call("inspect O", () => this.deps.docker.inspect(a.oId));
			if (!o || o.running) throw new StepFailure("start", "O is no longer stopped");
			await run.call("start N", () => this.deps.docker.start(nId));
			const readyBy = this.now() + this.cfg.readinessMs;
			for (;;) {
				const r = await this.execIn(
					a,
					"readiness N",
					nId,
					["test", "-f", READY_SENTINEL],
					5_000,
					"call",
				);
				if (r.exitCode === 0) break;
				if (this.now() >= readyBy) throw new StepFailure("start", "N not ready in time");
				await this.sleep(this.cfg.readinessPollMs);
				if (!run.epochOpen) throw new EpochClosedError("readiness N", run.closeReason as string);
			}
			const n = await run.call("inspect N", () => this.deps.docker.inspect(nId));
			if (!n?.running) throw new StepFailure("start", "N is not running");
		} catch (err) {
			throw this.asStep("start", err);
		}
	}

	private asStep(step: RecreateStep, err: unknown): StepFailure {
		if (err instanceof StepFailure) return err;
		if (err instanceof EpochClosedError)
			return new StepFailure(step, `epoch closed (${err.reason})`);
		return new StepFailure(step, (err as Error).message);
	}

	// ── Rollback ────────────────────────────────────────────────────────────

	/**
	 * Steps 1–4 failed. The epoch closes (no forward continuation runs),
	 * then the resolution waits for every request to answer and, with D1
	 * still on O, removes N (confirmed), gives O its name back, and only
	 * then retires `defer-skill-seed`. Within T_rb that is a resolved
	 * rollback, done under this attempt's own lock (its lease); otherwise
	 * the record goes `uncertain`, the lock is released, the pass in
	 * progress stops before its next action, and a later pass finishes
	 * under the lock it takes itself.
	 */
	private async rollback(a: Attempt, err: unknown): Promise<RecreateResult> {
		const failure = err instanceof StepFailure ? err : this.asStep("prepare", err);
		a.run.close(`rollback: ${failure.reason}`);
		logger.warn(`[recreate] ${a.sessionId}: rolling back (${failure.message})`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const first = await Promise.race([
			this.runResolution(a, a.lease),
			new Promise<"T_rb">((r) => {
				timer = setTimeout(() => r("T_rb"), this.cfg.tRbMs);
			}),
		]);
		clearTimeout(timer);
		if (first !== "resolved") {
			await this.markUncertain(a, `rollback not confirmed (${failure.reason})`);
		}
		if (a.state !== "resolved") {
			return {
				ok: false,
				status: 500,
				code: "recreate-failed",
				step: failure.step,
				unresolved: true,
			};
		}
		// Owner decision (#459 point 3): a precondition that failed against
		// I_N answers with its own code — but only after a rollback that is
		// resolved and confirmed (we are past the `unresolved` return).
		if (failure.blockers) {
			return {
				ok: false,
				status: 409,
				code: (failure.blockers[0] as Blocker).code,
				blockers: failure.blockers,
				step: failure.step,
			};
		}
		return { ok: false, status: 500, code: "recreate-failed", step: failure.step };
	}

	// ── Step 4 onwards: completion on N ─────────────────────────────────────

	/**
	 * Steps 5 and 6, all of it inside T_rec (E2): authorization, file
	 * writes, D1 writes and execs are requests of the attempt, so when the
	 * budget runs out the epoch closes, nothing further starts, a late
	 * answer does nothing, and what is still out is named in the record.
	 *
	 * The record is resolved here only when everything converged and was
	 * re-observed (E3). Otherwise it goes `uncertain` and the resolution —
	 * which converges on N and checks it under the session's lock — is
	 * what resolves it; until then every incompatible verb is refused.
	 */
	private async complete(a: Attempt, facts: Facts, nId: string): Promise<RecreateResult> {
		const { run, sessionId } = a;
		const warnings: string[] = [];
		const incomplete: string[] = [];
		logger.info(`[recreate] ${sessionId}: committed N ${nId.slice(0, 12)}`);

		// Step 5: the §2.7.5 procedure on N, inside this attempt's epoch.
		let capture: CaptureBlock | null = null;
		try {
			capture = await run.call("authorize N", () => this.deps.capture.authorize(sessionId, run));
			// Answering is not completing: a relay that never identified
			// itself leaves capture authorized with neither file (E6).
			if (!(await run.call("capture converged", () => this.deps.capture.converged(sessionId)))) {
				incomplete.push("authorize");
			}
		} catch (err) {
			if (!(err instanceof EpochClosedError)) {
				logger.warn(
					`[recreate] ${sessionId}: authorization on N failed: ${(err as Error).message}`,
				);
			}
			incomplete.push("authorize");
		}

		// Step 6. A failure is logged and undoes nothing: N is the session.
		const execBudget = (cap: number) => Math.max(1_000, Math.min(cap, run.remaining()));
		let cliVersion: string | null = null;
		const items: Array<[string, () => Promise<void>]> = [
			[
				"defer-skill-seed",
				() =>
					run.call("remove defer-skill-seed", () =>
						this.deps.capture.removeDeferSeed(sessionId).then(() => {
							a.seedPending = true;
						}),
					),
			],
			[
				"seed-skills",
				async () => {
					// Once issued, never re-issued blindly — even if T_rec stops the
					// waiting: the seed may be running. An unknown exit is pending
					// evidence (execIn); a non-zero one is logged and the next start
					// seeds (§2.7.3). Only a refused create puts it back.
					// Only after `defer-skill-seed` is gone: with it still there the
					// script defers and the exec is wasted; the resolution removes
					// it and seeds then (the item above stays incomplete).
					if (!a.seedPending) return;
					const r = await this.execIn(a, "seed N", nId, [SEED_SCRIPT], execBudget(60_000), "call", {
						issued: () => {
							a.seedPending = false;
						},
						refused: () => {
							a.seedPending = true;
						},
					});
					if (r.exitCode !== 0) throw new Error(`seed-skills exit ${r.exitCode ?? "unknown"}`);
				},
			],
			[
				"ports",
				() =>
					run.call("d1 ports", () =>
						this.deps.d1.setPorts(sessionId, facts.config.ports, () => run.epochOpen),
					),
			],
			["status", () => run.call("d1 status", () => this.deps.d1.setStatus(sessionId, "running"))],
			[
				"gitIdentity",
				async () => {
					const id = facts.config.gitIdentity;
					if (!facts.layer.reapplyGitIdentity || !id) return;
					for (const [k, v] of [
						["user.name", id.name],
						["user.email", id.email],
					] as const) {
						const r = await this.execIn(
							a,
							`git config ${k}`,
							nId,
							["git", "config", "--global", k, v],
							execBudget(30_000),
							"call",
						);
						if (r.exitCode !== 0)
							throw new Error(`git config ${k} exit ${r.exitCode ?? "unknown"}`);
					}
				},
			],
			[
				"postStart",
				async () => {
					const cmd = facts.config.postStartCmd;
					if (!cmd) return;
					// Launched detached in tmux like every start's postStart: the
					// command keeps running in N (N is the session); only the
					// launch is waited for.
					const r = await this.execIn(
						a,
						"postStart N",
						nId,
						[
							"bash",
							"-c",
							'tmux kill-session -t bootstrap 2>/dev/null; exec tmux new-session -d -s bootstrap -c /home/developer/workspace bash -c "$0"',
							cmd,
						],
						execBudget(30_000),
						"call",
					);
					if (r.exitCode !== 0) throw new Error(`postStart launch exit ${r.exitCode ?? "unknown"}`);
				},
			],
			[
				"cliVersion",
				async () => {
					const r = await this.execIn(
						a,
						"claude --version",
						nId,
						["claude", "--version"],
						execBudget(15_000),
						"call",
					);
					const v = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null;
					cliVersion = v;
					if (!v || semverLess(v, CLI_MIN_VERSION)) warnings.push("cli-below-minimum");
				},
			],
			[
				"remove O",
				async () => {
					// Carry-over (§2.7.7): O is kept, stopped, under its -old- name
					// until an operator approves its removal — the rollback path.
					if (a.carry) return;
					await run.call("remove O", () =>
						this.deps.docker.remove(a.oId).catch((err) => {
							if (!isNotFound(err)) throw err;
						}),
					);
				},
			],
		];
		for (const [name, fn] of items) {
			if (!run.epochOpen) {
				incomplete.push(name);
				continue;
			}
			try {
				await fn();
			} catch (err) {
				if (!(err instanceof EpochClosedError)) {
					logger.warn(`[recreate] ${sessionId}: step 6 ${name} failed: ${(err as Error).message}`);
				}
				incomplete.push(name);
			}
		}
		if (incomplete.length > 0) {
			logger.warn(
				`[recreate] ${sessionId}: completed with pending items: ${incomplete.join(", ")}`,
			);
		}

		const retained = this.retainedOf(a);
		const base = {
			ok: true as const,
			outcome: "committed" as const,
			nContainerId: nId,
			capture,
			cliVersion,
			warnings,
			incomplete,
			...(a.carry
				? {
						carried: {
							entries: a.carry.carried.length,
							bytes: a.carry.carried.reduce((s, c) => s + c.bytes, 0),
						},
					}
				: {}),
			...(retained ? { retained } : {}),
		};
		const notConverged = incomplete.filter((i) => CONVERGENCE_ITEMS.has(i));
		if (a.seedPending) notConverged.push("seed-skills");
		const converged =
			notConverged.length === 0 &&
			run.inflightLabels().length === 0 &&
			a.unknownExecs.length === 0 &&
			(await this.convergedOnN(a, nId));
		if (!converged) {
			run.close(run.closeReason ?? "not converged");
			const pending = [
				...notConverged.map((i) => `${i} (not done)`),
				...run.inflightLabels().map((l) => `${l} (no answer yet)`),
				...a.unknownExecs.map((e) => `${e.label} (exit unknown)`),
			];
			if (pending.length === 0) pending.push("convergence check");
			await this.markUncertain(a, `committed, not converged: ${pending.join(", ")}`);
			void this.runResolution(a);
			return { ...base, unresolved: true, pending };
		}
		run.close("completed");
		const resolved = await this.resolveRecord(
			a,
			a.lease,
			{ kind: "committed", nContainerId: nId },
			incomplete.length ? `committed; pending: ${incomplete.join(", ")}` : "committed",
			retained ?? undefined,
		);
		if (!resolved) {
			// The record write failed: still owned, still gated; retried.
			void this.runResolution(a);
			return { ...base, unresolved: true, pending: ["record"] };
		}
		return base;
	}

	/**
	 * Re-observed, inside the epoch: D1 on N and `running`, O gone, the
	 * marker gone. What step 6 claimed done, seen again.
	 */
	/** The container a committed carry-over keeps (O, stopped, under its -old- name). */
	private retainedOf(a: Attempt): RetainedContainer | null {
		if (!a.carry) return null;
		return {
			containerId: a.oId,
			name: a.oOldName,
			role: "O",
			since: new Date(this.now()).toISOString(),
		};
	}

	/** O as a committed carry-over leaves it: present and stopped. */
	private async oRetainedOk(
		a: Attempt,
		call: <T>(l: string, f: () => Promise<T>) => Promise<T>,
	): Promise<boolean> {
		const o = await call("confirm O retained", () => this.deps.docker.inspect(a.oId));
		return !!o && !o.running;
	}

	private async convergedOnN(a: Attempt, nId: string): Promise<boolean> {
		const { run, sessionId } = a;
		try {
			const row = await run.call("d1 re-read", () => this.deps.d1.getRow(sessionId));
			if (row?.container_id !== nId || row.status !== "running") return false;
			if (a.carry) {
				if (!(await this.oRetainedOk(a, (l, f) => run.call(l, f)))) return false;
			} else if (await run.call("confirm O gone", () => this.deps.docker.inspect(a.oId))) {
				return false;
			}
			if (
				await run.call("defer-skill-seed gone", () => this.deps.capture.deferSeedExists(sessionId))
			)
				return false;
			return await run.call("capture converged", () => this.deps.capture.converged(sessionId));
		} catch {
			return false;
		}
	}

	// ── Record transitions (serialized per attempt) ─────────────────────────

	private recordOp<T>(a: Attempt, fn: () => Promise<T>): Promise<T> {
		const next = a.recordChain.then(fn, fn);
		a.recordChain = next.catch(() => undefined);
		return next;
	}

	private async markUncertain(a: Attempt, reason: string): Promise<void> {
		await this.recordOp(a, async () => {
			if (a.state !== "open") return;
			try {
				await this.deps.attempts.markUncertain(a.sessionId, a.attemptId, reason);
				a.state = "uncertain";
				logger.warn(`[recreate] ${a.sessionId}: attempt ${a.attemptId} uncertain: ${reason}`);
			} catch (err) {
				// Still `open` and owned by this process: the gate refuses the
				// session all the same ("attempt in progress").
				logger.error(
					`[recreate] ${a.sessionId}: could not mark uncertain: ${(err as Error).message}`,
				);
			}
		});
	}

	/** Only under the session's lock: resolving is what lets the other verbs in. */
	private async resolveRecord(
		a: Attempt,
		lease: Lease,
		outcome: AttemptOutcome,
		reason: string,
		retained?: RetainedContainer,
	): Promise<boolean> {
		return this.recordOp(a, async () => {
			if (a.state === "resolved") return true;
			// Checked here, inside the serialized record operation and right
			// before the durable write: the pass may have waited for its last
			// evidence across an `engine.stop()`, and a `resolved` written after
			// the shutdown would be inherited by the next process, which D8
			// says must find the attempt unresolved. A write already started
			// before the stop is not cancelled.
			if (!lease.held || this.stopped) throw new LeaseLostError();
			try {
				await this.deps.attempts.resolve(a.sessionId, a.attemptId, outcome, reason, { retained });
			} catch (err) {
				logger.error(`[recreate] ${a.sessionId}: could not resolve: ${(err as Error).message}`);
				return false;
			}
			a.state = "resolved";
			if (a.retryTimer) clearTimeout(a.retryTimer);
			this.attempts.delete(a.sessionId);
			logger.info(`[recreate] ${a.sessionId}: attempt ${a.attemptId} resolved (${outcome.kind})`);
			return true;
		});
	}

	// ── Resolution (evidence only) ──────────────────────────────────────────

	/**
	 * Waits for every request of the attempt to answer (and, after an
	 * ambiguous CAS, for D1 to be final), then applies the resolution table
	 * with D1 deciding — under the session's lock: the attempt's own
	 * (`lease`, from inside `recreate`) or one it takes (`recreate-resolve`,
	 * which the unresolved gate lets through). Each pass resolves, or
	 * schedules a re-observation (something could not be confirmed yet), or
	 * stops (neither O nor N: operator). Never on elapsed time alone.
	 */
	private runResolution(a: Attempt, lease?: Lease): Promise<"resolved" | "pending"> {
		if (a.resolving) return a.resolving;
		const p = (async (): Promise<"resolved" | "pending"> => {
			await a.run.settled();
			if (a.cas === "ambiguous" && a.casSentAt !== null) {
				const wait = a.casSentAt + this.cfg.tD1Ms - this.now();
				if (wait > 0) await this.sleep(wait);
			}
			// Shutting down: the process that could act on this evidence is
			// going away; the next one finds the record and stays fail-closed.
			if (this.stopped) return "pending";
			let r: ResolveStep;
			try {
				// A lease already lost (T_rb let the lock go while this pass
				// waited for evidence) is not used: this pass takes the lock.
				r = lease?.held
					? await this.resolveOnce(a, lease)
					: await this.deps.lock.run(
							a.sessionId,
							"recreate-resolve",
							async () => {
								const own: Lease = { held: true };
								try {
									return await this.resolveOnce(a, own);
								} finally {
									own.held = false;
								}
							},
							{ mode: "wait" },
						);
			} catch (err) {
				if (!(err instanceof LeaseLostError)) {
					logger.warn(
						`[recreate] ${a.sessionId}: resolution pass failed: ${(err as Error).message}`,
					);
				}
				r = "retry";
			}
			if (r === "resolved") return "resolved";
			if (r === "retry" && !this.stopped) {
				a.retryTimer = setTimeout(() => {
					a.retryTimer = null;
					void this.runResolution(a);
				}, this.cfg.resolveRetryMs);
				a.retryTimer.unref?.();
			}
			return "pending";
		})();
		a.resolving = p;
		void p.finally(() => {
			if (a.resolving === p) a.resolving = null;
		});
		return p;
	}

	private async resolveOnce(a: Attempt, lease: Lease): Promise<ResolveStep> {
		// Every action of the pass, reads included, goes through here: it is
		// tracked as the attempt's evidence and refused once the lease is gone.
		const mayAct = () => lease.held && !this.stopped;
		const act: Act = Object.assign(
			<T>(label: string, fn: () => Promise<T>): Promise<T> => {
				if (!mayAct()) throw new LeaseLostError();
				return a.run.untimed(label, fn);
			},
			{ mayAct },
		);
		const row = await act("d1 read", () => this.deps.d1.getRow(a.sessionId));
		const current = row?.container_id ?? null;
		if (a.reverse) return this.resolveReverse(a, lease, act, current);
		if (current === a.oId) return this.resolveToO(a, lease, act);
		if (a.nId !== null && current === a.nId) return this.resolveToN(a, lease, act);
		this.stats.recreateOrphans++;
		logger.error(
			`[recreate] ${a.sessionId}: attempt ${a.attemptId}: D1 names neither O nor N (${current ?? "null"}); left for the operator`,
		);
		return "stuck";
	}

	/** D1 = O: N must be confirmed gone before O gets its name back and the marker goes. */
	private async resolveToO(a: Attempt, lease: Lease, act: Act): Promise<ResolveStep> {
		const d = this.deps.docker;
		const ids = new Set<string>();
		if (a.nId) ids.add(a.nId);
		for (const c of await act("list N by label", () => d.listByLabel(LABEL_ATTEMPT, a.attemptId))) {
			ids.add(c.id);
		}
		for (const id of ids) {
			if (id === a.oId) continue; // never O, whatever a label says
			const c = await act("inspect N", () => d.inspect(id));
			if (!c) continue;
			try {
				if (c.running) await act("stop N", () => d.stop(id));
				await act("remove N", () => d.remove(id));
			} catch (err) {
				if (err instanceof LeaseLostError) throw err;
				if (!isNotFound(err)) {
					logger.warn(`[recreate] ${a.sessionId}: removing N failed: ${(err as Error).message}`);
					return "retry";
				}
			}
		}
		for (const id of ids) {
			if (id !== a.oId && (await act("confirm N gone", () => d.inspect(id)))) return "retry";
		}
		const labelled = await act("confirm no N by label", () =>
			d.listByLabel(LABEL_ATTEMPT, a.attemptId),
		);
		if (labelled.some((c) => c.id !== a.oId)) return "retry";
		// N gone ⇒ every exec in it ended.
		if (!(await this.execsEnded(a, act))) return "retry";

		const o = await act("inspect O", () => d.inspect(a.oId));
		if (!o) {
			this.stats.recreateOrphans++;
			logger.error(`[recreate] ${a.sessionId}: D1 names O but O is gone; left for the operator`);
			return "stuck";
		}
		if (o.name !== a.canonical) {
			try {
				await act("rename O back", () => d.rename(a.oId, a.canonical));
			} catch (err) {
				if (err instanceof LeaseLostError) throw err;
				logger.warn(`[recreate] ${a.sessionId}: renaming O back failed: ${(err as Error).message}`);
				return "retry";
			}
			const again = await act("confirm O name", () => d.inspect(a.oId));
			if (again?.name !== a.canonical) return "retry";
		}
		// Only now, with N confirmed gone: nothing can start with the marker
		// missing and seed over the workspace.
		await act("remove defer-skill-seed", () => this.deps.capture.removeDeferSeed(a.sessionId));
		if (await act("defer-skill-seed gone", () => this.deps.capture.deferSeedExists(a.sessionId))) {
			return "retry";
		}
		const restored = await act("restore O capture", () =>
			this.deps.capture.restore(a.sessionId, a.snapshot, a.oId, act.mayAct),
		);
		if (a.snapshot.marker || a.snapshot.hooksFile) {
			logger.info(`[recreate] ${a.sessionId}: O's capture files: ${restored}`);
		}
		// O's files as authorization allows them now (E6). `restore` only
		// ever writes; what it leaves behind — a half pair from a failed
		// withdrawal, files whose authorization a disable took away — is
		// converged here (O is stopped: keep a complete pair, else withdraw)
		// and seen again before the record says `resolved`.
		if (!(await act("capture converged", () => this.deps.capture.converged(a.sessionId)))) {
			await act("capture converge", () => this.deps.capture.converge(a.sessionId, act.mayAct));
			if (!(await act("capture converged", () => this.deps.capture.converged(a.sessionId)))) {
				return "retry";
			}
		}
		return (await this.resolveRecord(a, lease, { kind: "rolled-back" }, "rolled back"))
			? "resolved"
			: "retry";
	}

	/**
	 * D1 = N (the commit applied): converge on N, never revert — and check
	 * it, before the record says `resolved` (E3).
	 */
	private async resolveToN(a: Attempt, lease: Lease, act: Act): Promise<ResolveStep> {
		const { sessionId } = a;
		const d = this.deps.docker;
		const nId = a.nId as string;
		const o = await act("inspect O", () => d.inspect(a.oId));
		if (o) {
			if (o.running) {
				// Someone started O by hand after the commit. It is not D1's
				// container, but it is running on the shared workspace:
				// removing it is not this resolution's call.
				logger.error(
					`[recreate] ${sessionId}: O is running after the commit; left for the operator`,
				);
				return "retry";
			}
			if (!a.carry) {
				try {
					await act("remove O", () => d.remove(a.oId));
				} catch (err) {
					if (err instanceof LeaseLostError) throw err;
					if (!isNotFound(err)) return "retry";
				}
			}
		}
		const n = await act("inspect N", () => d.inspect(nId));
		if (!n) {
			this.stats.recreateOrphans++;
			logger.error(`[recreate] ${sessionId}: D1 names N but N is gone; left for the operator`);
			return "stuck";
		}
		const status = n.running ? "running" : "stopped";
		await act("d1 status", () => this.deps.d1.setStatus(sessionId, status));
		const config = await act("d1 config", () => this.deps.d1.getConfig(sessionId));
		await act("d1 ports", () =>
			this.deps.d1.setPorts(sessionId, n.running ? config.ports : [], act.mayAct),
		);
		const marker = await act("defer-skill-seed exists", () =>
			this.deps.capture.deferSeedExists(sessionId),
		);
		if (marker || a.seedPending) {
			await act("remove defer-skill-seed", () => this.deps.capture.removeDeferSeed(sessionId));
			a.seedPending = true;
			if (n.running) {
				if (!lease.held || this.stopped) throw new LeaseLostError();
				const r = await this.execIn(a, "seed N", nId, [SEED_SCRIPT], 60_000, "untimed", {
					mayAct: act.mayAct,
					issued: () => {
						a.seedPending = false;
					},
					refused: () => {
						a.seedPending = true;
					},
				});
				if (r.exitCode !== null && r.exitCode !== 0) {
					logger.warn(`[recreate] ${sessionId}: seed exit ${r.exitCode}`);
				}
			} else {
				// The next start seeds: the marker is gone (§2.7.3).
				a.seedPending = false;
			}
		}
		// The ordinary §2.7.5 convergence, as the attempt (the gate would
		// skip it while the record is unresolved — that is the point).
		const capture = await act("capture converge", () =>
			this.deps.capture.converge(sessionId, act.mayAct),
		);
		logger.info(`[recreate] ${sessionId}: capture on N: ${capture}`);

		// Seen again before resolving: D1 on N with the status of N, O gone,
		// the marker gone, and every exec of the attempt ended.
		const again = await act("d1 re-read", () => this.deps.d1.getRow(sessionId));
		if (again?.container_id !== nId || again.status !== status) return "retry";
		const nNow = await act("inspect N again", () => d.inspect(nId));
		if (!nNow || nNow.running !== n.running) return "retry";
		if (a.carry) {
			if (!(await this.oRetainedOk(a, act))) return "retry";
		} else if (await act("confirm O gone", () => d.inspect(a.oId))) return "retry";
		if (await act("defer-skill-seed gone", () => this.deps.capture.deferSeedExists(sessionId))) {
			return "retry";
		}
		// What `converge` answered is not the evidence: the files are (E6).
		// Still authorized but incomplete (a relay that did not identify
		// itself, a write that failed) ⇒ the next pass converges again;
		// authorization gone ⇒ both files must be seen gone.
		if (!(await act("capture converged", () => this.deps.capture.converged(sessionId)))) {
			return "retry";
		}
		if (!(await this.execsEnded(a, act))) return "retry";
		return (await this.resolveRecord(
			a,
			lease,
			{ kind: "committed", nContainerId: nId },
			"converged on N",
			this.retainedOf(a) ?? undefined,
		))
			? "resolved"
			: "retry";
	}

	// ── Carry-over follow-ups (§2.7.7): approve, rollback, recover ──────────

	/**
	 * Remove the container a committed carry-over (O) or a rollback (N) kept.
	 * Under the session's lock; the retained container must be stopped and
	 * must not be D1's container. Idempotent: an already removed container
	 * just clears the record.
	 */
	async approve(sessionId: string): Promise<AdminOpResult> {
		try {
			return await this.deps.lock.run(
				sessionId,
				"recreate",
				async () => {
					const rec = await this.deps.attempts.read(sessionId);
					if (rec.kind === "none") return { ok: false, status: 404, code: "no-attempt" };
					if (rec.kind !== "ok" || rec.record.state !== "resolved")
						return { ok: false, status: 409, code: "recreate-unresolved" };
					const retained = rec.record.retained;
					if (!retained) return { ok: false, status: 409, code: "nothing-retained" };
					const row = await this.deps.d1.getRow(sessionId);
					if (!row) return { ok: false, status: 404, code: "not-found" };
					if (row.container_id === retained.containerId)
						return { ok: false, status: 409, code: "retained-is-current" };
					const c = await this.bounded(
						"inspect retained",
						this.deps.docker.inspect(retained.containerId),
					);
					if (c?.running) return { ok: false, status: 409, code: "retained-running" };
					if (c) {
						try {
							await this.deps.docker.remove(retained.containerId);
						} catch (err) {
							if (!isNotFound(err)) throw err;
						}
						if (
							await this.bounded(
								"confirm retained gone",
								this.deps.docker.inspect(retained.containerId),
							)
						)
							return { ok: false, status: 500, code: "remove-failed" };
					}
					await this.deps.attempts.approve(sessionId);
					logger.info(
						`[recreate] ${sessionId}: approved; retained ${retained.role} ${retained.containerId.slice(0, 12)} ${c ? "removed" : "was already gone"}`,
					);
					return {
						ok: true,
						status: 200,
						body: { removed: !!c, containerId: retained.containerId, role: retained.role },
					};
				},
				{ mode: "fail" },
			);
		} catch (err) {
			if (err instanceof SessionBusyError) return { ok: false, status: 409, code: "busy" };
			if (err instanceof RecreateUnresolvedError)
				return { ok: false, status: 409, code: "recreate-unresolved" };
			if (err instanceof DockerUnavailableError)
				return { ok: false, status: 503, code: "docker-unavailable" };
			throw err;
		}
	}

	/**
	 * Back to the retained O after a committed carry-over (§2.7.7): a small
	 * attempt of its own (record `reverse`), with N (D1's container, stopped)
	 * and the retained O exchanging roles. Steps: N → `-old-`, O → canonical,
	 * ONE D1 statement moving `container_id` back and dropping the ingest
	 * hash (O predates the relay), then status/ports/capture converge on O —
	 * which retires the capture files, since O has no control mounts. N is
	 * kept, stopped, as the retained container (`role: N`) until approval.
	 * Nothing is removed. The owner starts O afterwards like any session.
	 */
	async rollbackToRetained(sessionId: string): Promise<AdminOpResult> {
		try {
			const lease: Lease = { held: true };
			return await this.deps.lock.run(
				sessionId,
				"recreate",
				async () => {
					try {
						return await this.rollbackToRetainedLocked(sessionId, lease);
					} finally {
						lease.held = false;
					}
				},
				{ mode: "fail" },
			);
		} catch (err) {
			if (err instanceof SessionBusyError) return { ok: false, status: 409, code: "busy" };
			if (err instanceof RecreateUnresolvedError)
				return { ok: false, status: 409, code: "recreate-unresolved" };
			if (err instanceof DockerUnavailableError)
				return { ok: false, status: 503, code: "docker-unavailable" };
			throw err;
		}
	}

	private async rollbackToRetainedLocked(sessionId: string, lease: Lease): Promise<AdminOpResult> {
		const rec = await this.deps.attempts.read(sessionId);
		if (rec.kind === "none") return { ok: false, status: 404, code: "no-attempt" };
		if (rec.kind !== "ok" || rec.record.state !== "resolved")
			return { ok: false, status: 409, code: "recreate-unresolved" };
		const retained = rec.record.retained;
		if (!retained || retained.role !== "O")
			return { ok: false, status: 409, code: "nothing-retained" };
		const row = await this.deps.d1.getRow(sessionId);
		if (!row) return { ok: false, status: 404, code: "not-found" };
		// D1 must be on the container the retained one would replace — not
		// on the retained one itself. The last record may be a carry-over
		// (`committed` on N) or a rollback that did not apply (`rolled-back`,
		// names restored, O still retained): both are rollback-able.
		const nId = row.container_id;
		if (!nId || nId === retained.containerId)
			return { ok: false, status: 409, code: "not-on-committed-n" };
		const n = await this.bounded("inspect N", this.deps.docker.inspect(nId));
		if (!n) return { ok: false, status: 409, code: "container-missing" };
		if (n.running) return { ok: false, status: 409, code: "running" };
		const o = await this.bounded(
			"inspect retained O",
			this.deps.docker.inspect(retained.containerId),
		);
		if (!o) return { ok: false, status: 409, code: "retained-missing" };
		if (o.running) return { ok: false, status: 409, code: "retained-running" };
		if (this.stopped) return { ok: false, status: 500, code: "recreate-failed" };

		const attemptId = randomUUID();
		const ts = String(this.now());
		const canonical = row.container_name;
		const identity = {
			attemptId,
			oContainerId: nId,
			oCanonicalName: canonical,
			oOldName: `${canonical}-old-${ts}`,
			nTempName: o.name,
		};
		try {
			await this.deps.attempts.begin(sessionId, identity, {
				reverse: true,
				retainedContainerId: retained.containerId,
			});
		} catch (err) {
			if (err instanceof RecreateUnresolvedError)
				return { ok: false, status: 409, code: "recreate-unresolved" };
			logger.error(`[recreate] ${sessionId}: rollback begin refused: ${(err as Error).message}`);
			await this.deps.attempts
				.resolve(sessionId, attemptId, { kind: "rolled-back" }, "begin failed; no effects")
				.catch(() => undefined);
			return { ok: false, status: 500, code: "recreate-failed" };
		}
		const a: Attempt = {
			sessionId,
			attemptId,
			oId: nId, // the container being replaced (N)
			canonical,
			run: new AttemptRun(this.now() + this.cfg.tRecMs, { now: this.now }),
			snapshot: { marker: false, hooksFile: false },
			nId: retained.containerId, // the container coming back (O)
			casSentAt: null,
			cas: null,
			state: "open",
			recordChain: Promise.resolve(),
			resolving: null,
			retryTimer: null,
			lease,
			unknownExecs: [],
			seedPending: false,
			oOldName: identity.oOldName,
			carry: null,
			reverse: true,
		};
		this.attempts.set(sessionId, a);
		logger.info(
			`[recreate] ${sessionId}: rollback attempt ${attemptId} open (N ${nId.slice(0, 12)} → O ${retained.containerId.slice(0, 12)})`,
		);
		try {
			await a.run.call("rename N", () => this.deps.docker.rename(nId, identity.oOldName));
			await a.run.call("rename O", () => this.deps.docker.rename(retained.containerId, canonical));
		} catch (err) {
			a.run.close(`rollback renames failed: ${(err as Error).message}`);
			await this.markUncertain(a, `rollback renames failed: ${(err as Error).message}`);
			void this.runResolution(a);
			return { ok: false, status: 500, code: "recreate-failed", detail: "rename" };
		}
		a.casSentAt = this.now();
		a.cas = await a.run.untimed("d1 rollback", () =>
			this.deps.d1.casBack(sessionId, nId, retained.containerId),
		);
		if (a.cas === "ambiguous") {
			a.run.close("ambiguous rollback commit");
			await this.markUncertain(a, "ambiguous rollback commit; D1 re-read after T_d1");
			void this.runResolution(a);
			return { ok: false, status: 500, code: "recreate-failed", detail: "commit" };
		}
		// The resolution table finishes either outcome by evidence, under this lock.
		const r = await this.runResolution(a, lease);
		if (r !== "resolved" || a.state !== "resolved") {
			return { ok: false, status: 500, code: "recreate-failed", detail: "not resolved" };
		}
		const rec2 = await this.deps.attempts.read(sessionId);
		const outcome = rec2.kind === "ok" ? rec2.record.outcome : undefined;
		if (outcome?.kind === "committed") {
			return {
				ok: true,
				status: 200,
				body: {
					outcome: "rolled-back-to-retained",
					containerId: retained.containerId,
					retained: rec2.kind === "ok" ? (rec2.record.retained ?? null) : null,
				},
			};
		}
		return { ok: false, status: 409, code: "rollback-not-applied" };
	}

	/**
	 * The resolution table of a reverse attempt (§2.7.7). D1 decides, nothing
	 * is removed: on O (the retained container, now canonical) ⇒ names as
	 * renamed, status stopped, ports cleared, capture converged (retired for
	 * a container without control mounts), N kept as retained; on N (the
	 * statement did not apply) ⇒ both names back, nothing else.
	 */
	private async resolveReverse(
		a: Attempt,
		lease: Lease,
		act: Act,
		current: string | null,
	): Promise<ResolveStep> {
		const d = this.deps.docker;
		const nId = a.oId; // the container being replaced
		const oId = a.nId as string; // the retained container coming back
		const { sessionId } = a;
		if (current === oId) {
			const o = await act("inspect O", () => d.inspect(oId));
			if (!o) return "stuck";
			// Names: N off the canonical name first (it may still hold it when
			// the first rename never happened), then O onto it — never a
			// rename into a name another container holds.
			const n = await act("inspect N", () => d.inspect(nId));
			if (n && n.name !== a.oOldName) {
				await act("rename N old", () => d.rename(nId, a.oOldName)).catch(() => undefined);
			}
			if (o.name !== a.canonical) {
				await act("rename O canonical", () => d.rename(oId, a.canonical)).catch(() => undefined);
			}
			await act("d1 status", () => this.deps.d1.setStatus(sessionId, "stopped"));
			await act("d1 ports", () => this.deps.d1.setPorts(sessionId, [], act.mayAct));
			await act("capture converge", () => this.deps.capture.converge(sessionId, act.mayAct));
			// Seen again.
			const again = await act("d1 re-read", () => this.deps.d1.getRow(sessionId));
			if (again?.container_id !== oId || again.status !== "stopped") return "retry";
			const oNow = await act("inspect O again", () => d.inspect(oId));
			if (!oNow || oNow.running || oNow.name !== a.canonical) return "retry";
			if (!(await act("capture converged", () => this.deps.capture.converged(sessionId))))
				return "retry";
			const nNow = await act("inspect N again", () => d.inspect(nId));
			const retained: RetainedContainer | undefined = nNow
				? {
						containerId: nId,
						name: nNow.name,
						role: "N",
						since: new Date(this.now()).toISOString(),
					}
				: undefined;
			return (await this.resolveRecord(
				a,
				lease,
				{ kind: "committed", nContainerId: oId },
				"rolled back to the retained container",
				retained,
			))
				? "resolved"
				: "retry";
		}
		if (current === nId) {
			// Not applied: undo the renames — O off the canonical name first
			// (to a reserved `-old-<ts>` name the boot pass recognises), then
			// N back onto it.
			const o = await act("inspect O", () => d.inspect(oId));
			if (o && o.name === a.canonical) {
				await act("rename O back", () => d.rename(oId, `${a.canonical}-old-${this.now()}`)).catch(
					() => undefined,
				);
			}
			const n2 = await act("inspect N", () => d.inspect(nId));
			if (n2 && n2.name !== a.canonical) {
				await act("rename N canonical", () => d.rename(nId, a.canonical)).catch(() => undefined);
			}
			// Seen again: D1 still on N, N canonical and stopped, O present and not canonical.
			const again = await act("d1 re-read", () => this.deps.d1.getRow(sessionId));
			if (again?.container_id !== nId) return "retry";
			const nNow = await act("inspect N again", () => d.inspect(nId));
			if (!nNow || nNow.name !== a.canonical) return "retry";
			const oNow = await act("inspect O again", () => d.inspect(oId));
			if (oNow?.name === a.canonical) return "retry";
			const retained: RetainedContainer | undefined = oNow
				? {
						containerId: oId,
						name: oNow.name,
						role: "O",
						since: new Date(this.now()).toISOString(),
					}
				: undefined;
			return (await this.resolveRecord(
				a,
				lease,
				{ kind: "rolled-back" },
				"rollback not applied; names restored",
				retained,
			))
				? "resolved"
				: "retry";
		}
		this.stats.recreateOrphans++;
		logger.error(
			`[recreate] ${sessionId}: rollback attempt ${a.attemptId}: D1 names neither container (${current ?? "null"}); left for the operator`,
		);
		return "stuck";
	}

	/**
	 * The D8 recovery procedure (§2.7.7), operator-driven: an attempt
	 * orphaned by a restart is adopted by this process and resolved by the
	 * evidence available NOW — D1's row, the containers, the record — under
	 * the session's lock (`recreate-resolve`, which the unresolved gate lets
	 * through). Required: every container of the attempt stopped, so no exec
	 * of the dead process can still be running inside one (no process
	 * outlives its container's stop), and no live attempt of this process.
	 * Nothing is inferred from elapsed time.
	 */
	async recover(sessionId: string): Promise<AdminOpResult> {
		if (this.attempts.has(sessionId))
			return { ok: false, status: 409, code: "attempt-in-progress" };
		try {
			return await this.deps.lock.run(
				sessionId,
				"recreate-resolve",
				async () => {
					const rec = await this.deps.attempts.read(sessionId);
					if (rec.kind === "none") return { ok: false, status: 404, code: "no-attempt" };
					if (rec.kind === "unreadable")
						return { ok: false, status: 409, code: "record-unreadable", detail: rec.error };
					const r = rec.record;
					if (r.state === "resolved") return { ok: false, status: 409, code: "already-resolved" };
					if (!r.orphanedAt) return { ok: false, status: 409, code: "not-orphaned" };
					const d = this.deps.docker;
					const row = await this.deps.d1.getRow(sessionId);
					if (!row) return { ok: false, status: 404, code: "not-found" };
					// Every container the attempt may have touched, by identity and by label.
					const candidates = new Map<string, RecreateContainer>();
					for (const ref of [r.oContainerId, r.nTempName, row.container_id ?? ""]) {
						if (!ref) continue;
						const c = await this.bounded("inspect candidate", d.inspect(ref));
						if (c) candidates.set(c.id, c);
					}
					for (const c of await this.bounded(
						"list by attempt",
						d.listByLabel(LABEL_ATTEMPT, r.attemptId),
					))
						candidates.set(c.id, c);
					const running = [...candidates.values()].filter((c) => c.running);
					if (running.length > 0)
						return {
							ok: false,
							status: 409,
							code: "running",
							detail: `${running.length} container(s) running`,
						};
					// N: the labelled container of this attempt (strict); for a
					// reverse attempt, the retained container coming back — by
					// its recorded id (the attempt renames it, so no name can
					// identify it), or for a record without one, by D1 when D1
					// already moved, else the holder of the canonical name that
					// is not the replaced container.
					let nId: string | null = null;
					if (r.reverse) {
						if (r.retainedContainerId) {
							nId = r.retainedContainerId;
						} else if (row.container_id && row.container_id !== r.oContainerId) {
							nId = row.container_id;
						} else {
							const holder = await this.bounded("inspect canonical", d.inspect(r.oCanonicalName));
							nId = holder && holder.id !== r.oContainerId ? holder.id : null;
						}
						if (nId) {
							const c = await this.bounded("inspect retained", d.inspect(nId));
							if (!c) return { ok: false, status: 409, code: "retained-missing" };
							if (c.running)
								return { ok: false, status: 409, code: "running", detail: "retained container" };
						}
					} else {
						const labelled = [...candidates.values()].filter(
							(c) => c.labels[LABEL_ATTEMPT] === r.attemptId && c.id !== r.oContainerId,
						);
						if (labelled.length > 1)
							return {
								ok: false,
								status: 409,
								code: "ambiguous-n",
								detail: `${labelled.length} labelled containers`,
							};
						nId = labelled[0]?.id ?? null;
					}
					await this.deps.attempts.adopt(sessionId, r.attemptId);
					const lease: Lease = { held: true };
					const a: Attempt = {
						sessionId,
						attemptId: r.attemptId,
						oId: r.oContainerId,
						canonical: r.oCanonicalName,
						run: new AttemptRun(this.now() + this.cfg.tRecMs, { now: this.now }),
						snapshot: { marker: false, hooksFile: false },
						nId,
						casSentAt: null,
						cas: null,
						state: "uncertain",
						recordChain: Promise.resolve(),
						resolving: null,
						retryTimer: null,
						lease,
						unknownExecs: [],
						seedPending: false,
						oOldName: r.oOldName,
						carry: r.preserve
							? {
									plan: {
										entries: [],
										blockers: [],
										skipped: { entrypoint: 0, cliRuntime: 0, socket: 0 },
									},
									bytes: r.preserve.bytes,
									carried: [],
								}
							: null,
						reverse: !!r.reverse,
					};
					this.attempts.set(sessionId, a);
					try {
						let step: ResolveStep = "retry";
						for (let i = 0; i < 3 && step === "retry"; i++) {
							step = await this.resolveOnce(a, lease);
						}
						if (step === "resolved") {
							const after = await this.deps.attempts.read(sessionId);
							const rr = after.kind === "ok" ? after.record : null;
							logger.info(
								`[recreate] ${sessionId}: attempt ${r.attemptId} recovered by the operator (${rr?.outcome?.kind})`,
							);
							return {
								ok: true,
								status: 200,
								body: { outcome: rr?.outcome ?? null, retained: rr?.retained ?? null },
							};
						}
						return {
							ok: false,
							status: 409,
							code: step === "stuck" ? "recover-stuck" : "recover-retry",
							detail: "evidence did not confirm; see the backend log",
						};
					} finally {
						lease.held = false;
						if (a.state !== "resolved") this.attempts.delete(sessionId);
					}
				},
				{ mode: "fail" },
			);
		} catch (err) {
			if (err instanceof SessionBusyError) return { ok: false, status: 409, code: "busy" };
			if (err instanceof DockerUnavailableError)
				return { ok: false, status: 503, code: "docker-unavailable" };
			throw err;
		}
	}

	// ── Boot pass ───────────────────────────────────────────────────────────

	/**
	 * After a backend restart. Unresolved attempts were already marked
	 * `uncertain` + orphaned by `recoverOnBoot` and are NOT resolved here
	 * (D8). What this does:
	 *   - removes leftovers: a container labelled with attempt A, A resolved
	 *     in its session's record, its id neither D1's `container_id` nor
	 *     A's committed N, and never started (stopped; a running one is
	 *     left alone and logged);
	 *   - retires a residual `defer-skill-seed` of a session whose latest
	 *     attempt resolved `committed` with D1 on that N, seeding if N runs.
	 * Containers of attempts that are not resolved are never touched.
	 */
	async bootPass(): Promise<void> {
		const d = this.deps.docker;
		let labelled: RecreateContainer[] = [];
		try {
			labelled = await this.bounded("list recreate containers", d.listByLabel(LABEL_ATTEMPT));
		} catch (err) {
			logger.warn(`[recreate] boot pass: listing failed: ${(err as Error).message}`);
		}
		for (const c of labelled) {
			const sid = c.labels[LABEL_SESSION];
			const attemptId = c.labels[LABEL_ATTEMPT];
			if (!sid || !attemptId) continue;
			try {
				const resolved = await this.deps.attempts.resolvedAttempts(sid);
				const outcome = resolved.get(attemptId);
				if (!outcome) continue; // unknown or unresolved attempt: part of an uncertain state
				const row = await this.deps.d1.getRow(sid);
				if (row?.container_id === c.id) continue;
				if (outcome.kind === "committed" && outcome.nContainerId === c.id) continue;
				if (c.running) {
					logger.warn(
						`[recreate] boot pass: leftover ${c.id.slice(0, 12)} is running; not touched`,
					);
					continue;
				}
				await d.remove(c.id).catch((err) => {
					if (!isNotFound(err)) throw err;
				});
				this.stats.leftoversRemoved++;
				logger.info(`[recreate] boot pass: removed leftover ${c.id.slice(0, 12)} of ${sid}`);
			} catch (err) {
				logger.warn(`[recreate] boot pass: ${c.id.slice(0, 12)}: ${(err as Error).message}`);
			}
		}
		await this.reviewReservedNames();
		await this.convergeResidualDeferSeeds();
	}

	/**
	 * The reserved `-old-`/`-new-` names whose prefix is a session of D1
	 * are reviewed and logged, never touched: a leftover is defined by its
	 * attempt label (handled above), and an unlabelled `-old-` container is
	 * an O — removing it is a resolution's call, with evidence.
	 */
	private async reviewReservedNames(): Promise<void> {
		for (const fragment of ["-old-", "-new-"]) {
			let found: RecreateContainer[];
			try {
				found = await this.bounded("list reserved names", this.deps.docker.listByName(fragment));
			} catch (err) {
				logger.warn(
					`[recreate] boot pass: listing ${fragment} names failed: ${(err as Error).message}`,
				);
				continue;
			}
			for (const c of found) {
				const m = RESERVED_NAME_RE.exec(c.name);
				if (!m) continue;
				const sid = await this.deps.d1.sessionIdByContainerName(`st-${m[1]}`).catch(() => null);
				if (!sid) continue;
				this.stats.reservedNamesSeen++;
				logger.warn(
					`[recreate] boot pass: ${c.name} (${c.id.slice(0, 12)}) of session ${sid} is present; left as is`,
				);
			}
		}
	}

	private async convergeResidualDeferSeeds(): Promise<void> {
		const root = this.deps.attempts.controlRoot();
		let sids: string[];
		try {
			// Only session ids become path components below.
			sids = (await fs.readdir(root)).filter((n) => SESSION_ID_RE.test(n));
		} catch {
			return;
		}
		for (const sid of sids) {
			try {
				if (!(await this.deps.capture.deferSeedExists(sid))) continue;
				const rec = await this.deps.attempts.read(sid);
				if (rec.kind !== "ok" || rec.record.state !== "resolved") continue;
				const outcome = rec.record.outcome;
				const row = await this.deps.d1.getRow(sid);
				if (outcome?.kind !== "committed" || row?.container_id !== outcome.nContainerId) continue;
				await this.deps.capture.removeDeferSeed(sid);
				const n = await this.bounded("inspect N", this.deps.docker.inspect(outcome.nContainerId));
				if (n?.running) {
					const r = await this.deps.docker.exec(n.id, [SEED_SCRIPT], 60_000);
					if (r.exitCode !== 0)
						logger.warn(`[recreate] boot pass: seed of ${sid} exit ${r.exitCode}`);
				}
				logger.info(`[recreate] boot pass: retired residual defer-skill-seed of ${sid}`);
			} catch (err) {
				logger.warn(`[recreate] boot pass: defer-skill-seed of ${sid}: ${(err as Error).message}`);
			}
		}
	}
}
