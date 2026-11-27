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
