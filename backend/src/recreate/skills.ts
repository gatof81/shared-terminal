/**
 * recreate/skills.ts — precondition 8 (CONVERSATION.md §2.7.1): the
 * managed skills N's image would seed must not overwrite anything the
 * user changed.
 *
 * Three versions of each file under `/opt/session-skills/**` of N's
 * image: W (the workspace copy, `~/.claude/skills/<rel>`, i.e.
 * `.st/claude-state/skills/<rel>`), I_O (O's image) and I_N (N's image).
 *
 *   - W absent, W = I_N or W = I_O          ⇒ allowed
 *   - W differs from both                   ⇒ managed-skills-customized
 *   - W exists at a path O's image lacks    ⇒ managed-skills-collision
 *
 * The preflight creates nothing, so it compares against I_O alone (it
 * passes I_O as I_N); the POST repeats the check against the real I_N in
 * step 1. Files that are not managed are never read or touched.
 */

import { openWorkspaceFile, readHead } from "../workspaceFiles.js";
import { parseTar, type TarEntry } from "./tar.js";

export type SkillsCode = "managed-skills-customized" | "managed-skills-collision";

export const SKILLS_IMAGE_DIR = "/opt/session-skills";
/** Where the entrypoint seeds them, relative to the workspace. */
export const SKILLS_WORKSPACE_DIR = ".st/claude-state/skills";
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;
export const SKILLS_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
const SKILLS_MAX_ENTRIES = 2000;

/** File contents by path relative to the skills root; `other` = a non-file entry. */
export type SkillSet = Map<string, Buffer | "other">;

export type WorkspaceSkill =
	| { kind: "absent" }
	| { kind: "file"; data: Buffer }
	| { kind: "other" };

/**
 * The image's skills from a `getArchive(<container>, /opt/session-skills)`
 * tar, or null when the image has no such directory (404 from Docker,
 * mapped by the caller).
 */
export function skillSetFromTar(tar: Buffer): SkillSet {
	const entries: TarEntry[] = parseTar(tar, {
		maxEntries: SKILLS_MAX_ENTRIES,
		maxFileBytes: SKILL_FILE_MAX_BYTES,
	});
	const out: SkillSet = new Map();
	const root = SKILLS_IMAGE_DIR.split("/").pop()!; // "session-skills"
	for (const e of entries) {
		if (e.path !== root && !e.path.startsWith(`${root}/`)) {
			throw new Error("skills archive entry outside its root");
		}
		const rel = e.path === root ? "" : e.path.slice(root.length + 1);
		if (rel === "" || e.type === "dir") continue;
		if (rel.split("/").some((seg) => seg === ".." || seg === "")) {
			throw new Error("skills archive entry with an unsafe path");
		}
		out.set(rel, e.type === "file" ? (e.data as Buffer) : "other");
	}
	return out;
}

export async function compareSkills(
	imageN: SkillSet,
	imageO: SkillSet | null,
	readW: (rel: string) => Promise<WorkspaceSkill>,
): Promise<Array<{ code: SkillsCode; count: number }>> {
	let customized = 0;
	let collision = 0;
	for (const [rel, iN] of imageN) {
		const w = await readW(rel);
		if (w.kind === "absent") continue;
		const iO = imageO?.get(rel);
		if (iO === undefined) {
			collision++;
			continue;
		}
		// A non-file in either image can't be compared byte for byte:
		// fail-closed rather than let a seed overwrite it.
		if (iN === "other" || iO === "other" || w.kind === "other") {
			collision++;
			continue;
		}
		if (w.data.equals(iN) || w.data.equals(iO)) continue;
		customized++;
	}
	const out: Array<{ code: SkillsCode; count: number }> = [];
	if (customized) out.push({ code: "managed-skills-customized", count: customized });
	if (collision) out.push({ code: "managed-skills-collision", count: collision });
	return out;
}

/**
 * W through the workspace opener (lexical + realpath containment, an
 * O_NOFOLLOW open and the `/proc/self/fd` proof), never a plain readFile
 * on a user-controlled path. `.st/` is a restricted path for the user
 * routes; this backend-internal read is the one caller allowed past it.
 * Anything that exists but is not a plain readable file (a symlink, a
 * directory, an oversized file) is `other`, which blocks.
 */
export async function readWorkspaceSkill(sessionId: string, rel: string): Promise<WorkspaceSkill> {
	const r = await openWorkspaceFile(sessionId, `${SKILLS_WORKSPACE_DIR}/${rel}`, {
		maxBytes: SKILL_FILE_MAX_BYTES,
		allowRestricted: true,
	});
	if (r.ok) {
		try {
			const { bytes, truncated } = await readHead(r.handle, SKILL_FILE_MAX_BYTES, r.size);
			return truncated ? { kind: "other" } : { kind: "file", data: bytes };
		} finally {
			await r.handle.close();
		}
	}
	if (r.status === 404 && r.absent) return { kind: "absent" };
	return { kind: "other" };
}
