/**
 * portMappings.ts — runtime "which container ports are exposed" table for #190.
 *
 * The dispatcher (190c) parses an inbound `Host: p<container>-<sessionId>.<base>`
 * header and looks the target up here to decide whether to reverse-proxy and
 * with what auth gate. Since the direct-container-proxying switch the dispatcher
 * forwards to `http://<containerName>:<containerPort>` over the shared
 * user-defined network (`SESSIONS_NETWORK`) — there is no published host port
 * anymore, so this table is now a denormalised copy of the *declarative*
 * `session_configs.ports_json` (container_port + is_public) joined against the
 * live session row. It exists so the dispatcher's hot path is one indexed point
 * read instead of a JSON parse of the config blob on every proxied request.
 *
 * Lifecycle:
 *   - Written from config by `DockerManager.spawn()` / `startContainer()` /
 *     `reconcile()` (via `mappingsFromConfig`), and live-rewritten by
 *     `PATCH /api/sessions/:id/ports` when an owner edits the exposed set.
 *   - Cleared by `DockerManager.kill()` and `stopContainer()` so a
 *     stopped/dead session can't be proxied to.
 *   - The FK ON DELETE CASCADE in `db.ts` cleans up automatically when
 *     a hard-delete drops the session row.
 *
 * NOTE: the `host_port` column is vestigial (kept `NOT NULL`, written = the
 * container port). It is no longer read by the dispatcher; dropping it is a
 * deferred table-rebuild ticket.
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
// (#299) Before-and-after still leaves one race: a lookup whose SELECT was
// ALREADY IN FLIGHT (holding rows read before the write) can `cache.set`
// those stale rows AFTER the writer's post-write invalidate — re-publishing
// them for up to the TTL. The security-relevant case is a port the owner
// just flipped `public:true -> false` via PATCH /ports staying cached as
// public (unauthenticated) for 30 s. `invalidateCache` therefore also bumps
// a monotonic `writeEpoch`; `lookupDispatchTarget` snapshots it before its
// SELECT and skips the populate if it moved across the await.
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

/** Exported for the test suite — the TTL-expiry test pins behaviour
 *  against this value rather than a magic 30_001 literal that would
 *  silently coast through a future TTL change. */
export const CACHE_TTL_MS = 30_000;

interface CacheEntry {
	byContainerPort: Map<number, DispatchTarget>;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Monotonic write counter (#299) — see the cache header comment. A single
// global counter, not per-session: an invalidate for an unrelated session
// also makes an in-flight lookup skip its populate, but that only costs an
// occasional extra D1 round-trip (the data wasn't actually stale), and
// writes are session-lifecycle events (spawn / stop / kill / reconcile /
// PATCH ports) — rare next to dispatch reads. The global counter keeps the
// bookkeeping to one number with no per-session memory growth.
let writeEpoch = 0;

function invalidateCache(sessionId: string): void {
	cache.delete(sessionId);
	writeEpoch++;
}

/** Test seam: drop every cached entry. The dispatcher tests that swap
 *  `lookupDispatchTarget` with a stub never go through the cache, but
 *  unit tests that exercise the cache directly need a clean slate per
 *  case. Not exported into the public API surface — only re-exported
 *  via the named import path the test file uses. */
export function __resetDispatchCacheForTests(): void {
	cache.clear();
	// Reset the write epoch too so each test gets a genuine clean slate —
	// the seam's contract is "as if freshly loaded".
	writeEpoch = 0;
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
 * dispatcher can authorize and forward in one query: the target container's
 * name + is_public + the owning user_id (for the `assertOwnership` check on
 * private ports).
 *
 * `containerName` is the Docker `--name` (`st-<sid[:12]>`) — the dispatcher
 * proxies to `http://<containerName>:<containerPort>` over the shared
 * user-defined network (`SESSIONS_NETWORK`), resolved by Docker's embedded
 * DNS. We no longer publish per-port host ports (`-p 0:<container>`), so the
 * vestigial `sessions_port_mappings.host_port` column is not read here.
 *
 * `null` means "no row, OR session is not running" — the dispatcher's
 * 404 response collapses both cases. We deliberately do NOT distinguish
 * to keep the response shape identical for "session never existed" and
 * "session was stopped 200 ms ago", so a probe attacker can't enumerate
 * recently-active sessions.
 */
export interface DispatchTarget {
	containerName: string;
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
		// Expired entry — drop before the await so an empty D1 result
		// (session stopped, no mappings) leaves a clean map. Without
		// this, the empty-result branch below returns null without
		// touching the cache, and the stale expired entry would
		// linger forever for any session that's been stopped without
		// a paired `clearPortMappings` invalidation having fired.
		cache.delete(sessionId);
	}
	// Snapshot the write epoch BEFORE the await (#299). If any writer
	// invalidates while the SELECT below is in flight, `writeEpoch` moves and
	// we skip the cache populate — the rows we just read may already be
	// superseded (e.g. a public->private flip that landed mid-SELECT). Read
	// here, while still synchronous, so no writer can interleave before the
	// snapshot.
	const epochAtRead = writeEpoch;
	// Fetch the FULL set of dispatch targets for this session in one
	// round-trip. Same JOIN as before, minus the per-port WHERE clause —
	// the per-port lookup is satisfied from the populated map below. This
	// shape means a follow-up `lookupDispatchTarget(sessionId, otherPort)`
	// hits the cache instead of issuing a second D1 call.
	const result = await d1Query<{
		container_port: number;
		container_name: string;
		is_public: number;
		user_id: string;
	}>(
		`SELECT spm.container_port, s.container_name, spm.is_public, s.user_id
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
			containerName: row.container_name,
			isPublic: row.is_public === 1,
			ownerUserId: row.user_id,
		});
	}
	// Only populate if no writer invalidated during the SELECT above. A moved
	// epoch means a setPortMappings/clearPortMappings landed mid-flight and
	// these rows may be stale; skipping the set just makes the next lookup
	// re-fetch (the result we return to THIS caller is still served — it's
	// at worst as fresh as a request that arrived a moment earlier).
	if (writeEpoch === epochAtRead) {
		cache.set(sessionId, { byContainerPort, expiresAt: now + CACHE_TTL_MS });
	}
	return byContainerPort.get(containerPort) ?? null;
}

/**
 * Build the runtime mapping rows directly from the session's declarative
 * `config.ports[]` — the source of truth now that the dispatcher proxies to
 * the container by name over the shared network instead of to a kernel-
 * assigned host port. There is no `inspect()` round-trip and no ephemeral
 * host port to discover: a declared port IS the mapping.
 *
 * `host_port` is vestigial (the column is kept `NOT NULL` to avoid a
 * destructive table rebuild — see `db.ts`); we write the container port into
 * it so the column stays populated and any legacy reader sees a sane value.
 * Pure helper, no D1.
 */
export function mappingsFromConfig(
	ports: ReadonlyArray<{ container: number; public: boolean }>,
): PortMapping[] {
	return ports.map((p) => ({
		containerPort: p.container,
		hostPort: p.container,
		isPublic: p.public,
	}));
}
