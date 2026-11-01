import { describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { parseUiShell } from "./uiShell.js";

describe("parseUiShell", () => {
	it("defaults to v1 and accepts v1 / v2 in any case", () => {
		expect(parseUiShell(undefined)).toBe("v1");
		expect(parseUiShell("")).toBe("v1");
		expect(parseUiShell("v1")).toBe("v1");
		expect(parseUiShell("v2")).toBe("v2");
		expect(parseUiShell(" V2 ")).toBe("v2");
	});
	it("falls back to v1 on anything else", () => {
		expect(parseUiShell("v3")).toBe("v1");
		expect(parseUiShell("true")).toBe("v1");
	});
});
