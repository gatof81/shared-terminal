/**
 * execRegistry.ts — process-local registry of HTTP-exec lifecycles (#381).
 *
 * The exec API's recovery surface (`GET /sessions/:id/exec/:execId`) and
 * kill endpoint need to resolve an opaque execId back to the pgid and
 * lifecycle state of a `streamExec({ newProcessGroup: true })` run. The
 * registry is deliberately in-memory and single-replica — matching the
 * documented deployment shape — so a backend restart loses it; the API
 * reports those ids as `state: "unknown"` and the contract documents the
 * session-level reconciliation the consumer falls back to (same gap the
 * bootstrap runner accepts on restart).
 */

import { randomBytes } from "node:crypto";

export type ExecExitReason = "exited" | "killed" | "timeout";

export interface ExecEntry {
	execId: string;
	sessionId: string;
	state: "running" | "exited";
	/** Reported by the PGID wrapper's sentinel; may lag `register()` by
	 *  one Docker round-trip, and (fail-open sentinel path) may never
	 *  arrive at all. */
	pgid?: number;
	/** null while running, and for execs whose stream died before Docker
	 *  recorded an exit code (indeterminate outcome ≠ success). */
	exitCode: number | null;
	reason?: ExecExitReason;
	/** Recorded when a kill is *requested* (kill endpoint or the
	 *  maxDurationMs timer), consumed by `markExited` to attribute the
	 *  eventual exit. First writer wins: a timeout firing while a
	 *  user-requested kill is in flight must not relabel it. */
	killIntent?: "killed" | "timeout";
	startedAt: Date;
	endedAt?: Date;
}

// Exited entries are kept around for the recovery endpoint (a consumer
// that lost the stream asks "did it finish, with what code?"), but not
// forever: past the TTL the honest answer degrades to "unknown", which
// the contract already forces consumers to handle for restarts.
const EXITED_TTL_MS = 60 * 60 * 1000;
// Hard bound on total entries so a hot consumer can't grow the map
// without limit. Running entries are already bounded by the per-session
// concurrency cap; the bound here mostly trims exited history early.
const MAX_ENTRIES = 5000;

export class ExecRegistry {
	private readonly entries = new Map<string, ExecEntry>();

	register(sessionId: string): ExecEntry {
		this.prune();
		const entry: ExecEntry = {
			execId: `e_${randomBytes(8).toString("hex")}`,
			sessionId,
			state: "running",
			exitCode: null,
			startedAt: new Date(),
		};
		this.entries.set(entry.execId, entry);
		return entry;
	}

	get(execId: string): ExecEntry | undefined {
		return this.entries.get(execId);
	}

	setPgid(execId: string, pgid: number): void {
		const entry = this.entries.get(execId);
		if (entry) entry.pgid = pgid;
	}

	markKillIntent(execId: string, intent: "killed" | "timeout"): void {
		const entry = this.entries.get(execId);
		if (entry && entry.state === "running" && entry.killIntent === undefined) {
			entry.killIntent = intent;
		}
	}

	/**
	 * Undo a kill intent whose `killExecProcessGroup` came back
	 * `already-exited` — the process beat the signal, so attributing the
	 * exit to the kill would misreport a natural exit as `killed`.
	 */
	clearKillIntent(execId: string): void {
		const entry = this.entries.get(execId);
		if (entry && entry.state === "running") entry.killIntent = undefined;
	}

	markExited(execId: string, exitCode: number | null): void {
		const entry = this.entries.get(execId);
		if (!entry || entry.state === "exited") return;
		entry.state = "exited";
		entry.exitCode = exitCode;
		entry.reason = entry.killIntent ?? "exited";
		entry.endedAt = new Date();
	}

	runningCount(sessionId: string): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.sessionId === sessionId && entry.state === "running") count++;
		}
		return count;
	}

	size(): number {
		return this.entries.size;
	}

	/**
	 * Lazy eviction, run on every `register` (the only growth point, so
	 * no timer needed): drop exited entries past their TTL, then — if the
	 * map is still at the hard cap — drop the oldest exited entries in
	 * insertion order. Running entries are never evicted: their execId is
	 * the only kill handle a disconnected consumer has left.
	 */
	private prune(): void {
		const cutoff = Date.now() - EXITED_TTL_MS;
		for (const [id, entry] of this.entries) {
			if (entry.state === "exited" && (entry.endedAt?.getTime() ?? 0) < cutoff) {
				this.entries.delete(id);
			}
		}
		if (this.entries.size < MAX_ENTRIES) return;
		for (const [id, entry] of this.entries) {
			if (entry.state === "exited") {
				this.entries.delete(id);
				if (this.entries.size < MAX_ENTRIES) return;
			}
		}
	}
}
