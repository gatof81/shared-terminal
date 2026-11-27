/**
 * routes/workRoot.ts — the `?work=<id>` parameter of the Files and Git
 * routes: run the operation on that work's worktree
 * (`<workspace>/.st/ctx/<id>`, acp/works.ts) instead of the workspace.
 *
 * `.st/` stays restricted (`isRestrictedPath`); this is not an exception
 * to the denylist but a different ROOT: the backend builds the path from
 * a work it has proved belongs here, and every containment check then
 * runs against that root (workspaceFiles.ts `canonicalRoot`, gitReadOnly
 * `exactRoot`). The client never sends a path to the worktree.
 *
 * A work is usable when ALL of these hold, else the answer is the same
 * 404 as a missing or foreign session (no oracle for another owner's or
 * another agent's works):
 *   - the session is the caller's (the route's `assertOwnedByOr404`, run
 *     before this);
 *   - `agent_works` has `<id>` for this owner, and its agent is the agent
 *     of THIS session (a work of another agent of the same owner lives in
 *     another container and another workspace);
 *   - its state is not `cleaned` (the worktree was removed), and a
 *     `creating` one counts only once its worktree exists;
 *   - its root is a real directory exactly at `.st/ctx/<id>` (no symlink
 *     anywhere on the way — checked for every state).
 */

import { WORK_ID_RE, type WorkRow, workView } from "../acp/works.js";
import { d1Query } from "../db.js";
import { NotFoundError } from "../sessionManager.js";
import { workRootExists } from "../workspaceFiles.js";

export type WorkRef = { id: string; view: ReturnType<typeof workView> };

/**
 * `undefined` when the request carries no `work` (the workspace, exactly
 * as before); the work when it is usable; throws NotFoundError otherwise.
 */
export async function resolveWorkParam(
	raw: unknown,
	sessionId: string,
	userId: string,
): Promise<WorkRef | undefined> {
	if (raw === undefined) return undefined;
	// A repeated param (array) or a malformed id can't name a work.
	if (typeof raw !== "string" || !WORK_ID_RE.test(raw)) throw new NotFoundError();
	const r = await d1Query<WorkRow & { agent: string }>(
		`SELECT w.*, a.name AS agent FROM agent_works w
		 JOIN acp_agents a ON a.agent_id = w.agent_id
		 WHERE w.owner_user_id = ? AND w.id = ? AND a.session_id = ? AND a.owner_user_id = w.owner_user_id
			AND w.state != 'cleaned'`,
		[userId, raw, sessionId],
	);
	const row = r.results[0];
	if (!row || !(await workRootExists(sessionId, row.id))) throw new NotFoundError();
	return { id: row.id, view: workView(row) };
}
