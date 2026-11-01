import { beforeEach, describe, expect, it } from "vitest";
import {
	applyShell,
	consumeShellQuery,
	currentShell,
	readStoredShell,
	resolveShell,
} from "./uiShell.js";

beforeEach(() => {
	localStorage.clear();
	history.replaceState(null, "", "/");
	document.documentElement.removeAttribute("data-shell");
});

describe("resolveShell", () => {
	it("query > stored > server > v1", () => {
		expect(resolveShell({})).toBe("v1");
		expect(resolveShell({ server: "v2" })).toBe("v2");
		expect(resolveShell({ server: "v2", stored: "v1" })).toBe("v1");
		expect(resolveShell({ server: "v1", stored: "v2", query: "v1" })).toBe("v1");
		expect(resolveShell({ server: "nope", stored: "zzz", query: "" })).toBe("v1");
	});
});

describe("consumeShellQuery", () => {
	it("stores ?ui=v2, strips it from the address and keeps the hash", () => {
		history.replaceState(null, "", "/?ui=v2&x=1#/sessions/s1/chat");
		expect(consumeShellQuery()).toBe("v2");
		expect(readStoredShell()).toBe("v2");
		expect(window.location.search).toBe("?x=1");
		expect(window.location.hash).toBe("#/sessions/s1/chat");
	});
	it("?ui= (empty) clears the override; an unknown value changes nothing", () => {
		localStorage.setItem("st.uiShell", "v2");
		history.replaceState(null, "", "/?ui=v9");
		expect(consumeShellQuery()).toBe("v2");
		history.replaceState(null, "", "/?ui=");
		expect(consumeShellQuery()).toBeNull();
		expect(window.location.search).toBe("");
	});
	it("without the parameter, answers the stored override", () => {
		expect(consumeShellQuery()).toBeNull();
		localStorage.setItem("st.uiShell", "v1");
		expect(consumeShellQuery()).toBe("v1");
	});
});

describe("applyShell / currentShell", () => {
	it("round-trips through data-shell; defaults to v1", () => {
		expect(currentShell()).toBe("v1");
		applyShell("v2");
		expect(document.documentElement.dataset.shell).toBe("v2");
		expect(currentShell()).toBe("v2");
	});
});
