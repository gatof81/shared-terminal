/**
 * filesView.test.ts — Workspace Explorer UI behaviour under jsdom, with
 * main.ts (app state) and api.ts (network) mocked. The load-bearing
 * assertion is the terminal invariant: entering/leaving Files must not
 * touch the terminal container or its panes.
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
	class WorkspaceFsError extends Error {
		constructor(
			message: string,
			readonly status: number,
		) {
			super(message);
		}
	}
	return {
		WorkspaceFsError,
		listWorkspaceDir: vi.fn(),
		previewWorkspaceFile: vi.fn(),
		fetchWorkspaceImage: vi.fn(),
		downloadSessionFile: vi.fn(),
	};
});
vi.mock("./api.js", () => api);

const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("./saveBlob.js", () => ({ saveBlob }));

type FilesView = typeof import("./filesView.js");
type ViewSwitch = typeof import("./viewSwitch.js");
let fv: FilesView;
let vs: ViewSwitch;

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const entry = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
	name,
	type,
	size: type === "file" ? 10 : null,
	mtime: "2026-01-01T00:00:00.000Z",
	restricted: false,
	...extra,
});

const ROOT_LISTING = {
	path: "",
	truncated: false,
	entries: [
		entry("src", "dir"),
		entry(".st", "dir", { restricted: true, mtime: null }),
		entry("README.md", "file"),
		entry("blob.bin", "file"),
		entry(".env", "file", { restricted: true, size: null, mtime: null }),
		entry("link", "symlink"),
	],
};

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
					<button id="view-chat-btn"></button>
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
			<div id="chat-view" hidden><button id="chat-to-terminal-btn"></button></div>
		</section>`;
	// jsdom has no ResizeObserver; the module installs one at load.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"URL",
		Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
	);
	vs = await import("./viewSwitch.js");
	fv = await import("./filesView.js");
});

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const rowFor = (path: string) =>
	[...document.querySelectorAll<HTMLElement>(".files-row")].find((r) => r.dataset.path === path);

function selectSession(id: string, status = "running") {
	mainState.activeSessionId = id;
	mainState.sessions = [{ sessionId: id, name: id, status }];
	vs.syncSessionViews();
}

beforeEach(() => {
	api.listWorkspaceDir.mockReset().mockResolvedValue(ROOT_LISTING);
	api.previewWorkspaceFile.mockReset();
	api.downloadSessionFile.mockReset();
	mainState.currentTerminals = new Map([["t1", {}]]);
	mainState.focus.mockClear();
	mainState.showToast.mockClear();
});

afterEach(() => {
	// Back to "no session" so every test starts from a clean view.
	mainState.activeSessionId = null;
	mainState.sessions = [];
	vs.syncSessionViews();
});

describe("view switching", () => {
	it("makes the covered terminal inert (not focusable) while Files is shown, and restores it", async () => {
		selectSession("s1");
		const covered = ["terminal-tabs", "terminal-container", "key-bar"];
		const xtermInput = $("xterm-input") as HTMLTextAreaElement;
		xtermInput.focus();
		expect(document.activeElement).toBe(xtermInput);

		$("view-files-btn").click();
		await flush();
		for (const id of covered) expect($(id).hasAttribute("inert")).toBe(true);
		// Focus left the terminal; terminal-only toolbar controls are off.
		expect(document.activeElement).not.toBe(xtermInput);
		for (const id of ["font-size-btn", "terminal-search-btn", "terminal-search-input"]) {
			expect(($(id) as HTMLButtonElement).disabled).toBe(true);
		}
		// Layout untouched: inert is an attribute, not a display change.
		expect($("terminal-container").getAttribute("style")).toBe("display: block");

		mainState.focus.mockClear();
		$("view-terminal-btn").click();
		for (const id of covered) expect($(id).hasAttribute("inert")).toBe(false);
		for (const id of ["font-size-btn", "terminal-search-btn", "terminal-search-input"]) {
			expect(($(id) as HTMLButtonElement).disabled).toBe(false);
		}
		// Focus is handed back to the terminal after inert is lifted.
		expect(mainState.focus).toHaveBeenCalledTimes(1);
	});

	it("doesn't steal focus back to the terminal on mobile", async () => {
		mainState.mobile = true;
		try {
			selectSession("s1");
			$("view-files-btn").click();
			await flush();
			mainState.focus.mockClear();
			$("view-terminal-btn").click();
			expect(mainState.focus).not.toHaveBeenCalled();
			expect(mainState.setChromeOpen).toHaveBeenCalledWith(false);
		} finally {
			mainState.mobile = false;
		}
	});

	it("overlays Files without touching the terminal container or panes", async () => {
		selectSession("s1");
		const container = $("terminal-container");
		const pane = $("pane");
		const before = { style: container.getAttribute("style"), html: container.innerHTML };

		$("view-files-btn").click();
		await flush();
		expect($("files-view").hidden).toBe(false);
		expect(fv.isFilesViewActive()).toBe(true);

		$("view-terminal-btn").click();
		expect($("files-view").hidden).toBe(true);
		expect(container.getAttribute("style")).toBe(before.style);
		expect(container.innerHTML).toBe(before.html);
		expect(pane.isConnected).toBe(true);
		// Desktop hands focus back to the terminal.
		expect(mainState.focus).toHaveBeenCalled();
	});

	it("shows the view switch only while a session is active", () => {
		expect($("view-switch").hidden).toBe(true);
		selectSession("s1");
		expect($("view-switch").hidden).toBe(false);
	});

	it("forces Files for a stopped session; Terminal stays selectable and snaps back once it runs", async () => {
		mainState.currentTerminals = new Map();
		selectSession("s1", "stopped");
		await flush();
		expect(fv.isFilesViewActive()).toBe(true);
		// Selectable: the Terminal view shows the stopped state and a Start action.
		expect(($("view-terminal-btn") as HTMLButtonElement).disabled).toBe(false);
		expect(api.listWorkspaceDir).toHaveBeenCalledWith("s1", "");

		// Session started → terminal available again → snaps back.
		mainState.sessions = [{ sessionId: "s1", name: "s1", status: "running" }];
		vs.syncSessionViews();
		expect(($("view-terminal-btn") as HTMLButtonElement).disabled).toBe(false);
		expect(fv.isFilesViewActive()).toBe(false);
	});

	it("keeps a user-chosen Files view when the session state changes", async () => {
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		vs.syncSessionViews();
		expect(fv.isFilesViewActive()).toBe(true);
	});
});

describe("tree", () => {
	it("renders the root listing with restricted and symlink markers", async () => {
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		expect(rowFor("src")?.getAttribute("aria-expanded")).toBe("false");
		expect(rowFor(".env")?.classList.contains("restricted")).toBe(true);
		// Restricted dirs are not expandable.
		expect(rowFor(".st")?.hasAttribute("aria-expanded")).toBe(false);
		expect(rowFor("link")?.title).toContain("not followed");
	});

	it("expands folders lazily", async () => {
		api.listWorkspaceDir.mockImplementation(async (_sid: string, p: string) =>
			p === ""
				? ROOT_LISTING
				: { path: "src", truncated: false, entries: [entry("index.ts", "file")] },
		);
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		rowFor("src")?.click();
		await flush();
		expect(api.listWorkspaceDir).toHaveBeenCalledWith("s1", "src");
		expect(rowFor("src")?.getAttribute("aria-expanded")).toBe("true");
		expect(rowFor("src/index.ts")).toBeDefined();
	});

	it("shows an error state with retry when listing fails", async () => {
		api.listWorkspaceDir.mockRejectedValueOnce(new api.WorkspaceFsError("boom", 500));
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		expect($("files-tree").textContent).toContain("boom");
		const retry = [...$("files-tree").querySelectorAll("button")].find(
			(b) => b.textContent === "Retry",
		);
		retry?.click();
		await flush();
		expect(rowFor("README.md")).toBeDefined();
	});

	it("shows an empty state for an empty workspace", async () => {
		api.listWorkspaceDir.mockResolvedValue({ path: "", truncated: false, entries: [] });
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		expect($("files-tree").textContent).toContain("empty");
	});

	it("never requests a preview for restricted entries", async () => {
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		rowFor(".env")?.click();
		await flush();
		expect(api.previewWorkspaceFile).not.toHaveBeenCalled();
		expect($("files-preview").textContent).toContain("restricted");
	});

	it("drops the previous session's tree on session switch", async () => {
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		api.listWorkspaceDir.mockResolvedValue({
			path: "",
			truncated: false,
			entries: [entry("other.txt", "file")],
		});
		selectSession("s2");
		await flush();
		expect(api.listWorkspaceDir).toHaveBeenLastCalledWith("s2", "");
		expect(rowFor("README.md")).toBeUndefined();
		expect(rowFor("other.txt")).toBeDefined();
	});

	it("hides and clears everything when the session goes away (logout)", async () => {
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		mainState.activeSessionId = null;
		mainState.sessions = [];
		vs.syncSessionViews();
		expect($("files-view").hidden).toBe(true);
		// Re-entering for a new session refetches rather than reusing.
		selectSession("s3");
		$("view-files-btn").click();
		await flush();
		expect(api.listWorkspaceDir).toHaveBeenLastCalledWith("s3", "");
	});
});

describe("preview", () => {
	async function openFile(path: string, preview: unknown) {
		api.previewWorkspaceFile.mockResolvedValue(preview);
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		rowFor(path)?.click();
		await flush();
	}

	const meta = { size: 10, mtime: "2026-01-01T00:00:00.000Z" };

	it("renders Markdown safely and toggles to source", async () => {
		await openFile("README.md", {
			kind: "text",
			path: "README.md",
			name: "README.md",
			...meta,
			content: "# Title\n\n<script>alert(1)</script>",
			truncated: false,
		});
		const previewEl = $("files-preview");
		expect(previewEl.querySelector("h1")?.textContent).toBe("Title");
		expect(previewEl.querySelector("script")).toBeNull();
		const source = [...previewEl.querySelectorAll("button")].find(
			(b) => b.textContent === "Source",
		);
		source?.click();
		expect(previewEl.querySelector("h1")).toBeNull();
		expect(previewEl.querySelector(".files-code-body")?.textContent).toContain("# Title");
		// Restore the default for later tests (mode persists per page load).
		[...previewEl.querySelectorAll("button")].find((b) => b.textContent === "Preview")?.click();
		// Breadcrumbs reflect the selection.
		expect($("files-breadcrumbs").textContent).toBe("workspace/README.md");
	});

	it("flags truncated previews", async () => {
		await openFile("README.md", {
			kind: "text",
			path: "README.md",
			name: "README.md",
			...meta,
			content: "x",
			truncated: true,
		});
		expect($("files-preview").querySelector(".files-banner")).not.toBeNull();
	});

	it("offers download instead of rendering binaries", async () => {
		api.downloadSessionFile.mockResolvedValue({ blob: new Blob(["x"]), filename: "blob.bin" });
		await openFile("blob.bin", {
			kind: "binary",
			path: "blob.bin",
			name: "blob.bin",
			...meta,
			reason: "binary",
		});
		const previewEl = $("files-preview");
		expect(previewEl.textContent).toContain("binary");
		[...previewEl.querySelectorAll("button")]
			.find((b) => b.textContent === "Download file")
			?.click();
		await flush();
		expect(api.downloadSessionFile).toHaveBeenCalledWith("s1", "blob.bin");
		expect(saveBlob).toHaveBeenCalled();
	});

	it("aborts a superseded preview request", async () => {
		const signals: AbortSignal[] = [];
		api.previewWorkspaceFile.mockImplementation(
			(_sid: string, _p: string, signal: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signals.push(signal);
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		rowFor("README.md")?.click();
		await flush();
		rowFor("blob.bin")?.click();
		await flush();
		expect(signals).toHaveLength(2);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		// Selecting a folder aborts the in-flight one too.
		rowFor("src")?.click();
		expect(signals[1]?.aborted).toBe(true);
	});

	it("shows very large Markdown as source instead of rendering it", async () => {
		await openFile("README.md", {
			kind: "text",
			path: "README.md",
			name: "README.md",
			...meta,
			content: `# Big\n\n${"word ".repeat(60_000)}`,
			truncated: false,
		});
		const previewEl = $("files-preview");
		expect(previewEl.querySelector("h1")).toBeNull();
		expect(previewEl.textContent).toContain("Too large to render as Markdown");
		expect([...previewEl.querySelectorAll("button")].some((b) => b.textContent === "Preview")).toBe(
			false,
		);
		expect(previewEl.querySelector(".files-code-body")?.textContent).toContain("# Big");
	});

	it("explains a 403 from the server as restricted", async () => {
		api.previewWorkspaceFile.mockRejectedValue(new api.WorkspaceFsError("nope", 403));
		selectSession("s1");
		$("view-files-btn").click();
		await flush();
		rowFor("README.md")?.click();
		await flush();
		expect($("files-preview").textContent).toContain("restricted");
	});
});
