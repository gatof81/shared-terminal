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
 * The receiver checks BOTH on every event, as the last authorisation step
 * before enqueue, and caches nothing — a cached negative would admit an
 * event after the rename (stat at t=0, rename at t=10 ms, event accepted
 * from cache at t=20 ms), which is exactly the review-round-3 counter-
 * example. A stat of the global marker plus two small reads per session
 * (`LIFTED`, then `REVOKED`, 3.0d) per accepted event cost microseconds.
 *
 * Writes are atomic: temp file + fsync + rename, then fsync of the
 * directory, so the guarantee "no authorisation that starts after
 * `rename` returns admits the event" holds across processes and crashes.
 */

import { createHash, randomUUID } from "node:crypto";
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
/**
 * Lifting a per-session revocation (3.0d audit A1.1a/b). `REVOKED` itself is
 * NEVER moved or deleted once written — a writer only ever replaces it with
 * temp + `rename`, so the name never disappears. An enable lifts the one it
 * saw by publishing, the same atomic way, the sha256 of that marker's exact
 * bytes here. A revocation is in effect when `REVOKED` exists and is not the
 * one `LIFTED` names: a newer marker (disable, emergency CLI) has other
 * bytes (each write carries a unique `id`), so it is in effect whatever
 * `LIFTED` says, with nothing to restore and nothing anyone could overwrite.
 */
export const LIFTED_FILE = "LIFTED";
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

export function liftedPath(workspaceRoot: string, stSessionId: string): string {
	return path.join(sessionConversationsDir(workspaceRoot, stSessionId), LIFTED_FILE);
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

async function writeMarker(file: string, marker: object): Promise<void> {
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

function sha256(bytes: string): string {
	return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/** File contents, or null on ENOENT. Any other error throws. */
async function readIfExists(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/**
 * The per-session revocation IN EFFECT: the exact bytes of `REVOKED` when
 * it exists and is not the one `LIFTED` names; null when there is none or it
 * was lifted. Errors throw (callers fail closed).
 *
 * `LIFTED` is read BEFORE `REVOKED`. Each changes only by an atomic replace,
 * so any interleaving with a writer gives one of: the newer `REVOKED` (bytes
 * no lift names ⇒ in effect), or an older pair (the state before the write,
 * which was itself a consistent answer). Read the other way round, a reader
 * could combine an old `REVOKED` with a lift published after it and miss a
 * newer marker written in between — that order is the one that matters.
 */
export async function readSessionRevocation(
	workspaceRoot: string,
	stSessionId: string,
): Promise<string | null> {
	const liftedRaw = await readIfExists(liftedPath(workspaceRoot, stSessionId));
	const revoked = await readIfExists(revokedPath(workspaceRoot, stSessionId));
	if (revoked === null) return null;
	let lifts: unknown = null;
	try {
		lifts = liftedRaw ? (JSON.parse(liftedRaw) as { lifts?: unknown }).lifts : null;
	} catch {
		lifts = null; // an unreadable lift lifts nothing
	}
	return lifts === sha256(revoked) ? null : revoked;
}

/**
 * Lift the per-session revocation only if the one in effect is still
 * `expected` — the bytes an enable saw when it started (3.0d audit A1).
 * Nothing is moved or deleted: the lift is published (temp + fsync +
 * rename) naming `expected`'s hash, then the state is read again. A newer
 * revocation written at any point — before, during or after the publish —
 * has other bytes, so it stays in effect and the answer is "newer". A
 * failure leaves the revocation in effect (fail-closed) and throws.
 */
export async function retireSessionRevocation(
	workspaceRoot: string,
	stSessionId: string,
	expected: string | null,
): Promise<"removed" | "absent" | "newer"> {
	if (expected !== null) {
		await writeMarker(liftedPath(workspaceRoot, stSessionId), {
			lifts: sha256(expected),
			at: new Date().toISOString(),
		});
	}
	const now = await readSessionRevocation(workspaceRoot, stSessionId);
	if (now !== null) return "newer";
	return expected === null ? "absent" : "removed";
}

export async function removeGlobalRevocation(workspaceRoot: string): Promise<void> {
	await fs.rm(revokedAllPath(workspaceRoot), { force: true });
}

export type RevocationState = "none" | "session" | "global";

/**
 * Uncached, by design (see the header): a stat of the global marker and
 * `readSessionRevocation`'s two reads. Returns
 * which marker is present; "global" wins when both are.
 */
export async function checkRevocation(
	workspaceRoot: string,
	stSessionId: string,
): Promise<RevocationState> {
	if (await exists(revokedAllPath(workspaceRoot))) return "global";
	try {
		return (await readSessionRevocation(workspaceRoot, stSessionId)) === null ? "none" : "session";
	} catch {
		// Absence that cannot be established is not absence (fail-closed).
		return "session";
	}
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
