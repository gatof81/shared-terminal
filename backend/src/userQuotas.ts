/**
 * userQuotas.ts — per-user quotas: max sessions + total CPU/RAM budgets (#202).
 *
 * Three layers cooperate:
 *
 *   - Deployment defaults: MAX_ACTIVE_SESSIONS_PER_USER (sessionManager.ts,
 *     pre-existing) for the count; USER_MAX_TOTAL_CPU (cores) /
 *     USER_MAX_TOTAL_MEM (MiB) env vars for the budgets. Budget vars unset
 *     means UNLIMITED — an existing deployment upgrades with zero behaviour
 *     change until the operator opts in.
 *   - Per-user overrides: users.max_sessions / max_total_cpu / max_total_mem
 *     (migration v12). NULL = fall through to the deployment default.
 *     Units mirror session_configs: nano-CPUs and bytes — no conversions
 *     between the admin PATCH, this module, and the create-time check.
 *   - Enforcement: POST /sessions only. The session-count cap stays inside
 *     sessionManager.create's atomic INSERT (this module just resolves the
 *     number to fold in); the CPU/RAM budget check is read-then-insert and
 *     therefore racy under concurrent creates by the same user — accepted
 *     for v1 (the losing request would exceed the budget by at most one
 *     session's allocation, and the next create corrects). Existing
 *     sessions are never affected retroactively; /start is deliberately
 *     not gated (issue #202 scopes enforcement to create time).
 */

import { z } from "zod";
import { d1Query } from "./db.js";
import { DEFAULT_MEMORY_BYTES, DEFAULT_NANO_CPUS } from "./dockerManager.js";
import { logger } from "./logger.js";
import {
	EFFECTIVE_CPU_NANO_MAX,
	EFFECTIVE_CPU_NANO_MIN,
	EFFECTIVE_MEM_BYTES_MAX,
	EFFECTIVE_MEM_BYTES_MIN,
	listResourceCaps,
} from "./sessionConfig.js";
import { MAX_ACTIVE_SESSIONS_PER_USER, type SessionManager } from "./sessionManager.js";

// ── Deployment defaults (env) ───────────────────────────────────────────────

/** Cores (decimals ok) → nano-CPUs; unset/empty → null (unlimited).
 *  Same warn-and-fall-back posture as parseMaxSessionCpu — a typo'd
 *  budget must not brick session creation, and "unlimited" is the
 *  behaviour the deployment had before the var existed. */
export function parseUserMaxTotalCpu(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const cores = Number(raw);
	if (!Number.isFinite(cores) || cores <= 0) {
		logger.warn(
			`[userQuotas] USER_MAX_TOTAL_CPU=${JSON.stringify(raw)} is not a positive number; ` +
				"treating as unset (unlimited)",
		);
		return null;
	}
	return Math.round(cores * 1_000_000_000);
}

/** MiB (integer) → bytes; unset/empty → null (unlimited). */
export function parseUserMaxTotalMem(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const mib = Number(raw);
	if (!Number.isFinite(mib) || !Number.isInteger(mib) || mib <= 0) {
		logger.warn(
			`[userQuotas] USER_MAX_TOTAL_MEM=${JSON.stringify(raw)} is not a positive integer (MiB); ` +
				"treating as unset (unlimited)",
		);
		return null;
	}
	return mib * 1024 * 1024;
}

const DEFAULT_MAX_TOTAL_CPU_NANOS = parseUserMaxTotalCpu(process.env.USER_MAX_TOTAL_CPU);
const DEFAULT_MAX_TOTAL_MEM_BYTES = parseUserMaxTotalMem(process.env.USER_MAX_TOTAL_MEM);

// ── Types ───────────────────────────────────────────────────────────────────

/** Raw per-user override columns; null = deployment default. */
export interface UserQuotaRow {
	max_sessions: number | null;
	max_total_cpu: number | null;
	max_total_mem: number | null;
}

export interface EffectiveQuotas {
	maxSessions: number;
	/** null = unlimited */
	maxTotalCpuNanos: number | null;
	/** null = unlimited */
	maxTotalMemBytes: number | null;
}

export interface RunningAllocations {
	runningSessions: number;
	cpuNanos: number;
	memBytes: number;
}

export class UserQuotaExceededError extends Error {
	readonly cap: "cpu" | "mem";
	constructor(cap: "cpu" | "mem", limit: number, current: number, requested: number) {
		// Human units in the message (the frontend ships it verbatim);
		// exact figures ride the structured fields for programmatic
		// consumers. Naming the cap that was hit is an acceptance
		// criterion of #202.
		super(
			cap === "cpu"
				? `Total CPU budget (${limit / 1e9} cores) exceeded: ` +
						`${current / 1e9} in use + ${requested / 1e9} requested`
				: `Total memory budget (${Math.round(limit / 2 ** 20)} MiB) exceeded: ` +
						`${Math.round(current / 2 ** 20)} MiB in use + ${Math.round(requested / 2 ** 20)} MiB requested`,
		);
		this.name = "UserQuotaExceededError";
		this.cap = cap;
	}
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getUserQuotaRow(userId: string): Promise<UserQuotaRow | null> {
	const result = await d1Query<UserQuotaRow>(
		"SELECT max_sessions, max_total_cpu, max_total_mem FROM users WHERE id = ?",
		[userId],
	);
	return result.results[0] ?? null;
}

export function resolveEffectiveQuotas(row: UserQuotaRow | null): EffectiveQuotas {
	return {
		maxSessions: row?.max_sessions ?? MAX_ACTIVE_SESSIONS_PER_USER,
		maxTotalCpuNanos: row?.max_total_cpu ?? DEFAULT_MAX_TOTAL_CPU_NANOS,
		maxTotalMemBytes: row?.max_total_mem ?? DEFAULT_MAX_TOTAL_MEM_BYTES,
	};
}

/**
 * What a session will actually get from the cgroup, per allocation axis —
 * the same `Math.min(stored ?? default, operator cap)` formula spawn()
 * applies. Budgets must count the REAL allocation: an 8-core stored cap
 * on a 4-core-max deployment burns 4 cores of budget, not 8.
 */
export function effectiveSessionAllocation(caps: {
	cpuLimit: number | null;
	memLimit: number | null;
}): { cpuNanos: number; memBytes: number } {
	return {
		cpuNanos: Math.min(caps.cpuLimit ?? DEFAULT_NANO_CPUS, EFFECTIVE_CPU_NANO_MAX),
		memBytes: Math.min(caps.memLimit ?? DEFAULT_MEMORY_BYTES, EFFECTIVE_MEM_BYTES_MAX),
	};
}

/**
 * Sum of the caller's RUNNING sessions' effective allocations. Two D1
 * round-trips (session list + batched caps read) on top of POST
 * /sessions' existing cost — create is not a hot path.
 */
export async function computeRunningAllocations(
	sessions: SessionManager,
	userId: string,
): Promise<RunningAllocations> {
	const all = await sessions.listForUser(userId);
	const running = all.filter((s) => s.status === "running");
	if (running.length === 0) return { runningSessions: 0, cpuNanos: 0, memBytes: 0 };
	const caps = await listResourceCaps(running.map((s) => s.sessionId));
	let cpuNanos = 0;
	let memBytes = 0;
	for (const s of running) {
		const alloc = effectiveSessionAllocation(
			caps.get(s.sessionId) ?? { cpuLimit: null, memLimit: null },
		);
		cpuNanos += alloc.cpuNanos;
		memBytes += alloc.memBytes;
	}
	return { runningSessions: running.length, cpuNanos, memBytes };
}

/** Throws UserQuotaExceededError naming the first cap the new session busts. */
export function assertBudgetAllows(
	effective: EffectiveQuotas,
	current: RunningAllocations,
	requested: { cpuNanos: number; memBytes: number },
): void {
	if (
		effective.maxTotalCpuNanos !== null &&
		current.cpuNanos + requested.cpuNanos > effective.maxTotalCpuNanos
	) {
		throw new UserQuotaExceededError(
			"cpu",
			effective.maxTotalCpuNanos,
			current.cpuNanos,
			requested.cpuNanos,
		);
	}
	if (
		effective.maxTotalMemBytes !== null &&
		current.memBytes + requested.memBytes > effective.maxTotalMemBytes
	) {
		throw new UserQuotaExceededError(
			"mem",
			effective.maxTotalMemBytes,
			current.memBytes,
			requested.memBytes,
		);
	}
}

// ── Admin surface (#202 PATCH /admin/users/:id/quotas + users list) ─────────

export interface QuotaPatch {
	/** undefined = leave alone; null = clear the override (deployment default). */
	maxSessions?: number | null;
	maxTotalCpu?: number | null;
	maxTotalMem?: number | null;
}

// Budget bounds deliberately DIVERGE from the per-session schema on the
// upper side (issue #202 said "same EFFECTIVE_*_MIN/MAX bounds", but a
// TOTAL budget below the per-session max would be useless and one above
// it is the entire point — N sessions). Lower bounds reuse the session
// floors: a budget smaller than the smallest possible session can never
// admit anything, so it's a typo, not a policy. Upper bounds are pure
// fat-finger guards, far above any single-host reality.
export const MAX_TOTAL_CPU_NANO_CEILING = 128 * 1_000_000_000;
export const MAX_TOTAL_MEM_BYTES_CEILING = 1024 * 1024 * 1024 * 1024; // 1 TiB
export const MAX_SESSIONS_CEILING = 500;

/** Wire schema for PATCH /admin/users/:id/quotas. `null` clears the
 *  override back to the deployment default; the route additionally
 *  requires at least one key (same shape as ResourceCapsPatchSchema). */
export const UserQuotasPatchSchema = z
	.object({
		maxSessions: z.number().int().min(1).max(MAX_SESSIONS_CEILING).nullable().optional(),
		maxTotalCpu: z
			.number()
			.int()
			.min(EFFECTIVE_CPU_NANO_MIN)
			.max(MAX_TOTAL_CPU_NANO_CEILING)
			.nullable()
			.optional(),
		maxTotalMem: z
			.number()
			.int()
			.min(EFFECTIVE_MEM_BYTES_MIN)
			.max(MAX_TOTAL_MEM_BYTES_CEILING)
			.nullable()
			.optional(),
	})
	.strict();

/** Targeted UPDATE of the override columns. Returns false when the user
 *  id doesn't exist (route maps to 404). */
export async function updateUserQuotas(userId: string, patch: QuotaPatch): Promise<boolean> {
	const sets: string[] = [];
	const params: (string | number | null)[] = [];
	if (patch.maxSessions !== undefined) {
		sets.push("max_sessions = ?");
		params.push(patch.maxSessions);
	}
	if (patch.maxTotalCpu !== undefined) {
		sets.push("max_total_cpu = ?");
		params.push(patch.maxTotalCpu);
	}
	if (patch.maxTotalMem !== undefined) {
		sets.push("max_total_mem = ?");
		params.push(patch.maxTotalMem);
	}
	if (sets.length === 0) return false;
	params.push(userId);
	const result = await d1Query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
	return result.meta.changes === 1;
}

export interface AdminUserRow {
	id: string;
	username: string;
	is_admin: number;
	created_at: string;
	max_sessions: number | null;
	max_total_cpu: number | null;
	max_total_mem: number | null;
}

/** Cross-user list for the admin dashboard. Bounded like ADMIN_LIST_LIMIT
 *  — a deployment with >500 users has outgrown this dashboard. */
export async function listUsersWithQuotas(): Promise<AdminUserRow[]> {
	const result = await d1Query<AdminUserRow>(
		`SELECT id, username, is_admin, created_at, max_sessions, max_total_cpu, max_total_mem
                 FROM users ORDER BY created_at ASC LIMIT 500`,
	);
	return result.results;
}
