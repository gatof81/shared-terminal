import { describe, expect, it } from "vitest";
import { type SessionConfigPayload, stripConfigForTemplate } from "./api.js";

// `stripConfigForTemplate` is the client-side gate that prevents
// plaintext secrets from reaching the unencrypted `templates.config`
// column. The backend's `assertTemplateConfigShape` (195a, round 3
// BLOCKER) is the regression guard if this function ever ships a
// regression, but the client-side strip is the source of truth for
// what we send — these tests pin every branch.

describe("stripConfigForTemplate", () => {
	it("returns the same shape for a config with no secrets", () => {
		const input: SessionConfigPayload = {
			cpuLimit: 1_000_000_000,
			postCreateCmd: "npm install",
			envVars: [{ name: "FOO", type: "plain", value: "bar" }],
		};
		expect(stripConfigForTemplate(input)).toEqual(input);
	});

	it("collapses secret envVars to secret-slot (no value)", () => {
		const input: SessionConfigPayload = {
			envVars: [
				{ name: "FOO", type: "plain", value: "bar" },
				{ name: "API_KEY", type: "secret", value: "sk-test-1234" },
			],
		};
		const out = stripConfigForTemplate(input);
		expect(out.envVars).toEqual([
			{ name: "FOO", type: "plain", value: "bar" },
			{ name: "API_KEY", type: "secret-slot" },
		]);
		// Belt-and-braces: the slot row must NOT carry a value.
		const slot = out.envVars?.find((e) => e.type === "secret-slot");
		expect(slot).not.toHaveProperty("value");
	});

	it("drops auth.pat entirely (PAT material must not persist)", () => {
		const input: SessionConfigPayload = {
			repo: { url: "https://github.com/u/r", auth: "pat" },
			auth: { pat: "ghp_leakedtokenvalue" },
		};
		const out = stripConfigForTemplate(input);
		// The repo's auth: "pat" declaration stays — the recipient
		// re-supplies the PAT via the Use-template re-prompt.
		expect(out.repo?.auth).toBe("pat");
		// `auth.pat` is gone; `auth` itself is dropped because there's
		// nothing else in it.
		expect(out.auth).toBeUndefined();
	});

	it("drops auth.ssh.privateKey but keeps knownHosts (public)", () => {
		const input: SessionConfigPayload = {
			repo: { url: "git@github.com:u/r", auth: "ssh" },
			auth: {
				ssh: {
					privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----…",
					knownHosts: "github.com ssh-ed25519 …",
				},
			},
		};
		const out = stripConfigForTemplate(input);
		expect(out.repo?.auth).toBe("ssh");
		// privateKey is gone; knownHosts (public fingerprints) stays
		// so the recipient doesn't have to re-paste them.
		expect(out.auth?.ssh).not.toHaveProperty("privateKey");
		expect(out.auth?.ssh?.knownHosts).toBe("github.com ssh-ed25519 …");
	});

	it("drops `auth` entirely when SSH had only a privateKey (no knownHosts)", () => {
		const input: SessionConfigPayload = {
			repo: { url: "git@github.com:u/r", auth: "ssh" },
			auth: { ssh: { privateKey: "secret", knownHosts: "" } },
		};
		const out = stripConfigForTemplate(input);
		// No knownHosts → nothing left in `auth.ssh` after the strip.
		// Whole `auth` collapses out so the wire shape matches what
		// the backend's `allowMissingAuth: true` accepts.
		expect(out.auth).toBeUndefined();
	});

	it("does not mutate the input config (non-destructive)", () => {
		const input: SessionConfigPayload = {
			envVars: [{ name: "API_KEY", type: "secret", value: "sk-test-1234" }],
			auth: { pat: "ghp_x" },
		};
		const snapshot = JSON.parse(JSON.stringify(input));
		stripConfigForTemplate(input);
		// Caller's `input` must be unchanged — prevents a
		// future-form-resubmit-after-save-as-template from accidentally
		// sending a stripped config with a secret-slot to POST /sessions
		// (which 400s on slots).
		expect(input).toEqual(snapshot);
	});

	it("leaves a no-auth / no-envVars config untouched", () => {
		const input: SessionConfigPayload = { cpuLimit: 1_000_000_000 };
		const out = stripConfigForTemplate(input);
		expect(out).toEqual(input);
		expect(out.auth).toBeUndefined();
	});
});
