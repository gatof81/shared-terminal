/**
 * portMappings.ts — runtime container_port → host_port table for #190.
 *
 * The dispatcher (190c) parses an inbound `Host: p<container>-<sessionId>.<base>`
 * header and looks the host port up here to decide where to reverse-proxy.
 * Distinct from the *declarative* `session_configs.ports_json` (the user's
 * configured list of ports to expose) — this table holds what Docker
 * actually bound on the host after `container.start()` resolved the
 * `-p 0:<container>` request to a concrete kernel-assigned ephemeral port.
 *
 * Lifecycle:
 *   - Written by `DockerManager.spawn()` after `container.start()` (and
 *     by `reconcile()` on backend restart — the running container's
 *     bindings are still live; we just re-discover them).
 *   - Cleared by `DockerManager.kill()` and `stopContainer()` so a
 *     stopped/dead session doesn't leave the dispatcher pointing at
 *     a host port the kernel is about to recycle.
 *   - The FK ON DELETE CASCADE in `db.ts` cleans up automatically when
 *     a hard-delete drops the session row.
 */

import { d1Query } from "./db.js";

// ── Dispatch-target cache (#238) ────────────────────────────────────────────
//
// The dispatcher's hot path is `lookupDispatchTarget(sessionId, port)` —
// called per request to `https://p<port>-<sessionId>.<base>`. CLAUDE.md is
// explicit that every `d1Query` is an HTTP round-trip to Cloudflare; without
// a cache, hot-reload spam against a Vite dev server (~one request per file
// edit, plus all the asset follow-ups) burns one D1 round-trip per asset
// even though the row hasn't changed.
//
// Cache shape: `Map<sessionId, { byContainerPort, expiresAt }>` where
// `byContainerPort` is the FULL set of dispatch targets for the running
// session. We populate the whole set on first miss because:
//   - the SELECT cost of `WHERE session_id = ?` (no port filter) is the
//     same one round-trip as the per-port shape, and
//   - typical dev-loop traffic hits 2–3 ports for the same session in
//     close succession (app + WS + asset proxy), so per-port caching
//     would still incur 2–3 D1 hits where per-session caching incurs 1.
//
// Invalidation is event-driven: `setPortMappings` and `clearPortMappings`
// (the only writers, called from spawn / startContainer / reconcile / kill
// / stopContainer) call `invalidateCache` before AND after their D1 work.
// Before-and-after is belt-and-suspenders: a concurrent lookup that lands
// between the DELETE and the first INSERT in `setPortMappings` would
// otherwise re-populate the cache from the half-updated table; the
// post-write invalidate clears that.
//
// TTL is the safety net for the unusual case where someone mutates the
// table out-of-band (e.g. a manual SQL edit during debugging) — bounded
// at 30 s so an operator running an experiment doesn't have to restart
// the backend to see their change.
//
// Negative results (no row, or session not running) are NOT cached —
// the dispatcher's per-IP rate limit is the throttle for probe traffic,
// and a session that just spawned could land in the table milliseconds
// after a "miss". Caching the miss would amplify "session is starting"
// race windows into a 30-second 404 wall.

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
	byContainerPort: Map<number, DispatchTarget>;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function invalidateCache(sessionId: string): void {
	cache.delete(sessionId);
}

/** Test seam: drop every cached entry. The dispatcher tests that swap
 *  `lookupDispatchTarget` with a stub never go through the cache, but
 *  unit tests that exercise the cache directly need a clean slate per
 *  case. Not exported into the public API surface — only re-exported
 *  via the named import path the test file uses. */
export function __resetDispatchCacheForTests(): void {
	cache.clear();
}

export interface PortMapping {
	containerPort: number;
	hostPort: number;
	// #190 PR 190c — per-port auth gate stored on the mapping row so
	// the dispatcher's hot path is one indexed point read. `false` =
	// `requireAuth` + `assertOwnership` before proxying; `true` =
	// open to anyone with the URL (webhook / OAuth callback shape).
	isPublic: boolean;
}

/**
 * Subset of the join `sessions_port_mappings` ⋈ `sessions` the dispatcher
 * needs at request time. Returned by `lookupDispatchTarget` so the
 * dispatcher can authorize and forward in one query: host_port + is_public
 * + the owning user_id (for the `assertOwnership` check on private ports).
 *
 * `null` means "no row, OR session is not running" — the dispatcher's
 * 404 response collapses both cases. We deliberately do NOT distinguish
 * to keep the response shape identical for "session never existed" and
 * "session was stopped 200 ms ago", so a probe attacker can't enumerate
 * recently-active sessions.
 */
export interface DispatchTarget {
	hostPort: number;
	isPublic: boolean;
	ownerUserId: string;
}

/**
 * Replace all mappings for `sessionId` with `mappings`. D1 has no
 * multi-statement transaction primitive on the HTTP API, so this
 * sequences DELETE then per-row INSERT — emphatically NOT atomic. A
 * backend crash mid-sequence can leave the table empty (DELETE
 * succeeded, INSERTs didn't); the next spawn / reconcile rewrites it
 * cleanly, and the dispatcher's "session must be running" gate stops
 * a torn read from proxying to a stale host port in the meantime.
 */
export async function setPortMappings(sessionId: string, mappings: PortMapping[]): Promise<void> {
	// Invalidate before AND after the D1 work — see the cache header
	// comment for the concurrent-lookup race this defends against.
	invalidateCache(sessionId);
	await d1Query("DELETE FROM sessions_port_mappings WHERE session_id = ?", [sessionId]);
	for (const m of mappings) {
		await d1Query(
			"INSERT INTO sessions_port_mappings (session_id, container_port, host_port, is_public) VALUES (?, ?, ?, ?)",
			[sessionId, m.containerPort, m.hostPort, m.isPublic ? 1 : 0],
		);
	}
	invalidateCache(sessionId);
}

/**
 * Read all mappings for `sessionId`. Empty array when no row exists.
 *
 * Currently exercised only by the test suite — the dispatcher's hot
 * path uses `lookupDispatchTarget` (single-row JOIN). 190d will wire
 * a `GET /api/sessions/:id/ports` endpoint that calls this so the
 * frontend can render the per-port URL + copy-to-clipboard list on
 * the session detail view (per the issue spec). Kept exported now to
 * avoid the back-and-forth of un-exporting and re-exporting in the
 * adjacent PR. PR #223 round 5 NIT.
 */
export async function getPortMappings(sessionId: string): Promise<PortMapping[]> {
	const result = await d1Query<{ container_port: number; host_port: number; is_public: number }>(
		"SELECT container_port, host_port, is_public FROM sessions_port_mappings WHERE session_id = ? ORDER BY container_port",
		[sessionId],
	);
	return result.results.map((r) => ({
		containerPort: r.container_port,
		hostPort: r.host_port,
		isPublic: r.is_public === 1,
	}));
}

/** Drop all mappings for `sessionId`. Idempotent — no-op if none exist. */
export async function clearPortMappings(sessionId: string): Promise<void> {
	invalidateCache(sessionId);
	await d1Query("DELETE FROM sessions_port_mappings WHERE session_id = ?", [sessionId]);
	invalidateCache(sessionId);
}

/**
 * Single-query JOIN that resolves a `Host: p<container>-<sessionId>.<base>`
 * lookup to the host_port + auth-gate + owning user the dispatcher needs
 * to authorize and forward. Returns `null` when:
 *   - no mapping row exists for `(sessionId, containerPort)`, OR
 *   - the session row's status is not `running`.
 *
 * Both states collapse to `null` (and the dispatcher to 404) so a probe
 * attacker can't enumerate recently-active sessions by status-code timing.
 *
 * INNER JOIN on `sessions` because the FK CASCADE means every mapping
 * row implies a parent session row; the join filters on status without
 * a second round-trip.
 */
export async function lookupDispatchTarget(
	sessionId: string,
	containerPort: number,
): Promise<DispatchTarget | null> {
	const now = Date.now();
	const cached = cache.get(sessionId);
	if (cached && cached.expiresAt > now) {
		return cached.byContainerPort.get(containerPort) ?? null;
	}
	if (cached) {
		// Expired entry — drop before re-fetch so a concurrent invalidate
		// from `setPortMappings` doesn't race against our re-population.
		cache.delete(sessionId);
	}
	// Fetch the FULL set of dispatch targets for this session in one
	// round-trip. Same JOIN as before, minus the per-port WHERE clause —
	// the per-port lookup is satisfied from the populated map below. This
	// shape means a follow-up `lookupDispatchTarget(sessionId, otherPort)`
	// hits the cache instead of issuing a second D1 call.
	const result = await d1Query<{
		container_port: number;
		host_port: number;
		is_public: number;
		user_id: string;
	}>(
		`SELECT spm.container_port, spm.host_port, spm.is_public, s.user_id
		 FROM sessions_port_mappings spm
		 JOIN sessions s ON s.session_id = spm.session_id
		 WHERE spm.session_id = ? AND s.status = 'running'`,
		[sessionId],
	);
	if (result.results.length === 0) {
		// Not cached — see header comment. A session that just spawned
		// could land in the table milliseconds later; caching the miss
		// would extend the "session is starting" race window into a
		// 30-second wall.
		return null;
	}
	const byContainerPort = new Map<number, DispatchTarget>();
	for (const row of result.results) {
		byContainerPort.set(row.container_port, {
			hostPort: row.host_port,
			isPublic: row.is_public === 1,
			ownerUserId: row.user_id,
		});
	}
	cache.set(sessionId, { byContainerPort, expiresAt: now + CACHE_TTL_MS });
	return byContainerPort.get(containerPort) ?? null;
}

/**
 * Annotate raw inspect-output mappings with the configured `public` flag
 * looked up by container port. Container ports absent from the lookup
 * default to `false` (auth required) — the safest fallback when the
 * caller's source-of-truth (config or the prior mapping row) doesn't
 * know about a particular port. Pure helper, no D1.
 */
export function annotateWithPublic(
	raw: Array<{ containerPort: number; hostPort: number }>,
	publicByContainer: Map<number, boolean>,
): PortMapping[] {
	return raw.map((m) => ({
		...m,
		isPublic: publicByContainer.get(m.containerPort) ?? false,
	}));
}

/**
 * Parse Docker's `NetworkSettings.Ports` shape (as returned by
 * `container.inspect()`) into the PortMapping[] this module persists.
 *
 * Docker shape (only the bits we care about):
 *
 *     {
 *       "3000/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "32768" }, ...],
 *       "5500/tcp": null   // exposed but not bound (--publish-all=false)
 *     }
 *
 * We take the FIRST non-null binding per container port — Docker can list
 * multiple host bindings (IPv4 + IPv6 entries are common), and they
 * always share the same kernel-assigned port number, so taking [0] is
 * sufficient. `null` and empty arrays are filtered out (those container
 * ports are exposed but unpublished, which would only happen if a
 * future code path sets `ExposedPorts` without `PortBindings` — not the
 * spawn path here, but the parser stays robust against it).
 *
 * The container-port half is `"<num>/<proto>"`; we only emit the int.
 * v1 publishes TCP only (the dispatcher in 190c is HTTP/WS); a future
 * UDP feature would extend this parser, not break it.
 *
 * Exported for the test suite.
 */
export function parseInspectPorts(
	ports: Record<string, Array<{ HostPort: string; HostIp?: string }> | null> | undefined | null,
): Array<{ containerPort: number; hostPort: number }> {
	if (!ports) return [];
	const out: Array<{ containerPort: number; hostPort: number }> = [];
	for (const [key, bindings] of Object.entries(ports)) {
		if (!bindings || bindings.length === 0) continue;
		// Match `<port>` or `<port>/<proto>`. The proto half is informational
		// only at this stage; we assume tcp.
		const m = key.match(/^(\d+)(?:\/[a-z]+)?$/);
		if (!m) continue;
		const containerPort = Number(m[1]);
		const hostPort = Number(bindings[0]!.HostPort);
		// Defensive against a malformed inspect response: Docker's
		// HostPort is always a stringified positive int, but a future
		// API change shouldn't crash the spawn path.
		if (
			!Number.isInteger(containerPort) ||
			containerPort <= 0 ||
			!Number.isInteger(hostPort) ||
			hostPort <= 0
		) {
			continue;
		}
		out.push({ containerPort, hostPort });
	}
	return out;
}
