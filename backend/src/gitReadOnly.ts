/**
 * gitReadOnly.ts — read-only git inspection of a session's workspace
 * (status, numstat, one-file diff, recent log) for the Git Changes view.
 *
 * WHERE git runs is the load-bearing decision. Every command executes
 * INSIDE the session container (`DockerManager.execCapture`, as the
 * unprivileged `developer` user), never on the host:
 *
 *   - A repository is attacker-controlled input. `.git/config` can set
 *     `core.fsmonitor`, `diff.external`, `core.sshCommand`, a textconv
 *     driver, `core.worktree=/` … — plain `git status` / `git diff` will
 *     happily execute those or read outside the tree. On the host the
 *     backend is root; in the container it is the same uid that already
 *     runs the user's arbitrary code, so nothing is gained by escaping.
 *   - The worktree can also point anywhere via symlinks; in-container,
 *     "anywhere" is the container.
 *
 * The cost is that a STOPPED session has no container to exec in — the
 * Git view needs the session running (the Files view doesn't). Running
 * git on the host in a throwaway sandbox container is the documented
 * follow-up, not v1.
 *
 * Client input never becomes shell: every command is a fixed argv, the
 * only client-sourced operands are a validated workspace-relative
 * directory (`-C <dir>`) and validated repo-relative file paths passed
 * after `--` as `:(top,literal)` pathspecs. Output is bounded in bytes
 * and seconds by execCapture; parsers here tolerate a cut record.
 */

import type { DockerManager } from "./dockerManager.js";
import { isRestrictedPath, validateRelPathParam, type WorkspaceFsError } from "./workspaceFiles.js";

// ── Limits ──────────────────────────────────────────────────────────────────

// One command's wall clock. `git status` on a cold multi-GB tree is a
// few seconds; 20 s is "something is wrong", not "be patient".
export const GIT_TIMEOUT_MS = 20_000;
// Porcelain status: ~100 B/record, so 2 MiB ≈ 20k entries — far past
// GIT_MAX_STATUS_FILES; the cap is a memory bound, not a UX one.
export const GIT_STATUS_MAX_BYTES = 2 * 1024 * 1024;
// One file's patch. 512 KiB ≈ 12k diff lines — more than a human reads
// in a browser pane; larger diffs show their head with `truncated`.
export const GIT_DIFF_MAX_BYTES = 512 * 1024;
export const GIT_LOG_MAX_BYTES = 256 * 1024;
export const GIT_MAX_STATUS_FILES = 2000;
export const GIT_LOG_LIMIT = 50;
export const GIT_MAX_CANDIDATES = 50;

export const WORKSPACE_DIR = "/home/developer/workspace";

// ── Validation ──────────────────────────────────────────────────────────────

export type GitArea = "staged" | "unstaged" | "untracked" | "conflict";
const AREAS: ReadonlySet<string> = new Set(["staged", "unstaged", "untracked", "conflict"]);

export function parseArea(raw: unknown): GitArea | null {
	return typeof raw === "string" && AREAS.has(raw) ? (raw as GitArea) : null;
}

/**
 * A repo-relative path as git reported it: non-empty, POSIX, no `.`/`..`
 * or empty segments, no NUL, not absolute. Stricter than the Files view's
 * normalise-then-check because this string is handed back to git as a
 * literal pathspec and must name exactly the entry status listed.
 */
export function validateGitPath(raw: unknown): string | WorkspaceFsError {
	const v = validateRelPathParam(raw, { allowEmpty: false });
	if (typeof v !== "string") return v;
	if (!hasCleanSegments(v) || v.endsWith("/")) {
		return { ok: false, status: 400, error: "path must be a normalised repo-relative path" };
	}
	return v;
}

/** Optional `?dir=`: workspace-relative repo root ("" = workspace root). */
export function validateGitDir(raw: unknown): string | WorkspaceFsError {
	const v = validateRelPathParam(raw, { allowEmpty: true });
	if (typeof v !== "string") return v;
	const dir = v.replace(/\/+$/, "");
	if (!hasCleanSegments(dir)) {
		return { ok: false, status: 400, error: "dir must be a normalised workspace-relative path" };
	}
	if (isRestrictedPath(dir, "dir")) {
		return { ok: false, status: 403, error: "This path is restricted" };
	}
	return dir;
}

function hasCleanSegments(p: string): boolean {
	if (p === "") return true;
	return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// ── Command runner ──────────────────────────────────────────────────────────

export interface CaptureResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
	truncated: boolean;
	timedOut: boolean;
}

/** One session container, one repo dir. Built per request by the route. */
export interface GitRunner {
	run(argv: string[], maxBytes: number): Promise<CaptureResult>;
}

// Git is told, through the environment, to never block, never write and
// never look outside the workspace:
//   GIT_OPTIONAL_LOCKS=0      `git status` takes no index lock at all, so it
//                             never fights the user's own git. (`git diff`
//                             may still refresh the index's stat cache in
//                             place — same tracked content, and it backs
//                             off if index.lock is held; pinned by the
//                             integration test.)
//   GIT_TERMINAL_PROMPT=0     no credential/passphrase prompt can hang us.
//   GIT_CEILING_DIRECTORIES   discovery stops at the workspace: a `.git`
//                             planted in /home/developer is never used.
//   LC_ALL=C                  stable English diagnostics for the matchers
//                             below; path bytes are never transcoded.
export const GIT_ENV: Readonly<Record<string, string>> = {
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
	GIT_CEILING_DIRECTORIES: "/home/developer",
	GIT_PAGER: "cat",
	PAGER: "cat",
	LC_ALL: "C",
};

// Per-invocation config overrides (command line beats repo/user config):
// raw UTF-8 paths, no colour, no pager, no fsmonitor daemon spawn.
const GIT_CONFIG_ARGS = [
	"-c",
	"core.quotePath=false",
	"-c",
	"color.ui=never",
	"-c",
	"core.pager=cat",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"diff.noprefix=false",
	"-c",
	"diff.mnemonicPrefix=false",
];

// Diff flags shared by every patch/numstat call: no external diff driver,
// no textconv filter (both are repo-configurable commands), no colour.
const DIFF_SAFE_ARGS = ["--no-ext-diff", "--no-textconv", "--no-color"];

export function makeGitRunner(
	docker: Pick<DockerManager, "execCapture">,
	sessionId: string,
	containerId: string,
): GitRunner {
	return {
		run: (argv, maxBytes) =>
			docker.execCapture(sessionId, argv, {
				containerId,
				cwd: WORKSPACE_DIR,
				env: GIT_ENV,
				maxBytes,
				timeoutMs: GIT_TIMEOUT_MS,
			}),
	};
}

/** `git [-C dir] <config overrides> …args` */
export function gitArgv(dir: string, ...args: string[]): string[] {
	return ["git", ...(dir === "" ? [] : ["-C", dir]), ...GIT_CONFIG_ARGS, ...args];
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type GitErrorCode = "not-a-repo" | "unsafe-repository" | "timeout" | "git-failed";

export class GitError extends Error {
	constructor(
		readonly code: GitErrorCode,
		message: string,
	) {
		super(message);
		this.name = "GitError";
	}
}

/**
 * Classify a failed run. The stderr snippet surfaced to the client is
 * the first line only, capped, with URL-embedded credentials scrubbed —
 * git's own diagnostics for these read-only commands don't carry
 * secrets, but the message is also logged, and belt-and-braces is cheap.
 */
export function classifyFailure(result: CaptureResult, what: string): GitError {
	const stderr = result.stderr.toString("utf-8");
	if (result.timedOut) return new GitError("timeout", `${what} timed out`);
	if (/not a git repository/i.test(stderr))
		return new GitError("not-a-repo", "not a git repository");
	if (/dubious ownership|unsafe repository/i.test(stderr)) {
		return new GitError(
			"unsafe-repository",
			"Git refused this repository because its files are owned by another user (safe.directory)",
		);
	}
	const firstLine = scrubCredentials(stderr.split("\n")[0] ?? "").slice(0, 200);
	const code = result.exitCode === null ? "unknown" : String(result.exitCode);
	return new GitError(
		"git-failed",
		firstLine ? `${what} failed (exit ${code}): ${firstLine}` : `${what} failed (exit ${code})`,
	);
}

function scrubCredentials(s: string): string {
	return s.replace(/(\w+:\/\/)[^/\s@]+@/g, "$1***@");
}

// ── Parsers (exported for tests) ────────────────────────────────────────────

/** NUL-separated records; a trailing partial (cut by the byte cap) is dropped. */
export function splitNulRecords(buf: Buffer, truncated: boolean): string[] {
	const text = buf.toString("utf-8");
	const parts = text.split("\0");
	// A complete output ends in NUL → last element is "". If it isn't,
	// the output was cut mid-record (or had no terminator at all).
	const last = parts.pop();
	if (last !== undefined && last !== "" && !truncated) parts.push(last);
	return parts;
}

export interface NumStat {
	additions: number | null;
	deletions: number | null;
	binary: boolean;
}

/** `git diff --numstat -z` → Map by (new) path. */
export function parseNumstat(records: string[]): Map<string, NumStat> {
	const out = new Map<string, NumStat>();
	for (let i = 0; i < records.length; i++) {
		const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i] as string);
		if (!m) continue;
		let path = m[3] as string;
		if (path === "") {
			// Rename/copy: `a\td\t\0old\0new\0`
			i += 2;
			path = records[i] ?? "";
			if (path === "") continue;
		}
		const binary = m[1] === "-";
		out.set(path, {
			additions: binary ? null : Number.parseInt(m[1] as string, 10),
			deletions: binary ? null : Number.parseInt(m[2] as string, 10),
			binary,
		});
	}
	return out;
}

export interface GitChange {
	area: GitArea;
	/** Single porcelain letter: M A D R C T U ? (conflicts carry the XY pair in `xy`). */
	status: string;
	xy: string;
	path: string;
	oldPath: string | null;
	additions: number | null;
	deletions: number | null;
	binary: boolean;
	/** Credential-shaped path (same list as the Files view): listed, diff refused. */
	restricted: boolean;
}

export interface GitBranchInfo {
	branch: string | null;
	detached: boolean;
	head: string | null;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
}

export interface ParsedStatus extends GitBranchInfo {
	changes: GitChange[];
}

/** `git status --porcelain=v2 --branch -z` records → branch info + changes. */
export function parsePorcelainV2(records: string[]): ParsedStatus {
	const info: GitBranchInfo = {
		branch: null,
		detached: false,
		head: null,
		upstream: null,
		ahead: null,
		behind: null,
	};
	const changes: GitChange[] = [];
	const push = (area: GitArea, status: string, xy: string, path: string, oldPath: string | null) =>
		changes.push({
			area,
			status,
			xy,
			path,
			oldPath,
			additions: null,
			deletions: null,
			binary: false,
			restricted: isRestrictedPath(path),
		});

	for (let i = 0; i < records.length; i++) {
		const rec = records[i] as string;
		if (rec.startsWith("# ")) {
			const [key, ...rest] = rec.slice(2).split(" ");
			const value = rest.join(" ");
			if (key === "branch.oid") info.head = value === "(initial)" ? null : value;
			else if (key === "branch.head") {
				if (value === "(detached)") info.detached = true;
				else info.branch = value;
			} else if (key === "branch.upstream") info.upstream = value;
			else if (key === "branch.ab") {
				const ab = /^\+(\d+) -(\d+)$/.exec(value);
				if (ab) {
					info.ahead = Number.parseInt(ab[1] as string, 10);
					info.behind = Number.parseInt(ab[2] as string, 10);
				}
			}
			continue;
		}
		const type = rec[0];
		if (type === "?") {
			push("untracked", "?", "??", rec.slice(2), null);
		} else if (type === "1") {
			// 1 XY sub mH mI mW hH hI <path>
			const f = splitFields(rec, 8);
			if (!f) continue;
			const xy = f.fields[1] as string;
			addTracked(push, xy, f.rest, null);
		} else if (type === "2") {
			// 2 XY sub mH mI mW hH hI Xscore <path>\0<origPath>
			const f = splitFields(rec, 9);
			if (!f) continue;
			const xy = f.fields[1] as string;
			i += 1;
			const orig = records[i] ?? null;
			addTracked(push, xy, f.rest, orig === "" ? null : orig);
		} else if (type === "u") {
			// u XY sub m1 m2 m3 mW h1 h2 h3 <path>
			const f = splitFields(rec, 10);
			if (!f) continue;
			push("conflict", "U", f.fields[1] as string, f.rest, null);
		}
		// "!" (ignored) is never requested; unknown record types are skipped.
	}
	return { ...info, changes };
}

type Push = (
	area: GitArea,
	status: string,
	xy: string,
	path: string,
	oldPath: string | null,
) => void;

function addTracked(push: Push, xy: string, path: string, oldPath: string | null): void {
	const x = xy[0] ?? ".";
	const y = xy[1] ?? ".";
	if (x !== ".") push("staged", x, xy, path, oldPath);
	// A rename's worktree-side change is against the NEW path.
	if (y !== ".") push("unstaged", y, xy, path, null);
}

/** First `n` space-separated fields, then the remainder (a path may contain spaces). */
function splitFields(rec: string, n: number): { fields: string[]; rest: string } | null {
	const fields: string[] = [];
	let pos = 0;
	for (let k = 0; k < n; k++) {
		const sp = rec.indexOf(" ", pos);
		if (sp === -1) return null;
		fields.push(rec.slice(pos, sp));
		pos = sp + 1;
	}
	return { fields, rest: rec.slice(pos) };
}

/** Fold numstat line counts into the status entries (by area + path). */
export function attachNumstat(
	changes: GitChange[],
	staged: Map<string, NumStat>,
	unstaged: Map<string, NumStat>,
): void {
	for (const c of changes) {
		const stat =
			c.area === "staged"
				? staged.get(c.path)
				: c.area === "unstaged" || c.area === "conflict"
					? unstaged.get(c.path)
					: undefined;
		if (stat) {
			c.additions = stat.additions;
			c.deletions = stat.deletions;
			c.binary = stat.binary;
		}
	}
}

export interface GitCommit {
	hash: string;
	shortHash: string;
	author: string;
	/** ISO-8601 author date. */
	date: string;
	subject: string;
}

// Field separator inside one `git log -z` record. Unit separator: not a
// byte a sane subject contains, and the subject is the LAST field so an
// adversarial one with embedded \x1f only garbles its own text.
const LOG_FS = "\x1f";
export const LOG_FORMAT = `%H${LOG_FS}%h${LOG_FS}%an${LOG_FS}%aI${LOG_FS}%s`;

export function parseLog(records: string[]): GitCommit[] {
	const out: GitCommit[] = [];
	for (const rec of records) {
		const parts = rec.split(LOG_FS);
		if (parts.length < 5) continue;
		const [hash, shortHash, author, date, ...subject] = parts;
		if (!/^[0-9a-f]{40,64}$/.test(hash as string)) continue;
		out.push({
			hash: hash as string,
			shortHash: shortHash as string,
			author: author as string,
			date: date as string,
			subject: subject.join(LOG_FS),
		});
	}
	return out;
}

/** True when the patch says git treated the file as binary. */
export function isBinaryPatch(patch: string): boolean {
	return /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);
}

/** Cut a truncated patch back to its last complete line. */
export function trimToLastLine(text: string): string {
	const nl = text.lastIndexOf("\n");
	return nl === -1 ? "" : text.slice(0, nl + 1);
}

/** `find -print0` output `./proj/.git` → `proj`, sorted, capped. */
export function parseCandidates(records: string[]): string[] {
	const out: string[] = [];
	for (const r of records) {
		const m = /^\.\/([^/]+)\/\.git$/.exec(r);
		if (m && !out.includes(m[1] as string)) out.push(m[1] as string);
	}
	return out.sort().slice(0, GIT_MAX_CANDIDATES);
}

// ── High-level operations ───────────────────────────────────────────────────

export type GitStatusResult =
	| { repo: false; candidates: string[] }
	| ({
			repo: true;
			/** Workspace-relative repo root ("" = workspace root). */
			root: string;
			truncated: boolean;
	  } & ParsedStatus);

/** Throws GitError on timeout / unexpected git failure. */
export async function getGitStatus(runner: GitRunner, dir: string): Promise<GitStatusResult> {
	// All four are independent reads; parallel keeps a refresh at one
	// round-trip's latency instead of four.
	const [status, cached, work, prefix] = await Promise.all([
		runner.run(
			gitArgv(dir, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"),
			GIT_STATUS_MAX_BYTES,
		),
		runner.run(
			gitArgv(dir, "diff", "--cached", "--numstat", "-z", "-M", ...DIFF_SAFE_ARGS),
			GIT_STATUS_MAX_BYTES,
		),
		runner.run(
			gitArgv(dir, "diff", "--numstat", "-z", "-M", ...DIFF_SAFE_ARGS),
			GIT_STATUS_MAX_BYTES,
		),
		runner.run(gitArgv(dir, "rev-parse", "--show-prefix"), 64 * 1024),
	]);
	if (status.exitCode !== 0) {
		const err = classifyFailure(status, "git status");
		if (err.code !== "not-a-repo") throw err;
		// Only the workspace root offers candidates: one level down is
		// where `git clone <url>` from the terminal lands a repo.
		const candidates = dir === "" ? await findRepoCandidates(runner) : [];
		return { repo: false, candidates };
	}
	const parsed = parsePorcelainV2(splitNulRecords(status.stdout, status.truncated));
	// numstat failing (e.g. a corrupt index) degrades to "no counts"
	// rather than failing the whole view.
	const stagedStats =
		cached.exitCode === 0
			? parseNumstat(splitNulRecords(cached.stdout, cached.truncated))
			: new Map();
	const workStats =
		work.exitCode === 0 ? parseNumstat(splitNulRecords(work.stdout, work.truncated)) : new Map();
	attachNumstat(parsed.changes, stagedStats, workStats);
	let truncated = status.truncated;
	if (parsed.changes.length > GIT_MAX_STATUS_FILES) {
		parsed.changes.length = GIT_MAX_STATUS_FILES;
		truncated = true;
	}
	// `--show-prefix` is "" at the repo root, "src/" inside it: the root
	// is `dir` minus that suffix. Diff pathspecs are repo-root-relative
	// (`:(top)`), so the client re-targets at `root` when they differ.
	const prefixStr = prefix.exitCode === 0 ? prefix.stdout.toString("utf-8").replace(/\n$/, "") : "";
	let root = dir;
	if (prefixStr !== "" && `${dir}/`.endsWith(prefixStr)) {
		root = dir.slice(0, dir.length + 1 - prefixStr.length).replace(/\/$/, "");
	}
	return { repo: true, root, truncated, ...parsed };
}

async function findRepoCandidates(runner: GitRunner): Promise<string[]> {
	// `-P` (default): symlinks are not followed, so a link to / can't turn
	// this into a filesystem walk. Depth exactly 2 = `./<dir>/.git`.
	const res = await runner.run(
		["find", ".", "-mindepth", "2", "-maxdepth", "2", "-name", ".git", "-print0"],
		256 * 1024,
	);
	// A `find` that can't read some subdir exits 1 but still prints the
	// rest — use whatever came out.
	return parseCandidates(splitNulRecords(res.stdout, res.truncated));
}

export interface GitDiffResult {
	path: string;
	area: GitArea;
	patch: string;
	truncated: boolean;
	binary: boolean;
}

export async function getGitDiff(
	runner: GitRunner,
	dir: string,
	req: { path: string; oldPath: string | null; area: GitArea },
): Promise<GitDiffResult> {
	// `:(top,literal)`: repo-root-relative (not cwd-relative) and no glob
	// expansion — `*.ts` names the file literally called `*.ts`. A leading
	// `-` can't be an option after `--`, and `:` can't start pathspec
	// magic of the client's choosing because the magic prefix is ours.
	const spec = (p: string) => `:(top,literal)${p}`;
	let argv: string[];
	let okExit: number[];
	if (req.area === "untracked") {
		// Untracked files have no index side to diff against: compare the
		// worktree file to /dev/null. `--no-index` takes plain paths
		// relative to the cwd, which the route pins to the repo root.
		argv = gitArgv(dir, "diff", "--no-index", ...DIFF_SAFE_ARGS, "--", "/dev/null", req.path);
		// --no-index exits 1 when the sides differ — the expected answer.
		okExit = [0, 1];
	} else {
		const specs = req.oldPath !== null ? [spec(req.oldPath), spec(req.path)] : [spec(req.path)];
		argv =
			req.area === "staged"
				? gitArgv(dir, "diff", "--cached", "-M", ...DIFF_SAFE_ARGS, "--", ...specs)
				: gitArgv(dir, "diff", ...DIFF_SAFE_ARGS, "--", ...specs);
		okExit = [0];
	}
	const res = await runner.run(argv, GIT_DIFF_MAX_BYTES);
	if (res.exitCode === null || !okExit.includes(res.exitCode)) {
		if (res.truncated && !res.timedOut) {
			// Output cap hit: git was cut mid-write, so its exit status is
			// meaningless — the head of the patch is still the answer.
		} else {
			throw classifyFailure(res, "git diff");
		}
	}
	let patch = res.stdout.toString("utf-8");
	if (res.truncated) patch = trimToLastLine(patch);
	return {
		path: req.path,
		area: req.area,
		patch,
		truncated: res.truncated,
		binary: isBinaryPatch(patch),
	};
}

export async function getGitLog(runner: GitRunner, dir: string): Promise<GitCommit[]> {
	const res = await runner.run(
		gitArgv(
			dir,
			"log",
			"-z",
			"-n",
			String(GIT_LOG_LIMIT),
			`--format=${LOG_FORMAT}`,
			"--no-decorate",
			"--no-show-signature",
		),
		GIT_LOG_MAX_BYTES,
	);
	if (res.exitCode !== 0) {
		const stderr = res.stderr.toString("utf-8");
		// Fresh `git init`: no HEAD to walk yet. Not an error for the UI.
		if (
			!res.timedOut &&
			/does not have any commits yet|bad default revision|unknown revision/i.test(stderr)
		) {
			return [];
		}
		throw classifyFailure(res, "git log");
	}
	return parseLog(splitNulRecords(res.stdout, res.truncated));
}
