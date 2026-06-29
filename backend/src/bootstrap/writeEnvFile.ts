/**
 * writeEnvFile.ts — `.env` materialisation bootstrap stage (#277).
 *
 * When `config.writeEnvFile === true`, writes a `.env` file at
 * `/home/developer/workspace/.env` (the bind-mounted workspace root)
 * from `config.envVars`. Both `plain` and decrypted `secret` entries
 * land in the file as `KEY=VALUE` lines so the user's project tooling
 * (node's `dotenv`, python-dotenv, `docker compose --env-file`, a
 * `set -a; . .env` shell prelude) can pick them up.
 *
 * Stage ordering: this runs AFTER `cloneRepo` (so we don't drop a
 * `.env` into a directory `git clone` is about to refuse to populate)
 * and BEFORE `postCreate` (so a user's `npm install` / `pnpm i` /
 * custom hook can `source .env` or rely on `dotenv` having a real
 * file to read).
 *
 * Value escaping: every value is wrapped in single quotes with any
 * embedded single quote substituted as `'\''`. This is the universal
 * shape that:
 *   - dotenv libraries (node, python) accept and strip cleanly,
 *   - `bash`/`sh` source files accept via `set -a; . .env`,
 *   - never interprets `$VAR` / backticks / `\n` inside the value
 *     (the user's literal bytes survive verbatim — they typed them
 *     into the form expecting an exact match).
 *
 * Secret plaintext is in scope only between `decryptStoredEntries` in
 * the caller and the `docker.streamExec` Env block here; the bash
 * script unsets `$ST_ENV_CONTENT` after the write, mirroring
 * agentSeed's defensive `unset` pattern.
 *
 * SECURITY — at-rest tradeoff (#303). The written `.env` holds ALL
 * entries (`plain` values verbatim, `secret` values decrypted) as
 * cleartext on the host bind mount (`<WORKSPACE_ROOT>/<sessionId>/.env`),
 * so `secrets.ts`'s "a D1 export yields only ciphertext" guarantee no
 * longer covers the secret values once this stage is enabled. `chmod 600`
 * (below) limits in-container reads but not host-side access. And because
 * a soft `DELETE /api/sessions/:id` preserves the workspace dir, the
 * cleartext `.env` SURVIVES soft delete — only `?hard=true`
 * (purgeWorkspace) removes it. No API rewrites the file after this
 * create-time run: `PATCH /sessions/:id/env` updates only the legacy
 * `sessions.env_vars` column, not the typed `session_configs` store this
 * stage reads, and never the file on disk — so there is no rotate-in-place
 * path. That same write-once property is why we do NOT shred on soft
 * delete (it would strand a restored session without its `.env`). This is
 * the explicit, opt-in purpose of #277; the operator consequences are
 * documented in docs/SECURITY.md → "Secrets at rest".
 */

import type { DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";

interface RunWriteEnvFileArgs {
	sessionId: string;
	enabled: boolean | undefined;
	/** Decrypted entries from `decryptStoredEntries` — keyed by env-var
	 *  name. The caller decrypts so plaintext is in scope only at the
	 *  single boundary that hands bytes to `docker.streamExec`. */
	envVars: Record<string, string> | undefined;
	docker: DockerManager;
	onOutput?: (chunk: string) => void;
	signal?: AbortSignal;
}

/**
 * Returns `{ exitCode: 0 }` and skips when the toggle is off OR no
 * env vars are configured (writing an empty `.env` over a user-
 * managed one on a respawn would be a footgun). Otherwise renders
 * the file content and writes it to the workspace root.
 */
export async function runWriteEnvFile(args: RunWriteEnvFileArgs): Promise<{ exitCode: number }> {
	const { enabled, envVars, sessionId, docker, onOutput, signal } = args;
	if (enabled !== true) return { exitCode: 0 };
	if (!envVars || Object.keys(envVars).length === 0) {
		logger.info(`[writeEnvFile] session ${sessionId}: toggle on but no envVars; skipping`);
		return { exitCode: 0 };
	}

	const content = renderEnvFile(envVars);
	logger.info(
		`[writeEnvFile] session ${sessionId}: writing /home/developer/workspace/.env (${Object.keys(envVars).length} entries)`,
	);

	return docker.streamExec(
		sessionId,
		{
			cmd: ["bash", "-c", WRITE_ENV_FILE_SCRIPT],
			env: { ST_ENV_CONTENT: content },
			signal,
		},
		onOutput,
	);
}

/**
 * Render `{ KEY: value, ... }` into a `.env` file body. Order is
 * insertion order of the input record — `decryptStoredEntries` builds
 * the record by iterating the stored array, so the file order matches
 * the user's declared order in the form. One line per entry,
 * single-quoted value with `'\''` escaping for embedded apostrophes.
 *
 * Exported for the unit test that pins the rendered shape so a future
 * edit can't silently change quoting semantics (e.g. drop the single
 * quotes and start interpolating `$VAR` references inside values).
 */
export function renderEnvFile(envVars: Record<string, string>): string {
	const lines: string[] = [];
	for (const [name, value] of Object.entries(envVars)) {
		// `'` → `'\''` — close the single-quoted region, emit an escaped
		// apostrophe, reopen the single-quoted region. Standard POSIX
		// shell idiom; safe for every dotenv parser that treats single-
		// quoted values as literal.
		const escaped = value.replace(/'/g, "'\\''");
		lines.push(`${name}='${escaped}'`);
	}
	// Trailing newline so appending or sourcing the file doesn't trip
	// on a missing final EOL. Matches what most editors produce when
	// the user hand-edits a `.env`.
	return `${lines.join("\n")}\n`;
}

/**
 * Bash script body. `printf '%s' "$ST_ENV_CONTENT"` (no trailing `\n`
 * — `renderEnvFile` already appended one) preserves the rendered
 * bytes exactly. `chmod 600` because the file may carry secrets that
 * just got decrypted; the bind-mounted workspace is owned by the
 * `developer` user inside the container, so 600 means only that user
 * can read it. `unset` defends against a future edit that adds a
 * downstream stage in the same exec context picking the var back up.
 *
 * Exported for the script-shape pin test (same pattern agentSeed
 * uses for `AGENT_SEED_SCRIPT`).
 */
export const WRITE_ENV_FILE_SCRIPT = `set -e
printf '%s' "$ST_ENV_CONTENT" > /home/developer/workspace/.env
chmod 600 /home/developer/workspace/.env
unset ST_ENV_CONTENT
`;
