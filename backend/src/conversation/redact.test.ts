/**
 * redact.test.ts — docs/CONVERSATION.md §4.3: the seven required examples
 * plus the per-tool table, the error/notification conditioning and the
 * argv allowlist. These tests ARE the privacy contract: a change that
 * starts persisting a command string must fail here first.
 */

import { describe, expect, it } from "vitest";
import {
	bashPrograms,
	filterArgvFlags,
	redactNotification,
	redactToolError,
	summarizeToolInput,
} from "./redact.js";

describe("summarizeToolInput — §4.3.1 required examples", () => {
	it("curl with a quoted Authorization header → quotes make the syntax ambiguous: programs omitted", () => {
		const cmd = "curl -H 'Authorization: Bearer SECRETO' https://example.test";
		expect(summarizeToolInput("Bash", { command: cmd })).toEqual({
			command_bytes: Buffer.byteLength(cmd),
			programs_omitted: true,
		});
		expect(summarizeToolInput("Bash", { command: "curl https://example.test" })).toEqual({
			programs: ["curl"],
			command_bytes: 25,
		});
	});
	it("env assignment before aws, piped to head", () => {
		const cmd = "AWS_SECRET_ACCESS_KEY=abc aws s3 ls | head";
		expect(summarizeToolInput("Bash", { command: cmd })).toEqual({
			programs: ["aws", "head"],
			command_bytes: Buffer.byteLength(cmd),
		});
	});
	it("git clone with a credentialed URL && cd", () => {
		const cmd = "git clone https://user:tok3n@github.com/x/y.git && cd y";
		expect(summarizeToolInput("Bash", { command: cmd })).toEqual({
			programs: ["git", "cd"],
			command_bytes: Buffer.byteLength(cmd),
		});
	});
	it("echo $TOKEN | base64 -d > file → `$` and `>` make it ambiguous: programs omitted", () => {
		const cmd = "echo $TOKEN | base64 -d > /tmp/k";
		expect(summarizeToolInput("Bash", { command: cmd })).toEqual({
			command_bytes: Buffer.byteLength(cmd),
			programs_omitted: true,
		});
	});
	it("WebFetch keeps only the host (no query, no prompt)", () => {
		expect(
			summarizeToolInput("WebFetch", {
				url: "https://api.example.test/v1/users?api_key=XYZ",
				prompt: "summarise",
			}),
		).toEqual({ host: "api.example.test" });
	});
	it("Grep keeps path and pattern size, never the pattern", () => {
		expect(summarizeToolInput("Grep", { pattern: "sk-live-[0-9a-z]+", path: "src" })).toEqual({
			path: "src",
			pattern_bytes: 17,
		});
	});
	it("MCP tool → key names only", () => {
		expect(
			summarizeToolInput("mcp__x__call", {
				server: "x",
				headers: { Authorization: "Bearer Y" },
				body: "…",
			}),
		).toEqual({ keys: ["server", "headers", "body"] });
	});
});

describe("summarizeToolInput — per-tool table", () => {
	it("never returns the command text under any key", () => {
		const cmd = "export API_KEY=zzz; ./deploy.sh --token zzz";
		const s = JSON.stringify(summarizeToolInput("Bash", { command: cmd, description: "deploy" }));
		expect(s).not.toContain("zzz");
		expect(s).not.toContain("--token");
		expect(s).not.toContain("description");
		// The program NAME is a structural identifier and is kept.
		expect(JSON.parse(s).programs).toEqual(["deploy.sh"]);
	});
	it("Bash: prefix words skip their segment, subshells make it ambiguous, max 8 programs", () => {
		expect(bashPrograms("sudo env FOO=1 /usr/bin/python3 x.py; make")).toEqual(["make"]);
		expect(bashPrograms("(cd a && ls); nohup node s.js &")).toBeNull();
		expect(bashPrograms("a|b|c|d|e|f|g|h|i|j")).toHaveLength(8);
	});
	it("Bash: run_in_background passes through as a boolean", () => {
		expect(summarizeToolInput("Bash", { command: "sleep 1", run_in_background: true })).toEqual({
			programs: ["sleep"],
			command_bytes: 7,
			run_in_background: true,
		});
	});
	it("Read/Edit/Write keep file_path (and Read's offset/limit), never content", () => {
		expect(
			summarizeToolInput("Edit", { file_path: "/w/x.ts", old_string: "secret", new_string: "s2" }),
		).toEqual({ file_path: "/w/x.ts" });
		expect(summarizeToolInput("Read", { file_path: "/w/x.ts", offset: 10, limit: 5 })).toEqual({
			file_path: "/w/x.ts",
			offset: 10,
			limit: 5,
		});
		expect(summarizeToolInput("Write", { file_path: "/w/.env", content: "KEY=v" })).toEqual({
			file_path: "/w/.env",
		});
	});
	it("Agent keeps subagent_type and a clipped description, never the prompt", () => {
		const s = summarizeToolInput("Agent", {
			subagent_type: "Explore",
			description: "Find config",
			prompt: "the secret is X",
		});
		expect(s).toEqual({ subagent_type: "Explore", description: "Find config" });
	});
	it("WebSearch keeps only the query size", () => {
		expect(summarizeToolInput("WebSearch", { query: "my password 1234" })).toEqual({
			query_bytes: 16,
		});
	});
	it("WebFetch with an unparseable url yields nothing", () => {
		expect(summarizeToolInput("WebFetch", { url: "not a url" })).toEqual({});
	});
	it("unknown tool with a non-object input yields an empty key list", () => {
		expect(summarizeToolInput("Weird", "string")).toEqual({ keys: [] });
	});
	it("key names are capped at 16 entries of 64 bytes", () => {
		const input: Record<string, number> = {};
		for (let i = 0; i < 40; i++) input[`k${i}`.padEnd(100, "x")] = i;
		const s = summarizeToolInput("mcp__a__b", input) as { keys: string[] };
		expect(s.keys).toHaveLength(16);
		for (const k of s.keys) expect(Buffer.byteLength(k)).toBeLessThanOrEqual(64);
	});
});

describe("redactToolError — §4.3.3", () => {
	it("Bash keeps bytes + exit code, never the text", () => {
		const r = redactToolError("Bash", "Command failed with exit code 2: cat /etc/shadow");
		expect(r).toEqual({ error_bytes: 48, exit_code: 2 });
	});
	it("MCP tools behave like Bash", () => {
		expect(redactToolError("mcp__db__query", "boom secret")).toEqual({ error_bytes: 11 });
	});
	it("other tools keep ≤ 512 bytes of text", () => {
		const r = redactToolError("Read", "x".repeat(1000));
		expect(r.error_bytes).toBe(1000);
		expect(Buffer.byteLength(r.error as string)).toBeLessThanOrEqual(512);
		expect(r.error).toMatch(/…\[\+\d+ chars\]$/);
	});
});

describe("redactNotification — §4.3.3", () => {
	it("permission_prompt keeps only the type", () => {
		expect(
			redactNotification("permission_prompt", "Claude needs permission to run rm -rf", "t"),
		).toEqual({
			notification_type: "permission_prompt",
		});
	});
	it("idle_prompt and quota_* keep message/title", () => {
		expect(redactNotification("idle_prompt", "waiting", "Claude")).toEqual({
			notification_type: "idle_prompt",
			message: "waiting",
			title: "Claude",
		});
		expect(redactNotification("quota_auto_resume_fired", "resumed", undefined)).toEqual({
			notification_type: "quota_auto_resume_fired",
			message: "resumed",
		});
	});
});

describe("filterArgvFlags — §2.3 allowlist", () => {
	it("keeps allowlisted flags, drops everything else including values", () => {
		expect(
			filterArgvFlags([
				"claude",
				"--dangerously-skip-permissions",
				"--append-system-prompt",
				"top secret",
				"-p",
				"the prompt",
				"--resume",
				"abc",
				"--agent-name",
				"api-worker",
				"--teammate-mode=tmux",
				"--model",
				"opus",
			]),
		).toEqual([
			"--dangerously-skip-permissions",
			"-p",
			"--resume",
			"--agent-name=api-worker",
			"--teammate-mode=tmux",
		]);
	});
	it("clips kept values to 64 bytes and ignores non-strings", () => {
		const out = filterArgvFlags(["--agent-name", "x".repeat(200), 42, null]);
		expect(out).toHaveLength(1);
		expect(Buffer.byteLength(out[0])).toBeLessThanOrEqual("--agent-name=".length + 64);
	});
});
