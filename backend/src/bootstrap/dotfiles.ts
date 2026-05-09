/**
 * dotfiles.ts — dotfiles bootstrap stage (#191 PR 191b).
 *
 * Clones a user-supplied dotfiles repo into `~/dotfiles` inside the
 * session container, then optionally runs an install script from the
 * cloned tree. Auth credentials are shared with the main repo
 * (`config.auth`): the user has one identity per session, so a
 * private dotfiles URL relies on the same PAT or SSH key the main
 * repo uses. A per-repo identity is a follow-up (#189).
 *
 * The clone reuses the same three-mode logic as `cloneRepo.ts`:
 *   - `auth.pat` set + https URL → GIT_ASKPASS-shimmed clone
 *   - `auth.ssh` set + git@ URL  → key-on-disk + StrictHostKeyChecking=yes
 *   - neither set + https URL    → anonymous clone
 *
 * Mismatched URL/auth combinations fail loudly inside the bash
 * script — the schema-side cross-field validation that `repo` has
 * deliberately doesn't apply here (DotfilesSpec note in
 * sessionConfig.ts) because the auth blob is shared. The 191b
 * runner is the right layer to surface the mismatch via a clear
 * exit code + streamed error message.
 *
 * The install script (when set) runs from inside the cloned tree
 * via `bash <installScript>`. A non-zero exit aborts the bootstrap.
 */

import type { DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";
import type { AuthInput, DotfilesInput } from "../sessionConfig.js";
import { type AuthStored, decryptStoredAuth, KNOWN_HOSTS_DEFAULT } from "../sessionConfig.js";
import { KNOWN_HOSTS_DEFAULT_BUNDLE } from "./knownHosts.js";

const CONTAINER_DOTFILES_DIR = "/home/developer/dotfiles";

interface RunDotfilesArgs {
	sessionId: string;
	dotfiles: DotfilesInput | null | undefined;
	storedAuth: AuthStored | null | undefined;
	docker: DockerManager;
	onOutput?: (chunk: string) => void;
	signal?: AbortSignal;
}

export class DotfilesAuthMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DotfilesAuthMismatchError";
	}
}

const HTTPS_URL = /^https:\/\/[^@\s]+$/;
const SSH_URL = /^git@/;

/**
 * Returns `{ exitCode: 0 }` and skips when `dotfiles` is null /
 * undefined. Otherwise: clone the repo, optionally run the install
 * script. Returns the first non-zero exit code (or 0 on success).
 */
export async function runDotfiles(args: RunDotfilesArgs): Promise<{ exitCode: number }> {
	const { dotfiles, storedAuth, sessionId, docker, onOutput, signal } = args;
	if (!dotfiles) return { exitCode: 0 };

	const decrypted: AuthInput = storedAuth ? decryptStoredAuth(storedAuth) : {};
	const isHttps = HTTPS_URL.test(dotfiles.url);
	const isSsh = SSH_URL.test(dotfiles.url);

	logger.info(
		`[dotfiles] session ${sessionId}: cloning ${dotfiles.url} (ref=${dotfiles.ref ?? "<HEAD>"}, install=${dotfiles.installScript ?? "<none>"})`,
	);

	// Pick the auth mode from the URL shape + what's available in the
	// shared auth blob. The mode determines which bash script body to
	// run. Mismatched URL/auth combinations are caught here as a
	// loud throw — the schema's cross-field check doesn't fire for
	// dotfiles because the auth blob is shared with the main repo.
	const env: Record<string, string> = {
		ST_URL: dotfiles.url,
		ST_REF: dotfiles.ref ?? "",
		ST_TARGET_DIR: CONTAINER_DOTFILES_DIR,
	};
	let script: string;
	if (isSsh) {
		if (!decrypted.ssh) {
			throw new DotfilesAuthMismatchError(
				"dotfiles: git@ URL requires config.auth.ssh (shared with main repo) to be set",
			);
		}
		const knownHostsContent =
			decrypted.ssh.knownHosts === KNOWN_HOSTS_DEFAULT
				? KNOWN_HOSTS_DEFAULT_BUNDLE
				: decrypted.ssh.knownHosts;
		env.ST_SSH_KEY = decrypted.ssh.privateKey;
		env.ST_KNOWN_HOSTS = knownHostsContent;
		script = DOTFILES_SSH_SCRIPT;
	} else if (isHttps) {
		if (decrypted.pat !== undefined) {
			env.ST_PAT = decrypted.pat;
			script = DOTFILES_PAT_SCRIPT;
		} else {
			script = DOTFILES_NONE_SCRIPT;
		}
	} else {
		throw new DotfilesAuthMismatchError("dotfiles: url must be https://… or git@host:path form");
	}

	const cloneResult = await docker.streamExec(
		sessionId,
		{
			cmd: ["bash", "-c", script],
			env,
			signal,
		},
		onOutput,
	);
	if (cloneResult.exitCode !== 0) return cloneResult;

	// Install script — optional. Run from inside the cloned tree so
	// the script's relative paths resolve against the dotfiles root
	// (e.g. `bash install.sh` referencing `./files/...`).
	const installScript = dotfiles.installScript;
	if (installScript === undefined || installScript === null || installScript === "") {
		return { exitCode: 0 };
	}
	return docker.streamExec(
		sessionId,
		{
			// argv-mode + workingDir pinned to the dotfiles tree.
			// The schema's installScript regex blocks `..` and leading
			// `/`, so the value is a clean relative path; we still pin
			// the working dir defensively.
			cmd: ["bash", "--", installScript],
			workingDir: CONTAINER_DOTFILES_DIR,
			signal,
		},
		onOutput,
	);
}

/** Anonymous-https clone (no auth). Same shape as cloneRepo's argv
 *  path but as a script for consistency with the auth'd variants. */
export const DOTFILES_NONE_SCRIPT = `set -e
ARGS=("git" "clone")
[ -n "$ST_REF" ] && ARGS+=("--branch" "$ST_REF")
ARGS+=("--" "$ST_URL" "$ST_TARGET_DIR")
"\${ARGS[@]}"
`;

/** PAT-https clone via GIT_ASKPASS shim. Mirrors cloneRepo.PAT_CLONE_SCRIPT.
 *
 *  `unset ST_PAT` runs AFTER the clone, NOT before it. The askpass
 *  shim is invoked as a child process by git and reads `$ST_PAT`
 *  from its inherited environment; unsetting it before the clone
 *  would make the shim print an empty token and break auth.
 *  Placing the unset after clears the var from the bash process
 *  for any subsequent operation in the same exec context (none in
 *  this script today; defensive against a future edit that adds
 *  one). PR #218 round 2 NIT flagged the inconsistency with
 *  DOTFILES_SSH_SCRIPT (which can unset BEFORE git because the
 *  key has already been written to disk by then and git reads
 *  from the file, not the env). */
export const DOTFILES_PAT_SCRIPT = `set -e
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
export GIT_TERMINAL_PROMPT=0
ARGS=("git" "clone")
[ -n "$ST_REF" ] && ARGS+=("--branch" "$ST_REF")
ARGS+=("--" "$ST_URL" "$ST_TARGET_DIR")
"\${ARGS[@]}"
unset ST_PAT
`;

/** SSH clone. Reuses ~/.ssh/id_ed25519 and ~/.ssh/known_hosts the
 *  main repo's clone already wrote (shared per the issue spec) —
 *  but we re-write them here too in case dotfiles runs BEFORE the
 *  main repo clone in the pipeline. The order is currently
 *  gitIdentity → repo → dotfiles, so the main clone has already
 *  written the keys; the re-write is idempotent (same bytes).
 *  StrictHostKeyChecking=yes mirrors cloneRepo.SSH_CLONE_SCRIPT. */
export const DOTFILES_SSH_SCRIPT = `set -e
mkdir -p ~/.ssh
chmod 700 ~/.ssh
printf '%s' "$ST_SSH_KEY" > ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
printf '%s\\n' "$ST_KNOWN_HOSTS" > ~/.ssh/known_hosts
chmod 644 ~/.ssh/known_hosts
unset ST_SSH_KEY ST_KNOWN_HOSTS
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=yes"
ARGS=("git" "clone")
[ -n "$ST_REF" ] && ARGS+=("--branch" "$ST_REF")
ARGS+=("--" "$ST_URL" "$ST_TARGET_DIR")
"\${ARGS[@]}"
`;
