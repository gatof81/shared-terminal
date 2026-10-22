/**
 * conversation/ids.ts — identifiers that end up in file paths.
 *
 * A Claude `session_id` (from the hook BODY, attacker-influenced) and a
 * Shared Terminal session id (from the `X-ST-Session` header) are both
 * used as path components under `<WORKSPACE_ROOT>/.conversations/`. They
 * are validated here as plain components — no separators, no `..`, no
 * leading dot, bounded length — and the store re-checks containment of
 * every resolved path, so a traversal has to defeat two independent
 * guards (audit round 1, B1).
 */

import path from "node:path";

/** Claude session ids are UUIDs in practice; accept a conservative superset. */
const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** ST session ids: UUID-shaped; same class as `validateTabLabel`-style ids. */
const ST_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafeClaudeSessionId(id: unknown): id is string {
	return typeof id === "string" && CLAUDE_SESSION_ID_RE.test(id) && !id.includes("..");
}

export function isSafeStSessionId(id: unknown): id is string {
	return typeof id === "string" && ST_SESSION_ID_RE.test(id) && !id.includes("..");
}

/** Throws unless `component` is a single safe path component. */
export function assertSafeComponent(component: string, what: string): void {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(component) ||
		component.includes("..") ||
		component.includes("/") ||
		component.includes("\\")
	) {
		throw new Error(`[conversation] unsafe ${what}: refusing to build a path from it`);
	}
}

/** Throws unless `target` resolves strictly inside `root`. */
export function assertContained(root: string, target: string, what: string): string {
	const rootAbs = path.resolve(root);
	const abs = path.resolve(target);
	if (abs === rootAbs || !abs.startsWith(rootAbs + path.sep)) {
		throw new Error(`[conversation] ${what} escapes its root: refusing`);
	}
	return abs;
}
