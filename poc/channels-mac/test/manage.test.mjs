// Regression 1: uninstall restores settings.local.json byte for byte when
// nothing else changed it, and removes only the kit's hooks otherwise.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { install, uninstall } from "../manage.mjs";

const bunPath = process.execPath;
const folder = () => mkdtempSync(join(tmpdir(), "poc0-manage-"));
const settings = (f) => join(f, ".claude", "settings.local.json");
// Deliberately unusual formatting (tabs, key order, no trailing newline,
// unicode) so any re-serialisation would be caught by the byte comparison.
const PRIOR = '{\n\t"permissions": {"allow": ["mcp__plugin_fakechat_fakechat__reply"]},\n\t"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mía"}]}]},\n\t"zz": 1\n}';

test("sin archivo previo: install + uninstall no deja rastro (archivo y .claude creados por el kit se eliminan)", () => {
	const f = folder();
	install(f, { bunPath });
	assert.ok(existsSync(settings(f)));
	const r = uninstall(f);
	assert.equal(r.mode, "restaurado-exacto");
	assert.equal(existsSync(settings(f)), false);
	assert.equal(existsSync(join(f, ".claude")), false);
});

test("con archivo previo y sin cambios externos: restauración byte por byte", () => {
	const f = folder();
	mkdirSync(join(f, ".claude"));
	writeFileSync(settings(f), PRIOR);
	install(f, { bunPath });
	const installed = JSON.parse(readFileSync(settings(f), "utf8"));
	assert.equal(installed.hooks.Stop.length, 2, "el hook previo del usuario se conserva durante la prueba");
	assert.deepEqual(installed.permissions, { allow: ["mcp__plugin_fakechat_fakechat__reply"] });
	const r = uninstall(f);
	assert.equal(r.mode, "restaurado-exacto");
	assert.equal(readFileSync(settings(f), "utf8"), PRIOR);
});

test(".claude existente con otros archivos y sin settings.local.json: se borra sólo el archivo del kit", () => {
	const f = folder();
	mkdirSync(join(f, ".claude"));
	writeFileSync(join(f, ".claude", "settings.json"), "{}");
	install(f, { bunPath });
	uninstall(f);
	assert.equal(existsSync(settings(f)), false);
	assert.equal(readFileSync(join(f, ".claude", "settings.json"), "utf8"), "{}");
});

test("con cambios concurrentes: sólo se quitan los hooks del kit y se conservan los cambios ajenos", () => {
	const f = folder();
	mkdirSync(join(f, ".claude"));
	writeFileSync(settings(f), PRIOR);
	install(f, { bunPath });
	// Simulate Claude saving a "don't ask again" permission and a new user hook during the test.
	const s = JSON.parse(readFileSync(settings(f), "utf8"));
	s.permissions.allow.push("Read(./notes.md)");
	s.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "echo externo" }] });
	writeFileSync(settings(f), JSON.stringify(s, null, 2));
	const r = uninstall(f);
	assert.match(r.mode, /sólo-hooks-del-kit/);
	const after = JSON.parse(readFileSync(settings(f), "utf8"));
	assert.deepEqual(after.permissions.allow, ["mcp__plugin_fakechat_fakechat__reply", "Read(./notes.md)"]);
	assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: "command", command: "echo mía" }] }]);
	assert.deepEqual(after.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: "echo externo" }] }]);
	assert.equal(JSON.stringify(after).includes(".poc0/hook-logger.mjs"), false);
	assert.equal(after.zz, 1);
});

test("sin archivo previo pero con cambios concurrentes: se conserva lo ajeno", () => {
	const f = folder();
	install(f, { bunPath });
	const s = JSON.parse(readFileSync(settings(f), "utf8"));
	s.permissions = { allow: ["Read(./x)"] };
	writeFileSync(settings(f), JSON.stringify(s));
	uninstall(f);
	assert.deepEqual(JSON.parse(readFileSync(settings(f), "utf8")), { permissions: { allow: ["Read(./x)"] } });
});

test("instalar dos veces falla sin tocar nada", () => {
	const f = folder();
	install(f, { bunPath });
	const before = readFileSync(settings(f));
	assert.throws(() => install(f, { bunPath }), /ya están instalados/);
	assert.deepEqual(readFileSync(settings(f)), before);
});

test("settings.local.json inválido: install se niega", () => {
	const f = folder();
	mkdirSync(join(f, ".claude"));
	writeFileSync(settings(f), "{ no es json");
	assert.throws(() => install(f, { bunPath }), /no es JSON válido/);
	assert.equal(readFileSync(settings(f), "utf8"), "{ no es json");
});

// The owner's Mac has the PREVIOUS kit installed (logger only on
// UserPromptSubmit). The new manage.mjs must retire it, keep every log, and
// then install the new kit with the probe.
function oldInstall(f, prior) {
	const poc = join(f, ".poc0");
	mkdirSync(join(poc, "out"), { recursive: true });
	const h = { type: "command", command: `"${bunPath}" "${join(poc, "hook-logger.mjs")}"`, timeout: 5 };
	const fz = "mcp__plugin_fakechat_fakechat__.*";
	const base = prior === null ? {} : JSON.parse(prior);
	base.hooks = base.hooks ?? {};
	for (const [ev, entry] of Object.entries({ SessionStart: { hooks: [h] }, UserPromptSubmit: { hooks: [h] }, Stop: { hooks: [h] }, StopFailure: { hooks: [h] },
		Notification: { hooks: [h] }, PostToolUse: { matcher: fz, hooks: [h] }, PostToolUseFailure: { matcher: fz, hooks: [h] } })) base.hooks[ev] = [...(base.hooks[ev] ?? []), entry];
	mkdirSync(join(f, ".claude"), { recursive: true });
	const after = `${JSON.stringify(base, null, 2)}\n`;
	writeFileSync(settings(f), after);
	if (prior !== null) writeFileSync(join(poc, "settings.local.json.before"), prior);
	const sha = (b) => createHash("sha256").update(b).digest("hex");
	writeFileSync(join(poc, "installed.json"), JSON.stringify({ existed: prior !== null, createdClaudeDir: false, beforeSha: prior === null ? null : sha(prior), afterSha: sha(after), bunPath }));
	for (const x of ["hook-logger.mjs", "send.mjs", "report.mjs", "idle.mjs", "classify.mjs"]) writeFileSync(join(poc, x), "// viejo");
	writeFileSync(join(poc, "out", "hooks.jsonl"), '{"event":"UserPromptSubmit"}\n');
	writeFileSync(join(poc, "out", "sends-T.jsonl"), '{"id":"P0T01-f9dfb6"}\n');
}

test("kit anterior instalado: el manage nuevo lo retira byte por byte, conserva los logs e instala la sonda", () => {
	const f = folder();
	oldInstall(f, PRIOR);
	const logsBefore = readFileSync(join(f, ".poc0", "out", "hooks.jsonl"), "utf8") + readFileSync(join(f, ".poc0", "out", "sends-T.jsonl"), "utf8");
	const r = uninstall(f);
	assert.equal(r.mode, "restaurado-exacto");
	assert.equal(readFileSync(settings(f), "utf8"), PRIOR);
	assert.equal(existsSync(join(f, ".poc0", "hook-logger.mjs")), false);
	assert.equal(readFileSync(join(f, ".poc0", "out", "hooks.jsonl"), "utf8") + readFileSync(join(f, ".poc0", "out", "sends-T.jsonl"), "utf8"), logsBefore);
	install(f, { bunPath });
	const s = JSON.parse(readFileSync(settings(f), "utf8"));
	assert.equal(s.hooks.UserPromptSubmit.at(-1).hooks.length, 2);
	assert.equal(uninstall(f).mode, "restaurado-exacto");
	assert.equal(readFileSync(settings(f), "utf8"), PRIOR);
});

test("kit anterior + permiso guardado por Claude durante T: se quitan sólo los hooks del kit", () => {
	const f = folder();
	oldInstall(f, PRIOR);
	const cur = JSON.parse(readFileSync(settings(f), "utf8"));
	cur.permissions.allow.push("Bash(ls:*)");
	writeFileSync(settings(f), JSON.stringify(cur));
	const r = uninstall(f);
	assert.match(r.mode, /sólo-hooks-del-kit-quitados/);
	const s = JSON.parse(readFileSync(settings(f), "utf8"));
	assert.deepEqual(s.permissions.allow, ["mcp__plugin_fakechat_fakechat__reply", "Bash(ls:*)"]);
	assert.equal(JSON.stringify(s).includes(".poc0/"), false);
	assert.deepEqual(s.hooks, { Stop: [{ hooks: [{ type: "command", command: "echo mía" }] }] });
});
