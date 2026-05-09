/**
 * gitIdentity.ts — git identity bootstrap stage (#191 PR 191b).
 *
 * Runs `git config --global user.{name,email}` inside the session
 * container BEFORE any commit-producing operation (clone-with-rebase,
 * dotfiles install, postCreate scripts that auto-commit). Without
 * this, those operations would fail with "Please tell me who you
 * are" or commit under whatever default git picked.
 *
 * The values are user-supplied (validated by the schema's regex +
 * control-char rejection) and reach `git config` as positional argv,
 * NOT via shell interpolation. A `\n` in the value would still
 * corrupt `~/.gitconfig` (INI uses newline as record separator), but
 * the schema-side `CONTROL_CHAR_PATTERN` reject closes that path
 * before the value reaches here.
 */

import type { DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";
import type { GitIdentityInput } from "../sessionConfig.js";

interface RunGitIdentityArgs {
	sessionId: string;
	identity: GitIdentityInput | null | undefined;
	docker: DockerManager;
	onOutput?: (chunk: string) => void;
	signal?: AbortSignal;
}

/**
 * Returns `{ exitCode: 0 }` and skips the stage when `identity` is
 * null/undefined. Otherwise runs two sequential `git config --global`
 * invocations and returns the first non-zero exit (or 0 if both
 * succeeded). The two-call shape matches what an interactive operator
 * would type and produces clear streamed output for the modal.
 */
export async function runGitIdentity(args: RunGitIdentityArgs): Promise<{ exitCode: number }> {
	const { identity, sessionId, docker, onOutput, signal } = args;
	if (!identity) return { exitCode: 0 };

	logger.info(
		`[gitIdentity] session ${sessionId}: setting user.name=${identity.name} user.email=${identity.email}`,
	);

	// argv-mode (no shell). The schema's control-char reject keeps
	// `\n` out, but argv-only is the load-bearing defence: any other
	// shell-meta in the value reaches `git config` as a single
	// positional argument.
	const nameResult = await docker.streamExec(
		sessionId,
		{
			cmd: ["git", "config", "--global", "user.name", identity.name],
			signal,
		},
		onOutput,
	);
	if (nameResult.exitCode !== 0) return nameResult;

	return docker.streamExec(
		sessionId,
		{
			cmd: ["git", "config", "--global", "user.email", identity.email],
			signal,
		},
		onOutput,
	);
}
