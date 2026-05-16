/**
 * containerStats.ts — one-shot Docker `/containers/<id>/stats` client.
 *
 * Used by the admin dashboard (#270) to surface per-session live CPU/RAM
 * usage and an aggregate "totals across all running sessions" panel.
 *
 * Design notes:
 *
 *   - `stream: false` is critical. The dockerode default streams stats
 *     forever; on a one-shot call we'd leak the socket. The
 *     non-streaming branch returns a single sample and closes.
 *
 *   - `stream:false` pre-fills `precpu_stats` with a sample taken
 *     ~1s earlier inside the daemon, so even the very first call
 *     yields a meaningful rate. The 0% guard below fires only on
 *     truly degenerate samples (sysDelta or cpuDelta non-positive) —
 *     e.g. two samples taken in the same monotonic-clock tick.
 *
 *   - A per-call timeout via `AbortController` defends the admin route
 *     against a wedged container holding the request open. On any
 *     error/timeout we return `null` and let the UI render "—" rather
 *     than 500ing the whole dashboard.
 *
 *   - Small TTL cache. The admin page fetches `/admin/sessions` (per-
 *     row usage) and `/admin/stats` (aggregate totals) in parallel —
 *     they share the same set of running containers. A 2-second TTL
 *     lets the second call piggyback on the first. Bounded at 1000
 *     entries; entries past the cap evict the oldest insertion. We do
 *     NOT cache negative results — a wedged container shouldn't be
 *     remembered as wedged across the next refresh.
 */

import type Dockerode from "dockerode";
import { logger } from "./logger.js";

// ── Public types ────────────────────────────────────────────────────────────

export interface ContainerStats {
	/** CPU usage as a percentage. 100 = 1 fully busy core. Range is
	 *  effectively [0, onlineCpus*100]; a 4-core saturated container
	 *  reports ~400. */
	cpuPercent: number;
	/** Resident bytes in use right now (cgroup `memory_stats.usage`). */
	memBytes: number;
	/** Cgroup memory limit Docker applied (`memory_stats.limit`). May be
	 *  larger than the per-session `mem_limit` cap if cgroup-v2 ceilings
	 *  the limit to host RAM when the container was created with no cap;
	 *  the UI displays this value (what's REAL) alongside the configured
	 *  cap (what was REQUESTED). */
	memLimitBytes: number;
	/** memBytes / memLimitBytes × 100. 0 when memLimitBytes is 0/missing. */
	memPercent: number;
}

// ── Internal cache ──────────────────────────────────────────────────────────

interface CacheEntry {
	fetchedAt: number;
	value: ContainerStats;
}

const STATS_TTL_MS = 2_000;
const MAX_STATS_CACHE = 1_000;
const cache = new Map<string /*containerId*/, CacheEntry>();

/** Force-evict a single container's entry. Called by the PATCH-caps
 *  route after a `docker update` so the next fetch returns a fresh
 *  sample against the new cap (the cgroup denominator changed even
 *  though usage didn't). Exported for tests too. */
export function invalidateStatsCache(containerId: string): void {
	cache.delete(containerId);
}

/** Test-only — reset the module's in-memory cache between cases. */
export function __resetStatsCacheForTests(): void {
	cache.clear();
}

// ── Stats fetch ─────────────────────────────────────────────────────────────

const PER_CALL_TIMEOUT_MS = 3_000;

/**
 * Fetch a one-shot stats sample for `containerId`. Returns `null` on
 * any failure (timeout, no-such-container, malformed response,
 * dockerode error). Callers MUST handle null as "stats not available"
 * — there is no retry / throw path.
 *
 * The Docker daemon's response shape is documented but stable enough
 * that we narrow at the boundary rather than runtime-validating every
 * field. Missing critical fields collapse to 0 via the `?? 0` falls
 * below, which is the same shape as a freshly-started container — the
 * caller can't distinguish "0% real" from "no sample yet" but that
 * matches the daemon's own behaviour.
 */
export async function getContainerStats(
	docker: Dockerode,
	containerId: string,
): Promise<ContainerStats | null> {
	// Cache hit — return the prior sample if still fresh. We re-check
	// the TTL on read (not via a sweeper) because the cache is small
	// and the read path is the hot one.
	const cached = cache.get(containerId);
	if (cached !== undefined && Date.now() - cached.fetchedAt < STATS_TTL_MS) {
		return cached.value;
	}

	let timer: NodeJS.Timeout | undefined;
	const ac = new AbortController();
	const timeoutPromise = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			ac.abort();
			resolve(null);
		}, PER_CALL_TIMEOUT_MS);
	});

	try {
		// dockerode's `stats({ stream: false })` returns a single object
		// (NOT a stream). The `abortSignal` second arg is supported but
		// not in older type defs — pass via `as` to keep tsc happy
		// across versions. If the timeout fires before dockerode resolves,
		// `Promise.race` returns null and we never read `statsPromise`.
		const statsPromise = (
			docker.getContainer(containerId).stats as unknown as (opts: {
				stream: false;
				abortSignal?: AbortSignal;
			}) => Promise<RawDockerStats>
		)({ stream: false, abortSignal: ac.signal });

		const raw = await Promise.race([statsPromise, timeoutPromise]);
		if (raw === null) {
			// Timeout branch — `statsPromise` is now rejected/abandoned;
			// it would have logged its own warning when the next event
			// loop tick handled the abort, but we own the surface here.
			logger.warn(
				`[containerStats] timed out after ${PER_CALL_TIMEOUT_MS}ms for container ${containerId}`,
			);
			return null;
		}

		const value = computeStats(raw);
		// Delete-then-insert so a refreshed entry moves to the youngest
		// insertion position — otherwise Map keeps it at its original
		// slot and an active container could get evicted before an
		// unused one. Same pattern the ownership cache uses
		// (sessionManager.ts, see CLAUDE.md "Notes on D1" block).
		cache.delete(containerId);
		if (cache.size >= MAX_STATS_CACHE) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(containerId, { fetchedAt: Date.now(), value });
		return value;
	} catch (err) {
		// Don't shout — a container that vanished between our snapshot
		// of `sessions.listAll()` and the stats call is normal under
		// concurrent stop/delete, and would otherwise spam admin
		// dashboards with logs every refresh.
		logger.warn(
			`[containerStats] fetch failed for container ${containerId}: ${(err as Error).message}`,
		);
		return null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// ── CPU/RAM math ────────────────────────────────────────────────────────────

/**
 * Raw shape of the Docker daemon's `/containers/<id>/stats` JSON. Only
 * fields we read are declared; the daemon returns considerably more
 * (block I/O, network counters, per-cpu breakdowns) that we ignore.
 *
 * Exported for the test suite to construct fixtures without redefining
 * the shape locally.
 */
export interface RawDockerStats {
	cpu_stats?: {
		cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
		system_cpu_usage?: number;
		online_cpus?: number;
	};
	precpu_stats?: {
		cpu_usage?: { total_usage?: number };
		system_cpu_usage?: number;
	};
	memory_stats?: {
		usage?: number;
		limit?: number;
		// cgroup-v2 puts file-cache + inactive_file under `stats` and Docker
		// adds those into `usage` — subtracting `cache` gives the "real"
		// RSS-ish number `docker stats` displays. We honour that subtraction
		// when present; cgroup-v2 deployments without `stats.cache` get the
		// raw `usage` and the user sees a slightly inflated number, which
		// is the documented `docker stats` behaviour on those kernels.
		stats?: { cache?: number };
	};
}

/**
 * Pure CPU%/mem% computation. Exported for tests so the math can be
 * pinned against fixture samples without spinning a real container.
 *
 * CPU formula matches the Docker CLI's own `formatter/stats.go`:
 *   cpuDelta = cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage
 *   sysDelta = cpu_stats.system_cpu_usage     - precpu_stats.system_cpu_usage
 *   onlineCpus = cpu_stats.online_cpus
 *                ?? cpu_stats.cpu_usage.percpu_usage?.length   (legacy fallback)
 *                ?? 1
 *   cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * onlineCpus * 100 : 0
 */
export function computeStats(raw: RawDockerStats): ContainerStats {
	const cpuTotal = raw.cpu_stats?.cpu_usage?.total_usage ?? 0;
	const preCpuTotal = raw.precpu_stats?.cpu_usage?.total_usage ?? 0;
	const sysTotal = raw.cpu_stats?.system_cpu_usage ?? 0;
	const preSysTotal = raw.precpu_stats?.system_cpu_usage ?? 0;
	const cpuDelta = cpuTotal - preCpuTotal;
	const sysDelta = sysTotal - preSysTotal;
	const onlineCpus =
		raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
	// Divide-by-zero guard — `sysDelta > 0` only, matching the Docker
	// CLI's `formatter_stats.go`. `cpuDelta` can be negative (rare:
	// usage briefly regresses between the daemon's two internal
	// samples); we clamp the negative-rate output to 0 with
	// `Math.max(0, …)` rather than pre-guarding on `cpuDelta > 0`,
	// which would mask the equally-rare-but-meaningful "CPU dropped"
	// signal as a flat 0%. `stream:false` pre-fills precpu_stats with
	// a ~1s-prior daemon sample, so the meaningful first call's
	// sysDelta is non-zero — the guard fires only on the genuine
	// "two samples in the same monotonic tick" path.
	const cpuPercent = sysDelta > 0 ? Math.max(0, (cpuDelta / sysDelta) * onlineCpus * 100) : 0;

	const memUsage = raw.memory_stats?.usage ?? 0;
	const memCache = raw.memory_stats?.stats?.cache ?? 0;
	// `usage - cache` matches `docker stats`. Clamp at 0 so a quirky
	// kernel reporting cache > usage doesn't yield a negative number.
	const memBytes = Math.max(0, memUsage - memCache);
	const memLimitBytes = raw.memory_stats?.limit ?? 0;
	const memPercent = memLimitBytes > 0 ? (memBytes / memLimitBytes) * 100 : 0;

	return { cpuPercent, memBytes, memLimitBytes, memPercent };
}

// ── Aggregate helper ────────────────────────────────────────────────────────

/**
 * Per-session input the aggregate helper needs. The admin routes pass
 * a derived view of `SessionMeta` so this module doesn't import the
 * sessions type and create a circular dep.
 */
export interface RunningSessionForStats {
	sessionId: string;
	containerId: string | null;
}

/**
 * Per-session stats result keyed by sessionId. `null` value means
 * "stats fetch failed or container missing"; the admin route still
 * emits the row but with `usage: null`.
 */
export type StatsBySession = Map<string, ContainerStats | null>;

/**
 * Fetch stats for every running session in parallel via
 * `Promise.allSettled`. A failure on one container does not stall the
 * others. Sessions with no `containerId` are emitted with `null`
 * (impossible-but-defensive — a `running` row without a container_id
 * is a reconcile-pending state).
 *
 * Called by both `/admin/stats` (for the totals card) and
 * `/admin/sessions` (for per-row display) — the TTL cache lets the
 * second call piggyback on the first.
 */
export async function gatherStatsForRunning(
	docker: Dockerode,
	sessions: RunningSessionForStats[],
): Promise<StatsBySession> {
	const out: StatsBySession = new Map();
	const tasks: Promise<void>[] = [];
	for (const s of sessions) {
		if (s.containerId === null) {
			out.set(s.sessionId, null);
			continue;
		}
		const cid = s.containerId;
		tasks.push(
			getContainerStats(docker, cid).then((v) => {
				out.set(s.sessionId, v);
			}),
		);
	}
	await Promise.allSettled(tasks);
	return out;
}
