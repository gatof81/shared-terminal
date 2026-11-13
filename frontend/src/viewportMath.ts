/**
 * viewportMath.ts — where the app must be drawn for the phone keyboard
 * (main.ts mirrors the result into --app-vh / --app-top).
 *
 * The app's box is the VISIBLE band: as tall as the visual viewport, and as
 * far down the document as the visual viewport's top. That top is
 * `pageTop` — the page scroll PLUS the visual viewport's own pan — not
 * `offsetTop` alone. iOS reveals a focused field either by panning the
 * visual viewport (offsetTop grows, scrollY stays 0) or by scrolling the
 * page itself (scrollY grows, offsetTop stays 0), and which one it does
 * varies by version and by layout. With offsetTop only, a page scroll left
 * the app drawn that far ABOVE the visible band: the field sat near the top
 * of the screen, black space below it (owner's iPhone, #616).
 */

export interface ViewportInput {
	/** visualViewport.height, or innerHeight without the API. */
	height: number;
	/** visualViewport.pageTop (falls back to scrollY + offsetTop). */
	pageTop: number;
	/** visualViewport.scale (1 without the API). */
	scale: number;
	innerHeight: number;
}

/** Below this, the visual viewport is "clearly shorter": the soft keyboard is up. */
export const KEYBOARD_MIN_PX = 120;

export function appViewport(v: ViewportInput): { vh: number; top: number; keyboard: boolean } {
	// Only at scale 1: under a pinch zoom the offset is the reader panning the
	// magnified page, and translating the app by it would chase the gesture.
	const unzoomed = Math.abs((v.scale || 1) - 1) < 0.01;
	// The visible band lies inside the layout viewport scrolled by at most the
	// room the keyboard leaves: clamping to that is geometry, not a guess — a
	// stale offset reported after the keyboard closes (full height ⇒ bound 0)
	// cannot push the app below the screen.
	const maxTop = Math.max(0, v.innerHeight - v.height);
	const top = unzoomed ? Math.min(Math.max(0, v.pageTop), maxTop) : 0;
	return { vh: v.height, top, keyboard: v.innerHeight - v.height > KEYBOARD_MIN_PX };
}
