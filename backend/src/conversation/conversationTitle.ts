/**
 * conversation/conversationTitle.ts — the owner's custom title rules
 * (docs/CONVERSATION.md §6.2, v1.8).
 *
 * The frontend keeps a byte-identical copy (like composerText.ts) used only
 * to explain a rejection before the request leaves; the server decides
 * every time. Keep the two files identical.
 */

/** The same cap as the automatic title (§5.1), in code points. */
export const TITLE_MAX_CODE_POINTS = 80;

export type TitleResult =
	| { ok: true; value: string | null }
	| { ok: false; code: "invalid-title" | "title-too-long" };

// \p{Cc}: C0 (tab and newline included), DEL and C1. Plus the directional
// marks, embeddings, overrides and isolates: a title is rendered next to
// other text, and a stray override would visually reorder it.
const FORBIDDEN = /[\p{Cc}‎‏‪-‮⁦-⁩]/u;

/** A lone surrogate survives JSON.parse but is not text. */
function isWellFormed(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/**
 * `null` clears the custom title; a string is normalised (NFC, trimmed,
 * inner whitespace runs collapsed) and refused — never truncated — when it
 * carries a control/bidi character or exceeds the cap. Empty after the trim
 * means "clear", like `null`.
 */
export function normalizeTitle(raw: unknown): TitleResult {
	if (raw === null) return { ok: true, value: null };
	if (typeof raw !== "string" || !isWellFormed(raw)) return { ok: false, code: "invalid-title" };
	const nfc = raw.normalize("NFC");
	if (FORBIDDEN.test(nfc)) return { ok: false, code: "invalid-title" };
	const value = nfc.trim().replace(/\s+/gu, " ");
	if (value.length === 0) return { ok: true, value: null };
	if ([...value].length > TITLE_MAX_CODE_POINTS) return { ok: false, code: "title-too-long" };
	return { ok: true, value };
}
