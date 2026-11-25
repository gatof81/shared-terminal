import { beforeEach, describe, expect, it } from "vitest";
import {
	appRouteHash,
	clear,
	currentRoute,
	depth,
	enableProjectRoutes,
	fromHistory,
	mapSessionAddress,
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

	it("fromHistory: a traversal is Back / Forward; a fragment navigation, an input or a push is not", () => {
		start();
		// A traversal lands on an entry that has a state.
		window.dispatchEvent(new PopStateEvent("popstate", { state: { st: { n: 1 } } }));
		expect(fromHistory()).toBe(true);
		// The person's next input is a new choice.
		window.dispatchEvent(new Event("pointerdown"));
		expect(fromHistory()).toBe(false);
		window.dispatchEvent(new PopStateEvent("popstate", { state: { stSeen: true } }));
		expect(fromHistory()).toBe(true);
		navigate({ sessionId: SID, view: "git", detail: null });
		expect(fromHistory()).toBe(false);
		// A link followed / a URL pasted: the browser's popstate for a new
		// entry (no state) — not Back; the entry is marked for a later Back to it.
		history.replaceState(null, "", `/#/sessions/${SID}/files`);
		window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
		expect(fromHistory()).toBe(false);
		expect(history.state).toEqual({ stSeen: true });
		expect(depth()).toBe(0);
	});
});

describe("Herramientas over the session (mapSessionAddress)", () => {
	beforeEach(() => {
		resetForTests();
		history.replaceState(null, "", "/");
	});

	it("writes the tools' session as the tools address, and others as before", () => {
		const tools = "#/projects/p/tools/dev/~/files/README.md";
		mapSessionAddress((r) => (r.sessionId === SID ? tools : null));
		navigate({ sessionId: SID, view: "files", detail: "README.md" });
		expect(window.location.hash).toBe(tools);
		expect(currentRoute()).toEqual({ sessionId: SID, view: "files", detail: "README.md" });
		navigate({ sessionId: "other", view: null, detail: null });
		expect(window.location.hash).toBe("#/sessions/other");
		mapSessionAddress(null);
	});
});

describe("project routes", () => {
	const PID = "6b1f2c3d-0000-4000-8000-000000000001";

	it("parses the project's pages and round-trips them", () => {
		const CID = "0c0c0c0c-0000-4000-8000-000000000009";
		expect(parseProjectRoute(`#/projects/${PID}`)).toEqual({ projectId: PID, page: "home" });
		expect(parseProjectRoute(`#/projects/${PID}/chat`)).toEqual({ projectId: PID, page: "chat" });
		expect(parseProjectRoute(`#/projects/${PID}/c/${CID}`)).toEqual({
			projectId: PID,
			page: "conversation",
			conversationId: CID,
		});
		expect(projectRouteHash({ projectId: PID })).toBe(`#/projects/${PID}`);
		for (const r of [
			{ projectId: PID, page: "home" as const },
			{ projectId: "p 1", page: "chat" as const },
			{ projectId: PID, page: "conversation" as const, conversationId: "c 1" },
		])
			expect(parseProjectRoute(projectRouteHash(r))).toEqual(r);
	});

	it("parses Herramientas (with and without its topic) and round-trips it", () => {
		const CID = "0c0c0c0c-0000-4000-8000-000000000009";
		expect(parseProjectRoute(`#/projects/${PID}/c/${CID}/tools/dev/~/files/src/a%20b.ts`)).toEqual({
			projectId: PID,
			page: "tools",
			conversationId: CID,
			tools: { agent: "dev", work: null, tool: "files", detail: "src/a b.ts" },
		});
		expect(parseProjectRoute(`#/projects/${PID}/tools/dev/ci-cache/git`)).toEqual({
			projectId: PID,
			page: "tools",
			tools: { agent: "dev", work: "ci-cache", tool: "git", detail: null },
		});
		for (const r of [
			{
				projectId: PID,
				page: "tools" as const,
				conversationId: CID,
				tools: { agent: "arq", work: null, tool: "terminal" as const, detail: "tab-1" },
			},
			{
				projectId: PID,
				page: "tools" as const,
				tools: { agent: "dev", work: "w-1", tool: "git" as const, detail: "unstaged:a/b c.ts" },
			},
		])
			expect(parseProjectRoute(projectRouteHash(r))).toEqual(r);
		// Not a tool; a link with a "." / ".." step in its path is no address.
		expect(parseProjectRoute(`#/projects/${PID}/tools/dev/~/chat`)).toBeNull();
		expect(appRouteHash(`#/projects/${PID}/tools/dev/~/files/../x`)).toBeNull();
		expect(appRouteHash(`#/projects/${PID}/tools/dev/~/git/unstaged:../x`)).toBeNull();
	});

	it("rejects other shapes", () => {
		for (const h of [
			"",
			"#/projects/",
			"#/projects//agents/x",
			"#/projects/%zz",
			`#/projects/${PID}/team`,
			`#/projects/${PID}/agents`,
			`#/projects/${PID}/c/`,
			`#/projects/${PID}/c/x/y`,
			`#/sessions/${SID}`,
		])
			expect(parseProjectRoute(h), h).toBeNull();
	});

	it("never changes how a session route parses, and a project hash is no session route", () => {
		expect(parseRoute(`#/projects/${PID}/chat`)).toBeNull();
		expect(parseRoute(`#/sessions/${SID}/chat/c1`)).toEqual({
			sessionId: SID,
			view: "chat",
			detail: "c1",
		});
	});

	it("project routes off: a pasted project hash is delivered to the session listeners as before", () => {
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
		navigateProject({ projectId: PID });
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
		navigateProject({ projectId: PID });
		pushSessionAddress();
		expect(window.location.hash).toBe(`#/sessions/${SID}/chat`);
		expect(depth()).toBe(2);
	});

	it("project routes on: Back onto a project page is not a session route change", () => {
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
