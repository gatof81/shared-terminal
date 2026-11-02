#!/usr/bin/env bun
// Install / uninstall / check the phase-0 diagnostic hooks in ONE test folder.
//   bun manage.mjs install   <test-folder>
//   bun manage.mjs check     <test-folder>
//   bun manage.mjs uninstall <test-folder> [--purge-logs]
// Touches only <test-folder>/.claude/settings.local.json (merging: existing
// keys and hooks are kept; only entries whose command points at this kit's
// hook-logger.mjs are added or removed) and <test-folder>/.poc0/. Never
// ~/.claude, never global settings, never credentials.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = dirname(fileURLToPath(import.meta.url));
const MARK = ".poc0/hook-logger.mjs";
const FILES = ["hook-logger.mjs", "send.mjs", "report.mjs"];
const die = (m) => {
	console.error(`ABORT: ${m}`);
	process.exit(1);
};
const [cmd, folderArg, ...rest] = process.argv.slice(2);
if (!["install", "check", "uninstall"].includes(cmd) || !folderArg) die("uso: bun manage.mjs install|check|uninstall <carpeta-de-prueba>");
if (!existsSync(folderArg)) die(`no existe ${folderArg}`);
const folder = realpathSync(folderArg);
if (folder === realpathSync(homedir()) || folder === "/") die("la carpeta de prueba no puede ser tu HOME ni /");
const poc = join(folder, ".poc0");
const settingsPath = join(folder, ".claude", "settings.local.json");
const bun = process.execPath;

function readSettings() {
	if (!existsSync(settingsPath)) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch {
		die(`${settingsPath} no es JSON válido: no se toca`);
	}
}
// Hook events and why: UserPromptSubmit = arrival/acceptance evidence; Stop /
// StopFailure = turn end; SessionStart = which conversation; PostToolUse(Failure)
// restricted to fakechat's tools = the reply went back; Notification = a
// permission dialog appeared (human intervention).
function ourEntries() {
	const command = `"${bun}" "${join(poc, "hook-logger.mjs")}"`;
	const h = { type: "command", command, timeout: 5 };
	return {
		SessionStart: { hooks: [h] },
		UserPromptSubmit: { hooks: [h] },
		Stop: { hooks: [h] },
		StopFailure: { hooks: [h] },
		Notification: { hooks: [h] },
		PostToolUse: { matcher: "mcp__plugin_fakechat_fakechat__.*", hooks: [h] },
		PostToolUseFailure: { matcher: "mcp__plugin_fakechat_fakechat__.*", hooks: [h] },
	};
}
const isOurs = (entry) => (entry?.hooks ?? []).some((h) => String(h.command ?? "").includes(MARK));
const write = (obj) => {
	mkdirSync(dirname(settingsPath), { recursive: true });
	const tmp = `${settingsPath}.poc0tmp`;
	writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
	renameSync(tmp, settingsPath);
};

if (cmd === "install") {
	const s = readSettings();
	if (Object.values(s.hooks ?? {}).flat().some(isOurs)) die("los hooks de diagnóstico ya están instalados (usar 'check')");
	mkdirSync(join(poc, "out"), { recursive: true });
	for (const f of FILES) copyFileSync(join(KIT, f), join(poc, f));
	if (existsSync(settingsPath)) copyFileSync(settingsPath, join(poc, "settings.local.json.before"));
	s.hooks = s.hooks ?? {};
	for (const [ev, entry] of Object.entries(ourEntries())) s.hooks[ev] = [...(s.hooks[ev] ?? []), entry];
	write(s);
	writeFileSync(join(poc, "installed.json"), `${JSON.stringify({ at: new Date().toISOString(), folder, bun, settingsPath, hadSettings: existsSync(join(poc, "settings.local.json.before")) }, null, 2)}\n`);
	console.log(`hooks de diagnóstico instalados en ${settingsPath}\nscripts y logs en ${poc}`);
}

if (cmd === "check") {
	const s = readSettings();
	const evs = Object.entries(s.hooks ?? {}).filter(([, list]) => list.some(isOurs)).map(([e]) => e);
	console.log(`eventos con el logger: ${evs.join(", ") || "ninguno"}`);
	const log = join(poc, "out", "hooks.jsonl");
	if (existsSync(log)) {
		const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
		console.log(`hooks.jsonl: ${lines.length} líneas; último: ${lines.at(-1)?.slice(0, 160) ?? "—"}`);
	} else console.log("hooks.jsonl todavía no existe (ningún hook disparó en esta carpeta)");
	// Self-test of the logger with a synthetic payload, written to a scratch
	// file, never to hooks.jsonl, and without starting Claude.
	const r = spawnSync(bun, [join(poc, "hook-logger.mjs")], {
		input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "selftest", prompt: "x", source: "user" }),
		encoding: "utf8",
	});
	console.log(`autotest del logger: exit=${r.status} stdout=${JSON.stringify(r.stdout)} (debe ser exit=0 y stdout vacío)`);
	if (existsSync(log)) {
		const lines = readFileSync(log, "utf8").trim().split("\n");
		if (lines.at(-1).includes('"session_id":"selftest"')) writeFileSync(log, `${lines.slice(0, -1).join("\n")}${lines.length > 1 ? "\n" : ""}`);
	}
}

if (cmd === "uninstall") {
	const s = readSettings();
	for (const ev of Object.keys(s.hooks ?? {})) {
		s.hooks[ev] = s.hooks[ev].filter((e) => !isOurs(e));
		if (s.hooks[ev].length === 0) delete s.hooks[ev];
	}
	if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
	const hadBefore = existsSync(join(poc, "settings.local.json.before"));
	if (!hadBefore && Object.keys(s).length === 0) rmSync(settingsPath, { force: true });
	else write(s);
	for (const f of [...FILES, "installed.json", "settings.local.json.before"]) rmSync(join(poc, f), { force: true });
	if (rest.includes("--purge-logs")) rmSync(poc, { recursive: true, force: true });
	console.log(`hooks de diagnóstico retirados de ${settingsPath}${rest.includes("--purge-logs") ? "; logs borrados" : `; logs conservados en ${join(poc, "out")}`}`);
	const digest = existsSync(settingsPath) ? createHash("sha256").update(readFileSync(settingsPath)).digest("hex").slice(0, 12) : "eliminado";
	console.log(`settings.local.json ahora: ${digest}`);
}
