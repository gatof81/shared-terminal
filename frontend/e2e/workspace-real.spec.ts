import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { AGENT_IDS, PROJECT_IDS, PROJECT_SESSION_IDS, SESSION_IDS } from "./mockBackend.js";

/**
 * The v3 workspace against the REAL D1 backend — not the mock. The
 * project-conversation routes (and the capture read of a reply's text) are
 * forwarded to backend/src/projects/conversation/e2eHarness.testutil.ts:
 * the real store, fan-out (§3), reply watcher (§4.1), owner_ack (§4.3),
 * Express routes and requireAuth. Faked there, as other subsystems: the D1
 * directory, the agents' captures and the Composer's answers (scripted per
 * session). Everything else (login, sessions, the agent directory) is the
 * usual mock. Needs backend/node_modules (CI installs both workspaces).
 */

const PID = PROJECT_IDS.hz;
const projectHash = `#/projects/${PID}`;
const ARCH = { agentId: AGENT_IDS.architect, sessionId: PROJECT_SESSION_IDS.architect };
const DEV = { agentId: AGENT_IDS.developer, sessionId: SESSION_IDS.running };

interface Harness {
	proc: ChildProcess;
	base: string;
	token: string;
}

async function startHarness(): Promise<Harness> {
	const proc = spawn("npx", ["tsx", "src/projects/conversation/e2eHarness.testutil.ts"], {
		cwd: join(process.cwd(), "..", "backend"),
		env: {
			...process.env,
			HARNESS_CONFIG: JSON.stringify({
				projectId: PID,
				ownerUserId: "u-alice",
				username: "alice",
				agents: [ARCH, DEV],
				settleMs: 400,
			}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let err = "";
	proc.stderr?.on("data", (d) => {
		err += String(d);
	});
	const first = await new Promise<string>((resolve, reject) => {
		let out = "";
		const t = setTimeout(() => reject(new Error(`harness did not start: ${err}`)), 60_000);
		proc.stdout?.on("data", (d) => {
			out += String(d);
			const nl = out.indexOf("\n");
			if (nl >= 0) {
				clearTimeout(t);
				resolve(out.slice(0, nl));
			}
		});
		proc.on("exit", (code) => reject(new Error(`harness exited ${code}: ${err}`)));
	});
	const { port, token } = JSON.parse(first) as { port: number; token: string };
	return { proc, base: `http://127.0.0.1:${port}`, token };
}

function running(h: Harness | undefined): Harness {
	if (!h) throw new Error("harness not started");
	return h;
}

async function control(hh: Harness | undefined, path: string, body: unknown): Promise<void> {
	const h = running(hh);
	const r = await fetch(`${h.base}/__harness/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(r.ok, `${path}: ${r.status}`).toBe(true);
}

async function realLog(h: Harness | undefined): Promise<Array<Record<string, unknown>>> {
	return (await fetch(`${running(h).base}/__harness/log`)).json();
}

const cards = (page: Page) =>
	page.locator("#project-view .tw-foryou").filter({ visible: true }).locator(".tw-card");
const composer = (page: Page) =>
	page.locator("#project-view .tw-composer").filter({ visible: true });

let h: Harness | undefined;

test.describe("workspace — against the real D1 backend", () => {
	test.skip(({ shell }) => shell === "v2", "the v1/v2 shell doesn't change this path; desktop + mobile suffice");

	test.beforeEach(async ({ backend }) => {
		const harness = await startHarness();
		h = harness;
		backend.enableProjects();
		backend.projectConversation = true; // the mock's flag; its own log stays unused
		const forward = /^\/projects\/[^/]+\/conversation\/|^\/sessions\/[^/]+\/conversations\/[^/]+\/events\/\d+(\?|$)/;
		backend.override = async (_method, path, route) => {
			if (!forward.test(path)) return false;
			if (path.startsWith("/sessions/") && ![ARCH.sessionId, DEV.sessionId].some((s) => path.includes(s)))
				return false;
			const req = route.request();
			const u = new URL(req.url());
			const response = await route.fetch({
				url: `${harness.base}${u.pathname}${u.search}`,
				headers: { ...req.headers(), cookie: `st_token=${harness.token}` },
			});
			await route.fulfill({ response });
			return true;
		};
	});

	test.afterEach(() => {
		// Also runs for a skipped test, which never started a harness.
		h?.proc.kill("SIGTERM");
		h = undefined;
	});

	test("a task to two agents: accepted, one delivered and one busy — each result from the real fan-out", async ({
		app,
		page,
	}) => {
		await control(h, "composer", { sessionId: DEV.sessionId, answers: [{ status: 409, error: "busy" }] });
		await app.login("alice", `${projectHash}/new`);
		const c = composer(page);
		for (const name of [/architect-hz/, /^@developer-hz(?!-2)/]) {
			await c.locator(".tw-chip-add").click();
			await c.getByRole("option", { name }).click();
		}
		await c.locator("textarea").fill("Review the CSP, both of you");
		await c.getByRole("button", { name: "Send" }).click();
		await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
		const row = page.locator("#project-view .tw-row-me").last();
		await expect(row.locator(".tw-del")).toHaveText([
			"@architect-hz · Delivered ✓",
			"@developer-hz · Not delivered: it was busy",
		]);
		await expect(row.locator(".tw-partial")).toHaveText(
			"Not every agent received this: 1 of 2 received it, 1 not delivered.",
		);
		// The real log has exactly one message and the busy one was never sent.
		const log = await realLog(h);
		expect(log.filter((l) => l.ev === "message")).toHaveLength(1);
		const devStates = log.filter((l) => l.ev === "delivery" && l.agent_id === DEV.agentId).map((l) => l.state);
		expect(devStates.at(-1)).toBe("refused");
	});

	test("a reply: confirming during the real settle window, then the verified text; Reply… only answers it if delivered", async ({
		app,
		page,
	}) => {
		await app.login("alice", `${projectHash}/new`);
		const c = composer(page);
		await c.locator(".tw-chip-add").click();
		await c.getByRole("option", { name: /architect-hz/ }).click();
		await c.locator("textarea").fill("Audit the backups");
		await c.getByRole("button", { name: "Send" }).click();
		await expect(page).toHaveURL(/\/threads\//);
		await control(h, "turn_end", { sessionId: ARCH.sessionId, text: "Backups verified: 3 of 3." });
		const timeline = page.locator("#project-view .tw-timeline");
		// The thread polls every 5 s; the settle window is 400 ms here — either
		// the confirming row or the reply itself is what a poll can land on.
		await expect(timeline.locator(".tw-bubble-agent").last()).toHaveText("Backups verified: 3 of 3.", {
			timeout: 15_000,
		});
		await expect(timeline.getByRole("button", { name: "Reply…" })).toBeVisible({ timeout: 15_000 });
		// The quote goes to a busy architect: refused ⇒ the reply stays pending.
		await control(h, "composer", { sessionId: ARCH.sessionId, answers: [{ status: 409, error: "busy" }] });
		await timeline.getByRole("button", { name: "Reply…" }).click();
		await composer(page).locator("textarea").fill("Thanks, also check the NAS copy.");
		await composer(page).getByRole("button", { name: "Send" }).click();
		await expect(composer(page).locator(".tw-results li")).toHaveText([
			"@architect-hz · Not delivered: it was busy",
		]);
		await page.goto(`/${projectHash}`);
		await expect(cards(page).filter({ hasText: "@architect-hz replied to you" })).toBeVisible({
			timeout: 10_000,
		});
		// Delivered this time: only now is the reply answered.
		await page.goto(`/${projectHash}`);
		await cards(page).filter({ hasText: "@architect-hz replied to you" }).locator("a").first().click();
		await page.locator("#project-view .tw-timeline").getByRole("button", { name: "Reply…" }).click();
		await composer(page).locator("textarea").fill("Thanks, also check the NAS copy.");
		await composer(page).getByRole("button", { name: "Send" }).click();
		await expect(composer(page).locator(".tw-results li")).toHaveText(["@architect-hz · Delivered ✓"]);
		await page.goto(`/${projectHash}`);
		await expect(cards(page).filter({ hasText: "@architect-hz replied to you" })).toHaveCount(0, {
			timeout: 10_000,
		});
		// The real log carries the quote_ref on both follow-ups.
		const quoted = (await realLog(h)).filter((l) => l.ev === "message" && l.quote_ref);
		expect(quoted).toHaveLength(2);
	});

	test("Done writes a real owner_ack; a fresh page reads it from the log", async ({ app, page }) => {
		await control(h, "composer", { sessionId: DEV.sessionId, answers: [{ status: 409, error: "busy" }] });
		await app.login("alice", `${projectHash}/new`);
		const c = composer(page);
		await c.locator(".tw-chip-add").click();
		await c.getByRole("option", { name: /^@developer-hz(?!-2)/ }).click();
		await c.locator("textarea").fill("Bump the version");
		await c.getByRole("button", { name: "Send" }).click();
		await expect(page).toHaveURL(/\/threads\//);
		await page.goto(`/${projectHash}`);
		const card = cards(page).filter({ hasText: "Not delivered to @developer-hz" });
		await card.getByRole("button", { name: /Done/ }).click();
		await expect(card).toHaveCount(0);
		const acks = (await realLog(h)).filter((l) => l.ev === "owner_ack");
		expect(acks).toHaveLength(1);
		expect(acks[0]!.target).toMatchObject({ agent_id: DEV.agentId });
		await page.reload();
		await expect(page.locator("#project-view .tw-thread-row").filter({ visible: true })).toHaveCount(1);
		await expect(cards(page).filter({ hasText: "Not delivered to @developer-hz" })).toHaveCount(0);
	});
});
