#!/usr/bin/env python3
"""DISPOSABLE smoke that would wire the unified observer to the REAL 2.1.314 CLI in an isolated
HOME. **Not run during the #521 canary window** (no real CLI / Docker / smokes until Claude A
confirms). Kept here so the launch + cleanup are reviewable now and runnable later.

Process-group cleanup (owner req 8): the CLI is launched under `setsid --wait`, so the inner shell
becomes a session/group LEADER and `exec claude` keeps that PID == PGID. That PGID is written to a
file, and cleanup signals exactly that group — it never guesses from the tmux pane pid, never uses
`pkill -f`, so it cannot kill foreign processes and does not leave orphans. A UNIQUE tmux socket is
used per run.

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


def _read_pgid(path):
    """The CLI's own process-group id, or None. Targeted cleanup depends only on this."""
    try:
        with open(path, encoding="utf-8") as fh:
            v = fh.read().strip()
        return int(v) if v.isdigit() and int(v) > 1 else None
    except (OSError, ValueError):
        return None


def _cleanup(pgidfile, base):
    pgid = _read_pgid(pgidfile)
    tmux("kill-server")                       # our unique socket only
    if pgid is not None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pgid, sig)          # exactly the CLI's group
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
