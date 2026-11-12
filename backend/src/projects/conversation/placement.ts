/**
 * projects/conversation/placement.ts — writing artifacts into the target
 * workspace's `.st-inbox/` (docs/PROJECT_CONVERSATION.md §6.4, the step b'
 * of §3.3). Runs WITHOUT the project lock, after `delivery{placing}` is on
 * disk; its failure becomes `not-sent{artifact-failed}` in S2b.
 *
 * The target workspace is controlled by the agent, and the backend is root
 * on the host. Every rule below exists because the agent can rename,
 * replace or symlink anything in its workspace at any moment:
 *
 *   - the workspace and the inbox are OPENED (O_DIRECTORY | O_NOFOLLOW) and
 *     proven by `/proc/self/fd/<n>`; from then on every path is built on
 *     `/proc/self/fd/<inboxfd>/…`, which the kernel resolves to the opened
 *     directory whatever happens to the textual path. Node has no `openat`;
 *     this is the same thing. The textual path is never resolved again;
 *   - nothing existing is opened for writing, replaced or deleted: a file
 *     is published by `link(2)` from our own O_EXCL temp (EEXIST ⇒ compare),
 *     and an existing name is only ever READ (O_NOFOLLOW | O_NONBLOCK, so a
 *     FIFO cannot park the request);
 *   - the content is verified through the temp's own fd after fsync, and
 *     after the link the final name must be THAT inode (dev + ino): an agent
 *     that swapped the temp between write and link gets a visible failure,
 *     never a "placed" for bytes we did not verify;
 *   - no symlink is created, no exec bit is set, the temp is the only thing
 *     ever unlinked — and only while its name still holds our inode.
 */

import { randomBytes } from "node:crypto";
import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";
import { ARTIFACT_MAX_BYTES, type ArtifactRef, inboxName, sha256Hex } from "./artifacts.js";

export const INBOX_DIR = ".st-inbox";
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlacementError =
	| "workspace-unavailable"
	| "inbox-not-dir"
	| "exists-different"
	| "hash-mismatch"
	| "io";

export type PlacementResult =
	| { ok: true; placed: Array<{ sha256: string; path: string }> }
	| { ok: false; error: PlacementError; detail?: string };

export interface PlacementInput {
	workspaceRoot: string;
	sessionId: string;
	artifacts: ReadonlyArray<ArtifactRef & { content: Buffer }>;
	/** WORKSPACE_UID:WORKSPACE_GID — who owns what the agent receives (§6.4). */
	uid: number;
	gid: number;
	/** Test seam: runs once the inbox is opened and proven (T11 swaps the path here). */
	afterInboxOpen?: () => Promise<void>;
	/** Test seam: runs between the temp's verification and its link (the swap race). */
	beforeLink?: (tmpPath: string) => Promise<void>;
}

class Fail extends Error {
	constructor(
		readonly code: PlacementError,
		detail: string,
	) {
		super(detail);
	}
}

const errno = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? "";
const fdPath = (fh: fs.FileHandle) => `/proc/self/fd/${fh.fd}`;

export async function placeArtifacts(input: PlacementInput): Promise<PlacementResult> {
	const handles: fs.FileHandle[] = [];
	try {
		if (!SID_RE.test(input.sessionId))
			throw new Fail("workspace-unavailable", "invalid session id");
		// Bytes that are not the artifact never reach the target, not even its inbox (T13).
		for (const a of input.artifacts) {
			if (sha256Hex(a.content) !== a.sha256) throw new Fail("hash-mismatch", a.sha256);
		}
		// 1. The workspace, proven to be exactly <realpath(WORKSPACE_ROOT)>/<sid>.
		const realRoot = await fs.realpath(input.workspaceRoot);
		const wsPath = path.join(realRoot, input.sessionId);
		let ws: fs.FileHandle;
		try {
			ws = await fs.open(wsPath, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
		} catch (e) {
			throw new Fail("workspace-unavailable", errno(e) || (e as Error).message);
		}
		handles.push(ws);
		if ((await fs.readlink(fdPath(ws))) !== wsPath)
			throw new Fail("workspace-unavailable", "workspace fd is not the workspace path");

		// 2. The inbox, relative to that descriptor.
		const inbox = await openInbox(ws, `${wsPath}/${INBOX_DIR}`, input);
		handles.push(inbox);
		await input.afterInboxOpen?.();
		const inboxAt = fdPath(inbox);

		const placed: Array<{ sha256: string; path: string }> = [];
		for (const a of input.artifacts) {
			const final = inboxName(a);
			await placeOne(inboxAt, final, a, input);
			placed.push({ sha256: a.sha256, path: `${INBOX_DIR}/${final}` });
		}
		await inbox.sync();
		return { ok: true, placed };
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.code, detail: e.message };
		return { ok: false, error: "io", detail: errno(e) || (e as Error).message };
	} finally {
		for (const h of handles.reverse()) await h.close().catch(() => {});
	}
}

async function openInbox(
	ws: fs.FileHandle,
	expected: string,
	input: PlacementInput,
): Promise<fs.FileHandle> {
	const at = `${fdPath(ws)}/${INBOX_DIR}`;
	const open = () => fs.open(at, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
	let inbox: fs.FileHandle;
	let created = false;
	try {
		inbox = await open();
	} catch (e) {
		if (errno(e) === "ELOOP" || errno(e) === "ENOTDIR") throw new Fail("inbox-not-dir", errno(e));
		if (errno(e) !== "ENOENT") throw e;
		try {
			await fs.mkdir(at, 0o755);
			created = true;
		} catch (e2) {
			if (errno(e2) !== "EEXIST") throw e2;
		}
		try {
			inbox = await open();
		} catch (e3) {
			if (errno(e3) === "ELOOP" || errno(e3) === "ENOTDIR")
				throw new Fail("inbox-not-dir", errno(e3));
			throw e3;
		}
	}
	try {
		if ((await fs.readlink(fdPath(inbox))) !== expected)
			throw new Fail("inbox-not-dir", "inbox fd is not <workspace>/.st-inbox");
		if (created) {
			// By descriptor, never by name: the agent may already have swapped the name.
			await inbox.chown(input.uid, input.gid);
			await inbox.chmod(0o755);
		}
		if (created) await ws.sync();
		return inbox;
	} catch (e) {
		await inbox.close().catch(() => {});
		throw e;
	}
}

/** §6.4 step 3: an existing final name counts as placed only if it is a regular file with exactly our bytes. */
async function existingMatches(p: string, sha: string): Promise<boolean> {
	let fh: fs.FileHandle;
	try {
		fh = await fs.open(p, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
	} catch {
		return false;
	}
	try {
		const st = await fh.stat();
		if (!st.isFile() || st.size > ARTIFACT_MAX_BYTES) return false;
		const buf = Buffer.alloc(st.size + 1);
		const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
		return bytesRead === st.size && sha256Hex(buf.subarray(0, bytesRead)) === sha;
	} catch {
		return false;
	} finally {
		await fh.close().catch(() => {});
	}
}

async function placeOne(
	inboxAt: string,
	final: string,
	a: ArtifactRef & { content: Buffer },
	input: PlacementInput,
): Promise<void> {
	const finalAt = `${inboxAt}/${final}`;
	// 3. Already there (a previous delivery, or the agent): compare, never replace.
	try {
		await fs.lstat(finalAt);
		if (await existingMatches(finalAt, a.sha256)) return;
		throw new Fail("exists-different", final);
	} catch (e) {
		if (e instanceof Fail) throw e;
		if (errno(e) !== "ENOENT") throw e;
	}

	// 4. Our own temp: O_EXCL, written, fsynced, re-read through the same fd.
	const tmpAt = `${inboxAt}/.${randomBytes(8).toString("hex")}.tmp`;
	const tmp = await fs.open(tmpAt, FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_RDWR, 0o644);
	let ours: { dev: number; ino: number } | undefined;
	let linked = false;
	try {
		const st0 = await tmp.stat();
		ours = { dev: st0.dev, ino: st0.ino };
		await tmp.writeFile(a.content);
		await tmp.sync();
		const back = Buffer.alloc(a.content.length + 1);
		const { bytesRead } = await tmp.read(back, 0, back.length, 0);
		if (bytesRead !== a.content.length || sha256Hex(back.subarray(0, bytesRead)) !== a.sha256)
			throw new Fail("hash-mismatch", `${final}: read-back differs`);
		// Only now handed to the agent (§6.4): before this it could not touch it.
		await tmp.chmod(0o644);
		await tmp.chown(input.uid, input.gid);

		await input.beforeLink?.(tmpAt);
		try {
			await fs.link(tmpAt, finalAt);
			linked = true;
		} catch (e) {
			if (errno(e) !== "EEXIST") throw e;
		}
		if (!linked) {
			// Someone published that name between our check and our link.
			if (!(await existingMatches(finalAt, a.sha256))) throw new Fail("exists-different", final);
		} else {
			// The link took whatever held the temp's NAME. Placed only if that is our inode.
			const fst = await fs.lstat(finalAt).catch(() => null);
			if (!fst?.isFile() || fst.dev !== ours.dev || fst.ino !== ours.ino)
				throw new Fail("exists-different", `${final}: not the verified file`);
		}
	} finally {
		await tmp.close().catch(() => {});
		await unlinkIfOurs(tmpAt).catch(() => {});
	}

	async function unlinkIfOurs(p: string): Promise<void> {
		const st = await fs.lstat(p).catch(() => null);
		if (st && ours && st.dev === ours.dev && st.ino === ours.ino) await fs.unlink(p);
	}
}
