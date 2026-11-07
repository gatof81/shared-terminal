/**
 * projects/directory.ts — P3a, the project & agent directory
 * (docs/PROJECTS.md). Projects, agents with a stable identity of their own,
 * and the versioned agent ↔ session binding. Nothing here talks to Docker,
 * the capture, the composer or a container: an agent is a D1 row that
 * POINTS at an existing session of its owner, and binding one changes
 * nothing about that session.
 *
 * Constructed only when PROJECT_CHAT_ENABLED is on (index.ts); with the
 * flag off the routes are not mounted and no other path calls in here.
 *
 * Atomicity (PROJECTS.md §3). D1 over HTTP runs every call as its own
 * statement, so no correctness property may span two calls:
 *
 * - every creation is ONE statement (projects: an INSERT…SELECT with the
 *   limit inline; agents: the creation-record INSERT whose trigger writes
 *   the agent and its binding — db.ts PROJECT_DIRECTORY_DDL);
 * - every creation carries the client's `clientRequestId`, and the record
 *   is keyed by (owner, clientRequestId), so a retry can never create a
 *   second one;
 * - an answer that does not prove the outcome (timeout, network, a 5xx) is
 *   resolved by READING the record back: found ⇒ the creation happened and
 *   is answered as such; not found ⇒ 503 `outcome-unknown`, because a late
 *   D1 write can still land — the client retries with the same id, which is
 *   safe in both cases. Nothing is ever retried here on its own.
 */

import { createHash, randomUUID } from "node:crypto";
import { parseD1Utc } from "../d1Time.js";
import { D1StatementError, d1Query } from "../db.js";
import { logger } from "../logger.js";
import { decidingConversation, derivePresence, type Presence } from "./presence.js";

// ── Limits and shapes ──────────────────────────────────────────────────────

export const MAX_PROJECTS_PER_OWNER = 50;
/** Also hard-coded in trg_project_agent_creation (db.ts): change both, by migration. */
export const MAX_AGENTS_PER_PROJECT = 32;
export const PROJECT_NAME_MAX = 80;
export const AGENT_ROLE_MAX = 60;
/** 03-protocol §1. */
export const HANDLE_RE = /^[a-z][a-z0-9-]{1,31}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Session ids are server-minted v4 UUIDs, lowercase; anything else cannot be one.
const ID_RE = UUID_V4_RE;
// C0/C1 controls and the bidi overrides: a name or role is shown verbatim.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching controls is the point
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** The provider's declared capabilities (02 §5.2). `channels` stays false until the Channels GO. */
const CLAUDE_CODE_CAPABILITIES = { capture: true, channels: false, directControl: true } as const;

/** `PROJECT_CHAT_ENABLED`: only `true` / `1` turn it on; unset or empty (compose's `:-`) keeps it off. */
export function projectChatFlagEnabled(raw: string | undefined): boolean {
	return raw === "true" || raw === "1";
}

/** Every refusal the directory answers: an HTTP status and a stable code. */
export class ProjectError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message?: string,
	) {
		super(message ?? code);
		this.name = "ProjectError";
	}
}

/** Thrown by the hard-delete guard (PROJECTS.md §6): the session has a live binding. */
export class AgentActiveError extends Error {
	constructor() {
		super("agent-active");
		this.name = "AgentActiveError";
	}
}

export interface BindingView {
	bindingId: string;
	epoch: number;
	sessionId: string;
	state: "active" | "draining" | "retired";
	createdAt: string;
}

export interface BindingHistoryEntry extends BindingView {
	retiredAt: string | null;
	retireReason: string | null;
}

export interface AgentListEntry {
	agentId: string;
	handle: string;
	role: string | null;
	provider: string;
	/** Reserved (AD4, E3): always null in P3a. */
	template: null;
	binding: BindingView | null;
	presence: Presence;
}

export interface AgentDetail extends AgentListEntry {
	projectId: string;
	createdAt: string;
	removedAt: string | null;
	capabilities: typeof CLAUDE_CODE_CAPABILITIES;
	bindings: BindingHistoryEntry[];
	can: { remove: Allowed };
}

export interface ProjectSummary {
	projectId: string;
	name: string;
	createdAt: string;
	agentCount: number;
}

type Allowed = { allowed: true } | { allowed: false; reason: string };

/** What `/api/sessions` shows for a bound session (E-4). */
export interface SessionBinding {
	projectId: string;
	agentId: string;
	handle: string;
	bindingId: string;
	epoch: number;
}

export interface Created<T> {
	/** True when this answer is a replay of an earlier request with the same id. */
	replayed: boolean;
	body: T;
}

// ── Validation ─────────────────────────────────────────────────────────────

function requireObject(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ProjectError(400, "invalid-body", "body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

function requireClientRequestId(b: Record<string, unknown>): string {
	const v = b.clientRequestId;
	if (typeof v !== "string" || !UUID_V4_RE.test(v)) {
		throw new ProjectError(
			400,
			"invalid-client-request-id",
			"clientRequestId must be a lowercase UUID v4",
		);
	}
	return v;
}

function cleanText(v: unknown, field: string, max: number): string {
	if (typeof v !== "string")
		throw new ProjectError(400, `invalid-${field}`, `${field} must be a string`);
	const t = v.normalize("NFC").trim();
	if (t.length === 0 || [...t].length > max || UNSAFE_TEXT_RE.test(t)) {
		throw new ProjectError(
			400,
			`invalid-${field}`,
			`${field} must be 1–${max} characters without control characters`,
		);
	}
	return t;
}

/** A path id that cannot be one answers like a missing one (404), never 400. */
export function isDirectoryId(id: string): boolean {
	return ID_RE.test(id);
}

function requestHash(parts: ReadonlyArray<string | null>): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** D1's `datetime('now')` (suffix-less UTC) → ISO. */
function iso(raw: string, context: string): string {
	return parseD1Utc(raw, context).toISOString();
}

/** An instant in D1's own `datetime('now')` shape, for rows whose time the backend sets. */
function d1Now(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function isoOrNull(raw: string | null, context: string): string | null {
	return raw === null ? null : iso(raw, context);
}

// ── Rows ───────────────────────────────────────────────────────────────────

interface AgentJoinRow {
	agent_id: string | null;
	handle: string | null;
	role: string | null;
	provider: string | null;
	agent_created_at: string | null;
	removed_at: string | null;
	binding_id: string | null;
	epoch: number | null;
	st_session_id: string | null;
	binding_state: BindingView["state"] | null;
	binding_created_at: string | null;
	retired_at: string | null;
	retire_reason: string | null;
	/** The bound session's status, NULL when its row is gone (hard delete). */
	session_status: string | null;
}

interface ConversationPresenceRow {
	st_session_id: string;
	status: string;
	status_evidence: string;
	status_at: string;
	last_event_at: string | null;
	pane_id: string | null;
}

interface CreationRow {
	project_id: string;
	agent_id: string;
	binding_id: string;
	st_session_id: string;
	handle: string;
	role: string | null;
	request_hash: string;
	created_at: string;
	removed_at: string | null;
	binding_state: BindingView["state"] | null;
}

/** The creation receipt of `POST …/agents` (and its replays). */
export interface AgentReceipt {
	agentId: string;
	projectId: string;
	handle: string;
	role: string | null;
	provider: "claude-code";
	template: null;
	createdAt: string;
	removedAt: string | null;
	binding: { bindingId: string; epoch: 1; sessionId: string; state: BindingView["state"] };
}

const LIVE = "('active','draining')";

function bindingOf(r: AgentJoinRow): BindingView | null {
	if (r.binding_id === null || r.binding_state === null) return null;
	return {
		bindingId: r.binding_id,
		epoch: r.epoch as number,
		sessionId: r.st_session_id as string,
		state: r.binding_state,
		createdAt: iso(r.binding_created_at as string, "agent_bindings.created_at"),
	};
}

/** Which D1 failure an agent creation hit, from D1's own message. */
function classifyAgentCreateFailure(message: string): ProjectError | null {
	const raised = /\bst:([a-z-]+)/.exec(message)?.[1];
	if (raised === "project-not-found") return new ProjectError(404, "project-not-found");
	if (raised === "session-not-found") return new ProjectError(404, "session-not-found");
	if (raised === "agent-limit") return new ProjectError(409, "agent-limit");
	if (
		/UNIQUE constraint failed: project_agents\.project_id, project_agents\.handle/.test(message)
	) {
		return new ProjectError(409, "handle-taken");
	}
	if (/UNIQUE constraint failed: agent_bindings\.st_session_id/.test(message)) {
		return new ProjectError(409, "session-taken");
	}
	return null;
}

/**
 * True when D1 itself refused the statement, so it was NOT applied. d1Query
 * raises D1StatementError only for a 2xx carrying `success: false`; the
 * Cloudflare v4 API may instead answer a refused statement with a 4xx and the
 * same envelope, which d1Query reports as a plain "D1 API error (4xx): <body>".
 * That is just as definite (the request was evaluated and failed; nothing
 * ran), and treating it as ambiguous would turn every taken handle or session
 * into a 503 that a retry can never resolve. Kept local to the directory:
 * d1Query's callers elsewhere (the recreation CAS) rely on its stricter rule.
 * A 5xx, a timeout, or a body that is not the envelope stays ambiguous.
 */
export function isDefiniteRefusal(err: unknown): boolean {
	if (err instanceof D1StatementError) return true;
	const m = /^D1 API error \((4\d\d)\): ([\s\S]*)$/.exec((err as Error | undefined)?.message ?? "");
	if (!m) return false;
	try {
		const body = JSON.parse(m[2]) as { success?: unknown; errors?: unknown };
		return body.success === false && Array.isArray(body.errors) && body.errors.length > 0;
	} catch {
		return false;
	}
}

function outcomeUnknown(): ProjectError {
	return new ProjectError(
		503,
		"outcome-unknown",
		"The result could not be confirmed. Retry with the same clientRequestId.",
	);
}

// ── Directory ──────────────────────────────────────────────────────────────

const BINDING_CACHE_TTL_MS = 30_000;
const BINDING_CACHE_MAX = 1_000;

export interface ProjectDirectoryOptions {
	now?: () => number;
}

export class ProjectDirectory {
	private readonly now: () => number;
	/**
	 * Live bindings per owner for `/api/sessions` (E-4), so the 5 s sidebar
	 * poll costs no D1 read per row and one per owner per TTL. A writer bumps
	 * the owner's generation before AND after its statement; a reader stores
	 * what it read only if the generation did not move while it was reading —
	 * so a read that raced a write can never re-populate the cache with the
	 * pre-write state (the portMappings pre/post rule, made explicit).
	 */
	private readonly bindingCache = new Map<
		string,
		{ expires: number; map: Map<string, SessionBinding> }
	>();
	private readonly bindingGen = new Map<string, number>();

	constructor(opts: ProjectDirectoryOptions = {}) {
		this.now = opts.now ?? Date.now;
	}

	// ── Projects ───────────────────────────────────────────────────────────

	async createProject(ownerId: string, rawBody: unknown): Promise<Created<ProjectSummary>> {
		const b = requireObject(rawBody);
		const clientRequestId = requireClientRequestId(b);
		const name = cleanText(b.name, "name", PROJECT_NAME_MAX);
		const hash = requestHash([name]);
		const projectId = randomUUID();
		const createdAtD1 = d1Now(this.now());

		const readBack = () => this.readProjectCreation(ownerId, clientRequestId, hash);
		let changes: number;
		try {
			const r = await d1Query(
				`INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash, created_at)
				 SELECT ?, ?, ?, ?, ?, ?
				 WHERE (SELECT COUNT(*) FROM projects WHERE owner_user_id = ? AND archived_at IS NULL) < ?`,
				[
					projectId,
					ownerId,
					name,
					clientRequestId,
					hash,
					createdAtD1,
					ownerId,
					MAX_PROJECTS_PER_OWNER,
				],
			);
			changes = r.meta.changes;
		} catch (err) {
			return this.resolveFailedCreate(err, readBack, () => null);
		}
		if (changes === 1) {
			return {
				replayed: false,
				body: {
					projectId,
					name,
					createdAt: iso(createdAtD1, "projects.created_at"),
					agentCount: 0,
				},
			};
		}
		// Nothing inserted: either an earlier request with this id already
		// created it (and the limit has since been reached), or the limit.
		const earlier = await readBack();
		if (earlier) return earlier;
		throw new ProjectError(409, "project-limit");
	}

	private async readProjectCreation(
		ownerId: string,
		clientRequestId: string,
		hash: string,
	): Promise<Created<ProjectSummary> | null> {
		const r = await d1Query<{
			project_id: string;
			name: string;
			created_at: string;
			request_hash: string;
			agent_count: number;
		}>(
			`SELECT p.project_id, p.name, p.created_at, p.request_hash,
			        (SELECT COUNT(*) FROM project_agents a WHERE a.project_id = p.project_id AND a.removed_at IS NULL) AS agent_count
			 FROM projects p WHERE p.owner_user_id = ? AND p.client_request_id = ?`,
			[ownerId, clientRequestId],
		);
		const row = r.results[0];
		if (!row) return null;
		if (row.request_hash !== hash) throw new ProjectError(409, "idempotency-conflict");
		return {
			replayed: true,
			body: {
				projectId: row.project_id,
				name: row.name,
				createdAt: iso(row.created_at, "projects.created_at"),
				agentCount: row.agent_count,
			},
		};
	}

	async listProjects(
		ownerId: string,
	): Promise<{ projects: ProjectSummary[]; can: { createProject: Allowed } }> {
		const r = await d1Query<{
			project_id: string;
			name: string;
			created_at: string;
			agent_count: number;
		}>(
			`SELECT p.project_id, p.name, p.created_at,
			        (SELECT COUNT(*) FROM project_agents a WHERE a.project_id = p.project_id AND a.removed_at IS NULL) AS agent_count
			 FROM projects p
			 WHERE p.owner_user_id = ? AND p.archived_at IS NULL
			 ORDER BY p.created_at, p.project_id`,
			[ownerId],
		);
		const projects = r.results.map((row) => ({
			projectId: row.project_id,
			name: row.name,
			createdAt: iso(row.created_at, "projects.created_at"),
			agentCount: row.agent_count,
		}));
		return {
			projects,
			can: {
				createProject:
					projects.length < MAX_PROJECTS_PER_OWNER
						? { allowed: true }
						: { allowed: false, reason: "project-limit" },
			},
		};
	}

	// ── Agents ─────────────────────────────────────────────────────────────

	async createAgent(
		ownerId: string,
		projectId: string,
		rawBody: unknown,
	): Promise<Created<AgentReceipt>> {
		if (!isDirectoryId(projectId)) throw new ProjectError(404, "project-not-found");
		const b = requireObject(rawBody);
		const clientRequestId = requireClientRequestId(b);
		const handle = b.handle;
		if (typeof handle !== "string" || !HANDLE_RE.test(handle)) {
			throw new ProjectError(400, "invalid-handle", "handle must match ^[a-z][a-z0-9-]{1,31}$");
		}
		const role =
			b.role === undefined || b.role === null ? null : cleanText(b.role, "role", AGENT_ROLE_MAX);
		const sessionId = b.sessionId;
		if (typeof sessionId !== "string" || !isDirectoryId(sessionId)) {
			throw new ProjectError(400, "invalid-session-id", "sessionId must be a session id");
		}
		const hash = requestHash([projectId, handle, role, sessionId]);
		const agentId = randomUUID();
		const bindingId = randomUUID();
		// The D1 shape, so the trigger copies the same instant into both rows.
		const createdAtD1 = d1Now(this.now());

		const readBack = () => this.readAgentCreation(ownerId, clientRequestId, hash);
		this.bumpBindings(ownerId);
		try {
			await d1Query(
				`INSERT INTO project_agent_creations
				   (owner_user_id, client_request_id, request_hash, project_id, agent_id, binding_id, st_session_id, handle, role, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					ownerId,
					clientRequestId,
					hash,
					projectId,
					agentId,
					bindingId,
					sessionId,
					handle,
					role,
					createdAtD1,
				],
			);
		} catch (err) {
			return this.resolveFailedCreate(err, readBack, (msg) => classifyAgentCreateFailure(msg));
		} finally {
			this.bumpBindings(ownerId);
		}
		return {
			replayed: false,
			body: {
				agentId,
				projectId,
				handle,
				role,
				provider: "claude-code",
				template: null,
				createdAt: iso(createdAtD1, "project_agent_creations.created_at"),
				removedAt: null,
				binding: { bindingId, epoch: 1, sessionId, state: "active" },
			},
		};
	}

	private async readAgentCreation(
		ownerId: string,
		clientRequestId: string,
		hash: string,
	): Promise<Created<AgentReceipt> | null> {
		const r = await d1Query<CreationRow>(
			`SELECT c.project_id, c.agent_id, c.binding_id, c.st_session_id, c.handle, c.role,
			        c.request_hash, c.created_at, a.removed_at, b.state AS binding_state
			 FROM project_agent_creations c
			 LEFT JOIN project_agents a ON a.agent_id = c.agent_id
			 LEFT JOIN agent_bindings b ON b.binding_id = c.binding_id
			 WHERE c.owner_user_id = ? AND c.client_request_id = ?`,
			[ownerId, clientRequestId],
		);
		const row = r.results[0];
		if (!row) return null;
		if (row.request_hash !== hash) throw new ProjectError(409, "idempotency-conflict");
		return {
			replayed: true,
			body: {
				agentId: row.agent_id,
				projectId: row.project_id,
				handle: row.handle,
				role: row.role,
				provider: "claude-code",
				template: null,
				createdAt: iso(row.created_at, "project_agent_creations.created_at"),
				removedAt: isoOrNull(row.removed_at, "project_agents.removed_at"),
				binding: {
					bindingId: row.binding_id,
					epoch: 1,
					sessionId: row.st_session_id,
					// The record and the binding are written by one statement; a
					// record without its binding cannot exist. Retired is the
					// only way it can have changed.
					state: row.binding_state ?? "retired",
				},
			},
		};
	}

	/**
	 * A creation statement threw. First, ALWAYS, look for the record: if it
	 * is there (an earlier attempt with this id, or this one landing despite
	 * the error) the creation happened. Otherwise a D1StatementError proves
	 * nothing was applied and is classified; any other error leaves the
	 * outcome unknown (503) — the write may still land.
	 */
	private async resolveFailedCreate<T>(
		err: unknown,
		readBack: () => Promise<Created<T> | null>,
		classify: (message: string) => ProjectError | null,
	): Promise<Created<T>> {
		const definite = isDefiniteRefusal(err);
		let earlier: Created<T> | null;
		try {
			earlier = await readBack();
		} catch (readErr) {
			if (readErr instanceof ProjectError) throw readErr;
			logger.warn(
				`[projects] read-back after a failed create failed: ${(readErr as Error).message}`,
			);
			if (definite) {
				const known = classify((err as Error).message);
				if (known) throw known;
			}
			throw outcomeUnknown();
		}
		if (earlier) return earlier;
		if (!definite) {
			logger.warn(`[projects] create outcome unknown: ${(err as Error).message}`);
			throw outcomeUnknown();
		}
		const known = classify((err as Error).message);
		if (known) throw known;
		throw err;
	}

	async listAgents(
		ownerId: string,
		projectId: string,
	): Promise<{
		projectId: string;
		generatedAt: string;
		agents: AgentListEntry[];
		can: { createAgent: Allowed };
	}> {
		if (!isDirectoryId(projectId)) throw new ProjectError(404, "project-not-found");
		const readAt = new Date(this.now()).toISOString();
		const r = await d1Query<AgentJoinRow & { project_id: string }>(
			`SELECT p.project_id,
			        a.agent_id, a.handle, a.role, a.provider, a.created_at AS agent_created_at, a.removed_at,
			        b.binding_id, b.epoch, b.st_session_id, b.state AS binding_state,
			        b.created_at AS binding_created_at, b.retired_at, b.retire_reason,
			        s.status AS session_status
			 FROM projects p
			 LEFT JOIN project_agents a ON a.project_id = p.project_id AND a.removed_at IS NULL
			 LEFT JOIN agent_bindings b ON b.agent_id = a.agent_id AND b.state IN ${LIVE}
			 LEFT JOIN sessions s ON s.session_id = b.st_session_id AND s.user_id = p.owner_user_id
			 WHERE p.project_id = ? AND p.owner_user_id = ?
			 ORDER BY a.created_at, a.handle`,
			[projectId, ownerId],
		);
		if (r.results.length === 0) throw new ProjectError(404, "project-not-found");
		const rows = r.results.filter((row) => row.agent_id !== null);
		const presence = await this.presenceFor(rows, readAt);
		const agents = rows.map((row) => ({
			agentId: row.agent_id as string,
			handle: row.handle as string,
			role: row.role,
			provider: row.provider as string,
			template: null,
			binding: bindingOf(row),
			presence: presence(row),
		}));
		return {
			projectId,
			generatedAt: readAt,
			agents,
			can: {
				createAgent:
					agents.length < MAX_AGENTS_PER_PROJECT
						? { allowed: true }
						: { allowed: false, reason: "agent-limit" },
			},
		};
	}

	async getAgent(ownerId: string, projectId: string, agentId: string): Promise<AgentDetail> {
		if (!isDirectoryId(projectId) || !isDirectoryId(agentId)) {
			throw new ProjectError(404, "agent-not-found");
		}
		const readAt = new Date(this.now()).toISOString();
		const r = await d1Query<AgentJoinRow>(
			`SELECT a.agent_id, a.handle, a.role, a.provider, a.created_at AS agent_created_at, a.removed_at,
			        b.binding_id, b.epoch, b.st_session_id, b.state AS binding_state,
			        b.created_at AS binding_created_at, b.retired_at, b.retire_reason,
			        s.status AS session_status
			 FROM project_agents a
			 JOIN projects p ON p.project_id = a.project_id AND p.owner_user_id = ?
			 LEFT JOIN agent_bindings b ON b.agent_id = a.agent_id
			 LEFT JOIN sessions s ON s.session_id = b.st_session_id AND s.user_id = p.owner_user_id
			 WHERE a.agent_id = ? AND a.project_id = ?
			 ORDER BY b.epoch`,
			[ownerId, agentId, projectId],
		);
		const first = r.results[0];
		if (!first) throw new ProjectError(404, "agent-not-found");
		const bindings: BindingHistoryEntry[] = [];
		let live: AgentJoinRow | null = null;
		for (const row of r.results) {
			const b = bindingOf(row);
			if (!b) continue;
			bindings.push({
				...b,
				retiredAt: isoOrNull(row.retired_at, "agent_bindings.retired_at"),
				retireReason: row.retire_reason,
			});
			if (b.state !== "retired") live = row;
		}
		const presenceOf = await this.presenceFor(live ? [live] : [], readAt);
		const removedAt = isoOrNull(first.removed_at, "project_agents.removed_at");
		return {
			agentId: first.agent_id as string,
			projectId,
			handle: first.handle as string,
			role: first.role,
			provider: first.provider as string,
			template: null,
			createdAt: iso(first.agent_created_at as string, "project_agents.created_at"),
			removedAt,
			capabilities: CLAUDE_CODE_CAPABILITIES,
			binding: live ? bindingOf(live) : null,
			bindings,
			presence: live
				? presenceOf(live)
				: {
						value: "disconnected",
						detail: removedAt ? "agent-removed" : "unbound",
						source: "directory",
						at: removedAt ?? readAt,
					},
			can: { remove: removedAt ? { allowed: false, reason: "agent-removed" } : { allowed: true } },
		};
	}

	/**
	 * `DELETE …/agents/:aid`: sets `removed_at`; the trigger retires the live
	 * binding in the same statement. Idempotent: removing a removed agent is
	 * the same 204. The history (bindings, creation record) is kept.
	 */
	async removeAgent(ownerId: string, projectId: string, agentId: string): Promise<void> {
		if (!isDirectoryId(projectId) || !isDirectoryId(agentId)) {
			throw new ProjectError(404, "agent-not-found");
		}
		const state = async (): Promise<"removed" | "present" | "missing"> => {
			const r = await d1Query<{ removed_at: string | null }>(
				`SELECT a.removed_at FROM project_agents a
				 JOIN projects p ON p.project_id = a.project_id AND p.owner_user_id = ?
				 WHERE a.agent_id = ? AND a.project_id = ?`,
				[ownerId, agentId, projectId],
			);
			const row = r.results[0];
			if (!row) return "missing";
			return row.removed_at === null ? "present" : "removed";
		};
		this.bumpBindings(ownerId);
		let changes: number;
		try {
			const r = await d1Query(
				`UPDATE project_agents SET removed_at = datetime('now')
				 WHERE agent_id = ? AND project_id = ? AND removed_at IS NULL
				   AND project_id IN (SELECT project_id FROM projects WHERE owner_user_id = ?)`,
				[agentId, projectId, ownerId],
			);
			changes = r.meta.changes;
		} catch (err) {
			if (isDefiniteRefusal(err)) throw err;
			const now = await state().catch(() => null);
			if (now === "removed") return;
			if (now === "missing") throw new ProjectError(404, "agent-not-found");
			throw outcomeUnknown();
		} finally {
			this.bumpBindings(ownerId);
		}
		if (changes === 1) return;
		if ((await state()) === "missing") throw new ProjectError(404, "agent-not-found");
	}

	// ── Presence ───────────────────────────────────────────────────────────

	/**
	 * ONE D1 read of the capture's conversation rows for every bound running
	 * session. A failed read degrades to `unknown` (never a guess, never a
	 * 500 for the directory).
	 */
	private async presenceFor(
		rows: readonly AgentJoinRow[],
		readAt: string,
	): Promise<(row: AgentJoinRow) => Presence> {
		const running = [
			...new Set(
				rows
					.filter((r) => r.binding_id !== null && r.session_status === "running")
					.map((r) => r.st_session_id as string),
			),
		];
		const bySession = new Map<string, ConversationPresenceRow[]>();
		let conversationsRead = true;
		if (running.length > 0) {
			try {
				const r = await d1Query<ConversationPresenceRow>(
					`SELECT st_session_id, status, status_evidence, status_at, last_event_at, pane_id
					 FROM claude_conversations
					 WHERE pane_id IS NOT NULL AND st_session_id IN (${running.map(() => "?").join(", ")})`,
					running,
				);
				for (const c of r.results) {
					const list = bySession.get(c.st_session_id) ?? [];
					list.push(c);
					bySession.set(c.st_session_id, list);
				}
			} catch (err) {
				conversationsRead = false;
				logger.warn(`[projects] presence read failed: ${(err as Error).message}`);
			}
		}
		const now = this.now();
		return (row) => {
			if (row.binding_id === null) {
				return { value: "disconnected", detail: "unbound", source: "directory", at: readAt };
			}
			const deciding = decidingConversation(
				(bySession.get(row.st_session_id as string) ?? []).map((c) => ({
					status: c.status,
					statusEvidence: c.status_evidence,
					statusAt: c.status_at,
					lastEventAt: c.last_event_at,
					paneId: c.pane_id,
				})),
			);
			return derivePresence({
				sessionStatus: row.session_status,
				conversationsRead,
				conversation: deciding,
				readAt,
				now,
			});
		};
	}

	// ── Sessions (E-4) and the hard-delete guard ───────────────────────────

	private bumpBindings(ownerId: string): void {
		this.bindingGen.set(ownerId, (this.bindingGen.get(ownerId) ?? 0) + 1);
		this.bindingCache.delete(ownerId);
	}

	/** The owner's live bindings by session id (cached ≤ 30 s, see `bindingCache`). */
	async liveBindingsForOwner(ownerId: string): Promise<Map<string, SessionBinding>> {
		const hit = this.bindingCache.get(ownerId);
		if (hit && hit.expires > this.now()) return hit.map;
		const gen = this.bindingGen.get(ownerId) ?? 0;
		const r = await d1Query<{
			st_session_id: string;
			binding_id: string;
			epoch: number;
			agent_id: string;
			handle: string;
			project_id: string;
		}>(
			`SELECT b.st_session_id, b.binding_id, b.epoch, a.agent_id, a.handle, a.project_id
			 FROM agent_bindings b
			 JOIN project_agents a ON a.agent_id = b.agent_id
			 JOIN projects p ON p.project_id = a.project_id
			 WHERE p.owner_user_id = ? AND b.state IN ${LIVE}`,
			[ownerId],
		);
		const map = new Map<string, SessionBinding>();
		for (const row of r.results) {
			map.set(row.st_session_id, {
				projectId: row.project_id,
				agentId: row.agent_id,
				handle: row.handle,
				bindingId: row.binding_id,
				epoch: row.epoch,
			});
		}
		if ((this.bindingGen.get(ownerId) ?? 0) === gen) {
			if (this.bindingCache.size >= BINDING_CACHE_MAX && !this.bindingCache.has(ownerId)) {
				const oldest = this.bindingCache.keys().next().value;
				if (oldest !== undefined) this.bindingCache.delete(oldest);
			}
			this.bindingCache.set(ownerId, { expires: this.now() + BINDING_CACHE_TTL_MS, map });
		}
		return map;
	}

	/**
	 * Hard-delete guard (03 §2.1): a session with a live binding is refused
	 * with 409 `agent-active` — the owner removes the agent first. Uncached
	 * and fail-closed: a failed read refuses the delete (500), it never lets
	 * it through.
	 */
	async assertNoLiveBinding(sessionId: string): Promise<void> {
		const r = await d1Query(
			`SELECT 1 AS live FROM agent_bindings WHERE st_session_id = ? AND state IN ${LIVE} LIMIT 1`,
			[sessionId],
		);
		if (r.results.length > 0) throw new AgentActiveError();
	}
}
