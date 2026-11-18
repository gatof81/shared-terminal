/**
 * projects/directory.ts — projects: a name that groups ACP agents and gives
 * them Project Chat (acp/agents.ts keeps `acp_agents.project_id`; the
 * messages carry their own scope). Owner-only; a foreign or missing project
 * is the same 404.
 *
 * A creation is ONE statement (an INSERT…SELECT with the per-owner limit
 * inline) keyed by the client's `clientRequestId`, so a retry never creates
 * a second project. D1 over HTTP can lose an answer: anything that does not
 * prove the outcome is resolved by reading the record back — found ⇒ the
 * creation happened; not found ⇒ 503 `outcome-unknown` (a late write can
 * still land; the client retries with the same id). Nothing is retried here.
 *
 * Constructed only when PROJECT_CHAT_ENABLED is on (index.ts).
 */

import { createHash, randomUUID } from "node:crypto";
import { parseD1Utc } from "../d1Time.js";
import { D1StatementError, d1Query } from "../db.js";
import { logger } from "../logger.js";

export const MAX_PROJECTS_PER_OWNER = 50;
export const PROJECT_NAME_MAX = 80;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// C0/C1 controls and the bidi overrides: a name is shown verbatim.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching controls is the point
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** `PROJECT_CHAT_ENABLED`: only `true` / `1` turn it on; unset or empty (compose's `:-`) keeps it off. */
export function projectChatFlagEnabled(raw: string | undefined): boolean {
	return raw === "true" || raw === "1";
}

/** Every refusal: an HTTP status and a stable code. */
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

export interface ProjectSummary {
	projectId: string;
	name: string;
	createdAt: string;
	/** ACP agents taking part in it. */
	agentCount: number;
}

type Allowed = { allowed: true } | { allowed: false; reason: string };

export interface Created<T> {
	/** True when this answer is a replay of an earlier request with the same id. */
	replayed: boolean;
	body: T;
}

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

function cleanName(v: unknown): string {
	if (typeof v !== "string") throw new ProjectError(400, "invalid-name", "name must be a string");
	const t = v.normalize("NFC").trim();
	if (t.length === 0 || [...t].length > PROJECT_NAME_MAX || UNSAFE_TEXT_RE.test(t)) {
		throw new ProjectError(
			400,
			"invalid-name",
			`name must be 1–${PROJECT_NAME_MAX} characters without control characters`,
		);
	}
	return t;
}

/** A path id that cannot be one answers like a missing one (404), never 400. */
export function isDirectoryId(id: string): boolean {
	return UUID_V4_RE.test(id);
}

function requestHash(parts: ReadonlyArray<string | null>): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** D1's `datetime('now')` (suffix-less UTC) → ISO. */
function iso(raw: string, context: string): string {
	return parseD1Utc(raw, context).toISOString();
}

/** An instant in D1's own `datetime('now')` shape. */
function d1Now(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Is this failure D1's own refusal envelope (a 2xx `success: false` or a 4xx
 * with the same body)? Network-level failures share none of it, and for a
 * write those leave the outcome unknown.
 */
export function isD1Envelope(err: unknown): boolean {
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

const AGENT_COUNT =
	"(SELECT COUNT(*) FROM acp_agents a WHERE a.project_id = p.project_id) AS agent_count";

export interface ProjectDirectoryOptions {
	now?: () => number;
}

export class ProjectDirectory {
	private readonly now: () => number;

	constructor(opts: ProjectDirectoryOptions = {}) {
		this.now = opts.now ?? Date.now;
	}

	async createProject(ownerId: string, rawBody: unknown): Promise<Created<ProjectSummary>> {
		const b = requireObject(rawBody);
		const clientRequestId = requireClientRequestId(b);
		const name = cleanName(b.name);
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
			// Only a refusal D1 itself answered is definite; anything else is resolved by the record.
			let earlier: Created<ProjectSummary> | null;
			try {
				earlier = await readBack();
			} catch (readErr) {
				if (readErr instanceof ProjectError) throw readErr;
				logger.warn(
					`[projects] read-back after a failed create failed: ${(readErr as Error).message}`,
				);
				throw outcomeUnknown();
			}
			if (earlier) return earlier;
			if (isD1Envelope(err)) throw new ProjectError(500, "internal");
			logger.warn(`[projects] create outcome unknown: ${(err as Error).message}`);
			throw outcomeUnknown();
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
		// Nothing inserted: an earlier request with this id created it, or the limit.
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
			`SELECT p.project_id, p.name, p.created_at, p.request_hash, ${AGENT_COUNT}
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
			`SELECT p.project_id, p.name, p.created_at, ${AGENT_COUNT}
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

	/**
	 * Archive: the project leaves every list; its row stays (its id is still in
	 * old messages' scope). Its agents leave it first, so nothing keeps posting
	 * to a project nobody sees. Idempotent.
	 */
	async archiveProject(ownerId: string, projectId: string): Promise<void> {
		if (!(await this.ownsProject(ownerId, projectId)))
			throw new ProjectError(404, "project-not-found");
		await d1Query(
			"UPDATE acp_agents SET project_id = NULL WHERE owner_user_id = ? AND project_id = ?",
			[ownerId, projectId],
		);
		await d1Query(
			"UPDATE projects SET archived_at = COALESCE(archived_at, ?) WHERE project_id = ? AND owner_user_id = ?",
			[d1Now(this.now()), projectId, ownerId],
		);
	}

	async ownsProject(ownerId: string, projectId: string): Promise<boolean> {
		if (!isDirectoryId(projectId)) return false;
		const r = await d1Query<{ one: number }>(
			"SELECT 1 AS one FROM projects WHERE project_id = ? AND owner_user_id = ? AND archived_at IS NULL",
			[projectId, ownerId],
		);
		return r.results.length > 0;
	}
}
