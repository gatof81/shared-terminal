// Phase-0 hook recorder (local variant). Appends the raw hook input with its
// receive time to ~/poc/out/hooks.jsonl. Never blocks or fails the CLI.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

try {
	const raw = readFileSync(0, "utf8");
	let event;
	try {
		event = JSON.parse(raw);
	} catch {
		event = { unparsed: raw.slice(0, 4096) };
	}
	const out = join(homedir(), "poc", "out");
	mkdirSync(out, { recursive: true });
	appendFileSync(join(out, "hooks.jsonl"), `${JSON.stringify({ recv_ts: Date.now() / 1000, event })}\n`);
} catch {
	// a recorder must never break the session
}
process.exit(0);
