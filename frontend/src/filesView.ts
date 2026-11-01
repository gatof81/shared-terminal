/**
 * filesView.ts — the Workspace Explorer: a read-only "Files" view of the
 * active session's persistent workspace, alongside the terminal.
 *
 * The view is an OVERLAY over the terminal; the switching mechanics and
 * the terminal invariant (never disconnect / resize / dispose the
 * terminal) live in viewSwitch.ts, shared with the Git view. This module
 * owns the explorer's data and rendering only.
 *
 * Files works for stopped / soft-deleted sessions too: the backend reads
 * the host bind mount, no container needed. sessionCore opens such
 * sessions straight into this view with the Terminal toggle disabled.
 *
 * All file content is rendered via textContent / DOM construction
 * (markdown.ts, highlight.ts) — never innerHTML.
 */

import {
	downloadSessionFile,
	fetchWorkspaceImage,
	listWorkspaceDir,
	previewWorkspaceFile,
	type WorkspaceEntry,
	WorkspaceFsError,
	type WorkspaceListing,
	type WorkspacePreview,
} from "./api.js";
import { formatBytes } from "./format.js";
import { highlightCode, languageForFile } from "./highlight.js";
import { activeSessionId, isMobile, sessions, showCopySuccessToast, showToast } from "./main.js";
import { renderMarkdown } from "./markdown.js";
import { saveBlob } from "./saveBlob.js";
import { button, el, stateBox } from "./ui.js";
import {
	getView,
	onSessionSync,
	onViewChange,
	reflectRoute,
	registerRouteDetail,
	routeBack,
} from "./viewSwitch.js";
import {
	ancestorsOf,
	baseName,
	breadcrumbsFor,
	joinPath,
	parentPath,
	resolveRelativeLink,
} from "./workspacePaths.js";

// ── DOM ─────────────────────────────────────────────────────────────────────
const breadcrumbsEl = document.getElementById("files-breadcrumbs")!;
const refreshBtn = document.getElementById("files-refresh-btn") as HTMLButtonElement;
const filesBody = document.getElementById("files-body")!;
const treeEl = document.getElementById("files-tree")!;
const previewEl = document.getElementById("files-preview")!;

// ── State ───────────────────────────────────────────────────────────────────

/** Session the cached explorer state below belongs to. */
let stateSessionId: string | null = null;
// Bumped on every session switch; async results carrying an older value
// are dropped so a slow listing for session A never renders into B.
let generation = 0;

interface DirState {
	listing: WorkspaceListing | null;
	loading: boolean;
	error: { message: string; status: number } | null;
}
const dirs = new Map<string, DirState>();
const expanded = new Set<string>([""]);

type Selected = { path: string; entry: WorkspaceEntry | null };
let selected: Selected | null = null;

type PreviewState =
	| { status: "none" }
	| { status: "loading"; path: string }
	| { status: "error"; path: string; message: string; httpStatus: number }
	| {
			status: "loaded";
			path: string;
			data: WorkspacePreview;
			imageUrl: string | null;
			imageError: string | null;
	  };
let preview: PreviewState = { status: "none" };
let previewToken = 0;
// Aborts the superseded preview/image request when the user moves on, so
// clicking quickly through files doesn't leave a queue of server-side
// reads (each holding one of the backend's per-user preview slots).
let previewAbort: AbortController | null = null;

// Persisted per page-load across files: someone reading docs wants every
// .md rendered; someone reviewing markup wants source for all of them.
let markdownMode: "rendered" | "source" = "rendered";
let jsonPretty = false;

const MARKDOWN_RENDER_MAX_CHARS = 256 * 1024;
// Mobile is single-pane: tree OR preview.
let mobilePane: "tree" | "preview" = "tree";

// ── View switching ──────────────────────────────────────────────────────────

export function isFilesViewActive(): boolean {
	return getView() === "files";
}

onViewChange((next) => {
	if (next !== "files") return;
	if (stateSessionId !== null && !dirs.has("")) void loadDir("");
	renderAll();
});

/**
 * Re-sync with the active session. Runs on every `syncSessionViews()`
 * (sessionCore's updateToolbar — every session selection / teardown —
 * and logout), after viewSwitch has settled which view is up.
 */
onSessionSync(syncFilesView);

// Route detail = the selected path (#/sessions/<id>/files/<path>).
registerRouteDetail("files", {
	current: () => selected?.path ?? null,
	apply: (path) => void revealPath(path ?? ""),
});

function syncFilesView(): void {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) {
		resetState(null);
		return;
	}
	if (s.sessionId !== stateSessionId) {
		resetState(s.sessionId);
		if (isFilesViewActive()) {
			void loadDir("");
			renderAll();
		}
	}
	// No unconditional renderAll here: this runs on every session-list
	// poll, and rebuilding the preview would reset its scroll position
	// and drop the user's text selection every few seconds.
}

function resetState(sessionId: string | null): void {
	generation++;
	previewAbort?.abort();
	previewAbort = null;
	stateSessionId = sessionId;
	dirs.clear();
	expanded.clear();
	expanded.add("");
	selected = null;
	clearPreview();
	mobilePane = "tree";
}

// ── Data loading ────────────────────────────────────────────────────────────

async function loadDir(path: string): Promise<void> {
	const sessionId = stateSessionId;
	if (sessionId === null) return;
	const gen = generation;
	const prev = dirs.get(path);
	dirs.set(path, { listing: prev?.listing ?? null, loading: true, error: null });
	renderTree();
	try {
		const listing = await listWorkspaceDir(sessionId, path);
		if (gen !== generation) return;
		dirs.set(path, { listing, loading: false, error: null });
	} catch (err) {
		if (gen !== generation) return;
		const status = err instanceof WorkspaceFsError ? err.status : 0;
		dirs.set(path, {
			listing: null,
			loading: false,
			error: { message: (err as Error).message, status },
		});
	}
	renderTree();
	if (selected?.path === path) renderPreview();
}

/** Drop the preview and invalidate any in-flight preview request. */
function clearPreview(): void {
	previewToken++;
	previewAbort?.abort();
	previewAbort = null;
	setPreview({ status: "none" });
}

function setPreview(next: PreviewState): void {
	// Free the previous image blob — object URLs pin their Blob until
	// revoked, and an image-heavy browse would otherwise accumulate them.
	if (preview.status === "loaded" && preview.imageUrl) URL.revokeObjectURL(preview.imageUrl);
	preview = next;
}

async function openPreview(path: string): Promise<void> {
	const sessionId = stateSessionId;
	if (sessionId === null) return;
	const token = ++previewToken;
	previewAbort?.abort();
	const abort = new AbortController();
	previewAbort = abort;
	const { signal } = abort;
	const stale = () => token !== previewToken || sessionId !== stateSessionId;
	setPreview({ status: "loading", path });
	renderPreview();
	let data: WorkspacePreview;
	try {
		data = await previewWorkspaceFile(sessionId, path, signal);
	} catch (err) {
		if (stale()) return;
		const httpStatus = err instanceof WorkspaceFsError ? err.status : 0;
		setPreview({ status: "error", path, message: (err as Error).message, httpStatus });
		renderPreview();
		return;
	}
	if (stale()) return;
	setPreview({ status: "loaded", path, data, imageUrl: null, imageError: null });
	renderPreview();
	if (data.kind === "image") {
		try {
			const blob = await fetchWorkspaceImage(sessionId, path, data.mime, signal);
			if (stale()) return;
			setPreview({
				status: "loaded",
				path,
				data,
				imageUrl: URL.createObjectURL(blob),
				imageError: null,
			});
		} catch (err) {
			if (stale()) return;
			setPreview({
				status: "loaded",
				path,
				data,
				imageUrl: null,
				imageError: (err as Error).message,
			});
		}
		renderPreview();
	}
}

function findEntry(path: string): WorkspaceEntry | null {
	if (path === "") return null;
	const listing = dirs.get(parentPath(path))?.listing;
	return listing?.entries.find((e) => e.name === baseName(path)) ?? null;
}

// ── Actions ─────────────────────────────────────────────────────────────────

function selectEntry(path: string, entry: WorkspaceEntry | null): void {
	selected = { path, entry };
	if (entry === null || entry.type === "dir") {
		// Restricted folders are listed but never expanded.
		if (!entry?.restricted && path !== "") {
			if (expanded.has(path)) {
				expanded.delete(path);
			} else {
				expanded.add(path);
				if (!dirs.get(path)?.listing) void loadDir(path);
			}
		}
		clearPreview();
	} else if (entry.type === "file" && !entry.restricted) {
		void openPreview(path);
		if (isMobile()) mobilePane = "preview";
	} else {
		// Restricted file / symlink / special file: explain in the pane.
		clearPreview();
		if (isMobile()) mobilePane = "preview";
	}
	renderAll();
	// Opening a file is a step Back undoes (a no-op while a route is being applied).
	reflectRoute({ push: true });
}

/** Expand every ancestor of `path` (loading as needed), then select it. */
async function revealPath(path: string): Promise<void> {
	const gen = generation;
	for (const dir of ancestorsOf(path)) {
		expanded.add(dir);
		if (!dirs.get(dir)?.listing) await loadDir(dir);
		if (gen !== generation) return;
	}
	if (path === "") {
		selected = null;
		clearPreview();
		mobilePane = "tree";
		renderAll();
		return;
	}
	const entry = findEntry(path);
	if (!entry) {
		showToast(`Not found: ${path}`, true);
		return;
	}
	if (entry.type === "dir") {
		expanded.delete(path); // selectEntry toggles it back open
		mobilePane = "tree";
	}
	selectEntry(path, entry);
	findRow(path)?.scrollIntoView({ block: "nearest" });
}

async function refresh(): Promise<void> {
	if (stateSessionId === null) return;
	refreshBtn.classList.add("spinning");
	refreshBtn.disabled = true;
	try {
		// Reload what's on screen: expanded dirs that were loaded (or
		// failed) and the open file. Collapsed dirs are dropped from the
		// cache so they re-fetch fresh when next opened.
		for (const key of [...dirs.keys()]) if (!expanded.has(key)) dirs.delete(key);
		const loads = [...expanded].filter((p) => p === "" || dirs.has(p)).map((p) => loadDir(p));
		if (preview.status !== "none") loads.push(openPreview(preview.path));
		await Promise.all(loads);
	} finally {
		refreshBtn.classList.remove("spinning");
		refreshBtn.disabled = false;
	}
}
refreshBtn.addEventListener("click", () => void refresh());

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Clipboard API unavailable (insecure context) or denied — the
		// legacy execCommand path still works on most browsers.
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	}
}

async function downloadSelected(path: string): Promise<void> {
	const sessionId = stateSessionId;
	if (sessionId === null) return;
	try {
		showToast(`Downloading ${baseName(path)}…`);
		const { blob, filename } = await downloadSessionFile(sessionId, path);
		saveBlob(blob, filename);
	} catch (err) {
		showToast(`Download failed: ${(err as Error).message}`, true);
	}
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderAll(): void {
	if (!isFilesViewActive()) return;
	renderBreadcrumbs();
	renderTree();
	renderPreview();
	filesBody.classList.toggle("show-preview", mobilePane === "preview");
}

function renderBreadcrumbs(): void {
	breadcrumbsEl.replaceChildren();
	const path = selected?.path ?? "";
	const crumbs = breadcrumbsFor(path);
	crumbs.forEach((c, i) => {
		if (i > 0) breadcrumbsEl.appendChild(el("span", "files-crumb-sep", "/"));
		const isLast = i === crumbs.length - 1;
		const isFileLeaf = isLast && selected?.entry !== null && selected?.entry?.type !== "dir";
		if (isFileLeaf) {
			const leaf = el("span", "files-crumb current", c.label);
			leaf.setAttribute("aria-current", "page");
			breadcrumbsEl.appendChild(leaf);
		} else {
			const b = button(
				c.label,
				`files-crumb${isLast ? " current" : ""}`,
				() => void revealPath(c.path),
			);
			if (isLast) b.setAttribute("aria-current", "page");
			breadcrumbsEl.appendChild(b);
		}
	});
	// Keep the deepest crumb visible when the trail overflows.
	breadcrumbsEl.scrollLeft = breadcrumbsEl.scrollWidth;
}

function entryIcon(entry: WorkspaceEntry, isOpen: boolean): string {
	if (entry.restricted) return "🔒";
	switch (entry.type) {
		case "dir":
			return isOpen ? "▾" : "▸";
		case "symlink":
			return "↪";
		case "other":
			return "◇";
		default:
			return "·";
	}
}

function renderTree(): void {
	if (!isFilesViewActive()) return;
	const active = document.activeElement;
	const focusedPath =
		active instanceof HTMLElement && treeEl.contains(active) ? active.dataset.path : undefined;
	const scrollTop = treeEl.scrollTop;
	treeEl.replaceChildren();

	const root = dirs.get("");
	if (!root || (root.loading && !root.listing)) {
		treeEl.appendChild(stateBox("loading", "Loading files…"));
		return;
	}
	if (root.error) {
		treeEl.appendChild(
			stateBox(
				"error",
				`Couldn't load the workspace: ${root.error.message}`,
				button("Retry", "files-btn", () => void loadDir("")),
			),
		);
		return;
	}
	if (root.listing && root.listing.entries.length === 0) {
		treeEl.appendChild(stateBox("empty", "This workspace is empty."));
		return;
	}

	const frag = document.createDocumentFragment();
	const renderLevel = (dirPath: string, depth: number) => {
		const state = dirs.get(dirPath);
		const pad = `${0.5 + depth * 0.9}rem`;
		if (!state || (state.loading && !state.listing)) {
			const row = el("div", "files-tree-note", "Loading…");
			row.style.paddingLeft = pad;
			frag.appendChild(row);
			return;
		}
		if (state.error) {
			const row = el("div", "files-tree-note error");
			row.style.paddingLeft = pad;
			row.appendChild(el("span", undefined, state.error.message));
			row.appendChild(button("Retry", "files-link-btn", () => void loadDir(dirPath)));
			frag.appendChild(row);
			return;
		}
		const listing = state.listing as WorkspaceListing;
		if (listing.entries.length === 0) {
			const row = el("div", "files-tree-note", "Empty folder");
			row.style.paddingLeft = pad;
			frag.appendChild(row);
		}
		for (const entry of listing.entries) {
			const path = joinPath(dirPath, entry.name);
			const isDir = entry.type === "dir" && !entry.restricted;
			const isOpen = isDir && expanded.has(path);
			const row = el("button", "files-row");
			row.type = "button";
			row.dataset.path = path;
			row.setAttribute("role", "treeitem");
			row.setAttribute("aria-level", String(depth + 1));
			row.setAttribute("aria-selected", String(selected?.path === path));
			if (isDir) row.setAttribute("aria-expanded", String(isOpen));
			if (entry.restricted) row.classList.add("restricted");
			if (selected?.path === path) row.classList.add("selected");
			row.style.paddingLeft = pad;
			row.appendChild(el("span", `files-row-icon type-${entry.type}`, entryIcon(entry, isOpen)));
			row.appendChild(el("span", "files-row-name", entry.name));
			if (entry.type === "file" && entry.size !== null) {
				row.appendChild(el("span", "files-row-size", formatBytes(entry.size)));
			}
			row.title = entry.restricted
				? `${entry.name} — restricted (may contain credentials)`
				: entry.type === "symlink"
					? `${entry.name} — symbolic link (not followed)`
					: entry.name;
			row.addEventListener("click", () => selectEntry(path, entry));
			frag.appendChild(row);
			if (isOpen) renderLevel(path, depth + 1);
		}
		if (listing.truncated) {
			const row = el(
				"div",
				"files-tree-note",
				`Showing the first ${listing.entries.length} entries`,
			);
			row.style.paddingLeft = pad;
			frag.appendChild(row);
		}
	};
	renderLevel("", 0);
	treeEl.appendChild(frag);
	treeEl.scrollTop = scrollTop;
	if (focusedPath !== undefined) {
		findRow(focusedPath)?.focus();
	}
}

function findRow(path: string): HTMLElement | undefined {
	return [...treeEl.querySelectorAll<HTMLElement>(".files-row")].find(
		(r) => r.dataset.path === path,
	);
}

// Arrow-key tree navigation (WAI-ARIA tree pattern, simplified): ↑/↓ move
// between visible rows, → expands / enters a folder, ← collapses / jumps
// to the parent. Enter/Space are the rows' native button activation.
treeEl.addEventListener("keydown", (e) => {
	const row = (e.target as HTMLElement).closest<HTMLElement>(".files-row");
	if (!row) return;
	const rows = [...treeEl.querySelectorAll<HTMLElement>(".files-row")];
	const idx = rows.indexOf(row);
	const path = row.dataset.path as string;
	const focusAt = (i: number) => rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
	switch (e.key) {
		case "ArrowDown":
			focusAt(idx + 1);
			break;
		case "ArrowUp":
			focusAt(idx - 1);
			break;
		case "Home":
			focusAt(0);
			break;
		case "End":
			focusAt(rows.length - 1);
			break;
		case "ArrowRight":
			if (row.getAttribute("aria-expanded") === "false") row.click();
			else if (row.getAttribute("aria-expanded") === "true") focusAt(idx + 1);
			break;
		case "ArrowLeft":
			if (row.getAttribute("aria-expanded") === "true") row.click();
			else findRow(parentPath(path))?.focus();
			break;
		default:
			return;
	}
	e.preventDefault();
});

function previewHeader(name: string, meta: string, actions: HTMLElement[]): HTMLElement {
	const header = el("div", "files-preview-header");
	header.appendChild(
		button("‹ Files", "files-btn files-mobile-only", routeBack, "Back to file list"),
	);
	const title = el("div", "files-preview-title");
	title.appendChild(el("span", "files-preview-name", name));
	if (meta) title.appendChild(el("span", "files-preview-meta", meta));
	header.appendChild(title);
	const bar = el("div", "files-preview-actions");
	bar.append(...actions);
	header.appendChild(bar);
	return header;
}

function codeView(content: string, name: string): HTMLElement {
	const wrap = el("div", "files-code");
	const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	const gutter = el("pre", "files-code-gutter");
	gutter.setAttribute("aria-hidden", "true");
	gutter.textContent = lines.map((_, i) => String(i + 1)).join("\n");
	const pre = el("pre", "files-code-body");
	const code = el("code");
	code.appendChild(highlightCode(content, languageForFile(name)));
	pre.appendChild(code);
	wrap.append(gutter, pre);
	return wrap;
}

function isMarkdown(name: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(name);
}

function prettyJson(content: string): string | null {
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return null;
	}
}

function renderPreview(): void {
	if (!isFilesViewActive()) return;
	previewEl.replaceChildren();

	if (preview.status === "none") {
		const entry = selected?.entry ?? null;
		const name = selected ? baseName(selected.path) || "workspace" : "";
		if (!selected) {
			previewEl.appendChild(stateBox("empty", "Select a file to preview it."));
		} else if (entry?.restricted) {
			previewEl.appendChild(previewHeader(name, "restricted", []));
			previewEl.appendChild(
				stateBox(
					"info",
					"This path is restricted because it may contain credentials (keys, tokens, .env secrets, Claude login state). It can't be previewed or downloaded here.",
				),
			);
		} else if (entry?.type === "symlink") {
			previewEl.appendChild(previewHeader(name, "symbolic link", []));
			previewEl.appendChild(
				stateBox("info", "Symbolic links aren't followed. Open the link's target directly."),
			);
		} else if (entry?.type === "other") {
			previewEl.appendChild(previewHeader(name, "special file", []));
			previewEl.appendChild(
				stateBox("info", "Sockets, pipes and device files can't be previewed."),
			);
		} else {
			const listing = dirs.get(selected.path)?.listing;
			const count = listing ? `${listing.entries.length}${listing.truncated ? "+" : ""} items` : "";
			previewEl.appendChild(previewHeader(name, count ? `folder · ${count}` : "folder", []));
			previewEl.appendChild(stateBox("empty", "Select a file in this folder to preview it."));
		}
		return;
	}

	const name = baseName(preview.path);
	if (preview.status === "loading") {
		previewEl.appendChild(previewHeader(name, "", []));
		previewEl.appendChild(stateBox("loading", "Loading preview…"));
		return;
	}
	const path = preview.path;
	const download = button(
		"Download",
		"files-btn",
		() => void downloadSelected(path),
		`Download ${name}`,
	);

	if (preview.status === "error") {
		previewEl.appendChild(previewHeader(name, "", []));
		const msg =
			preview.httpStatus === 403
				? "This file is restricted because it may contain credentials. It can't be previewed or downloaded here."
				: preview.httpStatus === 404
					? "This file no longer exists. Refresh to update the tree."
					: `Couldn't load the preview: ${preview.message}`;
		const retry =
			preview.httpStatus === 403
				? []
				: [button("Retry", "files-btn", () => void openPreview(path))];
		previewEl.appendChild(stateBox(preview.httpStatus === 403 ? "info" : "error", msg, ...retry));
		return;
	}

	const data = preview.data;
	const meta = `${formatBytes(data.size)} · modified ${new Date(data.mtime).toLocaleString()}`;

	if (data.kind === "binary") {
		previewEl.appendChild(previewHeader(name, meta, [download]));
		const msg =
			data.reason === "too-large"
				? "This image is too large to preview inline. Download it to view."
				: "This looks like a binary file, so it isn't rendered. Download it to open it locally.";
		previewEl.appendChild(
			stateBox(
				"info",
				msg,
				button("Download file", "files-btn primary", () => void downloadSelected(path)),
			),
		);
		return;
	}

	if (data.kind === "image") {
		previewEl.appendChild(previewHeader(name, meta, [download]));
		const body = el("div", "files-image");
		if (preview.imageError) {
			body.appendChild(stateBox("error", `Couldn't load the image: ${preview.imageError}`));
		} else if (preview.imageUrl) {
			const img = el("img");
			img.alt = name;
			img.src = preview.imageUrl;
			img.addEventListener("error", () => {
				img.replaceWith(
					stateBox("info", "Your browser can't display this image format. Download it instead."),
				);
			});
			body.appendChild(img);
		} else {
			body.appendChild(stateBox("loading", "Loading image…"));
		}
		previewEl.appendChild(body);
		return;
	}

	// Text.
	const actions: HTMLElement[] = [];
	const md = isMarkdown(name);
	// Rendering builds DOM synchronously on the thread that also drives
	// the terminal; past this size, show highlighted source instead (the
	// renderer is linear and budgeted, but 1 MiB of prose is still a lot
	// of layout for little benefit).
	const mdRenderable = md && data.content.length <= MARKDOWN_RENDER_MAX_CHARS;
	const pretty =
		name.toLowerCase().endsWith(".json") && !data.truncated ? prettyJson(data.content) : null;
	if (mdRenderable) {
		const seg = el("div", "files-seg");
		seg.setAttribute("role", "group");
		seg.setAttribute("aria-label", "Markdown view");
		for (const mode of ["rendered", "source"] as const) {
			const b = button(mode === "rendered" ? "Preview" : "Source", "files-seg-btn", () => {
				markdownMode = mode;
				renderPreview();
			});
			b.setAttribute("aria-pressed", String(markdownMode === mode));
			seg.appendChild(b);
		}
		actions.push(seg);
	} else if (pretty !== null && pretty !== data.content) {
		const b = button(
			"Format",
			"files-btn",
			() => {
				jsonPretty = !jsonPretty;
				renderPreview();
			},
			"Toggle pretty-printed JSON",
		);
		b.setAttribute("aria-pressed", String(jsonPretty));
		actions.push(b);
	}
	const content = data.content;
	actions.push(
		button(
			"Copy",
			"files-btn",
			() => {
				void copyText(content).then((ok) => {
					if (!ok) showToast("Copy failed — clipboard permission denied?", true);
					else if (data.truncated) showToast("Copied the previewed part only (file is truncated)");
					else showCopySuccessToast();
				});
			},
			"Copy file contents",
		),
		download,
	);
	previewEl.appendChild(previewHeader(name, meta, actions));

	if (data.truncated) {
		previewEl.appendChild(
			el(
				"div",
				"files-banner",
				`Large file — showing the first ${formatBytes(content.length)}. Download it for the full contents.`,
			),
		);
	}
	if (md && !mdRenderable) {
		previewEl.appendChild(
			el("div", "files-banner", "Too large to render as Markdown — showing the source."),
		);
	}
	if (content.length === 0) {
		previewEl.appendChild(stateBox("empty", "This file is empty."));
		return;
	}
	const scroller = el("div", "files-preview-scroll");
	if (mdRenderable && markdownMode === "rendered") {
		scroller.classList.add("markdown");
		scroller.appendChild(
			renderMarkdown(content, {
				onRelativeLink: (href) => {
					const target = resolveRelativeLink(path, href);
					if (target === null) showToast("That link points outside the workspace", true);
					else void revealPath(target);
				},
			}),
		);
	} else {
		scroller.appendChild(codeView(jsonPretty && pretty !== null ? pretty : content, name));
	}
	previewEl.appendChild(scroller);
}
