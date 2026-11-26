// The frontend's request budget on a project's topic (each request is rows
// read from D1): one feed per opening, one shared /acp/agents read for the
// rail and the thread (one 15 s clock, one read per frame), nothing while
// the tab is hidden and one batch when it shows, and everything read again
// after a real reconnect. The page's clock RUNS here (installed): the
// fixture's fixed `Date.now()` would freeze every age the feeds judge by.
//
// ACP_COUNTS=1 prints the per-endpoint tallies (the PR's before/after).

import type { Page } from "@playwright/test";
import { expect, FIXED_NOW, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const topic = (id: string) => `#/projects/${HZ}/c/${id}`;
const THREAD = "#project-view .ps-topic .acp-chat-thread";
const FEED = (id: string) => `/acp/conversations/${id}/feed`;
const TOPICS = `/acp/projects/${HZ}/conversations`;

/** GET requests by path (no query) since index `from`. */
function tally(backend: MockBackend, from = 0): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of backend.requests.slice(from)) {
		if (r.method !== "GET") continue;
		const p = r.path.split("?")[0]!;
		out[p] = (out[p] ?? 0) + 1;
	}
	return out;
}

function report(label: string, t: Record<string, number>): void {
	if (process.env.ACP_COUNTS) console.log(`[counts] ${label}: ${JSON.stringify(t)}`);
}

/** `ms` of the page's clock, in steps its fetches can answer between. */
async function run(page: Page, ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= 500) {
		await page.clock.runFor(Math.min(500, left));
		await page.waitForTimeout(10);
	}
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
	await page.evaluate((h) => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => (h ? "hidden" : "visible"),
		});
		document.dispatchEvent(new Event("visibilitychange"));
	}, hidden);
}

test.describe("a topic's request budget (clock running)", { tag: "@any-viewport" }, () => {
	test.beforeEach(async ({ backend, page }) => {
		backend.enableConversations();
		await page.clock.install({ time: new Date(FIXED_NOW) });
	});

	/** A direct link to «Rediseño de UI/UX», its first load settled (its read mark included). */
	async function land(app: { login: (u: "alice", h: string) => Promise<void> }, page: Page) {
		await app.login("alice", topic(CONV_IDS.ui));
		await expect(page.locator(THREAD)).toContainText("¿qué falta del prototipo?");
		await run(page, 5_000);
	}

	test("a direct link to a topic: one feed, one list of topics, one inbox", async ({
		app,
		backend,
		page,
	}) => {
		// A topic with nothing unread: no read mark (whose frame re-reads the counts).
		backend.addAcpMessage({
			to_id: "dev",
			body: "@dev el esquema",
			state: "done",
			result_text: "Listo.",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
		});
		backend.acpConversations.find((c) => c.id === CONV_IDS.backend)!.readAt = FIXED_NOW;
		await app.login("alice", topic(CONV_IDS.backend));
		await expect(page.locator(THREAD)).toContainText("Listo.");
		await run(page, 5_000);
		const t = tally(backend);
		report("direct link to a topic (first 5 s)", t);
		expect(t["/acp/agents"]).toBe(1);
		expect(t[FEED(CONV_IDS.backend)]).toBe(1);
		expect(t[TOPICS]).toBe(1);
		expect(t["/acp/inbox"]).toBe(1);
	});

	test("(a) opening a topic with the socket up: one feed", async ({ app, backend, page }) => {
		await land(app, page);
		// Out of the project (the thread stops following; the inbox keeps the socket up)…
		const before = tally(backend)["/sessions"] ?? 0;
		await page.evaluate((h) => {
			location.hash = h;
		}, `#/sessions/${PROJECT_SESSION_IDS.scratch}`);
		await expect(page.locator(THREAD)).toBeHidden();
		// The session list, slowed while the project covered it, is read at once.
		await run(page, 500);
		expect(tally(backend)["/sessions"]).toBe(before + 1);
		await run(page, 6_000);
		// …and back into another topic: its thread subscribes again.
		const from = backend.requests.length;
		await page.evaluate((h) => {
			location.hash = h;
		}, topic(CONV_IDS.backend));
		await expect(page).toHaveURL(new RegExp(`/c/${CONV_IDS.backend}$`));
		await run(page, 3_000);
		const t = tally(backend, from);
		report("open a topic from a session (3 s)", t);
		expect(t[FEED(CONV_IDS.backend)]).toBe(1);
		expect(t[TOPICS]).toBe(1);
	});

	test("(b) 30 s quiet in a topic: at most 2 reads of the agents", async ({
		app,
		backend,
		page,
	}) => {
		await land(app, page);
		const from = backend.requests.length;
		await run(page, 30_000);
		const t = tally(backend, from);
		report("30 s quiet in a topic", t);
		expect(t["/acp/agents"] ?? 0).toBeLessThanOrEqual(2);
		expect(t["/acp/agents"] ?? 0).toBeGreaterThanOrEqual(1);
	});

	test("(c) a message frame: one read of the agents for the rail and the thread", async ({
		app,
		backend,
		page,
	}) => {
		await land(app, page);
		// Past the period's next read, so it does not fall in the window.
		const from = backend.requests.length;
		backend.pushAcp({
			type: "message",
			message: backend.addAcpMessage({
				to_id: "arq",
				body: "@arq una pregunta más",
				project_id: HZ,
				conversation_id: CONV_IDS.ui,
			}),
		});
		await expect(page.locator(THREAD)).toContainText("una pregunta más");
		await run(page, 2_000);
		const t = tally(backend, from);
		report("one message frame (2 s)", t);
		expect(t["/acp/agents"]).toBe(1);
	});

	test("(d) hidden: frames make no request; one batch when it shows", async ({
		app,
		backend,
		page,
	}) => {
		await land(app, page);
		await setHidden(page, true);
		const from = backend.requests.length;
		backend.pushAcp({
			type: "message",
			message: backend.addAcpMessage({
				to_id: "arq",
				body: "@arq mientras no mirás",
				project_id: HZ,
				conversation_id: CONV_IDS.ui,
			}),
		});
		backend.pushAcp({ type: "question", question: { id: 77, agent: "arq", state: "withdrawn" } });
		backend.pushAcp({ type: "agents" });
		await run(page, 20_000);
		report("hidden + 3 frames (20 s)", tally(backend, from));
		expect(tally(backend, from), "hidden").toEqual({});
		await setHidden(page, false);
		await run(page, 4_000);
		const t = tally(backend, from);
		report("hidden + 3 frames, then visible (4 s)", t);
		for (const [p, n] of Object.entries(t)) expect(n, p).toBe(1);
		expect(t["/acp/inbox"]).toBe(1);
		expect(t["/acp/agents"]).toBe(1);
		expect(t[TOPICS]).toBe(1);
		await expect(page.locator(THREAD)).toContainText("mientras no mirás");
	});

	test("(e) a reconnect (down → open) reads the feed, the rail and the inbox again", async ({
		app,
		backend,
		page,
	}) => {
		await land(app, page);
		const from = backend.requests.length;
		backend.dropAcpSockets();
		// The first retry is 1 s later; its hello re-reads.
		await run(page, 5_000);
		const t = tally(backend, from);
		report("down → open (5 s)", t);
		expect(t[FEED(CONV_IDS.ui)]).toBe(1);
		expect(t[TOPICS]).toBe(1);
		expect(t["/acp/inbox"]).toBe(1);
		expect(t["/acp/agents"]).toBe(1);
	});
});
