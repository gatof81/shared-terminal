import { describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "./api.js";
import { STALE_EVIDENCE_MS } from "./conversationModel.js";
import {
	bucketOf,
	type FetchList,
	loadProjects,
	matches,
	type Project,
	ProjectLoader,
	sectionize,
	toItem,
	visibleInSwitcher,
} from "./switcherModel.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function conv(over: Partial<ConversationSummary> = {}): ConversationSummary {
	return {
		sessionId: "c1",
		kind: "interactive",
		title: "Refactor auth",
		status: "waiting_input",
		statusEvidence: "hook",
		statusAt: ago(60_000),
		tabId: "tab-1",
		paneId: "%1",
		startedAt: ago(3_600_000),
		endedAt: null,
		lastEventAt: ago(60_000),
		lastSeq: 10,
		firstRetainedSeq: 1,
		eventsCount: 10,
		gapsCount: 0,
		claudeVersion: "2.1.314",
		canSendInput: true,
		customTitle: null,
		archivedAt: null,
		...over,
	} as ConversationSummary;
}

describe("bucketOf — states come from the presentation, never from age or canSendInput alone", () => {
	it("a fresh permission or input wait needs the person", () => {
		expect(bucketOf(conv({ status: "waiting_permission" }), NOW).bucket).toBe("attention");
		expect(bucketOf(conv({ status: "waiting_input" }), NOW).bucket).toBe("attention");
	});
	it("a fresh run or background wait is working", () => {
		expect(bucketOf(conv({ status: "running" }), NOW).bucket).toBe("working");
		expect(bucketOf(conv({ status: "waiting_background" }), NOW).bucket).toBe("working");
	});
	it("a STALE wait is never 'needs you': it is quiet, labelled No recent activity", () => {
		const old = ago(STALE_EVIDENCE_MS + 1000);
		const b = bucketOf(
			conv({ status: "waiting_permission", statusAt: old, lastEventAt: old }),
			NOW,
		);
		expect(b.bucket).toBe("quiet");
		expect(b.status.label).toBe("No recent activity");
	});
	it("a recent event keeps an old status time fresh (lastEvidenceAt)", () => {
		const b = bucketOf(
			conv({ status: "running", statusAt: ago(STALE_EVIDENCE_MS * 3), lastEventAt: ago(1000) }),
			NOW,
		);
		expect(b.bucket).toBe("working");
	});
	it("unknown is quiet and says so; ended is recent", () => {
		expect(bucketOf(conv({ status: "unknown" }), NOW)).toMatchObject({
			bucket: "quiet",
			status: { label: "State unknown" },
		});
		expect(bucketOf(conv({ status: "ended" }), NOW).bucket).toBe("recent");
	});
	it("canSendInput does not change the bucket", () => {
		expect(bucketOf(conv({ status: "running", canSendInput: true }), NOW).bucket).toBe("working");
		expect(bucketOf(conv({ status: "waiting_input", canSendInput: false }), NOW).bucket).toBe(
			"attention",
		);
	});
});

describe("items, sections and search", () => {
	const proj = { sessionId: "s1", name: "my-project" };
	it("toItem keeps the project id and name apart from the conversation id", () => {
		const i = toItem(conv({ sessionId: "conv-9" }), proj, NOW);
		expect(i).toMatchObject({ sessionId: "s1", projectName: "my-project", cid: "conv-9" });
	});
	it("sections in order attention → working → recent → quiet, newest first inside", () => {
		const items = [
			toItem(conv({ sessionId: "a", status: "ended", lastEventAt: ago(5000) }), proj, NOW),
			toItem(conv({ sessionId: "b", status: "unknown" }), proj, NOW),
			toItem(conv({ sessionId: "c", status: "running" }), proj, NOW),
			toItem(conv({ sessionId: "d", status: "waiting_input", lastEventAt: ago(9000) }), proj, NOW),
			toItem(
				conv({ sessionId: "e", status: "waiting_permission", lastEventAt: ago(2000) }),
				proj,
				NOW,
			),
		];
		const s = sectionize(items);
		expect(s.map((x) => x.bucket)).toEqual(["attention", "working", "recent", "quiet"]);
		expect(s[0]?.items.map((i) => i.cid)).toEqual(["e", "d"]);
	});
	it("archived conversations appear only while live again (the Chat 'Active' set)", () => {
		expect(visibleInSwitcher(conv({ archivedAt: ago(1000), status: "ended" }), NOW)).toBe(false);
		expect(visibleInSwitcher(conv({ archivedAt: ago(1000), status: "running" }), NOW)).toBe(true);
		expect(visibleInSwitcher(conv(), NOW)).toBe(true);
	});
	it("search matches every term against the title or the project name", () => {
		const i = toItem(conv({ title: "Refactor auth flow" }), proj, NOW);
		expect(matches(i, "")).toBe(true);
		expect(matches(i, "AUTH")).toBe(true);
		expect(matches(i, "auth my-proj")).toBe(true);
		expect(matches(i, "auth docs")).toBe(false);
		// One rule across title, project and extra names (its agents).
		expect(matches(i, "auth explore", ["Explore"])).toBe(true);
		expect(matches(i, "auth plan", ["Explore"])).toBe(false);
	});
});

describe("loadProjects — bounded, per-project failures, never a fake empty list", () => {
	const projects = [
		{ sessionId: "s1", name: "one" },
		{ sessionId: "s2", name: "two" },
		{ sessionId: "s3", name: "three" },
		{ sessionId: "s4", name: "four" },
	];

	it("never runs more than `concurrency` requests at once", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchList: FetchList = async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return { ok: true, conversations: [] };
		};
		const seen: Project[] = [];
		await loadProjects(projects, fetchList, (p) => seen.push(p), { concurrency: 2 });
		expect(peak).toBe(2);
		expect(seen).toHaveLength(4);
	});

	it("a 429, an error and a throw fail only their project; the rest load", async () => {
		const fetchList: FetchList = async (sid) => {
			if (sid === "s1") return { ok: false, status: 429, error: "Too many requests" };
			if (sid === "s2") return { ok: false, status: 500, error: "Internal server error" };
			if (sid === "s3") throw new Error("Failed to fetch");
			return { ok: true, conversations: [conv()] };
		};
		const seen = new Map<string, Project>();
		await loadProjects(projects, fetchList, (p) => seen.set(p.sessionId, p));
		expect(seen.get("s1")?.state).toMatchObject({ kind: "error", reason: "rate-limited" });
		expect(seen.get("s2")?.state).toMatchObject({ kind: "error", reason: "failed" });
		expect(seen.get("s3")?.state).toMatchObject({ kind: "error", reason: "failed" });
		expect(seen.get("s4")?.state).toMatchObject({ kind: "ok" });
	});

	it("a request that does not answer in time is a timeout, not an empty project", async () => {
		vi.useFakeTimers();
		try {
			const fetchList: FetchList = (_sid, signal) =>
				new Promise((_res, rej) =>
					signal.addEventListener("abort", () => rej(new Error("aborted"))),
				);
			const seen: Project[] = [];
			const done = loadProjects(projects.slice(0, 1), fetchList, (p) => seen.push(p), {
				timeoutMs: 100,
			});
			await vi.advanceTimersByTimeAsync(150);
			await done;
			expect(seen[0]?.state).toEqual({ kind: "error", reason: "timeout", detail: "" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("a closed switcher stops starting requests and reports nothing more", async () => {
		let cancelled = false;
		const started: string[] = [];
		const fetchList: FetchList = async (sid) => {
			started.push(sid);
			cancelled = true;
			return { ok: true, conversations: [] };
		};
		const seen: Project[] = [];
		await loadProjects(projects, fetchList, (p) => seen.push(p), {
			concurrency: 1,
			isCancelled: () => cancelled,
		});
		expect(started).toEqual(["s1"]);
		expect(seen).toEqual([]);
	});

	it("the first load and later retries share the same slots", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchList: FetchList = async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return { ok: true, conversations: [] };
		};
		const loader = new ProjectLoader(fetchList, () => {}, { concurrency: 2 });
		await Promise.all([loader.load(projects.slice(0, 2)), loader.load(projects.slice(2))]);
		expect(peak).toBe(2);
	});

	it("a request's time limit starts when it gets its slot, not while it waits", async () => {
		vi.useFakeTimers();
		try {
			const fetchList: FetchList = (sid) =>
				new Promise((res) =>
					setTimeout(() => res({ ok: true, conversations: [] }), sid === "s1" ? 80 : 10),
				);
			const seen: Project[] = [];
			const done = loadProjects(projects.slice(0, 2), fetchList, (p) => seen.push(p), {
				concurrency: 1,
				timeoutMs: 100,
			});
			await vi.advanceTimersByTimeAsync(200);
			await done;
			expect(seen.map((p) => p.state.kind)).toEqual(["ok", "ok"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a list whose names/archive state could not be read is marked, not hidden", async () => {
		const fetchList: FetchList = async () => ({
			ok: true,
			conversations: [conv()],
			meta: "unavailable",
		});
		const seen: Project[] = [];
		await loadProjects(projects.slice(0, 1), fetchList, (p) => seen.push(p));
		expect(seen[0]?.state).toMatchObject({ kind: "ok", metaUnavailable: true });
	});
});
