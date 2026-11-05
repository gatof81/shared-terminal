#!/usr/bin/env python3
"""DISPOSABLE **skeleton** smoke for wiring the unified observer to the REAL 2.1.314 CLI in an
isolated HOME. It is NOT end-to-end: it does NOT wire the trust-gate and does NOT set up the N14
fixture or the managed policy — it only launches the CLI and feeds pane/debug into the Observer to
exercise the launch + cleanup. **Not run during the #521 canary window** (no real CLI/Docker/smoke).

Process-group cleanup (owner req 8): the CLI is launched under `setsid --wait`, so the inner shell
becomes a session/group LEADER and `exec claude` keeps that PID == PGID, written to a file. Cleanup
signals ONLY that group, and only after a best-effort check that `/proc/<pgid>/comm` still looks
like our CLI (reducing — NOT eliminating — the risk of signaling a REUSED pgid). It never guesses
from the tmux pane pid and never uses `pkill -f`. CAVEAT: if the process starts but never writes the
PGID file, cleanup cannot target it and the detached `setsid` child may ORPHAN — absolute absence of
orphans is NOT promised.

NETWORK (req 7/owner #4): this does NOT isolate the network (isolated HOME + no login only).
Verifiable isolation would require a network namespace or a container (see the future-smoke note in
README.md). No raw pane text is persisted — only the observer's sanitized events.
"""
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observer as O  # noqa: E402

SOCK = f"obsunified-{os.getpid()}-{secrets.token_hex(4)}"


def tmux(*a):
    return subprocess.run(["tmux", "-L", SOCK, *a], capture_output=True, text=True)


CLI_COMMS = {"claude", "claude.exe", "node", "bun"}


def _read_pgid(path):
    """The CLI's own process-group id, or None. Targeted cleanup depends only on this."""
    try:
        with open(path, encoding="utf-8") as fh:
            v = fh.read().strip()
        return int(v) if v.isdigit() and int(v) > 1 else None
    except (OSError, ValueError):
        return None


def _group_is_ours(pgid, proc_root="/proc"):
    """Best-effort: does /proc/<pgid>/comm still look like our CLI? Reduces (does NOT eliminate) the
    risk of signaling a REUSED pgid. Unknown/mismatch => False (we do not signal)."""
    try:
        with open(os.path.join(proc_root, str(pgid), "comm"), encoding="utf-8") as fh:
            return fh.read().strip() in CLI_COMMS
    except OSError:
        return False


def _cleanup(pgidfile, base, *, killpg=os.killpg, group_is_ours=_group_is_ours):
    pgid = _read_pgid(pgidfile)
    tmux("kill-server")                       # our unique socket only
    # Only signal a pgid we wrote AND that still looks like our CLI (reused-group guard). If the
    # process never wrote its pgid, we do NOT guess — the detached child may orphan (documented).
    if pgid is not None and group_is_ours(pgid):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                killpg(pgid, sig)             # exactly the CLI's group
            except (ProcessLookupError, PermissionError, OSError):
                break
            time.sleep(0.3)
    shutil.rmtree(base, ignore_errors=True)


def run_once():   # pragma: no cover - requires a real CLI; not run during the canary
    cli = subprocess.run(["bash", "-lc", "command -v claude"], capture_output=True, text=True).stdout.strip()
    base = tempfile.mkdtemp(prefix="obsunified.")
    home, ws = os.path.join(base, "home"), os.path.join(base, "ws")
    os.makedirs(os.path.join(home, ".claude"))
    os.makedirs(ws)
    json.dump({"hasCompletedOnboarding": True, "theme": "dark"}, open(os.path.join(home, ".claude.json"), "w"))
    rcf, pgidfile, dbg = (os.path.join(base, n) for n in ("rc", "pgid", "debug.log"))
    env = {"PATH": "/usr/bin:/bin", "HOME": home, "TERM": "xterm-256color", "DISABLE_AUTOUPDATER": "1"}
    envs = " ".join(f"{k}={v}" for k, v in env.items())
    inner = f"echo $$ > {pgidfile}; exec env -i {envs} {cli} --debug-file {dbg} 2> {base}/stderr.txt"
    wrapped = f"setsid --wait sh -c {shquote(inner)}; echo $? > {rcf}"
    o = O.Observer("P0", 1, SOCK, time.monotonic)
    try:
        tmux("new-session", "-d", "-s", "s", "-x", "200", "-y", "50", "sh", "-c", wrapped)
        # (A real run would: readiness-gate + trust-gate -> o.fact('trust', ...); poll pane ->
        # o.from_pane(capture); read dbg -> o.from_debug(...). Omitted here: not run during canary.)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not os.path.exists(rcf):
            r = tmux("capture-pane", "-p", "-t", "s")
            o.from_pane(r.stdout if r.returncode == 0 else "", ok=r.returncode == 0)
            try:
                with open(dbg, encoding="utf-8", errors="replace") as fh:
                    o.from_debug(fh.read())
            except OSError:
                pass
            time.sleep(0.5)
    finally:
        snap = o.snapshot()
        _cleanup(pgidfile, base)
    return snap


def shquote(s):
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    print(json.dumps(run_once(), indent=2))   # pragma: no cover
