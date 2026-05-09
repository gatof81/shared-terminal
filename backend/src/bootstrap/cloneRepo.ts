/**
 * cloneRepo.ts — repo-clone bootstrap step (#188 PR 188c + 188d).
 *
 * Runs `git clone` inside the freshly-spawned session container BEFORE
 * postCreate fires, so a configured `repo` is in place by the time
 * the user's hook (or first interactive command) runs. Output streams
 * to the same WS broadcaster as postCreate.
 *
 * Three auth modes (188d wires PAT and SSH on top of 188c's "none"):
 *
 *   - `auth: "none"` — anonymous HTTPS clone. Pure argv invocation
 *     (no shell), single `streamExec` call.
 *
 *   - `auth: "pat"` — HTTPS clone authenticated by a personal access
 *     token. The PAT NEVER appears in argv (process listings) or in
 *     the resulting `.git/config`. Implementation: write a small
 *     `GIT_ASKPASS` shim to `/tmp`, point `GIT_ASKPASS` at it, pass
 *     the PAT via env var (`ST_PAT`). Git invokes the askpass shim
 *     when it needs credentials; the shim prints them, git uses
 *     them, and the URL stored in `origin` is the public form. The
 *     askpass file is shredded on exit so a process snooping the
 *     filesystem after the clone finds nothing.
 *
 *   - `auth: "ssh"` — SSH clone with `git@host:path` URL. The user's
 *     private key is written to `~/.ssh/id_ed25519` (mode 0600), the
 *     known_hosts content (bundled defaults or a custom paste) is
 *     written to `~/.ssh/known_hosts`. `StrictHostKeyChecking=yes`
 *     is enforced so a hostile DNS / network can't trick the clone
 *     into trusting an attacker's host key. Both files PERSIST so
 *     the user can subsequently `git pull` / `git push` from the
 *     interactive shell without further setup.
 *
 * The PAT/SSH paths are bash-script-mode (multi-step setup before
 * the clone). User-supplied values (URL, ref, target, depth) reach
 * `git` as positional argv inside the script — populated via env
 * vars and expanded with bash double-quoting — so a value that
 * slipped past the schema's regex still cannot become shell meta.
 */

import type { DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";
import type { AuthInput, SessionConfigRecord } from "../sessionConfig.js";
import { decryptStoredAuth, KNOWN_HOSTS_DEFAULT } from "../sessionConfig.js";
import { KNOWN_HOSTS_DEFAULT_BUNDLE } from "./knownHosts.js";

/**
 * Path of the workspace bind mount inside the container. Mirrors the
 * value DockerManager uses on the spawn side. Hard-coded here rather
 * than imported because cloneRepo lives behind the streamExec
 * primitive — the path needs to land in the runner's argv, not in
 * the spawn config.
 */
const CONTAINER_WORKSPACE = "/home/developer/workspace";

/** Thrown when the auth blob is missing required fields at runtime
 *  (e.g. `repo.auth='pat'` but `auth.pat` not in the decrypted blob).
 *  The route's cross-field validation already blocks this on the
 *  wire, so seeing it here means a row landed via a path that
 *  bypassed `validateSessionConfig` (direct D1 write, partial-edit
 *  endpoint). */
export class CloneCredentialMissingError extends Error {
	constructor(authMode: string, missing: string) {
		super(`cloneRepo: auth='${authMode}' configured but ${missing} is missing from the auth blob`);
		this.name = "CloneCredentialMissingError";
	}
}

interface RunCloneRepoArgs {
	sessionId: string;
	config: SessionConfigRecord;
	docker: DockerManager;
	onOutput?: (chunk: string) => void;
	/** Abort signal threaded from the bootstrap runner's 10-min cap
	 *  (#191 PR 191b). Forwarded to streamExec; an in-flight clone
	 *  unblocks promptly when the timeout fires. */
	signal?: AbortSignal;
}

/**
 * Run the configured clone for `sessionId` and return its exit code.
 * Returns `{ exitCode: 0 }` and a no-op when no `repo` is configured.
 */
export async function runCloneRepo(args: RunCloneRepoArgs): Promise<{ exitCode: number }> {
	const { config, sessionId, docker, onOutput, signal } = args;
	const repo = config.repo;
	if (!repo) return { exitCode: 0 };

	const targetAbs = resolveTargetAbsPath(repo.target);
	const decrypted: AuthInput = config.auth ? decryptStoredAuth(config.auth) : {};

	logger.info(
		`[cloneRepo] session ${sessionId}: cloning ${repo.url} ` +
			`(auth=${repo.auth}, ref=${repo.ref ?? "<HEAD>"}, depth=${repo.depth ?? "full"}, target=${targetAbs})`,
	);

	if (repo.auth === "none") {
		const cloneArgv = buildCloneArgv(repo.url, repo.ref, repo.depth, targetAbs);
		// argv-mode (no shell) — user-controlled values reach `git` as
		// positional args, never as shell tokens.
		return docker.streamExec(
			sessionId,
			{ cmd: cloneArgv, workingDir: CONTAINER_WORKSPACE, signal },
			onOutput,
		);
	}

	if (repo.auth === "pat") {
		if (decrypted.pat === undefined) {
			throw new CloneCredentialMissingError("pat", "auth.pat");
		}
		// User-supplied values land in env vars; the bash script
		// references them with double-quotes so shell-meta would be
		// inert even if it slipped past the schema's regex. The PAT
		// itself is in the env block too — visible to operators with
		// `docker inspect` but NOT in argv (host-side `ps`) or
		// in `.git/config` (workspace bind mount).
		const env = patEnv(decrypted.pat, repo);
		return docker.streamExec(
			sessionId,
			{
				cmd: ["bash", "-c", PAT_CLONE_SCRIPT],
				env,
				workingDir: CONTAINER_WORKSPACE,
				signal,
			},
			onOutput,
		);
	}

	// repo.auth === "ssh"
	if (decrypted.ssh === undefined) {
		throw new CloneCredentialMissingError("ssh", "auth.ssh");
	}
	const knownHostsContent =
		decrypted.ssh.knownHosts === KNOWN_HOSTS_DEFAULT
			? KNOWN_HOSTS_DEFAULT_BUNDLE
			: decrypted.ssh.knownHosts;
	const env = sshEnv(decrypted.ssh.privateKey, knownHostsContent, repo);
	return docker.streamExec(
		sessionId,
		{
			cmd: ["bash", "-c", SSH_CLONE_SCRIPT],
			env,
			workingDir: CONTAINER_WORKSPACE,
			signal,
		},
		onOutput,
	);
}

/**
 * Resolve the in-container clone target. `target === ""` (or undefined)
 * means clone into the workspace root.
 */
export function resolveTargetAbsPath(target: string | undefined): string {
	if (target === undefined || target === "") return CONTAINER_WORKSPACE;
	return `${CONTAINER_WORKSPACE}/${target}`;
}

/**
 * Build the argv array for an `auth: "none"` clone.
 */
export function buildCloneArgv(
	url: string,
	ref: string | undefined,
	depth: number | null | undefined,
	targetAbs: string,
): string[] {
	const argv: string[] = ["git", "clone"];
	if (ref !== undefined && ref.length > 0) {
		argv.push("--branch", ref);
	}
	if (depth !== null && depth !== undefined) {
		argv.push("--depth", String(depth));
	}
	argv.push("--", url, targetAbs);
	return argv;
}

/**
 * Env block for the PAT clone. The script reads each of these from
 * `$ST_*` so user-supplied values can never become shell tokens.
 *
 * Exported for the unit-test that pins the env shape — verifying the
 * PAT lands in the env (not argv) and that user values are
 * env-encoded rather than shell-interpolated.
 */
export function patEnv(
	pat: string,
	repo: { url: string; ref?: string; depth?: number | null; target?: string },
): Record<string, string> {
	return {
		ST_PAT: pat,
		ST_URL: repo.url,
		ST_REF: repo.ref ?? "",
		ST_DEPTH: repo.depth != null ? String(repo.depth) : "",
		ST_TARGET_ABS: resolveTargetAbsPath(repo.target),
	};
}

/**
 * Env block for the SSH clone. Same env-only model as `patEnv`.
 *
 * `ST_SSH_KEY` is the plaintext private key (newline-terminated); the
 * script writes it to `~/.ssh/id_ed25519` with mode 0600. `ST_KNOWN_HOSTS`
 * is the resolved known_hosts content (bundle or paste); written to
 * `~/.ssh/known_hosts`.
 */
export function sshEnv(
	privateKey: string,
	knownHosts: string,
	repo: { url: string; ref?: string; depth?: number | null; target?: string },
): Record<string, string> {
	return {
		ST_SSH_KEY: privateKey,
		ST_KNOWN_HOSTS: knownHosts,
		ST_URL: repo.url,
		ST_REF: repo.ref ?? "",
		ST_DEPTH: repo.depth != null ? String(repo.depth) : "",
		ST_TARGET_ABS: resolveTargetAbsPath(repo.target),
	};
}

/**
 * Bash script for PAT clone. All user-controlled values are read from
 * env vars and double-quoted at use, so shell-meta in any of them is
 * inert. The askpass file is shredded on exit (success OR fail) via
 * `trap … EXIT` so a process snooping `/tmp` doesn't find the PAT.
 *
 * Note the conditional `--branch` / `--depth` handling: the variables
 * are empty strings when the user didn't configure them; the bash
 * `[ -n ]` guards skip the corresponding flag when so. Empty
 * positional values would NOT be safe — `git clone --branch ""`
 * crashes — and the empty-string convention is what `patEnv`
 * produces.
 *
 * Also exported for the unit-test that pins the script shape so a
 * future edit doesn't accidentally drop the `set -e`, the cleanup
 * trap, or the `--` separator.
 */
export const PAT_CLONE_SCRIPT = `set -e
# Cleanup runs on EXIT (success or fail) so the askpass file never
# survives the clone — the PAT it would print is gone with it.
ASKPASS_PATH=$(mktemp /tmp/git-askpass-XXXXXXXX)
cleanup() { rm -f "$ASKPASS_PATH"; }
trap cleanup EXIT
cat > "$ASKPASS_PATH" <<'ASKPASS_EOF'
#!/bin/sh
case "$1" in
  Username*) printf 'oauth2\\n' ;;
  *) printf '%s\\n' "$ST_PAT" ;;
esac
ASKPASS_EOF
chmod 700 "$ASKPASS_PATH"
export GIT_ASKPASS="$ASKPASS_PATH"
# Refuse to ever drop into an interactive prompt — without this, a
# remote that doesn't accept the PAT would block the bootstrap on
# stdin. We want a clean non-zero exit code instead.
export GIT_TERMINAL_PROMPT=0
ARGS=("git" "clone")
[ -n "$ST_REF" ] && ARGS+=("--branch" "$ST_REF")
[ -n "$ST_DEPTH" ] && ARGS+=("--depth" "$ST_DEPTH")
ARGS+=("--" "$ST_URL" "$ST_TARGET_ABS")
"\${ARGS[@]}"
`;

/**
 * Bash script for SSH clone. Persists the key + known_hosts to
 * `~/.ssh/` so the user can `git pull` / `git push` later without
 * re-supplying credentials. `StrictHostKeyChecking=yes` (the default
 * when known_hosts has matching entries) defends against a hostile
 * network swapping in an attacker's host key during the clone.
 *
 * Also exported for the unit-test that pins the script shape.
 */
export const SSH_CLONE_SCRIPT = `set -e
mkdir -p ~/.ssh
chmod 700 ~/.ssh
# printf '%s' (no trailing \\n) so a key that already ends in \\n
# isn't double-newlined; ssh-keygen tolerates either, but the
# canonical form is exactly the bytes the user pasted.
printf '%s' "$ST_SSH_KEY" > ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
printf '%s\\n' "$ST_KNOWN_HOSTS" > ~/.ssh/known_hosts
chmod 644 ~/.ssh/known_hosts
# Drop the secret env vars from the bash environment as soon as they
# land on disk so a child process started by git doesn't inherit
# them. (The docker exec env is what initially carried them; we
# can't unset that, but we can keep them out of the post-write
# scope.)
unset ST_SSH_KEY ST_KNOWN_HOSTS
# Enforce strict host-key checking explicitly. Without this, OpenSSH
# falls back to its 'ask' default — which behaves like rejection in a
# non-TTY context (\`Tty: false\` on the docker exec) but prompts in a
# TTY. The bot review of PR #215 round 1 caught this: the SSH JSDoc
# block claimed the protection without code-enforcing it. With the
# known_hosts file populated above, \`StrictHostKeyChecking=yes\` means
# "verify the server's host key against known_hosts; refuse on
# mismatch or absence". That's exactly the protection we want — a
# hostile DNS / network can't substitute its own host key during
# the clone.
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=yes"
ARGS=("git" "clone")
[ -n "$ST_REF" ] && ARGS+=("--branch" "$ST_REF")
[ -n "$ST_DEPTH" ] && ARGS+=("--depth" "$ST_DEPTH")
ARGS+=("--" "$ST_URL" "$ST_TARGET_ABS")
"\${ARGS[@]}"
`;
