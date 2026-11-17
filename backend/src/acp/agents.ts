/**
 * acp/agents.ts — ACP agents (experimental, ACP_AGENTS_ENABLED).
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
import { d1Query } from "../db.js";
import type { AgentLifecycleHooks, DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";
import { deriveSubkey } from "../secrets.js";

// ── Configuration ─────────────────────────────────────────────────────────

export function acpAgentsEnabled(raw: string | undefined): boolean {
	return raw === "1" || raw === "true";
}

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
}

export function acpConfigFromEnv(workspaceRoot: string, port: number): AcpConfig {
	const env = process.env;
	return {
		runtimeDir: env.ACP_RUNTIME_DIR ?? path.join(workspaceRoot, ".acp-runtime"),
		defaultRuntime: env.ACP_DEFAULT_RUNTIME ?? "claude-acp-0.108.0",
		defaultModel: env.ACP_DEFAULT_MODEL ?? "claude-sonnet-5-5",
		maxMessageBytes: Number(env.ACP_MESSAGE_MAX_BYTES ?? 256 * 1024),
		watchdogMs: Number(env.ACP_WATCHDOG_MS ?? 30_000),
		backendUrl: env.ACP_BACKEND_URL ?? `http://st-backend:${port}`,
		// src/acp (tsx) and dist/acp (image, which copies it to /acp-runtime)
		// both resolve to <repo or image root>/acp-runtime.
		runnerSrc: env.ACP_RUNNER_SRC ?? path.resolve(__dirname, "../../../acp-runtime"),
	};
}

const RUNTIME_MOUNT = "/opt/st-acp";
const RUNNER_LOOP_NAME = "st-acp-runner-loop";
const RUNNER_LOCK = "/tmp/st-acp-runner.lock";
// Liveness from the processes themselves (never from silence, never by taking
// the lock — a probe holding it would make a concurrent launch give up):
// exit 0: the restart loop is there (alive);
// exit 3: no loop, but a runner (or a holder of the launch lock) still lives —
//         unsupervised, NOT dead: launching would make a second runner on the
//         same ACP session, so nothing is launched; when it exits, the next
//         probe sees 1;
// exit 1: nothing (dead — safe to launch, still under `flock -n`).
// Patterns are anchored so they never match this probe's own `sh -c`.
export const RUNNER_PROBE = [
	"pgrep -f '^sh -c while true; do node' >/dev/null && exit 0",
	"pgrep -f '^node --no-warnings /opt/st-acp/st/runner.mjs' >/dev/null && exit 3",
	`i=$(stat -c %i ${RUNNER_LOCK} 2>/dev/null) && grep -q ":$i " /proc/locks && exit 3`,
	"exit 1",
].join("\n");
// Names an agent can be addressed by (`st send @name`). `owner` and `system`
// are the person and Shared Terminal itself.
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
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
}

export interface ActivityEvent {
	seq: number;
	at: string;
	messageId: number | null;
	kind: string;
	[key: string]: unknown;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const ACTIVITY_MAX = 500;

export class AcpAgents {
	private readonly tokenKey = deriveSubkey("st-acp-agent-token/v1");
	private readonly byId = new Map<string, AgentRow>();
	private readonly activity = new Map<
		string,
		{ seq: number; events: ActivityEvent[]; seenAt: number }
	>();

	constructor(
		readonly config: AcpConfig,
		private readonly docker: DockerManager,
	) {}

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
		model?: string,
	): Promise<AgentRow> {
		const row = (
			await d1Query<AgentRow>(
				"INSERT INTO acp_agents (agent_id, session_id, owner_user_id, name, runtime, model) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
				[
					randomUUID(),
					sessionId,
					ownerUserId,
					name,
					this.config.defaultRuntime,
					model ?? this.config.defaultModel,
				],
			)
		).results[0];
		this.byId.set(row.agent_id, row);
		return row;
	}

	async nameTaken(ownerUserId: string, name: string): Promise<boolean> {
		const r = await d1Query("SELECT 1 FROM acp_agents WHERE owner_user_id = ? AND name = ?", [
			ownerUserId,
			name,
		]);
		return r.results.length > 0;
	}

	async bySession(sessionId: string): Promise<AgentRow | null> {
		for (const a of this.byId.values()) if (a.session_id === sessionId) return a;
		const r = await d1Query<AgentRow>("SELECT * FROM acp_agents WHERE session_id = ?", [sessionId]);
		const row = r.results[0] ?? null;
		if (row) this.byId.set(row.agent_id, row);
		return row;
	}

	async byName(ownerUserId: string, name: string): Promise<AgentRow | null> {
		for (const a of this.byId.values())
			if (a.owner_user_id === ownerUserId && a.name === name) return a;
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
		for (const row of r.results) this.byId.set(row.agent_id, row);
		return r.results;
	}

	runnerSeenAt(agentId: string): string | null {
		const a = this.activity.get(agentId);
		return a?.seenAt ? new Date(a.seenAt).toISOString() : null;
	}

	// ── Agent tokens ───────────────────────────────────────────────────────
	// `acp1.<agentId>.<hmac>`: recomputable from the agent id, so nothing is
	// stored and re-launching a runner never invalidates a live one.

	tokenFor(agentId: string): string {
		return `acp1.${agentId}.${createHmac("sha256", this.tokenKey).update(agentId).digest("base64url")}`;
	}

	async verifyToken(token: string): Promise<AgentRow | null> {
		const m = /^acp1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
		if (!m) return null;
		const want = Buffer.from(this.tokenFor(m[1]).split(".")[2]);
		const got = Buffer.from(m[2]);
		if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
		const cached = this.byId.get(m[1]);
		if (cached) return cached;
		const r = await d1Query<AgentRow>("SELECT * FROM acp_agents WHERE agent_id = ?", [m[1]]);
		const row = r.results[0] ?? null;
		if (row) this.byId.set(row.agent_id, row);
		return row;
	}

	// ── Messages ───────────────────────────────────────────────────────────

	async send(ownerUserId: string, from: string, to: string, body: string): Promise<MessageRow> {
		return (
			await d1Query<MessageRow>(
				"INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state) VALUES (?, ?, ?, 'request', ?, 'pending') RETURNING *",
				[ownerUserId, from, to, body],
			)
		).results[0];
	}

	async messages(ownerUserId: string, agent: string | null, limit = 200): Promise<MessageRow[]> {
		const r = await d1Query<MessageRow>(
			`SELECT * FROM (SELECT * FROM agent_messages WHERE owner_user_id = ?1 AND (?2 IS NULL OR to_id = ?2 OR from_id = ?2)
			 ORDER BY id DESC LIMIT ?3) ORDER BY id`,
			[ownerUserId, agent, limit],
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

	async running(agent: AgentRow): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			"SELECT * FROM agent_messages WHERE owner_user_id = ? AND to_id = ? AND state = 'running'",
			[agent.owner_user_id, agent.name],
		);
		return r.results[0] ?? null;
	}

	/** One statement: the oldest pending, only if nothing of this agent is running. */
	async claim(agent: AgentRow): Promise<MessageRow | null> {
		this.touch(agent.agent_id);
		const r = await d1Query<MessageRow>(
			`UPDATE agent_messages SET state = 'running', attempts = attempts + 1, started_at = ${NOW}
			 WHERE id = (SELECT id FROM agent_messages WHERE owner_user_id = ?1 AND to_id = ?2 AND state = 'pending' ORDER BY id LIMIT 1)
			 AND NOT EXISTS (SELECT 1 FROM agent_messages WHERE owner_user_id = ?1 AND to_id = ?2 AND state = 'running')
			 RETURNING *`,
			[agent.owner_user_id, agent.name],
		);
		return r.results[0] ?? null;
	}

	/**
	 * A message from Shared Terminal itself, already `running` (the runner sends it
	 * right away): the controlled continuation after an interrupted run. Same
	 * guard as a claim — never a second running message.
	 */
	async startSystemMessage(agent: AgentRow, body: string): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			`INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state, attempts, started_at)
			 SELECT ?1, 'system', ?2, 'request', ?3, 'running', 1, ${NOW}
			 WHERE NOT EXISTS (SELECT 1 FROM agent_messages WHERE owner_user_id = ?1 AND to_id = ?2 AND state = 'running')
			 RETURNING *`,
			[agent.owner_user_id, agent.name, body],
		);
		return r.results[0] ?? null;
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
		return r.results[0] ?? null;
	}

	/** The runner proved the prompt never left (adapter did not start): back to pending. */
	async release(agent: AgentRow, id: number, note: string): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			"UPDATE agent_messages SET state = 'pending', note = ? WHERE id = ? AND owner_user_id = ? AND to_id = ? AND state = 'running' RETURNING *",
			[note, id, agent.owner_user_id, agent.name],
		);
		return r.results[0] ?? null;
	}

	/** A person's decision, never automatic. */
	async requeue(ownerUserId: string, id: number): Promise<MessageRow | null> {
		const r = await d1Query<MessageRow>(
			"UPDATE agent_messages SET state = 'pending', note = 'requeued by owner' WHERE id = ? AND owner_user_id = ? AND state = 'uncertain' RETURNING *",
			[id, ownerUserId],
		);
		return r.results[0] ?? null;
	}

	// ── Activity (memory only) ─────────────────────────────────────────────

	private touch(agentId: string) {
		const a = this.activity.get(agentId) ?? { seq: 0, events: [], seenAt: 0 };
		a.seenAt = Date.now();
		this.activity.set(agentId, a);
		return a;
	}

	pushActivity(agent: AgentRow, events: Array<Record<string, unknown>>): void {
		const a = this.touch(agent.agent_id);
		for (const e of events.slice(0, 100)) {
			a.events.push({
				...e,
				seq: ++a.seq,
				at: new Date().toISOString(),
				messageId: typeof e.messageId === "number" ? e.messageId : null,
				kind: String(e.kind ?? "event"),
			});
		}
		if (a.events.length > ACTIVITY_MAX) a.events.splice(0, a.events.length - ACTIVITY_MAX);
	}

	activitySince(agentId: string, after: number): { seq: number; events: ActivityEvent[] } {
		const a = this.activity.get(agentId);
		if (!a) return { seq: 0, events: [] };
		return { seq: a.seq, events: a.events.filter((e) => e.seq > after) };
	}

	// ── Runner lifecycle ───────────────────────────────────────────────────

	hooks(): AgentLifecycleHooks {
		return {
			prepareSpawn: async (sessionId) => {
				const agent = await this.bySession(sessionId);
				return { binds: agent ? [`${this.config.runtimeDir}:${RUNTIME_MOUNT}:ro`] : [] };
			},
			onStarted: (sessionId, containerId) => {
				void this.ensureRunner(sessionId, containerId).catch((err) =>
					logger.warn(`[acp] runner launch for ${sessionId} failed: ${(err as Error).message}`),
				);
			},
		};
	}

	/**
	 * Launches the runner in the container. Idempotent: `flock -n` on a lock in
	 * the container's /tmp makes a second launch exit at once while one runs, and
	 * the lock dies with the container. The shell loop restarts a runner that
	 * exits (by design on an adapter crash) — the only supervision there is.
	 */
	async ensureRunner(sessionId: string, containerId: string): Promise<boolean> {
		const agent = await this.bySession(sessionId);
		if (!agent) return false;
		const runtimeRoot = `${RUNTIME_MOUNT}/${agent.runtime}`;
		await this.docker.execDetached(
			containerId,
			[
				"flock",
				"-n",
				RUNNER_LOCK,
				"sh",
				"-c",
				`while true; do node --no-warnings ${RUNTIME_MOUNT}/st/runner.mjs >> /tmp/st-acp-runner.log 2>&1; sleep 3; done`,
				RUNNER_LOOP_NAME,
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
		logger.info(`[acp] runner ensured for @${agent.name} (${sessionId}) on ${agent.runtime}`);
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

	/** The runner loop's state in this container, from RUNNER_PROBE's exit code. */
	async probeRunner(
		sessionId: string,
		containerId: string,
	): Promise<"alive" | "dead" | "orphaned" | "unknown"> {
		try {
			const r = await this.docker.execCapture(sessionId, ["sh", "-c", RUNNER_PROBE], {
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

	private async checkRunner(agent: AgentRow): Promise<void> {
		if (this.checking.has(agent.agent_id)) return; // single-flight per agent
		this.checking.add(agent.agent_id);
		try {
			const containerId = await this.docker.runningContainerId(
				`st-${agent.session_id.slice(0, 12)}`,
			);
			if (!containerId) return;
			const state = await this.probeRunner(agent.session_id, containerId);
			if (state === "orphaned" && !this.orphanReported.has(agent.agent_id)) {
				// warn once per episode: the agent still works, it just has no restart loop
				this.orphanReported.add(agent.agent_id);
				logger.warn(
					`[acp] @${agent.name}: runner alive without its restart loop; not launching a second one (it is relaunched once it exits)`,
				);
			}
			if (state !== "orphaned") this.orphanReported.delete(agent.agent_id);
			if (state !== "dead") return;
			logger.warn(`[acp] runner loop of @${agent.name} is not running; launching it`);
			await this.ensureRunner(agent.session_id, containerId);
		} catch (err) {
			logger.warn(`[acp] watchdog for @${agent.name}: ${(err as Error).message}`);
		} finally {
			this.checking.delete(agent.agent_id);
		}
	}

	/** Boot: running agent sessions get their runner back (a backend restart does not touch containers, but a host reboot does). */
	async ensureAllRunning(): Promise<void> {
		const r = await d1Query<AgentRow & { container_id: string | null; status: string }>(
			"SELECT a.*, s.container_id, s.status FROM acp_agents a JOIN sessions s ON s.session_id = a.session_id WHERE s.status = 'running'",
		);
		for (const row of r.results) {
			this.byId.set(row.agent_id, row);
			if (!row.container_id) continue;
			await this.ensureRunner(row.session_id, row.container_id).catch((err) =>
				logger.warn(
					`[acp] boot runner launch for ${row.session_id} failed: ${(err as Error).message}`,
				),
			);
		}
	}

	/** Used by the session route to tell the UI which sessions are agents. */
	async sessionsOf(ownerUserId: string): Promise<Map<string, AgentRow>> {
		return new Map((await this.list(ownerUserId)).map((a) => [a.session_id, a]));
	}
}
