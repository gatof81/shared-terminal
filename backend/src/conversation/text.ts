/**
 * conversation/text.ts — byte-accurate truncation helpers shared by the
 * normaliser. All limits in docs/CONVERSATION.md §4.4 are UTF-8 bytes of
 * the value, so slicing by JS string length would both over- and
 * under-count (a 4-byte emoji is 2 UTF-16 code units). We slice on a
 * Buffer and then back off to a code-point boundary so a truncated
 * string never ends in a lone surrogate or a split multi-byte sequence.
 */

export interface Truncated {
	value: string;
	truncated: boolean;
	/** Byte length of the original value; only present when truncated. */
	originalBytes?: number;
}

export function utf8Bytes(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

/**
 * Cut `s` to at most `maxBytes` UTF-8 bytes on a code-point boundary.
 * `marker` (when given) is appended INSIDE the budget so the result,
 * marker included, never exceeds `maxBytes` — the CLI uses the same
 * in-string "…[+N chars]" convention for its own clipped fields.
 */
export function truncateUtf8(
	s: string,
	maxBytes: number,
	marker?: (dropped: number) => string,
): Truncated {
	const total = utf8Bytes(s);
	if (total <= maxBytes) return { value: s, truncated: false };
	const buf = Buffer.from(s, "utf8");
	// Reserve room for the marker (estimated with the full count; the
	// final marker can only be shorter or equal once we know `dropped`).
	const reserve = marker ? utf8Bytes(marker(total)) : 0;
	let cut = Math.max(0, maxBytes - reserve);
	// Back off to a UTF-8 boundary: continuation bytes are 10xxxxxx.
	while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
	let head = buf.subarray(0, cut).toString("utf8");
	// A lone high surrogate can't survive a round trip; drop it.
	const last = head.charCodeAt(head.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
	const dropped = total - utf8Bytes(head);
	return {
		value: marker ? head + marker(dropped) : head,
		truncated: true,
		originalBytes: total,
	};
}

/** The CLI's own convention for clipped strings (TaskCreated etc.). */
export function clipMarker(dropped: number): string {
	return `…[+${dropped} chars]`;
}

/** Auxiliary-string truncation (L4-style): in-string marker, no flag needed. */
export function clipAux(s: string, maxBytes: number): string {
	return truncateUtf8(s, maxBytes, clipMarker).value;
}
