/**
 * recreate/ports.ts — what the recreation engine needs from Docker.
 * DockerManager implements it against dockerd; tests implement it with
 * fakes that can hang, fail or answer late at any request.
 *
 * Contract for implementations: no request takes an abort signal or a
 * client-side timeout (§2.7.4) — the engine decides how long to wait, and
 * the answer, whenever it comes, is the evidence.
 */

import type { LayerChange, PathStat } from "./layer.js";

export interface RecreateContainer {
	id: string;
	/** Without Docker's leading "/". */
	name: string;
	running: boolean;
	imageId: string;
	labels: Record<string, string>;
	mounts: string[];
}

export interface RecreateCreateSpec {
	name: string;
	/** The checked image ID (D6), never the tag. */
	imageId: string;
	/** Capture env (N's token, backend port); the session's own env is added by the implementation. */
	env: string[];
	/** Capture binds (managed + control, ro); workspace and uploads are added by the implementation. */
	binds: string[];
	labels: Record<string, string>;
}

export interface RecreateDockerPort {
	/** null on 404. */
	inspect(idOrName: string): Promise<RecreateContainer | null>;
	changes(id: string): Promise<LayerChange[]>;
	/** null on 404. */
	statPath(id: string, path: string): Promise<PathStat | null>;
	/** A tar of `path` read from the container (running or not), or null on 404. Throws past `maxBytes`. */
	readArchive(id: string, path: string, maxBytes: number): Promise<Buffer | null>;
	/** The session image now, by immutable ID; null when the tag is missing. */
	currentImage(): Promise<{ imageId: string; relay2: boolean } | null>;
	/**
	 * Same env, binds, caps, limits and network as a spawn of `sessionId`
	 * (D1 reads happen here, before any Docker request). The result is
	 * handed unchanged to `create`, which is the one Docker request.
	 */
	buildCreate(sessionId: string, spec: RecreateCreateSpec): Promise<object>;
	/** Returns N's id. */
	create(options: object): Promise<string>;
	rename(id: string, name: string): Promise<void>;
	start(id: string): Promise<void>;
	/** Resolves when stopped (already stopped included); 404 rejects with `statusCode: 404`. */
	stop(id: string): Promise<void>;
	/** Not forced: a running container is refused. 404 rejects with `statusCode: 404`. */
	remove(id: string): Promise<void>;
	listByLabel(key: string, value?: string): Promise<RecreateContainer[]>;
	/** Every container whose name contains `fragment` (Docker's name filter is a substring match). */
	listByName(fragment: string): Promise<RecreateContainer[]>;
	/**
	 * Runs `cmd` under the in-container `timeout` and resolves when dockerd
	 * reports how it ended. `exitCode: null` means the termination is
	 * UNKNOWN (the stream broke, or the exec did not report an exit): the
	 * process may still be running and may still write. It is never "it
	 * failed". `execId` lets the caller ask later (`execState`). Errors
	 * thrown here come only from before the process could have started
	 * (the exec instance was not created).
	 */
	exec(containerId: string, cmd: string[], timeoutMs: number): Promise<ExecResult>;
	/** An exec's state now; null when dockerd no longer knows it (404). */
	execState(execId: string): Promise<{ running: boolean; exitCode: number | null } | null>;
}

export interface ExecResult {
	/** null: termination unknown — see `exec`. */
	exitCode: number | null;
	stdout: string;
	execId?: string;
}

export const LABEL_SESSION = "io.shared-terminal.session";
export const LABEL_RECREATE_OF = "io.shared-terminal.recreate-of";
export const LABEL_ATTEMPT = "io.shared-terminal.recreate-attempt";

/**
 * The suffixes `-old-<ts>` and `-new-<ts>` on a canonical `st-<sid[:12]>`
 * are reserved for recreation (§2.7.4). The 12-char prefix of a session
 * UUID keeps its first dash (`3f2a9c1b-4d5e`), so this is the pattern real
 * names follow; a name that does not match exactly is never touched.
 */
export const RESERVED_NAME_RE = /^st-([0-9a-f]{8}-[0-9a-f]{3})-(old|new)-([0-9]+)$/;

export function isNotFound(err: unknown): boolean {
	return (err as { statusCode?: number } | null)?.statusCode === 404;
}
