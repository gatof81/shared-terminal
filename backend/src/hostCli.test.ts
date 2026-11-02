/**
 * The host CLIs' production wiring (`hostDeps` of recreate/adminCli.ts and
 * conversation/composerCli.ts): both run in their own process, so they must
 * validate the JWT secret themselves before signing — on VM100 (2026-10-31)
 * every verb died with "jwtSecret() called before validateJwtSecret()".
 * Positive: with a secret in the env, `hostDeps()` signs a verifiable 2-minute
 * admin token and resolves admins from D1. Negative: the pre-fix shape —
 * signing from a fresh auth module without validation — throws exactly that.
 */
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, { id: string; username: string; is_admin: number }>([
	["root", { id: "admin-1", username: "root", is_admin: 1 }],
	["ana", { id: "user-2", username: "ana", is_admin: 0 }],
]);
vi.mock("./db.js", () => ({
	d1Query: vi.fn(async (_sql: string, params: unknown[]) => ({
		results: rows.has(params[0] as string) ? [rows.get(params[0] as string)] : [],
	})),
}));

const SECRET = "test-secret-".padEnd(48, "x");
const saved = { JWT_SECRET: process.env.JWT_SECRET, NODE_ENV: process.env.NODE_ENV };
beforeEach(() => {
	vi.resetModules();
	process.env.JWT_SECRET = SECRET;
	process.env.NODE_ENV = "test";
});
afterEach(() => {
	process.env.JWT_SECRET = saved.JWT_SECRET;
	process.env.NODE_ENV = saved.NODE_ENV;
});

for (const [label, modulePath] of [
	["recreate:admin", "./recreate/adminCli.js"],
	["composer:resolve", "./conversation/composerCli.js"],
] as const) {
	describe(`${label} host wiring`, () => {
		it("signs a verifiable short-lived token for a D1 admin and refuses non-admins / unknown users", async () => {
			const { hostDeps } = (await import(modulePath)) as {
				hostDeps: () => Promise<{
					lookupAdmin: (u: string) => Promise<{ id: string; username: string } | null>;
					signToken: (id: string, u: string) => string;
				}>;
			};
			const deps = await hostDeps();
			expect(await deps.lookupAdmin("root")).toEqual({ id: "admin-1", username: "root" });
			expect(await deps.lookupAdmin("ana")).toBeNull();
			expect(await deps.lookupAdmin("nobody")).toBeNull();
			const token = deps.signToken("admin-1", "root");
			const payload = jwt.verify(token, SECRET) as {
				sub: string;
				username: string;
				exp: number;
				iat: number;
			};
			expect(payload.sub).toBe("admin-1");
			expect(payload.username).toBe("root");
			expect(payload.exp - payload.iat).toBe(120);
		});
	});
}

it("the pre-fix shape: signing from a fresh auth module without validateJwtSecret() throws (what the CLIs did)", async () => {
	const auth = await import("./auth.js");
	expect(() => auth.signCliToken("admin-1", "root")).toThrow(/called before validateJwtSecret/);
	auth.validateJwtSecret();
	expect(() => auth.signCliToken("admin-1", "root")).not.toThrow();
});

it("production without a secret: hostDeps refuses before any token exists", async () => {
	process.env.NODE_ENV = "production";
	delete process.env.JWT_SECRET;
	const { hostDeps } = (await import("./recreate/adminCli.js")) as {
		hostDeps: () => Promise<unknown>;
	};
	await expect(hostDeps()).rejects.toThrow(/JWT_SECRET must be set/);
});
