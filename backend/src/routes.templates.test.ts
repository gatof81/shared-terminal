import { describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import { assertTemplateConfigShape, parseTemplateBody, TemplateBodyError } from "./routes.js";

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

// `parseTemplateBody` runs at the route boundary on every POST/PUT
// /api/templates request. The validation invariants (name required,
// name + description length caps, config-must-be-object) protect
// the storage layer from malformed inputs and surface precise 400s
// to the client. Direct unit coverage so a silent regression on
// either constant or any of the type checks fails this suite.
describe("parseTemplateBody", () => {
	const goodConfig = { cpuLimit: 1_000_000_000 };

	it("accepts the canonical shape and trims the name", () => {
		const got = parseTemplateBody({
			name: "  my template  ",
			description: "a tooltip",
			config: goodConfig,
		});
		expect(got.name).toBe("my template");
		expect(got.description).toBe("a tooltip");
	});

	it("collapses a missing description to null", () => {
		const got = parseTemplateBody({ name: "T", config: goodConfig });
		expect(got.description).toBeNull();
	});

	it("collapses a whitespace-only description to null (UX trap fix)", () => {
		const got = parseTemplateBody({ name: "T", description: "   ", config: goodConfig });
		expect(got.description).toBeNull();
	});

	it("requires a name (missing / non-string / empty / whitespace-only)", () => {
		expect(() => parseTemplateBody({ config: goodConfig })).toThrowError(/name is required/);
		expect(() => parseTemplateBody({ name: 123 as unknown, config: goodConfig })).toThrowError(
			/name is required/,
		);
		expect(() => parseTemplateBody({ name: "", config: goodConfig })).toThrowError(
			/name is required/,
		);
		expect(() => parseTemplateBody({ name: "   ", config: goodConfig })).toThrowError(
			/name is required/,
		);
	});

	it("rejects names over 64 characters (post-trim)", () => {
		// Exactly 64 chars passes (boundary pin).
		const exact = "a".repeat(64);
		expect(parseTemplateBody({ name: exact, config: goodConfig }).name).toBe(exact);
		// 65 fails.
		expect(() => parseTemplateBody({ name: "a".repeat(65), config: goodConfig })).toThrowError(
			/name exceeds 64 characters/,
		);
		// Mostly-whitespace 65 chars passes (trim-first ordering — the
		// post-trim length is what counts).
		const padded = `   ${"a".repeat(60)}   `;
		expect(parseTemplateBody({ name: padded, config: goodConfig }).name).toBe("a".repeat(60));
	});

	it("rejects descriptions that aren't strings", () => {
		expect(() =>
			parseTemplateBody({ name: "T", description: 42 as unknown, config: goodConfig }),
		).toThrowError(/description must be a string/);
	});

	it("rejects descriptions over 512 characters (post-trim)", () => {
		// Exactly 512 chars passes (boundary pin).
		const exact = "a".repeat(512);
		expect(
			parseTemplateBody({ name: "T", description: exact, config: goodConfig }).description,
		).toBe(exact);
		// 513 fails.
		expect(() =>
			parseTemplateBody({ name: "T", description: "a".repeat(513), config: goodConfig }),
		).toThrowError(/description exceeds 512 characters/);
	});

	it("rejects missing / null / non-object configs", () => {
		expect(() => parseTemplateBody({ name: "T" })).toThrowError(/config is required/);
		expect(() => parseTemplateBody({ name: "T", config: null })).toThrowError(/config is required/);
		expect(() => parseTemplateBody({ name: "T", config: "string" as unknown })).toThrowError(
			/config must be an object/,
		);
		// Array guard: `typeof [] === "object"` so without the
		// Array.isArray short-circuit a bare array would slip past.
		expect(() => parseTemplateBody({ name: "T", config: [1, 2, 3] as unknown })).toThrowError(
			/config must be an object/,
		);
	});

	it("path attribution: TemplateBodyError carries the right `.path`", () => {
		// Locks the path values the route uses to build the 400 body.
		try {
			parseTemplateBody({ config: goodConfig });
		} catch (err) {
			expect((err as TemplateBodyError).path).toBe("name");
		}
		try {
			parseTemplateBody({ name: "T", description: 42 as unknown, config: goodConfig });
		} catch (err) {
			expect((err as TemplateBodyError).path).toBe("description");
		}
		try {
			parseTemplateBody({ name: "T" });
		} catch (err) {
			expect((err as TemplateBodyError).path).toBe("config");
		}
	});
});
