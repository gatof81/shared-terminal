/**
 * recreate/layer.ts — what the stopped container's writable layer holds,
 * and whether recreating it would lose any of it (CONVERSATION.md §2.7.1,
 * precondition 6; owner decisions D2/D3).
 *
 * Only what the entrypoint itself produces is allowed, and only with its
 * exact shape: the persistence symlinks pointing at their exact workspace
 * targets, `~/.config`, the readiness sentinel, the relay log and the
 * tmux socket dir. `~/.gitconfig` is allowed only when it holds exactly
 * the session's git identity (gitIdentity writes it; recreation re-runs
 * it). The runtime artifacts Claude Code 2.1.308 leaves under /tmp are
 * allowed only in the exact shapes seen on a real daemon (`cliTmpArtifact`
 * below). Everything else blocks with a category code and a count — never
 * a path: a user's `docker diff` is content.
 */

import path from "node:path";

export type LayerCode =
	| "layer-home"
	| "layer-gitconfig-modified"
	| "layer-dotfiles"
	| "layer-tmp"
	| "layer-system";

export interface LayerChange {
	Path: string;
	/** Docker's encoding: 0 modified, 1 added, 2 deleted. */
	Kind: number;
}

export type PathKind = "dir" | "file" | "symlink" | "socket" | "other";

export interface PathStat {
	kind: PathKind;
	linkTarget?: string;
	/** Bytes, for a regular file (the archive stat's `size`). */
	size?: number;
}

export interface LayerInput {
	changes: LayerChange[];
	/** Stat of a path inside the stopped container; null when absent. */
	stat: (p: string) => Promise<PathStat | null>;
	/** Mount destinations of the container (their mount points may be in the layer). */
	mounts: string[];
	/**
	 * `~/.gitconfig` as read from the container; null when absent,
	 * "unreadable" when over GITCONFIG_MAX_BYTES or not a regular file.
	 */
	gitconfig: () => Promise<Buffer | null | "unreadable">;
	identity: { name: string; email: string } | null;
	hasDotfiles: boolean;
}

export interface LayerVerdict {
	blockers: Array<{ code: LayerCode; count: number }>;
	/** The gitconfig existed and held exactly the identity: re-run gitIdentity on N. */
	reapplyGitIdentity: boolean;
}

export const HOME = "/home/developer";
const WORKSPACE = `${HOME}/workspace`;
export const GITCONFIG = `${HOME}/.gitconfig`;
export const GITCONFIG_MAX_BYTES = 4096;
/** The session user (Dockerfile: `useradd -u 1000`); tmux names its socket dir after it. */
const SESSION_UID = 1000;

/** Symlinks the entrypoint makes, with their exact targets (entrypoint.sh). */
export const ENTRYPOINT_SYMLINKS: ReadonlyMap<string, string> = new Map([
	[`${HOME}/.npm-global`, `${WORKSPACE}/.npm-global`],
	[`${HOME}/.vscode-cli`, `${WORKSPACE}/.vscode-cli`],
	[`${HOME}/.config/gh`, `${WORKSPACE}/.config/gh`],
	[`${HOME}/.claude`, `${WORKSPACE}/.st/claude-state`],
	[`${HOME}/.claude.json`, `${WORKSPACE}/.st/claude.json`],
	[`${HOME}/.ssh`, `${WORKSPACE}/.st/ssh`],
]);
const ENTRYPOINT_DIRS: ReadonlySet<string> = new Set([`${HOME}/.config`]);
const ENTRYPOINT_FILES: ReadonlySet<string> = new Set(["/tmp/.st-ready", "/tmp/st-relay.log"]);
/**
 * Mount points Docker itself creates for `--init` (every session runs with
 * `Init: true`): docker-init is bind-mounted at /sbin/docker-init, which on
 * the Ubuntu 24.04 image resolves through the /sbin → /usr/sbin symlink.
 * `inspect().Mounts` does not list that bind, so it is named here. Seen on
 * a real daemon by realDocker.smoke.ts.
 */
const DOCKER_INIT_FILES: ReadonlySet<string> = new Set([
	"/sbin/docker-init",
	"/usr/sbin/docker-init",
]);
const TMUX_DIR = `/tmp/tmux-${SESSION_UID}`;

// ── Claude Code's runtime artifacts under /tmp ─────────────────────────────
//
// Seen in a stopped session container's layer after real uses of the pinned
// CLI 2.1.308 (`claude -p`, `--resume`, an interactive tab with Bash and a
// subagent, a tab still running at the stop), by
// session-image/test/cli-tmp-evidence.sh on CI's dockerd:
//
//   /tmp/cc-socks/                       dir
//   /tmp/cc-socks/<pid>.sock             socket (a live CLI's endpoint; stale
//                                        once the container stopped)
//   /tmp/claude-1000/                    dir
//   …/fswatch-probe-<6 alnum>/probe      dir + a 1-byte file: the CLI's own
//                                        file-watch probe, one per run
//   …/<cwd slug>/<session uuid>/tasks/   dirs
//   …/tasks/a<16 hex>.output             symlink to that subagent's transcript
//                                        `~/.claude/projects/<slug>/<uuid>/
//                                        subagents/agent-a<16 hex>.jsonl`;
//                                        the archive stat reports it resolved
//                                        through the verified `~/.claude`
//                                        symlink, so that is the form compared
//
// None of it is state a resumed conversation needs: sockets and probes are
// per-process, and a task symlink only points at the transcript, which lives
// in the workspace (~/.claude is a symlink into it) and is preserved. So
// these are allowed — each with its exact type and name shape, a symlink only
// with the one target its own path determines, a probe only at 1 byte.
// Anything else under these dirs blocks as `layer-tmp`: notably a regular
// file in `tasks/` (a background task's output is the user's content, and
// nothing shows it is disposable), another target, another uid's dir.
const CLI_SOCKS = "/tmp/cc-socks";
const CLI_TMP = `/tmp/claude-${SESSION_UID}`;
const CLI_SOCKET = /^\/tmp\/cc-socks\/\d{1,10}\.sock$/;
const CLI_PROBE_DIR = /^\/tmp\/claude-1000\/fswatch-probe-[A-Za-z0-9]{6}$/;
const CLI_PROBE = /^\/tmp\/claude-1000\/fswatch-probe-[A-Za-z0-9]{6}\/probe$/;
/** The CLI's slug of a cwd: `/` (and any other non-alphanumeric) → `-`. Only cwds in the workspace. */
const SLUG = "-home-developer-workspace(?:-[A-Za-z0-9-]+)?";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLI_PROJECT_DIRS = new RegExp(`^/tmp/claude-1000/(${SLUG})(?:/(${UUID})(?:/tasks)?)?$`);
const CLI_TASK_LINK = new RegExp(
	`^/tmp/claude-1000/(${SLUG})/(${UUID})/tasks/(a[0-9a-f]{16})\\.output$`,
);

/**
 * True when `p` is one of the CLI's runtime artifacts above with exactly its
 * expected type (and size or target). False for anything else under /tmp,
 * which then blocks.
 */
function cliTmpArtifact(p: string, st: PathStat | null): boolean {
	if (p === CLI_SOCKS || p === CLI_TMP || CLI_PROBE_DIR.test(p) || CLI_PROJECT_DIRS.test(p)) {
		return st?.kind === "dir";
	}
	if (CLI_SOCKET.test(p)) return st?.kind === "socket";
	if (CLI_PROBE.test(p)) return st?.kind === "file" && st.size === 1;
	const link = CLI_TASK_LINK.exec(p);
	if (link) {
		const [, slug, uuid, id] = link;
		return (
			st?.kind === "symlink" &&
			st.linkTarget ===
				`${WORKSPACE}/.st/claude-state/projects/${slug}/${uuid}/subagents/agent-${id}.jsonl`
		);
	}
	return false;
}

function isUnder(p: string, dir: string): boolean {
	return p === dir || p.startsWith(`${dir}/`);
}

function category(p: string): LayerCode {
	if (isUnder(p, HOME)) return "layer-home";
	if (isUnder(p, "/tmp")) return "layer-tmp";
	return "layer-system";
}

function ancestors(p: string): string[] {
	const out: string[] = [];
	let d = path.posix.dirname(p);
	while (d !== "/" && d !== ".") {
		out.push(d);
		d = path.posix.dirname(d);
	}
	return out;
}

/**
 * Strict reading of the INI that `git config --global` writes: sections
 * and `key = value` lines only. Comments, includes, continuation lines or
 * any escape this doesn't know make it unparseable (null), which blocks.
 */
export function parseGitconfig(text: string): Map<string, string[]> | null {
	const out = new Map<string, string[]>();
	let section: string | null = null;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const sec = /^\[([A-Za-z0-9.-]+)\]$/.exec(line);
		if (sec) {
			section = sec[1]!.toLowerCase();
			continue;
		}
		const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
		if (!kv || section === null) return null;
		const value = unquote(kv[2]!);
		if (value === null) return null;
		const key = `${section}.${kv[1]!.toLowerCase()}`;
		out.set(key, [...(out.get(key) ?? []), value]);
	}
	return out;
}

function unquote(v: string): string | null {
	if (!v.includes('"') && !v.includes("\\")) {
		return /[#;]/.test(v) ? null : v;
	}
	if (!(v.length >= 2 && v.startsWith('"') && v.endsWith('"'))) return null;
	let out = "";
	const body = v.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const c = body[i]!;
		if (c === '"') return null;
		if (c !== "\\") {
			out += c;
			continue;
		}
		const n = body[++i];
		if (n === '"' || n === "\\") out += n;
		else if (n === "t") out += "\t";
		else return null;
	}
	return out;
}

function gitconfigMatches(buf: Buffer, identity: { name: string; email: string }): boolean {
	const parsed = parseGitconfig(buf.toString("utf8"));
	if (!parsed) return false;
	if (parsed.size !== 2) return false;
	const name = parsed.get("user.name");
	const email = parsed.get("user.email");
	return (
		name?.length === 1 &&
		email?.length === 1 &&
		name[0] === identity.name &&
		email[0] === identity.email
	);
}

export async function classifyLayer(input: LayerInput): Promise<LayerVerdict> {
	const counts = new Map<LayerCode, number>();
	const block = (code: LayerCode) => counts.set(code, (counts.get(code) ?? 0) + 1);
	let reapplyGitIdentity = false;

	const mounts = input.mounts.map((m) => path.posix.normalize(m));
	// Directories that may show up as merely "changed" because something
	// allowed was created inside them.
	const allowedAncestors = new Set<string>();
	for (const p of [
		...ENTRYPOINT_SYMLINKS.keys(),
		...ENTRYPOINT_DIRS,
		...ENTRYPOINT_FILES,
		...DOCKER_INIT_FILES,
		TMUX_DIR,
		GITCONFIG,
		...mounts,
	]) {
		for (const a of ancestors(p)) allowedAncestors.add(a);
	}

	const verifiedSymlinks = new Set<string>();
	for (const [link, target] of ENTRYPOINT_SYMLINKS) {
		const st = await input.stat(link);
		if (st?.kind === "symlink" && st.linkTarget === target) verifiedSymlinks.add(link);
	}

	for (const ch of input.changes) {
		const p = path.posix.normalize(ch.Path);
		if (isUnder(p, WORKSPACE)) continue; // the bind mount, not the layer
		if (ch.Kind === 2) {
			// Deleted. Only what the entrypoint hid by replacing a real
			// image directory with its symlink (the image's ~/.npm-global),
			// and only once that symlink is verified exact.
			const parentLink = [...verifiedSymlinks].find((l) => p !== l && isUnder(p, l));
			if (parentLink) continue;
			block(category(p));
			continue;
		}
		if (ENTRYPOINT_SYMLINKS.has(p)) {
			if (!verifiedSymlinks.has(p)) block(category(p));
			continue;
		}
		if (p === GITCONFIG) {
			const buf = await input.gitconfig();
			if (Buffer.isBuffer(buf) && input.identity && gitconfigMatches(buf, input.identity)) {
				reapplyGitIdentity = true;
			} else {
				block("layer-gitconfig-modified");
			}
			continue;
		}
		const st = await input.stat(p);
		if (ENTRYPOINT_DIRS.has(p) || p === TMUX_DIR) {
			if (st?.kind !== "dir") block(category(p));
			continue;
		}
		if (ENTRYPOINT_FILES.has(p) || DOCKER_INIT_FILES.has(p)) {
			if (st?.kind !== "file") block(category(p));
			continue;
		}
		if (path.posix.dirname(p) === TMUX_DIR) {
			if (st?.kind !== "socket") block(category(p));
			continue;
		}
		if (ch.Kind === 1 && isUnder(p, "/tmp") && cliTmpArtifact(p, st)) continue;
		if (mounts.includes(p)) {
			// A mount point Docker created because the image lacked it.
			if (st?.kind !== "dir" && st?.kind !== "file") block(category(p));
			continue;
		}
		if (ch.Kind === 0 && allowedAncestors.has(p) && st?.kind === "dir") continue;
		block(category(p));
	}
	// Dotfiles' clone and install cannot be reproduced exactly (D3).
	if (input.hasDotfiles) block("layer-dotfiles");

	const order: LayerCode[] = [
		"layer-home",
		"layer-gitconfig-modified",
		"layer-dotfiles",
		"layer-tmp",
		"layer-system",
	];
	return {
		blockers: order
			.filter((c) => counts.has(c))
			.map((code) => ({ code, count: counts.get(code)! })),
		reapplyGitIdentity,
	};
}
