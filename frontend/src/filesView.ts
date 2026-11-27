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
import { copyText } from "./clipboard.js";
import { showCopySuccessToast, showToast } from "./components/toast.js";
import { formatBytes } from "./format.js";
import { highlightCode, languageForFile } from "./highlight.js";
import { activeSessionId, isMobile, sessions } from "./main.js";
import { renderMarkdown } from "./markdown.js";
import { saveBlob } from "./saveBlob.js";
import { onWorkChange, reportWorkGone, workFor } from "./toolsContext.js";
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
/** …and its workspace: null = the principal one, else a work (toolsContext.ts). */
let stateWork: string | null = null;
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

// The reveal in flight (a route's path, a breadcrumb, a Markdown link):
// each await re-checks it, so a newer reveal, the person's own click, a
// view change or a session switch leaves the older one without effect.
let revealToken = 0;

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
	if (next !== "files") {
		revealToken++; // a reveal pending for a view that is gone is void
		return;
	}
	if (stateSessionId !== null && !dirs.has("")) void loadDir("");
	renderAll();
});

/**
 * Re-sync with the active session. Runs on every `syncSessionViews()`
 * (sessionCore's updateToolbar — every session selection / teardown —
 * and logout), after viewSwitch has settled which view is up.
 */
onSessionSync(syncFilesView);
onWorkChange(syncFilesView);

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
	if (s.sessionId !== stateSessionId || workFor(s.sessionId) !== stateWork) {
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
	revealToken++;
	previewAbort?.abort();
	previewAbort = null;
	stateSessionId = sessionId;
	stateWork = workFor(sessionId);
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
		const listing = await listWorkspaceDir(sessionId, path, stateWork);
		if (gen !== generation) return;
		dirs.set(path, { listing, loading: false, error: null });
	} catch (err) {
		if (gen !== generation) return;
		const status = err instanceof WorkspaceFsError ? err.status : 0;
		// The work is gone (cleaned) or not this session's: Herramientas shows
		// it as one state over the whole view, never a retry by another path.
		// Only its root says so: a subfolder's 404 (deleted since the parent
		// was listed) or 403 (restricted) is that folder's error.
		if (path === "" && stateWork !== null && (status === 404 || status === 403))
			reportWorkGone(sessionId, stateWork);
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
		data = await previewWorkspaceFile(sessionId, path, signal, stateWork);
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
			const blob = await fetchWorkspaceImage(sessionId, path, data.mime, signal, stateWork);
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
	const token = ++revealToken;
	const stale = () => gen !== generation || token !== revealToken;
	for (const dir of ancestorsOf(path)) {
		expanded.add(dir);
		if (!dirs.get(dir)?.listing) await loadDir(dir);
		if (stale()) return;
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
		showToast(`No se encontró: ${path}`, true);
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

async function downloadSelected(path: string): Promise<void> {
	const sessionId = stateSessionId;
	if (sessionId === null) return;
	try {
		showToast(`Descargando ${baseName(path)}…`);
		const { blob, filename } = await downloadSessionFile(sessionId, path, stateWork);
		saveBlob(blob, filename);
	} catch (err) {
		showToast(`Falló la descarga: ${(err as Error).message}`, true);
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
		treeEl.appendChild(stateBox("loading", "Cargando los archivos…"));
		return;
	}
	if (
		root.error &&
		stateWork !== null &&
		(root.error.status === 404 || root.error.status === 403)
	) {
		// The work is gone (cleaned) or not this session's: a state, never a
		// retry with another path — the client has no other way into it.
		treeEl.appendChild(stateBox("info", "Este trabajo ya no está disponible."));
		return;
	}
	if (root.error) {
		treeEl.appendChild(
			stateBox(
				"error",
				`No se pudo cargar el workspace: ${root.error.message}`,
				button("Reintentar", "files-btn", () => void loadDir("")),
			),
		);
		return;
	}
	if (root.listing && root.listing.entries.length === 0) {
		treeEl.appendChild(stateBox("empty", "Este workspace está vacío."));
		return;
	}

	const frag = document.createDocumentFragment();
	const renderLevel = (dirPath: string, depth: number) => {
		const state = dirs.get(dirPath);
		const pad = `${0.5 + depth * 0.9}rem`;
		if (!state || (state.loading && !state.listing)) {
			const row = el("div", "files-tree-note", "Cargando…");
			row.style.paddingLeft = pad;
			frag.appendChild(row);
			return;
		}
		if (state.error) {
			const row = el("div", "files-tree-note error");
			row.style.paddingLeft = pad;
			row.appendChild(el("span", undefined, state.error.message));
			row.appendChild(button("Reintentar", "files-link-btn", () => void loadDir(dirPath)));
			frag.appendChild(row);
			return;
		}
		const listing = state.listing as WorkspaceListing;
		if (listing.entries.length === 0) {
			const row = el("div", "files-tree-note", "Carpeta vacía");
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
				? `${entry.name} — restringido (puede contener credenciales)`
				: entry.type === "symlink"
					? `${entry.name} — enlace simbólico (no se sigue)`
					: entry.name;
			row.addEventListener("click", () => {
				revealToken++; // the person's choice voids a reveal in flight
				selectEntry(path, entry);
			});
			frag.appendChild(row);
			if (isOpen) renderLevel(path, depth + 1);
		}
		if (listing.truncated) {
			const row = el(
				"div",
				"files-tree-note",
				`Se muestran las primeras ${listing.entries.length} entradas`,
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
		button("‹ Archivos", "files-btn files-mobile-only", routeBack, "Volver a la lista de archivos"),
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
			previewEl.appendChild(stateBox("empty", "Elegí un archivo para verlo."));
		} else if (entry?.restricted) {
			previewEl.appendChild(previewHeader(name, "restringido", []));
			previewEl.appendChild(
				stateBox(
					"info",
					"Esta ruta está restringida porque puede contener credenciales (claves, tokens, secretos de .env, el login de Claude). Acá no se puede ver ni descargar.",
				),
			);
		} else if (entry?.type === "symlink") {
			previewEl.appendChild(previewHeader(name, "enlace simbólico", []));
			previewEl.appendChild(
				stateBox(
					"info",
					"Los enlaces simbólicos no se siguen. Abrí directamente el destino del enlace.",
				),
			);
		} else if (entry?.type === "other") {
			previewEl.appendChild(previewHeader(name, "archivo especial", []));
			previewEl.appendChild(
				stateBox("info", "Los sockets, pipes y archivos de dispositivo no se pueden ver."),
			);
		} else {
			const listing = dirs.get(selected.path)?.listing;
			const count = listing
				? `${listing.entries.length}${listing.truncated ? "+" : ""} elementos`
				: "";
			previewEl.appendChild(previewHeader(name, count ? `carpeta · ${count}` : "carpeta", []));
			previewEl.appendChild(stateBox("empty", "Elegí un archivo de esta carpeta para verlo."));
		}
		return;
	}

	const name = baseName(preview.path);
	if (preview.status === "loading") {
		previewEl.appendChild(previewHeader(name, "", []));
		previewEl.appendChild(stateBox("loading", "Cargando la vista previa…"));
		return;
	}
	const path = preview.path;
	const download = button(
		"Descargar",
		"files-btn",
		() => void downloadSelected(path),
		`Descargar ${name}`,
	);

	if (preview.status === "error") {
		previewEl.appendChild(previewHeader(name, "", []));
		const msg =
			preview.httpStatus === 403
				? "Este archivo está restringido porque puede contener credenciales. Acá no se puede ver ni descargar."
				: preview.httpStatus === 404
					? "Este archivo ya no existe. Actualizá para refrescar el árbol."
					: `No se pudo cargar la vista previa: ${preview.message}`;
		const retry =
			preview.httpStatus === 403
				? []
				: [button("Reintentar", "files-btn", () => void openPreview(path))];
		previewEl.appendChild(stateBox(preview.httpStatus === 403 ? "info" : "error", msg, ...retry));
		return;
	}

	const data = preview.data;
	const meta = `${formatBytes(data.size)} · modificado ${new Date(data.mtime).toLocaleString()}`;

	if (data.kind === "binary") {
		previewEl.appendChild(previewHeader(name, meta, [download]));
		const msg =
			data.reason === "too-large"
				? "Esta imagen es demasiado grande para verla acá. Descargala para abrirla."
				: "Parece un archivo binario, así que no se muestra. Descargalo para abrirlo en tu equipo.";
		previewEl.appendChild(
			stateBox(
				"info",
				msg,
				button("Descargar el archivo", "files-btn primary", () => void downloadSelected(path)),
			),
		);
		return;
	}

	if (data.kind === "image") {
		previewEl.appendChild(previewHeader(name, meta, [download]));
		const body = el("div", "files-image");
		if (preview.imageError) {
			body.appendChild(stateBox("error", `No se pudo cargar la imagen: ${preview.imageError}`));
		} else if (preview.imageUrl) {
			const img = el("img");
			img.alt = name;
			img.src = preview.imageUrl;
			img.addEventListener("error", () => {
				img.replaceWith(
					stateBox("info", "Tu navegador no puede mostrar este formato de imagen. Descargala."),
				);
			});
			body.appendChild(img);
		} else {
			body.appendChild(stateBox("loading", "Cargando la imagen…"));
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
		seg.setAttribute("aria-label", "Vista del Markdown");
		for (const mode of ["rendered", "source"] as const) {
			const b = button(mode === "rendered" ? "Vista previa" : "Fuente", "files-seg-btn", () => {
				markdownMode = mode;
				renderPreview();
			});
			b.setAttribute("aria-pressed", String(markdownMode === mode));
			seg.appendChild(b);
		}
		actions.push(seg);
	} else if (pretty !== null && pretty !== data.content) {
		const b = button(
			"Formatear",
			"files-btn",
			() => {
				jsonPretty = !jsonPretty;
				renderPreview();
			},
			"Alternar el JSON formateado",
		);
		b.setAttribute("aria-pressed", String(jsonPretty));
		actions.push(b);
	}
	const content = data.content;
	const copyBtn = button(
		"Copiar",
		"files-btn",
		() => {
			void copyText(content, copyBtn).then((ok) => {
				if (!ok) showToast("No se pudo copiar", true);
				else if (data.truncated)
					showToast("Se copió solo la parte mostrada (el archivo está truncado)");
				else showCopySuccessToast();
			});
		},
		"Copiar el contenido del archivo",
	);
	actions.push(copyBtn, download);
	previewEl.appendChild(previewHeader(name, meta, actions));

	if (data.truncated) {
		previewEl.appendChild(
			el(
				"div",
				"files-banner",
				`Archivo grande: se muestran los primeros ${formatBytes(content.length)}. Descargalo para verlo completo.`,
			),
		);
	}
	if (md && !mdRenderable) {
		previewEl.appendChild(
			el(
				"div",
				"files-banner",
				"Demasiado grande para mostrarlo como Markdown: se muestra la fuente.",
			),
		);
	}
	if (content.length === 0) {
		previewEl.appendChild(stateBox("empty", "Este archivo está vacío."));
		return;
	}
	const scroller = el("div", "files-preview-scroll");
	if (mdRenderable && markdownMode === "rendered") {
		scroller.classList.add("markdown");
		scroller.appendChild(
			renderMarkdown(content, {
				onRelativeLink: (href) => {
					const target = resolveRelativeLink(path, href);
					if (target === null) showToast("Ese enlace apunta fuera del workspace", true);
					else void revealPath(target);
				},
			}),
		);
	} else {
		scroller.appendChild(codeView(jsonPretty && pretty !== null ? pretty : content, name));
	}
	previewEl.appendChild(scroller);
}
