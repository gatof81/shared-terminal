// Regression 1: uninstall restores settings.local.json byte for byte when
// nothing else changed it, and removes only the kit's hooks otherwise.
import assert from "node:assert/strict";
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
