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
const BAR_KEY = "st.uiShellBar";

/**
 * Shell v2's mobile bar variant, for comparing on the preview (§5.3):
 * `merged` = the session bar shares one line with the header (☰, user
 * menu, Insert) instead of being a second line under it. `?bar=merged`
 * stores it, `?bar=` clears it. Nothing without shell v2.
 */
export type UiBar = "merged";

export function readStoredBar(): UiBar | null {
	try {
		return localStorage.getItem(BAR_KEY) === "merged" ? "merged" : null;
	} catch {
		return null;
	}
}

export function applyBar(bar: UiBar | null): void {
	if (bar) document.documentElement.dataset.bar = bar;
	else delete document.documentElement.dataset.bar;
}

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
	if (!url.searchParams.has("ui") && !url.searchParams.has("bar")) return readStoredShell();
	const raw = url.searchParams.get("ui");
	const bar = url.searchParams.get("bar");
	try {
		if (raw !== null) {
			if (isUiShell(raw)) localStorage.setItem(STORAGE_KEY, raw);
			else if (raw === "") localStorage.removeItem(STORAGE_KEY);
		}
		if (bar !== null) {
			if (bar === "merged") localStorage.setItem(BAR_KEY, bar);
			else if (bar === "") localStorage.removeItem(BAR_KEY);
		}
	} catch {
		/* storage unavailable: the override just doesn't persist */
	}
	url.searchParams.delete("ui");
	url.searchParams.delete("bar");
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
