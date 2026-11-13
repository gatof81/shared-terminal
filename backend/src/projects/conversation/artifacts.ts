/**
 * projects/conversation/artifacts.ts — D2: admitting and storing artifacts
 * (docs/PROJECT_CONVERSATION.md §6.1–§6.3). Constructed only with
 * PROJECT_ARTIFACTS_ENABLED effective; without it nothing here exists and
 * no workspace file is read.
 *
 * An artifact is a text file the owner picked from the workspace of an
 * agent's live session. It is read through the SAME opener as a Files
 * download (`openWorkspaceFile`: credential denylist, no links, regular
 * files only, the /proc fd proof), checked to be UTF-8 without NUL, and
 * stored content-addressed under `.projects/<pid>/artifacts/<sha256>`.
 *
 * Order, and why:
 *   1. read + hash the source (no lock: a workspace read is slow I/O), then,
 *      under the project lock, refuse anything that would be refused anyway
 *      (replay, quota, a log that cannot take the event) and new bytes past
 *      the unreferenced-bytes budget (measured from disk + reserved, in that
 *      same section) — all before writing;
 *   2. content to `artifacts/<sha>`: temp + fsync + re-read through the same
 *      fd + `link(2)` to the final name, so a final name never holds partial
 *      or unverified bytes and an existing one is never replaced (EEXIST ⇒
 *      verify the existing file instead);
 *   3. only then the `artifact` event, under the project lock, where the
 *      per-project quota is decided against the folded log.
 * A death between 2 and 3, or a refusal in 3 the pre-check could not
 * foresee, leaves an unreferenced content file: content-addressed, reused by
 * the next registration of the same bytes, never deleted (§9), and bounded
 * by `PROJECT_ARTIFACTS_UNREFERENCED_MAX_BYTES`, writes in progress included
 * (only reserved bytes are ever written; reuse writes nothing).
 */

import { createHash, randomBytes } from "node:crypto";
import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";
import type { HttpResult } from "../../conversation/composer.js";
import { logger } from "../../logger.js";
import { fsyncDir } from "../../recreateAttempt.js";
import type { OpenedWorkspaceFile, WorkspaceFsError } from "../../workspaceFiles.js";
import { logErrorToHttp } from "./api.js";
import type { ProjectBindings } from "./fanout.js";
import { ARTIFACTS_DIR, projectDir } from "./paths.js";
import type { ProjectConversationStore } from "./store.js";

/** §6.1 */
export const ARTIFACT_MAX_BYTES = 1024 * 1024;
export const ARTIFACTS_PER_MESSAGE = 4;
export const PROJECT_ARTIFACTS_MAX_BYTES = 256 * 1024 * 1024;
/**
 * §6.2: bytes under `artifacts/` that no `artifact` event references (an
 * event the log refused after the copy, a death between copy and event,
 * temps — measured on disk, so a restart's leftovers count). A registration
 * that would add new bytes is admitted only while measured + reserved + its
 * own ≤ this; otherwise refused before copying. Nothing is deleted to make
 * room. The bound is strict, writes in progress included: a registration
 * writes (temps too) only the parts it reserved, and reusing existing
 * content writes nothing (storeContent `writes`).
 */
export const PROJECT_ARTIFACTS_UNREFERENCED_MAX_BYTES = 16 * 1024 * 1024;
const NAME_MAX = 96;
const SHA_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_MAX = 4096;

/** `PROJECT_ARTIFACTS_ENABLED`: only `true` / `1` turn it on (same rule as the other flags). */
export function projectArtifactsFlagEnabled(raw: string | undefined): boolean {
	const v = (raw ?? "").trim().toLowerCase();
	return v === "true" || v === "1";
}

/**
 * §6.1: the last path component, cut to `[A-Za-z0-9._-]{1,96}`, never
 * starting with `.`. Informative only — the identity is the sha256, and the
 * inbox name is prefixed with it, so two artifacts never share a name.
 */
export function sanitizeName(rawPath: string): string {
	const leaf = rawPath.split("/").filter(Boolean).pop() ?? "";
	// One `_` per code point, not per UTF-16 unit, so a name's length does
	// not depend on how its characters are encoded.
	let s = Array.from(leaf, (c) => (/^[A-Za-z0-9._-]$/.test(c) ? c : "_")).join("");
	s = s.replace(/^\.+/, (dots) => "_".repeat(dots.length));
	s = s.slice(0, NAME_MAX);
	return s === "" ? "artifact" : s;
}

/** §6.1: valid UTF-8 and no NUL. */
export function isText(buf: Buffer): boolean {
	if (buf.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buf);
		return true;
	} catch {
		return false;
	}
}

export const sha256Hex = (b: Buffer | string): string =>
	createHash("sha256").update(b).digest("hex");

/** §6.4 step 4: the name in the target's `.st-inbox/`. */
export const inboxName = (a: { sha256: string; name: string }): string =>
	`${a.sha256.slice(0, 12)}-${a.name}`;

export interface ArtifactRef {
	sha256: string;
	name: string;
	bytes: number;
}

/** §6.3: one line per artifact, appended by the backend to the text the agent receives. */
export function artifactLine(a: ArtifactRef): string {
	return `[artefacto] ${a.name} · ${a.bytes} B · sha256 ${a.sha256} · ~/workspace/.st-inbox/${inboxName(a)}`;
}

export function composeText(normalized: string, artifacts: readonly ArtifactRef[]): string {
	if (artifacts.length === 0) return normalized;
	return [normalized, ...artifacts.map(artifactLine)].join("\n");
}

// ── Content files ───────────────────────────────────────────────────────────

const artifactsDir = (root: string, pid: string) => path.join(projectDir(root, pid), ARTIFACTS_DIR);

async function ensureArtifactsDir(root: string, pid: string): Promise<string> {
	const dir = artifactsDir(root, pid);
	try {
		const st = await fs.lstat(dir);
		if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
		return dir;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	try {
		await fs.mkdir(dir, { mode: 0o700 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	await fsyncDir(path.dirname(dir));
	return dir;
}

/** A file of ours, read with O_NOFOLLOW and capped; null ⇔ absent. */
async function readCapped(p: string, max: number): Promise<Buffer | null> {
	let fh: fs.FileHandle;
	try {
		fh = await fs.open(p, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		const st = await fh.stat();
		if (!st.isFile() || st.size > max) throw new Error(`${p}: not a regular file ≤ ${max} B`);
		const buf = Buffer.alloc(st.size + 1);
		const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
		if (bytesRead > st.size) throw new Error(`${p}: grew while read`);
		return buf.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

/**
 * Publishes `content` under `dir/name` without ever replacing a file:
 * temp (O_EXCL) → write → fsync → re-read → `link` → unlink temp → fsync dir.
 * EEXIST on the link ⇒ the existing file is checked with `same` instead.
 */
async function publishNoClobber(
	dir: string,
	name: string,
	content: Buffer,
	same: (existing: Buffer) => boolean,
	max: number,
): Promise<"written" | "existed"> {
	const tmp = path.join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
	const fh = await fs.open(tmp, FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_RDWR, 0o600);
	// Until the link succeeds, the temp is this call's alone: a random name
	// created O_EXCL and never linked, so nothing can reference it. On any
	// failure up to there it is removed — left behind it would count against
	// the unreferenced-bytes budget (§6.2), which nothing ever frees, so a
	// short ENOSPC/EIO episode would block the project's registrations for
	// good. A death (no `catch` runs) can still leave one; that is what the
	// budget bounds.
	const dropTemp = async (cause: unknown): Promise<never> => {
		await fs.unlink(tmp).catch((e: unknown) => {
			// Not fatal for this answer (the cause is), but not silent either:
			// the temp stays, and from now on it is measured on disk against
			// the budget (also after a restart) until an operator removes it.
			logger.warn(
				`[projects] artifact temp ${tmp} could not be removed after a failed write: ${(e as Error).message}`,
			);
		});
		throw cause;
	};
	try {
		try {
			await fh.writeFile(content);
			await fh.sync();
			const back = Buffer.alloc(content.length + 1);
			const { bytesRead } = await fh.read(back, 0, back.length, 0);
			if (bytesRead !== content.length || !back.subarray(0, bytesRead).equals(content)) {
				throw new Error(`${name}: read-back differs from what was written`);
			}
		} finally {
			await fh.close();
		}
	} catch (err) {
		await dropTemp(err);
	}
	let outcome: "written" | "existed" = "written";
	try {
		await fs.link(tmp, path.join(dir, name));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") await dropTemp(err);
		outcome = "existed";
	}
	await fs.unlink(tmp);
	await fsyncDir(dir);
	if (outcome === "existed") {
		const existing = await readCapped(path.join(dir, name), max);
		if (!existing || !same(existing)) {
			throw new ArtifactStoreCorrupt(`${name}: the existing file does not match its name`);
		}
	}
	return outcome;
}

export class ArtifactStoreCorrupt extends Error {}

/** The metadata file's exact bytes (what the reservation counts, §6.2). */
export function metaBuffer(sha: string, meta: Record<string, unknown>): Buffer {
	return Buffer.from(`${JSON.stringify({ sha256: sha, ...meta })}\n`, "utf8");
}

const isMetaOf =
	(sha: string) =>
	(b: Buffer): boolean => {
		try {
			return (JSON.parse(b.toString("utf8")) as { sha256?: unknown }).sha256 === sha;
		} catch {
			return false;
		}
	};
const META_MAX = 64 * 1024;

/**
 * Makes the content file (and its metadata) present and verified. `writes`
 * says which of the two this registration RESERVED (§6.2): only those may be
 * written — through a temp, which is why they must be reserved, temps being
 * bytes on disk too. A part not reserved existed when the budget was
 * measured and is only verified, never re-published: reuse of existing
 * content writes no byte at all (no temp, no metadata), so every byte any
 * registration puts under `artifacts/` was admitted against the budget.
 *   - content not reserved and absent / not matching its name ⇒
 *     ArtifactStoreCorrupt (the store lost or changed a file it holds);
 *   - metadata not reserved and absent ⇒ accepted (informative, §6.2);
 *     present but not this sha's ⇒ ArtifactStoreCorrupt.
 */
export async function storeContent(
	root: string,
	pid: string,
	content: Buffer,
	meta: Record<string, unknown>,
	writes: { content: boolean; meta: boolean } = { content: true, meta: true },
): Promise<string> {
	const sha = sha256Hex(content);
	const sameContent = (b: Buffer) => sha256Hex(b) === sha;
	const dir =
		writes.content || writes.meta ? await ensureArtifactsDir(root, pid) : artifactsDir(root, pid);
	if (writes.content) {
		await publishNoClobber(dir, sha, content, sameContent, ARTIFACT_MAX_BYTES);
	} else {
		const existing = await readCapped(path.join(dir, sha), ARTIFACT_MAX_BYTES);
		if (!existing || !sameContent(existing)) {
			throw new ArtifactStoreCorrupt(`${sha}: content file missing or not matching its name`);
		}
	}
	// The metadata is informative (§6.2: the log's `artifact` events are the
	// record); a first one wins and is never rewritten.
	if (writes.meta) {
		await publishNoClobber(dir, `${sha}.json`, metaBuffer(sha, meta), isMetaOf(sha), META_MAX);
	} else {
		const existing = await readCapped(path.join(dir, `${sha}.json`), META_MAX);
		if (existing && !isMetaOf(sha)(existing)) {
			throw new ArtifactStoreCorrupt(`${sha}.json: does not describe its content`);
		}
	}
	return sha;
}

/** The stored bytes of `sha`, verified against their name; null ⇔ absent. */
export async function readContent(root: string, pid: string, sha: string): Promise<Buffer | null> {
	if (!SHA_RE.test(sha)) return null;
	const buf = await readCapped(path.join(artifactsDir(root, pid), sha), ARTIFACT_MAX_BYTES);
	if (buf === null) return null;
	if (sha256Hex(buf) !== sha) throw new ArtifactStoreCorrupt(`${sha}: content does not match`);
	return buf;
}

/** The unreferenced bytes could not be measured: new bytes are refused (fail closed). */
export class ArtifactUsageUnverifiable extends Error {}

/**
 * §6.2: what `artifacts/` holds that no `artifact` event references — a
 * content file or its `.json` whose sha the log does not reference, and
 * anything else (a temp left by a dead write) — measured from the disk
 * itself, so a restart's leftovers count exactly like this process's.
 * `need`: what this registration would add — the content and the metadata
 * file, each only if its final name does not exist yet (an existing one is
 * reused, never rewritten); 0 ⇒ nothing is measured. Stops summing once
 * past `stopAbove`.
 *
 * Fail closed: an entry that is not a regular file (its size would say
 * nothing about what it holds) or any error other than "vanished" makes the
 * measurement unverifiable, never 0.
 */
async function unreferencedUsage(
	dir: string,
	sha: string,
	sizes: { content: number; meta: number },
	referenced: ReadonlyMap<string, unknown>,
	stopAbove: number,
): Promise<{ need: number; used: number; writes: { content: boolean; meta: boolean } }> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return {
				need: sizes.content + sizes.meta,
				used: 0,
				writes: { content: true, meta: true },
			};
		throw new ArtifactUsageUnverifiable(`readdir: ${(err as Error).message}`);
	}
	const present = new Set(names);
	const writes = { content: !present.has(sha), meta: !present.has(`${sha}.json`) };
	const need = (writes.content ? sizes.content : 0) + (writes.meta ? sizes.meta : 0);
	if (need === 0) return { need, used: 0, writes };
	// Lock-hold cost: one readdir plus an lstat per UNREFERENCED entry (referenced
	// ones are skipped by name), stopping once past the budget — so it grows
	// with the project's entry count only through the readdir itself.
	let used = 0;
	for (const n of names) {
		const base = n.endsWith(".json") ? n.slice(0, -5) : n;
		if (SHA_RE.test(base) && referenced.has(base)) continue;
		let st: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			st = await fs.lstat(path.join(dir, n));
		} catch (err) {
			// A temp unlinked by its own write between the listing and here.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new ArtifactUsageUnverifiable(`${n}: ${(err as Error).message}`);
		}
		if (!st.isFile()) throw new ArtifactUsageUnverifiable(`${n}: not a regular file`);
		used += st.size;
		if (used > stopAbove) break;
	}
	return { need, used, writes };
}

// ── Registration (§6.1, POST …/artifacts) ───────────────────────────────────

export interface ArtifactDeps {
	store: ProjectConversationStore;
	workspaceRoot: string;
	/** One uncached D1 read; `null` ⇔ not this owner's project. */
	bindings(ownerId: string, projectId: string): Promise<ProjectBindings | null>;
	/** The Files opener (workspaceFiles.openWorkspaceFile), with its denylist. */
	openSource(
		sessionId: string,
		rel: string,
		opts: { maxBytes: number },
	): Promise<OpenedWorkspaceFile | WorkspaceFsError>;
	/**
	 * Throws unless `ownerId` owns the session (sessions.assertOwnedBy). The
	 * project's owner owns its agents' sessions (PROJECTS.md §4.3); this is
	 * the check that a binding can never turn into a read of someone else's
	 * workspace.
	 */
	assertOwner(sessionId: string, ownerId: string): Promise<void>;
	/** Is this error an authorization refusal (foreign or missing session)? */
	isForbidden?(err: unknown): boolean;
	maxBytes?: number;
	projectMaxBytes?: number;
	unreferencedMaxBytes?: number;
}

const err = (status: number, code: string, detail?: string): HttpResult => ({
	status,
	body: detail ? { error: code, detail } : { error: code },
});

export class ProjectArtifacts {
	/** Per project: bytes admitted against the unreferenced budget and not yet settled (§6.2). */
	private readonly reservations = new Map<string, number>();

	constructor(private readonly deps: ArtifactDeps) {}

	private get max(): number {
		return this.deps.maxBytes ?? ARTIFACT_MAX_BYTES;
	}

	async register(ownerId: string, projectId: string, raw: unknown): Promise<HttpResult> {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return err(400, "invalid-body");
		const b = raw as Record<string, unknown>;
		if (typeof b.agentId !== "string" || !ID_RE.test(b.agentId))
			return err(400, "invalid-body", "agentId");
		if (
			typeof b.path !== "string" ||
			b.path.length === 0 ||
			b.path.length > PATH_MAX ||
			b.path.includes("\0") ||
			path.isAbsolute(b.path)
		) {
			return err(400, "invalid-body", "path");
		}
		const agentId = b.agentId.toLowerCase();

		// The source session is the agent's live binding NOW (§6.1), read
		// uncached from D1; the event records which session it was.
		const bindings = await this.deps.bindings(ownerId, projectId).catch(() => undefined);
		if (bindings === null) return err(404, "project-not-found");
		if (bindings === undefined) return err(503, "binding-unverified");
		const a = bindings.get(agentId);
		if (!a) return err(400, "invalid-body", "agentId: not an agent of this project");
		if (a.removed || !a.binding) return err(409, "agent-not-bound");
		const sid = a.binding.sessionId;
		try {
			await this.deps.assertOwner(sid, ownerId);
		} catch (e) {
			if (this.deps.isForbidden?.(e)) return err(409, "foreign-session");
			return err(503, "binding-unverified");
		}

		const opened = await this.deps.openSource(sid, b.path, { maxBytes: this.max });
		if (!opened.ok) {
			if (opened.status === 403) return err(403, "artifact-restricted");
			if (opened.status === 413) return err(413, "artifact-too-large");
			if (opened.status === 400 && /escapes/.test(opened.error))
				return err(404, "artifact-not-found");
			if (opened.status === 400) return err(400, "invalid-body", "path: not a regular file");
			return err(404, "artifact-not-found");
		}
		let content: Buffer;
		try {
			// Bounded by the opener's fstat; one byte more tells a file that
			// grew after it from one that fits.
			const buf = Buffer.alloc(Math.min(opened.size, this.max) + 1);
			const { bytesRead } = await opened.handle.read(buf, 0, buf.length, 0);
			if (bytesRead > this.max) return err(413, "artifact-too-large");
			content = buf.subarray(0, bytesRead);
		} finally {
			await opened.handle.close();
		}
		if (content.length === 0 || !isText(content)) return err(415, "artifact-not-text");
		const sha = sha256Hex(content);
		const rel = opened.rel;
		const name = sanitizeName(rel);
		const sourceKey = `${sid}:${rel}`;
		const answer = (status: number, replayed: boolean, n: string) => ({
			status,
			body: { sha256: sha, name: n, bytes: content.length, replayed },
		});

		const event = {
			ev: "artifact",
			sha256: sha,
			name,
			bytes: content.length,
			source: { kind: "owner", sid, path: rel, agent_id: agentId },
			by: ownerId,
		};

		const meta = { name, bytes: content.length, source: event.source };
		const sizes = { content: content.length, meta: metaBuffer(sha, meta).length };
		// Bytes this registration reserved against the unreferenced budget;
		// returned in `finally`, after every write of this call has settled.
		let reserved = 0;
		// What this registration may write: only what it reserved. Known
		// (referenced) content and content already on disk write nothing.
		let writes = { content: false, meta: false };

		try {
			// Pre-check: a replay, a quota already exceeded, or a log that would
			// refuse the event needs no write. The log check matters because the
			// content copy below is durable and the quota only counts what the
			// log references: a copy whose event the log then refuses (409
			// project-log-full, 503 persist-failed on a poisoned log) would be
			// disk spent outside every bound, once per distinct file.
			const pre = await this.deps.store.critical(projectId, async (tx) => {
				const known = tx.state.artifacts.get(sha);
				if (known?.sources.has(sourceKey)) return answer(200, true, known.name);
				if (!known && tx.state.artifactBytes + content.length > this.projectMax)
					return err(409, "artifacts-full");
				// Throws the append's own ProjectLogError ⇒ logErrorToHttp below.
				tx.assertAppendable([event]);
				// Already referenced ⇒ its files are on disk and counted by the
				// quota: nothing is written (only verified) and the directory is
				// not read.
				if (known) return null;

				// What the pre-check cannot exclude still leaves unreferenced
				// files: the log filling (or being poisoned, or the quota taken
				// by a concurrent registration) between here and the append, or
				// a death between the copy and the event. §6.2/§9: never deleted
				// automatically — a deletion would race a concurrent
				// registration of the same bytes that found the file already
				// there (EEXIST ⇒ reuse) and is about to log an event pointing
				// at it. Instead new bytes are admitted only while
				//   measured unreferenced bytes + reservations + this ≤ budget.
				// Measured and reserved in THIS critical section, so two
				// admissions never both decide on the same measurement: each one
				// sees the disk after every earlier admission either reserved
				// its bytes (counted here) or finished writing them and released
				// (now on disk, measured). The reservation total is read BEFORE
				// the measurement: a release landing during it was then counted
				// twice, never zero times.
				const pending = this.reservations.get(projectId) ?? 0;
				const usage = await unreferencedUsage(
					artifactsDir(this.deps.workspaceRoot, projectId),
					sha,
					sizes,
					tx.state.artifacts,
					this.unreferencedMax,
				);
				if (usage.need === 0) return null;
				if (usage.used + pending + usage.need > this.unreferencedMax)
					return err(409, "artifacts-full", "unreferenced");
				reserved = usage.need;
				writes = usage.writes;
				this.reservations.set(projectId, (this.reservations.get(projectId) ?? 0) + reserved);
				return null;
			});
			if (pre) return pre;

			await storeContent(this.deps.workspaceRoot, projectId, content, meta, writes);

			return await this.deps.store.critical(projectId, async (tx) => {
				const known = tx.state.artifacts.get(sha);
				if (known?.sources.has(sourceKey)) return answer(200, true, known.name);
				// Decided again here: the quota counts what the log references,
				// and only this section can see every registration in order.
				if (!known && tx.state.artifactBytes + content.length > this.projectMax)
					return err(409, "artifacts-full");
				await tx.append([event]);
				return answer(201, false, known?.name ?? name);
			});
		} catch (e) {
			const h = logErrorToHttp(e);
			if (h) return h;
			if (e instanceof ArtifactStoreCorrupt) return err(409, "artifact-corrupt");
			if (e instanceof ArtifactUsageUnverifiable)
				return err(503, "artifact-store-unverifiable", "unreferenced");
			throw e;
		} finally {
			// After storeContent has settled (its files linked or its temps
			// removed): from here the bytes are measured on disk instead.
			if (reserved > 0) {
				const left = (this.reservations.get(projectId) ?? 0) - reserved;
				if (left > 0) this.reservations.set(projectId, left);
				else this.reservations.delete(projectId);
			}
		}
	}

	private get projectMax(): number {
		return this.deps.projectMaxBytes ?? PROJECT_ARTIFACTS_MAX_BYTES;
	}

	private get unreferencedMax(): number {
		return this.deps.unreferencedMaxBytes ?? PROJECT_ARTIFACTS_UNREFERENCED_MAX_BYTES;
	}

	/** GET …/artifacts/:sha256 — only an artifact this project's log registered. */
	async content(
		projectId: string,
		sha: string,
	): Promise<{ ok: true; content: Buffer; name: string } | HttpResult> {
		const id = sha.toLowerCase();
		if (!SHA_RE.test(id)) return err(404, "artifact-not-found");
		const { state } = await this.deps.store.view(projectId);
		const known = state.artifacts.get(id);
		if (!known) return err(404, "artifact-not-found");
		try {
			const buf = await readContent(this.deps.workspaceRoot, projectId, id);
			if (!buf) return err(409, "artifact-corrupt", "content file missing");
			return { ok: true, content: buf, name: known.name };
		} catch (e) {
			if (e instanceof ArtifactStoreCorrupt) return err(409, "artifact-corrupt");
			throw e;
		}
	}

	/**
	 * The refs a message may carry (§6.3), from the folded log: every sha
	 * registered in this project, with its first registration's name.
	 */
	async lookup(
		projectId: string,
		shas: readonly string[],
	): Promise<{ ok: true; refs: ArtifactRef[] } | { ok: false; unknown: string }> {
		const { state } = await this.deps.store.view(projectId);
		const refs: ArtifactRef[] = [];
		for (const s of shas) {
			const k = state.artifacts.get(s);
			if (!k) return { ok: false, unknown: s };
			refs.push({ sha256: s, name: k.name, bytes: k.bytes });
		}
		return { ok: true, refs };
	}

	readContent(projectId: string, sha: string): Promise<Buffer | null> {
		return readContent(this.deps.workspaceRoot, projectId, sha);
	}
}
