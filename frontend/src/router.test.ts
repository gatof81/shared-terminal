import { beforeEach, describe, expect, it } from "vitest";
import {
	clear,
	currentRoute,
	depth,
	enableProjectRoutes,
	navigate,
	navigateProject,
	onAddressWrite,
	onRoute,
	parseProjectRoute,
	parseRoute,
	projectRouteHash,
	pushSessionAddress,
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

describe("project routes (P3a)", () => {
	const PID = "6b1f2c3d-0000-4000-8000-000000000001";
	const AID = "a0000000-0000-4000-8000-0000000000a2";

	it("parses the project and agent pages and round-trips them", () => {
		expect(parseProjectRoute(`#/projects/${PID}`)).toEqual({ projectId: PID, agentId: null });
		expect(parseProjectRoute(`#/projects/${PID}/agents/${AID}`)).toEqual({
			projectId: PID,
			agentId: AID,
		});
		for (const r of [
			{ projectId: PID, agentId: null },
			{ projectId: "p 1", agentId: "a/1" },
		]) {
			expect(parseProjectRoute(projectRouteHash(r))).toEqual(r);
		}
	});

	it("rejects other shapes — the chat route of a later phase included", () => {
		for (const h of [
			"",
			"#/projects/",
			"#/projects//agents/x",
			`#/projects/${PID}/agents/`,
			`#/projects/${PID}/agents/${AID}/chat`,
			`#/projects/${PID}/settings`,
			"#/projects/%zz",
			`#/sessions/${SID}`,
		]) {
			expect(parseProjectRoute(h), h).toBeNull();
		}
	});

	it("never changes how a session route parses, and a project hash is no session route", () => {
		expect(parseRoute(`#/projects/${PID}`)).toBeNull();
		expect(parseRoute(`#/sessions/${SID}/chat/c1`)).toEqual({
			sessionId: SID,
			view: "chat",
			detail: "c1",
		});
	});

	it("feature off: a pasted project hash is delivered to the session listeners as before", () => {
		start();
		const seen: string[] = [];
		onRoute((r) => seen.push(r ? routeHash(r) : "null"));
		navigate({ sessionId: SID, view: null, detail: null }, { replace: true });
		history.replaceState(null, "", `/#/projects/${PID}`);
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		expect(seen).toEqual(["null"]);
		expect(currentRoute()).toBeNull();
	});

	it("while a page is shown: a session REPLACE keeps the page in the address, current follows", () => {
		let shown = false;
		enableProjectRoutes(() => shown);
		navigate({ sessionId: SID, view: "terminal", detail: null }, { replace: true });
		const writes: string[] = [];
		onAddressWrite(() => writes.push(window.location.hash));
		navigateProject({ projectId: PID, agentId: null });
		shown = true;
		expect(window.location.hash).toBe(`#/projects/${PID}`);
		expect(depth()).toBe(1);
		navigate({ sessionId: SID, view: "terminal", detail: "tab-2" }, { replace: true });
		expect(window.location.hash).toBe(`#/projects/${PID}`);
		expect(currentRoute()).toEqual({ sessionId: SID, view: "terminal", detail: "tab-2" });
		// A view the person chose (push) leaves the page.
		navigate({ sessionId: SID, view: "files", detail: null });
		expect(window.location.hash).toBe(`#/sessions/${SID}/files`);
		expect(writes).toEqual([`#/projects/${PID}`, `#/sessions/${SID}/files`]);
	});

	it("leaving a page pushes the session underneath (Back returns to the page)", () => {
		const shown = true;
		enableProjectRoutes(() => shown);
		navigate({ sessionId: SID, view: "chat", detail: null }, { replace: true });
		navigateProject({ projectId: PID, agentId: AID });
		pushSessionAddress();
		expect(window.location.hash).toBe(`#/sessions/${SID}/chat`);
		expect(depth()).toBe(2);
	});

	it("feature on: Back onto a project page is not a session route change", () => {
		enableProjectRoutes(() => true);
		start();
		const seen: string[] = [];
		onRoute((r) => seen.push(r ? routeHash(r) : "null"));
		navigate({ sessionId: SID, view: "git", detail: null }, { replace: true });
		history.replaceState(null, "", `/#/projects/${PID}`);
		window.dispatchEvent(new PopStateEvent("popstate"));
		expect(seen).toEqual([]);
		expect(currentRoute()).toEqual({ sessionId: SID, view: "git", detail: null });
	});
});
