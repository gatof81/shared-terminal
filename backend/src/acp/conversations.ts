/**
 * acp/conversations.ts — conversations (v27): the topics of a project. The
 * project's agents are a shared team: any of them takes part in any topic by
 * being addressed — there is no membership. A conversation holds the person's
 * messages posted in it and everything they set off (consults, replies,
 * questions, recovery reports: acp/agents.ts copies `conversation_id` along).
 *
 * Owner-only; a foreign or missing conversation is the same 404. A creation is
 * idempotent by the client's `clientRequestId`, like a project's
 * (projects/directory.ts): a retry never creates a second topic, and an answer
 * that does not prove the outcome is resolved by reading the record back.
 *
 * READ STATE is a time, not a message id. The result of a person's message is
 * written on that same row when the agent finishes (`finished_at`), long after
 * its id was shown: an id marker would count it as seen the moment the person
 * sent it. So a row's "event time" is its `finished_at` for a person's message
 * that ended `done` with a result, its `created_at` for anything else, and
 * `read_at` is the newest event time the person's client has shown. It only
 * advances, and only on an explicit POST from the client — never on an event.
 */

import { createHash, randomUUID } from "node:crypto";
import { d1Query } from "../db.js";
import { logger } from "../logger.js";
import { isD1Envelope } from "../projects/directory.js";
import type { AcpAgents, MessageRow, QuestionRow } from "./agents.js";

export const TITLE_MAX = 120;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The shape every time column has (strftime '%Y-%m-%dT%H:%M:%fZ').
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching controls is the point
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/** Rows of each inbox section at most (the counter is the length of the first). */
const INBOX_MAX = 200;

/**
 * "Unseen" for a message row `m` of conversation `c` (see the header) is two
 * disjoint cases (by `from_id`), each written with its time range first so it
 * reads by the v28 indexes from `read_at` on — a topic already read reads ≈ 0
 * rows, not its whole history (D1 bills rows read; these run on every change).
 */
const UNSEEN_OTHERS = `m.created_at > COALESCE(c.read_at, '') AND m.from_id != 'owner'`;
const UNSEEN_RESULT = `m.finished_at > COALESCE(c.read_at, '') AND m.from_id = 'owner' AND m.state = 'done' AND m.result_text IS NOT NULL`;
const UNREAD = `(SELECT COUNT(*) FROM agent_messages m WHERE m.owner_user_id = c.owner_user_id AND m.conversation_id = c.id AND ${UNSEEN_OTHERS})
	+ (SELECT COUNT(*) FROM agent_messages m WHERE m.owner_user_id = c.owner_user_id AND m.conversation_id = c.id AND ${UNSEEN_RESULT})`;
// CROSS JOIN fixes SQLite's join order: from the few open questions (v28
// index) to their message, never from every message of the topic to its questions.
const NEEDS_ACTION = `(EXISTS (SELECT 1 FROM agent_messages m WHERE m.owner_user_id = c.owner_user_id AND m.conversation_id = c.id
		AND m.state = 'uncertain' AND m.reviewed_at IS NULL)
	OR EXISTS (SELECT 1 FROM agent_questions q CROSS JOIN agent_messages m ON m.id = q.message_id AND m.owner_user_id = q.owner_user_id
		WHERE q.owner_user_id = c.owner_user_id AND q.state = 'open' AND m.conversation_id = c.id))`;
const SUMMARY = `c.*,
	${UNREAD} AS unread,
	${NEEDS_ACTION} AS needs_action`;

export class ConversationError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail: Record<string, unknown> = {},
	) {
		super(code);
	}
}

export interface ConversationRow {
	id: string;
	owner_user_id: string;
	project_id: string;
	title: string;
	client_request_id: string;
	request_hash: string;
	created_at: string;
	last_activity_at: string;
	archived_at: string | null;
	read_at: string | null;
	recipients: string | null;
}

/**
 * Why a topic cannot be deleted yet (409 `in-use`): something of it is still
 * being worked on, or waits for the person, or names it.
 */
export type InUseReason = "message-active" | "question-open" | "work-open" | "task-open";

/**
 * DEFINITIVE DELETION (#13) of an archived topic or of the Archive. One rule
 * for both: nothing still in course is touched. A topic is all or nothing
 * (409 `in-use` with the reasons); the Archive keeps what is in course and
 * deletes the rest.
 *
 * Every statement carries its own guard — a previous read only gives the
 * reasons, it does not protect: a requeue or a runner's write may land
 * between two calls (D1 over HTTP has no transaction across them). Order is
 * questions → messages → the topic's row, LAST: the row is what a retry needs
 * to find the topic again, and it goes only once no message names it; a
 * failure half way leaves a state the same verb finishes.
 *
 * What stays and may name what is gone (every read tolerates it): tasks
 * (`conversation_id`, `origin_message_id`) and their events and links, the
 * works (`conversation_id`), counters and budgets; in the Archive, a reply
 * or recovery report of another scope whose request was deleted.
 */
const topicFree = (owner: string, id: string, projectId: string) => ({
	sql: `EXISTS (SELECT 1 FROM conversations c0 WHERE c0.id = ? AND c0.owner_user_id = ? AND c0.archived_at IS NOT NULL)
		AND NOT EXISTS (SELECT 1 FROM agent_messages a WHERE a.owner_user_id = ? AND a.conversation_id = ?
			AND a.state IN ('pending', 'running'))
		AND NOT EXISTS (SELECT 1 FROM agent_questions q CROSS JOIN agent_messages a ON a.id = q.message_id AND a.owner_user_id = q.owner_user_id
			WHERE q.owner_user_id = ? AND q.state IN ('open', 'answered') AND a.conversation_id = ?)
		AND NOT EXISTS (SELECT 1 FROM agent_works w WHERE w.owner_user_id = ? AND w.conversation_id = ? AND w.state != 'cleaned')
		AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.owner_user_id = ? AND t.project_id = ? AND t.status != 'done'
			AND t.conversation_id = ?)`,
	params: [id, owner, owner, id, owner, id, owner, id, owner, projectId, id],
});

/**
 * The Archive keeps a whole CHAIN (a person's message and every consult,
 * reply and report under it: `COALESCE(root_id, id)`) while any of it is in
 * course: deleting its finished requests would lower the round budget
 * (`chainRequests`) of a chain still running, and leave its pending reply
 * without its request. Both sets are read once (uncorrelated), by the
 * running and open-question indexes.
 */
const CHAIN_FREE = `COALESCE(m.root_id, m.id) NOT IN (SELECT COALESCE(a.root_id, a.id) FROM agent_messages a
		WHERE a.state IN ('pending', 'running') AND a.owner_user_id = ?)
	AND COALESCE(m.root_id, m.id) NOT IN (SELECT COALESCE(a.root_id, a.id)
		FROM agent_questions q CROSS JOIN agent_messages a ON a.id = q.message_id AND a.owner_user_id = q.owner_user_id
		WHERE q.owner_user_id = ? AND q.state IN ('open', 'answered'))`;

/** Which part of the Archive: a project's previous Project Chat, or an agent's direct messages. */
export type ArchiveScope = { projectId: string } | { agent: string };

// `+col IS NULL` keeps the planner off the `(owner, conversation_id …)`
// indexes, where NULL is the WHOLE Archive of the owner: each scope is read
// by its own index (the project's, an agent's to/from).
const archiveScope = (owner: string, s: ArchiveScope) =>
	"projectId" in s
		? {
				sql: "m.owner_user_id = ? AND m.project_id = ? AND +m.conversation_id IS NULL",
				params: [owner, s.projectId],
			}
		: {
				// Its individual chat's history: direct messages to it and from it
				// (with the person and with other agents), each side by its index.
				sql: `m.id IN (
					SELECT id FROM agent_messages WHERE owner_user_id = ? AND to_id = ? AND +project_id IS NULL AND +conversation_id IS NULL
					UNION SELECT id FROM agent_messages WHERE owner_user_id = ? AND from_id = ? AND +project_id IS NULL AND +conversation_id IS NULL)`,
				params: [owner, s.agent, owner, s.agent],
			};

type SummaryRow = ConversationRow & { unread?: number; needs_action?: number };

/** `{"agents":[…]}` or `{"team":true}`: who the person's last post in the topic went to. */
export type Recipients = { agents: string[] } | { team: true };

/** What the API and /ws/acp show of a conversation. */
export function conversationView(c: SummaryRow) {
	let recipients: Recipients | null = null;
	try {
		recipients = c.recipients ? (JSON.parse(c.recipients) as Recipients) : null;
	} catch {
		recipients = null;
	}
	return {
		id: c.id,
		projectId: c.project_id,
		title: c.title,
		createdAt: c.created_at,
		lastActivityAt: c.last_activity_at,
		archivedAt: c.archived_at,
		readAt: c.read_at,
		recipients,
		...(c.unread === undefined ? {} : { unread: Number(c.unread) }),
		...(c.needs_action === undefined ? {} : { needsAction: Boolean(c.needs_action) }),
	};
}

function cleanTitle(v: unknown): string {
	if (typeof v !== "string") throw new ConversationError(400, "invalid-title");
	const t = v.normalize("NFC").trim();
	if (t.length === 0 || [...t].length > TITLE_MAX || UNSAFE_TEXT_RE.test(t))
		throw new ConversationError(400, "invalid-title");
	return t;
}

export class AcpConversations {
	constructor(private readonly acp: AcpAgents) {}

	private publish(row: SummaryRow | null | undefined): void {
		if (row)
			this.acp.emit(row.owner_user_id, {
				type: "conversation",
				conversation: conversationView(row),
			});
	}

	/** One of the owner's conversations, with its project still live; archived ones included. */
	async get(ownerUserId: string, id: string): Promise<ConversationRow | null> {
		if (!UUID_V4_RE.test(id)) return null;
		const r = await d1Query<ConversationRow>(
			`SELECT c.* FROM conversations c JOIN projects p ON p.project_id = c.project_id
			 WHERE c.id = ? AND c.owner_user_id = ? AND p.owner_user_id = c.owner_user_id AND p.archived_at IS NULL`,
			[id, ownerUserId],
		);
		return r.results[0] ?? null;
	}

	/** The conversation with its `unread` and `needsAction`. */
	async summary(ownerUserId: string, id: string): Promise<SummaryRow | null> {
		const r = await d1Query<SummaryRow>(
			`SELECT ${SUMMARY} FROM conversations c WHERE c.id = ? AND c.owner_user_id = ?`,
			[id, ownerUserId],
		);
		return r.results[0] ?? null;
	}

	async create(
		ownerUserId: string,
		body: unknown,
	): Promise<{ row: SummaryRow; replayed: boolean }> {
		const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
		const crid = b.clientRequestId;
		if (typeof crid !== "string" || !UUID_V4_RE.test(crid))
			throw new ConversationError(400, "invalid-client-request-id");
		const title = cleanTitle(b.title);
		const projectId = b.projectId;
		if (typeof projectId !== "string" || !(await this.acp.ownsProject(ownerUserId, projectId)))
			throw new ConversationError(404, "project-not-found");
		const hash = createHash("sha256")
			.update(JSON.stringify([projectId, title]))
			.digest("hex");
		const readBack = async () => {
			const r = await d1Query<ConversationRow>(
				"SELECT * FROM conversations WHERE owner_user_id = ? AND client_request_id = ?",
				[ownerUserId, crid],
			);
			const row = r.results[0];
			if (!row) return null;
			if (row.request_hash !== hash) throw new ConversationError(409, "idempotency-conflict");
			return { row: (await this.summary(ownerUserId, row.id)) ?? row, replayed: true };
		};
		let inserted: ConversationRow | undefined;
		try {
			const r = await d1Query<ConversationRow>(
				`INSERT INTO conversations (id, owner_user_id, project_id, title, client_request_id, request_hash)
				 VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`,
				[randomUUID(), ownerUserId, projectId, title, crid, hash],
			);
			inserted = r.results[0];
		} catch (err) {
			// Only a refusal D1 itself answered is definite; anything else is resolved by the record.
			const earlier = await readBack().catch((e) => {
				if (e instanceof ConversationError) throw e;
				return null;
			});
			if (earlier) return earlier;
			if (isD1Envelope(err)) throw err;
			logger.warn(`[acp] conversation create outcome unknown: ${(err as Error).message}`);
			throw new ConversationError(503, "outcome-unknown");
		}
		if (inserted) {
			const row = { ...inserted, unread: 0, needs_action: 0 };
			this.publish(row);
			return { row, replayed: false };
		}
		const earlier = await readBack();
		if (!earlier) throw new ConversationError(503, "outcome-unknown");
		return earlier;
	}

	/** A project's conversations, most recently active first; archived ones only when asked. */
	async list(ownerUserId: string, projectId: string, archived: boolean): Promise<SummaryRow[]> {
		const r = await d1Query<SummaryRow>(
			`SELECT ${SUMMARY} FROM conversations c
			 WHERE c.owner_user_id = ? AND c.project_id = ? AND (c.archived_at IS NULL) != ?
			 ORDER BY c.last_activity_at DESC, c.id`,
			[ownerUserId, projectId, archived ? 1 : 0],
		);
		return r.results;
	}

	async rename(ownerUserId: string, id: string, body: unknown): Promise<SummaryRow> {
		const title = cleanTitle((body as { title?: unknown } | null)?.title);
		if (!UUID_V4_RE.test(id)) throw new ConversationError(404, "conversation-not-found");
		const r = await d1Query<ConversationRow>(
			"UPDATE conversations SET title = ? WHERE id = ? AND owner_user_id = ? RETURNING *",
			[title, id, ownerUserId],
		);
		if (!r.results[0]) throw new ConversationError(404, "conversation-not-found");
		return this.changed(ownerUserId, id);
	}

	/** Archive: leaves the list, takes no new post from the person; its history stays. Idempotent. */
	async archive(ownerUserId: string, id: string): Promise<SummaryRow> {
		if (!UUID_V4_RE.test(id)) throw new ConversationError(404, "conversation-not-found");
		const r = await d1Query<ConversationRow>(
			`UPDATE conversations SET archived_at = COALESCE(archived_at, ${NOW}) WHERE id = ? AND owner_user_id = ? RETURNING *`,
			[id, ownerUserId],
		);
		if (!r.results[0]) throw new ConversationError(404, "conversation-not-found");
		return this.changed(ownerUserId, id);
	}

	/** What keeps an archived topic from being deleted now (empty: nothing). */
	async inUse(ownerUserId: string, c: ConversationRow): Promise<InUseReason[]> {
		const r = await d1Query<Record<InUseReason, number>>(
			`SELECT
				EXISTS (SELECT 1 FROM agent_messages a WHERE a.owner_user_id = ? AND a.conversation_id = ?
					AND a.state IN ('pending', 'running')) AS "message-active",
				EXISTS (SELECT 1 FROM agent_questions q CROSS JOIN agent_messages a ON a.id = q.message_id AND a.owner_user_id = q.owner_user_id
					WHERE q.owner_user_id = ? AND q.state IN ('open', 'answered') AND a.conversation_id = ?) AS "question-open",
				EXISTS (SELECT 1 FROM agent_works w WHERE w.owner_user_id = ? AND w.conversation_id = ? AND w.state != 'cleaned') AS "work-open",
				EXISTS (SELECT 1 FROM tasks t WHERE t.owner_user_id = ? AND t.project_id = ? AND t.status != 'done'
					AND t.conversation_id = ?) AS "task-open"`,
			[ownerUserId, c.id, ownerUserId, c.id, ownerUserId, c.id, ownerUserId, c.project_id, c.id],
		);
		const row = r.results[0];
		const all: InUseReason[] = ["message-active", "question-open", "work-open", "task-open"];
		return row ? all.filter((k) => Number(row[k]) === 1) : [];
	}

	/**
	 * Deletes an archived topic for good (see `topicFree`): 404 foreign or
	 * missing, 409 `not-archived`, 409 `in-use` with its reasons.
	 */
	async remove(ownerUserId: string, id: string): Promise<void> {
		const c = await this.get(ownerUserId, id);
		if (!c) throw new ConversationError(404, "conversation-not-found");
		if (!c.archived_at) throw new ConversationError(409, "not-archived");
		const busy = await this.inUse(ownerUserId, c);
		if (busy.length) throw new ConversationError(409, "in-use", { reasons: busy });
		const free = topicFree(ownerUserId, c.id, c.project_id);
		await d1Query(
			`DELETE FROM agent_questions WHERE owner_user_id = ?
			 AND message_id IN (SELECT id FROM agent_messages WHERE owner_user_id = ? AND conversation_id = ?) AND ${free.sql}`,
			[ownerUserId, ownerUserId, c.id, ...free.params],
		);
		await d1Query(
			`DELETE FROM agent_messages WHERE owner_user_id = ? AND conversation_id = ? AND ${free.sql}`,
			[ownerUserId, c.id, ...free.params],
		);
		const r = await d1Query<{ id: string }>(
			`DELETE FROM conversations WHERE id = ? AND owner_user_id = ?
			 AND NOT EXISTS (SELECT 1 FROM agent_messages x WHERE x.owner_user_id = ? AND x.conversation_id = ?)
			 AND ${free.sql} RETURNING id`,
			[c.id, ownerUserId, ownerUserId, c.id, ...free.params],
		);
		if (!r.results[0]) {
			// Something started between the read and the statements: the guards held.
			const reasons = await this.inUse(ownerUserId, c);
			throw new ConversationError(409, "in-use", { reasons });
		}
		this.acp.emit(ownerUserId, { type: "deleted", conversationId: c.id, projectId: c.project_id });
	}

	/**
	 * Empties one part of the Archive (`ArchiveScope`), keeping every chain
	 * still in course (`CHAIN_FREE`). Questions first, then messages: a retry
	 * after a failure between them finishes it.
	 */
	async emptyArchive(
		ownerUserId: string,
		scope: ArchiveScope,
	): Promise<{ deleted: number; kept: number }> {
		const s = archiveScope(ownerUserId, scope);
		await d1Query(
			`DELETE FROM agent_questions WHERE owner_user_id = ?
			 AND message_id IN (SELECT m.id FROM agent_messages m WHERE ${s.sql} AND ${CHAIN_FREE})`,
			[ownerUserId, ...s.params, ownerUserId, ownerUserId],
		);
		const d = await d1Query(`DELETE FROM agent_messages AS m WHERE ${s.sql} AND ${CHAIN_FREE}`, [
			...s.params,
			ownerUserId,
			ownerUserId,
		]);
		const k = await d1Query<{ n: number }>(
			`SELECT COUNT(*) AS n FROM agent_messages m WHERE ${s.sql}`,
			s.params,
		);
		this.acp.emit(ownerUserId, { type: "deleted", ...scope });
		return { deleted: Number(d.meta?.changes ?? 0), kept: Number(k.results[0]?.n ?? 0) };
	}

	/**
	 * The client showed everything up to `at` (the newest event time on screen).
	 * Only advances; a time past now is taken as now.
	 */
	async read(ownerUserId: string, id: string, at: unknown): Promise<SummaryRow> {
		if (typeof at !== "string" || !ISO_MS_RE.test(at) || Number.isNaN(Date.parse(at)))
			throw new ConversationError(400, "invalid-at");
		if (!UUID_V4_RE.test(id)) throw new ConversationError(404, "conversation-not-found");
		const r = await d1Query<ConversationRow>(
			`UPDATE conversations SET read_at = MAX(COALESCE(read_at, ''), MIN(?, ${NOW}))
			 WHERE id = ? AND owner_user_id = ? RETURNING *`,
			[at, id, ownerUserId],
		);
		if (!r.results[0]) throw new ConversationError(404, "conversation-not-found");
		return this.changed(ownerUserId, id);
	}

	/** Who the person's last post in the topic went to (shown again as the next post's). */
	async setRecipients(ownerUserId: string, id: string, recipients: Recipients): Promise<void> {
		await d1Query("UPDATE conversations SET recipients = ? WHERE id = ? AND owner_user_id = ?", [
			JSON.stringify(recipients),
			id,
			ownerUserId,
		]);
		this.publish(await this.summary(ownerUserId, id));
	}

	private async changed(ownerUserId: string, id: string): Promise<SummaryRow> {
		const row = await this.summary(ownerUserId, id);
		if (!row) throw new ConversationError(404, "conversation-not-found");
		this.publish(row);
		return row;
	}

	/**
	 * The global inbox. `action` (the counter): every open question and every
	 * `uncertain` run not reviewed, of every project — and of the Archive, a
	 * run interrupted there is no less interrupted. `results`: the agents'
	 * results to the person's messages, in a live conversation, not seen yet.
	 * `reports`: the runner's recovery report of each interrupted run listed.
	 * Each row carries its conversation and project for navigation.
	 */
	async inbox(ownerUserId: string) {
		const [questions, interrupted, results] = await Promise.all([
			d1Query<QuestionRow & { conversation_id: string | null; project_id: string | null }>(
				`SELECT q.*, m.conversation_id AS conversation_id, m.project_id AS project_id
				 FROM agent_questions q LEFT JOIN agent_messages m ON m.id = q.message_id AND m.owner_user_id = q.owner_user_id
				 WHERE q.owner_user_id = ? AND q.state = 'open' ORDER BY q.id LIMIT ?`,
				[ownerUserId, INBOX_MAX],
			),
			d1Query<MessageRow>(
				`SELECT * FROM agent_messages WHERE owner_user_id = ? AND state = 'uncertain' AND reviewed_at IS NULL
				 ORDER BY id LIMIT ?`,
				[ownerUserId, INBOX_MAX],
			),
			d1Query<MessageRow>(
				// From the live conversations, each by its result-time range (the
				// other case of "unseen" cannot be a message of the person's).
				// CROSS JOIN is SQLite's way to fix that order: never all the
				// owner's messages first.
				`SELECT m.* FROM conversations c CROSS JOIN agent_messages m
				 WHERE c.owner_user_id = ? AND c.archived_at IS NULL
				 AND m.owner_user_id = c.owner_user_id AND m.conversation_id = c.id AND ${UNSEEN_RESULT}
				 ORDER BY m.finished_at, m.id LIMIT ?`,
				[ownerUserId, INBOX_MAX],
			),
		]);
		const ids = interrupted.results.map((m) => m.id);
		const reports = ids.length
			? (
					await d1Query<MessageRow>(
						`SELECT * FROM agent_messages WHERE owner_user_id = ? AND recovery_of IN (SELECT value FROM json_each(?))
						 ORDER BY id`,
						[ownerUserId, JSON.stringify(ids)],
					)
				).results
			: [];
		return {
			count: questions.results.length + interrupted.results.length,
			action: { questions: questions.results, interrupted: interrupted.results },
			results: results.results,
			reports,
		};
	}
}
