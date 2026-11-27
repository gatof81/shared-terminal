/**
 * terminalFit.ts — the terminal's grid for its box, the same every time.
 *
 * FitAddon divides the box by `dimensions.css.cell`, and xterm's DOM
 * renderer sets that to `round(deviceCell × cols / dpr) / cols`: a value
 * that depends on the CURRENT column count. So `fit()` is not idempotent:
 * on a box at a cell edge (958 px of 8.4014-px Liberation Mono) each call
 * flips 114 ⇄ 113 columns, and any legitimate refit — a height-only change
 * such as the phone keyboard with the Terminal on screen — can move the
 * column count and make tmux reflow every line.
 *
 * Here the grid comes from `dimensions.device.cell`, which neither
 * renderer derives from the column count (DOM: charWidth × dpr; WebGL:
 * floor(charWidth × dpr)). The result is the largest grid whose glyphs
 * (n × deviceCell / dpr) fit the box — FitAddon's larger outcome when it
 * fits, the smaller one otherwise — and never wider than the box.
 */

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** FitAddon's own floors and scrollbar reservation (addon-fit 0.11.0). */
const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;
const DEFAULT_SCROLL_BAR_WIDTH = 14;

export interface GridInput {
	/** Space available to the grid, in CSS px (box minus padding and scrollbar). */
	width: number;
	height: number;
	/** `dimensions.device.cell`, in device px. */
	deviceCellWidth: number;
	deviceCellHeight: number;
	dpr: number;
}

/**
 * Largest n ≥ min whose glyphs, n × cell / dpr, fit the space. Not xterm's
 * rounded canvas (round(n × cell / dpr)): that can equal the box while the
 * last glyph overhangs it by up to half a pixel.
 */
function fitCount(space: number, deviceCell: number, dpr: number, min: number): number {
	const extent = (n: number) => (n * deviceCell) / dpr;
	let n = Math.floor((space * dpr) / deviceCell);
	while (n > 0 && extent(n) > space) n--;
	while (extent(n + 1) <= space) n++;
	return Math.max(min, n);
}

/** The grid for a box: depends only on its arguments, never on the current grid. */
export function stableGrid(input: GridInput): { cols: number; rows: number } {
	return {
		cols: fitCount(input.width, input.deviceCellWidth, input.dpr, MINIMUM_COLS),
		rows: fitCount(input.height, input.deviceCellHeight, input.dpr, MINIMUM_ROWS),
	};
}

interface XtermRenderDimensions {
	device: { cell: { width: number; height: number } };
}

/**
 * The only reach into xterm's internals (checked against @xterm/xterm
 * 6.0.0 with @xterm/addon-webgl 0.19 and the DOM renderer): the render
 * service's dimensions — the same private object FitAddon reads — and its
 * `clear()`, which FitAddon calls before a resize to force a full render.
 */
function renderService(
	term: Terminal,
): { dimensions?: XtermRenderDimensions; clear?: () => void } | undefined {
	// biome-ignore lint/suspicious/noExplicitAny: private xterm API, see above.
	return (term as any)._core?._renderService;
}

/**
 * The renderer's device cell as "w×h" (null before it has one): part of the
 * fit signature, so a change of cell with the same box — a WebGL → DOM
 * fallback (floor(charWidth × dpr) vs charWidth × dpr), a remeasured font
 * — refits. Safe there because, unlike the css cell, it never depends on
 * the column count.
 */
export function deviceCellKey(term: Terminal): string | null {
	const cell = renderService(term)?.dimensions?.device?.cell;
	return cell ? `${cell.width}×${cell.height}` : null;
}

/**
 * Fit the terminal to its parent. Returns false when nothing could be
 * measured yet (no parent, no layout, renderer without dimensions); then
 * FitAddon's own fit ran instead — today's behaviour, not an invented size.
 */
export function fitTerminal(term: Terminal, fitAddon: FitAddon): boolean {
	const element = term.element;
	const parent = element?.parentElement;
	const service = renderService(term);
	const cell = service?.dimensions?.device?.cell;
	const dpr = window.devicePixelRatio;
	if (!element || !parent || !cell || !(cell.width > 0) || !(cell.height > 0) || !(dpr > 0)) {
		fitAddon.fit();
		return fitAddon.proposeDimensions() !== undefined;
	}
	// The space FitAddon.proposeDimensions computes, byte for byte.
	const parentStyle = getComputedStyle(parent);
	const style = getComputedStyle(element);
	const px = (s: CSSStyleDeclaration, prop: string) =>
		Number.parseInt(s.getPropertyValue(prop), 10);
	const scrollbar =
		term.options.scrollback === 0
			? 0
			: term.options.overviewRuler?.width || DEFAULT_SCROLL_BAR_WIDTH;
	const width =
		Math.max(0, px(parentStyle, "width")) -
		px(style, "padding-left") -
		px(style, "padding-right") -
		scrollbar;
	const height = px(parentStyle, "height") - px(style, "padding-top") - px(style, "padding-bottom");
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		fitAddon.fit();
		return fitAddon.proposeDimensions() !== undefined;
	}
	const { cols, rows } = stableGrid({
		width,
		height,
		deviceCellWidth: cell.width,
		deviceCellHeight: cell.height,
		dpr,
	});
	if (cols !== term.cols || rows !== term.rows) {
		service?.clear?.();
		term.resize(cols, rows);
	}
	return true;
}
