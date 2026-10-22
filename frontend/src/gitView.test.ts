/**
 * gitView.test.ts — Git Changes UI under jsdom, with main.ts (app state),
 * api.ts (network) and sessionCore.ts mocked. Like filesView.test.ts the
 * load-bearing assertion is the terminal invariant: entering/leaving Git
 * must not touch the terminal container or its panes.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mainState = vi.hoisted(() => ({
	activeSessionId: null as string | null,
	sessions: [] as { sessionId: string; name: string; status: string }[],
	currentTerminals: new Map<string, unknown>(),
	mobile: false,
	focus: vi.fn(),
	showToast: vi.fn(),
	setChromeOpen: vi.fn(),
}));

vi.mock("./main.js", () => ({
	get activeSessionId() {
		return mainState.activeSessionId;
	},
	get sessions() {
		return mainState.sessions;
	},
	get currentTerminals() {
		return mainState.currentTerminals;
	},
	getActiveTerminal: () => ({ focus: mainState.focus }),
	isMobile: () => mainState.mobile,
	setChromeOpen: mainState.setChromeOpen,
	showCopySuccessToast: vi.fn(),
	showToast: mainState.showToast,
	updateChromeToggle: vi.fn(),
}));

const api = vi.hoisted(() => {
	class GitApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
			readonly code: string | null,
		) {
			super(message);
		}
	}
	class WorkspaceFsError extends Error {
		constructor(
			message: string,
			readonly status: number,
		) {
			super(message);
		}
	}
	return {
		GitApiError,
		WorkspaceFsError,
		fetchGitStatus: vi.fn(),
		fetchGitDiff: vi.fn(),
		fetchGitLog: vi.fn(),
		startSession: vi.fn(),
		listWorkspaceDir: vi.fn(),
		previewWorkspaceFile: vi.fn(),
		fetchWorkspaceImage: vi.fn(),
		downloadSessionFile: vi.fn(),
	};
});
vi.mock("./api.js", () => api);

const core = vi.hoisted(() => ({ refreshSessions: vi.fn(async () => {}) }));
vi.mock("./sessionCore.js", () => core);
vi.mock("./saveBlob.js", () => ({ saveBlob: vi.fn() }));

type GitView = typeof import("./gitView.js");
type ViewSwitch = typeof import("./viewSwitch.js");
let gv: GitView;
let vs: ViewSwitch;

const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const change = (
	area: string,
	status: string,
	path: string,
	extra: Record<string, unknown> = {},
) => ({
	area,
	status,
	xy: `${status}.`,
	path,
	oldPath: null,
	additions: 3,
	deletions: 1,
	binary: false,
	restricted: false,
	...extra,
});

const CLEAN = {
	repo: true,
	root: "",
	truncated: false,
	branch: "main",
	detached: false,
	head: "abc1234567",
	upstream: "origin/main",
	ahead: 0,
	behind: 0,
	changes: [],
};
const DIRTY = {
	...CLEAN,
	branch: "feat/x",
	ahead: 2,
	behind: 1,
	changes: [
		change("staged", "A", "src/new.ts"),
		change("staged", "R", "docs/b.md", { oldPath: "docs/a.md", additions: 0, deletions: 0 }),
		change("unstaged", "M", "src/app.ts"),
		change("unstaged", "M", "img.png", { binary: true, additions: null, deletions: null }),
		change("untracked", "?", "notes.txt", { additions: null, deletions: null }),
		change("untracked", "?", ".env", { additions: null, deletions: null, restricted: true }),
		change("conflict", "U", "merge.ts", { xy: "UU" }),
	],
};
const COMMITS = [
	{
		hash: "a".repeat(40),
		shortHash: "aaaaaaa",
		author: "Ada",
		date: new Date(Date.now() - 5 * 60_000).toISOString(),
		subject: "feat: thing",
	},
];
const PATCH = [
	"diff --git a/src/app.ts b/src/app.ts",
	"--- a/src/app.ts",
	"+++ b/src/app.ts",
	"@@ -1,2 +1,3 @@",
	" keep",
	"-old",
	"+new",
	"+more",
	"",
].join("\n");

beforeAll(async () => {
	document.body.innerHTML = `
		<section id="terminal-area">
			<div id="terminal-toolbar">
				<button id="font-size-btn"></button>
				<input id="terminal-search-input" />
				<button id="terminal-search-btn"></button>
				<div id="view-switch" hidden>
					<button id="view-terminal-btn"></button>
					<button id="view-files-btn"></button>
					<button id="view-git-btn"></button>
				</div>
			</div>
			<div id="terminal-tabs"></div>
			<div id="terminal-container" style="display: block"><div class="tab-pane active" id="pane"><textarea id="xterm-input"></textarea></div></div>
			<div id="key-bar"></div>
			<div id="files-view" hidden>
				<button id="files-to-terminal-btn"></button>
				<nav id="files-breadcrumbs"></nav>
				<button id="files-refresh-btn"></button>
				<div id="files-body"><div id="files-tree"></div><div id="files-preview"></div></div>
			</div>
			<div id="git-view" hidden>
				<button id="git-to-terminal-btn"></button>
				<div id="git-summary"></div>
				<button id="git-refresh-btn"></button>
				<div id="git-body"><div id="git-list"></div><div id="git-diff"></div></div>
			</div>
		</section>`;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vs = await import("./viewSwitch.js");
	gv = await import("./gitView.js");
});

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const rowFor = (key: string) =>
	[...document.querySelectorAll<HTMLElement>(".git-row")].find((r) => r.dataset.key === key);
const buttonNamed = (root: HTMLElement, label: string) =>
	[...root.querySelectorAll("button")].find((b) => b.textContent === label);

function selectSession(id: string, status = "running") {
	mainState.activeSessionId = id;
	mainState.sessions = [{ sessionId: id, name: id, status }];
	vs.syncSessionViews();
}

async function openGit(id = "s1", status = "running") {
	selectSession(id, status);
	$("view-git-btn").click();
	await flush();
}

beforeEach(() => {
	api.fetchGitStatus.mockReset().mockResolvedValue(CLEAN);
	api.fetchGitLog.mockReset().mockResolvedValue(COMMITS);
	api.fetchGitDiff.mockReset().mockResolvedValue({
		path: "src/app.ts",
		area: "unstaged",
		patch: PATCH,
		truncated: false,
		binary: false,
	});
	api.startSession.mockReset().mockResolvedValue({});
	core.refreshSessions.mockClear();
	mainState.currentTerminals = new Map([["t1", {}]]);
	mainState.focus.mockClear();
	mainState.showToast.mockClear();
	mainState.setChromeOpen.mockClear();
});

afterEach(() => {
	mainState.activeSessionId = null;
	mainState.sessions = [];
	mainState.mobile = false;
	vs.syncSessionViews();
});

describe("view switching", () => {
	it("overlays Git without touching the terminal, makes it inert, and restores it", async () => {
		selectSession("s1");
		const container = $("terminal-container");
		const before = { style: container.getAttribute("style"), html: container.innerHTML };
		const xtermInput = $("xterm-input") as HTMLTextAreaElement;
		xtermInput.focus();

		$("view-git-btn").click();
		await flush();
		expect(gv.isGitViewActive()).toBe(true);
		expect($("git-view").hidden).toBe(false);
		expect($("files-view").hidden).toBe(true);
		for (const id of ["terminal-tabs", "terminal-container", "key-bar"]) {
			expect($(id).hasAttribute("inert")).toBe(true);
		}
		expect(document.activeElement).not.toBe(xtermInput);
		expect(($("font-size-btn") as HTMLButtonElement).disabled).toBe(true);
		expect(container.getAttribute("style")).toBe(before.style);
		expect(container.innerHTML).toBe(before.html);
		expect($("view-git-btn").getAttribute("aria-pressed")).toBe("true");

		// Git → Files → Terminal: one overlay at a time, terminal untouched.
		$("view-files-btn").click();
		expect($("git-view").hidden).toBe(true);
		expect($("files-view").hidden).toBe(false);
		expect($("terminal-container").hasAttribute("inert")).toBe(true);
		mainState.focus.mockClear();
		$("view-terminal-btn").click();
		for (const id of ["terminal-tabs", "terminal-container", "key-bar"]) {
			expect($(id).hasAttribute("inert")).toBe(false);
		}
		expect(container.getAttribute("style")).toBe(before.style);
		expect(container.innerHTML).toBe(before.html);
		expect($("pane").isConnected).toBe(true);
		expect(mainState.focus).toHaveBeenCalledTimes(1);
	});

	it("loads status and log on entering, not before", async () => {
		selectSession("s1");
		expect(api.fetchGitStatus).not.toHaveBeenCalled();
		$("view-git-btn").click();
		await flush();
		expect(api.fetchGitStatus).toHaveBeenCalledWith("s1", "");
		expect(api.fetchGitLog).toHaveBeenCalledWith("s1", "");
	});

	it("keeps a user-chosen Git view on a stopped session instead of forcing Files", async () => {
		mainState.currentTerminals = new Map();
		api.fetchGitStatus.mockRejectedValue(
			new api.GitApiError("not running", 409, "session-not-running"),
		);
		selectSession("s1", "stopped");
		await flush();
		// Stopped → landed on Files; the user picks Git.
		expect(vs.getView()).toBe("files");
		$("view-git-btn").click();
		await flush();
		vs.syncSessionViews();
		expect(vs.getView()).toBe("git");
		expect(($("view-terminal-btn") as HTMLButtonElement).disabled).toBe(true);
	});

	it("collapses the mobile chrome drawer when Git is opened", async () => {
		mainState.mobile = true;
		selectSession("s1");
		$("view-git-btn").click();
		await flush();
		expect(mainState.setChromeOpen).toHaveBeenCalledWith(false);
	});
});

describe("status states", () => {
	it("shows a loading state, then a clean tree with branch and commits", async () => {
		let resolve: (v: unknown) => void = () => {};
		api.fetchGitStatus.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		selectSession("s1");
		$("view-git-btn").click();
		expect($("git-list").textContent).toContain("Reading git status");
		resolve(CLEAN);
		await flush();
		expect($("git-list").textContent).toContain("Working tree clean");
		expect($("git-summary").textContent).toContain("main");
		expect($("git-summary").textContent).toContain("clean");
		expect($("git-list").textContent).toContain("aaaaaaa");
		expect($("git-list").textContent).toContain("feat: thing");
		expect($("git-list").textContent).toContain("5 min ago");
	});

	it("groups changes by area with status badges, counts and line stats", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		const text = $("git-list").textContent ?? "";
		for (const h of ["Conflicts", "Staged", "Changes", "Untracked", "Recent commits"]) {
			expect(text).toContain(h);
		}
		expect($("git-summary").textContent).toContain("feat/x");
		expect($("git-summary").textContent).toContain("↑2 ↓1");
		expect($("git-summary").textContent).toContain("7 changed");
		const titles = [...document.querySelectorAll(".git-section-title")].map((e) => e.textContent);
		expect(titles).toEqual(["Conflicts1", "Staged2", "Changes2", "Untracked2", "Recent commits"]);
		expect(rowFor("staged:src/new.ts")?.textContent).toContain("+3");
		expect(rowFor("staged:src/new.ts")?.textContent).toContain("−1");
		expect(rowFor("unstaged:img.png")?.textContent).toContain("bin");
		expect(rowFor("staged:docs/b.md")?.title).toContain("docs/a.md → docs/b.md");
		expect(rowFor("untracked:.env")?.classList.contains("restricted")).toBe(true);
		expect(rowFor("conflict:merge.ts")?.querySelector(".git-row-status")?.textContent).toBe("!");
	});

	it("not a repository: offers found candidates and reloads with dir", async () => {
		api.fetchGitStatus.mockResolvedValueOnce({ repo: false, candidates: ["app", "lib"] });
		api.fetchGitLog.mockRejectedValueOnce(new api.GitApiError("no repo", 502, "git-failed"));
		await openGit();
		expect($("git-list").textContent).toContain("not a git repository");
		expect($("git-list").textContent).toContain("Repositories found");
		api.fetchGitStatus.mockResolvedValueOnce({ ...CLEAN, root: "app" });
		buttonNamed($("git-list"), "app")?.click();
		await flush();
		expect(api.fetchGitStatus).toHaveBeenLastCalledWith("s1", "app");
		expect($("git-summary").textContent).toContain("app");
		expect($("git-list").textContent).toContain("Working tree clean");
	});

	it("session not running: explains, offers Start, and reloads once the poll says running", async () => {
		mainState.currentTerminals = new Map();
		api.fetchGitStatus.mockRejectedValueOnce(
			new api.GitApiError("Session is not running", 409, "session-not-running"),
		);
		api.fetchGitLog.mockRejectedValueOnce(new api.GitApiError("x", 409, "session-not-running"));
		await openGit("s1", "stopped");
		expect($("git-list").textContent).toContain("isn't running");
		buttonNamed($("git-list"), "Start session")?.click();
		await flush();
		expect(api.startSession).toHaveBeenCalledWith("s1");
		expect(core.refreshSessions).toHaveBeenCalled();
		// Poll reports running → auto reload.
		mainState.sessions = [{ sessionId: "s1", name: "s1", status: "running" }];
		mainState.currentTerminals = new Map([["t1", {}]]);
		vs.syncSessionViews();
		await flush();
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(2);
		expect($("git-list").textContent).toContain("Working tree clean");
	});

	it("errors: timeout message, generic error with Retry", async () => {
		api.fetchGitStatus.mockRejectedValueOnce(
			new api.GitApiError("git status timed out", 504, "timeout"),
		);
		await openGit();
		expect($("git-list").textContent).toContain("took too long");
		api.fetchGitStatus.mockRejectedValueOnce(new api.GitApiError("boom", 502, "git-failed"));
		buttonNamed($("git-list"), "Retry")?.click();
		await flush();
		expect($("git-list").textContent).toContain("boom");
		buttonNamed($("git-list"), "Retry")?.click();
		await flush();
		expect($("git-list").textContent).toContain("Working tree clean");
	});

	it("flags a truncated change list", async () => {
		api.fetchGitStatus.mockResolvedValue({ ...DIRTY, truncated: true });
		await openGit();
		expect($("git-list").textContent).toContain("Showing the first 7 changed files");
		expect($("git-summary").textContent).toContain("7+ changed");
	});
});

describe("diff", () => {
	it("fetches and renders the selected file's diff with line numbers", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		expect($("git-diff").textContent).toContain("Select a changed file");
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		expect(api.fetchGitDiff).toHaveBeenCalledWith("s1", {
			path: "src/app.ts",
			area: "unstaged",
			oldPath: null,
			dir: "",
		});
		expect(rowFor("unstaged:src/app.ts")?.classList.contains("selected")).toBe(true);
		const rows = [...document.querySelectorAll<HTMLElement>(".git-diff-row")];
		const kinds = rows.map((r) => r.className.replace("git-diff-row ", ""));
		expect(kinds).toEqual([
			"kind-meta",
			"kind-meta",
			"kind-meta",
			"kind-hunk",
			"kind-context",
			"kind-del",
			"kind-add",
			"kind-add",
		]);
		const nums = (r: HTMLElement) =>
			[...r.querySelectorAll(".git-diff-no")].map((n) => n.textContent).join("|");
		expect(nums(rows[4] as HTMLElement)).toBe("1|1");
		expect(nums(rows[5] as HTMLElement)).toBe("2|");
		expect(nums(rows[6] as HTMLElement)).toBe("|2");
		expect(rows[6]?.querySelector(".git-diff-text")?.textContent).toBe("new");
		expect($("git-diff").textContent).toContain("+2");
		expect($("git-diff").textContent).toContain("−1");
	});

	it("passes oldPath for renames and the chosen dir", async () => {
		api.fetchGitStatus.mockResolvedValueOnce({ repo: false, candidates: ["app"] });
		api.fetchGitLog.mockRejectedValueOnce(new Error("x"));
		await openGit();
		api.fetchGitStatus.mockResolvedValueOnce({ ...DIRTY, root: "app" });
		buttonNamed($("git-list"), "app")?.click();
		await flush();
		rowFor("staged:docs/b.md")?.click();
		await flush();
		expect(api.fetchGitDiff).toHaveBeenCalledWith("s1", {
			path: "docs/b.md",
			area: "staged",
			oldPath: "docs/a.md",
			dir: "app",
		});
	});

	it("never requests a diff for a restricted entry", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		rowFor("untracked:.env")?.click();
		await flush();
		expect(api.fetchGitDiff).not.toHaveBeenCalled();
		expect($("git-diff").textContent).toContain("restricted");
	});

	it("renders binary, truncated and header-only diffs", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		api.fetchGitDiff.mockResolvedValueOnce({
			path: "img.png",
			area: "unstaged",
			patch: "Binary files a/img.png and b/img.png differ\n",
			truncated: false,
			binary: true,
		});
		rowFor("unstaged:img.png")?.click();
		await flush();
		expect($("git-diff").textContent).toContain("Binary file");
		api.fetchGitDiff.mockResolvedValueOnce({
			path: "src/app.ts",
			area: "unstaged",
			patch: PATCH,
			truncated: true,
			binary: false,
		});
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		expect($("git-diff").textContent).toContain("Large diff");
		api.fetchGitDiff.mockResolvedValueOnce({
			path: "docs/b.md",
			area: "staged",
			patch: "diff --git a/docs/a.md b/docs/b.md\nsimilarity index 100%\n",
			truncated: false,
			binary: false,
		});
		rowFor("staged:docs/b.md")?.click();
		await flush();
		expect($("git-diff").textContent).toContain("No content changes");
		expect($("git-diff").textContent).toContain("renamed from docs/a.md");
	});

	it("explains a 403 and offers Retry on other failures", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		api.fetchGitDiff.mockRejectedValueOnce(new api.GitApiError("restricted", 403, null));
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		expect($("git-diff").textContent).toContain("restricted");
		expect(buttonNamed($("git-diff"), "Retry")).toBeUndefined();
		api.fetchGitDiff.mockRejectedValueOnce(new api.GitApiError("nope", 502, "git-failed"));
		rowFor("staged:src/new.ts")?.click();
		await flush();
		expect($("git-diff").textContent).toContain("nope");
		buttonNamed($("git-diff"), "Retry")?.click();
		await flush();
		expect(document.querySelectorAll(".git-diff-row").length).toBeGreaterThan(0);
	});

	it("queues a superseded diff behind the one in flight and renders only the latest", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		const pending: { req: { path: string }; resolve: (v: unknown) => void }[] = [];
		api.fetchGitDiff.mockImplementation(
			(_s: string, req: { path: string }) =>
				new Promise((resolve) => {
					pending.push({ req, resolve });
				}),
		);
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		rowFor("staged:src/new.ts")?.click();
		rowFor("staged:docs/b.md")?.click();
		await flush();
		// One request on the wire (the backend holds a slot until git
		// ends, so a second one would race the per-user cap).
		expect(pending.map((p) => p.req.path)).toEqual(["src/app.ts"]);
		expect($("git-diff").textContent).toContain("Loading diff");
		pending[0]?.resolve({
			path: "src/app.ts",
			area: "unstaged",
			patch: PATCH,
			truncated: false,
			binary: false,
		});
		await flush();
		// The first result is stale (selection moved on) and the LATEST
		// click, not the intermediate one, goes out next.
		expect(pending.map((p) => p.req.path)).toEqual(["src/app.ts", "docs/b.md"]);
		expect($("git-diff").textContent).toContain("Loading diff");
		pending[1]?.resolve({
			path: "docs/b.md",
			area: "staged",
			patch: "diff --git a/docs/a.md b/docs/b.md\nsimilarity index 100%\n",
			truncated: false,
			binary: false,
		});
		await flush();
		expect($("git-diff").textContent).toContain("No content changes");
		expect($("git-diff").textContent).not.toContain("+more");
	});

	it("drops the open diff when a refresh no longer lists that file", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		api.fetchGitStatus.mockResolvedValue(CLEAN);
		$("git-refresh-btn").click();
		await flush();
		expect($("git-list").textContent).toContain("Working tree clean");
		expect($("git-diff").textContent).toContain("Select a changed file");
	});

	it("refresh re-fetches status and log first, then the open diff — never three at once", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		api.fetchGitDiff.mockClear();
		let finishStatus: (v: unknown) => void = () => {};
		let finishLog: (v: unknown) => void = () => {};
		api.fetchGitStatus.mockReturnValueOnce(new Promise((r) => (finishStatus = r)));
		api.fetchGitLog.mockReturnValueOnce(new Promise((r) => (finishLog = r)));
		$("git-refresh-btn").click();
		await flush();
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(2);
		expect(api.fetchGitLog).toHaveBeenCalledTimes(2);
		// Two in flight = the per-user budget; the diff waits.
		expect(api.fetchGitDiff).not.toHaveBeenCalled();
		finishStatus(DIRTY);
		await flush();
		expect(api.fetchGitDiff).not.toHaveBeenCalled();
		finishLog(COMMITS);
		await flush();
		expect(api.fetchGitDiff).toHaveBeenCalledTimes(1);
		expect(api.fetchGitDiff).toHaveBeenLastCalledWith("s1", {
			path: "src/app.ts",
			area: "unstaged",
			oldPath: null,
			dir: "",
		});
		expect(rowFor("unstaged:src/app.ts")?.classList.contains("selected")).toBe(true);
	});

	it("a Refresh during the initial load waits for it instead of aborting and re-racing the slots", async () => {
		let finishStatus: (v: unknown) => void = () => {};
		let finishLog: (v: unknown) => void = () => {};
		api.fetchGitStatus.mockReturnValueOnce(new Promise((r) => (finishStatus = r)));
		api.fetchGitLog.mockReturnValueOnce(new Promise((r) => (finishLog = r)));
		await openGit();
		expect($("git-list").textContent).toContain("Reading git status");
		$("git-refresh-btn").click();
		await flush();
		// Nothing new went out: the first pair still holds the server's
		// two slots (git keeps running whatever the browser does).
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(1);
		expect(api.fetchGitLog).toHaveBeenCalledTimes(1);
		finishStatus(DIRTY);
		finishLog(COMMITS);
		await flush();
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(2);
		expect(api.fetchGitLog).toHaveBeenCalledTimes(2);
		expect($("git-list").textContent).toContain("Working tree clean");
		expect($("git-list").textContent).not.toContain("Couldn't");
	});

	it("a session switch with a diff pending queues the new session's load behind it", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		let finishDiff: (v: unknown) => void = () => {};
		api.fetchGitDiff.mockReturnValueOnce(new Promise((r) => (finishDiff = r)));
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		expect(api.fetchGitDiff).toHaveBeenCalledTimes(1);
		api.fetchGitStatus.mockResolvedValue(CLEAN);
		selectSession("s2");
		await flush();
		// s1's diff still holds a server slot: s2's two requests wait.
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(1);
		expect($("git-list").textContent).toContain("Reading git status");
		finishDiff({
			path: "src/app.ts",
			area: "unstaged",
			patch: PATCH,
			truncated: false,
			binary: false,
		});
		await flush();
		expect(api.fetchGitStatus).toHaveBeenLastCalledWith("s2", "");
		expect(api.fetchGitLog).toHaveBeenLastCalledWith("s2", "");
		expect($("git-list").textContent).toContain("Working tree clean");
		expect($("git-list").textContent).toContain("feat: thing");
		// The old diff's result was dropped, not rendered into s2.
		expect($("git-diff").textContent).toContain("Select a changed file");
	});

	it("a queued diff and a Refresh released by the same earlier diff run one after the other", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		const pending: { path: string; resolve: (v: unknown) => void }[] = [];
		api.fetchGitDiff.mockImplementation(
			(_s: string, req: { path: string }) =>
				new Promise((resolve) => {
					pending.push({ path: req.path, resolve });
				}),
		);
		const done = (i: number) =>
			pending[i]?.resolve({
				path: pending[i]?.path,
				area: "unstaged",
				patch: PATCH,
				truncated: false,
				binary: false,
			});
		rowFor("unstaged:src/app.ts")?.click(); // A: on the wire
		await flush();
		rowFor("staged:src/new.ts")?.click(); // B: queued behind A
		$("git-refresh-btn").click(); // status+log: queued behind B
		await flush();
		expect(pending.map((p) => p.path)).toEqual(["src/app.ts"]);
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(1);
		done(0);
		await flush();
		// A ended → only B starts; the load keeps waiting (two slots max).
		expect(pending.map((p) => p.path)).toEqual(["src/app.ts", "src/new.ts"]);
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(1);
		done(1);
		await flush();
		// B ended → status+log go out, then the refresh re-opens B's diff.
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(2);
		expect(api.fetchGitLog).toHaveBeenCalledTimes(2);
		expect(pending.map((p) => p.path)).toEqual(["src/app.ts", "src/new.ts", "src/new.ts"]);
		done(2);
		await flush();
		expect(rowFor("staged:src/new.ts")?.classList.contains("selected")).toBe(true);
		expect($("git-list").textContent).not.toContain("Couldn't");
	});

	it("a refresh clicked while a diff is loading waits for that diff", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		let finishDiff: (v: unknown) => void = () => {};
		api.fetchGitDiff.mockReturnValueOnce(new Promise((r) => (finishDiff = r)));
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		$("git-refresh-btn").click();
		await flush();
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(1);
		finishDiff({
			path: "src/app.ts",
			area: "unstaged",
			patch: PATCH,
			truncated: false,
			binary: false,
		});
		await flush();
		expect(api.fetchGitStatus).toHaveBeenCalledTimes(2);
		// …and the diff is re-fetched after the refresh, as usual.
		expect(api.fetchGitDiff).toHaveBeenCalledTimes(2);
	});

	it("renders a conflict's combined diff with its markers, and caps rows on every branch", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		api.fetchGitDiff.mockResolvedValueOnce({
			path: "merge.ts",
			area: "conflict",
			patch: [
				"diff --cc merge.ts",
				"--- a/merge.ts",
				"+++ b/merge.ts",
				"@@@ -1,2 -1,2 +1,6 @@@",
				"  a",
				"++<<<<<<< HEAD",
				" +ours",
				"++=======",
				"+ theirs",
				"++>>>>>>> other",
				"",
			].join("\n"),
			truncated: false,
			binary: false,
		});
		rowFor("conflict:merge.ts")?.click();
		await flush();
		const text = $("git-diff").textContent ?? "";
		expect(text).not.toContain("No content changes");
		expect(text).toContain("Unresolved conflict");
		expect(text).toContain("<<<<<<< HEAD");
		expect(text).toContain("+5");
		expect(document.querySelectorAll(".git-diff-row.kind-add").length).toBe(5);
		// A header-only patch with thousands of lines is capped like any other.
		api.fetchGitDiff.mockResolvedValueOnce({
			path: "docs/b.md",
			area: "staged",
			patch: `${"diff --git a/docs/a.md b/docs/b.md\n"}${"similarity index 100%\n".repeat(6000)}`,
			truncated: false,
			binary: false,
		});
		rowFor("staged:docs/b.md")?.click();
		await flush();
		expect(document.querySelectorAll(".git-diff-row").length).toBe(5000);
		expect($("git-diff").textContent).toContain("Showing the first 5000 lines");
	});

	it("a nested repository (directory entry) explains itself instead of requesting a diff", async () => {
		api.fetchGitStatus.mockResolvedValue({
			...DIRTY,
			changes: [...DIRTY.changes, change("untracked", "?", "vendor/lib/", { additions: null })],
		});
		await openGit();
		rowFor("untracked:vendor/lib/")?.click();
		await flush();
		expect(api.fetchGitDiff).not.toHaveBeenCalled();
		expect($("git-diff").textContent).toContain("directory");
	});
});

describe("mobile", () => {
	it("stacks list and diff; selecting a file shows the diff and ‹ Changes goes back", async () => {
		mainState.mobile = true;
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		expect($("git-body").classList.contains("show-diff")).toBe(false);
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		expect($("git-body").classList.contains("show-diff")).toBe(true);
		buttonNamed($("git-diff"), "‹ Changes")?.click();
		expect($("git-body").classList.contains("show-diff")).toBe(false);
		// The selection survives going back; the row is still marked.
		expect(rowFor("unstaged:src/app.ts")?.classList.contains("selected")).toBe(true);
	});
});

describe("sessions", () => {
	it("drops the previous session's state on switch and refetches for the new one", async () => {
		api.fetchGitStatus.mockResolvedValue(DIRTY);
		await openGit();
		rowFor("unstaged:src/app.ts")?.click();
		await flush();
		api.fetchGitStatus.mockResolvedValue(CLEAN);
		selectSession("s2");
		await flush();
		expect(api.fetchGitStatus).toHaveBeenLastCalledWith("s2", "");
		expect($("git-list").textContent).toContain("Working tree clean");
		expect($("git-diff").textContent).toContain("Select a changed file");
		expect(rowFor("unstaged:src/app.ts")).toBeUndefined();
	});

	it("ignores a late result from the previous session", async () => {
		let resolveOld: (v: unknown) => void = () => {};
		api.fetchGitStatus.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
		selectSession("s1");
		$("view-git-btn").click();
		await flush();
		api.fetchGitStatus.mockResolvedValue(CLEAN);
		selectSession("s2");
		await flush();
		resolveOld(DIRTY);
		await flush();
		expect($("git-list").textContent).toContain("Working tree clean");
		expect(rowFor("unstaged:src/app.ts")).toBeUndefined();
	});

	it("hides and clears everything when the session goes away (logout)", async () => {
		await openGit();
		mainState.activeSessionId = null;
		mainState.sessions = [];
		vs.syncSessionViews();
		expect($("git-view").hidden).toBe(true);
		expect(vs.getView()).toBe("terminal");
		await openGit("s3");
		expect(api.fetchGitStatus).toHaveBeenLastCalledWith("s3", "");
	});
});

describe("relativeDate", () => {
	it("formats recent times coarsely", () => {
		const now = Date.parse("2026-10-22T12:00:00Z");
		const at = (ms: number) => new Date(now - ms).toISOString();
		expect(gv.relativeDate(at(10_000), now)).toBe("just now");
		expect(gv.relativeDate(at(5 * 60_000), now)).toBe("5 min ago");
		expect(gv.relativeDate(at(3 * 3_600_000), now)).toBe("3 h ago");
		expect(gv.relativeDate(at(2 * 86_400_000), now)).toBe("2 d ago");
		expect(gv.relativeDate("garbage", now)).toBe("garbage");
	});
});
