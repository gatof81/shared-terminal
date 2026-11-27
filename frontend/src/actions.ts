/**
 * actions.ts — the mobile actions (+) menu and the file-attachment flow
 * (#286). Extracted from main.ts (#312). DOM re-queried locally; the
 * main.ts imports (getActiveTerminal, showToast, activeSessionId, sessions)
 * and runPasteFlow (paste.ts) are read only inside functions/handlers, so
 * the circular import is TDZ-safe. closeActionsMenu is exported for the
 * one main.ts caller.
 */

import { downloadSessionFile, uploadSessionFiles } from "./api.js";
import { createDialog, promptDialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import { activeSessionId, getActiveTerminal } from "./main.js";
import { runPasteFlow } from "./paste.js";
import { saveBlob } from "./saveBlob.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const actionsBtn = document.getElementById("actions-btn") as HTMLButtonElement;
const actionsMenu = document.getElementById("actions-menu")!;
const actionsPasteBtn = document.getElementById("actions-paste-btn") as HTMLButtonElement;
const actionsAttachBtn = document.getElementById("actions-attach-btn") as HTMLButtonElement;
const actionsSelectBtn = document.getElementById("actions-select-btn") as HTMLButtonElement;
const actionsDownloadBtn = document.getElementById("actions-download-btn") as HTMLButtonElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;

// ── Actions (+) menu ────────────────────────────────────────────────────────
// The mobile "+" button hosts both the existing paste flow and the new
// file-attach flow. Two-step UX (open menu → pick action) is the cost of
// supporting more than one command from a single header button.

const actionsDialog = createDialog(actionsMenu, {
	initialFocus: () => actionsPasteBtn,
	onClose: () => actionsBtn.setAttribute("aria-expanded", "false"),
});

function openActionsMenu() {
	actionsBtn.setAttribute("aria-expanded", "true");
	actionsDialog.open(actionsBtn);
}

function closeActionsMenu() {
	actionsDialog.close();
}

actionsBtn.addEventListener("click", () => {
	if (actionsDialog.isOpen()) closeActionsMenu();
	else openActionsMenu();
});

actionsPasteBtn.addEventListener("click", async () => {
	closeActionsMenu();
	// actionsBtn is the visible widget the user tapped first; route focus
	// back to it when the paste modal eventually closes.
	await runPasteFlow(actionsBtn);
});

actionsAttachBtn.addEventListener("click", () => {
	closeActionsMenu();
	// Reset the input so picking the same file twice in a row still
	// fires `change` (browsers no-op when value is unchanged).
	fileInput.value = "";
	fileInput.click();
});

// "Select & copy" (#286). On touch there's no Cmd-C and tmux `mouse on`
// forwards finger drags as scroll, so the user has no way to make — let
// alone copy — a selection. This entry copies an existing selection if
// one's present, then arms select-mode so the *next* finger drag builds a
// fresh selection that auto-copies on release (the auto-copy + toast path
// from #158 fires it; select-mode self-clears after one selection). On
// desktop `enterSelectMode` is a harmless no-op — only the copy runs.
actionsSelectBtn.addEventListener("click", () => {
	closeActionsMenu();
	const term = getActiveTerminal();
	if (!term) {
		showToast("No hay una sesión activa", true);
		return;
	}
	// When a selection already exists the user's intent is "copy this" —
	// copySelection handles it (and toasts via onCopy). Only when there's
	// nothing to copy do we arm select-mode for a fresh drag; arming it
	// after a successful copy would make the user's next scroll gesture
	// silently intercept as a selection attempt.
	const copied = term.copySelection();
	if (!copied) {
		term.enterSelectMode();
		showToast("Arrastrá sobre la terminal para seleccionar: se copia solo");
	}
});

// ── File download flow (#358) ───────────────────────────────────────────────
// Quick path prompt; the Files view (Workspace Explorer) is the
// browse-and-click alternative. Both save via saveBlob.

let downloadInFlight = false;

actionsDownloadBtn.addEventListener("click", async () => {
	closeActionsMenu();
	if (downloadInFlight) {
		showToast("Ya hay una descarga en curso; probá de nuevo en un momento", true);
		return;
	}
	if (!activeSessionId) {
		showToast("No hay una sesión activa", true);
		return;
	}
	// Snapshot before the prompt/await — same session-switch guard as the
	// attach flow above.
	const sessionId = activeSessionId;
	const relPath = await promptDialog({
		title: "Descargar un archivo",
		label: "Ruta dentro del workspace",
		placeholder: "dist/report.pdf",
		confirmLabel: "Descargar",
		validate: (v) => (v === "" ? "Escribí una ruta dentro del workspace." : null),
	});
	if (relPath === null) return;
	downloadInFlight = true;
	try {
		showToast(`Descargando ${relPath}…`);
		const { blob, filename } = await downloadSessionFile(sessionId, relPath);
		saveBlob(blob, filename);
		showToast(`Se descargó ${filename}`);
	} catch (err) {
		showToast(`Falló la descarga: ${(err as Error).message}`, true);
	} finally {
		downloadInFlight = false;
	}
});

// ── File attachment flow ────────────────────────────────────────────────────
// Upload via multipart, then type the in-container paths into the active
// terminal so the user can keep typing their prompt around them.

const MAX_ATTACH_FILES = 8; // mirrors backend multer cap
const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // mirrors backend per-file cap

let attachInFlight = false;

fileInput.addEventListener("change", async () => {
	const picked = Array.from(fileInput.files ?? []);
	// Clear immediately so a re-pick of the same files still triggers change.
	fileInput.value = "";
	if (picked.length === 0) return;
	if (attachInFlight) {
		// Without the toast the picker silently closes and nothing
		// happens — the prior "Uploading…" toast may have already
		// scrolled away, so the user has no feedback.
		showToast("Ya hay una subida en curso; probá de nuevo en un momento", true);
		return;
	}
	attachInFlight = true;
	// Every `return` inside this try { } is covered by the finally below
	// that resets attachInFlight — including the early validation
	// returns. Don't move attachInFlight = false above the try or
	// duplicate it on each early return; the finally is the single
	// release point.
	try {
		if (!activeSessionId) {
			showToast("No hay una sesión activa", true);
			return;
		}
		// Snapshot the id before any await so a session-switch or
		// logout that flips activeSessionId mid-upload doesn't end
		// up POSTing to /sessions/null/files. Same pattern as
		// addTab and openSession.
		const sessionId = activeSessionId;
		if (picked.length > MAX_ATTACH_FILES) {
			showToast(`Son demasiados archivos (${picked.length}; máximo ${MAX_ATTACH_FILES})`, true);
			return;
		}
		const oversized = picked.find((f) => f.size > MAX_ATTACH_BYTES);
		if (oversized) {
			const mb = (oversized.size / (1024 * 1024)).toFixed(1);
			showToast(`«${oversized.name}» pesa ${mb} MB: cada archivo puede pesar hasta 25 MB`, true);
			return;
		}
		showToast(picked.length === 1 ? "Subiendo 1 archivo…" : `Subiendo ${picked.length} archivos…`);
		let result: { paths: string[] };
		try {
			result = await uploadSessionFiles(sessionId, picked);
		} catch (err) {
			showToast(`Falló la subida: ${(err as Error).message}`, true);
			return;
		}
		// Re-check identity post-await: if the user switched away
		// from this session while the upload was in flight, pasting
		// its paths into whatever terminal they're now looking at
		// would silently inject foreign-session paths into their
		// current command. Mirrors the same guard pattern used in
		// addTab/openSession/closeTab. The files still landed in
		// session A's workspace; the user can switch back and
		// reference them manually.
		if (activeSessionId !== sessionId) {
			showToast(`Se subieron ${result.paths.length} a la sesión anterior`);
			return;
		}
		const term = getActiveTerminal();
		if (term && result.paths.length > 0) {
			// Quote any path containing whitespace — the sanitiser shouldn't
			// produce one, but the user pastes this directly into the shell.
			// Trailing space lets them keep typing immediately after.
			const inserted = `${result.paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ")} `;
			term.paste(inserted);
			showToast(
				result.paths.length === 1
					? "Se adjuntó 1 archivo"
					: `Se adjuntaron ${result.paths.length} archivos`,
			);
		} else {
			// Container isn't running, so there's nothing to type into. The
			// files still land in the workspace and survive a /start, so the
			// user can reference them later.
			showToast(`Se subieron ${result.paths.length}; poné en marcha la sesión para usarlos`);
		}
	} finally {
		attachInFlight = false;
	}
});

export { closeActionsMenu };
