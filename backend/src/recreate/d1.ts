/**
 * recreate/d1.ts — the recreation's D1 surface (CONVERSATION.md §2.7.2).
 *
 * The commit is ONE statement: `container_id` and the authorized hash
 * change together, so there is no observable instant with
 * `container_id = N` and a hash other than N's. It only applies while the
 * row still names O and capture is still requested — a disable that
 * flipped `conversation_requested` to 0 meanwhile is never overwritten,
 * even by a commit that lands late.
 *
 * The fence (v1.9.4, #627): both commit statements also require
 * `recreate_fence` to still be the generation the attempt recorded in its
 * durable record BEFORE sending them, and bump it when they apply. A
 * recovery that finds D1 still on O after a commit that may have been sent
 * cannot know whether that statement is still in flight — the process that
 * would have received its answer is gone, and nothing may be inferred from
 * elapsed time (D8). So it bumps the generation itself (`fence`) and
 * proves the bump by re-reading the row: from then on the in-flight
 * statement's guard can no longer match, whichever order D1 runs the two
 * in. If the commit won the race, the re-read shows it (`container_id`
 * moved) and the resolution converges on that container instead of
 * removing it.
 */

import { D1StatementError, d1Query } from "../db.js";
import { mappingsFromConfig, setPortMappings } from "../portMappings.js";
import { getSessionConfig } from "../sessionConfig.js";

export interface RecreateSessionRow {
	status: string;
	container_id: string | null;
	container_name: string;
	conversation_requested: number;
	/** The commit fence's current generation (migration v20). */
	recreate_fence: number;
}

export type CasResult = "applied" | "not-applied" | "ambiguous";

export interface RecreateSessionConfig {
	ports: ReadonlyArray<{ container: number; public: boolean }>;
	gitIdentity: { name: string; email: string } | null;
	hasDotfiles: boolean;
	postStartCmd: string | null;
}

export interface RecreateD1Port {
	getRow(sessionId: string): Promise<RecreateSessionRow | null>;
	/** The session whose canonical container name this is, if any. */
	sessionIdByContainerName(name: string): Promise<string | null>;
	/** Applies only while the row still carries generation `fence`; bumps it when it does. */
	cas(sessionId: string, oId: string, nId: string, hash: string, fence: number): Promise<CasResult>;
	/**
	 * The reverse of `cas` for a post-commit rollback (§2.7.7): back to the
	 * retained container, which has no ingest token (it predates the relay),
	 * so the hash goes with it. Applies only while the row still names the
	 * container being rolled back and carries generation `fence`.
	 */
	casBack(sessionId: string, fromId: string, toId: string, fence: number): Promise<CasResult>;
	/**
	 * Invalidates generation `fence`: one statement, applied only while the
	 * row still carries it. Its answer is never the proof on its own — the
	 * caller re-reads the row and requires `recreate_fence > fence` (an
	 * ambiguous bump may or may not have landed; a 0-row bump means the
	 * generation had already moved, possibly by the commit itself).
	 */
	fence(sessionId: string, fence: number): Promise<CasResult>;
	getConfig(sessionId: string): Promise<RecreateSessionConfig>;
	setStatus(sessionId: string, status: "running" | "stopped"): Promise<void>;
	/** Several statements: `mayAct` is asked before each, none is issued once it says no. */
	setPorts(
		sessionId: string,
		ports: RecreateSessionConfig["ports"],
		mayAct: () => boolean,
	): Promise<void>;
}

async function classified(sql: string, params: unknown[]): Promise<CasResult> {
	try {
		const r = await d1Query(sql, params);
		return r.meta.changes === 1 ? "applied" : "not-applied";
	} catch (err) {
		// Only an answer that says "failed" proves the statement did
		// not run. A timeout or a lost connection may have applied it.
		return err instanceof D1StatementError ? "not-applied" : "ambiguous";
	}
}

export const d1RecreatePort: RecreateD1Port = {
	async getRow(sessionId) {
		const r = await d1Query<RecreateSessionRow>(
			"SELECT status, container_id, container_name, conversation_requested, recreate_fence FROM sessions WHERE session_id = ?",
			[sessionId],
		);
		return r.results[0] ?? null;
	},
	async sessionIdByContainerName(name) {
		const r = await d1Query<{ session_id: string }>(
			"SELECT session_id FROM sessions WHERE container_name = ?",
			[name],
		);
		return r.results[0]?.session_id ?? null;
	},
	async cas(sessionId, oId, nId, hash, fence) {
		return classified(
			// The bump in the same statement: a commit that applied has
			// consumed its generation, so a recovery's fence finds it moved
			// (0 rows) and its re-read proves it — and sees N.
			"UPDATE sessions SET container_id = ?, ingest_token_hash = ?, ingest_token_hash_suspended = NULL, recreate_fence = recreate_fence + 1 WHERE session_id = ? AND container_id = ? AND conversation_requested = 1 AND recreate_fence = ?",
			[nId, hash, sessionId, oId, fence],
		);
	},
	async casBack(sessionId, fromId, toId, fence) {
		return classified(
			"UPDATE sessions SET container_id = ?, ingest_token_hash = NULL, ingest_token_hash_suspended = NULL, recreate_fence = recreate_fence + 1 WHERE session_id = ? AND container_id = ? AND recreate_fence = ?",
			[toId, sessionId, fromId, fence],
		);
	},
	async fence(sessionId, fence) {
		return classified(
			"UPDATE sessions SET recreate_fence = recreate_fence + 1 WHERE session_id = ? AND recreate_fence = ?",
			[sessionId, fence],
		);
	},
	async getConfig(sessionId) {
		const c = await getSessionConfig(sessionId);
		return {
			ports: c?.ports ?? [],
			gitIdentity: c?.gitIdentity ?? null,
			hasDotfiles: !!c?.dotfiles,
			postStartCmd: c?.postStartCmd ?? null,
		};
	},
	async setStatus(sessionId, status) {
		await d1Query("UPDATE sessions SET status = ? WHERE session_id = ?", [status, sessionId]);
	},
	async setPorts(sessionId, ports, mayAct) {
		await setPortMappings(sessionId, mappingsFromConfig(ports), mayAct);
	},
};
