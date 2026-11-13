import { describe, expect, it } from "vitest";
import { appViewport } from "./viewportMath.js";

// An iPhone 390×844 with the keyboard up: the visible band is ~420 px.
const IH = 844;
const H = 420;

describe("appViewport (#616: where the app is drawn with the keyboard up)", () => {
	it("Safari PANS the visual viewport (offsetTop): the app follows the pan", () => {
		// pageTop = scrollY 0 + offsetTop 300
		expect(appViewport({ height: H, pageTop: 300, scale: 1, innerHeight: IH })).toEqual({
			vh: H,
			top: 300,
			keyboard: true,
		});
	});

	it("Safari SCROLLS the page (scrollY): the app follows the scroll too — offsetTop alone left it above the band", () => {
		// pageTop = scrollY 336 + offsetTop 0. The old code used offsetTop only ⇒ top 0:
		// the app drawn 336 px above the visible band, the field near the top of the screen.
		const v = appViewport({ height: H, pageTop: 336, scale: 1, innerHeight: IH });
		expect(v.top).toBe(336);
	});

	it("both at once add up (pageTop is their sum)", () => {
		expect(appViewport({ height: H, pageTop: 200 + 150, scale: 1, innerHeight: IH }).top).toBe(350);
	});

	it("never below the screen: clamped to the room the keyboard leaves", () => {
		expect(appViewport({ height: H, pageTop: 900, scale: 1, innerHeight: IH }).top).toBe(IH - H);
		// Keyboard closed (full height): a stale offset cannot move the app.
		expect(appViewport({ height: IH, pageTop: 300, scale: 1, innerHeight: IH })).toEqual({
			vh: IH,
			top: 0,
			keyboard: false,
		});
	});

	it("never negative (rubber-band overscroll), and not under a pinch zoom", () => {
		expect(appViewport({ height: H, pageTop: -40, scale: 1, innerHeight: IH }).top).toBe(0);
		expect(appViewport({ height: H, pageTop: 300, scale: 1.8, innerHeight: IH }).top).toBe(0);
	});

	it("desktop / no keyboard: nothing moves", () => {
		expect(appViewport({ height: 800, pageTop: 0, scale: 1, innerHeight: 800 })).toEqual({
			vh: 800,
			top: 0,
			keyboard: false,
		});
	});
});
