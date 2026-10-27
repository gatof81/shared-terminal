/**
 * recreate/d1.ts — the recreation's D1 surface (CONVERSATION.md §2.7.2).
 *
 * The commit is ONE statement: `container_id` and the authorized hash
 * change together, so there is no observable instant with
 * `container_id = N` and a hash other than N's. It only applies while the
 * row still names O and capture is still requested — a disable that
 * flipped `conversation_requested` to 0 meanwhile is never overwritten,
 * even by a commit that lands late.
 */

import { D1StatementError, d1Query } from "../db.js";
import { mappingsFromConfig, setPortMappings } from "../portMappings.js";
import { getSessionConfig } from "../sessionConfig.js";

export interface RecreateSessionRow {
	status: string;
	container_id: string | null;
	container_name: string;
	conversation_requested: number;
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
	cas(sessionId: string, oId: string, nId: string, hash: string): Promise<CasResult>;
	getConfig(sessionId: string): Promise<RecreateSessionConfig>;
	setStatus(sessionId: string, status: "running" | "stopped"): Promise<void>;
	/** Several statements: `mayAct` is asked before each, none is issued once it says no. */
	setPorts(
		sessionId: string,
		ports: RecreateSessionConfig["ports"],
		mayAct: () => boolean,
	): Promise<void>;
}

export const d1RecreatePort: RecreateD1Port = {
	async getRow(sessionId) {
		const r = await d1Query<RecreateSessionRow>(
			"SELECT status, container_id, container_name, conversation_requested FROM sessions WHERE session_id = ?",
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
	async cas(sessionId, oId, nId, hash) {
		try {
			const r = await d1Query(
				"UPDATE sessions SET container_id = ?, ingest_token_hash = ?, ingest_token_hash_suspended = NULL WHERE session_id = ? AND container_id = ? AND conversation_requested = 1",
				[nId, hash, sessionId, oId],
			);
			return r.meta.changes === 1 ? "applied" : "not-applied";
		} catch (err) {
			// Only an answer that says "failed" proves the statement did
			// not run. A timeout or a lost connection may have applied it.
			return err instanceof D1StatementError ? "not-applied" : "ambiguous";
		}
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
