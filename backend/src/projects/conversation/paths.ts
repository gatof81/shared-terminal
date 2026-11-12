/**
 * projects/conversation/paths.ts — where the project conversation lives on
 * the host (docs/PROJECT_CONVERSATION.md §2, §8). Shared by the store and by
 * backup/restore, so both agree on names the other must never open.
 */

import path from "node:path";

export const PROJECTS_DIR = ".projects";
export const WRITER_LOCK_FILE = ".writer.lock";
export const RESTORE_JOURNAL_DIR = ".restore-journal";
export const RESTORE_STAGING_DIR = ".restore-staging";
export const RESTORE_REPLACED_DIR = ".restore-replaced";
export const RESTORED_MARKER = "RESTORED";
export const ARTIFACTS_DIR = "artifacts";

/** Project ids are `randomUUID()` (projects/directory.ts): lowercase. */
export const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function projectsRoot(workspaceRoot: string): string {
	return path.join(workspaceRoot, PROJECTS_DIR);
}

export function projectDir(workspaceRoot: string, pid: string): string {
	if (!PROJECT_ID_RE.test(pid)) throw new Error(`invalid project id ${JSON.stringify(pid)}`);
	return path.join(projectsRoot(workspaceRoot), pid);
}

export function writerLockPath(workspaceRoot: string): string {
	return path.join(projectsRoot(workspaceRoot), WRITER_LOCK_FILE);
}

/** An OPEN journal (§8 step 0); a closed one is renamed `<pid>.<restore_id>.done`. */
export function restoreJournalPath(workspaceRoot: string, pid: string): string {
	return path.join(projectsRoot(workspaceRoot), RESTORE_JOURNAL_DIR, `${pid}.json`);
}
