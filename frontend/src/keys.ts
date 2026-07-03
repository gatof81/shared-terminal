/**
 * keys.ts — pure key-sequence helpers for the mobile extra-keys bar.
 *
 * Kept free of DOM and xterm imports so the encoding rules are unit-
 * testable in isolation; terminal.ts supplies the runtime bits (app
 * cursor mode, the WS pipe) and keyBar.ts supplies the UI state.
 */

export type SpecialKey = "esc" | "tab" | "up" | "down" | "left" | "right" | "ctrl-c";

const ARROW_FINAL: Record<string, string> = {
	up: "A",
	down: "B",
	right: "C",
	left: "D",
};

/**
 * Byte sequence a real keyboard would produce for `key`.
 *
 * Arrows honour DECCKM: normal mode emits CSI (`\x1b[A`), application
 * cursor mode emits SS3 (`\x1bOA`) — vim/less/htop set the latter and
 * ignore CSI arrows. Ctrl-modified arrows always use the CSI form with
 * the xterm modifier parameter (`\x1b[1;5A`); modified keys have no SS3
 * encoding, applications expect CSI regardless of DECCKM.
 *
 * `ctrl` is ignored for the non-arrow keys: Ctrl+Esc / Ctrl+Tab have no
 * terminal encoding, and ctrl-c already IS a control code.
 */
export function specialKeySequence(
	key: SpecialKey,
	opts: { appCursor: boolean; ctrl: boolean },
): string {
	switch (key) {
		case "esc":
			return "\x1b";
		case "tab":
			return "\t";
		case "ctrl-c":
			return "\x03";
		default: {
			const final = ARROW_FINAL[key]!;
			if (opts.ctrl) return `\x1b[1;5${final}`;
			return opts.appCursor ? `\x1bO${final}` : `\x1b[${final}`;
		}
	}
}

/**
 * Transform one soft-keyboard character into its C0 control code, the
 * way a hardware Ctrl+<key> chord would: letters and the @[\]^_ block
 * mask to 0x00–0x1f (case-insensitive, so Ctrl+c and Ctrl+C both give
 * ETX), space maps to NUL (Ctrl+Space, tmux's default prefix-adjacent
 * binding and emacs set-mark), and `?` maps to DEL (Ctrl+? per the
 * xterm convention). Anything else — multi-byte IME output, paste
 * bursts, characters with no control mapping — passes through
 * unchanged; the caller still disarms its sticky-Ctrl state so the
 * modifier can't linger armed across an unmappable keystroke.
 */
export function ctrlifyChar(data: string): string {
	if (data.length !== 1) return data;
	if (data === " ") return "\x00";
	if (data === "?") return "\x7f";
	const code = data.toUpperCase().charCodeAt(0);
	// '@' (0x40) through '_' (0x5f) — the classic Ctrl range.
	if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
	return data;
}
