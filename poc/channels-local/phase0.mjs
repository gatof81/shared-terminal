#!/usr/bin/env bun
// Phase 0 of the Project Chat Channels POC, local variant (macOS / Linux).
// Runs ONLY as a temporary, non-admin OS user created for the test, from that
// user's own HOME. Subcommands, in order:
//   setup        write ~/.claude/settings.json, install fakechat, check pin, install deps
//   preflight    S0 evidence (before /login): isolation and no existing credentials
//   registration after /login + relaunch with --channels: did the channel register?
//   wake         --count N --min-idle S : idle-wake samples, one message each, never retried
//   report       four-dimension report (registration, wake, source, correlation)
//   archive      redacted copy of ~/poc/out to a shared folder for the owner
// Design: docs/design/project-chat/04-poc.md §1.7 (PR #512). Nothing here touches
// Docker, Shared Terminal, Proxmox or the owner's own Claude Code setup.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_VERSION = "2.1.314";
const BUN_VERSION = "1.3.10";
const FAKECHAT_COMMIT = "7994c270e575fa82bc86b3e99363bf8fe55292f7";
const CHANNEL = "plugin:fakechat@claude-plugins-official";
const PORT = Number(process.env.FAKECHAT_PORT ?? 18787);
const HOME = homedir();
const POC = join(HOME, "poc");
const OUT = join(POC, "out");
const KIT = dirname(fileURLToPath(import.meta.url));
const IS_MAC = platform() === "darwin";

const sh = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, ...opts });
	return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? r.error?.message ?? "" };
};
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const die = (m) => {
	console.error(`ABORT: ${m}`);
	process.exit(1);
};
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (p) =>
	existsSync(p)
		? readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => {
				try {
					return [JSON.parse(l)];
				} catch {
					return [];
				}
			})
		: [];
const hooks = () => readJsonl(join(OUT, "hooks.jsonl"));
const evName = (r) => r?.event?.hook_event_name;
const which = (c) => sh("/bin/sh", ["-c", `command -v ${c}`]).out.trim();
const underHome = (p) => p !== "" && !relative(HOME, p).startsWith("..");

function assertTempUser() {
	const u = userInfo().username;
	if (!/^poc/.test(u)) die(`este kit sólo corre como el usuario temporal (poc…); usuario actual: ${u}`);
	if (!HOME.endsWith(u)) die(`HOME inesperado: ${HOME}`);
}

function findFakechatDirs() {
	const root = join(HOME, ".claude", "plugins");
	const found = [];
	const walk = (d, depth) => {
		if (depth > 8 || !existsSync(d)) return;
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory() && e.name !== "node_modules") walk(p, depth + 1);
			else if (e.name === "server.ts" && p.includes("fakechat")) found.push(dirname(p));
		}
	};
	walk(root, 0);
	return [...new Set(found)];
}

// The pin is the exact FILE SET plus each file's hash: an extra file (hooks/,
// skills/, commands/ are auto-discovered by the CLI) would run unpinned code
// while every listed hash still matched.
function listFiles(dir) {
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.name === "node_modules" || e.name === ".git") continue;
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(relative(dir, p));
		}
	};
	walk(dir);
	return out.sort();
}

export function checkManifest(dir) {
	const lines = readFileSync(join(KIT, "manifest.sha256"), "utf8").trim().split("\n");
	const expected = lines.map((l) => l.split(/\s+/)[1]).sort();
	const actual = listFiles(dir);
	const extra = actual.filter((f) => !expected.includes(f));
	const res = lines.map((l) => {
		const [hash, file] = l.split(/\s+/);
		const p = join(dir, file);
		return { file, ok: existsSync(p) && sha256(p) === hash };
	});
	for (const f of extra) res.push({ file: `${f} (archivo fuera del commit fijado)`, ok: false });
	return res;
}

// ── setup ───────────────────────────────────────────────────────────────
function setup() {
	assertTempUser();
	mkdirSync(join(POC, "workspace"), { recursive: true });
	mkdirSync(OUT, { recursive: true });
	const bun = which("bun");
	if (!underHome(bun)) die(`bun debe estar instalado en el HOME del usuario temporal (encontrado: ${bun || "ninguno"})`);
	const settingsPath = join(HOME, ".claude", "settings.json");
	const tpl = readFileSync(join(KIT, "settings.template.json"), "utf8")
		.replaceAll("__BUN__", bun)
		.replaceAll("__HOOK__", join(KIT, "hook.mjs"));
	if (existsSync(settingsPath) && readFileSync(settingsPath, "utf8") !== tpl)
		die(`${settingsPath} ya existe con otro contenido: el HOME no es nuevo`);
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, tpl);
	console.log(`settings escritos en ${settingsPath}`);

	const claude = which("claude");
	if (!underHome(claude)) die(`claude debe ser el instalado en el HOME del usuario temporal (encontrado: ${claude || "ninguno"})`);
	for (const args of [
		["plugin", "marketplace", "add", "anthropics/claude-plugins-official"],
		["plugin", "install", "fakechat@claude-plugins-official"],
	]) {
		const r = sh(claude, args, { cwd: join(POC, "workspace") });
		writeFileSync(join(OUT, `setup-${args[1]}.log`), `${r.out}\n${r.err}`);
		if (r.code !== 0)
			die(`'claude ${args.join(" ")}' falló (ver ${OUT}). Si exige login, no es NO-GO: repetir 'setup' después del /login.`);
	}
	const dirs = findFakechatDirs();
	if (dirs.length === 0) die("fakechat no quedó instalado");
	const report = [];
	for (const d of dirs) {
		const res = checkManifest(d);
		report.push(`${d}\n${res.map((x) => `  ${x.ok ? "OK  " : "FAIL"} ${x.file}`).join("\n")}`);
		if (res.some((x) => !x.ok)) {
			writeFileSync(join(OUT, "manifest-check.txt"), report.join("\n"));
			die(`los archivos de ${d} no coinciden con ${FAKECHAT_COMMIT}: no se continúa`);
		}
		const lockBefore = sha256(join(d, "bun.lock"));
		const r = sh(bun, ["install", "--frozen-lockfile", "--no-summary"], { cwd: d });
		writeFileSync(join(OUT, "bun-install.log"), `${r.out}\n${r.err}`, { flag: "a" });
		if (r.code !== 0) die(`bun install --frozen-lockfile falló en ${d}`);
		if (sha256(join(d, "bun.lock")) !== lockBefore) die("bun install cambió bun.lock: no se continúa");
	}
	writeFileSync(join(OUT, "manifest-check.txt"), report.join("\n"));
	const lock = readFileSync(join(dirs[0], "bun.lock"), "utf8");
	const pkgs = [...lock.matchAll(/^\s{4}"[^"]+": \["([^"]+)"/gm)].map((m) => m[1]);
	writeFileSync(join(OUT, "deps.txt"), `${pkgs.length} paquetes (bun.lock, integridad sha512 verificada por --frozen-lockfile)\n${pkgs.join("\n")}\n`);
	console.log(`fakechat OK en ${dirs.length} copia(s); ${pkgs.length} dependencias en ${join(OUT, "deps.txt")}`);
}

// ── preflight (S0 evidence) ─────────────────────────────────────────────
async function portFree(port) {
	return new Promise((res) => {
		const s = createServer();
		s.once("error", () => res(false));
		s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
	});
}

async function preflight() {
	assertTempUser();
	const rows = [];
	const row = (name, ok, detail = "") => rows.push({ name, res: ok === null ? "INFO" : ok ? "PASS" : "FAIL", detail });
	const u = userInfo().username;
	const groups = sh("id", ["-Gn"]).out.trim().split(/\s+/);
	row("usuario temporal (no el habitual)", /^poc/.test(u), `${u}, HOME=${HOME}`);
	row("sin privilegios de administración", !groups.some((g) => ["admin", "sudo", "wheel", "root"].includes(g)), groups.join(" "));
	row("no pertenece al grupo docker", !groups.includes("docker"), "");
	const docker = which("docker");
	row("sin acceso a Docker", docker === "" || sh(docker, ["ps"]).code !== 0, docker ? "docker existe pero 'docker ps' falla" : "docker no está en el PATH");
	for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
		"CLAUDE_CONFIG_DIR", "CLOUDFLARE_API_TOKEN", "JWT_SECRET", "SECRETS_ENCRYPTION_KEY"])
		row(`variable ${v} ausente`, !process.env[v]);
	row("sin credenciales de Claude previas (archivo)", !existsSync(join(HOME, ".claude", ".credentials.json")));
	const cj = join(HOME, ".claude.json");
	row("sin cuenta previa en ~/.claude.json", !existsSync(cj) || !readFileSync(cj, "utf8").includes("oauthAccount"));
	if (IS_MAC)
		row("sin credenciales de Claude en el llavero de este usuario",
			sh("security", ["find-generic-password", "-s", "Claude Code-credentials"]).code !== 0);
	row("sin claves SSH en este usuario", !existsSync(join(HOME, ".ssh")) || readdirSync(join(HOME, ".ssh")).length === 0);
	const managed = IS_MAC
		? ["/Library/Application Support/ClaudeCode/managed-settings.json", "/Library/Application Support/ClaudeCode/managed-settings.d"]
		: ["/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-settings.d"];
	const present = managed.filter((p) => existsSync(p));
	row("sin managed settings de la máquina (afectarían la prueba)", present.length === 0, present.join(", ") || "ninguno");
	const claude = which("claude");
	const v = claude ? sh(claude, ["--version"]).out.trim() : "";
	row(`claude del usuario temporal, versión ${CLI_VERSION}`, underHome(claude) && v.startsWith(CLI_VERSION), `${claude} → ${v}`);
	const bun = which("bun");
	const bv = bun ? sh(bun, ["--version"]).out.trim() : "";
	row(`bun del usuario temporal, versión ${BUN_VERSION}`, underHome(bun) && bv === BUN_VERSION, `${bun} → ${bv}`);
	const settings = join(HOME, ".claude", "settings.json");
	let s = {};
	try {
		s = JSON.parse(readFileSync(settings, "utf8"));
	} catch {}
	row("settings del usuario temporal: hooks a archivo", !!s.hooks?.UserPromptSubmit && !!s.hooks?.Stop, settings);
	row("sin modo bypass de permisos", s.permissions?.defaultMode !== "bypassPermissions" && !s.permissions?.allow?.includes("Bash"), "");
	row("variables DISABLE_AUTOUPDATER y DISABLE_EXTRA_USAGE_COMMAND presentes (el uso extra lo confirma el responsable en su cuenta)", s.env?.DISABLE_AUTOUPDATER === "1" && s.env?.DISABLE_EXTRA_USAGE_COMMAND === "1");
	row("login forzado a cuenta de Claude (forceLoginMethod=claudeai)", s.forceLoginMethod === "claudeai");
	const dirs = findFakechatDirs();
	if (process.argv.includes("--before-plugin")) {
		row("fakechat", null, "pendiente: se instala con 'setup' después del /login (claude plugin exigió login)");
	} else {
		row(`fakechat idéntico a ${FAKECHAT_COMMIT.slice(0, 7)}`, dirs.length > 0 && dirs.every((d) => checkManifest(d).every((x) => x.ok)), dirs.join(", "));
		row("dependencias de fakechat instaladas desde el lockfile", existsSync(join(OUT, "deps.txt")), "ver deps.txt");
	}
	row(`puerto ${PORT} libre en 127.0.0.1`, await portFree(PORT));
	row("Shared Terminal / Proxmox / Docker: el kit no los usa", null, "no hay ninguna llamada a docker, ssh ni a hosts que no sean de Anthropic o GitHub");

	const md = [`# Fase 0 — preflight (S0) — ${now()}`, "", `Sistema: ${platform()} · usuario ${u}`, "",
		"| Comprobación | Resultado | Detalle |", "| --- | --- | --- |",
		...rows.map((r) => `| ${r.name} | ${r.res} | ${String(r.detail).replaceAll("|", "\\|")} |`)];
	mkdirSync(OUT, { recursive: true });
	writeFileSync(join(OUT, "preflight.md"), `${md.join("\n")}\n`);
	console.log(md.join("\n"));
	if (rows.some((r) => r.res === "FAIL")) {
		console.error("\nPreflight con FAIL: no seguir con el /login.");
		process.exit(1);
	}
}

// ── registration ────────────────────────────────────────────────────────
// Only availability/policy reasons are a NO-GO; any other skip (the plugin's
// server failed to start, port in use…) is a harness failure, because a NO-GO
// is final and must never come from our own setup.
const POLICY = /not currently available|not enabled for your org|channelsEnabled|not on the approved|approved channels|third-party|Bedrock|Vertex|Foundry/i;

function listenerPid(port) {
	const l = sh("/bin/sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || ss -ltnpH "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'`]).out.trim();
	return l.split(/\s+/)[0] || "";
}
function ancestors(pid) {
	const chain = [];
	let cur = pid;
	for (let i = 0; i < 20 && cur && cur !== "1" && cur !== "0"; i++) {
		chain.push(cur);
		cur = sh("ps", ["-o", "ppid=", "-p", cur]).out.trim();
	}
	return chain;
}

async function registration() {
	assertTempUser();
	const log = join(OUT, "claude-debug.log");
	let reg = "unknown";
	let line = "";
	for (let i = 0; i < 30 && reg === "unknown"; i++) {
		const t = existsSync(log) ? readFileSync(log, "utf8") : "";
		const lines = t.split("\n").filter((x) => /[Cc]hannel/.test(x));
		const ok = lines.find((x) => x.includes("Channel notifications registered") && x.includes("fakechat"));
		const skip = lines.find((x) => /Channel notifications skipped|Channel gate says skip|not currently available|Channels are not/.test(x));
		if (ok) {
			reg = "registered";
			line = ok;
		} else if (skip) {
			reg = POLICY.test(skip) ? "skipped" : "harness-skip";
			line = skip;
		} else await sleep(2000);
	}
	let http = "none";
	try {
		http = String((await fetch(`http://127.0.0.1:${PORT}/`)).status);
	} catch {}
	// The listener must belong to THIS claude (a fakechat left by the login
	// session would answer 204 and deliver into a dead CLI).
	const p = probe();
	const lp = listenerPid(PORT);
	const owned = !!p.pid && !!lp && ancestors(lp).includes(String(p.pid));
	writeFileSync(join(OUT, "registration.txt"),
		`registration=${reg}\nfakechat_http=${http}\nlistener_pid=${lp}\nclaude_pid=${p.pid ?? ""}\nlistener_owned=${owned}\nat=${now()}\n`);
	writeFileSync(join(OUT, "channel-line.log"), `${redactText(line)}\n`);
	console.log(`registro: ${reg} · fakechat HTTP ${http} · puerto de este claude: ${owned}`);
	if (reg === "skipped") {
		console.log("NO-GO: Channels no está disponible para esta suscripción. Detener la fase 0. No cambiar a API.");
		process.exit(3);
	}
	if (reg !== "registered" || http !== "200" || !owned) {
		console.log("Fallo del harness (no NO-GO): ver channel-line.log / registration.txt y repetir el paso 7.");
		process.exit(4);
	}
}

// ── wake ────────────────────────────────────────────────────────────────
function probe() {
	const claude = which("claude");
	const r = sh(claude, ["agents", "--json"]);
	let data;
	try {
		data = JSON.parse(r.out);
	} catch {
		return { ok: false, detail: `probe-error:${r.err.slice(0, 120)}` };
	}
	const list = Array.isArray(data) ? data : data.agents ?? data.sessions ?? [];
	const inter = list.filter((e) => (e.kind ?? "interactive") === "interactive");
	if (inter.length !== 1) return { ok: false, detail: `interactive=${inter.length}` };
	const { status, waitingFor, pid } = inter[0];
	const ok = status === "idle" || (status === "waiting" && waitingFor === "input needed");
	return { ok, pid, detail: `status=${status} waitingFor=${waitingFor ?? ""}` };
}

async function waitIdle(minIdle, limitS) {
	const end = Date.now() + limitS * 1000;
	while (Date.now() < end) {
		const rows = hooks();
		if (rows.some((r) => evName(r) === "StopFailure")) return { ok: false, detail: "stop-failure-present" };
		const last = Math.max(0, ...rows.map((r) => r.recv_ts));
		const lastUps = Math.max(0, ...rows.filter((r) => evName(r) === "UserPromptSubmit").map((r) => r.recv_ts));
		const lastStop = Math.max(0, ...rows.filter((r) => evName(r) === "Stop").map((r) => r.recv_ts));
		const p = probe();
		const idleFor = last ? Date.now() / 1000 - last : null;
		if (p.ok && lastUps <= lastStop && (idleFor === null || idleFor >= minIdle)) return { ok: true, detail: p.detail, idleFor };
		await sleep(10_000);
	}
	return { ok: false, detail: "idle-timeout" };
}

async function wake(args) {
	assertTempUser();
	const count = Number(args[args.indexOf("--count") + 1]);
	const minIdle = Number(args[args.indexOf("--min-idle") + 1]);
	if (!(count > 0) || !(minIdle >= 0)) die("uso: wake --count N --min-idle S");
	const label = minIdle >= 3600 ? "long" : "short";
	const reg = existsSync(join(OUT, "registration.txt")) ? readFileSync(join(OUT, "registration.txt"), "utf8") : "";
	if (!reg.includes("registration=registered") || !reg.includes("listener_owned=true")) die("primero 'registration' con resultado registrado");
	if (!hooks().some((r) => evName(r) === "SessionStart")) die("no hay ningún SessionStart en hooks.jsonl: los hooks no funcionan (fallo del harness)");
	const file = join(OUT, `sends-${label}.jsonl`);
	const append = (o) => writeFileSync(file, `${JSON.stringify(o)}\n`, { flag: "a" });
	for (let i = 1; i <= count; i++) {
		const w = await waitIdle(minIdle, minIdle + 900);
		if (!w.ok) {
			append({ label, n: i, result: "not-sent", reason: w.detail });
			console.log(`#${i} no enviado: ${w.detail}`);
			process.exit(6);
		}
		const mid = `poc-${label}-${i}-${randomBytes(3).toString("hex")}`;
		const text = `Prueba de fase 0 ${mid}: respondé solamente OK-${i}.`;
		const before = hooks();
		const seen = new Set(before.map((r) => JSON.stringify(r)));
		const priorPromptIds = new Set(before.map((r) => r.event?.prompt_id).filter(Boolean));
		const sentAt = Date.now() / 1000;
		let http = "error";
		try {
			const fd = new FormData();
			fd.set("id", mid);
			fd.set("text", text);
			http = String((await fetch(`http://127.0.0.1:${PORT}/upload`, { method: "POST", body: fd })).status);
		} catch (e) {
			http = `error:${e.message}`;
		}
		const rec = { label, n: i, msg_id: mid, sent_at: sentAt, idle_before_s: w.idleFor, probe_before: w.detail, upload_http: http };
		if (http !== "204") {
			append({ ...rec, result: "harness-error", reason: `upload ${http}` });
			console.log(`#${i}: fakechat respondió ${http} — fallo del harness, no NO-GO. Detenido.`);
			process.exit(4);
		}
		let ups = null;
		let others = 0;
		const wakeEnd = Date.now() + 120_000;
		while (Date.now() < wakeEnd && !ups) {
			await sleep(1000);
			others = 0;
			for (const r of hooks()) {
				if (seen.has(JSON.stringify(r)) || evName(r) !== "UserPromptSubmit") continue;
				// Wake = the id reached a prompt in any form; the exact tag shape is the
				// report's correlation check, not a condition for "woke up".
				if ((r.event.prompt ?? "").includes(mid)) ups = r;
				else others++;
			}
		}
		if (!ups) {
			const after = hooks().filter((r) => r.recv_ts > sentAt).map((r) => evName(r));
			append({ ...rec, result: "no-wake", other_prompts: others, hooks_after_send: after });
			console.log(`#${i} ${mid}: NO despertó en 120 s. Fase 0 detenida.`);
			process.exit(5);
		}
		const pe = ups.event;
		Object.assign(rec, {
			result: "wake", latency_s: +(ups.recv_ts - sentAt).toFixed(3), source: pe.source ?? "<absent>",
			prompt: pe.prompt, prompt_id: pe.prompt_id ?? null, session_id: pe.session_id,
			other_prompts_before_wake: others, prompt_id_seen_before: priorPromptIds.has(pe.prompt_id),
		});
		let stop = null;
		let failure = false;
		const turnEnd = Date.now() + 300_000;
		while (Date.now() < turnEnd && !stop && !failure) {
			await sleep(2000);
			for (const r of hooks()) {
				if (r.recv_ts <= sentAt) continue;
				if (evName(r) === "StopFailure") failure = true;
				if (evName(r) === "Notification" && /permission/i.test(r.event.notification_type ?? "")) rec.permission_prompt = true;
				if (evName(r) === "Stop" && r.recv_ts > ups.recv_ts && r.event.prompt_id === pe.prompt_id) stop = r;
			}
		}
		rec.stop_same_prompt_id = !!stop;
		rec.stop_latency_s = stop ? +(stop.recv_ts - sentAt).toFixed(3) : null;
		rec.stop_failure = failure;
		append(rec);
		console.log(`#${i} ${mid}: despertó en ${rec.latency_s} s · source=${rec.source} · Stop mismo prompt_id=${rec.stop_same_prompt_id}`);
		if (failure) {
			console.log("StopFailure (límite del plan o error): fase 0 detenida.");
			process.exit(7);
		}
	}
}

// ── report ──────────────────────────────────────────────────────────────
function report() {
	const regTxt = existsSync(join(OUT, "registration.txt")) ? readFileSync(join(OUT, "registration.txt"), "utf8") : "";
	const registration = /registration=(\S+)/.exec(regTxt)?.[1] ?? "not-run";
	const rows = [...readJsonl(join(OUT, "sends-short.jsonl")), ...readJsonl(join(OUT, "sends-long.jsonl"))]
		.sort((a, b) => (a.sent_at ?? 0) - (b.sent_at ?? 0));
	const attrs = (s) => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
	const wakes = rows.filter((r) => r.result === "wake");
	for (const r of wakes) {
		const tags = [...(r.prompt ?? "").matchAll(/<channel\b([^>]*)>/g)].map((m) => m[1]);
		const a = tags.length === 1 ? attrs(tags[0]) : {};
		const checks = {
			"una etiqueta": tags.length === 1,
			message_id: a.message_id === r.msg_id,
			"source de la etiqueta fakechat": (a.source ?? "").includes("fakechat"),
			"prompt_id nuevo": !!r.prompt_id && r.prompt_id_seen_before === false,
			"Stop del mismo prompt_id": r.stop_same_prompt_id === true,
			"sin otros prompts en la espera": (r.other_prompts_before_wake ?? 0) === 0,
		};
		r._corrOk = Object.values(checks).every(Boolean);
		r._corr = r._corrOk ? "OK" : `FALLA: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")}`;
	}
	const counted = rows.filter((r) => r.result === "wake" || r.result === "no-wake");
	const short = counted.filter((r) => r.label === "short");
	const long = counted.filter((r) => r.label === "long");
	const sources = [...new Set(wakes.map((r) => r.source))].sort();
	const all = counted.length === 12 && wakes.length === 12 && short.length === 10 && long.length === 2;
	const srcOk = wakes.length > 0 && sources.length === 1 && sources[0] === "system";
	const corrOk = wakes.length > 0 && wakes.every((r) => r._corrOk);
	const lat = wakes.map((r) => r.latency_s).sort((a, b) => a - b);
	let verdict;
	if (registration === "skipped") verdict = "**NO-GO**: Channels no se registra con la suscripción. No se cambia a API.";
	else if (registration !== "registered") verdict = "**Indeterminado**: sin evidencia de registro (fallo del harness, no NO-GO).";
	else if (rows.some((r) => r.result === "harness-error")) verdict = "**Indeterminado**: hubo un fallo del harness (ver tabla). No es NO-GO.";
	else if (rows.some((r) => r.result === "no-wake")) verdict = "**NO-GO de Channels para despertar.** El responsable decide si se evalúa `asyncRewake` (R2).";
	else if (!all) verdict = "**Incompleta**: faltan muestras. Sin veredicto.";
	else if (srcOk && corrOk) verdict = "**Fase 0 superada** (12/12, `source=system`, correlación OK). No es un GO de arquitectura: 12 muestras acotan la tasa de fallo en ≈ 25 %. Pedir GO separado para la POC completa.";
	else verdict = "**Disponibilidad y despertar OK; `source` o correlación en riesgo.** La POC completa sólo con GO explícito.";
	const md = [
		`# Informe de la fase 0 (variante local) — ${now()}`, "", `Veredicto: ${verdict}`, "",
		"## 1. Registro del canal", "", `- Resultado: \`${registration}\``, "",
		"## 2. Despertar y latencia", "",
		`- Despertares: ${wakes.length}/${counted.length} (cortos ${short.filter((r) => r.result === "wake").length}/${short.length}, largos ${long.filter((r) => r.result === "wake").length}/${long.length})`,
		`- Latencia envío → \`UserPromptSubmit\`: mín ${lat[0] ?? "—"} s · mediana ${lat[Math.floor(lat.length / 2)] ?? "—"} s · máx ${lat.at(-1) ?? "—"} s`, "",
		"## 3. Hooks: `source`", "", `- Valores observados: ${sources.map((s) => `\`${s}\``).join(", ") || "—"}`, "",
		"## 4. Correlación", "", `- Completa: ${corrOk ? "sí" : "no"}`, "",
		"| # | Tipo | Inactivo antes (s) | Despertó | Latencia (s) | `source` | `Stop` (s) | Permiso pedido | Correlación |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows.map((r) => `| ${r.n} | ${r.label} | ${typeof r.idle_before_s === "number" ? Math.round(r.idle_before_s) : "—"} | ${r.result} | ${r.latency_s ?? "—"} | \`${r.source ?? "—"}\` | ${r.stop_latency_s ?? "—"} | ${r.permission_prompt ? "sí" : "no"} | ${r._corr ?? "—"} |`),
		"", "## Forma exacta del primer prompt recibido", "", "```", (wakes[0]?.prompt ?? "—").slice(0, 2000), "```", "",
	];
	writeFileSync(join(OUT, "phase0-report.md"), md.join("\n"));
	console.log(join(OUT, "phase0-report.md"));
}

// ── archive ─────────────────────────────────────────────────────────────
const REDACT = [
	[/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-<REDACTED>"],
	[/("?(?:access_token|refresh_token|id_token|accessToken|refreshToken)"?\s*[:=]\s*)"[^"]*"/g, '$1"<REDACTED>"'],
	[/("?authorization"?\s*[:=]\s*"?)(bearer\s+)?[^"\s,}]+/gi, "$1<REDACTED>"],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<EMAIL>"],
	[/("?(?:(?:org|organization|account)_?(?:id|uuid)|userid|user_id|deviceid|device_id)"?\s*[:=]\s*)"[^"]*"/gi, '$1"<REDACTED>"'],
	[/\/organizations\/[0-9a-f-]{36}/gi, "/organizations/<REDACTED>"],
];
const SURVIVOR = /sk-ant-(?!<REDACTED>)|bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{20,}\./i;

export function redactText(t) {
	return REDACT.reduce((acc, [rx, rep]) => acc.replace(rx, rep), t);
}

function archive() {
	assertTempUser();
	const stillLogged = existsSync(join(HOME, ".claude", ".credentials.json")) ||
		(IS_MAC && sh("security", ["find-generic-password", "-s", "Claude Code-credentials"]).code === 0);
	if (stillLogged && !process.argv.includes("--logout-confirmed"))
		die("todavía hay credenciales de Claude: hacer /logout en la Terminal 1. Si ya lo hiciste y el llavero conserva la entrada, repetir con --logout-confirmed (el borrado del usuario la elimina)");
	const dest = IS_MAC ? `/Users/Shared/poc-channels-out-${Date.now()}` : `/tmp/poc-channels-out-${Date.now()}`;
	mkdirSync(dest, { mode: 0o755 });
	for (const f of readdirSync(OUT)) {
		const p = join(OUT, f);
		if (!statSync(p).isFile()) continue;
		let t = redactText(readFileSync(p, "utf8"));
		// The debug log is never parsed after the report, so every UUID in it
		// (account, org, device) is removed; hooks keep session/prompt ids.
		if (f === "claude-debug.log") t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>");
		if (SURVIVOR.test(t)) die(`${f}: queda un valor con forma de token tras redactar; no se archiva nada`);
		writeFileSync(join(dest, f), t);
		chmodSync(join(dest, f), 0o644);
	}
	copyFileSync(join(KIT, "manifest.sha256"), join(dest, "manifest.sha256"));
	console.log(`evidencia redactada en ${dest} (legible por el usuario habitual)`);
}

// ── main ────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const table = { setup, preflight, registration, wake: () => wake(rest), report, archive };
	if (!table[cmd]) die("uso: phase0.mjs setup|preflight|registration|wake --count N --min-idle S|report|archive");
	await table[cmd]();
}
