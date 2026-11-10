/**
 * conversation/cliPolicy.ts — which Claude Code versions the composer may
 * type into (docs/CONVERSATION.md §8.1.9, v1.8.3 proposal).
 *
 * The version judged is ALWAYS the live process's, established by
 * cliIdentity.ts (v1.8.2) — never the SessionStart hook's text. An
 * unverifiable version never reaches this module: it is refused before.
 *
 * Three settings, decided in this order:
 *   1. COMPOSER_CLI_DENY        exact versions refused whatever else says (a
 *                               release found broken). Deny always wins.
 *   2. COMPOSER_CLI_VERSIONS    exact versions the §8.2.6 revalidation was run
 *                               with (unchanged; default 2.1.314).
 *   3. COMPOSER_CLI_MIN_VERSION OPEN: every stable release ≥ it — later
 *                               patches, minors AND majors — with no ceiling.
 *                               It must itself be a validated version (listed
 *                               in COMPOSER_CLI_VERSIONS).
 * Unset (3) ⇒ the lowest version of the exact list (owner, 2026-11-10: new
 * stable CLI releases are accepted by default, without validating each one
 * or downgrading a session; known-broken ones go in the deny list).
 * `COMPOSER_CLI_MIN_VERSION=off` ⇒ the exact list alone (the old behaviour).
 * Pre-releases and build suffixes never count (the version parser accepts
 * plain X.Y.Z only). A malformed setting refuses to start.
 *
 * The risk of (3), stated in §8.1.9 and DEPLOYMENT.md: it admits releases
 * nobody has run §8.2.6 against. The composer's dynamic checks (probe
 * status, process identity and foreground, empty input region, visible
 * consumption of every paste, the ack) are fail-closed for what they
 * observe, but they cannot prove that a future CLI still treats CSI u as a
 * newline, wraps pastes at the same threshold, keeps `!`/`/` as modes or
 * acknowledges with `UserPromptSubmit`. A minor or major release can change
 * the terminal UI entirely; a regression there can produce a misdelivered
 * send (split, submitted early, run as a command) that no check detects.
 */

import { DEFAULT_CLI_VERSIONS } from "./composerText.js";

export type Semver = readonly [number, number, number];

/** Strict X.Y.Z: no leading zeros, no pre-release or build suffix. */
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export function parseVersion(s: string): Semver | null {
	const m = VERSION_RE.exec(s);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compare(a: Semver, b: Semver): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export interface CliPolicy {
	exact: ReadonlySet<string>;
	deny: ReadonlySet<string>;
	/** COMPOSER_CLI_MIN_VERSION, or null (exact list only). */
	min: string | null;
}

export type CliDecision =
	| { ok: true; version: string; by: "exact" | "min" }
	| { ok: false; version: string | null; why: "invalid-version" | "denied" | "not-allowed" };

// The validated default lives with the text rules (the frontend keeps a
// byte-identical copy of composerText.ts, so it is not duplicated here).
export const DEFAULT_EXACT: readonly string[] = DEFAULT_CLI_VERSIONS;

function versionList(name: string, raw: string | undefined): string[] {
	const entries = (raw ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
	const bad = entries.filter((v) => !parseVersion(v));
	// Configured but unusable must not silently become something else.
	if (bad.length > 0) throw new Error(`${name}: not a version: ${bad.join(", ")} (expected X.Y.Z)`);
	return entries;
}

export function parseExact(raw: string | undefined): Set<string> {
	const list = versionList("COMPOSER_CLI_VERSIONS", raw);
	return new Set(list.length > 0 ? list : DEFAULT_EXACT);
}

export function parseDeny(raw: string | undefined): Set<string> {
	return new Set(versionList("COMPOSER_CLI_DENY", raw));
}

/** The default minimum: the lowest validated version (the exact list is never empty). */
export function lowestVersion(versions: Iterable<string>): string {
	let low: string | null = null;
	for (const v of versions) {
		if (low === null || compare(parseVersion(v) as Semver, parseVersion(low) as Semver) < 0)
			low = v;
	}
	return low as string;
}

export function parseMin(raw: string | undefined, exact: ReadonlySet<string>): string | null {
	const text = (raw ?? "").trim();
	if (text === "off") return null;
	if (text === "") return lowestVersion(exact);
	if (!parseVersion(text))
		throw new Error(
			`COMPOSER_CLI_MIN_VERSION ${JSON.stringify(text)}: not a version (expected plain X.Y.Z, no range, no pre-release, or "off")`,
		);
	if (!exact.has(text))
		throw new Error(
			`COMPOSER_CLI_MIN_VERSION ${text}: must be a validated version listed in COMPOSER_CLI_VERSIONS`,
		);
	return text;
}

export function parsePolicy(env: {
	COMPOSER_CLI_VERSIONS?: string;
	COMPOSER_CLI_MIN_VERSION?: string;
	COMPOSER_CLI_DENY?: string;
}): CliPolicy {
	const exact = parseExact(env.COMPOSER_CLI_VERSIONS);
	return {
		exact,
		deny: parseDeny(env.COMPOSER_CLI_DENY),
		min: parseMin(env.COMPOSER_CLI_MIN_VERSION, exact),
	};
}

export function exactPolicy(exact: Iterable<string>): CliPolicy {
	return { exact: new Set(exact), deny: new Set(), min: null };
}

/**
 * Decide on a version ESTABLISHED from the live process (cliIdentity.ts),
 * bare X.Y.Z. Re-validated here: this module never trusts its input's shape.
 */
export function decide(policy: CliPolicy, version: string): CliDecision {
	const v = parseVersion(version);
	if (!v) return { ok: false, version: null, why: "invalid-version" };
	if (policy.deny.has(version)) return { ok: false, version, why: "denied" };
	if (policy.exact.has(version)) return { ok: true, version, by: "exact" };
	if (policy.min !== null && compare(v, parseVersion(policy.min) as Semver) >= 0)
		return { ok: true, version, by: "min" };
	return { ok: false, version, why: "not-allowed" };
}

/** The rule that authorized a send, as logged. */
export function ruleText(policy: CliPolicy, d: Extract<CliDecision, { ok: true }>): string {
	return d.by === "exact" ? "COMPOSER_CLI_VERSIONS" : `COMPOSER_CLI_MIN_VERSION >=${policy.min}`;
}

export function describePolicy(p: CliPolicy): string {
	const parts = [`exact ${[...p.exact].join(", ")}`];
	if (p.min) parts.push(`min ${p.min} (open: any later stable release, unvalidated)`);
	if (p.deny.size > 0) parts.push(`deny ${[...p.deny].join(", ")}`);
	return parts.join("; ");
}

/** Startup warnings that are not errors. */
export function policyWarnings(p: CliPolicy): string[] {
	const out: string[] = [];
	const both = [...p.exact].filter((v) => p.deny.has(v));
	if (both.length > 0)
		out.push(`COMPOSER_CLI_DENY also lists validated ${both.join(", ")}: denied (deny wins)`);
	if (p.min)
		out.push(
			`COMPOSER_CLI_MIN_VERSION=${p.min}: the composer will type into ANY later stable Claude Code release, including minor and major ones never validated (§8.1.9 risk)`,
		);
	return out;
}
