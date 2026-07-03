import { describe, expect, it } from "vitest";
import { ctrlifyChar, specialKeySequence } from "./keys.js";

describe("specialKeySequence", () => {
	const plain = { appCursor: false, ctrl: false };

	it("encodes the simple keys", () => {
		expect(specialKeySequence("esc", plain)).toBe("\x1b");
		expect(specialKeySequence("tab", plain)).toBe("\t");
		expect(specialKeySequence("ctrl-c", plain)).toBe("\x03");
	});

	it("encodes arrows as CSI in normal cursor mode", () => {
		expect(specialKeySequence("up", plain)).toBe("\x1b[A");
		expect(specialKeySequence("down", plain)).toBe("\x1b[B");
		expect(specialKeySequence("right", plain)).toBe("\x1b[C");
		expect(specialKeySequence("left", plain)).toBe("\x1b[D");
	});

	it("encodes arrows as SS3 in application cursor mode (DECCKM)", () => {
		const app = { appCursor: true, ctrl: false };
		expect(specialKeySequence("up", app)).toBe("\x1bOA");
		expect(specialKeySequence("left", app)).toBe("\x1bOD");
	});

	it("encodes ctrl-arrows with the CSI modifier form regardless of DECCKM", () => {
		expect(specialKeySequence("right", { appCursor: false, ctrl: true })).toBe("\x1b[1;5C");
		// Modified keys have no SS3 encoding — app-cursor mode must not
		// change the ctrl variant.
		expect(specialKeySequence("right", { appCursor: true, ctrl: true })).toBe("\x1b[1;5C");
	});

	it("ignores ctrl for keys with no modified encoding", () => {
		const ctrl = { appCursor: false, ctrl: true };
		expect(specialKeySequence("esc", ctrl)).toBe("\x1b");
		expect(specialKeySequence("tab", ctrl)).toBe("\t");
		expect(specialKeySequence("ctrl-c", ctrl)).toBe("\x03");
	});
});

describe("ctrlifyChar", () => {
	it("masks letters to C0 codes, case-insensitively", () => {
		expect(ctrlifyChar("c")).toBe("\x03");
		expect(ctrlifyChar("C")).toBe("\x03");
		expect(ctrlifyChar("a")).toBe("\x01");
		expect(ctrlifyChar("z")).toBe("\x1a");
	});

	it("maps the @[\\]^_ block", () => {
		expect(ctrlifyChar("@")).toBe("\x00");
		expect(ctrlifyChar("[")).toBe("\x1b"); // Ctrl-[ = Esc
		expect(ctrlifyChar("]")).toBe("\x1d");
		expect(ctrlifyChar("_")).toBe("\x1f");
	});

	it("maps space to NUL and ? to DEL", () => {
		expect(ctrlifyChar(" ")).toBe("\x00");
		expect(ctrlifyChar("?")).toBe("\x7f");
	});

	it("passes through unmappable or multi-char input unchanged", () => {
		expect(ctrlifyChar("ñ")).toBe("ñ");
		expect(ctrlifyChar("1")).toBe("1");
		expect(ctrlifyChar("hello")).toBe("hello");
		expect(ctrlifyChar("")).toBe("");
	});
});
