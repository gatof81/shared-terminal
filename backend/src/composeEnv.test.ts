/**
 * composeEnv.test.ts — docker-compose.yml forwards the composer's two
 * variables to the backend container with compose's `${VAR:-}` shape, and
 * the backend reads the forwarded value the way the operator expects:
 * nothing in .env ⇒ composer OFF and the default CLI allowlist; a value ⇒
 * that value. `docker compose config` itself runs in the Session Image
 * workflow (conversation-smoke.sh, Phase 0); this test pins the file's
 * shape and the backend's reading of the interpolated result.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composerFlagEnabled, parseCliVersions } from "./conversation/composer.js";

const compose = readFileSync(path.resolve(__dirname, "../../docker-compose.yml"), "utf8");

/** The `app` service's `environment` entries (`- NAME=value` lines). */
function appEnvironment(): Map<string, string> {
	const app = compose.slice(
		compose.indexOf("\n  app:"),
		compose.indexOf("\n  cloudflared:") > 0 ? compose.indexOf("\n  cloudflared:") : undefined,
	);
	const out = new Map<string, string>();
	for (const m of app.matchAll(/^\s+- ([A-Z0-9_]+)=(.*)$/gm)) out.set(m[1]!, m[2]!);
	return out;
}

/** Compose's interpolation for the two shapes this file uses: `${VAR}` and `${VAR:-default}`. */
function interpolate(template: string, env: Record<string, string | undefined>): string {
	return template.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
		const v = env[name];
		return v === undefined || v === "" ? (def ?? "") : v;
	});
}

describe("docker-compose.yml → composer env (3.2)", () => {
	it("forwards both variables with the empty default, like the capture flags", () => {
		const env = appEnvironment();
		// Compose's own `${VAR:-}` syntax, spelled out so the linter does not read it as a template.
		const shape = (name: string) => `$\{${name}:-}`;
		expect(env.get("CONVERSATION_COMPOSER_ENABLED")).toBe(shape("CONVERSATION_COMPOSER_ENABLED"));
		expect(env.get("COMPOSER_CLI_VERSIONS")).toBe(shape("COMPOSER_CLI_VERSIONS"));
		expect(env.get("CONVERSATION_ENABLED")).toBe(shape("CONVERSATION_ENABLED"));
	});

	it("nothing in .env ⇒ the container gets empty strings ⇒ composer off, default allowlist", () => {
		const env = appEnvironment();
		const flag = interpolate(env.get("CONVERSATION_COMPOSER_ENABLED")!, {});
		const versions = interpolate(env.get("COMPOSER_CLI_VERSIONS")!, {});
		expect(flag).toBe("");
		expect(composerFlagEnabled(flag)).toBe(false);
		expect(composerFlagEnabled(undefined)).toBe(false);
		expect([...parseCliVersions(versions)]).toEqual(["2.1.314"]);
	});

	it("values in .env reach the backend verbatim: the flag turns it on, the allowlist is exactly the list", () => {
		const env = appEnvironment();
		const vars = {
			CONVERSATION_COMPOSER_ENABLED: "true",
			COMPOSER_CLI_VERSIONS: "2.1.314,2.1.320",
		};
		expect(composerFlagEnabled(interpolate(env.get("CONVERSATION_COMPOSER_ENABLED")!, vars))).toBe(
			true,
		);
		expect([...parseCliVersions(interpolate(env.get("COMPOSER_CLI_VERSIONS")!, vars))]).toEqual([
			"2.1.314",
			"2.1.320",
		]);
		// Anything but true/1 keeps it off (an operator typo cannot turn it on).
		expect(
			composerFlagEnabled(
				interpolate(env.get("CONVERSATION_COMPOSER_ENABLED")!, {
					CONVERSATION_COMPOSER_ENABLED: "yes",
				}),
			),
		).toBe(false);
	});
});
