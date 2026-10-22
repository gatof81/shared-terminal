/**
 * conversation/cli.ts — host-shell kill switch (docs/CONVERSATION.md §2.5, §7).
 *
 *   npm run conversation:disable -- <sessionId>     one session
 *   npm run conversation:disable -- --all           every session (global marker)
 *   npm run conversation:enable-all                 remove the global marker only
 *
 * Runs inside the backend container like `backup.ts`, against the same
 * WORKSPACE_ROOT and D1. It cannot touch the receiver's in-memory cache,
 * which is exactly why the order is marker → D1 → files and why the
 * receiver stats the marker on every event. Success is printed only
 * after all three steps; a D1 failure leaves the marker (the cut stays)
 * and exits non-zero without deleting any file.
 *
 * `runCli(argv, deps)` is exported so the two-process regression can
 * execute the real command logic in a child process with an injected
 * D1 (healthy / failing) — see conversation.revocation.test.ts.
 */

import { type ActivationDeps, disableAll, disableSession, enableAll } from "./activation.js";

export interface CliDeps extends ActivationDeps {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const [cmd, ...rest] = argv;
	try {
		switch (cmd) {
			case "disable": {
				const target = rest[0];
				if (!target) throw new Error("usage: conversation:disable -- <sessionId> | --all");
				if (target === "--all") {
					const removed = await disableAll(deps, rest[1]);
					deps.stdout(
						`revoked ALL (global marker written, ${removed.length} hooks file(s) removed)`,
					);
					return 0;
				}
				if (!/^[A-Za-z0-9_-]{1,128}$/.test(target)) throw new Error("invalid session id");
				await disableSession(deps, target, "cli", rest[1]);
				deps.stdout(`revoked ${target}`);
				return 0;
			}
			case "enable-all":
				await enableAll(deps);
				deps.stdout("global revocation marker removed");
				return 0;
			default:
				throw new Error(
					"usage: conversation:disable -- <sessionId>|--all | conversation:enable-all",
				);
		}
	} catch (err) {
		deps.stderr((err as Error).message);
		// A disable that failed at D1 leaves the marker in place on purpose.
		if (cmd === "disable") deps.stderr("revocation marker left in place; ingest stays cut off");
		return 1;
	}
}

/* c8 ignore start */
if (typeof require !== "undefined" && require.main === module) {
	const deps: CliDeps = {
		workspaceRoot: process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces",
		enabled: process.env.CONVERSATION_ENABLED === "true",
		port: Number.parseInt(process.env.PORT ?? "3001", 10),
		stdout: (l) => console.log(l),
		stderr: (l) => console.error(l),
	};
	runCli(process.argv.slice(2), deps).then(
		(code) => process.exit(code),
		(err) => {
			console.error((err as Error).message);
			process.exit(1);
		},
	);
}
/* c8 ignore stop */
