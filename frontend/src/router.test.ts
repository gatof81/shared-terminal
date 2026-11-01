import { beforeEach, describe, expect, it } from "vitest";
import {
	clear,
	currentRoute,
	depth,
	navigate,
	onRoute,
	parseRoute,
	type Route,
	readRoute,
	resetForTests,
	routeHash,
	sameRoute,
	start,
} from "./router.js";

const SID = "aaaaaaaa-1111-4111-8111-111111111111";

beforeEach(() => {
	resetForTests();
	history.replaceState(null, "", "/");
});

describe("parseRoute / routeHash", () => {
	it("parses the three shapes and round-trips them", () => {
		const cases: Array<[string, Route]> = [
			[`#/sessions/${SID}`, { sessionId: SID, view: null, detail: null }],
			[`#/sessions/${SID}/files`, { sessionId: SID, view: "files", detail: null }],
			[
				`#/sessions/${SID}/files/src/auth.ts`,
				{ sessionId: SID, view: "files", detail: "src/auth.ts" },
			],
			[
				`#/sessions/${SID}/git/unstaged:src/auth.ts`,
				{ sessionId: SID, view: "git", detail: "unstaged:src/auth.ts" },
			],
			[`#/sessions/${SID}/chat/conv-1`, { sessionId: SID, view: "chat", detail: "conv-1" }],
			[`#/sessions/${SID}/terminal/tab-1`, { sessionId: SID, view: "terminal", detail: "tab-1" }],
		];
		for (const [hash, route] of cases) {
			expect(parseRoute(hash), hash).toEqual(route);
			expect(routeHash(route)).toBe(hash);
		}
	});

	it("encodes what needs it and keeps a path's slashes readable", () => {
		const r: Route = { sessionId: "s 1", view: "files", detail: "dir name/a#b.md" };
		const h = routeHash(r);
		expect(h).toBe("#/sessions/s%201/files/dir%20name/a%23b.md");
		expect(parseRoute(h)).toEqual(r);
	});

	it("returns null for absent, foreign, unknown-view and malformed hashes", () => {
		for (const h of [
			"",
			"#",
			"#session=abc",
			"#/sessions/",
			"#/sessions//files",
			`#/sessions/${SID}/settings`,
			`#/sessions/${SID}/files/%zz`,
			"#/other/x",
		]) {
			expect(parseRoute(h), h).toBeNull();
		}
	});

	it("sameRoute compares the three fields", () => {
		const a: Route = { sessionId: SID, view: "files", detail: null };
		expect(sameRoute(a, { ...a })).toBe(true);
		expect(sameRoute(a, { ...a, detail: "x" })).toBe(false);
		expect(sameRoute(a, null)).toBe(false);
		expect(sameRoute(null, null)).toBe(true);
	});
});

describe("navigate / clear / depth", () => {
	it("replace keeps the depth, push increments it; the hash follows", () => {
		navigate({ sessionId: SID, view: null, detail: null }, { replace: true });
		expect(window.location.hash).toBe(`#/sessions/${SID}`);
		expect(depth()).toBe(0);
		navigate({ sessionId: SID, view: "files", detail: null });
		expect(depth()).toBe(1);
		navigate({ sessionId: SID, view: "files", detail: "a.md" });
		expect(depth()).toBe(2);
		expect(window.location.hash).toBe(`#/sessions/${SID}/files/a.md`);
		expect(currentRoute()).toEqual({ sessionId: SID, view: "files", detail: "a.md" });
	});

	it("writing the route already shown is a no-op (no new entry)", () => {
		const r: Route = { sessionId: SID, view: "git", detail: null };
		navigate(r);
		navigate(r);
		expect(depth()).toBe(1);
	});

	it("preserves the query string and clears only our own shape", () => {
		history.replaceState(null, "", "/?x=1#session=abc");
		clear();
		expect(window.location.hash).toBe("#session=abc");
		navigate({ sessionId: SID, view: null, detail: null }, { replace: true });
		expect(window.location.search).toBe("?x=1");
		clear();
		expect(window.location.hash).toBe("");
		expect(window.location.search).toBe("?x=1");
		expect(readRoute()).toBeNull();
	});
});

describe("reads", () => {
	it("popstate and hashchange deliver a changed route once; our own writes never re-emit", () => {
		start();
		const seen: string[] = [];
		onRoute((r, src) => seen.push(`${src}:${r ? routeHash(r) : "null"}`));
		navigate({ sessionId: SID, view: "files", detail: null });
		window.dispatchEvent(new PopStateEvent("popstate"));
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		expect(seen).toEqual([]);
		// The browser went Back to an earlier entry: popstate first, then
		// the hashchange for the same fragment change — applied once.
		history.replaceState(null, "", `/#/sessions/${SID}/terminal`);
		window.dispatchEvent(new PopStateEvent("popstate"));
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		expect(seen).toEqual([`popstate:#/sessions/${SID}/terminal`]);
		// A pasted URL of another shape: delivered as null.
		history.replaceState(null, "", "/#session=zzz");
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		expect(seen).toEqual([`popstate:#/sessions/${SID}/terminal`, "hashchange:null"]);
	});
});
