/**
 * paste.ts — paste-to-terminal modal (clipboard / manual text → active
 * terminal). Extracted from main.ts (#312). DOM re-queried locally; the
 * main.ts imports (showToast, getActiveTerminal — a core helper that stays
 * in main.ts) are used only inside functions. closePasteModal / runPasteFlow
 * are exported for main.ts's Escape handler and the actions (+) menu.
 */

import { getActiveTerminal, showToast } from "./main.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const pasteModal = document.getElementById("paste-modal")!;
const pasteTextarea = document.getElementById("paste-textarea") as HTMLTextAreaElement;
const pasteClipboardBtn = document.getElementById("paste-clipboard-btn") as HTMLButtonElement;
const pasteSendBtn = document.getElementById("paste-send-btn") as HTMLButtonElement;

const MAX_PASTE_CHARS = 65_536;
let pasteOpener: HTMLButtonElement | null = null;

function openPasteModal(opener: HTMLButtonElement) {
	pasteOpener = opener;
	pasteModal.classList.add("open");
	pasteModal.setAttribute("aria-hidden", "false");
	pasteTextarea.value = "";
	pasteSendBtn.disabled = true;
	// Focus the textarea so the soft keyboard pops and a long-press
	// immediately offers Paste — saves the user one tap.
	pasteTextarea.focus();
}

function closePasteModal() {
	pasteModal.classList.remove("open");
	pasteModal.setAttribute("aria-hidden", "true");
	pasteTextarea.value = "";
	pasteSendBtn.disabled = true;
	// Release the runPasteFlow in-flight guard. The flow intentionally
	// leaves it set on the modal-open path so a second tap can't kick
	// off a parallel readClipboardText() while the modal is open;
	// closure of the modal is the signal that the cycle is truly
	// finished.
	pasteInFlight = false;
	// Restore focus to the opener — typically actionsBtn, which is
	// visible whenever a session is active. If it's somehow gone the
	// focus call is a harmless no-op.
	pasteOpener?.focus();
	pasteOpener = null;
}

async function readClipboardText(): Promise<string | null> {
	// navigator.clipboard.readText is the silent path. Returns null when
	// the API is unavailable, rejected (permission denied / in-app
	// webview), or throws synchronously on browsers that ship the API
	// gated on a secure context they don't recognise.
	if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
		return null;
	}
	try {
		return await navigator.clipboard.readText();
	} catch {
		return null;
	}
}

// Guards against two distinct races:
//   1. iOS "Paste" consent chip: the chip can take a second to appear,
//      and a second tap during that window would re-enter the async path
//      and queue a second clipboard read.
//   2. Modal-open window: openPasteModal() is synchronous, so a naive
//      try/finally would clear the guard the moment the modal opens —
//      letting another tap re-fire and re-initialise the modal,
//      clobbering text the user has started typing in the textarea.
//
// The guard therefore stays held across the modal lifetime; closePasteModal
// is the single release point. The local `releaseGuard` boolean tracks
// which exit path we're on so the silent-paste path still releases via
// finally without depending on a synthetic catch-and-rethrow.
let pasteInFlight = false;

async function runPasteFlow(opener: HTMLButtonElement) {
	if (pasteInFlight) return;
	pasteInFlight = true;
	let releaseGuard = true;
	try {
		const term = getActiveTerminal();
		if (!term) {
			showToast("No active session", true);
			return;
		}
		const clip = await readClipboardText();
		// Empty string is treated the same as null. iOS Safari can
		// resolve readText() with "" when the user dismisses or
		// never engages with the system "Paste" consent chip — even
		// if the clipboard genuinely has content. Treating that as
		// success would dead-end the user with a misleading
		// "clipboard empty" toast; falling through to the modal
		// gives them a long-press path that always works.
		if (clip) {
			if (clip.length > MAX_PASTE_CHARS) {
				showToast(`Clipboard too large (${clip.length} chars; max ${MAX_PASTE_CHARS})`, true);
				return;
			}
			term.paste(clip);
			showToast(`Pasted ${clip.length} character${clip.length === 1 ? "" : "s"}`);
			return;
		}
		// Clipboard API unavailable, denied, or returned empty —
		// surface the manual fallback. Hand the guard ownership to
		// closePasteModal so the second-tap protection covers the
		// entire modal lifetime, not just the synchronous tail of
		// this handler.
		openPasteModal(opener);
		releaseGuard = false;
	} finally {
		if (releaseGuard) pasteInFlight = false;
	}
}

pasteClipboardBtn.addEventListener("click", async () => {
	// Disable for the duration of the async readText() so a double-tap on
	// a slow iOS consent chip doesn't queue a stale second resolve. Same
	// intent as the runPasteFlow pasteInFlight guard, just expressed via
	// the button's own disabled state since there's nowhere visual to
	// look for in-flight feedback otherwise.
	pasteClipboardBtn.disabled = true;
	try {
		const clip = await readClipboardText();
		// Collapse null and "" — both mean "we couldn't get usable
		// clipboard text". null = API unavailable/denied. "" = iOS
		// resolved without engaging the consent chip, OR the
		// clipboard genuinely is empty. Either way the textarea
		// (long-press fallback) is the right next step. The toast
		// covers both interpretations because we can't distinguish
		// them: iOS doesn't tell us which "" we got.
		if (!clip) {
			showToast("Clipboard is empty or couldn't be read — long-press to paste manually", true);
			return;
		}
		if (clip.length > MAX_PASTE_CHARS) {
			showToast(`Clipboard too large (${clip.length} chars; max ${MAX_PASTE_CHARS})`, true);
			return;
		}
		pasteTextarea.value = clip;
		pasteSendBtn.disabled = false;
		pasteTextarea.focus();
	} finally {
		pasteClipboardBtn.disabled = false;
	}
});

pasteTextarea.addEventListener("input", () => {
	pasteSendBtn.disabled = pasteTextarea.value.length === 0;
});

pasteSendBtn.addEventListener("click", () => {
	const text = pasteTextarea.value;
	if (!text) return;
	// Defence in depth — HTML maxlength gates user typing but not
	// programmatic value sets, so a clipboard-fill of >65 KB could
	// sneak past it before this point.
	if (text.length > MAX_PASTE_CHARS) {
		showToast(`Too large (${text.length} chars; max ${MAX_PASTE_CHARS})`, true);
		return;
	}
	const term = getActiveTerminal();
	if (!term) {
		showToast("No active session", true);
		closePasteModal();
		return;
	}
	term.paste(text);
	showToast(`Pasted ${text.length} character${text.length === 1 ? "" : "s"}`);
	closePasteModal();
});

pasteModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closePasteModal();
});

export { closePasteModal, runPasteFlow };
