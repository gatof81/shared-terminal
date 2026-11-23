/**
 * acp/agents.ts — ACP agents.
 *
 * An agent is a session whose container runs the ST runner
 * (acp-runtime/runner.mjs): a direct ACP client driving a provider adapter
 * (claude-agent-acp today). Docker stays provider-neutral: the adapter and the
 * runner live in a read-only runtime directory bound into the container at
 * spawn, one directory per pinned adapter version, installed apart from any
 * image (`acp-runtime/install.sh`).
 *
 * `agent_messages` (D1, migration v21) is the single message store: the
 * person's messages, agent → agent messages and their results. The runner
 * claims ONE message at a time; Shared Terminal never resends a message whose
 * run was interrupted (it becomes `uncertain`; only the owner requeues it).
 *
 * Activity (tool calls, background tasks, the text being written) is
 * process-local and in memory: it is the live view, not history. History is
 * the messages and their results.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isBootstrapPending } from "../bootstrapHold.js";
import { d1Query } from "../db.js";
import type { AgentLifecycleHooks, DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";
import { deriveSubkey } from "../secrets.js";

/** Slots an agent runs: 1..max_concurrency (bounded, whatever the row says). */
const slotsOf = (agent: AgentRow) =>
	Array.from(
		{ length: Math.min(Math.max(agent.max_concurrency ?? 1, 1), MAX_SLOTS) },
		(_, i) => i + 1,
	);

// ── Configuration ─────────────────────────────────────────────────────────

export interface AcpConfig {
	/** Host path (== backend path, like WORKSPACE_ROOT) of the runtime dir. */
	runtimeDir: string;
	/** Directory name of the default adapter bundle, e.g. `claude-acp-0.108.0`. */
	defaultRuntime: string;
	defaultModel: string;
	/** Technical cap of one message body, bytes. Bigger content goes as an attachment. */
	maxMessageBytes: number;
	/** URL the runner uses to reach this backend from inside a session container. */
	backendUrl: string;
	/** Where the packaged runner files are (copied into `<runtimeDir>/st` at boot). */
	runnerSrc: string;
	/** Watchdog period: how often each running agent's runner loop is checked. */
	watchdogMs: number;
	/** Loop guard: the deepest agent → agent request a person's message may start. */
	maxDepth: number;
	/** Messages running at once on this backend, all agents together (ACP_MAX_RUNNING). */
	maxRunning: number;
	/** Install the deterministic test adapter as runtime `st-test-agent` (ACP_TEST_RUNTIME=1). */
	testRuntime: boolean;
}

export function acpConfigFromEnv(workspaceRoot: string, port: number): AcpConfig {
	const env = process.env;
	return {
		runtimeDir: env.ACP_RUNTIME_DIR ?? path.join(workspaceRoot, ".acp-runtime"),
		defaultRuntime: env.ACP_DEFAULT_RUNTIME ?? "claude-acp-0.108.0",
		defaultModel: env.ACP_DEFAULT_MODEL ?? "claude-sonnet-5-5",
		maxMessageBytes: Number(env.ACP_MESSAGE_MAX_BYTES ?? 256 * 1024),
		watchdogMs: Number(env.ACP_WATCHDOG_MS ?? 30_000),
		maxDepth: Number(env.ACP_MAX_DEPTH ?? DEFAULT_MAX_DEPTH),
		maxRunning: Number(env.ACP_MAX_RUNNING ?? 6),
		testRuntime: env.ACP_TEST_RUNTIME === "1",
		backendUrl: env.ACP_BACKEND_URL ?? `http://st-backend:${port}`,
		// src/acp (tsx) and dist/acp (image, which copies it to /acp-runtime)
		// both resolve to <repo or image root>/acp-runtime.
		runnerSrc: env.ACP_RUNNER_SRC ?? path.resolve(__dirname, "../../../acp-runtime"),
	};
}

const RUNTIME_MOUNT = "/opt/st-acp";
export const TEST_RUNTIME = "st-test-agent";
// Slot 1 keeps exactly the names it had before there were slots (lock, log,
// process command line), so a one-slot agent is the runner of always. Slot k ≥ 2
// carries k in every name and as the runner's argument.
const sfx = (slot: number) => (slot === 1 ? "" : `-${slot}`);
const runnerLock = (slot: number) => `/tmp/st-acp-runner${sfx(slot)}.lock`;
const runnerLog = (slot: number) => `/tmp/st-acp-runner${sfx(slot)}.log`;
const runnerCmd = (slot: number) =>
	`node --no-warnings ${RUNTIME_MOUNT}/st/runner.mjs${slot === 1 ? "" : ` ${slot}`}`;
/** Upper bound of `max_concurrency` (PATCH /agents/:name). */
export const MAX_SLOTS = 4;
// Liveness of ONE slot from the processes themselves (never from silence, never
// by taking the lock — a probe holding it would make a concurrent launch give up):
// exit 0: the slot's restart loop is there (alive);
// exit 3: no loop, but the slot's runner (or a holder of its launch lock) still
//         lives — unsupervised, NOT dead: launching would make a second runner
//         on the same ACP session, so nothing is launched; when it exits, the
//         next probe sees 1;
// exit 1: nothing (dead — safe to launch, still under `flock -n`).
// Patterns are anchored at both ends of the slot's own command (its log file
// for the loop, its argument for the runner), so slots never match each other
// and never this probe's own `sh -c`.
export function runnerProbe(slot: number): string {
	const cmd = runnerCmd(slot).replace(/\./g, "\\.");
	return [
		`pgrep -f '^sh -c while true; do ${cmd} >> ${runnerLog(slot).replace(/\./g, "\\.")} ' >/dev/null && exit 0`,
		`pgrep -f '^${cmd}$' >/dev/null && exit 3`,
		`i=$(stat -c %i ${runnerLock(slot)} 2>/dev/null) && grep -q ":$i " /proc/locks && exit 3`,
		"exit 1",
	].join("\n");
}
// Names an agent can be addressed by (`st send @name`). `owner` and `system`
// are the person and Shared Terminal itself.
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** An execution context name; it becomes a directory `.st/ctx/<name>/` in the workspace. */
export const CONTEXT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED_NAMES = new Set(["owner", "system", "all"]);

export function agentNameError(name: unknown): string | null {
	if (typeof name !== "string" || !AGENT_NAME_RE.test(name))
		return "agent name must match ^[a-z][a-z0-9-]{1,31}$";
	if (RESERVED_NAMES.has(name)) return `agent name '${name}' is reserved`;
	return null;
}

// ── Rows ──────────────────────────────────────────────────────────────────

export interface AgentRow {
	agent_id: string;
	session_id: string;
	owner_user_id: string;
	name: string;
	runtime: string;
	model: string | null;
	created_at: string;
	/** The project this agent takes part in (v22); NULL = none. */
	project_id: string | null;
	/** Reasoning effort the runner asks its adapter for (v23); NULL = "default" (the CLI decides). */
	effort: string | null;
	/** Slots (messages at once) this agent runs, 1..MAX_SLOTS (v24). */
	max_concurrency: number;
}

export type MessageState = "pending" | "running" | "done" | "failed" | "uncertain";

export interface MessageRow {
	id: number;
	owner_user_id: string;
	from_id: string;
	to_id: string;
	kind: "request" | "reply";
	reply_to: number | null;
	body: string;
	state: MessageState;
	attempts: number;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	result_text: string | null;
	stop_reason: string | null;
	note: string | null;
	/** Scope (v22): NULL = direct message, else posted in that project's chat. */
	project_id: string | null;
	/** Hops from the person's message (loop guard); 0 = sent by a person. */
	depth: number;
	client_id: string | null;
	/** Execution context (v24): NULL = the default one (workspace checkout, slot 1). */
	context: string | null;
	/** The sender's context of an agent's request: where its reply goes back (v24). */
	from_context: string | null;
	/** Slot that took it while running (v24); kept afterwards as a record. */
	slot: number | null;
}

export type QuestionState = "open" | "answered" | "delivered" | "withdrawn" | "orphaned";

export interface QuestionRow {
	id: number;
	owner_user_id: string;
	agent: string;
	message_id: number | null;
	/** JSON: the ACP form elicitation as the adapter sent it ({message, requestedSchema, …}). */
	request: string;
	state: QuestionState;
	/** JSON: the ACP elicitation response ({action, content?}). */
	answer: string | null;
	created_at: string;
	answered_at: string | null;
	delivered_at: string | null;
	note: string | null;
}

/** What the live channel (/ws/acp) pushes to an owner's browsers. */
export type AcpEvent =
	| { type: "message"; message: MessageRow }
	| { type: "question"; question: QuestionRow }
	| { type: "activity"; agent: string; events: ActivityEvent[] }
	| { type: "agents" };

export interface AgentLoad {
	/** Id of the message the agent is working on, if any. */
	running: number | null;
	pending: number;
}

export interface LoginMethod {
	id: string;
	name: string;
	description: string;
	/** argv: the adapter's own login command (terminal-auth). */
	command: string[];
}

export interface ActivityEvent {
	seq: number;
	at: string;
	messageId: number | null;
	kind: string;
	[key: string]: unknown;
}

/** What a runner reported after asking its adapter for a model. */
export interface ModelApplied {
	/** The model id the runner asked for. */
	requested: string;
	/** The adapter's current model after the switch (its own id), null if it did not say. */
	current: string | null;
	/** Why the switch failed, if it did (the agent keeps its previous model). */
	error: string | null;
	at: string;
}

/**
 * What a runner reported after applying the effort to its adapter. The levels
 * are the adapter's own for `model` (the product hardcodes none); empty when
 * that model offers no effort.
 */
export interface EffortApplied {
	/** The model the runner had applied when it reported (its requested id). */
	model: string | null;
	/** The level the runner asked for ("default" = none pinned). */
	requested: string;
	/** The adapter's current level after the request, null if it offers none. */
	current: string | null;
	levels: string[];
	/** Why the level was not applied, if it was not (the agent keeps its previous one). */
	error: string | null;
	at: string;
}

/**
 * Validates a requested effort: a level-shaped string or null. Only the shape:
 * which levels exist is the adapter's answer for the agent's model. "default"
 * is stored as NULL (no level pinned). Returns undefined for a bad value.
 */
export function effortOf(v: unknown): string | null | undefined {
	if (v === null || v === "default") return null;
	return typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(v) ? v : undefined;
}

/** A `clientId` already used for a different message to the same recipient. */
export class ClientIdConflictError extends Error {
	constructor(readonly existingId: number) {
		super("clientId already used for a different message");
	}
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// The claim's and the system message's shared guard (?1 owner, ?2 agent, ?3
// slot, ?5 global cap): the slot is free and exists, the agent is under its
// cap and the backend under ACP_MAX_RUNNING — all in the writing statement.
const RUN_GUARD = `NOT EXISTS (SELECT 1 FROM agent_messages y WHERE y.owner_user_id = ?1 AND y.to_id = ?2 AND y.state = 'running' AND y.slot = ?3)
	AND ?3 <= (SELECT max_concurrency FROM acp_agents WHERE owner_user_id = ?1 AND name = ?2)
	AND (SELECT COUNT(*) FROM agent_messages y WHERE y.owner_user_id = ?1 AND y.to_id = ?2 AND y.state = 'running')
		< (SELECT max_concurrency FROM acp_agents WHERE owner_user_id = ?1 AND name = ?2)
	AND (SELECT COUNT(*) FROM agent_messages y WHERE y.state = 'running') < ?5`;
const ACTIVITY_MAX = 500;
/** Agent → agent hops allowed below one person's message (ACP_MAX_DEPTH). */
export const DEFAULT_MAX_DEPTH = 6;

export class AcpAgents {
	private readonly tokenKey = deriveSubkey("st-acp-agent-token/v1");
	private readonly byId = new Map<string, AgentRow>();
	private readonly activity = new Map<string, { events: ActivityEvent[]; seenAt: number }>();
	/** One sequence for every agent's activity, so a project view keeps one cursor. */
	private activitySeq = 0;
	private readonly listeners = new Set<(ownerUserId: string, ev: AcpEvent) => void>();

	constructor(
		readonly config: AcpConfig,
		private readonly docker: DockerManager,
	) {}

	// ── Live events (in-process: every write goes through this object) ─────

	onEvent(fn: (ownerUserId: string, ev: AcpEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private publish(ownerUserId: string, ev: AcpEvent): void {
		for (const fn of this.listeners) {
			try {
				fn(ownerUserId, ev);
			} catch (err) {
				logger.warn(`[acp] event listener: ${(err as Error).message}`);
			}
		}
	}

	private published(row: MessageRow | null | undefined): MessageRow | null {
		if (row) this.publish(row.owner_user_id, { type: "message", message: row });
		return row ?? null;
	}

	// ── Runtime files ──────────────────────────────────────────────────────

	/** Copies the packaged runner into `<runtimeDir>/st` (the runner is versioned with this backend). */
	async installRunnerFiles(): Promise<void> {
		const dest = path.join(this.config.runtimeDir, "st");
		await fs.mkdir(path.join(dest, "bin"), { recursive: true });
		for (const f of ["runner.mjs", "bin/st", "package.json"]) {
			const tmp = path.join(dest, `${f}.tmp`);
			await fs.copyFile(path.join(this.config.runnerSrc, f), tmp);
			await fs.chmod(tmp, 0o755);
			await fs.rename(tmp, path.join(dest, f));
		}
		// The deterministic test adapter (acp-runtime/test-agent.mjs): a runtime
		// like any other, present only when asked for.
		const testDir = path.join(this.config.runtimeDir, TEST_RUNTIME);
		if (this.config.testRuntime) {
			await fs.copyFile(
				path.join(this.config.runnerSrc, "test-agent.mjs"),
				path.join(dest, "test-agent.mjs.tmp"),
			);
			await fs.rename(path.join(dest, "test-agent.mjs.tmp"), path.join(dest, "test-agent.mjs"));
			await fs.mkdir(testDir, { recursive: true });
			await fs.writeFile(
				path.join(testDir, "agent.tmp"),
				`#!/bin/sh\nexec node ${RUNTIME_MOUNT}/st/test-agent.mjs "$@"\n`,
				{ mode: 0o755 },
			);
			await fs.rename(path.join(testDir, "agent.tmp"), path.join(testDir, "agent"));
		} else await fs.rm(testDir, { recursive: true, force: true });
		const runtimes = await fs.readdir(this.config.runtimeDir).catch(() => []);
		logger.info(
			`[acp] runner installed in ${dest}; runtimes present: ${runtimes.filter((r) => r !== "st").join(", ") || "none"}`,
		);
	}

	// ── Agents ─────────────────────────────────────────────────────────────

	async create(
		sessionId: string,
		ownerUserId: string,
		name: string,
		opts: {
			model?: string;
			effort?: string | null;
			runtime?: string;
			projectId?: string | null;
		} = {},
	): Promise<AgentRow> {
		// Messages are addressed by name and outlive a hard-deleted agent: what
		// that agent left unfinished must not be picked up by a new agent that
		// takes the name. Only rows of a name no agent holds (the INSERT below
		// fails when one does). The hard delete itself closes them (onPurged);
		// this catches a delete whose close failed.
		await this.failInbox(ownerUserId, name, { onlyIfUnheld: true });
		const row = (
			await d1Query<AgentRow>(
				"INSERT INTO acp_agents (agent_id, session_id, owner_user_id, name, runtime, model, project_id, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
				[
					randomUUID(),
					sessionId,
					ownerUserId,
					name,
					opts.runtime ?? this.config.defaultRuntime,
					opts.model ?? this.config.defaultModel,
					opts.projectId ?? null,
					opts.effort ?? null,
				],
			)
		).results[0];
		this.byId.set(row.agent_id, row);
		this.publish(ownerUserId, { type: "agents" });
		return row;
	}

	/** Adapter bundles installed in the runtime dir (one dir each, with an `agent` entry). */
	async runtimes(): Promise<string[]> {
		const out: string[] = [];
		for (const d of await fs.readdir(this.config.runtimeDir).catch(() => [] as string[])) {
			if (d === "st" || d.startsWith(".")) continue;
			if (
				await fs
					.access(path.join(this.config.runtimeDir, d, "agent"))
					.then(() => true)
					.catch(() => false)
			)
				out.push(d);
		}
		return out.sort();
	}

	/** Joins (or, with null, leaves) a project. The agent keeps its session, context and history. */
	async setProject(
		ownerUserId: string,
		name: string,
		projectId: string | null,
	): Promise<AgentRow | null> {
		const r = await d1Query<AgentRow>(
			"UPDATE acp_agents SET project_id = ? WHERE owner_user_id = ? AND name = ? RETURNING *",
			[projectId, ownerUserId, name],
		);
		const row = r.results[0] ?? null;
		if (row) {
			this.byId.set(row.agent_id, row);
			this.publish(ownerUserId, { type: "agents" });
			logger.info(
				`[acp] @${name} ${projectId ? `joined project ${projectId}` : "left its project"}`,
			);
		}
		return row;
	}

	/**
	 * Changes the model the agent's runner asks its adapter for. Nothing is
	 * restarted here: the runner reads the requested model with every claim and
	 * switches the live ACP session (`session/set_config_option`) while it is
	 * idle — a message being worked on finishes on the model it started with —
	 * and re-applies it after every adapter (re)start, so a resume never goes
	 * back to the launch-time ANTHROPIC_MODEL. What the adapter confirmed comes
	 * back through `setModelApplied`.
	 */
	async setModel(ownerUserId: string, name: string, model: string): Promise<AgentRow | null> {
		const r = await d1Query<AgentRow>(
			"UPDATE acp_agents SET model = ? WHERE owner_user_id = ? AND name = ? RETURNING *",
			[model, ownerUserId, name],
		);
		const row = r.results[0] ?? null;
		if (row) {
			this.byId.set(row.agent_id, row);
			this.publish(ownerUserId, { type: "agents" });
			logger.info(`[acp] @${name} model → ${model} (applied by its runner when idle)`);
		}
		return row;
	}

	/**
	 * Changes the reasoning effort, the same way as `setModel`: the runner
	 * applies it while idle and re-applies it after every adapter (re)start and
	 * model switch. NULL = "default". Whether the level exists for the agent's
	 * model is the adapter's answer, reported through `setEffortApplied`.
	 */
	async setEffort(
		ownerUserId: string,
		name: string,
		effort: string | null,
	): Promise<AgentRow | null> {
		const r = await d1Query<AgentRow>(
			"UPDATE acp_agents SET effort = ? WHERE owner_user_id = ? AND name = ? RETURNING *",
			[effort, ownerUserId, name],
		);
		const row = r.results[0] ?? null;
		if (row) {
			this.byId.set(row.agent_id, row);
			this.publish(ownerUserId, { type: "agents" });
			logger.info(
				`[acp] @${name} effort → ${effort ?? "default"} (applied by its runner when idle)`,
			);
		}
		return row;
	}

	/** The model the runner's adapter reports after its last switch (memory only, like activity). */
	private readonly modelApplied = new Map<string, ModelApplied>();

	setModelApplied(agent: AgentRow, body: unknown): void {
		const b = (body ?? {}) as { requested?: unknown; current?: unknown; error?: unknown };
		const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);
		const requested = str(b.requested, 80);
		if (requested === null) return;
		this.modelApplied.set(agent.agent_id, {
			requested,
			current: str(b.current, 120),
			error: str(b.error, 300),
			at: new Date().toISOString(),
		});
		this.publish(agent.owner_user_id, { type: "agents" });
	}

	modelAppliedOf(agentId: string): ModelApplied | null {
		return this.modelApplied.get(agentId) ?? null;
	}

	/** The effort the runner's adapter reports after its last request (memory only). */
	private readonly effortApplied = new Map<string, EffortApplied>();

	setEffortApplied(agent: AgentRow, body: unknown): void {
		const b = (body ?? {}) as {
			model?: unknown;
			requested?: unknown;
			current?: unknown;
			levels?: unknown;
			error?: unknown;
		};
		const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);
		const requested = str(b.requested, 32);
		if (requested === null) return;
		const levels =
			Array.isArray(b.levels) &&
			b.levels.length <= 16 &&
			b.levels.every((l) => typeof l === "string" && l.length <= 32)
				? (b.levels as string[])
				: [];
		this.effortApplied.set(agent.agent_id, {
			model: str(b.model, 80),
			requested,
			current: str(b.current, 32),
			levels,
			error: str(b.error, 300),
			at: new Date().toISOString(),
		});
		this.publish(agent.owner_user_id, { type: "agents" });
	}

	effortAppliedOf(agentId: string): EffortApplied | null {
		return this.effortApplied.get(agentId) ?? null;
	}

	/** Running message and queue length per agent name (one query). */
	async loads(ownerUserId: string): Promise<Map<string, AgentLoad>> {
		const r = await d1Query<{ to_id: string; running: number | null; pending: number }>(
			`SELECT to_id, MAX(CASE WHEN state = 'running' THEN id END) AS running,
				SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending
			 FROM agent_messages WHERE owner_user_id = ? AND state IN ('pending', 'running') GROUP BY to_id`,
			[ownerUserId],
		);
		return new Map(
			r.results.map((x) => [x.to_id, { running: x.running ?? null, pending: Number(x.pending) }]),
		);
	}

	async nameTaken(ownerUserId: string, name: string): Promise<boolean> {
		const r = await d1Query("SELECT 1 FROM acp_agents WHERE owner_user_id = ? AND name = ?", [
			ownerUserId,
			name,
		]);
		return r.results.length > 0;
	}

	// By session / by name always read D1: an agent row goes away with a hard
	// delete of its session (cascade) and its name may be taken again by a new
	// agent, so a cached row could name the wrong session. The cache (byId)
	// serves only what is keyed by the immutable agent id (tokens, watchdog).
	async bySession(sessionId: string): Promise<AgentRow | null> {
		const r = await d1Query<AgentRow>("SELECT * FROM acp_agents WHERE session_id = ?", [sessionId]);
		const row = r.results[0] ?? null;
		if (row) this.byId.set(row.agent_id, row);
		return row;
	}

	async byName(ownerUserId: string, name: string): Promise<AgentRow | null> {
		const r = await d1Query<AgentRow>(
			"SELECT * FROM acp_agents WHERE owner_user_id = ? AND name = ?",
			[ownerUserId, name],
		);
		const row = r.results[0] ?? null;
		if (row) this.byId.set(row.agent_id, row);
		return row;
	}

	async list(ownerUserId: string): Promise<AgentRow[]> {
		const r = await d1Query<AgentRow>(
			"SELECT * FROM acp_agents WHERE owner_user_id = ? ORDER BY name",
			[ownerUserId],
		);
		// The owner's agents as D1 has them now: rows of deleted sessions leave the cache.
		for (const [id, a] of this.byId) if (a.owner_user_id === ownerUserId) this.byId.delete(id);
		for (const row of r.results) this.byId.set(row.agent_id, row);
		return r.results;
	}

	runnerSeenAt(agentId: string): string | null {
		const a = this.activity.get(agentId);
		return a?.seenAt ? new Date(a.seenAt).toISOString() : null;
	}

	// ── Agent tokens ───────────────────────────────────────────────────────
	// Recomputable, nothing stored, so re-launching a runner never invalidates a
	// live one:
	// - `acp1.<agentId>.<hmac>`: the runner's (every slot's) and the default
	//   context's — slot 1's adapter, hence its Bash and `st`, inherits it from
	//   the environment as it always did;
	// - `acp1.<agentId>.<context>.<hmac>`: a named context's. A slot ≥ 2 hands it
	//   to the ACP session of that context (`_meta.claudeCode.options.env`, on
	//   new AND resume: verified against claude-agent-acp 0.108.0, a resume
	//   without it falls back to the adapter's own environment), so everything
	//   that session runs — Bash in background, subagents, a resumed session —
	//   says which context it comes from. It is not per message: renewing a
	//   session's environment means restarting its Claude process, which kills
	//   the processes the agent left running (verified). It cannot reach the
	//   runner routes.

	tokenFor(agentId: string, context: string | null = null): string {
		const subject = context === null ? agentId : `${agentId}.${context}`;
		return `acp1.${subject}.${createHmac("sha256", this.tokenKey).update(subject).digest("base64url")}`;
	}

	async verifyToken(
		token: string,
	): Promise<{ agent: AgentRow; context: string | null; runner: boolean } | null> {
		const m = /^acp1\.([0-9a-f-]{36})(?:\.([a-z0-9][a-z0-9-]{0,39}))?\.([A-Za-z0-9_-]{43})$/.exec(
			token,
		);
		if (!m) return null;
		const context = m[2] ?? null;
		const want = Buffer.from(this.tokenFor(m[1], context).split(".").at(-1) as string);
		const got = Buffer.from(m[3]);
		if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
		let row = this.byId.get(m[1]) ?? null;
		if (!row) {
			const r = await d1Query<AgentRow>("SELECT * FROM acp_agents WHERE agent_id = ?", [m[1]]);
			row = r.results[0] ?? null;
			if (row) this.byId.set(row.agent_id, row);
		}
		return row ? { agent: row, context, runner: context === null } : null;
	}

	// ── Messages ───────────────────────────────────────────────────────────

	/**
	 * Persists one message (the INSERT is the acknowledgement). With a
	 * `clientId` the send is idempotent per recipient: a retry returns the row
	 * the first attempt wrote (`replayed`).
	 */
	async send(m: {
		ownerUserId: string;
		from: string;
		to: string;
		body: string;
		projectId?: string | null;
		depth?: number;
		clientId?: string | null;
		/** Where the recipient runs it (only the person sets it); NULL = its default context. */
		context?: string | null;
		/** An agent sender's context (from its credential): where the reply goes back. */
		fromContext?: string | null;
	}): Promise<{ message: MessageRow; replayed: boolean }> {
		const params = [
			m.ownerUserId,
			m.from,
			m.to,
			m.body,
			m.projectId ?? null,
			m.depth ?? 0,
			m.clientId ?? null,
			m.context ?? null,
			m.fromContext ?? null,
		];
		const r = await d1Query<MessageRow>(
			"INSERT OR IGNORE INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state, project_id, depth, client_id, context, from_context) VALUES (?, ?, ?, 'request', ?, 'pending', ?, ?, ?, ?, ?) RETURNING *",
			params,
		);
		if (r.results[0])
			return { message: this.published(r.results[0]) as MessageRow, replayed: false };
		const prior = await d1Query<MessageRow>(
			"SELECT * FROM agent_messages WHERE owner_user_id = ? AND client_id = ? AND to_id = ?",
			[m.ownerUserId, m.clientId ?? null, m.to],
		);
		const p = prior.results[0];
		if (!p) throw new Error("message insert returned nothing");
		// A replay is the SAME send retried: same sender, text and scope. The key
		// space is per owner, shared by the person and that owner's agents, so a
		// reused id with anything else is refused rather than answered with
		// someone else's row — which would report a new message as sent while
		// dropping it. Exact comparison only: no similarity-based deduplication.
		if (
			p.from_id !== m.from ||
			p.body !== m.body ||
			p.project_id !== (m.projectId ?? null) ||
			p.context !== (m.context ?? null)
		)
			throw new ClientIdConflictError(p.id);
		return { message: p, replayed: true };
	}

	/**
	 * A page of messages, newest `limit` before `before` (exclusive), oldest
	 * first. `agent`: everything to or from that agent, any scope (its
	 * individual chat — the owner's view of the agent's whole inbox).
	 * `projectId`: only what was posted in that project.
	 */
	async messages(
		ownerUserId: string,
		filter: { agent?: string | null; projectId?: string | null; before?: number | null },
		limit = 100,
	): Promise<MessageRow[]> {
		const r = await d1Query<MessageRow>(
			`SELECT * FROM (SELECT * FROM agent_messages WHERE owner_user_id = ?1
				AND (?2 IS NULL OR to_id = ?2 OR from_id = ?2)
				AND (?3 IS NULL OR project_id = ?3)
				AND (?4 IS NULL OR id < ?4)
			 ORDER BY id DESC LIMIT ?5) ORDER BY id`,
			[ownerUserId, filter.agent ?? null, filter.projectId ?? null, filter.before ?? null, limit],
		);
		return r.results;
	}

	async message(ownerUserId: string, id: number): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			"SELECT * FROM agent_messages WHERE owner_user_id = ? AND id = ?",
			[ownerUserId, id],
		);
		return r.results[0] ?? null;
	}

	/** The project as an agent's prompt names it: its name and who takes part. */
	async projectContext(
		ownerUserId: string,
		projectId: string,
	): Promise<{ id: string; name: string; agents: string[] } | null> {
		const r = await d1Query<{ name: string; agents: string | null }>(
			`SELECT p.name AS name, (SELECT group_concat(a.name, ' ') FROM acp_agents a
				WHERE a.owner_user_id = p.owner_user_id AND a.project_id = p.project_id) AS agents
			 FROM projects p WHERE p.project_id = ? AND p.owner_user_id = ?`,
			[projectId, ownerUserId],
		);
		const row = r.results[0];
		if (!row) return null;
		return {
			id: projectId,
			name: row.name,
			agents: (row.agents ?? "").split(" ").filter(Boolean).sort(),
		};
	}

	/** Live (not archived) project of this owner. */
	async ownsProject(ownerUserId: string, projectId: string): Promise<boolean> {
		const r = await d1Query(
			"SELECT 1 FROM projects WHERE project_id = ? AND owner_user_id = ? AND archived_at IS NULL",
			[projectId, ownerUserId],
		);
		return r.results.length > 0;
	}

	/** The message running in one context of this agent (at most one: the claim's guard). */
	async runningIn(agent: AgentRow, context: string | null): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			"SELECT * FROM agent_messages WHERE owner_user_id = ? AND to_id = ? AND state = 'running' AND context IS ?",
			[agent.owner_user_id, agent.name, context],
		);
		return r.results[0] ?? null;
	}

	/** The message one slot of this agent took and has not settled (at most one). */
	async runningInSlot(agent: AgentRow, slot: number): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			"SELECT * FROM agent_messages WHERE owner_user_id = ? AND to_id = ? AND state = 'running' AND slot = ?",
			[agent.owner_user_id, agent.name, slot],
		);
		return r.results[0] ?? null;
	}

	/**
	 * One statement (the whole distribution: there is no scheduler). Slot `slot`
	 * takes the oldest pending message it may run, recording itself, only if:
	 * - the slot runs nothing now and exists (slot ≤ the agent's max_concurrency);
	 * - the message's context has nothing running (one per agent and context:
	 *   two runs never share a checkout or an ACP session);
	 * - slot 1 takes only the default context (NULL), slots ≥ 2 only named ones —
	 *   so the default ACP session is only ever open in slot 1, as before slots;
	 * - `onlyContext`: a slot holding a context it cannot close (processes the
	 *   agent left running there) takes only that context's messages;
	 * - the agent's running count < max_concurrency and the backend's < maxRunning.
	 */
	async claim(
		agent: AgentRow,
		slot = 1,
		onlyContext: string | null = null,
	): Promise<MessageRow | null> {
		this.touch(agent.agent_id);
		const r = await d1Query<MessageRow>(
			`UPDATE agent_messages SET state = 'running', attempts = attempts + 1, started_at = ${NOW}, slot = ?3
			 WHERE id = (SELECT m.id FROM agent_messages m WHERE m.owner_user_id = ?1 AND m.to_id = ?2 AND m.state = 'pending'
				AND (CASE WHEN ?3 = 1 THEN m.context IS NULL ELSE m.context IS NOT NULL END)
				AND (?4 IS NULL OR m.context = ?4)
				AND NOT EXISTS (SELECT 1 FROM agent_messages x WHERE x.owner_user_id = ?1 AND x.to_id = ?2 AND x.state = 'running' AND x.context IS m.context)
				ORDER BY m.id LIMIT 1)
			 AND ${RUN_GUARD}
			 RETURNING *`,
			[agent.owner_user_id, agent.name, slot, onlyContext, this.config.maxRunning],
		);
		return this.published(r.results[0]);
	}

	/**
	 * A message from Shared Terminal itself, already `running` in `slot` and
	 * `context` (the runner sends it right away): the controlled continuation
	 * after an interrupted run, in the ACP session of the interrupted message's
	 * context. Same guards as a claim — never a second running message in the
	 * slot or the context, caps respected.
	 */
	async startSystemMessage(
		agent: AgentRow,
		body: string,
		slot = 1,
		context: string | null = null,
	): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			`INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state, attempts, started_at, slot, context)
			 SELECT ?1, 'system', ?2, 'request', ?6, 'running', 1, ${NOW}, ?3, ?4
			 WHERE NOT EXISTS (SELECT 1 FROM agent_messages x WHERE x.owner_user_id = ?1 AND x.to_id = ?2 AND x.state = 'running' AND x.context IS ?4)
			 AND ${RUN_GUARD}
			 RETURNING *`,
			[agent.owner_user_id, agent.name, slot, context, this.config.maxRunning, body],
		);
		return this.published(r.results[0]);
	}

	/** Changes how many slots (messages at once) the agent runs; a new slot is launched at once. */
	async setMaxConcurrency(ownerUserId: string, name: string, n: number): Promise<AgentRow | null> {
		const r = await d1Query<AgentRow>(
			"UPDATE acp_agents SET max_concurrency = ? WHERE owner_user_id = ? AND name = ? RETURNING *",
			[n, ownerUserId, name],
		);
		const row = r.results[0] ?? null;
		if (row) {
			this.byId.set(row.agent_id, row);
			this.publish(ownerUserId, { type: "agents" });
			logger.info(`[acp] @${name} max_concurrency → ${n}`);
			// Raising it launches the new slots now (the probe never doubles one);
			// lowering it lets the extra slots finish what they run and claim nothing.
			void this.checkRunner(row);
		}
		return row;
	}

	/** Records the run's result; the reply to an agent's request is the v21 trigger's, same statement. */
	async settle(
		agent: AgentRow,
		id: number,
		s: {
			state: MessageState;
			text?: string | null;
			stopReason?: string | null;
			note?: string | null;
		},
	): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			`UPDATE agent_messages SET state = ?, result_text = ?, stop_reason = ?, note = ?, finished_at = ${NOW}
			 WHERE id = ? AND owner_user_id = ? AND to_id = ? AND state = 'running' RETURNING *`,
			[
				s.state,
				s.text ?? null,
				s.stopReason ?? null,
				s.note ?? null,
				id,
				agent.owner_user_id,
				agent.name,
			],
		);
		const row = this.published(r.results[0]);
		// The trigger's reply (same statement) is a new message: push it too.
		if (row?.state === "done" && row.kind === "request" && row.from_id !== "owner") {
			const reply = await d1Query<MessageRow>(
				"SELECT * FROM agent_messages WHERE owner_user_id = ? AND reply_to = ? AND kind = 'reply'",
				[row.owner_user_id, row.id],
			).catch(() => null);
			this.published(reply?.results[0]);
		}
		// Run whether or not the UPDATE matched: a runner that lost the answer
		// re-posts the same result, finds the row already settled (409), and this
		// still writes the notice a crash between the two statements left out.
		if (s.state === "failed" || s.state === "uncertain")
			await this.noticeUnfinished(agent.owner_user_id, id);
		return row;
	}

	/**
	 * The v22 trigger answers an agent's request only when it ends `done`. One
	 * that ends `failed` or `uncertain` would leave its sender — told by the
	 * protocol that the answer arrives by itself and not to wait for it — with
	 * nothing, ever. This writes that answer: a `reply` correlated by
	 * `reply_to`, in the request's scope and depth, at most once per request
	 * and terminal state (an `uncertain` request the person requeues may still
	 * end `done`, and then the trigger's real reply follows). A person's
	 * message gets none: the person sees the state in Chat.
	 *
	 * The notice must not become a resend by other means: the requester is a
	 * model that could simply ask again, repeating effects the interrupted run
	 * may already have had. Shared Terminal itself never re-sends; the text
	 * tells the agent not to either, and leaves the retry to the person
	 * (requeue). A repeat the agent sends anyway is still bounded by depth.
	 */
	private async noticeUnfinished(ownerUserId: string, id: number): Promise<void> {
		const r = await d1Query<MessageRow>(
			`INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, reply_to, body, state, project_id, depth, note, context)
			 SELECT m.owner_user_id, m.to_id, m.from_id, 'reply', m.id,
				'Tu mensaje #' || m.id || ' a @' || m.to_id || ' no terminó: ' ||
				CASE m.state WHEN 'failed' THEN 'falló' ELSE 'se interrumpió y su estado es incierto: pudo haber hecho parte del trabajo' END ||
				COALESCE(' — ' || m.note, '') || '. No hay respuesta de @' || m.to_id || ' para ese pedido. ' ||
				'No lo repitas ni lo reenvíes por tu cuenta: puede haber tenido efectos, y si se reintenta lo decide la persona. ' ||
				'Decí en tu respuesta que ese pedido no terminó y seguí solo con lo que no dependa de él.',
				'pending', m.project_id, m.depth, 'unfinished:' || m.state, m.from_context
			 FROM agent_messages m
			 WHERE m.owner_user_id = ?1 AND m.id = ?2 AND m.kind = 'request' AND m.state IN ('failed', 'uncertain')
			 AND EXISTS (SELECT 1 FROM acp_agents a WHERE a.owner_user_id = m.owner_user_id AND a.name = m.from_id)
			 AND NOT EXISTS (SELECT 1 FROM agent_messages x WHERE x.owner_user_id = m.owner_user_id
				AND x.reply_to = m.id AND x.kind = 'reply' AND x.note = 'unfinished:' || m.state)
			 RETURNING *`,
			[ownerUserId, id],
		);
		this.published(r.results[0]);
	}

	/** Fails what is still pending or running for `name`, and tells agent senders. */
	private async failInbox(
		ownerUserId: string,
		name: string,
		opts: { onlyIfUnheld: boolean },
	): Promise<void> {
		const r = await d1Query<MessageRow>(
			`UPDATE agent_messages SET state = 'failed', note = 'the agent it was addressed to was deleted', finished_at = ${NOW}
			 WHERE owner_user_id = ?1 AND to_id = ?2 AND state IN ('pending', 'running')
			 ${opts.onlyIfUnheld ? "AND NOT EXISTS (SELECT 1 FROM acp_agents WHERE owner_user_id = ?1 AND name = ?2)" : ""}
			 RETURNING *`,
			[ownerUserId, name],
		);
		for (const m of r.results) {
			this.published(m);
			if (m.kind === "request") await this.noticeUnfinished(ownerUserId, m.id);
		}
	}

	/**
	 * Hard delete of an agent's session (before its row goes, by cascade):
	 * nothing will ever take what is queued for it, so it is closed now — not
	 * left `pending`/`running` in Project Chat until the name is reused — its
	 * open questions can no longer be delivered, and its cached row (which a
	 * token verification would otherwise keep honouring) is dropped.
	 */
	async onPurged(sessionId: string): Promise<void> {
		const agent = await this.bySession(sessionId);
		if (!agent) return;
		await this.failInbox(agent.owner_user_id, agent.name, { onlyIfUnheld: false });
		await this.orphanQuestions(agent, "the agent was deleted");
		this.byId.delete(agent.agent_id);
		this.activity.delete(agent.agent_id);
		this.loginMethods.delete(agent.agent_id);
		this.modelApplied.delete(agent.agent_id);
		this.effortApplied.delete(agent.agent_id);
		this.publish(agent.owner_user_id, { type: "agents" });
	}

	/** The runner proved the prompt never left (adapter did not start): back to pending. */
	async release(agent: AgentRow, id: number, note: string): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			"UPDATE agent_messages SET state = 'pending', note = ? WHERE id = ? AND owner_user_id = ? AND to_id = ? AND state = 'running' RETURNING *",
			[note, id, agent.owner_user_id, agent.name],
		);
		return this.published(r.results[0]);
	}

	/** A person's decision, never automatic. */
	async requeue(ownerUserId: string, id: number): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			"UPDATE agent_messages SET state = 'pending', note = 'requeued by owner' WHERE id = ? AND owner_user_id = ? AND state = 'uncertain' RETURNING *",
			[id, ownerUserId],
		);
		return this.published(r.results[0]);
	}

	// ── Questions (ACP elicitation, e.g. AskUserQuestion) ─────────────────
	// Durable: a question survives the browser, the backend and the runner. The
	// ACP request that waits for the answer lives only in the runner, so a
	// runner restart orphans what it had not delivered — never answers it.

	private publishedQuestion(row: QuestionRow | null | undefined): QuestionRow | null {
		if (row) this.publish(row.owner_user_id, { type: "question", question: row });
		return row ?? null;
	}

	async openQuestion(
		agent: AgentRow,
		messageId: number | null,
		request: unknown,
	): Promise<QuestionRow> {
		// The message id decides where the question is shown (a project's chat
		// shows the questions of its messages), so it is kept only when it names
		// the message this agent is running — an id from the token holder alone
		// could post a question into a project the agent is not in.
		const r = await d1Query<QuestionRow>(
			`INSERT INTO agent_questions (owner_user_id, agent, message_id, request, state)
			 VALUES (?1, ?2, (SELECT id FROM agent_messages WHERE owner_user_id = ?1 AND to_id = ?2 AND id = ?3 AND state = 'running'), ?4, 'open')
			 RETURNING *`,
			[agent.owner_user_id, agent.name, messageId, JSON.stringify(request)],
		);
		return this.publishedQuestion(r.results[0]) as QuestionRow;
	}

	async question(ownerUserId: string, id: number): Promise<QuestionRow | null> {
		const r = await d1Query<QuestionRow>(
			"SELECT * FROM agent_questions WHERE owner_user_id = ? AND id = ?",
			[ownerUserId, id],
		);
		return r.results[0] ?? null;
	}

	/** Questions of these messages, plus every still-open one of these agents. */
	async questionsFor(
		ownerUserId: string,
		messageIds: number[],
		agents: string[],
	): Promise<QuestionRow[]> {
		if (!messageIds.length && !agents.length) return [];
		const r = await d1Query<QuestionRow>(
			`SELECT * FROM agent_questions WHERE owner_user_id = ?1
			 AND (message_id IN (SELECT value FROM json_each(?2)) OR (state = 'open' AND agent IN (SELECT value FROM json_each(?3))))
			 ORDER BY id`,
			[ownerUserId, JSON.stringify(messageIds), JSON.stringify(agents)],
		);
		return r.results;
	}

	/** The person's answer. One conditional UPDATE: only an open question takes one, once. */
	async answerQuestion(
		ownerUserId: string,
		id: number,
		response: unknown,
	): Promise<QuestionRow | null> {
		const r = await d1Query<QuestionRow>(
			`UPDATE agent_questions SET state = 'answered', answer = ?, answered_at = ${NOW}
			 WHERE owner_user_id = ? AND id = ? AND state = 'open' RETURNING *`,
			[JSON.stringify(response), ownerUserId, id],
		);
		return this.publishedQuestion(r.results[0]);
	}

	async runnerQuestion(agent: AgentRow, id: number): Promise<QuestionRow | null> {
		const r = await d1Query<QuestionRow>(
			"SELECT * FROM agent_questions WHERE owner_user_id = ? AND agent = ? AND id = ?",
			[agent.owner_user_id, agent.name, id],
		);
		return r.results[0] ?? null;
	}

	/** The runner handed the answer to the waiting ACP request (or the adapter withdrew it). */
	async closeQuestion(
		agent: AgentRow,
		id: number,
		to: "delivered" | "withdrawn",
	): Promise<QuestionRow | null> {
		const from = to === "delivered" ? "('answered')" : "('open', 'answered')";
		const r = await d1Query<QuestionRow>(
			`UPDATE agent_questions SET state = ?, delivered_at = ${NOW}
			 WHERE owner_user_id = ? AND agent = ? AND id = ? AND state IN ${from} RETURNING *`,
			[to, agent.owner_user_id, agent.name, id],
		);
		return this.publishedQuestion(r.results[0]);
	}

	/**
	 * Runner start: the ACP requests of its previous run are gone. Nothing
	 * becomes answered. With a slot, only that slot's: the questions of messages
	 * it took (slot 1 also those tied to no message) — another slot's runner,
	 * alive, still waits on its own. Without one (agent deleted): all of them.
	 */
	async orphanQuestions(agent: AgentRow, note: string, slot?: number): Promise<QuestionRow[]> {
		const r = await d1Query<QuestionRow>(
			`UPDATE agent_questions SET state = 'orphaned', note = ?1
			 WHERE owner_user_id = ?2 AND agent = ?3 AND state IN ('open', 'answered')
			 AND (?4 IS NULL OR (?4 = 1 AND message_id IS NULL)
				OR message_id IN (SELECT id FROM agent_messages WHERE owner_user_id = ?2 AND to_id = ?3 AND slot = ?4))
			 RETURNING *`,
			[note, agent.owner_user_id, agent.name, slot ?? null],
		);
		for (const q of r.results) this.publishedQuestion(q);
		return r.results;
	}

	/** Agents (of this owner) waiting for the person right now. */
	async waitingAgents(ownerUserId: string): Promise<Set<string>> {
		const r = await d1Query<{ agent: string }>(
			"SELECT DISTINCT agent FROM agent_questions WHERE owner_user_id = ? AND state = 'open'",
			[ownerUserId],
		);
		return new Set(r.results.map((x) => x.agent));
	}

	// ── Login (the adapter's terminal-auth methods) ─────────────────────────
	// The runner reports what its adapter advertises at `initialize`; the
	// person starts one from Chat ("Conectar cuenta"): the exact command runs in
	// a new terminal tab of the agent's session, as the session's user, so the
	// credentials land in the agent's own persistent ~/.claude. Memory only:
	// a runner reports again on every start.

	private readonly loginMethods = new Map<string, LoginMethod[]>();

	setLoginMethods(agent: AgentRow, methods: unknown): void {
		const ok: LoginMethod[] = [];
		for (const m of Array.isArray(methods) ? methods.slice(0, 8) : []) {
			const t = (m as { terminal?: { command?: unknown; args?: unknown; label?: unknown } })
				?.terminal;
			const id = (m as { id?: unknown })?.id;
			if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id) || !t) continue;
			// Only a program under the runtime mount or a system path, args from a
			// safe alphabet: this becomes a shell line in the tab.
			if (
				typeof t.command !== "string" ||
				!/^\/(opt\/st-acp|usr\/(local\/)?bin)\/[A-Za-z0-9._/-]+$/.test(t.command)
			)
				continue;
			const args = Array.isArray(t.args) ? t.args : [];
			if (!args.every((a) => typeof a === "string" && /^[A-Za-z0-9._/=-]{1,200}$/.test(a)))
				continue;
			ok.push({
				id,
				name: String((m as { name?: unknown }).name ?? id).slice(0, 80),
				description: String((m as { description?: unknown }).description ?? "").slice(0, 200),
				command: [t.command, ...(args as string[])],
			});
		}
		this.loginMethods.set(agent.agent_id, ok);
		this.publish(agent.owner_user_id, { type: "agents" });
	}

	loginMethodsOf(agentId: string): LoginMethod[] {
		return this.loginMethods.get(agentId) ?? [];
	}

	/** Opens a terminal tab in the agent's session running the method's login command. */
	async startLogin(agent: AgentRow, methodId: string): Promise<{ tabId: string } | null> {
		const m = this.loginMethodsOf(agent.agent_id).find((x) => x.id === methodId);
		if (!m) return null;
		const line = `${m.command.map((a) => `'${a}'`).join(" ")}; echo; echo 'Listo. Si el login terminó bien, el agente se reactiva solo en unos segundos. Podés cerrar esta pestaña.'; exec bash -l`;
		const tab = await this.docker.createTab(agent.session_id, "Conectar cuenta", line);
		return { tabId: tab.tabId };
	}

	// ── Activity (memory only) ─────────────────────────────────────────────

	private touch(agentId: string) {
		const a = this.activity.get(agentId) ?? { events: [], seenAt: 0 };
		a.seenAt = Date.now();
		this.activity.set(agentId, a);
		return a;
	}

	pushActivity(agent: AgentRow, events: Array<Record<string, unknown>>): void {
		const a = this.touch(agent.agent_id);
		const added: ActivityEvent[] = [];
		for (const e of events.slice(0, 100)) {
			const ev: ActivityEvent = {
				...e,
				seq: ++this.activitySeq,
				at: new Date().toISOString(),
				messageId: typeof e.messageId === "number" ? e.messageId : null,
				kind: String(e.kind ?? "event"),
			};
			a.events.push(ev);
			added.push(ev);
		}
		if (a.events.length > ACTIVITY_MAX) a.events.splice(0, a.events.length - ACTIVITY_MAX);
		if (added.length)
			this.publish(agent.owner_user_id, { type: "activity", agent: agent.name, events: added });
	}

	/** The retained activity of one agent after `after` (0 = all it keeps). */
	activitySince(agentId: string, after = 0): ActivityEvent[] {
		return (this.activity.get(agentId)?.events ?? []).filter((e) => e.seq > after);
	}

	/** Last reported login state of an agent's adapter (from its `auth` / turn events). */
	authRequired(agentId: string): boolean {
		const evs = this.activity.get(agentId)?.events ?? [];
		for (let i = evs.length - 1; i >= 0; i--) {
			const e = evs[i];
			if (e.kind === "auth") return e.state === "required";
			if (e.kind === "turn" && e.phase === "answered") return false;
		}
		return false;
	}

	get currentActivitySeq(): number {
		return this.activitySeq;
	}

	// ── Runner lifecycle ───────────────────────────────────────────────────

	hooks(): AgentLifecycleHooks {
		return {
			prepareSpawn: async (sessionId) => {
				const agent = await this.bySession(sessionId);
				return { binds: agent ? [`${this.config.runtimeDir}:${RUNTIME_MOUNT}:ro`] : [] };
			},
			onPurged: (sessionId) => this.onPurged(sessionId),
			onStarted: (sessionId, containerId) => {
				void this.ensureRunner(sessionId, containerId).catch((err) =>
					logger.warn(`[acp] runner launch for ${sessionId} failed: ${(err as Error).message}`),
				);
			},
		};
	}

	/**
	 * Launches the runner's slots in the container (all of 1..max_concurrency,
	 * or just `slots`). Idempotent per slot: `flock -n` on the slot's lock in the
	 * container's /tmp makes a second launch exit at once while one runs, and
	 * the lock dies with the container. Each slot's shell loop restarts a runner
	 * that exits (by design on an adapter crash) — the only supervision there is.
	 */
	async ensureRunner(sessionId: string, containerId: string, slots?: number[]): Promise<boolean> {
		// The creation bootstrap is still shaping the workspace and ~/.claude;
		// the session the runner creates would never see it (bootstrapHold.ts).
		// `onBootstrapped` launches it once the bootstrap is done.
		if (isBootstrapPending(sessionId)) {
			logger.info(`[acp] runner for ${sessionId} waits for the session's bootstrap`);
			return false;
		}
		const agent = await this.bySession(sessionId);
		if (!agent) return false;
		const runtimeRoot = `${RUNTIME_MOUNT}/${agent.runtime}`;
		for (const slot of slots ?? slotsOf(agent))
			await this.docker.execDetached(
				containerId,
				[
					"flock",
					"-n",
					runnerLock(slot),
					"sh",
					"-c",
					`while true; do ${runnerCmd(slot)} >> ${runnerLog(slot)} 2>&1; sleep 3; done`,
					`st-acp-runner-loop${sfx(slot)}`,
				],
				{
					ST_URL: this.config.backendUrl,
					ST_TOKEN: this.tokenFor(agent.agent_id),
					ST_AGENT: agent.name,
					ACP_AGENT_CMD: `${runtimeRoot}/agent`,
					AGENT_CWD: "/home/developer/workspace",
					RUNNER_STATE: "/home/developer/workspace/.st/acp",
					ANTHROPIC_MODEL: agent.model ?? this.config.defaultModel,
					DISABLE_AUTOUPDATER: "1",
					PATH: `${RUNTIME_MOUNT}/st/bin:/home/developer/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
				},
			);
		logger.info(
			`[acp] runner ensured for @${agent.name} (${sessionId}) on ${agent.runtime}, slots ${(slots ?? slotsOf(agent)).join(",")}`,
		);
		return true;
	}

	// ── Watchdog ────────────────────────────────────────────────────────────
	// Autonomous: every ACP_WATCHDOG_MS, for each known agent whose container is
	// RUNNING (one Docker inspect by name, no D1), the runner's restart loop is
	// checked for real — the process holding its launch lock exists or not
	// (pgrep, not the lock itself) — and only a loop proven dead is launched again. Silence is never a
	// death: a runner busy in a long turn says nothing for minutes. The probe
	// never takes the launch lock (it would make a concurrent launch's `flock
	// -n` give up); duplicates are impossible anyway because every launch runs
	// under that lock. A probe that cannot answer (exec error, timeout) does
	// nothing. A runner that is alive but stuck is not this watchdog's case.

	private watchdog: NodeJS.Timeout | null = null;
	private readonly checking = new Set<string>();
	private readonly orphanReported = new Set<string>();

	startWatchdog(intervalMs = this.config.watchdogMs): void {
		this.stopWatchdog();
		this.watchdog = setInterval(() => void this.watchdogTick(), intervalMs);
		this.watchdog.unref();
	}

	stopWatchdog(): void {
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = null;
	}

	async watchdogTick(): Promise<void> {
		await Promise.all([...this.byId.values()].map((a) => this.checkRunner(a)));
	}

	/** One slot's runner loop state in this container, from runnerProbe's exit code. */
	async probeRunner(
		sessionId: string,
		containerId: string,
		slot = 1,
	): Promise<"alive" | "dead" | "orphaned" | "unknown"> {
		try {
			const r = await this.docker.execCapture(sessionId, ["sh", "-c", runnerProbe(slot)], {
				containerId,
				maxBytes: 256,
				timeoutMs: 10_000,
			});
			return r.exitCode === 0
				? "alive"
				: r.exitCode === 1
					? "dead"
					: r.exitCode === 3
						? "orphaned"
						: "unknown";
		} catch {
			return "unknown";
		}
	}

	async checkRunner(agent: AgentRow): Promise<void> {
		if (this.checking.has(agent.agent_id)) return; // single-flight per agent
		if (isBootstrapPending(agent.session_id)) return; // not dead: not started yet
		this.checking.add(agent.agent_id);
		try {
			const containerId = await this.docker.runningContainerId(
				`st-${agent.session_id.slice(0, 12)}`,
			);
			if (!containerId) return;
			// Each slot on its own: a busy slot is alive, only a dead one is launched.
			for (const slot of slotsOf(agent)) {
				const key = `${agent.agent_id}:${slot}`;
				const state = await this.probeRunner(agent.session_id, containerId, slot);
				if (state === "orphaned" && !this.orphanReported.has(key)) {
					// warn once per episode: the slot still works, it just has no restart loop
					this.orphanReported.add(key);
					logger.warn(
						`[acp] @${agent.name} slot ${slot}: runner alive without its restart loop; not launching a second one (it is relaunched once it exits)`,
					);
				}
				if (state !== "orphaned") this.orphanReported.delete(key);
				if (state !== "dead") continue;
				logger.warn(
					`[acp] runner loop of @${agent.name} slot ${slot} is not running; launching it`,
				);
				await this.ensureRunner(agent.session_id, containerId, [slot]);
			}
		} catch (err) {
			logger.warn(`[acp] watchdog for @${agent.name}: ${(err as Error).message}`);
		} finally {
			this.checking.delete(agent.agent_id);
		}
	}

	/** The session's creation bootstrap succeeded: launch its runner if it is an agent's (through the watchdog's probe, so never a twin). */
	async onBootstrapped(sessionId: string): Promise<void> {
		const agent = await this.bySession(sessionId);
		if (agent) await this.checkRunner(agent);
	}

	/** Boot: running agent sessions get their runner back (a backend restart does not touch containers, but a host reboot does). */
	async ensureAllRunning(): Promise<void> {
		const r = await d1Query<AgentRow>(
			"SELECT a.* FROM acp_agents a JOIN sessions s ON s.session_id = a.session_id WHERE s.status = 'running'",
		);
		for (const row of r.results) this.byId.set(row.agent_id, row);
		// Through the same probe as the watchdog: a backend restart does not kill
		// runners, and one alive without its loop must not get a twin.
		await this.watchdogTick();
	}

	/** Used by the session route to tell the UI which sessions are agents. */
	async sessionsOf(ownerUserId: string): Promise<Map<string, AgentRow>> {
		return new Map((await this.list(ownerUserId)).map((a) => [a.session_id, a]));
	}
}
