/**
 * recreate/carry.ts — the carry-over of a session container's writable layer
 * into its recreated container (CONVERSATION.md §2.7.7, legacy activation).
 *
 * Strict preservation (§2.7.1, D2) refuses to recreate a container whose
 * layer holds anything the entrypoint did not produce. The sessions that
 * predate the relay image hold years of such state — `~/.npm`, `~/.local`,
 * `~/.cache`, `~/.config`, hand-made directories under HOME, caches under
 * `/tmp` — and no package-level change (`docker diff` on the three real
 * sessions of 2026-10-31: nothing under /usr, /etc, /var or /opt except
 * Docker's own `docker-init`). The carry-over mode keeps N created from the
 * checked image, as the contract requires, and streams each top-level
 * entry of O's layer under HOME and /tmp into N before N starts. What the
 * entrypoint recreates on its own (its symlinks, the readiness sentinel,
 * the tmux socket dir, the relay log) and what is a dead process's runtime
 * (CLI sockets and probes) is not carried. Anything outside HOME and /tmp
 * still blocks: a system change cannot be carried with guarantees.
 *
 * This module is pure: the plan is computed from `docker diff` and stats;
 * the engine issues the copies.
 */
import path from "node:path";
import type { Blocker } from "./engine.js";
import {
	DOCKER_INIT_FILES,
	ENTRYPOINT_FILES,
	ENTRYPOINT_SYMLINKS,
	HOME,
	type LayerChange,
	type PathKind,
	type PathStat,
	TMUX_DIR,
	WORKSPACE,
} from "./layer.js";

export interface CarryEntry {
	/** Absolute path in O, a direct child of HOME or /tmp. */
	path: string;
	kind: PathKind;
}

export interface CarryPlan {
	/** What is streamed from O into N, in this order (HOME first). */
	entries: CarryEntry[];
	/** What blocks the carry-over: changes outside HOME and /tmp, or deletions of image files. */
	blockers: Blocker[];
	/** Entries deliberately not carried, by reason (counts only — paths are content). */
	skipped: { entrypoint: number; cliRuntime: number; socket: number };
}

/** The CLI's runtime dirs under /tmp (layer.ts documents their shapes): a dead process's state. */
const CLI_TMP_RUNTIME: ReadonlySet<string> = new Set(["/tmp/cc-socks", "/tmp/claude-1000"]);

function isUnder(p: string, dir: string): boolean {
	return p === dir || p.startsWith(`${dir}/`);
}

/** Every proper ancestor of an absolute path, "/" excluded. */
function ancestors(p: string): string[] {
	const out: string[] = [];
	let d = path.posix.dirname(p);
	while (d !== "/" && d !== ".") {
		out.push(d);
		d = path.posix.dirname(d);
	}
	return out;
}

/** The direct child of `root` on the way to `p`, or null when `p` is `root` itself or not under it. */
function topLevelUnder(p: string, root: string): string | null {
	if (!isUnder(p, root) || p === root) return null;
	const rest = p.slice(root.length + 1);
	const first = rest.split("/")[0];
	return first ? `${root}/${first}` : null;
}

export interface CarryInput {
	changes: LayerChange[];
	/** Mount destinations of O (bind mounts are not layer content). */
	mounts: string[];
	/** Stat of a path inside the stopped container; null when absent. */
	stat: (p: string) => Promise<PathStat | null>;
}

/**
 * The plan. Deterministic order: HOME entries sorted, then /tmp entries
 * sorted — so a retry copies in the same sequence and the evidence lines
 * up with the record.
 */
export async function planCarry(input: CarryInput): Promise<CarryPlan> {
	const mounts = new Set(input.mounts.map((m) => path.posix.normalize(m)));
	const blockers = new Map<string, number>();
	const block = (code: string) => blockers.set(code, (blockers.get(code) ?? 0) + 1);
	const skipped = { entrypoint: 0, cliRuntime: 0, socket: 0 };
	const tops = new Map<string, "home" | "tmp">();
	// Directories outside HOME and /tmp that show as merely "changed" because
	// something tolerated was created inside them (`/usr`, `/usr/sbin` for
	// docker-init; a mount point's parents). Same rule as the strict mode.
	const allowedAncestors = new Set<string>();
	for (const p of [...DOCKER_INIT_FILES, ...mounts]) {
		for (const a of ancestors(p)) allowedAncestors.add(a);
	}

	// Entrypoint symlinks verified exact are the only things whose
	// descendants may legitimately show as deleted (the image's real
	// ~/.npm-global replaced by the symlink into the workspace).
	const verifiedSymlinks = new Set<string>();
	for (const [link, target] of ENTRYPOINT_SYMLINKS) {
		const st = await input.stat(link);
		if (st?.kind === "symlink" && st.linkTarget === target) verifiedSymlinks.add(link);
	}

	for (const ch of input.changes) {
		const p = path.posix.normalize(ch.Path);
		if (isUnder(p, WORKSPACE)) continue; // the bind mount, never the layer
		if ([...mounts].some((m) => isUnder(p, m))) continue; // other mounts (uploads)
		if (DOCKER_INIT_FILES.has(p)) continue; // Docker's `--init` binary, present in every session
		if (p === HOME || p === "/tmp" || p === "/home") continue; // the parents, "changed" by their children
		if (ch.Kind === 2) {
			// A deletion cannot be carried: only the entrypoint's own replacement is tolerated.
			if ([...verifiedSymlinks].some((l) => p !== l && isUnder(p, l))) continue;
			block("layer-deleted");
			continue;
		}
		const home = topLevelUnder(p, HOME);
		const tmp = topLevelUnder(p, "/tmp");
		if (home) {
			if (ENTRYPOINT_SYMLINKS.has(home)) {
				// The entrypoint makes it again on N; a non-symlink here would be
				// the entrypoint's own failure, which strict mode reports too.
				// (`~/.config` is NOT skipped: the entrypoint only creates the
				// directory for its `gh` symlink, and a legacy session keeps
				// real configuration there — it is carried like any HOME entry;
				// the symlink inside it is re-made by N's entrypoint.)
				skipped.entrypoint++;
				continue;
			}
			if (mounts.has(home)) continue;
			tops.set(home, "home");
			continue;
		}
		if (tmp) {
			if (ENTRYPOINT_FILES.has(tmp) || tmp === TMUX_DIR) {
				skipped.entrypoint++;
				continue;
			}
			if (CLI_TMP_RUNTIME.has(tmp)) {
				skipped.cliRuntime++;
				continue;
			}
			tops.set(tmp, "tmp");
			continue;
		}
		if (ch.Kind === 0 && allowedAncestors.has(p)) {
			const st = await input.stat(p);
			if (st?.kind === "dir") continue;
		}
		block("layer-system");
	}

	const entries: CarryEntry[] = [];
	for (const scope of ["home", "tmp"] as const) {
		const paths = [...tops.entries()]
			.filter(([, s]) => s === scope)
			.map(([p]) => p)
			.sort();
		for (const p of paths) {
			const st = await input.stat(p);
			if (!st) continue; // listed as changed but gone: nothing to carry
			if (st.kind === "socket") {
				skipped.socket++;
				continue;
			}
			entries.push({ path: p, kind: st.kind });
		}
	}
	return {
		entries,
		blockers: [...blockers.entries()].sort().map(([code, count]) => ({ code, count })),
		skipped,
	};
}

/** The directory in N an entry is extracted into (its parent in O). */
export function carryDestination(entryPath: string): string {
	return path.posix.dirname(entryPath);
}

/**
 * T_rec for an attempt that carries `bytes`: the ordinary budget plus the
 * time the copy needs at a conservative throughput, capped. Streaming 12 GiB
 * at 20 MiB/s is ~10 min; the lock's ordinary wait cap is for the other
 * verbs, which refuse with `busy` meanwhile (the session is stopped anyway).
 */
export function carryBudgetMs(
	bytes: number,
	baseMs: number,
	bytesPerSec: number,
	capMs: number,
): number {
	const copyMs = Math.ceil((bytes / Math.max(1, bytesPerSec)) * 1000);
	return Math.min(capMs, baseMs + copyMs);
}

/** Free bytes required before a carry-over of `bytes`: the copy plus headroom. */
export function requiredFreeBytes(bytes: number): number {
	return Math.ceil(bytes * 1.2) + 1024 * 1024 * 1024;
}
