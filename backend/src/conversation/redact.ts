/**
 * conversation/redact.ts — docs/CONVERSATION.md §4.3: what a tool call
 * leaves behind in the event log.
 *
 * Principle (level 0, the only level in 3.x): the persisted summary
 * contains STRUCTURAL IDENTIFIERS ONLY — program names, a file path, a
 * URL host, byte counts, key names — never free text from the tool
 * input. A denylist of key names is deliberately NOT the mechanism: it
 * cannot see a credential embedded in a value (`curl -H 'Authorization:
 * Bearer …'`, `VAR=secret cmd`, `https://user:pass@host`), so free
 * values are simply not persisted at all. §4.3.2 lists what CAN still
 * carry secrets (the prompt, the assistant's text, file paths, a
 * subagent's short description) and SECURITY.md documents it; nothing
 * here claims to "remove secrets".
 */

import {
	AGENT_DESCRIPTION_BYTES,
	ARGV_FLAG_VALUE_BYTES,
	BASH_PROGRAM_BYTES,
	BASH_PROGRAMS_MAX,
	ERROR_TEXT_BYTES,
	FILE_PATH_BYTES,
	L4_AUX_BYTES,
	MCP_KEY_BYTES,
	MCP_KEYS_MAX,
} from "./limits.js";
import { clipAux, utf8Bytes } from "./text.js";

export type ToolSummary = Record<string, string | number | boolean | string[]>;

type Input = Record<string, unknown>;

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Shell words that prefix a command without being "the program". When a
 * segment STARTS with one of these, where the real program begins depends
 * on that word's own option grammar (`sudo -u app`, `env -i`), which we do
 * not parse: the segment is skipped rather than guessed (B3).
 */
const BASH_PREFIX_WORDS = new Set([
	"sudo",
	"env",
	"nohup",
	"time",
	"exec",
	"command",
	"builtin",
	"export",
	"declare",
	"local",
	"readonly",
	"set",
	"unset",
]);
const BASH_SEGMENT_SPLIT = /\|\||&&|\||;|\n/;
const BASH_PROGRAM_CHARS = /^[A-Za-z0-9._-]+$/;
/**
 * Anything that makes a naive split on `| ; && ||` unreliable: quotes
 * (separators inside strings), escapes, command substitution, heredocs,
 * subshells and braces. Rather than tokenising shell — which would
 * eventually be wrong — the summary omits `programs` entirely for such
 * commands and keeps only safe metadata (B3).
 */
const BASH_AMBIGUOUS = /["'`\\$(){}<>]/;

/**
 * Program names of a shell pipeline, or `null` when the command's syntax
 * is ambiguous. Only the FIRST token of each segment is ever a candidate;
 * arguments are never read, so an argument value can never surface as a
 * "program name".
 */
export function bashPrograms(command: string): string[] | null {
	if (BASH_AMBIGUOUS.test(command)) return null;
	const out: string[] = [];
	for (const rawSegment of command.split(BASH_SEGMENT_SPLIT)) {
		if (out.length >= BASH_PROGRAMS_MAX) break;
		const tokens = rawSegment.trim().split(/\s+/).filter(Boolean);
		// Skip leading plain `VAR=value` assignments (quotes already excluded).
		let i = 0;
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/.test(tokens[i])) i++;
		const first = tokens[i];
		if (!first) continue;
		// A prefix word or a flag in program position: unknowable, skip.
		if (BASH_PREFIX_WORDS.has(first) || first.startsWith("-")) continue;
		const base = first.split("/").pop() ?? "";
		if (!base || !BASH_PROGRAM_CHARS.test(base)) continue;
		out.push(utf8Bytes(base) > BASH_PROGRAM_BYTES ? base.slice(0, BASH_PROGRAM_BYTES) : base);
	}
	return out;
}

function hostOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).hostname || undefined;
	} catch {
		return undefined;
	}
}

function filePath(v: unknown): string | undefined {
	const s = str(v);
	return s === undefined ? undefined : clipAux(s, FILE_PATH_BYTES);
}

/**
 * `summarizeToolInput(tool_name, tool_input)` — pure, table-tested
 * (§4.3.1). Unknown tools and MCP tools yield key NAMES only.
 */
export function summarizeToolInput(toolName: string, toolInput: unknown): ToolSummary {
	const input: Input = toolInput && typeof toolInput === "object" ? (toolInput as Input) : {};
	switch (toolName) {
		case "Bash": {
			const command = str(input.command) ?? "";
			const programs = bashPrograms(command);
			const out: ToolSummary = { command_bytes: utf8Bytes(command) };
			if (programs === null) out.programs_omitted = true;
			else out.programs = programs;
			if (typeof input.run_in_background === "boolean") {
				out.run_in_background = input.run_in_background;
			}
			return out;
		}
		case "Read":
		case "Edit":
		case "Write":
		case "MultiEdit":
		case "NotebookEdit": {
			const out: ToolSummary = {};
			const fp = filePath(input.file_path ?? input.notebook_path);
			if (fp !== undefined) out.file_path = fp;
			if (toolName === "Read") {
				const offset = num(input.offset);
				const limit = num(input.limit);
				if (offset !== undefined) out.offset = offset;
				if (limit !== undefined) out.limit = limit;
			}
			return out;
		}
		case "Grep":
		case "Glob": {
			const out: ToolSummary = {};
			const p = filePath(input.path);
			if (p !== undefined) out.path = p;
			out.pattern_bytes = utf8Bytes(str(input.pattern) ?? "");
			return out;
		}
		case "Agent": {
			const out: ToolSummary = {};
			const type = str(input.subagent_type);
			if (type !== undefined) out.subagent_type = clipAux(type, ARGV_FLAG_VALUE_BYTES);
			const description = str(input.description);
			if (description !== undefined) {
				out.description = clipAux(description, AGENT_DESCRIPTION_BYTES);
			}
			return out;
		}
		case "WebFetch": {
			const host = hostOf(str(input.url));
			return host ? { host } : {};
		}
		case "WebSearch":
			return { query_bytes: utf8Bytes(str(input.query) ?? "") };
		case "TodoWrite":
		case "TaskCreate":
		case "TaskUpdate": {
			const items = Array.isArray(input.todos)
				? input.todos.length
				: Array.isArray(input.tasks)
					? input.tasks.length
					: 1;
			return { count: items };
		}
		default: {
			const keys = Object.keys(input)
				.slice(0, MCP_KEYS_MAX)
				.map((k) => (utf8Bytes(k) > MCP_KEY_BYTES ? k.slice(0, MCP_KEY_BYTES) : k));
			return { keys };
		}
	}
}

/**
 * §4.3.3 — `tool_failed.error`: persisted (≤ 512 bytes) only for tools
 * whose error text does not echo a command. For Bash and MCP tools only
 * the byte count and, when extractable, the exit code survive.
 */
export function redactToolError(
	toolName: string,
	error: string,
): { error?: string; error_bytes: number; exit_code?: number } {
	const bytes = utf8Bytes(error);
	if (toolName === "Bash" || toolName.startsWith("mcp__")) {
		const m = /exit code (\d+)/i.exec(error);
		const out: { error_bytes: number; exit_code?: number } = { error_bytes: bytes };
		if (m) out.exit_code = Number.parseInt(m[1], 10);
		return out;
	}
	return { error: clipAux(error, ERROR_TEXT_BYTES), error_bytes: bytes };
}

/** §4.3.3 — notification types whose text is not derived from a command. */
const NOTIFICATION_TEXT_ALLOWED = new Set([
	"idle_prompt",
	"agent_completed",
	"agent_needs_input",
	"auth_success",
	"elicitation_complete",
]);

export function redactNotification(
	notificationType: string,
	message: string | undefined,
	title: string | undefined,
): { notification_type: string; message?: string; title?: string } {
	const out: { notification_type: string; message?: string; title?: string } = {
		notification_type: notificationType,
	};
	const allowed =
		NOTIFICATION_TEXT_ALLOWED.has(notificationType) || notificationType.startsWith("quota_");
	if (allowed) {
		if (message !== undefined) out.message = clipAux(message, L4_AUX_BYTES);
		if (title !== undefined) out.title = clipAux(title, L4_AUX_BYTES);
	}
	return out;
}

/** §2.3 — argv flags that may be persisted from the `claude` process. */
const ARGV_FLAG_ALLOWLIST = new Set([
	"-p",
	"--print",
	"--bare",
	"--resume",
	"--continue",
	"--fork-session",
	"--agent",
	"--agent-name",
	"--agent-id",
	"--teammate-mode",
	"--dangerously-skip-permissions",
	"--permission-mode",
]);
/** Flags whose VALUE is kept (≤ 64 bytes); every other value is dropped. */
const ARGV_FLAGS_WITH_VALUE = new Set([
	"--agent-name",
	"--agent-type",
	"--teammate-mode",
	"--permission-mode",
]);

/**
 * Keep only allowlisted flags (and a few short values) from a `claude`
 * argv. The full argv is never persisted: it can carry
 * `--append-system-prompt`, paths or secrets.
 */
export function filterArgvFlags(argv: readonly unknown[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length && out.length < 32; i++) {
		const tok = argv[i];
		if (typeof tok !== "string") continue;
		const [flag, inlineValue] = tok.includes("=") ? tok.split(/=(.*)/s, 2) : [tok, undefined];
		if (!ARGV_FLAG_ALLOWLIST.has(flag) && !ARGV_FLAGS_WITH_VALUE.has(flag)) continue;
		if (ARGV_FLAGS_WITH_VALUE.has(flag)) {
			const value = inlineValue ?? (typeof argv[i + 1] === "string" ? (argv[i + 1] as string) : "");
			if (inlineValue === undefined && typeof argv[i + 1] === "string") i++;
			out.push(`${flag}=${clipAux(value, ARGV_FLAG_VALUE_BYTES)}`);
		} else {
			out.push(flag);
		}
	}
	return out;
}
