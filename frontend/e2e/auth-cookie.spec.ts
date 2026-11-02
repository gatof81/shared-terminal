import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { MockBackend } from "./mockBackend.js";

/**
 * Auth transitions against the browser's REAL network stack and cookie jar.
 *
 * The app's `/api/auth/*` and `/api/sessions` requests are not fulfilled by
 * Playwright: `route.continue({ url })` hands them back to Chromium, which
 * sends them to a real Node HTTP server started by the test, receives the
 * answer itself and applies its `Set-Cookie` itself — as in production.
 * Nothing relays headers or decides in JS whether a response "counts". The
 * server can hold an answer until the test releases it. Cookies are not
 * port-scoped, so the server's host-only `st_token` on `localhost` is the
 * page's cookie too; the `Cookie` header the server receives is the proof
 * of who the next request belongs to.
 */

type Holdable = "logout" | "sessions" | "status";

class AuthServer {
	private server = http.createServer((req, res) => void this.handle(req, res));
	base = "";
	private holdNext = new Set<Holdable>();
	private held = new Map<Holdable, (status?: number) => void>();
	/** What `GET /sessions` answers per signed-in user (default: none). */
	lists = new Map<string, unknown[]>();
	/** Arrival order of every request, with the cookie it carried. */
	log: Array<{ what: string; cookie: string | null }> = [];

	async start(): Promise<void> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		this.base = `http://localhost:${(this.server.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		for (const release of this.held.values()) release();
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	/** The next request of this kind is held until `release`. */
	hold(kind: Holdable): void {
		this.holdNext.add(kind);
	}

	isHeld(kind: Holdable): boolean {
		return this.held.has(kind);
	}

	release(kind: Holdable, status?: number): void {
		const r = this.held.get(kind);
		if (!r) throw new Error(`nothing held: ${kind}`);
		this.held.delete(kind);
		r(status);
	}

	received(what: string): number {
		return this.log.filter((l) => l.what === what).length;
	}

	lastCookie(what: string): string | null | undefined {
		return this.log.filter((l) => l.what === what).at(-1)?.cookie;
	}

	private user(req: http.IncomingMessage): string | null {
		const m = /(?:^|;\s*)st_token=([^;]+)/.exec(req.headers.cookie ?? "");
		return m ? decodeURIComponent(m[1]!) : null;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/api/, "");
		const user = this.user(req);
		let body = "";
		for await (const chunk of req) body += chunk;
		this.log.push({ what: `${req.method} ${path}`, cookie: user });
		const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(JSON.stringify(payload));
		};
		const maybeHold = async (kind: Holdable): Promise<number | undefined> => {
			if (!this.holdNext.delete(kind)) return undefined;
			return new Promise<number | undefined>((resolve) => this.held.set(kind, resolve));
		};
		if (path === "/auth/status") {
			await maybeHold("status");
			json(200, {
				needsSetup: false,
				authenticated: user !== null,
				isAdmin: user === "alice",
				isLead: false,
				resourceCaps: { cpuMaxCores: 8, memMaxMiB: 16384 },
			});
			return;
		}
		if (path === "/auth/login" && req.method === "POST") {
			const { username } = JSON.parse(body || "{}") as { username: string };
			json(
				200,
				{ userId: `u-${username}`, isAdmin: username === "alice", isLead: false },
				{
					"set-cookie": `st_token=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Strict`,
				},
			);
			return;
		}
		if (path === "/auth/logout" && req.method === "POST") {
			await maybeHold("logout");
			// What backend clearAuthCookie sends: an unconditional delete.
			res.writeHead(204, {
				"set-cookie":
					"st_token=; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
			});
			res.end();
			return;
		}
		if (path === "/sessions") {
			const forced = await maybeHold("sessions");
			if (forced !== undefined)
				return json(forced, forced === 200 ? [] : { error: "Unauthorized" });
			if (user === null) return json(401, { error: "Unauthorized" });
			return json(200, this.lists.get(user) ?? []);
		}
		json(404, { error: `unserved ${path}` });
	}
}

const backendClass = () => MockBackend;

const REAL = /^\/(auth\/(status|login|logout)|sessions)(\?|$)/;

function wire(backend: MockBackend, server: AuthServer): void {
	backend.override = async (_method: string, path: string, route: Route) => {
		if (!REAL.test(path)) return false;
		// Back to the browser's own network stack, aimed at the real server.
		await route.continue({ url: `${server.base}/api${path}` });
		return true;
	};
	// The other endpoints (groups, quotas…) stay on the mock, which must see
	// someone signed in or its 401s would fire the session-expired path.
	backend.loginAs("alice");
}

const tokenOf = async (context: BrowserContext): Promise<string | null> =>
	(await context.cookies()).find((c) => c.name === "st_token")?.value ?? null;

async function signIn(page: Page, user: string): Promise<void> {
	await expect(page.locator("#auth-view")).toBeVisible();
	await page.fill("#auth-username", user);
	await page.fill("#auth-password", "pw");
	await page.click("#auth-submit");
}

test.describe("auth transitions on the real cookie jar", () => {
	let server: AuthServer;
	test.beforeEach(async ({ backend, page }) => {
		server = new AuthServer();
		await server.start();
		wire(backend, server);
		await page.goto("/");
	});
	test.afterEach(async ({ page: _page }, testInfo) => {
		if (testInfo.status !== testInfo.expectedStatus) {
			console.log(`AUTH-SERVER log: ${JSON.stringify(server.log)}`);
		}
		await server.stop();
	});

	test("a logout answering after the next login never deletes the new person's cookie", async ({
		app,
		page,
		context,
		backend,
	}) => {
		await signIn(page, "alice");
		await expect(page.locator("#app-view")).toBeVisible();
		await expect.poll(() => tokenOf(context)).toBe("alice");

		// Alice's logout reaches the server, whose answer (the cookie delete) is held.
		server.hold("logout");
		await app.appMenu("logout-btn");
		await expect(page.locator("#auth-view")).toBeVisible();
		await expect.poll(() => server.isHeld("logout")).toBe(true);

		// Bob signs in on the same tab meanwhile.
		backend.loginAs("bob");
		await page.fill("#auth-username", "bob");
		await page.fill("#auth-password", "pw");
		await page.locator("#auth-submit").click({ noWaitAfter: true });
		await page.waitForTimeout(1000);
		// Alice's delete lands now — after Bob's login was asked for.
		server.release("logout");
		await expect(page.locator("#app-view")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(500);

		expect(await tokenOf(context), "a stale logout deleted the new login's cookie").toBe("bob");
		const before = server.received("GET /sessions");
		await app.openSidebar();
		await page.click("#sidebar-refresh-btn");
		await expect.poll(() => server.received("GET /sessions")).toBeGreaterThan(before);
		expect(server.lastCookie("GET /sessions"), "the next request is Bob's").toBe("bob");
		// The order the server saw: Alice's logout before Bob's login.
		const order = server.log.map((l) => l.what).filter((w) => w.startsWith("POST /auth/"));
		expect(order.slice(-2)).toEqual(["POST /auth/logout", "POST /auth/login"]);
		await expect(page.locator("#app-view")).toBeVisible();
	});

	test("a tab opened while another tab's logout is in flight does not sign in as the leaving account", async ({
		app,
		page,
		context,
	}) => {
		await signIn(page, "alice");
		await expect(page.locator("#app-view")).toBeVisible();
		await expect.poll(() => tokenOf(context)).toBe("alice");

		server.hold("logout");
		await app.appMenu("logout-btn");
		await expect.poll(() => server.isHeld("logout")).toBe(true);

		// The cross-tab ordering is the browser's Web Locks, not the in-page fallback.
		expect(await page.evaluate(() => typeof navigator.locks?.request)).toBe("function");
		// A second tab of the same browser (same cookie jar) opens now.
		const other = await context.newPage();
		const otherBackend = new (backendClass())();
		wire(otherBackend, server);
		await otherBackend.install(other);
		void other.goto("/");
		await other.waitForTimeout(1000);
		// Alice's cookie is still in the jar until her logout answers; the
		// new tab must not have shown her app meanwhile.
		await expect(
			other.locator("#app-view"),
			"the new tab signed in as the leaving account",
		).toBeHidden();
		expect(
			server.lastCookie("GET /auth/status") ?? null,
			"a status probe rode Alice's cookie",
		).toBe(null);
		server.release("logout");
		await expect(other.locator("#auth-view"), "the new tab shows the login form").toBeVisible({
			timeout: 15_000,
		});
		await expect(other.locator("#app-view")).toBeHidden();
		await expect(other.locator("#toast .toast-item", { hasText: "expired" })).toHaveCount(0);
		expect(await tokenOf(context)).toBe(null);
	});

	test("a 401 answering for the previous account does not sign the new one out", async ({
		app,
		page,
		context,
		backend,
	}) => {
		await signIn(page, "alice");
		await expect(page.locator("#app-view")).toBeVisible();
		await expect.poll(() => tokenOf(context)).toBe("alice");

		// A list request sent with Alice's cookie is held; it will answer 401.
		server.hold("sessions");
		await app.openSidebar();
		await page.click("#sidebar-refresh-btn");
		await expect.poll(() => server.isHeld("sessions")).toBe(true);

		await app.appMenu("logout-btn");
		await expect(page.locator("#auth-view")).toBeVisible();
		backend.loginAs("bob");
		await signIn(page, "bob");
		await expect(page.locator("#app-view")).toBeVisible();
		await expect.poll(() => tokenOf(context)).toBe("bob");

		const logoutsBefore = server.received("POST /auth/logout");
		server.release("sessions", 401);
		await page.waitForTimeout(1000);
		await expect(page.locator("#app-view"), "Bob was signed out by Alice's 401").toBeVisible();
		await expect(page.locator("#toast .toast-item", { hasText: "expired" })).toHaveCount(0);
		expect(server.received("POST /auth/logout")).toBe(logoutsBefore);
		expect(await tokenOf(context)).toBe("bob");
	});

	test("a 401 for the current account still signs it out, once", async ({ app, page, context }) => {
		await signIn(page, "alice");
		await expect(page.locator("#app-view")).toBeVisible();
		await expect.poll(() => tokenOf(context)).toBe("alice");

		const logoutsBefore = server.received("POST /auth/logout");
		server.hold("sessions");
		await app.openSidebar();
		await page.click("#sidebar-refresh-btn");
		await expect.poll(() => server.isHeld("sessions")).toBe(true);
		server.release("sessions", 401);
		await expect(page.locator("#auth-view")).toBeVisible();
		await expect(page.locator("#toast .toast-item", { hasText: "expired" })).toHaveCount(1);
		await expect.poll(() => server.received("POST /auth/logout")).toBe(logoutsBefore + 1);
		await expect.poll(() => tokenOf(context)).toBe(null);
	});
	test("a /auth/status answering after the next login does not overwrite the new identity", async ({
		app,
		page,
		backend,
	}) => {
		await signIn(page, "alice");
		await expect(page.locator("#app-view")).toBeVisible();
		await app.appMenu("logout-btn");
		await expect(page.locator("#auth-view")).toBeVisible();

		// On the login screen a status probe goes out (entering register mode
		// re-reads needsSetup) and its answer is held.
		server.hold("status");
		await page.click("#auth-toggle-link");
		await expect.poll(() => server.isHeld("status")).toBe(true);
		await page.click("#auth-toggle-link"); // back to login, no probe

		const bobSession = backend.sessions.find((x) => x.ownerUserId === "u-bob")!;
		server.lists.set("bob", [backend.serialize(bobSession)]);
		backend.loginAs("bob");
		await page.fill("#auth-username", "bob");
		await page.fill("#auth-password", "pw");
		await page.locator("#auth-submit").click({ noWaitAfter: true });
		await page.waitForTimeout(1000);
		// The probe's answer ("not signed in") lands now.
		server.release("status");
		await expect(page.locator("#app-view")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(500);

		// Bob is still Bob for the app: a new session of his appears on refresh.
		server.lists.set("bob", [
			backend.serialize(bobSession),
			{
				...backend.serialize(bobSession),
				sessionId: "00000000-0000-4000-8000-0000000000b2",
				name: "bob-new",
			},
		]);
		await app.openSidebar();
		await page.click("#sidebar-refresh-btn");
		await expect(
			app.sessionRow("bob-new"),
			"a stale status answer signed the mirror out",
		).toBeVisible();
		expect(await tokenOf(page.context())).toBe("bob");
	});
});
