/**
 * acp/works.ts — works (v26 `agent_works`): the only way a named execution
 * context exists. A work `<id>` IS the context `<id>`: its messages run in a
 * slot ≥ 2 with their own ACP session, in the git worktree
 * `<workspace>/.st/ctx/<id>` on branch `work/<id>`, with 100 ports of its own
 * (`port_base` … +99, ST_PORT_BASE in the session's environment).
 *
 * The backend creates the worktree BEFORE the work's first message, inside the
 * agent's container (like gitReadOnly.ts: fixed scripts under `docker exec`,
 * never git on the host — a repo's config can turn git into command
 * execution, and the backend is root there). The only client operands that
 * reach those scripts are the id (CONTEXT_RE) and the base ref (BASE_RE), as
 * positional arguments ("$1", "$2"), never as shell text.
 *
 * D1 and git share no transaction: the row is written `creating` first and
 * becomes `active` once git says the worktree exists. When git's answer is an
 * error or unknown (a cut exec), the REAL state is inspected before anything
 * else: the worktree on its branch ⇒ `active`; nothing created ⇒ the same POST
 * may be repeated; anything else stays `creating` with a note — never repaired
 * by replacing a directory. There is no background reconciler.
 */

import { d1Query } from "../db.js";
import type { DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";
import { type AcpConfig, type AgentRow, CONTEXT_RE } from "./agents.js";

export const WORK_ID_RE = CONTEXT_RE;
// A ref or sha as `git rev-parse` reads it: no leading `-` (never an option),
// no `..` (no ranges), no `//`, `@{` or a trailing `/`/`.lock`.
const BASE_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
export const WORKSPACE = "/home/developer/workspace";
export const workDir = (id: string) => `${WORKSPACE}/.st/ctx/${id}`;
const PORT_FIRST = 20000;
const PORT_SPAN = 100;
const EXEC_TIMEOUT_MS = 90_000;

export type WorkState = "creating" | "active" | "closed" | "cleanup-pending" | "cleaned";

export interface WorkRow {
	owner_user_id: string;
	id: string;
	agent_id: string;
	project_id: string | null;
	branch: string;
	base_sha: string | null;
	port_base: number;
	state: WorkState;
	note: string | null;
	/** `owner` or the creating agent's name. */
	created_by: string;
	created_at: string;
	closed_at: string | null;
	cleaned_at: string | null;
}

/** A refusal with its HTTP status, error code and what the caller needs to act on it. */
export class WorkError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail: Record<string, unknown> = {},
	) {
		super(code);
	}
}

// ── Container scripts ($1 = id, $2 = base ref or sha) ──────────────────────

const ws = WORKSPACE;
// What is in the way, the free space and the base, without changing anything.
// `exists=` lines: the worktree dir, an old ACP session of that context (it
// would be resumed), the branch — any of them refuses the work.
export const PREFLIGHT = `id=$1 base=$2
cd ${ws} || exit 3
[ "$(git rev-parse --show-toplevel 2>/dev/null)" = ${ws} ] || { echo not-a-repo; exit 0; }
echo "free_kb=$(df -Pk . | awk 'NR==2 {print $4}')"
[ -e ".st/ctx/$id" ] && echo exists=directory
[ -e ".st/acp/ctx/$id.json" ] && echo exists=session
git show-ref --verify --quiet "refs/heads/work/$id" && echo exists=branch
git fetch --quiet origin >/dev/null 2>&1 || echo fetch=failed
if [ -z "$base" ]; then base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || base=HEAD; fi
sha=$(git rev-parse --verify --quiet --end-of-options "$base^{commit}") || { echo "bad-base=$base"; exit 0; }
echo "base=$base"
echo "sha=$sha"`;
// The same checks again right before, then the worktree. Never over anything.
export const CREATE = `id=$1 sha=$2
cd ${ws} || exit 3
if [ -e ".st/ctx/$id" ] || [ -e ".st/acp/ctx/$id.json" ] || git show-ref --verify --quiet "refs/heads/work/$id"; then echo exists; exit 5; fi
git worktree add --quiet ".st/ctx/$id" -b "work/$id" "$sha" || exit 6
echo created`;
// What is really there after an error or an unknown outcome.
export const INSPECT = `id=$1 dir=${ws}/.st/ctx/$1
cd ${ws} || exit 3
if [ ! -e "$dir" ]; then
	if git show-ref --verify --quiet "refs/heads/work/$id"; then echo state=branch-only; else echo state=none; fi
	exit 0
fi
top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
br=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null)
if [ "$top" = "$dir" ] && [ "$br" = "work/$id" ]; then echo state=ok; echo "sha=$(git -C "$dir" rev-parse HEAD)"; else echo state=other; fi`;

function parse(out: Buffer): Map<string, string[]> {
	const m = new Map<string, string[]>();
	for (const line of out.toString("utf8").split("\n")) {
		if (!line) continue;
		const i = line.indexOf("=");
		const [k, v] = i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
		m.set(k, [...(m.get(k) ?? []), v]);
	}
	return m;
}

// ── Works ──────────────────────────────────────────────────────────────────

export class AcpWorks {
	constructor(
		private readonly config: AcpConfig,
		private readonly docker: Pick<DockerManager, "execCapture" | "runningContainerId">,
	) {}

	async get(ownerUserId: string, id: string): Promise<WorkRow | null> {
		const r = await d1Query<WorkRow>(
			"SELECT * FROM agent_works WHERE owner_user_id = ? AND id = ?",
			[ownerUserId, id],
		);
		return r.results[0] ?? null;
	}

	/** The owner's works (with the agent's name), or only those `agent` may see: its own and its project's. */
	async list(
		ownerUserId: string,
		agent: AgentRow | null,
	): Promise<Array<WorkRow & { agent: string }>> {
		const r = await d1Query<WorkRow & { agent: string }>(
			`SELECT w.*, a.name AS agent FROM agent_works w JOIN acp_agents a ON a.agent_id = w.agent_id
			 WHERE w.owner_user_id = ?1
				AND (?2 IS NULL OR w.agent_id = ?2 OR (w.project_id IS NOT NULL AND w.project_id = ?3))
			 ORDER BY w.created_at, w.id`,
			[ownerUserId, agent?.agent_id ?? null, agent?.project_id ?? null],
		);
		return r.results;
	}

	/**
	 * Creates work `id` for `target` (or returns it: repeating the same POST is
	 * idempotent). `createdBy`: "owner" or the creating agent's name — whose
	 * permission the route has already checked. `base`: ref or sha; absent = the
	 * remote's default branch after a best-effort fetch.
	 */
	async create(m: {
		ownerUserId: string;
		createdBy: string;
		target: AgentRow;
		id: string;
		base?: string | null;
	}): Promise<{ work: WorkRow; created: boolean }> {
		const { ownerUserId, target, id } = m;
		if (!WORK_ID_RE.test(id)) throw new WorkError(400, "bad-work-id");
		const base = m.base ?? "";
		if (base !== "" && !BASE_RE.test(base)) throw new WorkError(400, "bad-base");
		let row = await this.get(ownerUserId, id);
		if (row) {
			if (row.agent_id !== target.agent_id)
				throw new WorkError(409, "work-exists", { state: row.state, reason: "es de otro agente" });
			if (row.state === "active") return { work: row, created: false };
			if (row.state !== "creating")
				throw new WorkError(409, "work-exists", {
					state: row.state,
					reason: "un id de trabajo no se reutiliza",
				});
		}
		// Named contexts run in slots ≥ 2: a one-slot agent would never take one.
		if (target.max_concurrency < 2)
			throw new WorkError(400, "context-needs-slots", { agent: target.name });
		const containerId = await this.docker.runningContainerId(
			`st-${target.session_id.slice(0, 12)}`,
		);
		if (!containerId) throw new WorkError(409, "session-not-running", { agent: target.name });
		const sh = (script: string, ...args: string[]) =>
			this.docker.execCapture(target.session_id, ["sh", "-c", script, "sh", ...args], {
				containerId,
				maxBytes: 16 * 1024,
				timeoutMs: EXEC_TIMEOUT_MS,
			});

		// A row left `creating` by an earlier attempt: what is really there decides.
		if (row) {
			const seen = await this.inspect(sh, id);
			if (seen.state === "ok") return { work: await this.activate(row, seen.sha), created: false };
			if (seen.state !== "none") throw this.incomplete(row, seen.state);
		}

		const pre = parse((await sh(PREFLIGHT, id, base)).stdout);
		if (pre.has("not-a-repo"))
			throw new WorkError(409, "not-a-repo", { reason: `${WORKSPACE} no es un repositorio git` });
		const found = pre.get("exists") ?? [];
		if (found.length)
			throw new WorkError(409, "work-path-exists", {
				found,
				reason:
					"ya hay algo de ese id en el workspace (directorio, sesión ACP vieja o rama): no se reemplaza",
			});
		if (pre.has("bad-base"))
			throw new WorkError(400, "bad-base", { base: pre.get("bad-base")?.[0] });
		const freeMb = Math.floor(Number(pre.get("free_kb")?.[0]) / 1024);
		if (!(freeMb >= this.config.workMinFreeMb))
			throw new WorkError(409, "low-disk", {
				freeMb: Number.isFinite(freeMb) ? freeMb : null,
				minFreeMb: this.config.workMinFreeMb,
			});
		const sha = pre.get("sha")?.[0];
		if (!sha) throw new WorkError(500, "preflight-failed");

		if (!row) {
			row = await this.insert(ownerUserId, id, target, m.createdBy);
			if (row.agent_id !== target.agent_id || row.state !== "creating")
				// A concurrent POST of the same id won the INSERT: its outcome is the answer.
				return this.create(m);
		}
		let ok = false;
		try {
			const r = await sh(CREATE, id, sha);
			ok = r.exitCode === 0;
			if (!ok)
				logger.warn(
					`[acp] work ${id} of @${target.name}: worktree add exit ${r.exitCode}: ${r.stderr.toString("utf8").slice(0, 300)}`,
				);
		} catch (err) {
			logger.warn(`[acp] work ${id} of @${target.name}: worktree add: ${(err as Error).message}`);
		}
		if (ok) return { work: await this.activate(row, sha), created: true };
		const seen = await this.inspect(sh, id).catch(() => ({ state: "unknown", sha: null }));
		if (seen.state === "ok") return { work: await this.activate(row, seen.sha), created: true };
		throw this.incomplete(row, seen.state);
	}

	private async inspect(
		sh: (script: string, ...args: string[]) => ReturnType<DockerManager["execCapture"]>,
		id: string,
	): Promise<{ state: string; sha: string | null }> {
		const r = await sh(INSPECT, id);
		const out = parse(r.stdout);
		return { state: out.get("state")?.[0] ?? "unknown", sha: out.get("sha")?.[0] ?? null };
	}

	/** The row stays `creating`, with what was found, and the answer says so. */
	private incomplete(row: WorkRow, found: string): WorkError {
		const note =
			found === "none"
				? "no se creó nada: repetí el pedido"
				: found === "branch-only"
					? "existe la rama work/<id> sin su worktree: revisalo a mano, no se reemplaza"
					: found === "other"
						? "hay un directorio en .st/ctx/<id> que no es el worktree de work/<id>: revisalo a mano"
						: "no se pudo comprobar el estado del worktree: repetí el pedido";
		void d1Query(
			"UPDATE agent_works SET note = ? WHERE owner_user_id = ? AND id = ? AND state = 'creating'",
			[note, row.owner_user_id, row.id],
		).catch(() => {});
		return new WorkError(409, "work-incomplete", { state: "creating", found, note });
	}

	private async activate(row: WorkRow, sha: string | null): Promise<WorkRow> {
		const r = await d1Query<WorkRow>(
			`UPDATE agent_works SET state = 'active', base_sha = COALESCE(base_sha, ?), note = NULL
			 WHERE owner_user_id = ? AND id = ? AND state IN ('creating', 'active') RETURNING *`,
			[sha, row.owner_user_id, row.id],
		);
		const w = r.results[0];
		if (!w)
			throw new WorkError(409, "work-exists", { reason: "cambió de estado mientras se creaba" });
		logger.info(`[acp] work ${w.id} active (${w.branch} @ ${w.base_sha}, ports ${w.port_base})`);
		return w;
	}

	/**
	 * The `creating` row, with the lowest free port block among the agent's works
	 * that are not `cleaned` — chosen in the INSERT itself; the partial unique
	 * index refuses a block a concurrent INSERT took (then one more try).
	 */
	private async insert(
		ownerUserId: string,
		id: string,
		target: AgentRow,
		createdBy: string,
	): Promise<WorkRow> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const r = await d1Query<WorkRow>(
				`INSERT INTO agent_works (owner_user_id, id, agent_id, project_id, branch, port_base, state, created_by)
				 SELECT ?1, ?2, ?3, ?4, ?5, p, 'creating', ?6 FROM (SELECT
					CASE WHEN NOT EXISTS (SELECT 1 FROM agent_works WHERE agent_id = ?3 AND state != 'cleaned' AND port_base = ?7) THEN ?7
					ELSE (SELECT MIN(w.port_base) + ?8 FROM agent_works w WHERE w.agent_id = ?3 AND w.state != 'cleaned'
						AND NOT EXISTS (SELECT 1 FROM agent_works v WHERE v.agent_id = ?3 AND v.state != 'cleaned' AND v.port_base = w.port_base + ?8))
					END AS p) WHERE true
				 ON CONFLICT DO NOTHING RETURNING *`,
				[
					ownerUserId,
					id,
					target.agent_id,
					target.project_id,
					`work/${id}`,
					createdBy,
					PORT_FIRST,
					PORT_SPAN,
				],
			);
			if (r.results[0]) return r.results[0];
			const prior = await this.get(ownerUserId, id);
			if (prior) return prior;
		}
		throw new WorkError(503, "port-allocation-failed");
	}
}

/** What the API shows of a work. */
export function workView(w: WorkRow & { agent?: string }) {
	return {
		id: w.id,
		agent: w.agent,
		projectId: w.project_id,
		branch: w.branch,
		dir: workDir(w.id),
		baseSha: w.base_sha,
		portBase: w.port_base,
		state: w.state,
		note: w.note,
		createdBy: w.created_by,
		createdAt: w.created_at,
		closedAt: w.closed_at,
		cleanedAt: w.cleaned_at,
	};
}
