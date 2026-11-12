// ──────────────────────────────────────────────────────────────────────────────
// Tests for mock-anthropic.mjs's sha256 scenario (D2 validation runbook,
// P3.5): the stand-in is started for real on a loopback port and driven with
// Messages API bodies shaped like the CLI's. The point is the path rule —
// the scenario hands its path to a shell through the CLI's Bash tool, so
// only an inbox artifact name may ever reach the command — and that the
// existing scenarios still answer as before.
//
// Run: node --test session-image/test/mock-anthropic.test.mjs
// ──────────────────────────────────────────────────────────────────────────────
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 19000 + (process.pid % 1000);
let mock;

before(async () => {
	mock = spawn(process.execPath, [path.join(here, "mock-anthropic.mjs"), String(PORT)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise((resolve, reject) => {
		mock.stdout.on("data", (c) => {
			if (String(c).includes("listening")) resolve();
		});
		mock.on("exit", (code) => reject(new Error(`mock exited ${code}`)));
	});
});
after(() => mock?.kill());

const BASH = [{ name: "Bash" }, { name: "Read" }];
const SHA = "a".repeat(64);
const GOOD = `.st-inbox/${SHA.slice(0, 12)}-fix.diff`;

async function ask(messages, tools = BASH) {
	const r = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "m", stream: false, messages, tools }),
	});
	assert.equal(r.status, 200);
	const b = await r.json();
	const block = b.content[0];
	return block.type === "tool_use" ? { tool: block } : { text: block.text };
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

describe("ST_SCENARIO=sha256:<path>", () => {
	it("a valid inbox path ⇒ one Bash call running exactly `sha256sum -- <path>`", async () => {
		const r = await ask([user(`ST_SCENARIO=sha256:${GOOD}`)]);
		assert.equal(r.tool?.name, "Bash");
		assert.equal(r.tool.input.command, `sha256sum -- ${GOOD}`);
	});

	it("every other path is refused with a text and NO tool call", async () => {
		const bad = [
			"",
			"/etc/passwd",
			".st-inbox/../.env",
			"../.st-inbox/aaaaaaaaaaaa-x",
			".st-inbox/aaaaaaaaaaaa-.bashrc",
			".st-inbox/aaaaaaaaaaaa-",
			".st-inbox/AAAAAAAAAAAA-x",
			".st-inbox/aaaaaaaaaaa-x",
			".st-inbox/aaaaaaaaaaaa-x/y",
			".st-inbox/aaaaaaaaaaaa-x;rm",
			".st-inbox/aaaaaaaaaaaa-$(id)",
			".st-inbox/aaaaaaaaaaaa-`id`",
			".st-inbox/aaaaaaaaaaaa-x|cat",
			".st-inbox/aaaaaaaaaaaa-x&&id",
			".st-inbox/aaaaaaaaaaaa-'x'",
			".st-inbox/aaaaaaaaaaaa-*",
			"~/.ssh/id_ed25519",
			`.st-inbox/aaaaaaaaaaaa-${"x".repeat(97)}`,
			"st-inbox/aaaaaaaaaaaa-x",
		];
		for (const p of bad) {
			const r = await ask([user(`ST_SCENARIO=sha256:${p}`)]);
			assert.equal(r.tool, undefined, `tool call for ${JSON.stringify(p)}`);
			assert.match(r.text, /^sha256 scenario refused/, p);
		}
	});

	it("a path is only what follows the token up to whitespace (any Unicode space): trailing text never reaches the command", async () => {
		for (const sep of [" ", "\n", "\r\n", "\t", "\u00a0", "\u2028", "\u3000"]) {
			const r = await ask([user(`ST_SCENARIO=sha256:${GOOD}${sep}; rm -rf ~`)]);
			assert.equal(r.tool?.input.command, `sha256sum -- ${GOOD}`, JSON.stringify(sep));
		}
	});

	it("more than one token in the turn ⇒ refused, never the first or the last silently", async () => {
		const other = `.st-inbox/${"b".repeat(12)}-other`;
		for (const t of [
			`ST_SCENARIO=sha256:${other} ST_SCENARIO=sha256:${GOOD}`,
			`ST_SCENARIO=sha256:../x\nST_SCENARIO=sha256:${GOOD}`,
		]) {
			const r = await ask([user(t)]);
			assert.equal(r.tool, undefined);
			assert.match(r.text, /more than one token/);
		}
	});

	it("a token outside the current turn (earlier turn, tool output) is not a request", async () => {
		const r = await ask([
			user(`ST_SCENARIO=sha256:${GOOD}`),
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			user("hola"),
		]);
		assert.equal(r.text, "Hello from the mock.\nSecond line.\n");
	});

	it("without a Bash tool ⇒ refused, no call", async () => {
		const r = await ask([user(`ST_SCENARIO=sha256:${GOOD}`)], [{ name: "Read" }]);
		assert.equal(r.tool, undefined);
		assert.match(r.text, /no Bash tool/);
	});

	it("after the tool runs, the closing text echoes the hash sha256sum printed for THAT path", async () => {
		const call = { type: "tool_use", id: "t1", name: "Bash", input: { command: `sha256sum -- ${GOOD}` } };
		const msgs = (out) => [
			user(`ST_SCENARIO=sha256:${GOOD}`),
			{ role: "assistant", content: [call] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: out }] },
		];
		assert.equal((await ask(msgs(`${SHA}  ${GOOD}\n`))).text, `sha256 ${SHA} ${GOOD}\n`);
		// Content as an array of text blocks, as the CLI may send it.
		assert.equal(
			(await ask(msgs([{ type: "text", text: `${SHA}  ${GOOD}` }]))).text,
			`sha256 ${SHA} ${GOOD}\n`,
		);
		// A hash for another file, or an error, is never echoed as this one's.
		assert.equal(
			(await ask(msgs(`${SHA}  .st-inbox/bbbbbbbbbbbb-other\n`))).text,
			`sha256 not computed for ${GOOD}\n`,
		);
		assert.equal(
			(await ask(msgs(`sha256sum: ${GOOD}: No such file or directory\n`))).text,
			`sha256 not computed for ${GOOD}\n`,
		);
		// A line that only starts and ends right, two matching lines, or a tool error: not echoed.
		for (const out of [
			`${SHA}  .st-inbox/x  ${GOOD}\n`,
			`${SHA}  ${GOOD}\n${"c".repeat(64)}  ${GOOD}\n`,
		]) {
			assert.equal((await ask(msgs(out))).text, `sha256 not computed for ${GOOD}\n`);
		}
		const errored = [
			user(`ST_SCENARIO=sha256:${GOOD}`),
			{ role: "assistant", content: [call] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `${SHA}  ${GOOD}\n` }],
			},
		];
		assert.equal((await ask(errored)).text, `sha256 not computed for ${GOOD}\n`);
	});
});

describe("existing scenarios are unchanged", () => {
	it("plain prompt, bash, and a tool_result after any other call", async () => {
		assert.equal((await ask([user("hola")])).text, "Hello from the mock.\nSecond line.\n");
		assert.equal((await ask([user("ST_SCENARIO=bash")])).tool.input.command, "echo smoke-bash-ok");
		const r = await ask([
			user("ST_SCENARIO=bash"),
			{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "echo smoke-bash-ok" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "smoke-bash-ok" }] },
		]);
		assert.equal(r.text, "Tool finished.\nDone.\n");
	});
});
