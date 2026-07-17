/**
 * deepLink.test.ts — /#/sessions/<id> hash helpers (#419).
 *
 * The parser and the URL-reflection helper are the testable core of the
 * deep-link feature; the resolver in sessionCore.ts is exercised in the
 * browser (it is DOM + network-bound like the rest of that module).
 */

import { describe, expect, it } from "vitest";
import { parseSessionHash, reflectSessionInHash, sessionHash } from "./deepLink.js";

describe("parseSessionHash", () => {
	it("extracts the id from a well-formed deep link", () => {
		expect(parseSessionHash("#/sessions/abc-123")).toBe("abc-123");
	});

	it("round-trips ids through sessionHash, including encodable chars", () => {
		const id = "032da8d8-7fc6-4556-9227-2e231afd148f";
		expect(parseSessionHash(sessionHash(id))).toBe(id);
		// Not a shape the backend generates, but the route must not
		// corrupt whatever it is handed.
		const odd = "id with spaces&stuff";
		expect(parseSessionHash(sessionHash(odd))).toBe(odd);
	});

	it("returns null for absent, foreign, and malformed hashes", () => {
		expect(parseSessionHash("")).toBeNull();
		expect(parseSessionHash("#")).toBeNull();
		// The SW's one-shot notification hash is a different route and
		// must NOT match — it has clear-after-use semantics of its own.
		expect(parseSessionHash("#session=abc")).toBeNull();
		expect(parseSessionHash("#/sessions/")).toBeNull();
		expect(parseSessionHash("#/sessions/a/b")).toBeNull();
		expect(parseSessionHash("#/sessions/a?x=1")).toBeNull();
		expect(parseSessionHash("#/other/abc")).toBeNull();
		// Malformed percent-encoding must not throw during app init.
		expect(parseSessionHash("#/sessions/%zz")).toBeNull();
		expect(parseSessionHash("#/sessions/%")).toBeNull();
	});
});

describe("reflectSessionInHash", () => {
	it("writes the deep-link hash for a selected session", () => {
		history.replaceState(null, "", "/");
		reflectSessionInHash("s1");
		expect(window.location.hash).toBe("#/sessions/s1");
	});

	it("clears a deep-link hash when selection drops to null", () => {
		history.replaceState(null, "", "/#/sessions/s1");
		reflectSessionInHash(null);
		expect(window.location.hash).toBe("");
	});

	it("does NOT clobber a non-deep-link hash on null (SW #session= one-shot)", () => {
		history.replaceState(null, "", "/#session=abc");
		reflectSessionInHash(null);
		expect(window.location.hash).toBe("#session=abc");
	});

	it("preserves the query string across writes and clears", () => {
		history.replaceState(null, "", "/?foo=1");
		reflectSessionInHash("s2");
		expect(window.location.search).toBe("?foo=1");
		expect(window.location.hash).toBe("#/sessions/s2");
		reflectSessionInHash(null);
		expect(window.location.search).toBe("?foo=1");
		expect(window.location.hash).toBe("");
	});
});
