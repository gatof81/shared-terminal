// ──────────────────────────────────────────────────────────────────────────────
// Minimal Anthropic Messages API stand-in for the conversation-hooks smoke
// test (session-image/conversation-smoke.sh). The real `claude` binary from
// the image talks to it through ANTHROPIC_BASE_URL, so the hooks under test
// fire from the real CLI without an API key, network egress or cost.
//
// It answers every POST /v1/messages with a scripted reply chosen from the
// conversation itself:
//   - last user turn carries a tool_result   → a short closing text;
//   - prompt contains ST_SCENARIO=bash      → one Bash tool_use;
//   - prompt contains ST_SCENARIO=bashfail  → one Bash tool_use that exits 3;
//   - prompt contains ST_SCENARIO=bashwrite → one Bash tool_use that writes a
//     file (needs approval outside bypass mode ⇒ PermissionRequest);
//   - prompt contains ST_SCENARIO=agent     → one Agent tool_use (subagent);
//   - prompt contains ST_SCENARIO=long:<n>  → n lines of text (streaming load);
//   - prompt contains ST_SCENARIO=slow:<n>:<ms> → n lines, one every <ms> ms
//     (a paced stream, so the CLI displays it in several batches);
//   - prompt contains ST_SCENARIO=sha256:<path> → one Bash tool_use running
//     `sha256sum -- <path>`, then a closing text that echoes the hash the tool
//     printed (`sha256 <hex> <path>`), so the receiving CLI computes it itself
//     (D2 validation runbook, P3.5). <path> must be exactly an inbox artifact
//     name, `.st-inbox/<12 hex>-<name>` (the shape placement.ts publishes);
//     anything else is refused with a text and no tool call;
//   - anything else                         → two lines of text.
// Anything that is not /v1/messages gets an empty 200 JSON object, so side
// calls the CLI makes on startup never fail the run.
//
// Usage: node mock-anthropic.mjs [port]   (default 8080)
// ──────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import http from "node:http";

const port = Number(process.argv[2] ?? 8080);
// Optional: append every /v1/messages request body here, so a test can
// check what the model was shown (e.g. that no hook error reached it).
const requestLog = process.argv[3];
let seq = 0;

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => (b?.type === "text" ? b.text : b?.type === "tool_result" ? "[tool_result]" : ""))
		.join("\n");
}

// The only paths the sha256 scenario will hand to a shell: an artifact's
// inbox name as placement.ts publishes it (`<sha12>-<name>`, name from
// sanitizeName: no leading dot, no slash, the §6.1 set). No `..`, no
// absolute path, no quoting or expansion possible in the command built from it.
const SHA256_PATH_RE = /^\.st-inbox\/[0-9a-f]{12}-[A-Za-z0-9_-][A-Za-z0-9._-]{0,95}$/;
const SHA256_TOKEN_RE = /ST_SCENARIO=sha256:(\S*)/g;

/** The tool_result's text, whatever shape the CLI sent it in. */
function toolResultText(block) {
	const c = block?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((b) => (b?.type === "text" ? b.text : "")).join("\n");
	return "";
}

function plan(body) {
	// The CLI interleaves `system`-role context messages (environment, token
	// budget) with the conversation; only user/assistant turns matter here.
	const messages = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m?.role !== "system");
	const last = messages[messages.length - 1];
	const lastContent = Array.isArray(last?.content) ? last.content : [];
	if (lastContent.some((b) => b?.type === "tool_result")) {
		// The sha256 scenario's second step: echo what `sha256sum` printed for
		// the path it was asked about, and nothing else.
		const prev = messages[messages.length - 2];
		const call = (Array.isArray(prev?.content) ? prev.content : []).find(
			(b) => b?.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string",
		);
		const asked = call && /^sha256sum -- (\S+)$/.exec(call.input.command)?.[1];
		if (asked && SHA256_PATH_RE.test(asked)) {
			const results = lastContent.filter((b) => b?.type === "tool_result");
			const out = results.map(toolResultText).join("\n");
			// Exactly one line that is `<64 hex>  <asked>` and nothing else — what a
			// single-operand sha256sum prints — and no tool error.
			const hits = out.split("\n").filter((l) => /^[0-9a-f]{64}  /.test(l) && l.slice(66) === asked);
			const errored = results.some((b) => b?.is_error === true);
			const hex = !errored && hits.length === 1 ? hits[0].slice(0, 64) : null;
			return { text: hex ? `sha256 ${hex} ${asked}\n` : `sha256 not computed for ${asked}\n` };
		}
		return { text: "Tool finished.\nDone.\n" };
	}
	// The scenario comes from the current turn only (every user message after
	// the last assistant one: the CLI may append context messages after the
	// prompt), so a later plain prompt in the same interactive session gets a
	// plain answer.
	let lastAssistant = -1;
	messages.forEach((m, i) => {
		if (m.role === "assistant") lastAssistant = i;
	});
	const userTurns = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
	const prompt = messages
		.slice(lastAssistant + 1)
		.filter((m) => m.role === "user")
		.map((m) => textOf(m.content))
		.join("\n");
	const tools = new Set((body.tools ?? []).map((t) => t.name));
	if (userTurns.some((t) => t.includes("ST_SUBAGENT"))) return { text: "Subagent reporting.\nAll good.\n" };
	const tokens = [...prompt.matchAll(SHA256_TOKEN_RE)];
	if (tokens.length > 1) return { text: "sha256 scenario refused: more than one token\n" };
	if (tokens.length === 1) {
		const p = tokens[0][1];
		if (!SHA256_PATH_RE.test(p)) return { text: "sha256 scenario refused: not an inbox artifact path\n" };
		if (!tools.has("Bash")) return { text: "sha256 scenario refused: no Bash tool\n" };
		return { tool: { name: "Bash", input: { command: `sha256sum -- ${p}`, description: "Hash the received artifact" } } };
	}
	if (prompt.includes("ST_SCENARIO=bashwrite") && tools.has("Bash")) {
		return { tool: { name: "Bash", input: { command: "touch smoke-permission.txt", description: "Write a file" } } };
	}
	if (prompt.includes("ST_SCENARIO=bashfail") && tools.has("Bash")) {
		return { tool: { name: "Bash", input: { command: "echo failing >&2; exit 3", description: "Fail on purpose" } } };
	}
	if (prompt.includes("ST_SCENARIO=bash") && tools.has("Bash")) {
		return { tool: { name: "Bash", input: { command: "echo smoke-bash-ok", description: "Print a marker" } } };
	}
	if (prompt.includes("ST_SCENARIO=agent")) {
		const name = tools.has("Agent") ? "Agent" : tools.has("Task") ? "Task" : null;
		if (name) {
			return {
				tool: {
					name,
					input: {
						description: "Smoke subagent",
						prompt: "ST_SUBAGENT reply with one line",
						subagent_type: "general-purpose",
					},
				},
			};
		}
	}
	const long = /ST_SCENARIO=long:(\d+)/.exec(prompt);
	if (long) {
		const n = Math.min(Number(long[1]), 5000);
		return { text: Array.from({ length: n }, (_, i) => `Line ${i + 1} of the long answer.\n`).join("") };
	}
	const slow = /ST_SCENARIO=slow:(\d+):(\d+)/.exec(prompt);
	if (slow) {
		const n = Math.min(Number(slow[1]), 5000);
		return {
			text: Array.from({ length: n }, (_, i) => `Paced line ${i + 1}.\n`).join(""),
			delayMs: Math.min(Number(slow[2]), 1000),
		};
	}
	return { text: "Hello from the mock.\nSecond line.\n" };
}

function sse(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function respond(req, res, body) {
	const p = plan(body);
	const id = `msg_mock_${++seq}`;
	const model = body.model ?? "claude-mock";
	const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
	const content = p.tool
		? [{ type: "tool_use", id: `toolu_mock_${seq}`, name: p.tool.name, input: p.tool.input }]
		: [{ type: "text", text: p.text }];
	const stop_reason = p.tool ? "tool_use" : "end_turn";
	if (!body.stream) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ id, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage }));
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	sse(res, "message_start", {
		type: "message_start",
		message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
	});
	if (p.tool) {
		sse(res, "content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: content[0].id, name: p.tool.name, input: {} },
		});
		sse(res, "content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(p.tool.input) },
		});
	} else {
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		// Line-sized deltas, like a real stream, so MessageDisplay batches.
		for (const line of p.text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
			if (p.delayMs) await sleep(p.delayMs);
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: line } });
		}
	}
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
}

http
	.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const url = (req.url ?? "").split("?")[0];
			if (req.method === "POST" && url === "/v1/messages") {
				let body = {};
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {}
				if (requestLog) fs.appendFileSync(requestLog, `${JSON.stringify(body)}\n`);
				void respond(req, res, body);
				return;
			}
			if (req.method === "POST" && url === "/v1/messages/count_tokens") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ input_tokens: 10 }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	})
	.listen(port, "0.0.0.0", () => console.log(`mock-anthropic listening on ${port}`));
