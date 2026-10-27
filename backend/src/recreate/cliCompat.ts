/**
 * recreate/cliCompat.ts — the `control-marker-incompatible` precondition
 * (CONVERSATION.md §2.7.2, §2.7.5 "Compatibilidad con el CLI").
 *
 * N runs the CLI from the workspace's `.npm-global` (the entrypoint links
 * it over the image's copy), not necessarily the image's pin: a session
 * may have updated it. `/etc/st-control` was checked against the real CLI
 * only for the versions listed here (the #455 compatibility smoke: empty,
 * with markers, unreadable, with an invalid `.json` ⇒ same hooks and
 * events, no settings warning). Nothing says another version reads that
 * directory the same way, so any other version — or one that can't be
 * read — blocks the recreation. A version is added here only after that
 * smoke has run with it.
 */

import { openWorkspaceFile, readHead } from "../workspaceFiles.js";

export const CONTROL_MARKER_VALIDATED_CLI: ReadonlySet<string> = new Set(["2.1.308"]);

/** NPM_CONFIG_PREFIX=/home/developer/.npm-global, seen from the host. */
export const WORKSPACE_CLI_PACKAGE =
	".npm-global/lib/node_modules/@anthropic-ai/claude-code/package.json";

const PACKAGE_MAX_BYTES = 64 * 1024;

/**
 * The version in the workspace CLI's package.json, read on the host
 * without following symlinks; null when it is missing, a symlink, too
 * large or not parseable — all of which block.
 */
export async function readWorkspaceCliVersion(sessionId: string): Promise<string | null> {
	const r = await openWorkspaceFile(sessionId, WORKSPACE_CLI_PACKAGE, {
		maxBytes: PACKAGE_MAX_BYTES,
	});
	if (!r.ok) return null;
	try {
		const { bytes, truncated } = await readHead(r.handle, PACKAGE_MAX_BYTES, r.size);
		if (truncated) return null;
		const v = (JSON.parse(bytes.toString("utf8")) as { version?: unknown }).version;
		return typeof v === "string" ? v : null;
	} catch {
		return null;
	} finally {
		await r.handle.close();
	}
}
