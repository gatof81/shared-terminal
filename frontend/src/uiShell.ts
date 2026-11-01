/**
 * uiShell.ts — which shell to mount (UI unification §8.4, decision §9.7).
 *
 * Three sources, in order of precedence:
 *   1. `?ui=v2` / `?ui=v1` in the address: a per-browser override for
 *      trying a shell before it is switched on for everyone. Stored in
 *      localStorage and removed from the address; `?ui=` clears it.
 *   2. The stored override.
 *   3. The server's `uiShell` from GET /api/auth/status (the operator's
 *      UI_SHELL); default v1 until the first status answer.
 *
 * The shell is applied as `data-shell` on <html>: shell-v2.css keys on
 * it, and shellV2.ts does the few DOM moves the stylesheet can't.
 */

export type UiShell = "v1" | "v2";

const STORAGE_KEY = "st.uiShell";

export function isUiShell(v: unknown): v is UiShell {
	return v === "v1" || v === "v2";
}

/** Pure: the shell for a combination of sources. */
export function resolveShell(src: {
	query?: string | null;
	stored?: string | null;
	server?: string | null;
}): UiShell {
	if (isUiShell(src.query)) return src.query;
	if (isUiShell(src.stored)) return src.stored;
	if (isUiShell(src.server)) return src.server;
	return "v1";
}

export function readStoredShell(): UiShell | null {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return isUiShell(v) ? v : null;
	} catch {
		return null;
	}
}

/**
 * Consume a `?ui=` parameter: `v1`/`v2` stores the override, an empty
 * value clears it; the parameter is removed from the address either way
 * (a reload must not re-apply a one-off). Returns the stored override.
 */
export function consumeShellQuery(): UiShell | null {
	const url = new URL(window.location.href);
	if (!url.searchParams.has("ui")) return readStoredShell();
	const raw = url.searchParams.get("ui") ?? "";
	try {
		if (isUiShell(raw)) localStorage.setItem(STORAGE_KEY, raw);
		else if (raw === "") localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* storage unavailable: the override just doesn't persist */
	}
	url.searchParams.delete("ui");
	history.replaceState(history.state, "", url.pathname + url.search + url.hash);
	return readStoredShell();
}

export function currentShell(): UiShell {
	const v = document.documentElement.dataset.shell;
	return isUiShell(v) ? v : "v1";
}

export function applyShell(shell: UiShell): void {
	document.documentElement.dataset.shell = shell;
}
