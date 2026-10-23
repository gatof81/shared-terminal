// ──────────────────────────────────────────────────────────────────────────────
// Misbehaving ingest receivers for the conversation-hooks smoke test. Each
// mode stands where st-backend would and records what it received (one JSON
// line per request: arrival time, path, header presence and the parsed body)
// so the test can count requests and check identifiers.
//
//   ok       204, empty body (what the real receiver always answers)
//   hang     accepts the request and never answers
//   status500, text200, json200-invalid   unexpected answers
//   block    200 with a decision body — documents the trust boundary only
//
// Usage: node recorder.mjs <mode> <port> <out.jsonl>
// ──────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import http from "node:http";

const [mode = "ok", portArg = "3001", out = "/dev/stdout"] = process.argv.slice(2);

http
	.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body = null;
			try {
				body = JSON.parse(raw);
			} catch {}
			const line = {
				t: Date.now(),
				method: req.method,
				url: req.url,
				authorization: req.headers.authorization ?? null,
				session: req.headers["x-st-session"] ?? null,
				pane: req.headers["x-st-tmux-pane"] ?? null,
				event: body?.hook_event_name ?? null,
				body,
			};
			fs.appendFileSync(out, `${JSON.stringify(line)}\n`);
			switch (mode) {
				case "hang":
					return; // never answer
				case "status500":
					res.writeHead(500, { "content-type": "text/plain" });
					res.end("boom");
					return;
				case "text200":
					res.writeHead(200, { "content-type": "text/plain" });
					res.end("not json at all");
					return;
				case "json200-invalid":
					res.writeHead(200, { "content-type": "application/json" });
					res.end("{ broken");
					return;
				case "block":
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ decision: "block", reason: "recorder in block mode", continue: false }));
					return;
				default:
					res.writeHead(204);
					res.end();
			}
		});
	})
	.listen(Number(portArg), "0.0.0.0", () => console.error(`recorder(${mode}) listening on ${portArg}`));
