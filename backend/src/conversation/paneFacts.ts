/**
 * conversation/paneFacts.ts — the two tmux/proc reads the capture's probe
 * identity check needs (service.ts `verifyIdentity`): which process a pane
 * runs, and whether a pid descends from it. Fixed argv, bounded by coreutils
 * `timeout`; no text from a person or an agent ever reaches them.
 */

export const EXEC_TIMEOUT_S = 5;

/** `display -p`: the pane's process, mode, liveness and current command. */
export function paneStateArgv(paneId: string): string[] {
	return [
		"timeout",
		"-k",
		"2",
		String(EXEC_TIMEOUT_S),
		"tmux",
		"display",
		"-p",
		"-t",
		paneId,
		"#{pane_pid} #{pane_in_mode} #{pane_dead} #{pane_current_command}",
	];
}

export interface PaneState {
	panePid: number;
	inMode: boolean;
	dead: boolean;
	command: string;
}

export function parsePaneState(stdout: string): PaneState | null {
	const m = stdout.trim().match(/^(\d+) ([01]) ([01]) (\S+)$/);
	if (!m) return null;
	return { panePid: Number(m[1]), inMode: m[2] === "1", dead: m[3] === "1", command: m[4] };
}

/**
 * Is the descendant chain from `pid` reaching `panePid`? Walks ppid in
 * /proc; prints `yes`/`no`; anything else is unknown (fail closed).
 */
export const ANCESTRY_SCRIPT = `pid="$1"
target="$2"
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
	if [ "$pid" = "$target" ]; then echo yes; exit 0; fi
	stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || { echo no; exit 0; }
	rest="\${stat##*) }"
	set -- $rest
	pid="\${2:-}"
done
echo no
`;

export function ancestryArgv(pid: number, panePid: number): string[] {
	return [
		"timeout",
		"-k",
		"2",
		String(EXEC_TIMEOUT_S),
		"bash",
		"-c",
		ANCESTRY_SCRIPT,
		"st-ancestry",
		String(pid),
		String(panePid),
	];
}
