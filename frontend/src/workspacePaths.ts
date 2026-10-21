/**
 * workspacePaths.ts — pure helpers for workspace-relative paths in the
 * Workspace Explorer. Paths are POSIX, no leading slash, "" = the root.
 *
 * These are UX helpers only — the backend re-validates and containment-
 * checks every path it receives, so nothing here is a security boundary.
 */

export function joinPath(dir: string, name: string): string {
	return dir === "" ? name : `${dir}/${name}`;
}

export function parentPath(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Every ancestor directory of `path`, root first, excluding `path`. */
export function ancestorsOf(path: string): string[] {
	const out = [""];
	const segs = path.split("/").filter(Boolean);
	for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join("/"));
	return path === "" ? [] : out;
}

export interface Crumb {
	label: string;
	path: string;
}

/** Breadcrumb trail for `path`, starting at the workspace root. */
export function breadcrumbsFor(path: string, rootLabel = "workspace"): Crumb[] {
	const crumbs: Crumb[] = [{ label: rootLabel, path: "" }];
	const segs = path.split("/").filter(Boolean);
	segs.forEach((seg, i) => {
		crumbs.push({ label: seg, path: segs.slice(0, i + 1).join("/") });
	});
	return crumbs;
}

/**
 * Resolve a relative Markdown link (`../docs/a.md#intro`) against the
 * file containing it. Returns the workspace-relative target, or null when
 * the link climbs above the workspace root. A leading `/` is taken as
 * workspace-root-relative (GitHub's repo-root convention).
 */
export function resolveRelativeLink(fromFile: string, href: string): string | null {
	const clean = href.split("#")[0]?.split("?")[0] ?? "";
	let decoded: string;
	try {
		decoded = decodeURIComponent(clean);
	} catch {
		decoded = clean;
	}
	const base = decoded.startsWith("/") ? [] : parentPath(fromFile).split("/").filter(Boolean);
	for (const seg of decoded.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (base.length === 0) return null;
			base.pop();
		} else {
			base.push(seg);
		}
	}
	return base.join("/");
}
