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
 *
 * 2.1.314 and 2.1.316 (legacy activation, CONVERSATION.md §2.7.7): the
 * three pre-3.0d sessions had auto-updated to 2.1.316 and the composer
 * pilot runs 2.1.314. Both are validated by the Session Image workflow's
 * `cli-variants` job, which builds the same Dockerfile with
 * `CLAUDE_CODE_VERSION` set to each and runs the whole conversation
 * smoke (its phase 11d is the control-dir validation above), the
 * recreation smoke (a carry-over whose N runs that CLI from the
 * workspace) and the composer smoke against it, on every change to this
 * directory. A version leaves this set when that job stops passing for it.
 * 2.1.322 (owner, 2026-11-10/11, #577): session A's CLI, kept under the
 * same job so its coverage does not depend on the open floor below.
 *
 * **Policy since 2026-11-10 (owner): minimum + deny list, not an exact set.**
 * Requiring every new CLI release to be validated before a session can be
 * recreated blocked sessions that had simply auto-updated, and pushed toward
 * downgrades. The owner accepts the compatibility risk of new stable
 * releases: a workspace CLI passes when it is a plain stable X.Y.Z ≥
 * RECREATE_CLI_MIN_VERSION (default: the lowest validated version, 2.1.308)
 * and not in RECREATE_CLI_DENY (a release found broken). The validated set
 * below stays as the record of what the job checked, and `off` restores it
 * as the only rule. Still blocking, fail-closed: a version that cannot be
 * read, and anything that is not a plain stable release (pre-release, build
 * suffix). Every other precondition — image identity and relay label,
 * layer, skills, disk, backup, preserveLayer's carry plan and the rollback —
 * is unchanged. What the open rule cannot prove: that a future CLI still
 * reads `/etc/st-control` the same way; the Session Image workflow's
 * `cli-variants` job and the daily canary report it (informative).
 */

import { compare, parseVersion, type Semver } from "../conversation/cliPolicy.js";
import { openWorkspaceFile, readHead } from "../workspaceFiles.js";

export const CONTROL_MARKER_VALIDATED_CLI: ReadonlySet<string> = new Set([
	"2.1.308",
	"2.1.314",
	"2.1.316",
	"2.1.322",
]);

export interface RecreateCliPolicy {
	/** Lowest accepted stable version; null = the validated set only (`off`). */
	min: string | null;
	deny: ReadonlySet<string>;
}

export type RecreateCliDecision =
	| { ok: true; by: "validated" | "min" }
	| { ok: false; detail: string };

function lowest(versions: Iterable<string>): string {
	let low: string | null = null;
	for (const v of versions) {
		if (low === null || compare(parseVersion(v) as Semver, parseVersion(low) as Semver) < 0)
			low = v;
	}
	return low as string;
}

/** RECREATE_CLI_MIN_VERSION / RECREATE_CLI_DENY. A malformed value refuses to start. */
export function parseRecreateCliPolicy(env: {
	RECREATE_CLI_MIN_VERSION?: string;
	RECREATE_CLI_DENY?: string;
}): RecreateCliPolicy {
	const deny = (env.RECREATE_CLI_DENY ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
	const bad = deny.filter((v) => !parseVersion(v));
	if (bad.length > 0) {
		throw new Error(`RECREATE_CLI_DENY: not a version: ${bad.join(", ")} (expected X.Y.Z)`);
	}
	const raw = (env.RECREATE_CLI_MIN_VERSION ?? "").trim();
	let min: string | null;
	if (raw === "off") min = null;
	else if (raw === "") min = lowest(CONTROL_MARKER_VALIDATED_CLI);
	else {
		if (!parseVersion(raw)) {
			throw new Error(
				`RECREATE_CLI_MIN_VERSION ${JSON.stringify(raw)}: not a version (expected plain X.Y.Z, or "off")`,
			);
		}
		// The floor is a version the control directory was really checked with.
		if (!CONTROL_MARKER_VALIDATED_CLI.has(raw)) {
			throw new Error(
				`RECREATE_CLI_MIN_VERSION ${raw}: must be a validated version (${[...CONTROL_MARKER_VALIDATED_CLI].join(", ")})`,
			);
		}
		min = raw;
	}
	return { min, deny: new Set(deny) };
}

/** The `control-marker-incompatible` precondition on the workspace CLI's version. */
export function decideRecreateCli(
	policy: RecreateCliPolicy,
	version: string | null,
): RecreateCliDecision {
	if (version === null) return { ok: false, detail: "unreadable" };
	const v = parseVersion(version);
	if (!v) return { ok: false, detail: `not-a-stable-release:${version.slice(0, 64)}` };
	if (policy.deny.has(version)) return { ok: false, detail: `denied:${version}` };
	// A floor is a floor: raising it retires the validated versions below it too.
	if (policy.min !== null) {
		return compare(v, parseVersion(policy.min) as Semver) >= 0
			? { ok: true, by: CONTROL_MARKER_VALIDATED_CLI.has(version) ? "validated" : "min" }
			: { ok: false, detail: `below-min:${version}` };
	}
	return CONTROL_MARKER_VALIDATED_CLI.has(version)
		? { ok: true, by: "validated" }
		: { ok: false, detail: `not-validated:${version}` };
}

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
