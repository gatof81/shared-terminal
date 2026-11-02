// The logger is observational: no stdout, exit 0, no text stored.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
test("sin stdout, exit 0, sin texto ni rutas en el log, source ausente distinguible", () => {
	const d = mkdtempSync(join(tmpdir(), "poc0-logger-"));
	copyFileSync(join(KIT, "hook-logger.mjs"), join(d, "hook-logger.mjs"));
	const run = (payload) => spawnSync(process.execPath, [join(d, "hook-logger.mjs")], { input: payload, encoding: "utf8" });
	const secret = "texto privado sk-ant-abc /Users/alguien";
	const a = run(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p", prompt: `<channel source="plugin:fakechat:fakechat" message_id="P0T01-abcdef">${secret}</channel>`, transcript_path: "/Users/alguien/t", cwd: "/Users/alguien" }));
	const b = run("no es json");
	assert.equal(a.status, 0);
	assert.equal(a.stdout, "");
	assert.equal(b.status, 0);
	assert.equal(b.stdout, "");
	const log = readFileSync(join(d, "out", "hooks.jsonl"), "utf8");
	assert.equal(log.trim().split("\n").length, 1);
	assert.ok(!log.includes("privado") && !log.includes("sk-ant") && !log.includes("/Users/"));
	const rec = JSON.parse(log);
	assert.equal(rec.source_present, false);
	assert.equal(rec.channel_tags[0].attrs.message_id, "P0T01-abcdef");
});
