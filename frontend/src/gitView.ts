/**
 * gitView.ts — Git Changes: a read-only view of the active session's
 * repository (branch, changed files with line counts, one file's diff,
 * recent commits), alongside Terminal and Files.
 *
 * It is an OVERLAY over the terminal exactly like the Files view; the
 * switching mechanics and the terminal invariant (never disconnect /
 * resize / dispose the terminal) live in viewSwitch.ts.
 *
 * Unlike Files, this view needs the session RUNNING: the backend runs
 * git inside the session container (see backend gitReadOnly.ts for why),
 * so a stopped session gets a "start it" state rather than data.
 *
 * Layout: desktop = file list left, diff right; mobile = one pane at a
 * time (`.show-diff` on #git-body), with "‹ Changes" to come back.
 *
 * All git output (paths, commit subjects, patch lines) is rendered via
 * textContent — never innerHTML.
 */

import {
	fetchGitDiff,
	fetchGitLog,
	fetchGitStatus,
	GitApiError,
	type GitArea,
	type GitChange,
	type GitCommit,
	type GitDiff,
	type GitStatus,
} from "./api.js";
import { parseUnifiedDiff } from "./diff.js";
import { relativeDate } from "./format.js";
import { activeSessionId, isMobile, sessions } from "./main.js";
import { runSessionAction } from "./sessionCore.js";
import { button, el, stateBox } from "./ui.js";
import {
	getView,
	onSessionSync,
	onViewChange,
	reflectRoute,
	registerRouteDetail,
	routeBack,
} from "./viewSwitch.js";

// ── DOM ─────────────────────────────────────────────────────────────────────
const summaryEl = document.getElementById("git-summary")!;
const refreshBtn = document.getElementById("git-refresh-btn") as HTMLButtonElement;
const bodyEl = document.getElementById("git-body")!;
const listEl = document.getElementById("git-list")!;
const diffEl = document.getElementById("git-diff")!;

// ── State ───────────────────────────────────────────────────────────────────

/** Session the state below belongs to. */
let stateSessionId: string | null = null;
// Bumped on every session switch; async results carrying an older value
// are dropped so a slow fetch for session A never renders into B.
let generation = 0;
// Workspace-relative repo root being inspected ("" = workspace root).
// Changed only via the not-a-repo candidate buttons.
let dir = "";

type StatusState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "loaded"; data: GitStatus }
	| { status: "error"; message: string; httpStatus: number; code: string | null };
let status: StatusState = { status: "idle" };

type LogState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "loaded"; commits: GitCommit[] }
	| { status: "error"; message: string };
let log: LogState = { status: "idle" };

interface Selected {
	path: string;
	area: GitArea;
	oldPath: string | null;
	restricted: boolean;
	/** A directory entry (nested repository): git has no diff for it. */
	directory: boolean;
}
let selected: Selected | null = null;

type DiffState =
	| { status: "none" }
	| { status: "loading" }
	| { status: "loaded"; data: GitDiff }
	| { status: "error"; message: string; httpStatus: number; code: string | null };
let diff: DiffState = { status: "none" };
let diffToken = 0;

// ── Request queue ───────────────────────────────────────────────────────────
//
// The backend allows two git requests in flight per user and holds each
// slot until its git run has actually ENDED — aborting a fetch frees
// nothing server-side (a docker exec can't be cancelled), so this view
// never aborts anything. Instead every batch — one status+log load (two
// requests) or one diff (one) — takes a turn on a single FIFO, and the
// turn is reserved SYNCHRONOUSLY, before the first await, so two callers
// released by the same earlier batch can't both start (that was the
// 429). Stale work (a superseded click, a switched session) is dropped
// by generation / token when its turn comes, without spending a request.
let queue: Promise<void> = Promise.resolve();

function enqueue(run: () => Promise<void>): Promise<void> {
	const turn = queue.then(run, run);
	queue = turn.then(
		() => undefined,
		() => undefined,
	);
	return turn;
}

let mobilePane: "list" | "diff" = "list";
// A route detail (<area>:<path>) that arrived before the status did.
let pendingDetail: string | null = null;

// Route detail = the selected change (#/sessions/<id>/git/<area>:<path>).
registerRouteDetail("git", {
	current: () => (selected ? `${selected.area}:${selected.path}` : null),
	apply: (detail) => {
		pendingDetail = null;
		if (detail === null) {
			selected = null;
			clearDiff();
			mobilePane = "list";
			renderAll();
			return;
		}
		if (status.status !== "loaded" || !status.data.repo) {
			pendingDetail = detail; // applied when the status lands (load)
			return;
		}
		const c = findChangeByKey(status.data, detail);
		if (c) selectChange(c);
	},
});

function findChangeByKey(data: GitStatus, key: string): GitChange | undefined {
	const i = key.indexOf(":");
	if (i === -1 || !data.repo) return undefined;
	const area = key.slice(0, i);
	const path = key.slice(i + 1);
	return data.changes.find((c) => c.area === area && c.path === path);
}

// Past this many rendered rows the diff pane stops: it's a browser pane,
// not an IDE, and the server already caps the patch bytes.
const MAX_DIFF_ROWS = 5000;

// ── View switching ──────────────────────────────────────────────────────────

export function isGitViewActive(): boolean {
	return getView() === "git";
}

onViewChange((next) => {
	if (next !== "git") return;
	if (stateSessionId !== null && status.status === "idle") void load();
	renderAll();
});

onSessionSync(() => {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) {
		resetState(null);
		return;
	}
	if (s.sessionId !== stateSessionId) {
		resetState(s.sessionId);
		if (isGitViewActive()) {
			void load();
			renderAll();
		}
		return;
	}
	// The session was started while this view showed "not running" (via
	// the Start button here or the sidebar): pick the data up as soon as
	// the poll reports it running. Nothing else re-renders on a poll —
	// rebuilding the diff would drop scroll position and text selection.
	if (
		isGitViewActive() &&
		s.status === "running" &&
		status.status === "error" &&
		status.code === "session-not-running"
	) {
		void load();
	}
});

function resetState(sessionId: string | null): void {
	// No abort: the requests in flight keep their server-side slots
	// until git ends anyway, so the next session's load takes its turn
	// on the queue behind them; the generation bump drops their results.
	generation++;
	stateSessionId = sessionId;
	dir = "";
	status = { status: "idle" };
	log = { status: "idle" };
	selected = null;
	clearDiff();
	mobilePane = "list";
}

// ── Data loading ────────────────────────────────────────────────────────────

async function load(): Promise<void> {
	const sessionId = stateSessionId;
	if (sessionId === null) return;
	const gen = generation;
	const stale = () => gen !== generation;
	status = { status: "loading" };
	log = { status: "loading" };
	renderAll();
	await enqueue(async () => {
		if (stale()) return;
		// Status and log are independent reads: fire both, render each as
		// it lands. A log failure on a non-repo is expected and never shown.
		// The turn ends only when BOTH have settled.
		const statusDone = fetchGitStatus(sessionId, dir).then(
			(data) => {
				if (stale()) return;
				status = { status: "loaded", data };
				// Keep the open diff only if its file is still in the list;
				// otherwise it describes a change that no longer exists.
				if (selected !== null && !(data.repo && findChange(data, selected))) {
					selected = null;
					clearDiff();
					mobilePane = "list";
				}
				renderAll();
				// A deep link into a diff: the change can be selected now.
				if (pendingDetail !== null) {
					const c = data.repo ? findChangeByKey(data, pendingDetail) : undefined;
					pendingDetail = null;
					if (c) selectChange(c);
				}
			},
			(err: unknown) => {
				if (stale()) return;
				status = {
					status: "error",
					message: (err as Error).message,
					httpStatus: err instanceof GitApiError ? err.status : 0,
					code: err instanceof GitApiError ? err.code : null,
				};
				renderAll();
			},
		);
		const logDone = fetchGitLog(sessionId, dir).then(
			(commits) => {
				if (stale()) return;
				log = { status: "loaded", commits };
				renderList();
			},
			(err: unknown) => {
				if (stale()) return;
				log = { status: "error", message: (err as Error).message };
				renderList();
			},
		);
		await statusDone;
		await logDone;
	});
}

function findChange(data: GitStatus, sel: Selected): GitChange | undefined {
	if (!data.repo) return undefined;
	return data.changes.find((c) => c.path === sel.path && c.area === sel.area);
}

function clearDiff(): void {
	diffToken++;
	diff = { status: "none" };
}

async function openDiff(sel: Selected): Promise<void> {
	const sessionId = stateSessionId;
	if (sessionId === null) return;
	const token = ++diffToken;
	const stale = () => token !== diffToken || sessionId !== stateSessionId;
	diff = { status: "loading" };
	renderDiff();
	await enqueue(async () => {
		// A click superseded while it waited its turn never fetches.
		if (stale()) return;
		try {
			const data = await fetchGitDiff(sessionId, {
				path: sel.path,
				area: sel.area,
				oldPath: sel.oldPath,
				dir,
			});
			if (stale()) return;
			diff = { status: "loaded", data };
		} catch (err) {
			if (stale()) return;
			diff = {
				status: "error",
				message: (err as Error).message,
				httpStatus: err instanceof GitApiError ? err.status : 0,
				code: err instanceof GitApiError ? err.code : null,
			};
		}
		renderDiff();
	});
}

// ── Actions ─────────────────────────────────────────────────────────────────

function selectChange(c: GitChange): void {
	selected = {
		path: c.path,
		area: c.area,
		oldPath: c.oldPath,
		restricted: c.restricted,
		// `git status` reports a nested repository as `dir/` — one entry,
		// no contents, nothing a diff could show.
		directory: c.path.endsWith("/"),
	};
	if (c.restricted || selected.directory) {
		// Never even ask: the server would refuse, and the row already
		// says why.
		clearDiff();
	} else {
		void openDiff(selected);
	}
	if (isMobile()) mobilePane = "diff";
	renderAll();
	// Opening a diff is a step Back undoes (a no-op while a route is being applied).
	reflectRoute({ push: true });
}

function chooseDir(next: string): void {
	dir = next;
	selected = null;
	clearDiff();
	mobilePane = "list";
	void load();
}

async function refresh(): Promise<void> {
	if (stateSessionId === null) return;
	refreshBtn.classList.add("spinning");
	refreshBtn.disabled = true;
	try {
		// Status + log first (that's the per-user budget), THEN the open
		// diff — and only if the refreshed list still carries that entry
		// (load() drops a selection that vanished).
		await load();
		const sel = selected;
		if (sel !== null && !sel.restricted && !sel.directory) await openDiff(sel);
	} finally {
		refreshBtn.classList.remove("spinning");
		refreshBtn.disabled = false;
	}
}
refreshBtn.addEventListener("click", () => void refresh());

async function startThisSession(): Promise<void> {
	const s = sessions.find((x) => x.sessionId === stateSessionId);
	if (!s) return;
	// The same verb as the sidebar and the terminal's stopped state; the
	// poll-driven sync above reloads once the list says "running".
	await runSessionAction(s, "start");
}

// ── Rendering ───────────────────────────────────────────────────────────────

const AREA_LABEL: Record<GitArea, string> = {
	staged: "Staged",
	unstaged: "Changes",
	untracked: "Untracked",
	conflict: "Conflicts",
};
const AREA_ORDER: GitArea[] = ["conflict", "staged", "unstaged", "untracked"];

const STATUS_WORD = new Map<string, string>([
	["M", "Modified"],
	["A", "Added"],
	["D", "Deleted"],
	["R", "Renamed"],
	["C", "Copied"],
	["T", "Type changed"],
	["U", "Conflict"],
	["?", "Untracked"],
]);

function statusWord(c: GitChange): string {
	return c.area === "conflict" ? `Conflict (${c.xy})` : (STATUS_WORD.get(c.status) ?? c.status);
}

function statusLetter(c: GitChange): string {
	return c.area === "untracked" ? "U" : c.area === "conflict" ? "!" : c.status;
}

function renderAll(): void {
	if (!isGitViewActive()) return;
	renderSummary();
	renderList();
	renderDiff();
	bodyEl.classList.toggle("show-diff", mobilePane === "diff");
}

function renderSummary(): void {
	summaryEl.replaceChildren();
	if (status.status !== "loaded" || !status.data.repo) {
		summaryEl.appendChild(el("span", "git-summary-title", "Git"));
		if (dir !== "") summaryEl.appendChild(el("span", "git-summary-dir", dir));
		return;
	}
	const d = status.data;
	const branch = el("span", "git-branch");
	branch.appendChild(el("span", "git-branch-icon", "⎇"));
	if (d.branch !== null) {
		branch.appendChild(el("span", "git-branch-name", d.branch));
	} else {
		branch.appendChild(
			el(
				"span",
				"git-branch-name detached",
				d.head ? `HEAD @ ${d.head.slice(0, 7)}` : "no commits",
			),
		);
	}
	branch.title = d.upstream ? `Tracking ${d.upstream}` : "No upstream";
	summaryEl.appendChild(branch);
	if (d.ahead !== null && d.behind !== null && (d.ahead > 0 || d.behind > 0)) {
		const ab = el("span", "git-ahead-behind", `↑${d.ahead} ↓${d.behind}`);
		ab.title = `${d.ahead} ahead, ${d.behind} behind ${d.upstream ?? "upstream"}`;
		summaryEl.appendChild(ab);
	}
	if (dir !== "") summaryEl.appendChild(el("span", "git-summary-dir", dir));
	const n = d.changes.length;
	summaryEl.appendChild(
		el("span", "git-summary-count", n === 0 ? "clean" : `${n}${d.truncated ? "+" : ""} changed`),
	);
}

function renderList(): void {
	if (!isGitViewActive()) return;
	const active = document.activeElement;
	const focusedKey =
		active instanceof HTMLElement && listEl.contains(active) ? active.dataset.key : undefined;
	const scrollTop = listEl.scrollTop;
	listEl.replaceChildren();

	if (status.status === "idle" || status.status === "loading") {
		listEl.appendChild(stateBox("loading", "Reading git status…"));
		return;
	}
	if (status.status === "error") {
		listEl.appendChild(errorBox(status));
		return;
	}
	const data = status.data;
	if (!data.repo) {
		listEl.appendChild(notRepoBox(data.candidates));
		return;
	}

	const frag = document.createDocumentFragment();
	if (data.changes.length === 0) {
		frag.appendChild(stateBox("empty", "Working tree clean — nothing to show."));
	}
	for (const area of AREA_ORDER) {
		const items = data.changes.filter((c) => c.area === area);
		if (items.length === 0) continue;
		const section = el("section", `git-section area-${area}`);
		const heading = el("h3", "git-section-title");
		heading.appendChild(el("span", undefined, AREA_LABEL[area]));
		heading.appendChild(el("span", "git-section-count", String(items.length)));
		section.appendChild(heading);
		const list = el("div", "git-rows");
		list.setAttribute("role", "list");
		for (const c of items) list.appendChild(changeRow(c));
		section.appendChild(list);
		frag.appendChild(section);
	}
	if (data.truncated) {
		frag.appendChild(
			el("div", "files-tree-note", `Showing the first ${data.changes.length} changed files`),
		);
	}
	frag.appendChild(commitsSection());
	listEl.appendChild(frag);
	listEl.scrollTop = scrollTop;
	if (focusedKey !== undefined) findRow(focusedKey)?.focus();
}

function changeRow(c: GitChange): HTMLElement {
	const row = el("button", "git-row");
	row.type = "button";
	row.dataset.key = `${c.area}:${c.path}`;
	row.setAttribute("role", "listitem");
	const isSel = selected?.path === c.path && selected.area === c.area;
	row.setAttribute("aria-pressed", String(isSel));
	if (isSel) row.classList.add("selected");
	if (c.restricted) row.classList.add("restricted");
	const badge = el("span", `git-row-status s-${statusLetter(c)}`, statusLetter(c));
	badge.title = statusWord(c);
	row.appendChild(badge);
	const pathEl = el("span", "git-row-path");
	const slash = c.path.lastIndexOf("/");
	if (slash !== -1) pathEl.appendChild(el("span", "git-row-dir", c.path.slice(0, slash + 1)));
	pathEl.appendChild(el("span", "git-row-name", c.path.slice(slash + 1)));
	row.appendChild(pathEl);
	if (c.restricted) {
		row.appendChild(el("span", "git-row-lock", "🔒"));
	} else if (c.binary) {
		row.appendChild(el("span", "git-row-stats", "bin"));
	} else if (c.additions !== null || c.deletions !== null) {
		const stats = el("span", "git-row-stats");
		stats.appendChild(el("span", "git-add", `+${c.additions ?? 0}`));
		stats.appendChild(el("span", "git-del", `−${c.deletions ?? 0}`));
		row.appendChild(stats);
	}
	row.title = c.oldPath
		? `${statusWord(c)}: ${c.oldPath} → ${c.path}`
		: c.restricted
			? `${c.path} — restricted (may contain credentials)`
			: `${statusWord(c)}: ${c.path}`;
	row.addEventListener("click", () => selectChange(c));
	return row;
}

function findRow(key: string): HTMLElement | undefined {
	return [...listEl.querySelectorAll<HTMLElement>(".git-row")].find((r) => r.dataset.key === key);
}

// ↑/↓ between file rows (Enter/Space are the buttons' own activation).
listEl.addEventListener("keydown", (e) => {
	const row = (e.target as HTMLElement).closest<HTMLElement>(".git-row");
	if (!row) return;
	const rows = [...listEl.querySelectorAll<HTMLElement>(".git-row")];
	const idx = rows.indexOf(row);
	const focusAt = (i: number) => rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
	switch (e.key) {
		case "ArrowDown":
			focusAt(idx + 1);
			break;
		case "ArrowUp":
			focusAt(idx - 1);
			break;
		case "Home":
			focusAt(0);
			break;
		case "End":
			focusAt(rows.length - 1);
			break;
		default:
			return;
	}
	e.preventDefault();
});

function commitsSection(): HTMLElement {
	const section = el("section", "git-section git-commits");
	const heading = el("h3", "git-section-title");
	heading.appendChild(el("span", undefined, "Recent commits"));
	section.appendChild(heading);
	if (log.status === "loading" || log.status === "idle") {
		section.appendChild(el("div", "files-tree-note", "Loading…"));
	} else if (log.status === "error") {
		const note = el("div", "files-tree-note error");
		note.appendChild(el("span", undefined, `Couldn't load commits: ${log.message}`));
		section.appendChild(note);
	} else if (log.commits.length === 0) {
		section.appendChild(el("div", "files-tree-note", "No commits yet"));
	} else {
		const list = el("div", "git-rows");
		list.setAttribute("role", "list");
		for (const c of log.commits) {
			const row = el("div", "git-commit");
			row.setAttribute("role", "listitem");
			row.appendChild(el("code", "git-commit-hash", c.shortHash));
			const text = el("span", "git-commit-text");
			text.appendChild(el("span", "git-commit-subject", c.subject));
			text.appendChild(el("span", "git-commit-meta", `${c.author} · ${relativeDate(c.date)}`));
			row.appendChild(text);
			row.title = `${c.hash}\n${c.author} · ${new Date(c.date).toLocaleString()}`;
			list.appendChild(row);
		}
		section.appendChild(list);
	}
	return section;
}

function errorBox(err: { message: string; httpStatus: number; code: string | null }): HTMLElement {
	if (err.code === "session-not-running") {
		const s = sessions.find((x) => x.sessionId === stateSessionId);
		const actions: HTMLElement[] = [];
		if (s?.status === "stopped") {
			actions.push(button("Start session", "files-btn primary", () => void startThisSession()));
		}
		return stateBox(
			"info",
			"This session isn't running. Git runs inside the session container, so start it to see changes.",
			...actions,
		);
	}
	if (err.code === "unsafe-repository") {
		return stateBox("info", err.message);
	}
	const msg =
		err.code === "timeout"
			? "Git took too long to answer. The repository may be very large or the container busy."
			: err.httpStatus === 429
				? "Too many git requests at once — try again in a moment."
				: `Couldn't read the repository: ${err.message}`;
	return stateBox(
		"error",
		msg,
		button("Retry", "files-btn", () => void load()),
	);
}

function notRepoBox(candidates: string[]): HTMLElement {
	const where = dir === "" ? "The workspace root" : `"${dir}"`;
	const actions: HTMLElement[] = [];
	if (candidates.length > 0) {
		const wrap = el("div", "git-candidates");
		wrap.appendChild(el("p", "git-candidates-title", "Repositories found in this workspace:"));
		for (const c of candidates) {
			wrap.appendChild(button(c, "files-btn", () => chooseDir(c), `Open repository ${c}`));
		}
		actions.push(wrap);
	}
	if (dir !== "") {
		actions.push(button("Back to workspace root", "files-btn", () => chooseDir("")));
	}
	return stateBox("info", `${where} is not a git repository.`, ...actions);
}

function diffHeader(name: string, meta: HTMLElement | string, actions: HTMLElement[]): HTMLElement {
	const header = el("div", "files-preview-header");
	header.appendChild(
		button("‹ Changes", "files-btn files-mobile-only", routeBack, "Back to the change list"),
	);
	const title = el("div", "files-preview-title");
	title.appendChild(el("span", "files-preview-name", name));
	if (typeof meta === "string") {
		if (meta) title.appendChild(el("span", "files-preview-meta", meta));
	} else {
		title.appendChild(meta);
	}
	header.appendChild(title);
	const bar = el("div", "files-preview-actions");
	bar.append(...actions);
	header.appendChild(bar);
	return header;
}

function renderDiff(): void {
	if (!isGitViewActive()) return;
	diffEl.replaceChildren();
	const sel = selected;
	if (sel === null) {
		diffEl.appendChild(stateBox("empty", "Select a changed file to see its diff."));
		return;
	}
	const name = sel.path.slice(sel.path.lastIndexOf("/") + 1);
	if (sel.directory) {
		diffEl.appendChild(diffHeader(sel.path, "directory", []));
		diffEl.appendChild(
			stateBox(
				"info",
				"This entry is a directory — usually a nested repository, which git lists as one untracked item. Open it from the terminal.",
			),
		);
		return;
	}
	if (sel.restricted) {
		diffEl.appendChild(diffHeader(name, "restricted", []));
		diffEl.appendChild(
			stateBox(
				"info",
				"This path is restricted because it may contain credentials (keys, tokens, .env secrets). Its diff can't be shown here.",
			),
		);
		return;
	}
	if (diff.status === "none" || diff.status === "loading") {
		diffEl.appendChild(diffHeader(name, AREA_LABEL[sel.area], []));
		diffEl.appendChild(stateBox("loading", "Loading diff…"));
		return;
	}
	if (diff.status === "error") {
		const e = diff;
		diffEl.appendChild(diffHeader(name, AREA_LABEL[sel.area], []));
		if (e.httpStatus === 403) {
			diffEl.appendChild(
				stateBox("info", "This file is restricted because it may contain credentials."),
			);
		} else if (e.code === "session-not-running") {
			diffEl.appendChild(stateBox("info", "The session stopped. Start it to load diffs again."));
		} else {
			const msg =
				e.code === "timeout"
					? "Git took too long to produce this diff."
					: e.httpStatus === 429
						? "Too many git requests at once — try again in a moment."
						: `Couldn't load the diff: ${e.message}`;
			diffEl.appendChild(
				stateBox(
					"error",
					msg,
					button("Retry", "files-btn", () => void openDiff(sel)),
				),
			);
		}
		return;
	}

	const data = diff.data;
	const parsed = parseUnifiedDiff(data.patch);
	const meta = el("span", "files-preview-meta");
	meta.appendChild(el("span", undefined, `${AREA_LABEL[sel.area]} · `));
	if (sel.oldPath) meta.appendChild(el("span", undefined, `renamed from ${sel.oldPath} · `));
	if (!data.binary && parsed.hasHunks) {
		meta.appendChild(el("span", "git-add", `+${parsed.additions}`));
		meta.appendChild(el("span", undefined, " "));
		meta.appendChild(el("span", "git-del", `−${parsed.deletions}`));
	}
	diffEl.appendChild(diffHeader(name, meta, []));

	if (data.truncated) {
		diffEl.appendChild(
			el(
				"div",
				"files-banner",
				"Large diff — showing the beginning only. Use the terminal for the full patch.",
			),
		);
	}
	if (data.binary) {
		diffEl.appendChild(stateBox("info", "Binary file — no textual diff to show."));
		return;
	}
	if (sel.area === "conflict" && parsed.hasHunks) {
		diffEl.appendChild(
			el(
				"div",
				"files-banner",
				"Unresolved conflict — combined diff of the working tree against both sides; the conflict markers show as added lines.",
			),
		);
	}
	const scroller = el("div", "files-preview-scroll");
	appendDiffRows(scroller, parsed.rows);
	if (!parsed.hasHunks) {
		scroller.appendChild(
			stateBox(
				"empty",
				parsed.rows.length > 0
					? "No content changes — a rename, mode change or identical content."
					: "No differences to show.",
			),
		);
	}
	diffEl.appendChild(scroller);
}

/** The rows, capped at MAX_DIFF_ROWS on every path that renders them. */
function appendDiffRows(
	scroller: HTMLElement,
	rows: ReturnType<typeof parseUnifiedDiff>["rows"],
): void {
	if (rows.length === 0) return;
	scroller.appendChild(diffTable(rows.slice(0, MAX_DIFF_ROWS)));
	if (rows.length > MAX_DIFF_ROWS) {
		scroller.appendChild(
			el("div", "files-tree-note", `Showing the first ${MAX_DIFF_ROWS} lines of this diff.`),
		);
	}
}

function diffTable(rows: ReturnType<typeof parseUnifiedDiff>["rows"]): HTMLElement {
	const table = el("div", "git-diff-table");
	const frag = document.createDocumentFragment();
	for (const r of rows) {
		const row = el("div", `git-diff-row kind-${r.kind}`);
		if (r.kind === "hunk" || r.kind === "meta" || r.kind === "note") {
			const cell = el("span", "git-diff-span", r.text);
			row.appendChild(cell);
		} else {
			row.appendChild(el("span", "git-diff-no", r.oldNo === null ? "" : String(r.oldNo)));
			row.appendChild(el("span", "git-diff-no", r.newNo === null ? "" : String(r.newNo)));
			row.appendChild(
				el("span", "git-diff-mark", r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "),
			);
			row.appendChild(el("span", "git-diff-text", r.text));
		}
		frag.appendChild(row);
	}
	table.appendChild(frag);
	return table;
}

export { relativeDate };
