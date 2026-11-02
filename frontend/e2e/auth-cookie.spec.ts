import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Route } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * Race B at the HTTP level: a `POST /auth/logout` that answers AFTER the
 * next person's login carries a Set-Cookie that deletes `st_token`, and
 * browsers apply Set-Cookie in arrival order. The auth and list endpoints
 * are served by a REAL HTTP server (a Node `http` server this test starts)
 * whose logout answer is held until the test releases it; the browser's
 * real cookie jar is observed with `context.cookies()` and through the
 * Cookie header the server receives. The mock only forwards those
 * requests (with the jar's cookie) and relays the server's headers,
 * Set-Cookie included.
 */

class AuthServer {
	server: http.Server;
	base = "";
	held: { release: () => void } | null = null;
	holdNextLogout = false;
	seenCookies: string[] = [];

	constructor() {
		this.server = http.createServer((req, res) => void this.handle(req, res));
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		const { port } = this.server.address() as AddressInfo;
		this.base = `http://127.0.0.1:${port}`;
	}

	async stop(): Promise<void> {
		this.held?.release();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private user(req: http.IncomingMessage): string | null {
		const m = /(?:^|;\s*)st_token=([^;]+)/.exec(req.headers.cookie ?? "");
		return m ? decodeURIComponent(m[1]!) : null;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", this.base).pathname.replace(/^\/api/, "");
		const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(JSON.stringify(body));
		};
		if (path === "/auth/status") {
			json(200, {
				needsSetup: false,
				authenticated: this.user(req) !== null,
				isAdmin: false,
				isLead: false,
				resourceCaps: { cpuMaxCores: 4, memMaxMiB: 8192 },
			});
			return;
		}
		if (path === "/auth/login" && req.method === "POST") {
			let body = "";
			for await (const chunk of req) body += chunk;
			const { username } = JSON.parse(body || "{}") as { username: string };
			json(
				200,
				{ userId: `u-${username}`, isAdmin: false, isLead: false },
				{ "set-cookie": `st_token=${encodeURIComponent(username)}; Path=/; HttpOnly` },
			);
			return;
		}
		if (path === "/auth/logout" && req.method === "POST") {
			const answer = () => {
				if (res.writableEnded) return;
				res.writeHead(204, { "set-cookie": "st_token=; Path=/; HttpOnly; Max-Age=0" });
				res.end();
			};
			if (this.holdNextLogout) {
				this.holdNextLogout = false;
				this.held = { release: answer };
				return;
			}
			answer();
			return;
		}
		if (path.startsWith("/sessions")) {
			const u = this.user(req);
			this.seenCookies.push(u ?? "<none>");
			if (u === null) json(401, { error: "Unauthorized" });
			else json(200, []);
			return;
		}
		json(404, { error: `unmocked ${path}` });
	}
}

test.describe("auth cookie sequence (real HTTP server, real cookie jar)", () => {
	let server: AuthServer;

	test.beforeEach(async ({ backend, page }) => {
		server = new AuthServer();
		await server.start();
		const forward = async (path: string, route: Route) => {
			const req = route.request();
			// The Cookie header the browser would send, read from its own jar
			// for the page's origin.
			const jar = await page.context().cookies(page.url());
			const cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
			try {
				const upstream = await fetch(`${server.base}/api${path}`, {
					method: req.method(),
					headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
					body: req.method() === "POST" ? (req.postData() ?? "{}") : undefined,
				});
				const setCookie = upstream.headers.get("set-cookie");
				await route.fulfill({
					status: upstream.status,
					headers: {
						"content-type": upstream.headers.get("content-type") ?? "application/json",
						...(setCookie ? { "set-cookie": setCookie } : {}),
					},
					body: upstream.status === 204 ? "" : await upstream.text(),
				});
			} catch {
				/* the page aborted this request, or the test ended: nothing to apply */
			}
		};
		// Detached: a held logout keeps its route pending without holding the
		// page's actions, exactly like a slow server would.
		backend.override = async (_method, path, route) => {
			if (!/^\/(auth\/|sessions(\?|$))/.test(path)) return false;
			void forward(path, route);
			return true;
		};
		// The mock still answers the app's other endpoints (groups,
		// observables…); it must see a signed-in user or its 401s would fire
		// the session-expired path and log the page out on its own.
		backend.loginAs("alice");
		await page.goto("/");
	});

	test.afterEach(async () => {
		await server.stop();
	});

	test("a logout answering after the next login never deletes the new person's cookie", async ({
		page,
		context,
		backend,
	}) => {
		const cookie = async () =>
			(await context.cookies()).find((c) => c.name === "st_token")?.value ?? null;
		await expect(page.locator("#auth-view")).toBeVisible();
		await page.fill("#auth-username", "alice");
		await page.fill("#auth-password", "pw");
		await page.click("#auth-submit");
		await expect(page.locator("#app-view")).toBeVisible();
		await expect.poll(cookie).toBe("alice");

		// Alice's logout is held by the server; Bob signs in meanwhile. (The
		// v2 user menu and the v1 mobile sidebar both end in this button's
		// click, so dispatching it works on every layout.)
		server.holdNextLogout = true;
		await page.evaluate(() => document.getElementById("logout-btn")?.click());
		await expect(page.locator("#auth-view")).toBeVisible();
		await expect.poll(() => server.held !== null).toBe(true);
		backend.loginAs("bob");
		await page.fill("#auth-username", "bob");
		await page.fill("#auth-password", "pw");
		await page.click("#auth-submit");
		await expect(page.locator("#app-view")).toBeVisible({ timeout: 15_000 });
		await expect.poll(cookie).toBe("bob");

		// Alice's logout answer (a cookie-deleting Set-Cookie) lands now.
		server.held?.release();
		await page.waitForTimeout(500);
		expect(await cookie(), "the stale logout deleted the new login's cookie").toBe("bob");

		// The next list request reaches the server with Bob's cookie.
		const before = server.seenCookies.length;
		await page.evaluate(() => document.getElementById("sidebar-refresh-btn")?.click());
		await expect.poll(() => server.seenCookies.length).toBeGreaterThan(before);
		expect(server.seenCookies[server.seenCookies.length - 1]).toBe("bob");
		await expect(page.locator("#app-view")).toBeVisible();
	});
});
