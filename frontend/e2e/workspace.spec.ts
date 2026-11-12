import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { AGENT_IDS, type MockBackend, PROJECT_IDS, PROJECT_MSG_IDS } from "./mockBackend.js";

/**
 * Projects v3 workspace (teamView.ts) against the mock's project
 * conversation log (PROJECT_CONVERSATION.md §5). The mock seeds three
 * concurrent threads: "polling" (dev replied), "notes" (architect busy →
 * not delivered) and "backup" (architect replied, developer-hz-2
 * unconfirmed), plus the HZ directory's presence (designer-hz is at a
 * permission prompt, fresh hook evidence).
 */

const PID = PROJECT_IDS.hz;
const projectHash = `#/projects/${PID}`;
const threadHash = (id: string) => `${projectHash}/threads/${id}`;

const ws = (page: Page) => page.locator("#project-view .tw");
/** The For you list that is on screen (inline or in the right column). */
const forYou = (page: Page) => page.locator("#project-view .tw-foryou").filter({ visible: true });
const cards = (page: Page) => forYou(page).locator(".tw-card");
const threadRows = (page: Page) => page.locator("#project-view .tw-thread-row").filter({ visible: true });
const composer = (page: Page) => page.locator("#project-view .tw-composer").filter({ visible: true });

const conversationRequests = (backend: MockBackend) =>
	backend.requests.filter((r) => r.path.includes("/conversation/"));

async function noHorizontalScroll(page: Page): Promise<void> {
	const overflow = await page.locator("#project-view").evaluate((el) => el.scrollWidth - el.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);
	const body = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	expect(body).toBeLessThanOrEqual(0);
}

test.describe("workspace — flag off", () => {
	test("projectChat without projectConversation: the P3a page, no conversation request", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableProjects();
		await app.login("alice", projectHash);
		await expect(page.locator("#project-view .pv-agent").first()).toBeVisible();
		await expect(ws(page)).toHaveCount(0);
		// A v3 address degrades to the directory, never to an error.
		await page.goto(`/${threadHash(PROJECT_MSG_IDS.polling)}`);
		await expect(page.locator("#project-view .pv-agent").first()).toBeVisible();
		await page.waitForTimeout(400);
		expect(conversationRequests(backend)).toEqual([]);
	});
});

test.describe("workspace — flag on", () => {
	test.beforeEach(async ({ backend }) => {
		await backend.enableProjectConversation();
	});

	test("Now: agents with honest presence, For you by kind, threads newest first", async ({
		app,
		page,
	}) => {
		await app.login("alice", projectHash);
		await expect(ws(page)).toBeVisible();
		const agents = page.locator("#project-view .tw-agent");
		await expect(agents.filter({ hasText: "designer-hz" })).toContainText("Needs you");
		await expect(agents.filter({ hasText: /^.*developer-hz(?!-2)/ }).first()).toContainText("Working");
		// For you: the permission (presence) first, then the log's items.
		await expect(cards(page).first()).toContainText("@designer-hz is asking for permission");
		await expect(cards(page).filter({ hasText: "@developer-hz replied to you" })).toContainText(
			"Done: adaptive cadence",
		);
		await expect(cards(page).filter({ hasText: "@architect-hz replied to you" })).toContainText(
			"Backups verified",
		);
		await expect(cards(page).filter({ hasText: "Not delivered to @architect-hz" })).toContainText(
			"it was busy",
		);
		await expect(cards(page).filter({ hasText: "Not sure it arrived · @developer-hz-2" })).toBeVisible();
		await expect(cards(page)).toHaveCount(5);
		// Threads: the newest activity first; each says its latest fact.
		await expect(threadRows(page).locator("b")).toHaveText([
			"Check the VM backups",
			"Make the project page poll adaptively",
			"Write the release notes",
		]);
		await expect(threadRows(page).nth(2)).toContainText("Not delivered to @architect-hz");
		await noHorizontalScroll(page);
	});

	test("a reply is shown only when its text hashes to the log's report_sha256", async ({
		app,
		backend,
		page,
	}) => {
		// Tamper with the capture behind the dev's reply: the log's hash no longer matches.
		for (const [k, v] of backend.projectCaptures)
			if (String((v.data as { last_assistant_message: string }).last_assistant_message).startsWith("Done"))
				backend.projectCaptures.set(k, { ...v, data: { last_assistant_message: "Something else" } });
		await app.login("alice", threadHash(PROJECT_MSG_IDS.polling));
		const timeline = page.locator("#project-view .tw-timeline");
		await expect(timeline).toContainText("doesn't match what was recorded");
		await expect(timeline).not.toContainText("Something else");
	});

	test("Reply… on a reply quotes exactly it; sending clears only that card, everywhere", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", threadHash(PROJECT_MSG_IDS.polling));
		const timeline = page.locator("#project-view .tw-timeline");
		await expect(timeline.locator(".tw-bubble-agent")).toHaveText(
			"Done: adaptive cadence, timer stopped on logout. 628 tests pass.",
		);
		await timeline.getByRole("button", { name: "Reply…" }).click();
		const c = composer(page);
		await expect(c.locator(".tw-chip").first()).toContainText("@developer-hz");
		await expect(c).toContainText("Replying to @developer-hz's reply");
		await expect(c.locator(".tw-hint")).toHaveText("Only @developer-hz will receive this.");
		await c.locator("textarea").fill("Thanks — also cover the hidden-tab case.");
		await c.getByRole("button", { name: "Send" }).click();
		await expect(timeline.locator(".tw-bubble-me").last()).toHaveText(
			"Thanks — also cover the hidden-tab case.",
		);
		const post = backend.projectMessagePosts.at(-1)!;
		expect(post.to).toEqual([AGENT_IDS.developer]);
		expect(post.inReplyTo).toBe(PROJECT_MSG_IDS.polling);
		expect(post.quoteRef).toMatchObject({ msgId: PROJECT_MSG_IDS.polling, agentId: AGENT_IDS.developer });
		// That card is gone; the architect's reply (another thread) stays.
		await page.goto(`/${projectHash}`);
		await expect(cards(page).filter({ hasText: "@architect-hz replied to you" })).toBeVisible();
		await expect(cards(page).filter({ hasText: "@developer-hz replied to you" })).toHaveCount(0);
	});

	test("one send to two agents: accepted, but each recipient has its own result", async ({
		app,
		backend,
		page,
	}) => {
		backend.projectSendOutcome.set(AGENT_IDS.developer, { state: "refused", reason: "busy" });
		await app.login("alice", `${projectHash}/new`);
		const c = composer(page);
		for (const name of [/architect-hz/, /^@developer-hz(?!-2)/]) {
			await c.locator(".tw-chip-add").click();
			await c.getByRole("option", { name }).click();
		}
		await expect(c.locator(".tw-hint")).toHaveText("Only @architect-hz, @developer-hz will receive this.");
		await c.locator("textarea").fill("Both of you: review the CSP");
		await c.getByRole("button", { name: "Send" }).click();
		await expect(page).toHaveURL(/\/threads\//);
		const row = page.locator("#project-view .tw-row-me").last();
		await expect(row.locator(".tw-partial")).toHaveText(
			"Not every agent received this: 1 of 2 received it, 1 not delivered.",
		);
		await expect(row.locator(".tw-del")).toHaveText([
			"@architect-hz · Delivered ✓",
			"@developer-hz · Not delivered: it was busy",
		]);
		await page.goto(`/${projectHash}`);
		await expect(
			cards(page).filter({ hasText: "Not delivered to @developer-hz" }).filter({ hasText: "Both of you" }),
		).toBeVisible();
	});

	test("a quote that wasn't delivered leaves the reply pending; a delivered one clears only it", async ({
		app,
		backend,
		page,
	}) => {
		backend.projectSendOutcome.set(AGENT_IDS.developer, { state: "refused", reason: "busy" });
		await app.login("alice", threadHash(PROJECT_MSG_IDS.polling));
		const timeline = page.locator("#project-view .tw-timeline");
		await timeline.getByRole("button", { name: "Reply…" }).click();
		await composer(page).locator("textarea").fill("Also the hidden-tab case.");
		await composer(page).getByRole("button", { name: "Send" }).click();
		await expect(page.locator("#project-view .tw-del").last()).toHaveText(
			"@developer-hz · Not delivered: it was busy",
		);
		await page.goto(`/${projectHash}`);
		// The reply is still pending, and the refused quote is its own item.
		await expect(cards(page).filter({ hasText: "@developer-hz replied to you" })).toBeVisible();
		await expect(cards(page).filter({ hasText: "Not delivered to @developer-hz" })).toBeVisible();
	});

	test("Done writes an owner_ack: the card stays gone after a reload (another device reads the same log)", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", projectHash);
		const card = cards(page).filter({ hasText: "@architect-hz replied to you" });
		await card.getByRole("button", { name: /Done/ }).click();
		await expect(card).toHaveCount(0);
		expect(backend.projectAckPosts.at(-1)).toMatchObject({
			target: { msgId: PROJECT_MSG_IDS.backup, agentId: AGENT_IDS.architect },
		});
		expect(typeof (backend.projectAckPosts.at(-1)!.target as { reportSha256?: unknown }).reportSha256).toBe(
			"string",
		);
		// A fresh page (no memory of the click) reads the ack from the log.
		await page.reload();
		await expect(cards(page).filter({ hasText: "@developer-hz replied to you" })).toBeVisible();
		await expect(cards(page).filter({ hasText: "@architect-hz replied to you" })).toHaveCount(0);
		// The other items of that thread are untouched.
		await expect(cards(page).filter({ hasText: "Not sure it arrived · @developer-hz-2" })).toBeVisible();
	});

	test("a reply in its settle window shows its text as confirming, not in For you", async ({
		app,
		backend,
		page,
	}) => {
		backend.projectTask("c3000000-0000-4000-8000-000000000001", [AGENT_IDS.developer], "Bump the version");
		await backend.projectReply("c3000000-0000-4000-8000-000000000001", AGENT_IDS.developer, "Bumped to 1.4.0.", "exact", {
			settleOnly: true,
		});
		await app.login("alice", threadHash("c3000000-0000-4000-8000-000000000001"));
		const row = page.locator("#project-view .tw-row-settling");
		await expect(row).toContainText("reply received, confirming…");
		await expect(row.locator(".tw-bubble-agent")).toHaveText("Bumped to 1.4.0.");
		await expect(row.getByRole("button", { name: "Reply…" })).toHaveCount(0);
		await page.goto(`/${projectHash}`);
		await expect(cards(page).filter({ hasText: "Bumped" })).toHaveCount(0);
	});

	test("live: a reply arrives over WS /ws/project faster than any poll", async ({ app, backend, page }) => {
		backend.projectTask("c4000000-0000-4000-8000-000000000001", [AGENT_IDS.developer], "Live check");
		await app.login("alice", threadHash("c4000000-0000-4000-8000-000000000001"));
		await expect(page.locator("#project-view .tw-main-title")).toHaveText("Live check");
		await expect.poll(() => backend.projectSockets.filter((s) => !s.closed && s.after !== null).length).toBe(1);
		await backend.projectReply("c4000000-0000-4000-8000-000000000001", AGENT_IDS.developer, "Live reply.");
		// The poll is 5 s (30 s while live): 2 s can only be the socket.
		await expect(page.locator("#project-view .tw-bubble-agent")).toHaveText("Live reply.", { timeout: 2_000 });
	});

	test("a refused project socket falls back to polling: the reply still arrives", async ({
		app,
		backend,
		page,
	}) => {
		backend.projectSocketsRefused = true;
		backend.projectTask("c4000000-0000-4000-8000-000000000002", [AGENT_IDS.developer], "Poll check");
		await app.login("alice", threadHash("c4000000-0000-4000-8000-000000000002"));
		await expect(page.locator("#project-view .tw-main-title")).toHaveText("Poll check");
		await backend.projectReply("c4000000-0000-4000-8000-000000000002", AGENT_IDS.developer, "Polled reply.");
		await expect(page.locator("#project-view .tw-bubble-agent")).toHaveText("Polled reply.", { timeout: 12_000 });
	});

	test("New task: @ opens the picker; only chosen agents receive it, typed @names don't", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `${projectHash}/new`);
		const c = composer(page);
		const text = c.locator("textarea");
		await expect(c.locator(".tw-hint")).toContainText("Nobody receives it until you choose agents");
		await text.pressSequentially("Review the diff with @arch");
		const picker = c.locator(".tw-picker");
		await expect(picker).toBeVisible();
		// The agent stopped at a permission prompt is offered but can't be chosen.
		await text.press("Backspace");
		await text.press("Backspace");
		await text.press("Backspace");
		await text.press("Backspace");
		await expect(picker.getByRole("option", { name: /designer-hz/ })).toBeDisabled();
		await text.pressSequentially("arch");
		await text.press("Enter");
		await expect(c.locator(".tw-chip").first()).toContainText("@architect-hz");
		await expect(text).toHaveValue("Review the diff with @architect-hz ");
		// Typed, not picked: plain text, no recipient.
		await text.pressSequentially("and tell @qa-hz");
		await text.press("Escape");
		await expect(c.locator(".tw-hint")).toHaveText("Only @architect-hz will receive this.");
		await c.getByRole("button", { name: "Send" }).click();
		await expect(page).toHaveURL(/\/threads\/c0000000-/);
		expect(backend.projectMessagePosts.at(-1)!.to).toEqual([AGENT_IDS.architect]);
		await expect(page.locator("#project-view .tw-main-title")).toHaveText(
			"Review the diff with @architect-hz and tell @qa-hz",
		);
		await expect(page.locator("#project-view .tw-del")).toHaveText("@architect-hz · Delivered ✓");
	});

	test("not delivered clears only when a later send in that thread reaches the agent", async ({
		app,
		page,
	}) => {
		await app.login("alice", threadHash(PROJECT_MSG_IDS.notes));
		await expect(page.locator("#project-view .tw-del")).toHaveText(
			"@architect-hz · Not delivered: it was busy",
		);
		const c = composer(page);
		await c.locator(".tw-chip-add").click();
		await c.getByRole("option", { name: /architect-hz/ }).click();
		await c.locator("textarea").fill("Write the release notes (again)");
		await c.getByRole("button", { name: "Send" }).click();
		await expect(page.locator("#project-view .tw-del").last()).toHaveText("@architect-hz · Delivered ✓");
		await page.goto(`/${projectHash}`);
		await expect(cards(page).filter({ hasText: "Not delivered to @architect-hz" })).toHaveCount(0);
	});

	test("a lost answer: Check re-asks with the same id and never sends twice", async ({
		app,
		backend,
		page,
	}) => {
		backend.loseNextMessageAnswer = true;
		await app.login("alice", `${projectHash}/new`);
		const c = composer(page);
		await c.locator(".tw-chip-add").click();
		await c.getByRole("option", { name: /architect-hz/ }).click();
		await c.locator("textarea").fill("Rotate the deploy key");
		await c.getByRole("button", { name: "Send" }).click();
		await expect(c.locator(".tw-send-status")).toContainText("it may or may not have been sent");
		await c.getByRole("button", { name: "Check" }).click();
		await expect(page).toHaveURL(/\/threads\//);
		const ids = backend.projectMessagePosts.map((p) => p.clientMessageId);
		expect(new Set(ids).size).toBe(1);
		expect(backend.projectLog.filter((e) => e.ev === "message" && e.text === "Rotate the deploy key")).toHaveLength(1);
	});

	test("history: a late reply to an old task lands in its own thread, older pages on demand", async ({
		app,
		backend,
		page,
	}) => {
		// A small page: the old task is far outside the newest page.
		backend.projectLog = [];
		backend.projectTask(PROJECT_MSG_IDS.old, [AGENT_IDS.architect], "Old task: audit the CSP");
		for (let i = 0; i < 6; i++)
			backend.projectTask(`c2000000-0000-4000-8000-00000000000${i}`, [AGENT_IDS.developer], `Filler task ${i}`);
		await backend.projectReply(PROJECT_MSG_IDS.old, AGENT_IDS.architect, "CSP audit done: 2 findings.");
		backend.projectPageCap = 5;
		await app.login("alice", projectHash);
		// The reply's original was fetched by id: the old thread exists, with its reply.
		const old = threadRows(page).filter({ hasText: "Old task: audit the CSP" });
		await expect(old).toBeVisible();
		await expect(cards(page).filter({ hasText: "@architect-hz replied to you" })).toContainText(
			"CSP audit done",
		);
		await old.click();
		await expect(page.locator("#project-view .tw-bubble-agent")).toHaveText("CSP audit done: 2 findings.");
		await page.goto(`/${projectHash}`);
		// Older threads come page by page.
		const earlier = page.getByRole("button", { name: "Earlier threads" }).filter({ visible: true });
		await expect(earlier).toBeVisible();
		const before = await threadRows(page).count();
		await earlier.click();
		await expect.poll(() => threadRows(page).count()).toBeGreaterThan(before);
	});
});

test.describe("workspace — attachments (D2)", () => {
	test.beforeEach(async ({ backend }) => {
		await backend.enableProjectConversation();
	});

	const artifactRequests = (backend: MockBackend) =>
		backend.requests.filter((r) => r.path.includes("/conversation/artifacts"));

	test("projectArtifacts absent: no Attach control and no request to …/artifacts", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `${projectHash}/new`);
		await expect(composer(page).locator("textarea")).toBeVisible();
		await expect(composer(page).getByRole("button", { name: "Attach file" })).toHaveCount(0);
		await page.waitForTimeout(300);
		expect(artifactRequests(backend)).toEqual([]);
	});

	test("attach a file from an agent's workspace, send it, open it in the thread", async ({
		app,
		backend,
		page,
	}) => {
		backend.projectArtifacts = true;
		await app.login("alice", `${projectHash}/new`);
		const c = composer(page);
		await c.getByRole("button", { name: "Attach file" }).click();
		const panel = c.getByRole("group", { name: "Attach a file" });
		await panel.getByRole("button", { name: "@architect-hz" }).click();
		// Protected files are listed but can't be chosen.
		await expect(panel.locator(".tw-attach-entry", { hasText: ".env" })).toBeDisabled();
		await panel.locator(".tw-attach-entry", { hasText: "src/" }).click();
		await panel.locator(".tw-attach-entry", { hasText: "auth.ts" }).click();
		await expect(c.locator(".tw-files .tw-file-chip")).toContainText("auth.ts");
		expect(backend.projectArtifactPosts.at(-1)).toEqual({
			agentId: AGENT_IDS.architect,
			path: "src/auth.ts",
		});
		await c.locator("textarea").fill("Apply this to your branch");
		await c.locator(".tw-chip-add").click();
		await c.getByRole("option", { name: /architect-hz/ }).click();
		await c.getByRole("button", { name: "Send" }).click();
		await expect(page).toHaveURL(/\/threads\/c0000000-/);
		const post = backend.projectMessagePosts.at(-1)!;
		expect(post.artifacts).toHaveLength(1);
		expect(String((post.artifacts as string[])[0])).toMatch(/^[0-9a-f]{64}$/);
		const file = page.locator("#project-view .tw-file-open");
		await expect(file).toHaveText(/auth\.ts · \d+ B/);
		await file.click();
		await expect(page.locator("#project-view .tw-file-text")).toContainText(
			"export function login(user: string)",
		);
		await expect(page.locator("#project-view .tw-del")).toHaveText("@architect-hz · Delivered ✓");
		await noHorizontalScroll(page);
	});

	test("a placement that failed says why, and that files may already be in the inbox", async ({
		app,
		backend,
		page,
	}) => {
		backend.projectArtifacts = true;
		backend.projectPlacementError.set(AGENT_IDS.architect, "exists-different");
		await app.login("alice", `${projectHash}/new`);
		const c = composer(page);
		await c.getByRole("button", { name: "Attach file" }).click();
		const panel = c.getByRole("group", { name: "Attach a file" });
		await panel.getByRole("button", { name: "@architect-hz" }).click();
		await panel.locator(".tw-attach-entry", { hasText: "README.md" }).click();
		await expect(c.locator(".tw-files .tw-file-chip")).toContainText("README.md");
		await c.locator("textarea").fill("Read this");
		await c.locator(".tw-chip-add").click();
		await c.getByRole("option", { name: /architect-hz/ }).click();
		await c.getByRole("button", { name: "Send" }).click();
		await expect(page).toHaveURL(/\/threads\/c0000000-/);
		await expect(page.locator("#project-view .tw-del")).toHaveText(
			"@architect-hz · Not delivered: a file couldn't be placed: a different file already has that name in its inbox. Some files may already be in its inbox.",
		);
	});
});

test.describe("workspace — layout", () => {
	test.beforeEach(async ({ backend }) => {
		await backend.enableProjectConversation();
	});

	test("one pane at a time on a narrow page; never a horizontal scroll", async ({ app, page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await app.login("alice", projectHash);
		await expect(page.locator("#project-view .tw-now")).toBeVisible();
		await expect(page.locator("#project-view .tw-main")).toBeHidden();
		await noHorizontalScroll(page);
		await threadRows(page).first().click();
		await expect(page.locator("#project-view .tw-main")).toBeVisible();
		await expect(page.locator("#project-view .tw-now")).toBeHidden();
		await noHorizontalScroll(page);
		await page.getByRole("link", { name: "Back to Now" }).click();
		await expect(page.locator("#project-view .tw-now")).toBeVisible();
		for (const sel of [".tw-new", ".tw-thread-row", ".tw-agent"]) {
			const box = await page.locator(`#project-view ${sel}`).first().boundingBox();
			expect(box!.height, sel).toBeGreaterThanOrEqual(44);
		}
	});

	test("columns really sit side by side (they stacked as rows: the container query styled its own container)", async ({
		app,
		page,
	}) => {
		const box = (sel: string) => page.locator(`#project-view ${sel}`).first().boundingBox();
		await page.setViewportSize({ width: 1280, height: 800 });
		await app.login("alice", threadHash(PROJECT_MSG_IDS.polling));
		await expect(page.locator("#project-view .tw-main .tw-timeline")).toBeVisible();
		let now = (await box(".tw-now"))!;
		let main = (await box(".tw-main"))!;
		expect(now.x + now.width).toBeLessThanOrEqual(main.x + 1);
		expect(Math.abs(now.y - main.y)).toBeLessThan(2);
		// The two rules base rules used to override: no "‹ Now" beside Now, and
		// "+ New task" leads the column instead of floating over its cards.
		await expect(page.locator("#project-view .tw-back")).toBeHidden();
		const newTask = (await box(".tw-new"))!;
		const firstAgent = (await box(".tw-agent"))!;
		expect(newTask.y + newTask.height).toBeLessThanOrEqual(firstAgent.y);
		// Both columns take the page's full height: the thread is not a strip.
		const page_ = (await box(""))!;
		expect(main.height).toBeGreaterThan(page_.height - 2);
		await page.setViewportSize({ width: 1700, height: 900 });
		await expect(page.locator("#project-view .tw-side")).toBeVisible();
		now = (await box(".tw-now"))!;
		main = (await box(".tw-main"))!;
		const side = (await box(".tw-side"))!;
		expect(now.x + now.width).toBeLessThanOrEqual(main.x + 1);
		expect(main.x + main.width).toBeLessThanOrEqual(side.x + 1);
		expect(Math.abs(side.y - main.y)).toBeLessThan(2);
		await noHorizontalScroll(page);
	});

	test("phone: For you's Done sits beside the card text, and the New task bar is on top of what scrolls under it", async ({
		app,
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await app.login("alice", projectHash);
		const card = cards(page).filter({ has: page.locator(".tw-done") }).first();
		await expect(card).toBeVisible();
		const text = (await card.locator(".tw-card-link").boundingBox())!;
		const done = (await card.locator(".tw-done").boundingBox())!;
		// Same row: the button is beside the text, not on a row of its own.
		expect(done.x).toBeGreaterThanOrEqual(text.x + text.width - 1);
		expect(done.y).toBeLessThan(text.y + text.height);
		expect(done.height).toBeGreaterThanOrEqual(44);
		// With a thread row (avatars on its left) scrolled under it, the bar is on
		// top across its whole width — those avatars once painted over it.
		let bar = (await page.locator("#project-view .tw-new").boundingBox())!;
		const row = page.locator("#project-view .tw-now .tw-thread-row").first();
		await page.locator("#project-view .tw-now").evaluate(
			(col, { y }) => {
				const r = col.querySelector(".tw-thread-row")!.getBoundingClientRect();
				col.scrollTop += r.top - y;
			},
			{ y: bar.y + bar.height / 2 - 20 },
		);
		bar = (await page.locator("#project-view .tw-new").boundingBox())!;
		const under = (await row.boundingBox())!;
		expect(under.y).toBeLessThan(bar.y + bar.height / 2);
		expect(under.y + under.height).toBeGreaterThan(bar.y + bar.height / 2);
		// Probe the bar's edges, its middle, and every avatar of that row.
		const avatarXs = await row
			.locator(".tw-av")
			.evaluateAll((avs) => avs.map((a) => a.getBoundingClientRect().x + 8));
		expect(avatarXs.length).toBeGreaterThan(0);
		const xs = [bar.x + 12, bar.x + bar.width / 2, bar.x + bar.width - 12, ...avatarXs];
		const onTop = await page.evaluate(
			({ y, xs }) => xs.map((x) => !!document.elementFromPoint(x, y)?.closest(".tw-new")),
			{ y: bar.y + bar.height / 2, xs },
		);
		expect(onTop).toEqual(xs.map(() => true));
		expect(bar.width).toBeGreaterThan(350);
	});

	test("wide page: For you moves to its own column; medium: it folds into Now", async ({ app, page }) => {
		await page.setViewportSize({ width: 1700, height: 900 });
		await app.login("alice", projectHash);
		await expect(page.locator("#project-view .tw-side .tw-foryou")).toBeVisible();
		await expect(page.locator("#project-view .tw-foryou-inline")).toBeHidden();
		await noHorizontalScroll(page);
		await page.setViewportSize({ width: 1100, height: 800 });
		await expect(page.locator("#project-view .tw-side")).toBeHidden();
		await expect(page.locator("#project-view .tw-foryou-inline")).toBeVisible();
		await noHorizontalScroll(page);
	});
});
