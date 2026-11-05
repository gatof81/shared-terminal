#!/usr/bin/env python3
"""DISPOSABLE local smoke: drive the REAL 2.1.314 trust dialog through the gate, in an isolated
HOME (no login, loopback only), then clean up. NOT a VM100 run; NOT part of the audited kit; no
raw pane text is printed — only the gate's structured result + a boolean "got past trust".

    python3 smoke.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trustgate as T  # noqa: E402

SOCK = "inv1smoke"


def tmux(*a, check=False):
    return subprocess.run(["tmux", "-L", SOCK, *a], capture_output=True, text=True, check=check)


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
    # stdout MUST stay on the tmux pane (the CLI needs a TTY to draw the trust UI); only stderr is
    # redirected, exactly as the audited kit's one_start does.
    cmd = f"cd {ws} && env -i {envs} {cli} --debug-file {base}/debug.log 2> {base}/stderr.txt; echo $? > {rcf}"
    tmux("kill-server")
    tmux("new-session", "-d", "-s", "s", "-x", "200", "-y", "50", "sh", "-c", cmd)
    io = TmuxIO("s", rcf)
    try:
        res = T.drive_trust(io, poll=0.3, stable_polls=2, ready_timeout=40.0, settle=3.0)
        # Did the CLI get PAST trust? (prompt reached / trust gone, process still running)
        time.sleep(1)
        pane = io.pane()
        got_past = ("Yes, I trust this folder" not in pane) and (not io.exited())
        res["got_past_trust"] = got_past
    finally:
        tmux("kill-server")
        # best-effort: stop any lingering CLI from this disposable HOME, then remove temp
        subprocess.run(["pkill", "-9", "-f", base], capture_output=True)
        time.sleep(0.5)
        shutil.rmtree(base, ignore_errors=True)
    return res


if __name__ == "__main__":
    print(json.dumps(run_once(), indent=2))
