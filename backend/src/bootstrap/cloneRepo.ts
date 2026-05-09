/**
 * cloneRepo.ts — repo-clone bootstrap step (#188 PR 188c).
 *
 * Runs `git clone` inside the freshly-spawned session container BEFORE
 * postCreate fires, so a configured `repo` is in place by the time
 * the user's hook (or first interactive command) runs. Output streams
 * to the same WS broadcaster as postCreate.
 *
 * Scope of THIS PR (188c):
 *   - `repo.auth === "none"` only — anonymous HTTPS clone.
 *   - PAT and SSH paths throw `CloneAuthNotImplementedError` so a
 *     future PR (188d) wiring credentials wakes the runner up
 *     loudly rather than silently misbehaving (e.g. running an
 *     unauthenticated clone against a private URL and 404-ing).
 *
 * The clone runs argv-only (no shell). `--branch`, `--depth`, and the
 * target dir are passed as separate arguments to defang any
 * shell-meta in user-supplied values that slipped past the schema's
 * regex allowlist.
 */

import type { DockerManager } from "../dockerManager.js";
import { logger } from "../logger.js";
import type { SessionConfigRecord } from "../sessionConfig.js";

/**
 * Path of the workspace bind mount inside the container. Mirrors the
 * value DockerManager uses on the spawn side. Hard-coded here rather
 * than imported because cloneRepo lives behind the streamExec
 * primitive — the path needs to land in the runner's argv, not in
 * the spawn config.
 */
const CONTAINER_WORKSPACE = "/home/developer/workspace";

/** Thrown when `repo.auth !== "none"` lands here pre-188d. */
export class CloneAuthNotImplementedError extends Error {
	constructor(authMode: string) {
		super(
			`cloneRepo: auth='${authMode}' is not implemented in this PR (lands in 188d). ` +
				"Reject the config at the route boundary or wait for the credential path to ship.",
		);
		this.name = "CloneAuthNotImplementedError";
	}
}

interface RunCloneRepoArgs {
	sessionId: string;
	config: SessionConfigRecord;
	docker: DockerManager;
	onOutput?: (chunk: string) => void;
}

/**
 * Run the configured clone for `sessionId` and return its exit code.
 * Returns `{ exitCode: 0 }` and a no-op when no `repo` is configured —
 * the caller treats that as "clone step succeeded" so a session with
 * only a postCreate hook (no repo) is unaffected.
 *
 * `repo.target === ""` is a request to clone into the workspace root.
 * `git clone` into a non-empty dir would fail, but a freshly-spawned
 * session's bind-mounted workspace is empty (the `.uploads` dir lives
 * outside the workspace tree as of PR 188a), so this is the
 * straightforward path.
 */
export async function runCloneRepo(args: RunCloneRepoArgs): Promise<{ exitCode: number }> {
	const { config, sessionId, docker, onOutput } = args;
	const repo = config.repo;
	if (!repo) {
		// No repo configured — caller treats as success, postCreate
		// fires next. This branch is the steady-state for sessions
		// that don't use the repo-clone feature.
		return { exitCode: 0 };
	}

	if (repo.auth !== "none") {
		// Wire-shape `repo.auth` in {"pat", "ssh"} requires the
		// credential path that lands in 188d. Throw rather than
		// silently fall through to anonymous clone — anonymous clone
		// against a private URL would 404 and the user would see
		// "Repository not found", with no signal that their stored
		// credential was ignored.
		throw new CloneAuthNotImplementedError(repo.auth);
	}

	const targetAbs = resolveTargetAbsPath(repo.target);
	const cloneArgv = buildCloneArgv(repo.url, repo.ref, repo.depth, targetAbs);

	logger.info(
		`[cloneRepo] session ${sessionId}: cloning ${repo.url} ` +
			`(ref=${repo.ref ?? "<HEAD>"}, depth=${repo.depth ?? "full"}, target=${targetAbs})`,
	);

	// Run argv-style. `streamExec` shells out via Cmd: [argv0, argv1, …]
	// (no `bash -c`) so user-controlled values can never break out into
	// shell meta. The schema's regex allowlist is the primary defence;
	// argv-only is belt-and-suspenders.
	return docker.streamExec(
		sessionId,
		{ cmd: cloneArgv, workingDir: CONTAINER_WORKSPACE },
		onOutput,
	);
}

/**
 * Resolve the in-container clone target. `target === ""` (or undefined)
 * means clone into the workspace root (`/home/developer/workspace`).
 * A non-empty `target` is a workspace-relative subpath validated by
 * the schema (no `..`, no leading `/`). The runner trusts that
 * validation: re-checking here would diverge if a future schema
 * tightening changes the allowed shape.
 *
 * Exported for the unit-test that pins the mapping; not part of the
 * public runtime API of the module.
 */
export function resolveTargetAbsPath(target: string | undefined): string {
	if (target === undefined || target === "") return CONTAINER_WORKSPACE;
	return `${CONTAINER_WORKSPACE}/${target}`;
}

/**
 * Build the argv array for the clone. `--branch <ref>` and `--depth <N>`
 * are conditionally appended based on the config; `--` separates flags
 * from positional args so a future ref like `--evil` (already
 * blocked by the schema's leading-`-` check, but defence-in-depth)
 * can't be mis-parsed as a flag.
 *
 * Exported for the unit-test that pins the argv shape per
 * (ref, depth, target) variant.
 */
export function buildCloneArgv(
	url: string,
	ref: string | undefined,
	depth: number | null | undefined,
	targetAbs: string,
): string[] {
	const argv: string[] = ["git", "clone"];
	// Empty `ref` is the wire-shape signal for "use remote HEAD";
	// only pass `--branch` when the user explicitly named one.
	if (ref !== undefined && ref.length > 0) {
		argv.push("--branch", ref);
	}
	if (depth !== null && depth !== undefined) {
		argv.push("--depth", String(depth));
	}
	argv.push("--", url, targetAbs);
	return argv;
}
