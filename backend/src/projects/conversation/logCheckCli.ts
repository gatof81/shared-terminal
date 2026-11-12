/**
 * projects/conversation/logCheckCli.ts — `npm run projects:check-log`:
 * reads one `GET …/conversation/events` page (or an array of events) on
 * stdin and prints the logCheck.ts report. Read-only by construction: it
 * never opens a file, so it can run on any checkout, away from the host.
 * Exit 1 when a rule is violated, 2 when the input is not JSON.
 */

import { checkLog } from "./logCheck.js";

async function main(): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	let input: unknown;
	try {
		input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (err) {
		process.stderr.write(`not JSON: ${(err as Error).message}\n`);
		process.exit(2);
	}
	const report = checkLog(input);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exit(report.ok ? 0 : 1);
}

void main();
