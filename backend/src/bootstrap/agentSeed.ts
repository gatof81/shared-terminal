/**
 * agentSeed.ts — agent config seed bootstrap stage (#191 PR 191b).
 *
 * Writes the user's `settings.json` and/or `CLAUDE.md` content into
 * `~/.claude/` inside the session container so the Claude CLI starts
 * up with the operator's preferred config + project notes already in
 * place.
 *
 * Both fields are independent — the user can configure either one,
 * both, or neither. Empty / absent fields skip the corresponding
 * file write (so an existing file in the bind-mounted workspace
 * isn't clobbered with an empty body on a re-spawn).
 *
 * Both values reach the bash script via env vars, never argv. The
 * 256 KiB byte cap (schema-enforced) keeps either body from ballooning
 * the docker exec's env block beyond what the kernel accepts.
 */

import type { DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";
import type { AgentSeedInput } from "../sessionConfig.js";

interface RunAgentSeedArgs {
	sessionId: string;
	agentSeed: AgentSeedInput | null | undefined;
	docker: DockerManager;
	onOutput?: (chunk: string) => void;
	signal?: AbortSignal;
}

/**
 * Returns `{ exitCode: 0 }` and skips when `agentSeed` is null /
 * undefined / has neither field set. Otherwise writes the configured
 * file(s) and returns the bash script's exit code.
 */
export async function runAgentSeed(args: RunAgentSeedArgs): Promise<{ exitCode: number }> {
	const { agentSeed, sessionId, docker, onOutput, signal } = args;
	if (!agentSeed) return { exitCode: 0 };
	const settings = agentSeed.settings ?? "";
	const claudeMd = agentSeed.claudeMd ?? "";
	if (settings === "" && claudeMd === "") return { exitCode: 0 };

	logger.info(
		`[agentSeed] session ${sessionId}: settings=${settings.length > 0 ? "set" : "skip"} claudeMd=${claudeMd.length > 0 ? "set" : "skip"}`,
	);

	const env: Record<string, string> = {
		ST_SETTINGS: settings,
		ST_CLAUDE_MD: claudeMd,
	};

	return docker.streamExec(
		sessionId,
		{
			cmd: ["bash", "-c", AGENT_SEED_SCRIPT],
			env,
			signal,
		},
		onOutput,
	);
}

/**
 * Bash script body. Both writes are conditional via `[ -n "$VAR" ]`
 * so an unset field is a no-op, NOT an "empty file" overwrite of
 * whatever was already there. `printf '%s' …` (no trailing `\n`)
 * preserves the user's bytes exactly — they pasted the content,
 * we trust it. After the writes, `unset` keeps the secrets out of
 * any child process started later in the same exec context (lower
 * blast radius even though these aren't strictly secrets).
 *
 * Exported for the unit-test that pins the script shape so a future
 * edit can't drop the `mkdir -p ~/.claude` (which would let the
 * write fail if `~/.claude` doesn't already exist) or the
 * conditional guards.
 */
export const AGENT_SEED_SCRIPT = `set -e
mkdir -p ~/.claude
chmod 755 ~/.claude
if [ -n "$ST_SETTINGS" ]; then
  printf '%s' "$ST_SETTINGS" > ~/.claude/settings.json
  chmod 644 ~/.claude/settings.json
fi
if [ -n "$ST_CLAUDE_MD" ]; then
  printf '%s' "$ST_CLAUDE_MD" > ~/.claude/CLAUDE.md
  chmod 644 ~/.claude/CLAUDE.md
fi
unset ST_SETTINGS ST_CLAUDE_MD
`;
