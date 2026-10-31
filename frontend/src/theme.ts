/**
 * theme.ts — the bridge between the design tokens (styles/tokens.css) and
 * the one consumer that can't read CSS: xterm's theme object. Leaf module
 * (no app imports) so it can be unit-tested without loading xterm.
 */

/**
 * xterm's theme, read from the app-wide design tokens (styles/tokens.css)
 * so the terminal and the chrome can't drift apart when the palette
 * changes. Each value falls back to the literal the app always used:
 * under jsdom (tests) no stylesheet is loaded and `getPropertyValue`
 * answers "", and a token someone removes must degrade to the known
 * colour rather than to xterm's own default.
 */
export function readXtermTheme(): {
	background: string;
	foreground: string;
	cursor: string;
	selectionBackground: string;
} {
	const style =
		typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
	const token = (name: string, fallback: string): string => {
		const v = style?.getPropertyValue(name).trim();
		return v ? v : fallback;
	};
	return {
		background: token("--c-bg", "#0d1117"),
		foreground: token("--c-text", "#e6edf3"),
		cursor: token("--c-accent", "#58a6ff"),
		selectionBackground: token("--c-selection", "#264f78"),
	};
}
