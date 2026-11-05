#!/usr/bin/env python3
"""DISPOSABLE local smoke: drive the REAL 2.1.314 trust dialog through the gate in an ISOLATED HOME
(no login, autoupdater disabled), then clean up. NOT a VM100 run; NOT part of the audited kit; it
prints only the gate's structured result (enums/states) + a boolean "got past trust" — never raw
pane text.

NETWORK (owner finding #4): this smoke does NOT isolate the network. It is an isolated HOME + no
login + DISABLE_AUTOUPDATER=1, but the CLI can still reach the network. Verifiable network
isolation would require running under a network namespace (e.g. `unshare -rn`) or a container, which
is out of scope for this local prototype. Do not claim "loopback only".

Resources (owner finding #3): a UNIQUE tmux socket per run and TARGETED cleanup of only the
processes this smoke created — no `pkill -f`.

    python3 smoke.py
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
import trustgate as T  # noqa: E402

SOCK = f"inv1smoke-{os.getpid()}-{secrets.token_hex(4)}"   # unique per run (owner #3)


def tmux(*a):
    return subprocess.run(["tmux", "-L", SOCK, *a], capture_output=True, text=True)


class TmuxIO(T.IO):
    def __init__(self, sess, rcf):
        self.sess, self.rcf = sess, rcf

    def pane(self):
        r = tmux("capture-pane", "-p", "-t", self.sess)
        return r.stdout if r.returncode == 0 else ""

    def send(self, key):
        tmux("send-keys", "-t", self.sess, key)

    def exited(self):
        return os.path.exists(self.rcf)

    def now(self):
        return time.monotonic()

    def sleep(self, s):
        time.sleep(s)


def _pane_pid(sess):
    r = tmux("display-message", "-p", "-t", sess, "#{pane_pid}")
    out = r.stdout.strip()
    return int(out) if out.isdigit() else None


def _targeted_cleanup(pane_pid, base):
    # Kill ONLY our unique-socket tmux server (which terminates our session and its child process
    # tree); then, as belt-and-suspenders, signal the exact pane pid's group if it is still alive.
    tmux("kill-server")
    if pane_pid:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pane_pid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                break
            time.sleep(0.3)
    shutil.rmtree(base, ignore_errors=True)


def run_once():
    cli = subprocess.run(["bash", "-lc", "command -v claude"], capture_output=True, text=True).stdout.strip()
    base = tempfile.mkdtemp(prefix="inv1smoke.")
    home, ws = os.path.join(base, "home"), os.path.join(base, "ws")
    os.makedirs(os.path.join(home, ".claude"))
    os.makedirs(ws)
    json.dump({"hasCompletedOnboarding": True, "theme": "dark"}, open(os.path.join(home, ".claude.json"), "w"))
    rcf = os.path.join(base, "rc")
    env = {"PATH": "/usr/bin:/bin", "HOME": home, "TERM": "xterm-256color", "DISABLE_AUTOUPDATER": "1"}
    envs = " ".join(f"{k}={v}" for k, v in env.items())
    # stdout MUST stay on the tmux pane (the CLI needs a TTY to draw trust); only stderr redirected.
    # `setsid` gives the child its own process group so cleanup can target exactly it.
    cmd = f"cd {ws} && exec env -i {envs} {cli} --debug-file {base}/debug.log 2> {base}/stderr.txt"
    wrapped = f"setsid sh -c {json_quote(cmd)} ; echo $? > {rcf}"
    pane_pid = None
    try:
        tmux("new-session", "-d", "-s", "s", "-x", "200", "-y", "50", "sh", "-c", wrapped)
        pane_pid = _pane_pid("s")
        io = TmuxIO("s", rcf)
        res = T.drive_trust(io, poll=0.3, stable_polls=2, ready_timeout=40.0, settle=3.0)
        time.sleep(1)
        pane = io.pane()
        res["got_past_trust"] = ("Yes, I trust this folder" not in pane) and (not io.exited())
    finally:
        _targeted_cleanup(pane_pid, base)
    return res


def json_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    print(json.dumps(run_once(), indent=2))
