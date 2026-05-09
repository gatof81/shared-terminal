import { describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import { assertTemplateConfigShape, TemplateBodyError } from "./routes.js";

// `assertTemplateConfigShape` is the route-boundary belt-and-suspenders
// guard that prevents plaintext secrets / live credentials from landing
// in the unencrypted `templates.config` column. The schema-level
// `allowSecretSlots` flag relaxes the rejection on `secret-slot` so
// templates work; `assertTemplateConfigShape` re-tightens for the
// shapes a misbehaving client could otherwise smuggle past the
// schema's `allowSecretSlots: true` mode (a `secret`-typed env entry
// with a plaintext `value`, or an `auth.pat` / `auth.ssh.privateKey`
// blob). These tests pin the rejection branches so a refactor that
// renames the env-entry discriminant or adds a new credential field
// to `auth` can't silently disable the guard.
describe("assertTemplateConfigShape", () => {
	it("passes a config with no envVars / auth", () => {
		expect(() => assertTemplateConfigShape({})).not.toThrow();
		expect(() => assertTemplateConfigShape({ cpuLimit: 1_000_000_000 })).not.toThrow();
	});

	it("passes plain + secret-slot envVars (the only types templates accept)", () => {
		expect(() =>
			assertTemplateConfigShape({
				envVars: [
					{ name: "FOO", type: "plain", value: "bar" },
					{ name: "API_KEY", type: "secret-slot" },
				],
			}),
		).not.toThrow();
	});

	it("rejects a 'secret' envVar entry (BLOCKER from round 3)", () => {
		expect(() =>
			assertTemplateConfigShape({
				envVars: [{ name: "API_KEY", type: "secret", value: "sk-leaked" }],
			}),
		).toThrowError(TemplateBodyError);
		try {
			assertTemplateConfigShape({
				envVars: [{ name: "API_KEY", type: "secret", value: "sk-leaked" }],
			});
		} catch (err) {
			expect(err).toBeInstanceOf(TemplateBodyError);
			expect((err as TemplateBodyError).path).toBe("config.envVars");
			expect((err as Error).message).toMatch(/secret.*not allowed/);
		}
	});

	it("rejects auth.pat (live credential — must not land in raw-JSON column)", () => {
		expect(() =>
			assertTemplateConfigShape({
				auth: { pat: "ghp_leakedtokenvalue" },
			}),
		).toThrowError(TemplateBodyError);
		try {
			assertTemplateConfigShape({ auth: { pat: "ghp_x" } });
		} catch (err) {
			expect(err).toBeInstanceOf(TemplateBodyError);
			expect((err as TemplateBodyError).path).toBe("config.auth.pat");
			expect((err as Error).message).toMatch(/PAT.*must not/);
		}
	});

	it("rejects auth.ssh.privateKey (live credential — same shape as PAT)", () => {
		expect(() =>
			assertTemplateConfigShape({
				auth: { ssh: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----…" } },
			}),
		).toThrowError(TemplateBodyError);
		try {
			assertTemplateConfigShape({
				auth: { ssh: { privateKey: "secret" } },
			});
		} catch (err) {
			expect(err).toBeInstanceOf(TemplateBodyError);
			expect((err as TemplateBodyError).path).toBe("config.auth.ssh.privateKey");
			expect((err as Error).message).toMatch(/SSH key.*must not/);
		}
	});

	it("passes auth without credential blobs (the intended template shape)", () => {
		// `repo.auth: 'pat'` / `'ssh'` declarations stay (they're
		// re-prompts for the recipient via the `Use template` flow);
		// only the actual credential strings are forbidden. The schema's
		// `allowMissingAuth: true` flag handles the cross-field check.
		expect(() =>
			assertTemplateConfigShape({
				auth: { ssh: { knownHosts: "github.com ssh-ed25519 …" } },
			}),
		).not.toThrow();
		expect(() => assertTemplateConfigShape({ auth: {} })).not.toThrow();
	});

	it("ignores non-object configs (validation handled upstream)", () => {
		// `parseTemplateBody` already 400s on null / array / string
		// configs; this guard is the second-stage check on a known-
		// object config and is intentionally permissive when handed
		// something non-object — the upstream check is the source of
		// truth.
		expect(() => assertTemplateConfigShape(null)).not.toThrow();
		expect(() => assertTemplateConfigShape([] as unknown)).not.toThrow();
		expect(() => assertTemplateConfigShape("string" as unknown)).not.toThrow();
	});

	it("ignores envVars that aren't an array (handled by Zod upstream)", () => {
		expect(() => assertTemplateConfigShape({ envVars: "not an array" } as unknown)).not.toThrow();
	});
});
