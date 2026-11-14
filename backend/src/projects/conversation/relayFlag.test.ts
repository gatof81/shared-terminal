/**
 * PROJECT_CONVERSATION.md §7.3.1 (f): with the origin flag off,
 * PROJECT_RELAY_ENABLED stays off.
 *
 * The decision is two expressions in index.ts, which cannot be imported (it
 * boots the server) and is deliberately not refactored for this test. So the
 * test reads the SOURCE of those two expressions and evaluates exactly that
 * text over the whole flag matrix: an edit that lets the relay on without a
 * running origin check fails here, and so does an edit that moves the
 * expressions out of reach (the extraction then finds nothing).
 * relayOrigin.smoke.ts shows, against real Docker, why the rule exists: with
 * no verifier an event carries no verdict and nothing is admitted.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(__dirname, "../../index.ts"), "utf8");

/** The right-hand side of `const <name>[: type] = <expr>;` in index.ts. */
function rhs(name: string): string {
	const m = new RegExp(`\\nconst ${name}\\b[^=;]*=\\s*([^;]+);`).exec(source);
	if (!m) throw new Error(`index.ts no longer declares ${name} as a single const expression`);
	return m[1] as string;
}

const originMode = new Function("INGEST_ORIGIN_FLAG", `return (${rhs("INGEST_ORIGIN_MODE")});`) as (
	flag: string,
) => "enforce" | "observe" | null;
const relayEnabled = new Function(
	"PROJECT_RELAY_FLAG",
	"PROJECT_CONVERSATION_ENABLED",
	"INGEST_ORIGIN_MODE",
	`return (${rhs("PROJECT_RELAY_ENABLED")});`,
) as (relayFlag: boolean, d1: boolean, mode: string | null) => boolean;

describe("index.ts — PROJECT_RELAY_ENABLED needs the origin check running (§7.3.1 f)", () => {
	it("only `true` and `observe` turn the origin check on; anything else is off", () => {
		expect(originMode("true")).toBe("enforce");
		expect(originMode("observe")).toBe("observe");
		for (const off of ["", "false", "TRUE", "1", "on", "Observe", " observe", "enforce"]) {
			expect(originMode(off), JSON.stringify(off)).toBeNull();
		}
	});

	it("the relay is effective only with its flag, D1 effective AND an origin mode", () => {
		for (const flag of [true, false]) {
			for (const d1 of [true, false]) {
				for (const raw of ["", "false", "bogus", "observe", "true"]) {
					const mode = originMode(raw);
					expect(relayEnabled(flag, d1, mode), `${flag}/${d1}/${JSON.stringify(raw)}`).toBe(
						flag && d1 && (raw === "observe" || raw === "true"),
					);
				}
			}
		}
	});

	it("that one value decides the grant creation and every D3 object", () => {
		// `relay: false` ⇒ a `collab` body is 409 relay-off (fanout.ts); the
		// collab and the outbox watcher are built only inside this branch.
		expect(source).toMatch(/\n\t+relay: PROJECT_RELAY_ENABLED,/);
		const branch =
			/\n(\t+)if \(PROJECT_RELAY_ENABLED\) \{\n[\s\S]*?\n\1\}\n/.exec(source)?.[0] ?? "";
		expect(branch).toContain("new ProjectCollab(");
		expect(branch).toContain("new OutboxWatcher(");
		expect(source.match(/new (ProjectCollab|OutboxWatcher)\(/g)).toHaveLength(2);
	});
});
