/**
 * buildSessionImageScript.test.ts — scripts/build-session-image.sh, the
 * project's managed way to rebuild the session image (owner condition P2):
 * the gate (`images:pins`) runs before the build AND immediately before the
 * live tag moves; a NO-GO at either point moves nothing; nothing is removed.
 * A `docker` stand-in on PATH records every call and answers the gate.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../scripts/build-session-image.sh");
let dir: string;
let log: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "st-build-guard-"));
	log = path.join(dir, "docker.log");
	// The gate answers per call from GATE_SEQ ("GO GO", "NO-GO", "GO NO-GO").
	writeFileSync(
		path.join(dir, "docker"),
		`#!/bin/bash
echo "$*" >> "${log}"
if [ "$1 $2" = "compose exec" ]; then
  n=$(grep -c '^compose exec' "${log}")
  v=$(echo "$GATE_SEQ" | cut -d' ' -f"$n")
  [ "$v" = GO ] && { echo '{"gate":"GO"}'; exit 0; }
  echo '{"gate":"NO-GO","reasons":["st-x: image MISSING"]}'; exit 1
fi
[ "$1" = image ] && { echo sha256:new; exit 0; }
exit 0
`,
		{ mode: 0o755 },
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(gates: string, args: string[] = []) {
	const r = spawnSync("bash", [SCRIPT, ...args], {
		env: { PATH: `${dir}:/usr/bin:/bin`, GATE_SEQ: gates },
		encoding: "utf8",
	});
	const calls = (() => {
		try {
			return readFileSync(log, "utf8").trim().split("\n");
		} catch {
			return [];
		}
	})();
	return { code: r.status, out: r.stdout + r.stderr, calls };
}

describe("scripts/build-session-image.sh", () => {
	it("GO, GO ⇒ gate, build to a CANDIDATE tag, gate again, then move the live tag; nothing removed", () => {
		const r = run("GO GO", ["--build-arg", "CLAUDE_CODE_VERSION=2.1.318"]);
		expect(r.code).toBe(0);
		expect(r.calls).toHaveLength(5);
		expect(r.calls[0]).toBe("compose exec -T app npm run -s images:pins");
		expect(r.calls[2]).toBe("compose exec -T app npm run -s images:pins");
		expect(r.calls[4]).toMatch(/^image inspect shared-terminal-session /);
		expect(r.calls[1]).toMatch(
			/^build -t shared-terminal-session:candidate-\d{8}T\d{6}Z --build-arg CLAUDE_CODE_VERSION=2\.1\.318 \.\/session-image$/,
		);
		expect(r.calls[3]).toMatch(
			/^tag shared-terminal-session:candidate-\S+ shared-terminal-session$/,
		);
		expect(r.calls.some((c) => /^(rmi|image rm|image prune|system prune)/.test(c))).toBe(false);
	});
	it("NO-GO before the build ⇒ nothing is built or moved", () => {
		const r = run("NO-GO");
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/NO-GO \(before build\)/);
		expect(r.calls).toHaveLength(1);
	});
	it("NO-GO right before the move (a container appeared during the build) ⇒ built, but the live tag does NOT move", () => {
		const r = run("GO NO-GO");
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/NO-GO \(before moving shared-terminal-session\)/);
		expect(r.calls.some((c) => c.startsWith("tag "))).toBe(false);
		expect(r.calls.some((c) => c.startsWith("build "))).toBe(true);
	});
	it("the backend not answering (exec fails) is NO-GO, not 'no sessions'", () => {
		const r = run("");
		expect(r.code).toBe(1);
		expect(r.calls.some((c) => c.startsWith("build "))).toBe(false);
	});
});
