// ── Docker answers and reserved container names ────────────────────────────

/**
 * The suffixes `-old-<ts>` and `-new-<ts>` on a canonical `st-<sid[:12]>`
 * were reserved for the (removed) container recreation; containers left
 * under those names may still exist on a host and still belong to a
 * session. The 12-char prefix of a session UUID keeps its first dash
 * (`3f2a9c1b-4d5`), so this is the pattern real names follow; a name that
 * does not match exactly is never touched.
 */
export const RESERVED_NAME_RE = /^st-([0-9a-f]{8}-[0-9a-f]{3})-(old|new)-([0-9]+)$/;

export function isNotFound(err: unknown): boolean {
	return (err as { statusCode?: number } | null)?.statusCode === 404;
}

/**
 * Docker answers `stop` on a container that is not running with 304 Not
 * Modified. Together with 404 these are the ONLY answers that mean "the
 * work is already done"; a 5xx, a 409 or a socket error (`ECONNREFUSED`,
 * `EACCES` — docker-modem passes those through without a `statusCode`)
 * means the daemon did not confirm anything, and the caller must not
 * record the container as stopped or gone.
 */
export function isNotModified(err: unknown): boolean {
	return (err as { statusCode?: number } | null)?.statusCode === 304;
}
