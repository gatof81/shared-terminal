#!/usr/bin/env bun
// Install / check / uninstall the phase-0 diagnostic hooks in ONE test folder.
//   bun manage.mjs install   <test-folder>
//   bun manage.mjs check     <test-folder>
//   bun manage.mjs uninstall <test-folder> [--purge-logs]
// Touches only <test-folder>/.claude/settings.local.json and <test-folder>/.poc0/.
// Never ~/.claude, never global settings, never credentials.
//
// Uninstall restores the previous settings.local.json BYTE FOR BYTE (or removes
// it, and the .claude dir if install created it and it is empty) when the file
// is exactly as install left it. If anything else changed it meanwhile — e.g.
// Claude saved a "don't ask again" permission — only this kit's hook entries
// are removed and every external change is kept.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = dirname(fileURLToPath(import.meta.url));
const MARK = ".poc0/hook-logger.mjs";
export const FILES = ["hook-logger.mjs", "send.mjs", "report.mjs", "idle.mjs", "classify.mjs", "events.mjs", "rediagnose.mjs"];
const sha = (b) => createHash("sha256").update(b).digest("hex");

export function paths(folder) {
	const root = realpathSync(folder);
	return { root, poc: join(root, ".poc0"), claudeDir: join(root, ".claude"), settings: join(root, ".claude", "settings.local.json") };
}

function parse(bytes, where) {
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`${where} no es JSON válido: no se toca`);
	}
}
const isOurs = (entry) => (entry?.hooks ?? []).some((h) => String(h.command ?? "").includes(MARK));
const atomicWrite = (p, data) => {
	const tmp = `${p}.poc0tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, p);
};

// Events and why: UserPromptSubmit = arrival/acceptance evidence; Stop /
// StopFailure = turn end; SessionStart = which conversation; PostToolUse(Failure)
// on Fakechat's tools = the reply went back; Notification = a permission dialog.
export function ourEntries(poc, bunPath) {
	const h = { type: "command", command: `"${bunPath}" "${join(poc, "hook-logger.mjs")}"`, timeout: 5 };
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

export function stripOurs(obj) {
	const s = structuredClone(obj);
	for (const ev of Object.keys(s.hooks ?? {})) {
		s.hooks[ev] = (s.hooks[ev] ?? []).filter((e) => !isOurs(e));
		if (s.hooks[ev].length === 0) delete s.hooks[ev];
	}
	if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
	return s;
}

export function install(folder, { bunPath = process.execPath, kitDir = KIT } = {}) {
	const p = paths(folder);
	if (p.root === realpathSync(homedir()) || p.root === "/") throw new Error("la carpeta de prueba no puede ser tu HOME ni /");
	const existed = existsSync(p.settings);
	const before = existed ? readFileSync(p.settings) : null;
	const s = existed ? parse(before, p.settings) : {};
	if (Object.values(s.hooks ?? {}).flat().some(isOurs) || existsSync(join(p.poc, "installed.json")))
		throw new Error("los hooks de diagnóstico ya están instalados (usar 'check' o 'uninstall')");
	const createdClaudeDir = !existsSync(p.claudeDir);
	mkdirSync(join(p.poc, "out"), { recursive: true });
	for (const f of FILES) copyFileSync(join(kitDir, f), join(p.poc, f));
	if (existed) writeFileSync(join(p.poc, "settings.local.json.before"), before);
	s.hooks = s.hooks ?? {};
	for (const [ev, entry] of Object.entries(ourEntries(p.poc, bunPath))) s.hooks[ev] = [...(s.hooks[ev] ?? []), entry];
	mkdirSync(p.claudeDir, { recursive: true });
	const after = Buffer.from(`${JSON.stringify(s, null, 2)}\n`);
	atomicWrite(p.settings, after);
	const meta = { at: new Date().toISOString(), existed, createdClaudeDir, beforeSha: before ? sha(before) : null, afterSha: sha(after), bunPath };
	writeFileSync(join(p.poc, "installed.json"), `${JSON.stringify(meta, null, 2)}\n`);
	return meta;
}

export function uninstall(folder, { purgeLogs = false } = {}) {
	const p = paths(folder);
	const metaPath = join(p.poc, "installed.json");
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
	const current = existsSync(p.settings) ? readFileSync(p.settings) : null;
	let mode;
	if (meta && current && sha(current) === meta.afterSha) {
		if (meta.existed) {
			const before = readFileSync(join(p.poc, "settings.local.json.before"));
			if (sha(before) !== meta.beforeSha) throw new Error("la copia previa de settings.local.json no coincide con su hash: no se restaura");
			atomicWrite(p.settings, before);
		} else {
			rmSync(p.settings);
			if (meta.createdClaudeDir && readdirSync(p.claudeDir).length === 0) rmdirSync(p.claudeDir);
		}
		mode = "restaurado-exacto";
	} else if (!current) {
		mode = "archivo-ausente";
	} else {
		const s = stripOurs(parse(current, p.settings));
		if (meta && !meta.existed && Object.keys(s).length === 0) {
			rmSync(p.settings);
			if (meta.createdClaudeDir && readdirSync(p.claudeDir).length === 0) rmdirSync(p.claudeDir);
		} else atomicWrite(p.settings, `${JSON.stringify(s, null, 2)}\n`);
		mode = "sólo-hooks-del-kit-quitados (cambios ajenos conservados)";
	}
	for (const f of [...FILES, "installed.json", "settings.local.json.before"]) rmSync(join(p.poc, f), { force: true });
	if (purgeLogs) rmSync(p.poc, { recursive: true, force: true });
	return { mode, settingsSha: existsSync(p.settings) ? sha(readFileSync(p.settings)) : null };
}

export function check(folder) {
	const p = paths(folder);
	const s = existsSync(p.settings) ? parse(readFileSync(p.settings), p.settings) : {};
	const events = Object.entries(s.hooks ?? {}).filter(([, list]) => list.some(isOurs)).map(([e]) => e);
	const meta = JSON.parse(readFileSync(join(p.poc, "installed.json"), "utf8"));
	// Self-test on a scratch copy of the logger whose output goes to a temporary
	// dir: never to the real hooks.jsonl, never through Claude.
	const scratch = join(p.poc, "selftest");
	mkdirSync(scratch, { recursive: true });
	copyFileSync(join(p.poc, "hook-logger.mjs"), join(scratch, "hook-logger.mjs"));
	const r = spawnSync(meta.bunPath, [join(scratch, "hook-logger.mjs")], {
		input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "selftest", prompt: "x", source: "user" }),
		encoding: "utf8",
	});
	const wrote = existsSync(join(scratch, "out", "hooks.jsonl"));
	rmSync(scratch, { recursive: true, force: true });
	return { events, exit: r.status, stdout: r.stdout, wrote };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [cmd, folder, ...rest] = process.argv.slice(2);
	try {
		if (!folder || !existsSync(folder)) throw new Error("uso: bun manage.mjs install|check|uninstall <carpeta-de-prueba>");
		if (cmd === "install") {
			install(folder);
			console.log(`instalado en ${paths(folder).settings}; scripts y logs en ${paths(folder).poc}`);
		} else if (cmd === "check") {
			const c = check(folder);
			console.log(`eventos con el logger: ${c.events.join(", ") || "ninguno"}`);
			console.log(`autotest: exit=${c.exit} stdout=${JSON.stringify(c.stdout)} escribió=${c.wrote} (debe ser exit=0, stdout "" y escribió=true)`);
			if (c.exit !== 0 || c.stdout !== "" || !c.wrote || c.events.length !== 7) process.exit(1);
		} else if (cmd === "uninstall") {
			const u = uninstall(folder, { purgeLogs: rest.includes("--purge-logs") });
			console.log(`desinstalado: ${u.mode}; settings.local.json ${u.settingsSha ? `sha256 ${u.settingsSha.slice(0, 12)}` : "eliminado"}`);
		} else throw new Error("uso: bun manage.mjs install|check|uninstall <carpeta-de-prueba>");
	} catch (e) {
		console.error(`ABORT: ${e.message}`);
		process.exit(1);
	}
}
