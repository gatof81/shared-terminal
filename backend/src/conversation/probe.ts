/**
 * conversation/probe.ts — `claude agents --json`, the documented way to
 * read Claude Code session state from outside the CLI (agent-view docs).
 * Runs INSIDE the session container through `execCapture` (fixed argv,
 * byte cap, timeout), never on the host. Output is parsed tolerantly:
 * only the fields the contract relies on are read, unknown ones ignored.
 */

export interface ProbeEntry {
	sessionId: string;
	kind: "interactive" | "background" | string;
	pid?: number;
	status?: "busy" | "waiting" | "idle";
	waitingFor?: string;
	name?: string;
	cwd?: string;
}

/** Parse `claude agents --json` stdout. Returns null when unparseable. */
export function parseAgentsJson(stdout: string): ProbeEntry[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const out: ProbeEntry[] = [];
	for (const raw of parsed) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.sessionId !== "string") continue;
		const entry: ProbeEntry = {
			sessionId: r.sessionId,
			kind: typeof r.kind === "string" ? r.kind : "interactive",
		};
		if (typeof r.pid === "number") entry.pid = r.pid;
		if (r.status === "busy" || r.status === "waiting" || r.status === "idle")
			entry.status = r.status;
		if (typeof r.waitingFor === "string") entry.waitingFor = r.waitingFor;
		if (typeof r.name === "string") entry.name = r.name;
		if (typeof r.cwd === "string") entry.cwd = r.cwd;
		out.push(entry);
	}
	return out;
}

/** The exact argv the probe runs. Exported so tests can pin it. */
export const PROBE_ARGV: readonly string[] = ["claude", "agents", "--json"];
export const PROBE_MAX_BYTES = 64 * 1024;
export const PROBE_TIMEOUT_MS = 5_000;
