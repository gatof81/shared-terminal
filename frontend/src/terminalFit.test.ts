import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceCellKey, fitTerminal, stableGrid } from "./terminalFit.js";

// Liberation Mono at 14 px (the CI font): 1229/2048 em.
const CHAR = (1229 / 2048) * 14;

/** What FitAddon computes from a given current column count (DOM renderer). */
function fitAddonCols(width: number, deviceCell: number, dpr: number, current: number): number {
	const cssCell = Math.round((deviceCell * current) / dpr) / current;
	return Math.floor(width / cssCell);
}

/** Every column count FitAddon can land on from nearby states. */
function fitAddonOutcomes(width: number, deviceCell: number, dpr: number): Set<number> {
	const guess = Math.floor((width * dpr) / deviceCell);
	const out = new Set<number>();
	for (let n = guess - 3; n <= guess + 3; n++) out.add(fitAddonCols(width, deviceCell, dpr, n));
	return out;
}

describe("stableGrid", () => {
	it("DOM renderer: one of FitAddon's outcomes, the largest whose glyphs fit, never wider", () => {
		for (const dpr of [1, 1.25, 2]) {
			const deviceCell = CHAR * dpr; // DOM: charWidth × dpr, unrounded
			for (let width = 300; width <= 1400; width++) {
				const { cols } = stableGrid({
					width,
					height: 600,
					deviceCellWidth: deviceCell,
					deviceCellHeight: 20,
					dpr,
				});
				const laidOut = (n: number) => (n * deviceCell) / dpr;
				expect(laidOut(cols), `${width}px @${dpr}`).toBeLessThanOrEqual(width);
				expect(laidOut(cols + 1), `${width}px @${dpr}`).toBeGreaterThan(width);
				expect(fitAddonOutcomes(width, deviceCell, dpr).has(cols), `${width}px @${dpr}`).toBe(true);
			}
		}
	});

	it("958 px, where FitAddon flips 114 ⇄ 113: always 114 (957.76 px of glyphs, it fits)", () => {
		expect(fitAddonOutcomes(958, CHAR, 1)).toEqual(new Set([113, 114]));
		expect(
			stableGrid({ width: 958, height: 600, deviceCellWidth: CHAR, deviceCellHeight: 20, dpr: 1 })
				.cols,
		).toBe(114);
	});

	it("WebGL renderer (integer device cell): exactly FitAddon's answer", () => {
		for (const dpr of [1, 1.25, 1.5, 2]) {
			const deviceCell = Math.floor(CHAR * dpr);
			for (let width = 300; width <= 1400; width++) {
				const { cols } = stableGrid({
					width,
					height: 600,
					deviceCellWidth: deviceCell,
					deviceCellHeight: 20,
					dpr,
				});
				expect(cols, `${width}px @${dpr}`).toBe(Math.floor(width / (deviceCell / dpr)));
			}
		}
	});

	it("rows the same way, and FitAddon's minimums", () => {
		expect(
			stableGrid({ width: 800, height: 661, deviceCellWidth: CHAR, deviceCellHeight: 19, dpr: 1 })
				.rows,
		).toBe(34);
		expect(
			stableGrid({ width: 0, height: 0, deviceCellWidth: CHAR, deviceCellHeight: 19, dpr: 1 }),
		).toEqual({
			cols: 2,
			rows: 1,
		});
	});
});

describe("fitTerminal", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	function fakeTerminal(dimensions: unknown) {
		const parent = document.createElement("div");
		parent.style.width = "972px";
		parent.style.height = "661px";
		const element = document.createElement("div");
		parent.appendChild(element);
		document.body.appendChild(parent);
		const clear = vi.fn();
		const term = {
			element,
			cols: 80,
			rows: 24,
			options: { scrollback: 5000 },
			resize: vi.fn((c: number, r: number) => {
				term.cols = c;
				term.rows = r;
			}),
			_core: { _renderService: { dimensions, clear } },
		};
		const fitAddon = { fit: vi.fn(), proposeDimensions: vi.fn(() => undefined) };
		return {
			parent,
			term,
			clear,
			fitAddon,
			fit: () => fitTerminal(term as unknown as Terminal, fitAddon as unknown as FitAddon),
		};
	}

	it("the same grid however often it runs and whatever grid it starts from", () => {
		const t = fakeTerminal({ device: { cell: { width: CHAR, height: 19 } } });
		expect(t.fit()).toBe(true);
		expect([t.term.cols, t.term.rows]).toEqual([114, 34]); // 972 − 14 px scrollbar = 958
		expect(t.term.resize).toHaveBeenCalledTimes(1);
		expect(t.clear).toHaveBeenCalledTimes(1);
		t.fit();
		expect(t.term.resize).toHaveBeenCalledTimes(1);
		t.term.resize(113, 30);
		t.fit();
		expect([t.term.cols, t.term.rows]).toEqual([114, 34]);
		expect(t.fitAddon.fit).not.toHaveBeenCalled();
	});

	it("a height-only change moves the rows, never the columns", () => {
		const t = fakeTerminal({ device: { cell: { width: CHAR, height: 19 } } });
		t.fit();
		t.parent.style.height = "361px";
		t.fit();
		expect([t.term.cols, t.term.rows]).toEqual([114, 19]);
	});

	it("without the renderer's dimensions: FitAddon's fit, not an invented size", () => {
		const t = fakeTerminal(undefined);
		expect(t.fit()).toBe(false);
		expect(t.fitAddon.fit).toHaveBeenCalledTimes(1);
		expect(t.term.resize).not.toHaveBeenCalled();
		const z = fakeTerminal({ device: { cell: { width: 0, height: 0 } } });
		z.fit();
		expect(z.fitAddon.fit).toHaveBeenCalledTimes(1);
	});

	it("the signature's cell: changes with a renderer swap, absent before a renderer has one", () => {
		const cell = (width: number) =>
			({
				_core: { _renderService: { dimensions: { device: { cell: { width, height: 19 } } } } },
			}) as unknown as Terminal;
		expect(deviceCellKey(cell(CHAR))).not.toBe(deviceCellKey(cell(Math.floor(CHAR))));
		expect(deviceCellKey({ _core: {} } as unknown as Terminal)).toBeNull();
	});
});
