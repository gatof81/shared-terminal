import { describe, expect, it } from "vitest";
import {
	idleSecondsToFormUnit,
	memBytesToFormUnit,
	type SessionConfigPayload,
	stripConfigForTemplate,
} from "./api.js";

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

// `memBytesToFormUnit` and `idleSecondsToFormUnit` are the reverse-
// direction helpers the use-template flow's pre-fill calls (the
// inverse of what `collectAdvancedForSubmit` does). The boundary
// branches (GiB vs MiB, hours vs minutes) are deterministic pure
// math; pinning them here so a future regression in the divisibility
// check trips a test rather than silently mis-populating a form.

describe("memBytesToFormUnit", () => {
	it("returns null for undefined / 0 / negative (form blank state)", () => {
		expect(memBytesToFormUnit(undefined)).toBeNull();
		expect(memBytesToFormUnit(0)).toBeNull();
		expect(memBytesToFormUnit(-1)).toBeNull();
	});

	it("returns GiB when the byte count is an integer multiple of 1 GiB", () => {
		expect(memBytesToFormUnit(1024 ** 3)).toEqual({ amount: 1, unit: "GiB" });
		expect(memBytesToFormUnit(2 * 1024 ** 3)).toEqual({ amount: 2, unit: "GiB" });
		expect(memBytesToFormUnit(16 * 1024 ** 3)).toEqual({ amount: 16, unit: "GiB" });
	});

	it("falls back to MiB when bytes don't divide evenly into GiB", () => {
		// 1.5 GiB → 1536 MiB
		expect(memBytesToFormUnit(1.5 * 1024 ** 3)).toEqual({ amount: 1536, unit: "MiB" });
		// 256 MiB at the floor — under 1 GiB so the GiB branch is
		// skipped (the `gib >= 1` guard).
		expect(memBytesToFormUnit(256 * 1024 ** 2)).toEqual({ amount: 256, unit: "MiB" });
	});

	it("MiB rounds the boundary halfway case", () => {
		// 1.5 MiB → 2 (Math.round rounds ties to even / up depending
		// on the engine; pin that the round-up shape holds)
		expect(memBytesToFormUnit(1.5 * 1024 ** 2)).toEqual({ amount: 2, unit: "MiB" });
	});
});

describe("idleSecondsToFormUnit", () => {
	it("returns null for undefined / 0 / negative (form blank state)", () => {
		expect(idleSecondsToFormUnit(undefined)).toBeNull();
		expect(idleSecondsToFormUnit(0)).toBeNull();
		expect(idleSecondsToFormUnit(-60)).toBeNull();
	});

	it("returns hours when seconds divide evenly by 3600", () => {
		expect(idleSecondsToFormUnit(3600)).toEqual({ amount: 1, unit: "hours" });
		expect(idleSecondsToFormUnit(2 * 3600)).toEqual({ amount: 2, unit: "hours" });
		expect(idleSecondsToFormUnit(24 * 3600)).toEqual({ amount: 24, unit: "hours" });
	});

	it("falls back to minutes when seconds don't divide evenly by 3600", () => {
		expect(idleSecondsToFormUnit(60)).toEqual({ amount: 1, unit: "minutes" });
		expect(idleSecondsToFormUnit(90)).toEqual({ amount: 2, unit: "minutes" }); // rounds
		expect(idleSecondsToFormUnit(1800)).toEqual({ amount: 30, unit: "minutes" });
		// 90 minutes (5400 seconds) — not divisible by 3600 → minutes
		expect(idleSecondsToFormUnit(5400)).toEqual({ amount: 90, unit: "minutes" });
	});
});
