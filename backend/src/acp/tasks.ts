/**
 * acp/tasks.ts — tasks (v29, issue #794 §2–§4): what a project's agents are
 * working on. A ROOT (`parent_id` NULL) is a goal — created for one request of
 * the person, at most one per request — or a loose task; it carries the
 * coordinator. A CHILD hangs from a root (one level, enforced by the creating
 * statement) and uses its root's coordinator. A conversation creates no task
 * and a task creates no worktree: a work is only linked.
 *
 * `status` is what was DECLARED (todo / doing / review / done). What is really
 * going on is derived on read from the messages, questions and linked works
 * (DERIVED STATE below) and never written over it.
 *
 * Who may do what (the token says who the caller is, never the body):
 * - the person: everything, in any of their projects;
 * - an agent: only tasks of its own project — any other, like a missing one,
 *   is the same 404;
 *   - the coordinator (of the root): create children, title/description,
 *     assign (assignee, reviewer), priority, dependencies, hand the goal over;
 *   - the assignee: move its task between todo/doing/review, block/unblock,
 *     link a work, a PR or an external wait;
 *   - `done` (and reopening a done task): an agent that is NOT the assignee
 *     and is the task's reviewer or the coordinator. The assignee never.
 *   No state grants anything else.
 *
 * Every write names the `version` it was decided on: `UPDATE … WHERE version
 * = ?`, else 409 `stale` with the current row. A write whose permission came
 * from being the coordinator of a child's root also requires the root still
 * to have that coordinator, in the same statement. History (`task_events`)
 * is written by the v29 triggers in the statement that made each change (and,
 * for a request refused by a budget, by the one INSERT that records it).
 *
 * DERIVED STATE (`state` on every task the API shows) is read, never stored:
 * the task's messages running / queued / interrupted and not reviewed, the
 * open questions asked while working on them, its linked works' states, its
 * budgets — and what contradicts the declared status (a `done` task with a
 * run, a queued message, an active work or an open question). After a
 * reassignment there is no cancellation: a run of someone other than the
 * assignee still going is reported as `previousRunActive`, with whose it is.
 * A page derives all its tasks in four statements, each by the task.
 */

import { d1Query } from "../db.js";
import type { AcpAgents, AgentRow, BudgetError, MessageRow } from "./agents.js";
import { WORK_ID_RE, type WorkRow } from "./works.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 8000;
const REASON_MAX = 500;
const EXTERNAL_MAX = 200;
/** Board pages: open tasks by id, done ones newest first. */
// ≤ 200 tasks a page in all (#794, precisions §7): no cap on tasks per project.
const OPEN_PAGE = 150;
const DONE_PAGE = 50;
const CHILDREN_MAX = 500;
const EVENTS_MAX = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching controls is the point
const UNSAFE_LINE_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: newlines and tabs are allowed in a description
const UNSAFE_TEXT_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const PR_RE = /^(?:\d{1,9}|https:\/\/[^\s]{1,300})$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type TaskStatus = "todo" | "doing" | "review" | "done";
export type TaskPriority = "low" | "normal" | "high";
export type LinkKind = "work" | "pr" | "dep" | "external";
const STATUSES: readonly TaskStatus[] = ["todo", "doing", "review", "done"];
const PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high"];
const LINK_KINDS: readonly LinkKind[] = ["work", "pr", "dep", "external"];

export interface TaskRow {
	id: number;
	owner_user_id: string;
	project_id: string;
	parent_id: number | null;
	title: string;
	description: string;
	assignee: string | null;
	reviewer: string | null;
	coordinator: string | null;
	priority: TaskPriority;
	status: TaskStatus;
	blocked_reason: string | null;
	version: number;
	origin_key: string | null;
	origin_message_id: number | null;
	conversation_id: string | null;
	budget_limit: number | null;
	budget_used: number;
	requests_used: number;
	/** This task's own cap of agent requests; NULL = ACP_TASK_BUDGET. */
	requests_limit: number | null;
	created_by: string;
	updated_by: string;
	created_at: string;
	updated_at: string;
	done_at: string | null;
	done_by: string | null;
}

export interface LinkRow {
	owner_user_id: string;
	task_id: number;
	kind: LinkKind;
	ref: string;
	created_by: string;
	created_at: string;
}

export interface EventRow {
	id: number;
	owner_user_id: string;
	task_id: number;
	actor: string;
	kind: string;
	data: string | null;
	created_at: string;
}

/** Who is calling: the person, or an agent (its credential). */
export type TaskActor =
	| { kind: "owner" }
	| { kind: "agent"; agent: AgentRow; context: string | null };

/** A refusal with its HTTP status, error code and what the caller needs to act on it. */
export class TaskError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail: Record<string, unknown> = {},
	) {
		super(code);
	}
}

export interface Activity {
	kind: "running" | "queued" | "uncertain" | "waitOwner" | "work";
	agent: string;
	conversationId: string | null;
	since: string | null;
	messageId?: number;
	questionId?: number;
	workId?: string;
}

/** Derived on read (never stored): see AcpTasks.derive. */
export interface Derived {
	activity: Activity[];
	contradiction: string | null;
	dependencies: Array<{ taskId: number; title: string | null; status: TaskStatus | null }>;
	previousRunActive: Array<{ messageId: number; agent: string }>;
	taskBudget: { used: number; limit: number; exhausted: boolean };
	budget: { used: number; limit: number; exhausted: boolean } | null;
}

export function taskView(t: TaskRow, links?: LinkRow[], derived?: Derived) {
	return {
		id: t.id,
		projectId: t.project_id,
		parentId: t.parent_id,
		title: t.title,
		description: t.description,
		assignee: t.assignee,
		reviewer: t.reviewer,
		coordinator: t.coordinator,
		priority: t.priority,
		status: t.status,
		blockedReason: t.blocked_reason,
		version: t.version,
		originKey: t.origin_key,
		originMessageId: t.origin_message_id,
		conversationId: t.conversation_id,
		budget: t.parent_id === null ? { limit: t.budget_limit, used: t.budget_used } : null,
		requestsUsed: t.requests_used,
		createdBy: t.created_by,
		updatedBy: t.updated_by,
		createdAt: t.created_at,
		updatedAt: t.updated_at,
		doneAt: t.done_at,
		doneBy: t.done_by,
		...(derived ?? {}),
		...(links
			? {
					links: links
						.filter((l) => l.task_id === t.id)
						.map((l) => ({
							kind: l.kind,
							ref: l.ref,
							createdBy: l.created_by,
							createdAt: l.created_at,
						})),
				}
			: {}),
	};
}

function eventView(e: EventRow) {
	let data: unknown = null;
	try {
		data = e.data ? JSON.parse(e.data) : null;
	} catch {
		data = null;
	}
	return { id: e.id, actor: e.actor, kind: e.kind, data, at: e.created_at };
}

// ── Validation ─────────────────────────────────────────────────────────────

function line(v: unknown, max: number, code: string): string {
	if (typeof v !== "string") throw new TaskError(400, code);
	const t = v.normalize("NFC").trim();
	if (t.length === 0 || [...t].length > max || UNSAFE_LINE_RE.test(t))
		throw new TaskError(400, code);
	return t;
}

function text(v: unknown): string {
	if (v === undefined || v === null) return "";
	if (typeof v !== "string") throw new TaskError(400, "invalid-description");
	const t = v.normalize("NFC").trim();
	if ([...t].length > DESCRIPTION_MAX || UNSAFE_TEXT_RE.test(t))
		throw new TaskError(400, "invalid-description");
	return t;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], code: string): T {
	if (typeof v !== "string" || !list.includes(v as T))
		throw new TaskError(400, code, { allowed: list });
	return v as T;
}

const actorName = (a: TaskActor) => (a.kind === "owner" ? "owner" : a.agent.name);

/** Every task has a project: an agent in none has no tasks to see or make (409, not a 404). */
function noProject(a: TaskActor): void {
	if (a.kind === "agent" && a.agent.project_id === null) throw new TaskError(409, "no-project");
}

// ── Tasks ──────────────────────────────────────────────────────────────────

export class AcpTasks {
	constructor(
		private readonly acp: AcpAgents,
		private readonly works: { get(ownerUserId: string, id: string): Promise<WorkRow | null> },
	) {}

	private publish(row: TaskRow, links?: LinkRow[]): void {
		this.acp.emit(row.owner_user_id, { type: "task", task: taskView(row, links) });
	}

	private async row(ownerUserId: string, id: number): Promise<TaskRow | null> {
		const r = await d1Query<TaskRow>("SELECT * FROM tasks WHERE id = ? AND owner_user_id = ?", [
			id,
			ownerUserId,
		]);
		return r.results[0] ?? null;
	}

	/** The task if the caller may see it: the person's, or one of the calling agent's project. */
	async visible(ownerUserId: string, actor: TaskActor, id: unknown): Promise<TaskRow | null> {
		const n = typeof id === "string" && /^\d{1,15}$/.test(id) ? Number(id) : id;
		if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return null;
		const t = await this.row(ownerUserId, n);
		if (!t) return null;
		if (
			actor.kind === "agent" &&
			(actor.agent.project_id === null || t.project_id !== actor.agent.project_id)
		)
			return null;
		return t;
	}

	private async mustSee(ownerUserId: string, actor: TaskActor, id: unknown): Promise<TaskRow> {
		noProject(actor);
		const t = await this.visible(ownerUserId, actor, id);
		if (!t) throw new TaskError(404, "task-not-found");
		return t;
	}

	/** An agent of the project by name (`@` optional), or null when `v` is null. */
	private async member(ownerUserId: string, projectId: string, v: unknown, field: string) {
		if (v === null) return null;
		const name = typeof v === "string" ? v.replace(/^@/, "") : "";
		const a = name ? await this.acp.byName(ownerUserId, name) : null;
		if (!a || a.project_id !== projectId)
			throw new TaskError(400, "not-in-project", { field, agent: name });
		return a.name;
	}

	/** `name` was ever this task's assignee: its history (created / assigned), read by the task. */
	private async wasAssignee(t: TaskRow, name: string): Promise<boolean> {
		const r = await d1Query(
			`SELECT 1 FROM task_events WHERE owner_user_id = ? AND task_id = ?
			 AND ((kind = 'created' AND json_extract(data, '$.assignee') = ?)
				OR (json_extract(data, '$.assignee[0]') = ? OR json_extract(data, '$.assignee[1]') = ?))
			 LIMIT 1`,
			[t.owner_user_id, t.id, name, name, name],
		);
		return r.results.length > 0;
	}

	/** The root's coordinator (a child has none of its own). */
	private async coordinatorOf(t: TaskRow): Promise<string | null> {
		if (t.parent_id === null) return t.coordinator;
		return (await this.row(t.owner_user_id, t.parent_id))?.coordinator ?? null;
	}

	/**
	 * The person's request a message belongs to: its chain's root (through the
	 * interrupted message, for the runner's recovery report). A post to several
	 * agents or to the whole team shares its `client_id` across the recipients'
	 * rows, so every agent that got it computes the same key. `c:`/`m:` keep a
	 * client id from ever equalling a message key.
	 */
	private async originOf(
		ownerUserId: string,
		msg: MessageRow,
	): Promise<{ key: string; messageId: number }> {
		let m = msg;
		if (m.from_id === "system" && m.recovery_of !== null)
			m = (await this.acp.message(ownerUserId, m.recovery_of)) ?? m;
		if (m.root_id !== null) m = (await this.acp.message(ownerUserId, m.root_id)) ?? m;
		return { key: m.client_id ? `c:${m.client_id}` : `m:${m.id}`, messageId: m.id };
	}

	/**
	 * POST /tasks. With `parentId`: a child of that root (the root's coordinator
	 * or the person). Without: a root in the caller's project — an agent's with
	 * `goal: true` is THE goal of the person's request it is running, created
	 * once: the second agent gets the existing one (`created: false`) and its
	 * coordinator. The person creates a root in `projectId`, optionally for one
	 * of their messages (`originMessageId`, same idempotency) and with a
	 * coordinator of the project.
	 */
	async create(
		ownerUserId: string,
		actor: TaskActor,
		body: unknown,
	): Promise<{ task: TaskRow; created: boolean }> {
		const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
		const title = line(b.title, TITLE_MAX, "invalid-title");
		const description = text(b.description);
		const priority =
			b.priority === undefined ? "normal" : oneOf(b.priority, PRIORITIES, "bad-priority");
		const by = actorName(actor);
		const hasParent = b.parentId !== undefined && b.parentId !== null;
		if (hasParent) {
			for (const k of [
				"goal",
				"originMessageId",
				"coordinator",
				"projectId",
				"budgetLimit",
			] as const)
				if (b[k] !== undefined && b[k] !== null && b[k] !== false)
					throw new TaskError(400, "child-field", { field: k });
			const parent = await this.mustSee(ownerUserId, actor, b.parentId);
			if (parent.parent_id !== null)
				throw new TaskError(400, "one-level", { parentId: parent.id, rootId: parent.parent_id });
			if (actor.kind === "agent" && parent.coordinator !== actor.agent.name)
				throw new TaskError(403, "not-coordinator", { coordinator: parent.coordinator });
			const assignee =
				b.assignee === undefined
					? null
					: await this.member(ownerUserId, parent.project_id, b.assignee, "assignee");
			const reviewer =
				b.reviewer === undefined
					? null
					: await this.member(ownerUserId, parent.project_id, b.reviewer, "reviewer");
			// The one-level rule and the coordinator's authority, in the statement:
			// the parent is still a root with that coordinator when the child lands.
			const r = await d1Query<TaskRow>(
				`INSERT INTO tasks (owner_user_id, project_id, parent_id, title, description, assignee, reviewer, priority,
					conversation_id, created_by, updated_by)
				 SELECT p.owner_user_id, p.project_id, p.id, ?3, ?4, ?5, ?6, ?7, p.conversation_id, ?8, ?8
				 FROM tasks p WHERE p.id = ?1 AND p.owner_user_id = ?2 AND p.parent_id IS NULL
					AND (?9 = 0 OR p.coordinator IS ?8)
				 RETURNING *`,
				[
					parent.id,
					ownerUserId,
					title,
					description,
					assignee,
					reviewer,
					priority,
					by,
					actor.kind === "agent" ? 1 : 0,
				],
			);
			const child = r.results[0];
			if (!child) throw await this.staleOrGone(ownerUserId, parent.id);
			this.publish(child);
			return { task: child, created: true };
		}

		// A root.
		let projectId: string;
		let coordinator: string | null;
		let origin: { key: string; messageId: number } | null = null;
		let conversationId: string | null = null;
		let budgetLimit = this.acp.config.goalBudget;
		if (actor.kind === "agent") {
			const a = actor.agent;
			if (a.project_id === null) throw new TaskError(409, "no-project");
			if (b.projectId !== undefined && b.projectId !== null && b.projectId !== a.project_id)
				throw new TaskError(404, "project-not-found");
			if (
				b.originMessageId !== undefined ||
				b.budgetLimit !== undefined ||
				(b.coordinator !== undefined && b.coordinator !== null)
			)
				throw new TaskError(400, "computed-by-backend", {
					message:
						"el origen y el coordinador de un objetivo los fija el backend desde tu mensaje en ejecución",
				});
			projectId = a.project_id;
			coordinator = a.name;
			const cur = await this.acp.runningIn(a, actor.context);
			if (b.goal === true) {
				if (!cur)
					throw new TaskError(409, "execution-ended", {
						message:
							"the message this process was started for is no longer running: nothing was created",
					});
				origin = await this.originOf(ownerUserId, cur);
			}
			conversationId = cur?.conversation_id ?? null;
		} else {
			if (
				typeof b.projectId !== "string" ||
				!(await this.acp.ownsProject(ownerUserId, b.projectId))
			)
				throw new TaskError(404, "project-not-found");
			projectId = b.projectId;
			// The person may start a goal with another budget than ACP_GOAL_BUDGET.
			if (b.budgetLimit !== undefined) {
				const n = b.budgetLimit;
				if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 10_000)
					throw new TaskError(400, "bad-budget", { min: 0, max: 10_000 });
				budgetLimit = n;
			}
			coordinator =
				b.coordinator === undefined
					? null
					: await this.member(ownerUserId, projectId, b.coordinator, "coordinator");
			if (b.originMessageId !== undefined && b.originMessageId !== null) {
				const id = Number(b.originMessageId);
				const msg = Number.isSafeInteger(id) ? await this.acp.message(ownerUserId, id) : null;
				if (!msg) throw new TaskError(404, "message-not-found");
				if (msg.project_id !== null && msg.project_id !== projectId)
					throw new TaskError(400, "project-mismatch");
				origin = await this.originOf(ownerUserId, msg);
				conversationId = msg.conversation_id;
			}
		}
		const assignee =
			b.assignee === undefined
				? null
				: await this.member(ownerUserId, projectId, b.assignee, "assignee");
		const reviewer =
			b.reviewer === undefined
				? null
				: await this.member(ownerUserId, projectId, b.reviewer, "reviewer");
		const r = await d1Query<TaskRow>(
			`INSERT INTO tasks (owner_user_id, project_id, title, description, assignee, reviewer, coordinator, priority,
				origin_key, origin_message_id, conversation_id, budget_limit, created_by, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`,
			[
				ownerUserId,
				projectId,
				title,
				description,
				assignee,
				reviewer,
				coordinator,
				priority,
				origin?.key ?? null,
				origin?.messageId ?? null,
				conversationId,
				budgetLimit,
				by,
				by,
			],
		);
		const created = r.results[0];
		if (created) {
			this.publish(created);
			return { task: created, created: true };
		}
		// Only the origin key can conflict: the goal of that request exists.
		const prior = await d1Query<TaskRow>(
			"SELECT * FROM tasks WHERE owner_user_id = ? AND origin_key = ?",
			[ownerUserId, origin?.key ?? null],
		);
		const existing = prior.results[0];
		if (!existing) throw new Error("task insert returned nothing");
		if (existing.project_id !== projectId)
			throw new TaskError(409, "origin-other-project", { id: existing.id });
		return { task: existing, created: false };
	}

	/**
	 * A project's board: its open tasks by id (`openAfter` pages them) and its
	 * done ones newest first (`doneBefore`, the `nextDone` cursor of the previous
	 * page), with their links. Each read goes by its partial index.
	 */
	async board(
		ownerUserId: string,
		actor: TaskActor,
		q: { projectId?: unknown; project?: unknown; openAfter?: unknown; doneBefore?: unknown },
	) {
		const projectId = await this.projectOf(ownerUserId, actor, q.projectId ?? q.project);
		const after = Number(q.openAfter ?? 0);
		if (!Number.isSafeInteger(after) || after < 0) throw new TaskError(400, "bad-cursor");
		let doneAt = "9999-12-31T23:59:59.999Z";
		let doneId = Number.MAX_SAFE_INTEGER;
		if (q.doneBefore !== undefined) {
			const m = typeof q.doneBefore === "string" ? /^(.+)~(\d{1,15})$/.exec(q.doneBefore) : null;
			if (!m || !ISO_MS_RE.test(m[1])) throw new TaskError(400, "bad-cursor");
			doneAt = m[1];
			doneId = Number(m[2]);
		}
		const [open, done] = await Promise.all([
			d1Query<TaskRow>(
				`SELECT * FROM tasks WHERE owner_user_id = ? AND project_id = ? AND status != 'done' AND id > ?
				 ORDER BY id LIMIT ?`,
				[ownerUserId, projectId, after, OPEN_PAGE + 1],
			),
			d1Query<TaskRow>(
				`SELECT * FROM tasks WHERE owner_user_id = ? AND project_id = ? AND status = 'done' AND (done_at, id) < (?, ?)
				 ORDER BY done_at DESC, id DESC LIMIT ?`,
				[ownerUserId, projectId, doneAt, doneId, DONE_PAGE + 1],
			),
		]);
		const openRows = open.results.slice(0, OPEN_PAGE);
		const doneRows = done.results.slice(0, DONE_PAGE);
		const links = await this.linksOf(
			ownerUserId,
			[...openRows, ...doneRows].map((t) => t.id),
		);
		const states = await this.derive(ownerUserId, [...openRows, ...doneRows], links);
		const lastDone = doneRows.at(-1);
		return {
			projectId,
			open: openRows.map((t) => taskView(t, links, states.get(t.id))),
			done: doneRows.map((t) => taskView(t, links, states.get(t.id))),
			nextOpen: open.results.length > OPEN_PAGE ? (openRows.at(-1)?.id ?? null) : null,
			nextDone:
				done.results.length > DONE_PAGE && lastDone ? `${lastDone.done_at}~${lastDone.id}` : null,
		};
	}

	private async linksOf(ownerUserId: string, ids: number[]): Promise<LinkRow[]> {
		if (!ids.length) return [];
		const r = await d1Query<LinkRow>(
			`SELECT * FROM task_links WHERE task_id IN (SELECT value FROM json_each(?)) AND owner_user_id = ?
			 ORDER BY task_id, kind, ref`,
			[JSON.stringify(ids), ownerUserId],
		);
		return r.results;
	}

	/** One task with its links, its root (a child's) or children (a root's), and its latest history. */
	async show(ownerUserId: string, actor: TaskActor, id: unknown) {
		const t = await this.mustSee(ownerUserId, actor, id);
		const [links, related, events] = await Promise.all([
			this.linksOf(ownerUserId, [t.id]),
			t.parent_id === null
				? d1Query<TaskRow>(
						"SELECT * FROM tasks WHERE owner_user_id = ? AND parent_id = ? ORDER BY id LIMIT ?",
						[ownerUserId, t.id, CHILDREN_MAX],
					)
				: d1Query<TaskRow>("SELECT * FROM tasks WHERE id = ? AND owner_user_id = ?", [
						t.parent_id,
						ownerUserId,
					]),
			d1Query<EventRow>(
				`SELECT * FROM (SELECT * FROM task_events WHERE owner_user_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?)
				 ORDER BY id`,
				[ownerUserId, t.id, EVENTS_MAX],
			),
		]);
		const childLinks =
			t.parent_id === null
				? await this.linksOf(
						ownerUserId,
						related.results.map((c) => c.id),
					)
				: [];
		const states = await this.derive(
			ownerUserId,
			[t, ...related.results],
			[...links, ...childLinks],
		);
		return {
			task: taskView(t, links, states.get(t.id)),
			parent:
				t.parent_id === null
					? null
					: related.results[0]
						? taskView(related.results[0], undefined, states.get(related.results[0].id))
						: null,
			children:
				t.parent_id === null
					? related.results.map((c) => taskView(c, childLinks, states.get(c.id)))
					: [],
			events: events.results.map(eventView),
		};
	}

	/**
	 * PATCH /tasks/:id {version, …fields}. Each field is checked against the
	 * caller's role on the row at that version (header); the UPDATE applies only
	 * if the row is still at that version.
	 */
	async update(
		ownerUserId: string,
		actor: TaskActor,
		id: unknown,
		body: unknown,
	): Promise<TaskRow> {
		const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
		const version = b.version;
		if (typeof version !== "number" || !Number.isSafeInteger(version))
			throw new TaskError(400, "version-required");
		const t = await this.mustSee(ownerUserId, actor, id);
		const coord = await this.coordinatorOf(t);
		const me = actor.kind === "agent" ? actor.agent.name : null;
		const isCoord = me !== null && me === coord;
		const isAssignee = me !== null && me === t.assignee;
		const need = (ok: boolean, field: string, role: string) => {
			if (actor.kind !== "owner" && !ok)
				throw new TaskError(403, "not-allowed", { field, need: role });
		};

		const set: string[] = [];
		const params: unknown[] = [];
		const put = (col: string, v: unknown) => {
			set.push(`${col} = ?`);
			params.push(v);
		};
		const has = (k: string) => k in b;
		let newAssignee = t.assignee;
		if (has("title")) {
			need(isCoord, "title", "coordinator");
			put("title", line(b.title, TITLE_MAX, "invalid-title"));
		}
		if (has("description")) {
			need(isCoord, "description", "coordinator");
			put("description", text(b.description));
		}
		if (has("priority")) {
			need(isCoord, "priority", "coordinator");
			put("priority", oneOf(b.priority, PRIORITIES, "bad-priority"));
		}
		if (has("assignee")) {
			need(isCoord, "assignee", "coordinator");
			newAssignee = await this.member(ownerUserId, t.project_id, b.assignee, "assignee");
			put("assignee", newAssignee);
		}
		if (has("reviewer")) {
			need(isCoord, "reviewer", "coordinator");
			put("reviewer", await this.member(ownerUserId, t.project_id, b.reviewer, "reviewer"));
		}
		if (has("coordinator")) {
			if (t.parent_id !== null) throw new TaskError(400, "not-a-root", { rootId: t.parent_id });
			need(isCoord, "coordinator", "coordinator");
			const next = await this.member(ownerUserId, t.project_id, b.coordinator, "coordinator");
			// Only the person may leave a goal without an agent coordinating it.
			if (next === null && actor.kind !== "owner") throw new TaskError(400, "coordinator-required");
			put("coordinator", next);
		}
		if (has("blockedReason")) {
			need(isAssignee, "blockedReason", "assignee");
			put(
				"blocked_reason",
				b.blockedReason === null ? null : line(b.blockedReason, REASON_MAX, "invalid-reason"),
			);
		}
		if (has("status")) {
			const to = oneOf(b.status, STATUSES, "bad-status");
			if (to === "done" || t.status === "done") {
				// Approval (and its undoing): never the assignee — the one the task
				// has, the one this same write gives it, or any it had before (a
				// coordinator could otherwise reassign its own task away and approve it).
				if (actor.kind === "agent") {
					if (me === t.assignee || me === newAssignee || (await this.wasAssignee(t, me as string)))
						throw new TaskError(403, "self-approval", {
							message:
								"el responsable de una tarea no la aprueba: la aprueba su reviewer, el coordinador o la persona",
						});
					if (me !== t.reviewer && !isCoord)
						throw new TaskError(403, "not-allowed", {
							field: "status",
							need: "reviewer-or-coordinator",
						});
				}
				if (to === "done" && t.status !== "done") {
					set.push(`done_at = ${NOW}`, "done_by = ?");
					params.push(actorName(actor));
				} else if (to !== "done") set.push("done_at = NULL", "done_by = NULL");
			} else need(isAssignee, "status", "assignee");
			put("status", to);
		}
		if (!set.length) throw new TaskError(400, "nothing-to-change");

		// A child's coordinator is its root's: the authority checked above must
		// still hold when the row is written (the root may have been handed over).
		const guard = actor.kind === "agent" && t.parent_id !== null && isCoord;
		const r = await d1Query<TaskRow>(
			`UPDATE tasks SET ${set.join(", ")}, version = version + 1, updated_at = ${NOW}, updated_by = ?
			 WHERE id = ? AND owner_user_id = ? AND version = ?
				${guard ? "AND (SELECT p.coordinator FROM tasks p WHERE p.id = tasks.parent_id AND p.owner_user_id = tasks.owner_user_id) IS ?" : ""}
			 RETURNING *`,
			[...params, actorName(actor), t.id, ownerUserId, version, ...(guard ? [coord] : [])],
		);
		const row = r.results[0];
		if (row) {
			this.publish(row);
			return row;
		}
		throw await this.staleOrGone(ownerUserId, t.id);
	}

	/**
	 * POST /tasks/:id/links {version, kind, ref}. `dep` (another task of the
	 * project this one waits for): the coordinator. `work`, `pr` (a link, not an
	 * approval), `external` (a wait the system cannot see): the assignee or the
	 * coordinator. Adding a link that is already there changes nothing.
	 */
	async link(ownerUserId: string, actor: TaskActor, id: unknown, body: unknown): Promise<TaskRow> {
		const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
		const version = b.version;
		if (typeof version !== "number" || !Number.isSafeInteger(version))
			throw new TaskError(400, "version-required");
		const kind = oneOf(b.kind, LINK_KINDS, "bad-link-kind");
		const t = await this.mustSee(ownerUserId, actor, id);
		const coord = await this.coordinatorOf(t);
		const me = actor.kind === "agent" ? actor.agent.name : null;
		const isCoord = me !== null && me === coord;
		if (actor.kind === "agent") {
			const ok = kind === "dep" ? isCoord : isCoord || me === t.assignee;
			if (!ok)
				throw new TaskError(403, "not-allowed", {
					field: "links",
					need: kind === "dep" ? "coordinator" : "assignee-or-coordinator",
				});
		}
		let ref: string;
		if (kind === "work") {
			ref = String(b.ref ?? "");
			const w = WORK_ID_RE.test(ref) ? await this.works.get(ownerUserId, ref) : null;
			if (!w || w.project_id !== t.project_id)
				throw new TaskError(404, "work-not-found", { work: ref });
		} else if (kind === "pr") {
			ref = String(b.ref ?? "").trim();
			if (!PR_RE.test(ref))
				throw new TaskError(400, "bad-pr", { message: "un número de PR o una URL https" });
		} else if (kind === "dep") {
			const dep = await this.visible(ownerUserId, actor, b.ref);
			if (!dep || dep.project_id !== t.project_id)
				throw new TaskError(404, "task-not-found", { dep: b.ref });
			if (dep.id === t.id) throw new TaskError(400, "self-dependency");
			ref = String(dep.id);
		} else ref = line(b.ref, EXTERNAL_MAX, "invalid-external");

		const guard = actor.kind === "agent" && t.parent_id !== null && isCoord;
		const r = await d1Query<LinkRow>(
			`INSERT INTO task_links (owner_user_id, task_id, kind, ref, created_by)
			 SELECT t.owner_user_id, t.id, ?, ?, ? FROM tasks t WHERE t.id = ? AND t.owner_user_id = ? AND t.version = ?
				${guard ? "AND (SELECT p.coordinator FROM tasks p WHERE p.id = t.parent_id AND p.owner_user_id = t.owner_user_id) IS ?" : ""}
			 ON CONFLICT DO NOTHING RETURNING *`,
			[kind, ref, actorName(actor), t.id, ownerUserId, version, ...(guard ? [coord] : [])],
		);
		const now = await this.row(ownerUserId, t.id);
		if (!now) throw new TaskError(404, "task-not-found");
		// Nothing inserted at the same version: the link was already there.
		if (!r.results[0] && now.version !== version) throw await this.staleOrGone(ownerUserId, now.id);
		if (!r.results[0] && guard && (await this.coordinatorOf(now)) !== coord)
			throw await this.staleOrGone(ownerUserId, now.id);
		const links = await this.linksOf(ownerUserId, [now.id]);
		if (r.results[0]) this.publish(now, links);
		return now;
	}

	/**
	 * POST /tasks/:id/scope-approved {version, questionId?} — the person approved
	 * the goal's scope (#794, precisions §4). There is no state for it: the
	 * coordinator asks with a question to the person (AskUserQuestion →
	 * agent_questions, in Pendientes) and, once the person has answered it, records
	 * it here — an event on the goal naming the question. A write decided on a
	 * version, like any other (409 stale), though it changes no column.
	 *
	 * What the backend verifies is that the person ANSWERED (ACP `accept` = the
	 * form was submitted, whatever option was chosen — «ajustar» too), not that
	 * they approved: the coordinator declares the approval, and the event keeps
	 * the person's answer (`answer`, its content, cut at 1000 chars) so anyone
	 * reading the history sees what was actually answered.
	 *
	 * An agent: the root's coordinator, and the question is its own, asked while
	 * working on a message of this goal's request (the chain of `origin_message_id`
	 * when the goal has one); without `questionId`, its latest answered one on
	 * the message it is running. The person may name any of their questions.
	 * Once per question.
	 */
	async scopeApproved(ownerUserId: string, actor: TaskActor, id: unknown, body: unknown) {
		const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
		const version = b.version;
		if (typeof version !== "number" || !Number.isSafeInteger(version))
			throw new TaskError(400, "version-required");
		const t = await this.mustSee(ownerUserId, actor, id);
		if (t.parent_id !== null) throw new TaskError(400, "not-a-root", { rootId: t.parent_id });
		if (t.version !== version) throw await this.staleOrGone(ownerUserId, t.id);
		const qid = b.questionId === undefined || b.questionId === null ? null : Number(b.questionId);
		if (qid !== null && !Number.isSafeInteger(qid)) throw new TaskError(400, "bad-question");
		type Q = {
			id: number;
			agent: string;
			state: string;
			answer: string | null;
			m_id: number | null;
			m_root: number | null;
		};
		const SEL = `SELECT q.id, q.agent, q.state, q.answer, m.id AS m_id, COALESCE(m.root_id, m.id) AS m_root
			FROM agent_questions q LEFT JOIN agent_messages m ON m.id = q.message_id AND m.owner_user_id = q.owner_user_id`;
		let q: Q | undefined;
		if (actor.kind === "agent") {
			if (actor.agent.name !== t.coordinator)
				throw new TaskError(403, "not-coordinator", { coordinator: t.coordinator });
			let r: { results: Q[] };
			if (qid === null) {
				const cur = await this.acp.runningIn(actor.agent, actor.context);
				if (!cur)
					throw new TaskError(409, "execution-ended", {
						message: "the message this process was started for is no longer running",
					});
				r = await d1Query<Q>(
					`${SEL} WHERE q.owner_user_id = ? AND q.message_id = ? AND q.agent = ?
					 AND q.state IN ('answered', 'delivered') ORDER BY q.id DESC LIMIT 1`,
					[ownerUserId, cur.id, actor.agent.name],
				);
			} else
				r = await d1Query<Q>(`${SEL} WHERE q.owner_user_id = ? AND q.id = ? AND q.agent = ?`, [
					ownerUserId,
					qid,
					actor.agent.name,
				]);
			q = r.results[0];
			if (!q) throw new TaskError(404, "question-not-found");
			// Under this goal's request: the question's message is of the chain the goal was made for.
			if (t.origin_message_id !== null && q.m_root !== t.origin_message_id)
				throw new TaskError(409, "question-other-request", { question: q.id });
		} else if (qid !== null) {
			q = (await d1Query<Q>(`${SEL} WHERE q.owner_user_id = ? AND q.id = ?`, [ownerUserId, qid]))
				.results[0];
			if (!q) throw new TaskError(404, "question-not-found");
		}
		let answerText: string | null = null;
		if (q) {
			let action: unknown = null;
			try {
				const a = q.answer
					? (JSON.parse(q.answer) as { action?: unknown; content?: unknown })
					: null;
				action = a?.action ?? null;
				answerText = a?.content === undefined ? null : JSON.stringify(a.content).slice(0, 1000);
			} catch {}
			if ((q.state !== "answered" && q.state !== "delivered") || action !== "accept")
				throw new TaskError(409, "question-not-accepted", {
					question: q.id,
					state: q.state,
					action,
				});
		}
		const r = await d1Query<EventRow>(
			`INSERT INTO task_events (owner_user_id, task_id, actor, kind, data)
			 SELECT ?1, ?2, ?3, 'scope-approved', json_object('question', ?4, 'answer', ?5)
			 WHERE ?4 IS NULL OR NOT EXISTS (SELECT 1 FROM task_events e WHERE e.owner_user_id = ?1 AND e.task_id = ?2
				AND e.kind = 'scope-approved' AND json_extract(e.data, '$.question') = ?4)
			 RETURNING *`,
			[ownerUserId, t.id, actorName(actor), q?.id ?? null, answerText],
		);
		if (r.results[0]) this.publish(t);
		return {
			recorded: Boolean(r.results[0]),
			question: q?.id ?? null,
			task: await this.view(ownerUserId, t),
		};
	}

	/** A task as the API answers it after a write: with its links and derived state. */
	async view(ownerUserId: string, t: TaskRow) {
		const links = await this.linksOf(ownerUserId, [t.id]);
		return taskView(t, links, (await this.derive(ownerUserId, [t], links)).get(t.id));
	}

	/**
	 * The derived state of `rows` (header) — the board's reading contract
	 * (#794, third comment): `activity[]` (running / queued / uncertain /
	 * waitOwner / work, each with its agent, conversation and since),
	 * `contradiction`, the dependencies with the other task's status, the run
	 * still going after a reassignment, and the budgets (`budget` on a root).
	 * Five fixed statements whatever the number of rows; no N+1.
	 */
	private async derive(
		ownerUserId: string,
		rows: TaskRow[],
		links: LinkRow[],
	): Promise<Map<number, Derived>> {
		const out = new Map<number, Derived>();
		if (!rows.length) return out;
		const ids = JSON.stringify(rows.map((t) => t.id));
		const refs = (kind: LinkKind) => [
			...new Set(links.filter((l) => l.kind === kind).map((l) => l.ref)),
		];
		const workIds = refs("work");
		const depIds = refs("dep").map(Number);
		type Msg = {
			id: number;
			task_id: number;
			to_id: string;
			state: string;
			conversation_id: string | null;
			created_at: string;
			started_at: string | null;
			finished_at: string | null;
		};
		const none = <T>() => Promise.resolve({ results: [] as T[] });
		const [active, interrupted, questions, works, deps] = await Promise.all([
			d1Query<Msg>(
				`SELECT id, task_id, to_id, state, conversation_id, created_at, started_at, finished_at FROM agent_messages
				 WHERE owner_user_id = ? AND task_id IN (SELECT value FROM json_each(?)) AND state IN ('pending', 'running')
				 ORDER BY id`,
				[ownerUserId, ids],
			),
			d1Query<Msg>(
				`SELECT id, task_id, to_id, state, conversation_id, created_at, started_at, finished_at FROM agent_messages
				 WHERE owner_user_id = ? AND task_id IN (SELECT value FROM json_each(?)) AND state = 'uncertain' AND reviewed_at IS NULL
				 ORDER BY id`,
				[ownerUserId, ids],
			),
			// From the few open questions (v28 index) to their message, never the other way.
			d1Query<{
				id: number;
				agent: string;
				message_id: number;
				task_id: number;
				conversation_id: string | null;
				created_at: string;
			}>(
				`SELECT q.id, q.agent, q.message_id, m.task_id, m.conversation_id, q.created_at FROM agent_questions q
				 CROSS JOIN agent_messages m ON m.id = q.message_id AND m.owner_user_id = q.owner_user_id
				 WHERE q.owner_user_id = ? AND q.state = 'open' AND m.task_id IN (SELECT value FROM json_each(?))
				 ORDER BY q.id`,
				[ownerUserId, ids],
			),
			workIds.length
				? d1Query<{
						id: string;
						state: string;
						agent: string | null;
						conversation_id: string | null;
						created_at: string;
					}>(
						`SELECT w.id, w.state, a.name AS agent, w.conversation_id, w.created_at FROM agent_works w
						 LEFT JOIN acp_agents a ON a.agent_id = w.agent_id
						 WHERE w.owner_user_id = ? AND w.id IN (SELECT value FROM json_each(?))`,
						[ownerUserId, JSON.stringify(workIds)],
					)
				: none<{
						id: string;
						state: string;
						agent: string | null;
						conversation_id: string | null;
						created_at: string;
					}>(),
			depIds.length
				? d1Query<{ id: number; title: string; status: TaskStatus }>(
						"SELECT id, title, status FROM tasks WHERE id IN (SELECT value FROM json_each(?)) AND owner_user_id = ?",
						[JSON.stringify(depIds), ownerUserId],
					)
				: none<{ id: number; title: string; status: TaskStatus }>(),
		]);
		const work = new Map(works.results.map((w) => [w.id, w]));
		const dep = new Map(deps.results.map((d) => [d.id, d]));
		const cfg = this.acp.config;
		for (const t of rows) {
			const of = <T extends { task_id: number }>(l: T[]) => l.filter((x) => x.task_id === t.id);
			const activity: Activity[] = [
				...of(active.results).map((m) => ({
					kind: m.state === "running" ? ("running" as const) : ("queued" as const),
					agent: m.to_id,
					conversationId: m.conversation_id,
					since: m.state === "running" ? m.started_at : m.created_at,
					messageId: m.id,
				})),
				...of(interrupted.results).map((m) => ({
					kind: "uncertain" as const,
					agent: m.to_id,
					conversationId: m.conversation_id,
					since: m.finished_at,
					messageId: m.id,
				})),
				...of(questions.results).map((q) => ({
					kind: "waitOwner" as const,
					agent: q.agent,
					conversationId: q.conversation_id,
					since: q.created_at,
					messageId: q.message_id,
					questionId: q.id,
				})),
				...links
					.filter((l) => l.task_id === t.id && l.kind === "work")
					.map((l) => work.get(l.ref))
					.filter((w) => w && (w.state === "active" || w.state === "creating"))
					.map((w) => ({
						kind: "work" as const,
						agent: w?.agent ?? "",
						conversationId: w?.conversation_id ?? null,
						since: w?.created_at ?? null,
						workId: w?.id,
					})),
			];
			const has = (k: Activity["kind"]) => activity.some((a) => a.kind === k);
			// The most serious first; the declared `done` stays, the contradiction is said.
			const contradiction =
				t.status !== "done"
					? null
					: has("running")
						? "done-with-running"
						: has("work")
							? "done-with-active-work"
							: has("queued")
								? "done-with-queued"
								: has("waitOwner")
									? "done-with-open-question"
									: null;
			const taskLimit = t.requests_limit ?? cfg.taskBudget;
			const goalLimit = t.budget_limit ?? cfg.goalBudget;
			out.set(t.id, {
				activity,
				contradiction,
				dependencies: links
					.filter((l) => l.task_id === t.id && l.kind === "dep")
					.map((l) => {
						const d = dep.get(Number(l.ref));
						return { taskId: Number(l.ref), title: d?.title ?? null, status: d?.status ?? null };
					}),
				previousRunActive:
					t.assignee === null
						? []
						: activity
								.filter((a) => a.kind === "running" && a.agent !== t.assignee)
								.map((a) => ({ messageId: a.messageId as number, agent: a.agent })),
				taskBudget: {
					used: t.requests_used,
					limit: taskLimit,
					exhausted: t.requests_used >= taskLimit,
				},
				budget:
					t.parent_id === null
						? { used: t.budget_used, limit: goalLimit, exhausted: t.budget_used >= goalLimit }
						: null,
			});
		}
		return out;
	}

	/**
	 * A request refused by a budget: recorded once per limit (until the person
	 * raises it, the next refusals add nothing), on the goal or on the task.
	 */
	async budgetExhausted(ownerUserId: string, actor: string, e: BudgetError): Promise<void> {
		const on = e.budget === "goal" ? e.goalId : e.taskId;
		const r = await d1Query<EventRow>(
			`INSERT INTO task_events (owner_user_id, task_id, actor, kind, data)
			 SELECT ?1, ?2, ?3, 'budget-exhausted', json_object('budget', ?4, 'limit', ?5, 'used', ?6, 'task', ?7)
			 WHERE NOT EXISTS (SELECT 1 FROM task_events e WHERE e.owner_user_id = ?1 AND e.task_id = ?2 AND e.kind = 'budget-exhausted'
				AND json_extract(e.data, '$.budget') = ?4 AND json_extract(e.data, '$.limit') = ?5)
			 RETURNING *`,
			[ownerUserId, on, actor, e.budget, e.limit, e.used, e.taskId],
		);
		const t = r.results[0] ? await this.row(ownerUserId, on) : null;
		if (t) this.publish(t);
	}

	/**
	 * POST /tasks/:id/budget {add, scope?} — the person only (the route checks):
	 * `goal` (a root's default) raises the goal's budget, `task` (a child's
	 * default) the task's own cap. Additive, so no version: it never makes an
	 * agent's pending write stale. The history trigger records it.
	 */
	async raiseBudget(ownerUserId: string, id: unknown, body: unknown) {
		const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
		const add = b.add;
		if (typeof add !== "number" || !Number.isInteger(add) || add < 1 || add > 10_000)
			throw new TaskError(400, "bad-add", { min: 1, max: 10_000 });
		const t = await this.mustSee(ownerUserId, { kind: "owner" }, id);
		const scope = b.scope === undefined ? (t.parent_id === null ? "goal" : "task") : b.scope;
		if (scope !== "goal" && scope !== "task") throw new TaskError(400, "bad-scope");
		if (scope === "goal" && t.parent_id !== null)
			throw new TaskError(400, "not-a-root", { rootId: t.parent_id });
		const col = scope === "goal" ? "budget_limit" : "requests_limit";
		const r = await d1Query<TaskRow>(
			`UPDATE tasks SET ${col} = COALESCE(${col}, ?) + ?, updated_at = ${NOW}, updated_by = 'owner'
			 WHERE id = ? AND owner_user_id = ? RETURNING *`,
			[
				scope === "goal" ? this.acp.config.goalBudget : this.acp.config.taskBudget,
				add,
				t.id,
				ownerUserId,
			],
		);
		const row = r.results[0];
		if (!row) throw new TaskError(404, "task-not-found");
		this.publish(row);
		return this.view(ownerUserId, row);
	}

	/** The project a board read is about (`projectId` or `project`): an agent's own, or one of the person's. */
	private async projectOf(ownerUserId: string, actor: TaskActor, want: unknown): Promise<string> {
		noProject(actor);
		if (actor.kind === "agent") {
			const own = actor.agent.project_id as string;
			if (want !== undefined && want !== own) throw new TaskError(404, "project-not-found");
			return own;
		}
		if (typeof want !== "string" || !(await this.acp.ownsProject(ownerUserId, want)))
			throw new TaskError(404, "project-not-found");
		return want;
	}

	/** 409 `stale`: the whole current row (as a read shows it) and its last event — who changed what. */
	private async staleOrGone(ownerUserId: string, id: number): Promise<TaskError> {
		const now = await this.row(ownerUserId, id);
		if (!now) return new TaskError(404, "task-not-found");
		const [task, last] = await Promise.all([
			this.view(ownerUserId, now),
			d1Query<EventRow>(
				"SELECT * FROM task_events WHERE owner_user_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1",
				[ownerUserId, id],
			),
		]);
		return new TaskError(409, "stale", {
			task,
			lastEvent: last.results[0] ? eventView(last.results[0]) : null,
		});
	}

	/**
	 * GET /tasks/summary — the rail's counters for a project, one statement by
	 * the open-tasks index: open, blocked, and awaiting the person (in review
	 * with no reviewer: only the person can approve it). The `task` event of
	 * /ws/acp carries the changed task, so a client keeps them without rereading.
	 */
	async summary(
		ownerUserId: string,
		actor: TaskActor,
		q: { projectId?: unknown; project?: unknown },
	) {
		const projectId = await this.projectOf(ownerUserId, actor, q.projectId ?? q.project);
		const r = await d1Query<{ open: number; blocked: number | null; awaiting: number | null }>(
			`SELECT COUNT(*) AS open, SUM(blocked_reason IS NOT NULL) AS blocked,
				SUM(status = 'review' AND reviewer IS NULL) AS awaiting
			 FROM tasks WHERE owner_user_id = ? AND project_id = ? AND status != 'done'`,
			[ownerUserId, projectId],
		);
		const x = r.results[0];
		return {
			projectId,
			open: Number(x?.open ?? 0),
			blocked: Number(x?.blocked ?? 0),
			awaitingOwner: Number(x?.awaiting ?? 0),
		};
	}
}
