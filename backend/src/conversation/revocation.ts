/**
 * conversation/revocation.ts — docs/CONVERSATION.md §2.5: the on-disk
 * revocation marker that lets a SEPARATE PROCESS (the emergency CLI)
 * cut ingest off without being able to touch the receiver's in-memory
 * token cache.
 *
 * Two markers:
 *   <WORKSPACE_ROOT>/.conversations/<st_session_id>/REVOKED   per session
 *   <WORKSPACE_ROOT>/.conversations/REVOKED_ALL                global
 *
 * The receiver stats BOTH on every event, as the last authorisation step
 * before enqueue, and caches nothing — a cached negative would admit an
 * event after the rename (stat at t=0, rename at t=10 ms, event accepted
 * from cache at t=20 ms), which is exactly the review-round-3 counter-
 * example. Two stats per accepted event cost microseconds; at R1's
 * maximum that is 100 stats/s per session.
 *
 * Writes are atomic: temp file + fsync + rename, then fsync of the
 * directory, so the guarantee "no authorisation that starts after
 * `rename` returns admits the event" holds across processes and crashes.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertContained, assertSafeComponent } from "./ids.js";

export interface RevocationMarker {
	at: string;
	by: "cli" | "api";
	reason?: string;
	/**
	 * Unique per write (3.0d audit A1): an enable retires only the marker it
	 * saw when it started, never a newer one written meanwhile.
	 */
	id?: string;
}

export const REVOKED_FILE = "REVOKED";
export const REVOKED_ALL_FILE = "REVOKED_ALL";

export function conversationsRoot(workspaceRoot: string): string {
	return path.resolve(workspaceRoot, ".conversations");
}

export function sessionConversationsDir(workspaceRoot: string, stSessionId: string): string {
	// B1 — two independent guards: the component itself, then containment
	// of the resolved path under `.conversations/`.
	assertSafeComponent(stSessionId, "session id");
	const root = conversationsRoot(workspaceRoot);
	return assertContained(root, path.join(root, stSessionId), "session conversations dir");
}

export function revokedPath(workspaceRoot: string, stSessionId: string): string {
	return path.join(sessionConversationsDir(workspaceRoot, stSessionId), REVOKED_FILE);
}

export function revokedAllPath(workspaceRoot: string): string {
	return path.join(conversationsRoot(workspaceRoot), REVOKED_ALL_FILE);
}

async function fsyncDir(dir: string): Promise<void> {
	// Directory fsync makes the rename durable; without it a crash right
	// after the rename could leave the entry unlinked on some filesystems.
	// Best-effort on platforms that refuse to open directories.
	try {
		const fh = await fs.open(dir, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
	} catch {
		/* ignore */
	}
}

async function writeMarker(file: string, marker: RevocationMarker): Promise<void> {
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	const fh = await fs.open(tmp, "w", 0o600);
	try {
		await fh.writeFile(JSON.stringify(marker));
		await fh.sync();
	} finally {
		await fh.close();
	}
	await fs.rename(tmp, file);
	await fsyncDir(dir);
}

export async function writeSessionRevocation(
	workspaceRoot: string,
	stSessionId: string,
	marker: RevocationMarker,
): Promise<void> {
	await writeMarker(revokedPath(workspaceRoot, stSessionId), { ...marker, id: randomUUID() });
}

export async function writeGlobalRevocation(
	workspaceRoot: string,
	marker: RevocationMarker,
): Promise<void> {
	await writeMarker(revokedAllPath(workspaceRoot), { ...marker, id: randomUUID() });
}

/** The per-session marker's exact bytes, or null if there is none. Other errors throw. */
export async function readSessionRevocation(
	workspaceRoot: string,
	stSessionId: string,
): Promise<string | null> {
	try {
		return await fs.readFile(revokedPath(workspaceRoot, stSessionId), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/**
 * Retire the per-session marker only if it is still `expected` — the bytes
 * an enable read when it started (3.0d audit A1). Not "compare, then
 * delete": the marker is first moved aside with one atomic `rename`, so
 * what gets compared is exactly what was taken. If it is not `expected` (a
 * disable or the emergency CLI wrote a newer one), it goes back with `link`,
 * which never overwrites a marker written in between. Only that rare
 * mismatch leaves the name empty for the instant between the two calls;
 * the newer revocation's own D1 write and its final re-assertion
 * (`disableSession`) still hold.
 *
 * "newer": a marker other than `expected` is (or was) there — the caller
 * must not proceed as if unrevoked.
 */
export async function retireSessionRevocation(
	workspaceRoot: string,
	stSessionId: string,
	expected: string | null,
): Promise<"removed" | "absent" | "newer"> {
	const file = revokedPath(workspaceRoot, stSessionId);
	if (expected === null) return (await exists(file)) ? "newer" : "absent";
	const aside = `${file}.retiring.${randomUUID()}`;
	try {
		await fs.rename(file, aside);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		throw err;
	}
	let taken: string;
	try {
		taken = await fs.readFile(aside, "utf8");
	} catch {
		taken = "";
	}
	if (taken === expected) {
		await fs.rm(aside, { force: true });
		await fsyncDir(path.dirname(file));
		return "removed";
	}
	try {
		await fs.link(aside, file);
	} catch (err) {
		// EEXIST: an even newer marker is already in place — keep that one.
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
			// Never leave the newer revocation only under the aside name.
			await fs.rename(aside, file).catch(() => undefined);
			throw err;
		}
	}
	await fs.rm(aside, { force: true });
	await fsyncDir(path.dirname(file));
	return "newer";
}

export async function removeSessionRevocation(
	workspaceRoot: string,
	stSessionId: string,
): Promise<void> {
	await fs.rm(revokedPath(workspaceRoot, stSessionId), { force: true });
}

export async function removeGlobalRevocation(workspaceRoot: string): Promise<void> {
	await fs.rm(revokedAllPath(workspaceRoot), { force: true });
}

export type RevocationState = "none" | "session" | "global";

/**
 * Uncached: two `stat`s per call, by design (see the header). Returns
 * which marker is present; "global" wins when both are.
 */
export async function checkRevocation(
	workspaceRoot: string,
	stSessionId: string,
): Promise<RevocationState> {
	const [global, session] = await Promise.all([
		exists(revokedAllPath(workspaceRoot)),
		exists(revokedPath(workspaceRoot, stSessionId)),
	]);
	if (global) return "global";
	if (session) return "session";
	return "none";
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		// Any other error (EACCES, EIO) is treated as "present": failing
		// closed is the only safe reading of "I cannot tell".
		return true;
	}
}
