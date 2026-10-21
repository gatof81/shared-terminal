/**
 * workspaceFiles.ts — read-only access to a session's persistent workspace
 * on the HOST bind mount (`<WORKSPACE_ROOT>/<sessionId>`), shared by the
 * file-download route (#358) and the Workspace Explorer routes
 * (`routes/files.ts`).
 *
 * Everything here reads the host filesystem directly — no docker exec, no
 * shell — so it works on stopped sessions (the workspace outlives the
 * container) and can't be steered into running anything.
 *
 * Threat model: code running INSIDE the session container fully controls
 * the workspace tree. It can plant symlinks pointing anywhere on the host,
 * swap files/dirs for symlinks between our checks and our opens, and
 * create FIFOs. The backend is typically root on the host, so every read
 * has to prove the object it ACTUALLY opened lives inside the session's
 * workspace — checking the path string before opening is not enough.
 *
 * Callers own authorization: every function here assumes the caller has
 * already run the ownership check for `sessionId`.
 */

import { existsSync, promises as fs, constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import nodePath from "node:path";

// Same env read as dockerManager.ts / backup.ts — each module reads it at
// load rather than sharing an export, so route tests can point it at a
// tmp dir (set inside vi.hoisted) without dragging the docker socket in.
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";

// Linux PATH_MAX — anything longer can't name a real file on the host
// filesystem anyway, so reject it before path.resolve chews on it.
export const WORKSPACE_PATH_MAX_LEN = 4096;

// ── Restricted paths ────────────────────────────────────────────────────────
// Credential-bearing paths the file APIs refuse to serve even to the owner.
// The owner can still `cat` them from their own terminal — this isn't a
// sandbox boundary, it's about not exposing secrets through a browser
// surface: a one-click download/copy, a preview that lands in screenshots
// or screen shares, a compromised frontend tab, or a future read-only
// sharing feature that reuses these routes. Denylist, so best-effort by
// nature; the PR description calls that out. Matching is case-insensitive
// so `.ENV` / `ID_RSA` don't slip past on a case-sensitive host fs.

// Directory names restricted at ANY depth (everything beneath them too).
const RESTRICTED_DIR_NAMES = new Set([
	// Shared Terminal's own persisted state root (#377): Claude CLI OAuth
	// credentials + transcripts, ~/.claude.json, ~/.ssh keys.
	".st",
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	".password-store",
	// `code tunnel` auth tokens (entrypoint symlinks ~/.vscode-cli here).
	".vscode-cli",
	// `.git/config` can carry credential-embedded remote URLs and
	// `http.extraHeader` tokens; nothing else in there is useful to
	// browse — the git status/diff viewer is a separate, purpose-built
	// follow-up rather than raw object-store browsing.
	".git",
]);

// Two-segment directory sequences restricted at any depth.
const RESTRICTED_DIR_PAIRS: ReadonlyArray<readonly [string, string]> = [
	// gh CLI tokens (entrypoint symlinks ~/.config/gh into the workspace).
	[".config", "gh"],
	[".config", "gcloud"],
];

const RESTRICTED_FILE_NAMES = new Set([
	".env",
	".netrc",
	"_netrc",
	".git-credentials",
	".npmrc",
	".pypirc",
	".pgpass",
	".htpasswd",
	// Claude CLI state. Current layout keeps these under `.st/` (covered
	// above); these names cover the pre-#377 layout that wrote them at the
	// workspace root, and a user copying them around by hand.
	".credentials.json",
	".claude.json",
	"credentials",
	"credentials.json",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_ecdsa_sk",
	"id_ed25519_sk",
]);

// Committed-by-convention env templates: these document variable NAMES and
// are exactly what a user wants to read, so they're carved out of `.env.*`.
const ENV_TEMPLATE_NAMES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

const RESTRICTED_EXTENSIONS = [
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
	".kdbx",
	".ppk",
	".tfstate",
	".env",
];

function isRestrictedFileName(lower: string): boolean {
	if (RESTRICTED_FILE_NAMES.has(lower)) return true;
	if (lower.startsWith(".env.") && !ENV_TEMPLATE_NAMES.has(lower)) return true;
	if (lower.endsWith(".tfstate.backup")) return true;
	return RESTRICTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * True when the workspace-relative `rel` (POSIX separators, already
 * normalised — no `.`/`..` segments) names a restricted path or anything
 * beneath one. Directory rules apply to every segment, so `.ssh/config`
 * and `a/.git/config` are both caught. File-name rules apply only to the
 * LEAF and only when it is (or may be) a file: a source directory named
 * `credentials/` or a `.env/` virtualenv shouldn't be blocked wholesale.
 * Pass `kind: "dir"` only when the caller KNOWS the leaf is a directory.
 */
export function isRestrictedPath(rel: string, kind: "file" | "dir" = "file"): boolean {
	if (rel === "") return false;
	const segments = rel.split("/").map((s) => s.toLowerCase());
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i] as string;
		if (RESTRICTED_DIR_NAMES.has(seg)) return true;
		const next = segments[i + 1];
		if (next !== undefined && RESTRICTED_DIR_PAIRS.some(([a, b]) => a === seg && b === next)) {
			return true;
		}
	}
	const leaf = segments[segments.length - 1] as string;
	return kind === "file" && isRestrictedFileName(leaf);
}

// ── Path resolution ─────────────────────────────────────────────────────────

/** A 4xx outcome the route maps straight onto the response. */
export interface WorkspaceFsError {
	ok: false;
	status: 400 | 403 | 404 | 413;
	error: string;
}

const NOT_FOUND: WorkspaceFsError = { ok: false, status: 404, error: "File not found" };
const RESTRICTED: WorkspaceFsError = {
	ok: false,
	status: 403,
	error: "This path is restricted because it may contain credentials",
};

/**
 * Validate the raw `?path=` query value. Returns the string, or an error.
 * `allowEmpty` is for directory listing, where "" means the workspace root.
 *
 * Express has already percent-decoded the query string exactly once. We
 * deliberately do NOT decode again: a double-encoded `%2e%2e%2f` arrives
 * here as that literal string, which is a legal (if odd) filename inside
 * the workspace and is treated as one — decoding a second time is exactly
 * the bug class that lets `..%252f` sneak past a check.
 */
export function validateRelPathParam(
	raw: unknown,
	opts: { allowEmpty: boolean },
): string | WorkspaceFsError {
	// `req.query.path` is string | string[] | ParsedQs — the typeof check
	// rejects the repeated-param array shape along with the missing case.
	if (raw === undefined && opts.allowEmpty) return "";
	if (typeof raw !== "string" || (raw.length === 0 && !opts.allowEmpty)) {
		return { ok: false, status: 400, error: "query param 'path' is required" };
	}
	if (raw.length > WORKSPACE_PATH_MAX_LEN) {
		return {
			ok: false,
			status: 400,
			error: `path must be at most ${WORKSPACE_PATH_MAX_LEN} characters`,
		};
	}
	// NUL would truncate the path at the syscall boundary, making the
	// string we containment-check differ from the path the kernel
	// resolves — reject alongside absolute paths.
	if (nodePath.isAbsolute(raw) || raw.includes("\0")) {
		return { ok: false, status: 400, error: "path must be workspace-relative" };
	}
	return raw;
}

interface Resolved {
	/** `<WORKSPACE_ROOT>/<sessionId>`, lexical. */
	sessionRoot: string;
	/** Lexically-resolved absolute target. */
	joined: string;
	/** Workspace-relative, POSIX, normalised ("" = root). */
	rel: string;
}

function resolveLexically(sessionId: string, rawRel: string): Resolved | WorkspaceFsError {
	const rootAbs = nodePath.resolve(WORKSPACE_ROOT);
	const sessionRoot = nodePath.resolve(rootAbs, sessionId);
	// Defence-in-depth: the session id comes from a D1 row the caller
	// already ownership-checked, but a traversal-shaped or dot-prefixed id
	// must never select `.uploads` / `.tmp-uploads` / another tenant's dir.
	if (nodePath.dirname(sessionRoot) !== rootAbs || nodePath.basename(sessionRoot).startsWith(".")) {
		return NOT_FOUND;
	}
	// `path.resolve` collapses `../` segments lexically, so a traversal
	// either lands outside the root (caught by the prefix check) or is
	// harmlessly normalised back inside.
	const joined = nodePath.resolve(sessionRoot, rawRel);
	if (joined !== sessionRoot && !joined.startsWith(sessionRoot + nodePath.sep)) {
		return { ok: false, status: 400, error: "path escapes the session workspace" };
	}
	const rel = nodePath.relative(sessionRoot, joined).split(nodePath.sep).join("/");
	return { sessionRoot, joined, rel };
}

/** Workspace-relative form of `abs` under `realRoot`, or null if outside. */
function relUnder(realRoot: string, abs: string): string | null {
	if (abs === realRoot) return "";
	if (!abs.startsWith(realRoot + nodePath.sep)) return null;
	return abs
		.slice(realRoot.length + 1)
		.split(nodePath.sep)
		.join("/");
}

// Decided once at load: is the `/proc/self/fd` magic-link check available?
// Deliberately NOT "try it and fall back on any error" — on a host where
// /proc works, a readlink failure is an anomaly and must fail the request
// rather than silently skip the last containment check. Only a platform
// with no /proc at all (macOS dev boxes) runs without it.
const PROC_FD_AVAILABLE = process.platform === "linux" && existsSync("/proc/self/fd");

/**
 * Where the kernel says an open fd actually points. Linux exposes it as
 * the `/proc/self/fd/<n>` magic link, which is what closes the
 * check-then-open race: whatever symlink games happened on the way in,
 * this names the object we're holding. Returns null only where /proc is
 * unavailable — callers then rely on their pre-open realpath check alone,
 * which is the pre-Explorer download behaviour. Throws if /proc exists
 * but the readlink fails (caller closes the fd and answers 500).
 */
async function fdRealPath(handle: FileHandle): Promise<string | null> {
	if (!PROC_FD_AVAILABLE) return null;
	return fs.readlink(`/proc/self/fd/${handle.fd}`);
}

function isErrno(err: unknown, ...codes: string[]): boolean {
	return codes.includes((err as NodeJS.ErrnoException).code ?? "");
}

// ── Files ───────────────────────────────────────────────────────────────────

export interface OpenedWorkspaceFile {
	ok: true;
	/** Caller MUST close (or hand to a read stream with autoClose). */
	handle: FileHandle;
	/** From fstat on the open fd — matches the bytes the caller reads. */
	size: number;
	mtime: Date;
	/** Leaf name, for Content-Disposition. */
	name: string;
	/** Normalised workspace-relative path. */
	rel: string;
}

/**
 * Containment-check `rawRel` against the session's workspace and open it
 * read-only. Follows the purgeWorkspace discipline (lexical resolve +
 * strict-prefix check) and adds the symlink hardening a READ path needs
 * that a recursive-rm path doesn't: `fs.rm` never follows symlinks out of
 * the tree, but a read happily would.
 *
 * `maxBytes` (optional) is enforced against both the lstat and the fstat.
 */
export async function openWorkspaceFile(
	sessionId: string,
	rawRel: string,
	opts: { maxBytes?: number } = {},
): Promise<OpenedWorkspaceFile | WorkspaceFsError> {
	const resolved = resolveLexically(sessionId, rawRel);
	if ("ok" in resolved) return resolved;
	const { sessionRoot, joined } = resolved;
	if (resolved.rel === "") {
		return { ok: false, status: 400, error: "path is a directory, not a file" };
	}
	if (isRestrictedPath(resolved.rel)) return RESTRICTED;

	// The lexical check above says nothing about symlinked PARENTS
	// (`ln -s /etc workspace/link` + path=link/passwd passes it). realpath
	// the containing directory and re-verify against the realpath'd root —
	// both sides canonicalised so a legitimately-symlinked WORKSPACE_ROOT
	// (e.g. /var → /private/var) doesn't false-positive every request.
	let realRoot: string;
	let realDir: string;
	try {
		realRoot = await fs.realpath(sessionRoot);
		realDir = await fs.realpath(nodePath.dirname(joined));
	} catch (err) {
		if (isErrno(err, "ENOENT", "ENOTDIR")) return NOT_FOUND;
		throw err;
	}
	const realDirRel = relUnder(realRoot, realDir);
	if (realDirRel === null) {
		// 404, not 400: a symlink pointing out of the workspace was
		// planted by code running in the container — don't hand a
		// probing client confirmation that its link took effect.
		return NOT_FOUND;
	}
	const leafName = nodePath.basename(joined);
	// Re-check restriction against the REAL path: an in-workspace symlink
	// `docs -> .st` makes `docs/claude-state/.credentials.json` look
	// harmless lexically.
	if (isRestrictedPath(realDirRel === "" ? leafName : `${realDirRel}/${leafName}`)) {
		return RESTRICTED;
	}

	const leaf = nodePath.join(realDir, leafName);
	let lst: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		// lstat (not stat) so a symlink LEAF is visible as such instead
		// of being transparently followed to wherever it points.
		lst = await fs.lstat(leaf);
	} catch (err) {
		if (isErrno(err, "ENOENT", "ENOTDIR")) return NOT_FOUND;
		throw err;
	}
	if (lst.isSymbolicLink()) {
		// Same no-disclosure 404 as the parent-escape branch — even a
		// symlink that resolves INSIDE the workspace is refused rather
		// than followed; the user can open the target directly.
		return NOT_FOUND;
	}
	if (lst.isDirectory()) {
		return { ok: false, status: 400, error: "path is a directory, not a file" };
	}
	if (!lst.isFile()) {
		// Sockets, FIFOs, device nodes — nothing readable lives here.
		return { ok: false, status: 400, error: "path is not a regular file" };
	}
	if (opts.maxBytes !== undefined && lst.size > opts.maxBytes) {
		return tooLarge(opts.maxBytes);
	}

	// O_NOFOLLOW closes the lstat→open race for the LEAF: code inside the
	// container can swap the checked file for a symlink between the lstat
	// above and this open, and the backend (typically root on the host)
	// would follow it anywhere. With O_NOFOLLOW the kernel answers ELOOP.
	// O_NONBLOCK stops the same race from parking this request forever on
	// a FIFO swapped in for the file (a blocking open of a FIFO waits for
	// a writer); it's a no-op for regular-file reads.
	let handle: FileHandle;
	try {
		handle = await fs.open(
			leaf,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
	} catch (err) {
		if (isErrno(err, "ENOENT", "ELOOP", "ENOTDIR")) return NOT_FOUND;
		throw err;
	}
	// From here on every early return must close the fd: if fstat throws
	// (EBADF/ENOMEM under OS pressure) the root-held descriptor would
	// otherwise wait on GC finalisation, which can lose a race against
	// fd-table exhaustion under sustained load (PR #403 review).
	try {
		// A racing parent-DIRECTORY swap (realpath above, then the dir is
		// replaced by a symlink before open) is the one hole O_NOFOLLOW
		// can't close. Ask the kernel what we actually opened and redo
		// containment + restriction on that.
		const actual = await fdRealPath(handle);
		if (actual !== null) {
			const actualRel = relUnder(realRoot, actual);
			if (actualRel === null) {
				await handle.close();
				return NOT_FOUND;
			}
			if (isRestrictedPath(actualRel)) {
				await handle.close();
				return RESTRICTED;
			}
		}
		const st = await handle.stat();
		if (!st.isFile()) {
			await handle.close();
			return { ok: false, status: 400, error: "path is not a regular file" };
		}
		if (opts.maxBytes !== undefined && st.size > opts.maxBytes) {
			await handle.close();
			return tooLarge(opts.maxBytes);
		}
		return { ok: true, handle, size: st.size, mtime: st.mtime, name: leafName, rel: resolved.rel };
	} catch (err) {
		await handle.close().catch(() => {});
		throw err;
	}
}

function tooLarge(maxBytes: number): WorkspaceFsError {
	const mib = maxBytes / (1024 * 1024);
	return {
		ok: false,
		status: 413,
		error: `file exceeds the ${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB limit`,
	};
}

/**
 * Read at most `limit` bytes from the start of an open file without ever
 * allocating more than `min(limit, sizeHint) + 1` — so a multi-GB log
 * can't be pulled into the heap by a preview, and a 2 KB icon doesn't
 * cost a 10 MiB buffer. `sizeHint` is the caller's fstat size; the extra
 * byte is how we learn the file is longer than the cap even if it grew
 * since that fstat (reported as `truncated`).
 */
export async function readHead(
	handle: FileHandle,
	limit: number,
	sizeHint: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
	const cap = Math.min(limit, sizeHint);
	const buf = Buffer.alloc(cap + 1);
	let filled = 0;
	while (filled < buf.length) {
		const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return { bytes: buf.subarray(0, Math.min(filled, cap)), truncated: filled > cap };
}

// ── Directories ─────────────────────────────────────────────────────────────

export type WorkspaceEntryType = "dir" | "file" | "symlink" | "other";

export interface WorkspaceEntry {
	name: string;
	type: WorkspaceEntryType;
	/** Bytes for regular files; null otherwise. */
	size: number | null;
	mtime: string | null;
	/** Restricted entries are listed (so the tree isn't silently missing
	 *  files the user knows exist) but can't be opened or expanded. */
	restricted: boolean;
}

export interface WorkspaceListing {
	ok: true;
	/** Normalised workspace-relative directory path ("" = root). */
	path: string;
	entries: WorkspaceEntry[];
	/** True when the directory held more than `maxEntries` entries. */
	truncated: boolean;
}

/**
 * List one directory level. Symlinks are reported as `symlink` and never
 * followed — listing their target would need the same containment proof
 * as an open, and following them is how a tree walk ends up in /etc.
 */
export async function listWorkspaceDir(
	sessionId: string,
	rawRel: string,
	opts: { maxEntries: number },
): Promise<WorkspaceListing | WorkspaceFsError> {
	const resolved = resolveLexically(sessionId, rawRel);
	if ("ok" in resolved) return resolved;
	const { sessionRoot, joined } = resolved;
	if (isRestrictedPath(resolved.rel, "dir")) return RESTRICTED;

	let realRoot: string;
	let realTarget: string;
	try {
		realRoot = await fs.realpath(sessionRoot);
		realTarget = await fs.realpath(joined);
	} catch (err) {
		if (isErrno(err, "ENOENT", "ENOTDIR")) {
			return { ok: false, status: 404, error: "Directory not found" };
		}
		throw err;
	}
	const realRel = relUnder(realRoot, realTarget);
	if (realRel === null) return { ok: false, status: 404, error: "Directory not found" };
	if (isRestrictedPath(realRel, "dir")) return RESTRICTED;

	let handle: FileHandle;
	try {
		// Open the realpath'd target (no symlink components at check time)
		// with O_DIRECTORY|O_NOFOLLOW; the fd re-check below covers a swap
		// between the realpath and this open.
		handle = await fs.open(
			realTarget,
			fsConstants.O_RDONLY |
				fsConstants.O_DIRECTORY |
				fsConstants.O_NOFOLLOW |
				fsConstants.O_NONBLOCK,
		);
	} catch (err) {
		if (isErrno(err, "ENOTDIR")) {
			return { ok: false, status: 400, error: "path is not a directory" };
		}
		if (isErrno(err, "ENOENT", "ELOOP")) {
			return { ok: false, status: 404, error: "Directory not found" };
		}
		throw err;
	}
	try {
		const actual = await fdRealPath(handle);
		// Iterate via the fd's magic link when available so the directory
		// we list is the inode we verified, not whatever the path names
		// by the time opendir runs.
		let ioPath = realTarget;
		let listedRel = realRel;
		if (actual !== null) {
			const actualRel = relUnder(realRoot, actual);
			if (actualRel === null) return { ok: false, status: 404, error: "Directory not found" };
			if (isRestrictedPath(actualRel, "dir")) return RESTRICTED;
			ioPath = `/proc/self/fd/${handle.fd}`;
			listedRel = actualRel;
		}

		// Collect names + dirent types (free: readdir's d_type, no extra
		// syscall) for up to MAX_DIR_SCAN entries, sort, THEN cut to
		// `maxEntries` — so a big folder shows its first entries in display
		// order (dirs first, natural name order) rather than an arbitrary
		// filesystem-order subset. Only the kept entries get an lstat.
		// Directories past MAX_DIR_SCAN still see a scan-order subset;
		// `truncated` is set either way.
		const scanned: { name: string; isDir: boolean }[] = [];
		let truncated = false;
		const dir = await fs.opendir(ioPath);
		try {
			// opendir streams entries, so a 1M-entry cache dir costs
			// MAX_DIR_SCAN reads, not a full readdir array.
			for await (const dirent of dir) {
				if (scanned.length >= MAX_DIR_SCAN) {
					truncated = true;
					break;
				}
				scanned.push({ name: dirent.name, isDir: dirent.isDirectory() });
			}
		} finally {
			// `break` out of for-await already closes the Dir; closing it
			// again rejects with ERR_DIR_CLOSED, which is fine to drop.
			await dir.close().catch(() => {});
		}
		scanned.sort((a, b) => compareNames(a.name, a.isDir, b.name, b.isDir));
		if (scanned.length > opts.maxEntries) truncated = true;
		const names = scanned.slice(0, opts.maxEntries).map((e) => e.name);

		const entries = await Promise.all(
			names.map(async (name): Promise<WorkspaceEntry> => {
				const childRel = listedRel === "" ? name : `${listedRel}/${name}`;
				try {
					const st = await fs.lstat(nodePath.join(ioPath, name));
					const type: WorkspaceEntryType = st.isSymbolicLink()
						? "symlink"
						: st.isDirectory()
							? "dir"
							: st.isFile()
								? "file"
								: "other";
					const restricted = isRestrictedPath(childRel, type === "dir" ? "dir" : "file");
					return {
						name,
						type,
						// Restricted entries don't disclose size/mtime —
						// cheap, and it keeps the response from leaking
						// e.g. "the key file just changed".
						size: type === "file" && !restricted ? st.size : null,
						mtime: restricted ? null : st.mtime.toISOString(),
						restricted,
					};
				} catch {
					// Raced with a delete inside the container.
					return {
						name,
						type: "other",
						size: null,
						mtime: null,
						restricted: isRestrictedPath(childRel),
					};
				}
			}),
		);
		entries.sort(compareEntries);
		return { ok: true, path: resolved.rel, entries, truncated };
	} finally {
		await handle.close().catch(() => {});
	}
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Upper bound on names read from one directory before sorting. Names only
// (no stat), so 20k is a few hundred KB of strings at most.
const MAX_DIR_SCAN = 20_000;

function compareNames(an: string, aDir: boolean, bn: string, bDir: boolean): number {
	if (aDir !== bDir) return aDir ? -1 : 1;
	return collator.compare(an, bn) || (an < bn ? -1 : an > bn ? 1 : 0);
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
	return compareNames(a.name, a.type === "dir", b.name, b.type === "dir");
}

// ── Response helpers ────────────────────────────────────────────────────────

/**
 * Content-Disposition filename as an RFC 6266 quoted-string. Header
 * injection is neutralised by replacing everything outside printable
 * ASCII (CR/LF are what matter; Node would throw on them, but a 500 for
 * a weird filename is the wrong answer), then `"` and `\` are
 * backslash-escaped so the quoted-string can't be broken out of.
 * Multi-byte names degrade to underscores — losing the pretty name beats
 * emitting a header clients mis-parse; the RFC 5987 `filename*` dance
 * isn't worth it for v1.
 */
export function contentDispositionFilename(name: string): string {
	const printable = name.replace(/[^\x20-\x7e]/g, "_");
	const escaped = printable.replace(/[\\"]/g, "\\$&");
	return escaped.trim().length > 0 ? escaped : "download";
}
